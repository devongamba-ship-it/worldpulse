/**
 * Weekly Intelligence Synthesis — Phase 1.6.5
 *
 * Automated weekly report combining:
 *   - Active/escalating event threads
 *   - Top anomalies from baseline data
 *   - Rising entities and importance shifts
 *   - Pattern detection findings (chains, bridges, hotspots, sequences)
 *   - Feed quality summary
 *
 * Generates a comprehensive markdown digest and publishes as a PULSE post.
 * Runs Sunday 6am UTC (after pattern detection at 5am).
 *
 * @module cortex/weekly-synthesis
 */

import { db } from '../../db/postgres'
import { redis } from '../../db/redis'

const PULSE_USER_ID = process.env.PULSE_USER_ID || '00000000-0000-0000-0000-000000000000'

export interface WeeklySynthesis {
  period: { start: string; end: string }
  signal_stats: {
    total_signals: number
    by_severity: Record<string, number>
    top_categories: Array<{ category: string; count: number }>
  }
  threads: {
    new_threads: number
    escalating: Array<{ id: string; title: string; signal_count: number; peak_severity: string }>
    resolved: number
  }
  anomalies: Array<{
    category: string
    region: string
    z_score: number
    direction: string
    date: string
  }>
  entities: {
    rising: Array<{ name: string; type: string; trend: string; recent_7d: number }>
    most_important: Array<{ name: string; type: string; importance_score: number }>
  }
  patterns: {
    causal_chains: number
    hotspots: number
    bridges: number
    sequences: number
  }
  feed_quality: {
    avg_quality: number
    declining_sources: number
  } | null
}

/**
 * Generate the weekly intelligence synthesis.
 * Gathers data from all cortex subsystems and compiles a summary.
 */
export async function generateWeeklySynthesis(): Promise<WeeklySynthesis> {
  const end = new Date()
  const start = new Date(end.getTime() - 7 * 24 * 3600_000)
  const startStr = start.toISOString()
  const endStr = end.toISOString()

  // 1. Signal stats
  const totalResult = await db('signals')
    .where('created_at', '>=', startStr)
    .count('* as count')
    .first()
  const totalSignals = Number((totalResult as any)?.count ?? 0)

  const severityCounts = await db('signals')
    .where('created_at', '>=', startStr)
    .select('severity')
    .count('* as count')
    .groupBy('severity')

  const bySeverity: Record<string, number> = {}
  for (const r of severityCounts as any[]) {
    bySeverity[r.severity] = Number(r.count)
  }

  const topCategories = await db('signals')
    .where('created_at', '>=', startStr)
    .select('category')
    .count('* as count')
    .groupBy('category')
    .orderBy('count', 'desc')
    .limit(10)

  // 2. Thread activity
  const newThreadCount = await db('event_threads')
    .where('created_at', '>=', startStr)
    .count('* as count')
    .first()

  const escalatingThreads = await db('event_threads')
    .where('status', 'escalating')
    .select('id', 'title', 'signal_count', 'peak_severity')
    .orderBy('signal_count', 'desc')
    .limit(5)

  const resolvedCount = await db('event_threads')
    .where('resolved_at', '>=', startStr)
    .count('* as count')
    .first()

  // 3. Anomalies
  const anomalies = await db('signal_anomalies')
    .where('date', '>=', start.toISOString().slice(0, 10))
    .select('category', 'region', 'z_score', 'direction', 'date')
    .orderByRaw('ABS(z_score) DESC')
    .limit(10)

  // 4. Entity trends
  const risingEntities = await db('entity_nodes')
    .whereRaw("metadata->>'trend' = 'rising'")
    .where('mention_count', '>=', 5)
    .select('canonical_name', 'type', 'metadata')
    .orderBy('mention_count', 'desc')
    .limit(10)

  const importantEntities = await db('entity_nodes')
    .whereRaw("(metadata->>'importance_score')::float > 0.5")
    .select('canonical_name', 'type', 'metadata')
    .orderByRaw("(metadata->>'importance_score')::float DESC")
    .limit(10)

  // 5. Pattern detection results
  const patternReport = await redis.get('cortex:patterns:latest').catch(() => null)
  let patternStats = { causal_chains: 0, hotspots: 0, bridges: 0, sequences: 0 }
  if (patternReport) {
    const parsed = JSON.parse(patternReport)
    patternStats = {
      causal_chains: parsed.causal_chains?.length ?? 0,
      hotspots: parsed.geographic_hotspots?.length ?? 0,
      bridges: parsed.cross_cluster_bridges?.length ?? 0,
      sequences: parsed.temporal_sequences?.length ?? 0,
    }
  }

  // 6. Feed quality
  let feedQuality: WeeklySynthesis['feed_quality'] = null
  try {
    const qualityResult = await db('source_quality')
      .select(
        db.raw('AVG(quality_score) as avg_quality'),
        db.raw("COUNT(CASE WHEN trend = 'declining' THEN 1 END) as declining"),
      )
      .first()
    if (qualityResult) {
      feedQuality = {
        avg_quality: Math.round(Number((qualityResult as any).avg_quality ?? 0)),
        declining_sources: Number((qualityResult as any).declining ?? 0),
      }
    }
  } catch { /* source_quality table might not exist yet */ }

  return {
    period: { start: startStr, end: endStr },
    signal_stats: {
      total_signals: totalSignals,
      by_severity: bySeverity,
      top_categories: (topCategories as any[]).map(r => ({
        category: r.category,
        count: Number(r.count),
      })),
    },
    threads: {
      new_threads: Number((newThreadCount as any)?.count ?? 0),
      escalating: (escalatingThreads as any[]).map(t => ({
        id: t.id,
        title: t.title,
        signal_count: t.signal_count,
        peak_severity: t.peak_severity,
      })),
      resolved: Number((resolvedCount as any)?.count ?? 0),
    },
    anomalies: (anomalies as any[]).map(a => ({
      category: a.category,
      region: a.region,
      z_score: Number(a.z_score),
      direction: a.direction,
      date: a.date,
    })),
    entities: {
      rising: (risingEntities as any[]).map(e => {
        const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata ?? {}
        return {
          name: e.canonical_name,
          type: e.type,
          trend: meta.trend ?? 'unknown',
          recent_7d: meta.recent_7d ?? 0,
        }
      }),
      most_important: (importantEntities as any[]).map(e => {
        const meta = typeof e.metadata === 'string' ? JSON.parse(e.metadata) : e.metadata ?? {}
        return {
          name: e.canonical_name,
          type: e.type,
          importance_score: meta.importance_score ?? 0,
        }
      }),
    },
    patterns: patternStats,
    feed_quality: feedQuality,
  }
}

