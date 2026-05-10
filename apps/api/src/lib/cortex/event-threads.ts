/**
 * Event Threads Engine — Phase 1.6.2
 *
 * Graduates ephemeral Redis correlation clusters into durable PostgreSQL
 * event threads that track developing stories over days/weeks.
 *
 * Lifecycle:
 *   1. Correlation engine forms cluster in Redis (≥3 signals)
 *   2. This engine promotes qualifying clusters to event_threads
 *   3. New signals matching an existing thread get linked
 *   4. Thread status auto-transitions: developing → escalating → stable → resolved
 *
 * Runs every 30 minutes via scheduler.
 *
 * @module cortex/event-threads
 */

import { db } from '../../db/postgres'
import { redis } from '../../db/redis'

// ─── Types ───────────────────────────────────────────────────────────────────

interface RedisCluster {
  cluster_id: string
  primary_signal_id: string
  signal_ids: string[]
  categories: string[]
  sources: string[]
  severity: string
  correlation_score: number
  created_at: string
}

export interface EventThread {
  id: string
  title: string
  summary: string | null
  category: string
  region: string | null
  status: 'developing' | 'escalating' | 'stable' | 'resolved'
  peak_severity: string
  signal_count: number
  source_count: number
  severity_trajectory: Array<{ timestamp: string; avg_severity_rank: number; signal_count: number }>
  first_seen: string
  last_updated: string
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MIN_SIGNALS_FOR_THREAD = 3    // Minimum cluster size to graduate
const STABLE_AFTER_HOURS = 48       // Mark "stable" after 48h without new signals
const RESOLVED_AFTER_HOURS = 168    // Mark "resolved" after 7 days without new signals
const SEVERITY_RANK: Record<string, number> = {
  critical: 5, high: 4, medium: 3, low: 2, info: 1,
}
const THREAD_MERGE_WINDOW_HOURS = 72   // Merge threads that share signals within this window

// ─── Promote Redis clusters to threads ───────────────────────────────────────

/**
 * Scan recent Redis clusters and promote qualifying ones to event_threads.
 */
export async function promoteClusterToThreads(): Promise<{
  promoted: number
  updated: number
  merged: number
}> {
  let promoted = 0
  let updated = 0
  let merged = 0

  // Get recent cluster IDs from Redis sorted set
  const clusterIds = await redis.zrevrange('correlation:recent', 0, 200)

  for (const clusterId of clusterIds) {
    const raw = await redis.get(`correlation:cluster:${clusterId}`)
    if (!raw) continue

    let cluster: RedisCluster
    try {
      cluster = JSON.parse(raw)
    } catch { continue }

    if (cluster.signal_ids.length < MIN_SIGNALS_FOR_THREAD) continue

    // Check if this cluster already has a thread
    const existing = await db('event_threads')
      .where('cluster_id', clusterId)
      .first()

    if (existing) {
      // Update existing thread with any new signals
      const result = await updateThreadFromCluster(existing.id, cluster)
      if (result.new_signals > 0) updated++
      continue
    }

    // Check if any of these signals already belong to another thread
    const existingLinks = await db('event_thread_signals')
      .whereIn('signal_id', cluster.signal_ids)
      .select('thread_id', 'signal_id')

    if (existingLinks.length > 0) {
      // Signals already belong to an existing thread — merge into it
      const targetThreadId = existingLinks[0]!.thread_id
      await mergeClusterIntoThread(targetThreadId, cluster)
      merged++
      continue
    }

    // Create new thread
    await createThreadFromCluster(cluster)
    promoted++
  }

  console.log(`[CORTEX] Event threads: ${promoted} promoted, ${updated} updated, ${merged} merged`)
  return { promoted, updated, merged }
}

// ─── Create thread from cluster ──────────────────────────────────────────────

async function createThreadFromCluster(cluster: RedisCluster): Promise<string> {
  // Fetch signal details for title and region
  const signals = await db('signals')
    .whereIn('id', cluster.signal_ids)
    .select('id', 'title', 'category', 'severity', 'location_name', 'reliability_score', 'published_at')
    .orderBy('published_at', 'asc')

  if (signals.length === 0) return ''

  // Primary signal = highest severity, then most recent
  const primary = signals.reduce((best: any, s: any) => {
    const bestRank = SEVERITY_RANK[best.severity] ?? 0
    const sRank = SEVERITY_RANK[s.severity] ?? 0
    return sRank > bestRank ? s : best
  }, signals[0])

  const categories = [...new Set(signals.map((s: any) => s.category))]
  const regions = [...new Set(signals.map((s: any) => s.location_name).filter(Boolean))]
  const sources = cluster.sources?.length ?? 0

  const avgSeverityRank = signals.reduce((sum: number, s: any) =>
    sum + (SEVERITY_RANK[s.severity] ?? 1), 0) / signals.length

  const thread = await db('event_threads')
    .insert({
      title: primary.title,
      category: categories[0] ?? 'unknown',
      region: regions[0] ?? null,
      status: 'developing',
      peak_severity: primary.severity,
      signal_count: signals.length,
      source_count: sources,
      avg_reliability: signals.reduce((s: number, sig: any) =>
        s + Number(sig.reliability_score ?? 0.5), 0) / signals.length,
      severity_trajectory: JSON.stringify([{
        timestamp: new Date().toISOString(),
        avg_severity_rank: Math.round(avgSeverityRank * 100) / 100,
        signal_count: signals.length,
      }]),
      related_entities: '[]',
      cluster_id: cluster.cluster_id,
      first_seen: signals[0]!.published_at,
      last_updated: signals[signals.length - 1]!.published_at,
    })
    .returning('id')

  const threadId = thread[0]?.id
  if (!threadId) return ''

  // Link signals to thread
  const links = signals.map((s: any, i: number) => ({
    thread_id: threadId,
    signal_id: s.id,
    role: s.id === primary.id ? 'primary' : 'member',
  }))

  await db('event_thread_signals').insert(links).onConflict(['thread_id', 'signal_id']).ignore()

  console.log(`[CORTEX] Created event thread: "${primary.title.slice(0, 60)}..." (${signals.length} signals)`)
  return threadId
}

// ─── Update thread with new signals ──────────────────────────────────────────

async function updateThreadFromCluster(
  threadId: string,
  cluster: RedisCluster,
): Promise<{ new_signals: number }> {
  // Find signals not yet linked
  const existingLinks = await db('event_thread_signals')
    .where('thread_id', threadId)
    .select('signal_id')

  const existingIds = new Set(existingLinks.map((l: any) => l.signal_id))
  const newSignalIds = cluster.signal_ids.filter(id => !existingIds.has(id))

  if (newSignalIds.length === 0) return { new_signals: 0 }

  // Get new signal details
  const newSignals = await db('signals')
    .whereIn('id', newSignalIds)
    .select('id', 'severity', 'reliability_score', 'published_at')

  if (newSignals.length === 0) return { new_signals: 0 }

  // Link new signals
  await db('event_thread_signals')
    .insert(newSignals.map((s: any) => ({
      thread_id: threadId,
      signal_id: s.id,
      role: 'member',
    })))
    .onConflict(['thread_id', 'signal_id'])
    .ignore()

  // Update thread stats
  const allSignals = await db('event_thread_signals')
    .where('thread_id', threadId)
    .join('signals', 'event_thread_signals.signal_id', 'signals.id')
    .select('signals.severity', 'signals.reliability_score')

  const avgSeverityRank = allSignals.reduce((sum: number, s: any) =>
    sum + (SEVERITY_RANK[s.severity] ?? 1), 0) / allSignals.length

  const peakSev = allSignals.reduce((best: string, s: any) => {
    return (SEVERITY_RANK[s.severity] ?? 0) > (SEVERITY_RANK[best] ?? 0) ? s.severity : best
  }, 'low')

  // Get existing trajectory and append
  const thread = await db('event_threads').where('id', threadId).first()
  const trajectory = Array.isArray(thread?.severity_trajectory)
    ? thread.severity_trajectory
    : JSON.parse(thread?.severity_trajectory ?? '[]')

  trajectory.push({
    timestamp: new Date().toISOString(),
    avg_severity_rank: Math.round(avgSeverityRank * 100) / 100,
    signal_count: allSignals.length,
  })

  // Detect escalation: is severity trending up?
  const status = detectThreadStatus(trajectory, thread?.status)

  await db('event_threads').where('id', threadId).update({
    signal_count: allSignals.length,
    peak_severity: peakSev,
    avg_reliability: allSignals.reduce((s: number, sig: any) =>
      s + Number(sig.reliability_score ?? 0.5), 0) / allSignals.length,
    severity_trajectory: JSON.stringify(trajectory),
    status,
    last_updated: new Date().toISOString(),
  })

  return { new_signals: newSignals.length }
}

// ─── Merge cluster into existing thread ──────────────────────────────────────

async function mergeClusterIntoThread(
  threadId: string,
  cluster: RedisCluster,
): Promise<void> {
  // Update the cluster_id reference
  await db('event_threads')
    .where('id', threadId)
    .whereNull('cluster_id')
    .update({ cluster_id: cluster.cluster_id })

  await updateThreadFromCluster(threadId, cluster)
}

// ─── Thread lifecycle management ─────────────────────────────────────────────

/**
 * Update thread statuses based on activity.
 * - No new signals for 48h → "stable"
 * - No new signals for 7d → "resolved"
 */
export async function updateThreadLifecycles(): Promise<{
  stabilized: number
  resolved: number
}> {
  const now = new Date()
  const stableThreshold = new Date(now.getTime() - STABLE_AFTER_HOURS * 3600 * 1000)
  const resolvedThreshold = new Date(now.getTime() - RESOLVED_AFTER_HOURS * 3600 * 1000)

  const stabilized = await db('event_threads')
    .whereIn('status', ['developing', 'escalating'])
    .where('last_updated', '<', stableThreshold.toISOString())
    .update({ status: 'stable' })

  const resolved = await db('event_threads')
    .where('status', 'stable')
    .where('last_updated', '<', resolvedThreshold.toISOString())
    .update({
      status: 'resolved',
      resolved_at: now.toISOString(),
    })

  if (stabilized > 0 || resolved > 0) {
    console.log(`[CORTEX] Thread lifecycle: ${stabilized} → stable, ${resolved} → resolved`)
  }

  return { stabilized, resolved }
}

// ─── Status detection ────────────────────────────────────────────────────────

function detectThreadStatus(
  trajectory: Array<{ avg_severity_rank: number; signal_count: number }>,
  currentStatus: string,
): string {
  if (trajectory.length < 2) return currentStatus ?? 'developing'

  const recent = trajectory.slice(-3)
  const older  = trajectory.slice(-6, -3)

  if (older.length === 0) return 'developing'

  const recentAvgSev = recent.reduce((s, t) => s + t.avg_severity_rank, 0) / recent.length
  const olderAvgSev  = older.reduce((s, t) => s + t.avg_severity_rank, 0) / older.length

  const recentAvgCount = recent.reduce((s, t) => s + t.signal_count, 0) / recent.length
  const olderAvgCount  = older.reduce((s, t) => s + t.signal_count, 0) / older.length

  // Escalating: severity or volume trending up significantly
  if (recentAvgSev > olderAvgSev * 1.2 || recentAvgCount > olderAvgCount * 1.5) {
    return 'escalating'
  }

  return 'developing'
}

// ─── Thread summary generation ──────────────────────────────────────────────

/**
 * Generate LLM summaries for active threads that need one.
 *
 * Criteria for summarization:
 *   - Thread has ≥3 signals
 *   - Thread has no summary OR hasn't been summarized since last signal update
 *   - Thread status is developing or escalating (don't waste LLM on resolved)
 *
 * Uses Anthropic Claude (fast) or OpenAI as fallback for generating concise
 * 2-3 sentence summaries of developing stories.
 */
export async function generateThreadSummaries(): Promise<{ summarized: number }> {
  // Find threads needing summaries
  const threads = await db('event_threads')
    .whereIn('status', ['developing', 'escalating'])
    .where('signal_count', '>=', 3)
    .where(function () {
      this.whereNull('summary')
        .orWhereNull('summary_generated_at')
        .orWhereRaw('summary_generated_at < last_updated')
    })
    .select('id', 'title', 'category', 'region', 'status', 'signal_count', 'peak_severity')
    .limit(10) // Cap per cycle to control LLM costs

  if (threads.length === 0) return { summarized: 0 }

  let summarized = 0

  for (const thread of threads as any[]) {
    try {
      // Get the thread's constituent signals
      const signals = await db('event_thread_signals')
        .where('thread_id', thread.id)
        .join('signals', 'event_thread_signals.signal_id', 'signals.id')
        .select('signals.title', 'signals.summary as signal_summary', 'signals.category',
                'signals.severity', 'signals.location_name', 'signals.published_at')
        .orderBy('signals.published_at', 'desc')
        .limit(15) // Most recent 15 signals

      if (signals.length < 3) continue

      // Build the signal digest for the LLM
      const signalDigest = signals.map((s: any, i: number) =>
        `${i + 1}. [${s.severity}] ${s.title}${s.location_name ? ` (${s.location_name})` : ''}`
      ).join('\n')

      const prompt = `You are a concise intelligence analyst. Summarize this developing story in 2-3 sentences.

Thread: "${thread.title}"
Category: ${thread.category} | Region: ${thread.region || 'Global'} | Status: ${thread.status}
Peak severity: ${thread.peak_severity} | Signal count: ${thread.signal_count}

Recent signals:
${signalDigest}

Write a factual, neutral summary that captures:
1. What is happening (the core event)
2. Scale/scope (where, how many affected)
3. Trajectory (escalating, stabilizing, or resolving)

Keep it under 100 words. No bullet points. No speculation.`

      const summary = await callLLMForSummary(prompt)
      if (!summary) continue

      await db('event_threads')
        .where('id', thread.id)
        .update({
          summary,
          summary_generated_at: new Date().toISOString(),
        })

      summarized++
      console.log(`[CORTEX] Thread summary generated: ${thread.title.slice(0, 60)}`)
    } catch (err) {
      console.error(`[CORTEX] Thread summary failed for ${thread.id}:`, err)
    }
  }

  return { summarized }
}

/**
 * Call LLM to generate a thread summary.
 * Tries Anthropic Claude first (via API), falls back to OpenAI.
 */
async function callLLMForSummary(prompt: string): Promise<string | null> {
  // Try Anthropic first
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (anthropicKey) {
    try {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }),
      })

      if (response.ok) {
        const data = await response.json() as any
        const text = data.content?.[0]?.text
        if (text) return text.trim()
      }
    } catch (err) {
      console.warn('[CORTEX] Anthropic summary failed, trying OpenAI:', err)
    }
  }

  // Fallback to OpenAI
  const openaiKey = process.env.OPENAI_API_KEY
  if (openaiKey) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${openaiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          max_tokens: 200,
          messages: [{ role: 'user', content: prompt }],
        }),
      })

      if (response.ok) {
        const data = await response.json() as any
        const text = data.choices?.[0]?.message?.content
        if (text) return text.trim()
      }
    } catch (err) {
      console.warn('[CORTEX] OpenAI summary also failed:', err)
    }
  }

  return null
}

