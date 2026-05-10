/**
 * Pattern Alerts — Phase 1.6.5
 *
 * Auto-generates PULSE analysis posts when significant patterns are detected:
 *   - New causal chains with high confidence
 *   - Geographic hotspots with multi-category clustering
 *   - Cross-cluster bridges linking different event threads
 *   - Recurring temporal sequences
 *
 * Runs after the weekly pattern detection cycle.
 *
 * @module cortex/pattern-alerts
 */

import { db } from '../../db/postgres'
import { redis } from '../../db/redis'

const PULSE_USER_ID = process.env.PULSE_USER_ID || '00000000-0000-0000-0000-000000000000'
const MAX_ALERTS_PER_CYCLE = 3 // Don't flood the feed

interface PatternReport {
  causal_chains: Array<{
    source_category: string
    target_category: string
    co_occurrence_count: number
    avg_time_delta_hours: number
    confidence: number
  }>
  geographic_hotspots: Array<{
    region: string
    categories: string[]
    signal_count: number
    anomaly_score: number
  }>
  cross_cluster_bridges: Array<{
    thread_a_title: string
    thread_b_title: string
    shared_entities: string[]
    connection_strength: number
  }>
  temporal_sequences: Array<{
    sequence: string[]
    occurrences: number
    avg_interval_hours: number
    predictive_value: number
  }>
}

/**
 * Generate PULSE analysis posts from the latest pattern detection results.
 * Reads the cached pattern report from Redis and creates posts for the
 * most significant findings.
 */
export async function generatePatternAlerts(): Promise<{ alerts_published: number }> {
  const cached = await redis.get('cortex:patterns:latest').catch(() => null)
  if (!cached) {
    console.log('[CORTEX] No pattern report found — skipping alerts')
    return { alerts_published: 0 }
  }

  const report: PatternReport = JSON.parse(cached)
  let alertsPublished = 0

  // Check what we've already alerted on (avoid duplicate alerts)
  const recentAlerts = await db('pulse_publish_log')
    .where('content_type', 'pattern_alert')
    .where('published_at', '>', new Date(Date.now() - 7 * 24 * 3600_000))
    .select('metadata')

  const alertedPatterns = new Set<string>()
  for (const row of recentAlerts as any[]) {
    const meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata
    if (meta?.pattern_key) alertedPatterns.add(meta.pattern_key)
  }

  // Priority 1: High-confidence causal chains (≥ 5 occurrences)
  for (const chain of report.causal_chains ?? []) {
    if (alertsPublished >= MAX_ALERTS_PER_CYCLE) break
    if (chain.co_occurrence_count < 5) continue

    const patternKey = `chain:${chain.source_category}→${chain.target_category}`
    if (alertedPatterns.has(patternKey)) continue

    const content = `**Pattern Detected: ${formatCategory(chain.source_category)} → ${formatCategory(chain.target_category)}**\n\n` +
      `Cortex has identified a recurring causal pattern: ${formatCategory(chain.source_category)} events are consistently followed by ` +
      `${formatCategory(chain.target_category)} events within an average of ${Math.round(chain.avg_time_delta_hours)} hours. ` +
      `This pattern has been observed ${chain.co_occurrence_count} times over the past 30 days ` +
      `(confidence: ${Math.round(chain.confidence * 100)}%).\n\n` +
      `*Analysis: This cross-domain linkage may indicate a systemic relationship worth monitoring.*`

    const result = await publishPatternAlert(content, patternKey, { chain })
    if (result) alertsPublished++
  }

  // Priority 2: Geographic hotspots with high anomaly scores
  for (const hotspot of report.geographic_hotspots ?? []) {
    if (alertsPublished >= MAX_ALERTS_PER_CYCLE) break
    if (hotspot.anomaly_score < 0.5) continue

    const patternKey = `hotspot:${hotspot.region}`
    if (alertedPatterns.has(patternKey)) continue

    const content = `**Geographic Hotspot: ${hotspot.region}**\n\n` +
      `Unusual multi-category activity detected in ${hotspot.region}: ` +
      `${hotspot.signal_count} signals across ${hotspot.categories.length} categories ` +
      `(${hotspot.categories.map(formatCategory).join(', ')}). ` +
      `Anomaly score: ${Math.round(hotspot.anomaly_score * 100)}%.\n\n` +
      `*This convergence of different signal types in one region may indicate an escalating situation.*`

    const result = await publishPatternAlert(content, patternKey, { hotspot })
    if (result) alertsPublished++
  }

  // Priority 3: Cross-cluster bridges with high connection strength
  for (const bridge of report.cross_cluster_bridges ?? []) {
    if (alertsPublished >= MAX_ALERTS_PER_CYCLE) break
    if (bridge.connection_strength < 0.6) continue

    const patternKey = `bridge:${bridge.thread_a_title.slice(0, 30)}::${bridge.thread_b_title.slice(0, 30)}`
    if (alertedPatterns.has(patternKey)) continue

    const content = `**Cross-Domain Connection Detected**\n\n` +
      `Two developing stories share significant entity overlap:\n` +
      `• "${bridge.thread_a_title.slice(0, 80)}"\n` +
      `• "${bridge.thread_b_title.slice(0, 80)}"\n\n` +
      `Shared entities: ${bridge.shared_entities.slice(0, 5).join(', ')}. ` +
      `Connection strength: ${Math.round(bridge.connection_strength * 100)}%.\n\n` +
      `*These stories may be facets of a larger developing situation.*`

    const result = await publishPatternAlert(content, patternKey, { bridge })
    if (result) alertsPublished++
  }

  console.log(`[CORTEX] Pattern alerts: ${alertsPublished} published`)
  return { alerts_published: alertsPublished }
}

async function publishPatternAlert(
  content: string,
  patternKey: string,
  patternData: Record<string, unknown>,
): Promise<boolean> {
  try {
    const [post] = await db('posts')
      .insert({
        author_id:          PULSE_USER_ID,
        post_type:          'signal',
        content,
        pulse_content_type: 'pattern_alert',
        tags:               ['pulse', 'pattern-alert', 'cortex-analysis'],
        language:           'en',
      })
      .returning('*')

    await db('pulse_publish_log').insert({
      post_id:        post.id,
      content_type:   'pattern_alert',
      source_signals: [],
      model_used:     'cortex',
      token_count:    0,
      generation_ms:  0,
      metadata:       JSON.stringify({ pattern_key: patternKey, ...patternData }),
    })

    // Broadcast via WebSocket
    await redis.publish('wp:post.new', JSON.stringify({
      event:   'post.new',
      payload: { postId: post.id, contentType: 'pattern_alert', author: 'pulse' },
      filter:  { category: 'pulse' },
    })).catch(() => {})

    console.log(`[CORTEX] Pattern alert published: ${patternKey}`)
    return true
  } catch (err) {
    console.error(`[CORTEX] Failed to publish pattern alert:`, err)
    return false
  }
}

function formatCategory(cat: string): string {
  return cat
    .replace(/_/g, ' ')
    .replace(/\b\w/g, l => l.toUpperCase())
}