/**
 * Format the synthesis into a readable markdown report and publish as a PULSE post.
 */
export async function publishWeeklySynthesis(): Promise<{
  success: boolean
  postId?: string
  synthesis?: WeeklySynthesis
}> {
  const synthesis = await generateWeeklySynthesis()

  const startDate = new Date(synthesis.period.start).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric',
  })
  const endDate = new Date(synthesis.period.end).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  })

  // Build the report
  const sections: string[] = []

  sections.push(`# Weekly Intelligence Digest: ${startDate} – ${endDate}\n`)

  // Signal overview
  sections.push(`## Signal Overview\n`)
  sections.push(`**${synthesis.signal_stats.total_signals.toLocaleString()}** signals processed this week.`)
  const sevLine = Object.entries(synthesis.signal_stats.by_severity)
    .sort(([, a], [, b]) => b - a)
    .map(([sev, count]) => `${sev}: ${count.toLocaleString()}`)
    .join(' | ')
  if (sevLine) sections.push(`Severity: ${sevLine}`)

  if (synthesis.signal_stats.top_categories.length > 0) {
    const topCats = synthesis.signal_stats.top_categories
      .slice(0, 5)
      .map(c => `${c.category} (${c.count.toLocaleString()})`)
      .join(', ')
    sections.push(`Top categories: ${topCats}`)
  }

  // Developing stories
  if (synthesis.threads.escalating.length > 0 || synthesis.threads.new_threads > 0) {
    sections.push(`\n## Developing Stories\n`)
    sections.push(`${synthesis.threads.new_threads} new threads, ${synthesis.threads.resolved} resolved.`)
    if (synthesis.threads.escalating.length > 0) {
      sections.push(`\n**Escalating:**`)
      for (const t of synthesis.threads.escalating) {
        sections.push(`• ${t.title.slice(0, 100)} (${t.signal_count} signals, ${t.peak_severity})`)
      }
    }
  }

  // Anomalies
  if (synthesis.anomalies.length > 0) {
    sections.push(`\n## Notable Anomalies\n`)
    for (const a of synthesis.anomalies.slice(0, 5)) {
      sections.push(`• ${a.category}/${a.region}: ${a.z_score.toFixed(1)}σ ${a.direction} baseline (${a.date})`)
    }
  }

  // Entity trends
  if (synthesis.entities.rising.length > 0) {
    sections.push(`\n## Rising Entities\n`)
    for (const e of synthesis.entities.rising.slice(0, 5)) {
      sections.push(`• **${e.name}** (${e.type}) — ${e.recent_7d} mentions this week, trending ${e.trend}`)
    }
  }

  // Pattern insights
  if (synthesis.patterns.causal_chains + synthesis.patterns.hotspots + synthesis.patterns.sequences > 0) {
    sections.push(`\n## Pattern Detection\n`)
    sections.push(
      `${synthesis.patterns.causal_chains} causal chains, ` +
      `${synthesis.patterns.hotspots} geographic hotspots, ` +
      `${synthesis.patterns.bridges} cross-thread bridges, ` +
      `${synthesis.patterns.sequences} temporal sequences detected.`,
    )
  }

  // Feed quality
  if (synthesis.feed_quality) {
    sections.push(`\n## Feed Health\n`)
    sections.push(
      `Average source quality: ${synthesis.feed_quality.avg_quality}/100. ` +
      `${synthesis.feed_quality.declining_sources} sources declining.`,
    )
  }

  const content = sections.join('\n')

  // Publish as PULSE post
  try {
    const [post] = await db('posts')
      .insert({
        author_id:          PULSE_USER_ID,
        post_type:          'signal',
        content,
        pulse_content_type: 'weekly_synthesis',
        tags:               ['pulse', 'weekly-digest', 'cortex-analysis'],
        language:           'en',
      })
      .returning('*')

    await db('pulse_publish_log').insert({
      post_id:        post.id,
      content_type:   'weekly_synthesis',
      source_signals: [],
      model_used:     'cortex',
      token_count:    0,
      generation_ms:  0,
      metadata:       JSON.stringify({ period: synthesis.period }),
    })

    // Cache for API access
    await redis.setex('cortex:weekly-synthesis:latest', 8 * 24 * 3600, JSON.stringify(synthesis)).catch(() => {})

    // Broadcast
    await redis.publish('wp:post.new', JSON.stringify({
      event:   'post.new',
      payload: { postId: post.id, contentType: 'weekly_synthesis', author: 'pulse' },
      filter:  { category: 'pulse' },
    })).catch(() => {})

    console.log(`[CORTEX] Weekly synthesis published: ${post.id}`)
    return { success: true, postId: post.id, synthesis }
  } catch (err) {
    console.error('[CORTEX] Weekly synthesis publish failed:', err)
    return { success: false }
  }
}