// ─── Chokepoint-to-thread linking ────────────────────────────────────────────

const CHOKEPOINTS = [
  { id: 'suez',          name: 'Suez Canal',              lat: 30.46, lng: 32.34 },
  { id: 'panama',        name: 'Panama Canal',            lat:  9.08, lng: -79.68 },
  { id: 'hormuz',        name: 'Strait of Hormuz',        lat: 26.57, lng: 56.25 },
  { id: 'malacca',       name: 'Strait of Malacca',       lat:  2.50, lng: 101.50 },
  { id: 'bab-el-mandeb', name: 'Bab el-Mandeb',           lat: 12.58, lng: 43.32 },
  { id: 'taiwan',        name: 'Taiwan Strait',            lat: 24.50, lng: 119.50 },
  { id: 'gibraltar',     name: 'Strait of Gibraltar',      lat: 35.97, lng: -5.60 },
  { id: 'bosporus',      name: 'Turkish Straits',          lat: 41.12, lng: 29.05 },
  { id: 'good-hope',     name: 'Cape of Good Hope',        lat: -34.36, lng: 18.47 },
  { id: 'dover',         name: 'Strait of Dover',          lat: 51.02, lng:  1.45 },
]

const CHOKEPOINT_RADIUS_KM = 200

/**
 * Link active event threads to chokepoints by checking if any of their
 * signals have location data near a chokepoint.
 * Stores chokepoint metadata in the thread's related_entities field.
 */
export async function linkChokepointsToThreads(): Promise<{ linked: number }> {
  // Get active threads without chokepoint tags
  const threads = await db('event_threads')
    .whereIn('status', ['developing', 'escalating'])
    .select('id')

  let linked = 0

  for (const thread of threads) {
    // Get signals in this thread that have location data
    const signals = await db('event_thread_signals as ets')
      .join('signals as s', 'ets.signal_id', 's.id')
      .where('ets.thread_id', thread.id)
      .whereNotNull('s.location')
      .select(db.raw('ST_Y(s.location::geometry) as lat'), db.raw('ST_X(s.location::geometry) as lng'))

    if (signals.length === 0) continue

    // Check each signal against each chokepoint
    const matchedChokepoints = new Set<string>()

    for (const signal of signals as any[]) {
      for (const cp of CHOKEPOINTS) {
        const distance = haversineKm(signal.lat, signal.lng, cp.lat, cp.lng)
        if (distance <= CHOKEPOINT_RADIUS_KM) {
          matchedChokepoints.add(cp.name)
        }
      }
    }

    if (matchedChokepoints.size > 0) {
      // Read existing related_entities and merge
      const threadRow = await db('event_threads').where('id', thread.id).first()
      const existing: string[] = typeof threadRow?.related_entities === 'string'
        ? JSON.parse(threadRow.related_entities)
        : threadRow?.related_entities ?? []

      const merged = [...new Set([...existing, ...matchedChokepoints])]

      await db('event_threads')
        .where('id', thread.id)
        .update({
          related_entities: JSON.stringify(merged),
        })

      linked++
    }
  }

  if (linked > 0) {
    console.log(`[CORTEX] Linked ${linked} threads to chokepoints`)
  }
  return { linked }
}

/**
 * Haversine distance in km between two lat/lng points
 */
function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371
  const dLat = (lat2 - lat1) * Math.PI / 180
  const dLng = (lng2 - lng1) * Math.PI / 180
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

// ─── Full cycle ──────────────────────────────────────────────────────────────

/**
 * Run the full event threads cycle:
 * 1. Promote qualifying Redis clusters to threads
 * 2. Update thread lifecycles (stable/resolved transitions)
 * 3. Generate LLM summaries for threads needing them
 */
export async function runEventThreadsCycle(): Promise<{
  promoted: number
  updated: number
  merged: number
  stabilized: number
  resolved: number
  summarized: number
}> {
  const promotion = await promoteClusterToThreads()
  const lifecycle = await updateThreadLifecycles()
  const summaries = await generateThreadSummaries()
  const chokepoints = await linkChokepointsToThreads().catch(() => ({ linked: 0 }))

  return { ...promotion, ...lifecycle, ...summaries, chokepoints_linked: chokepoints.linked }
}
