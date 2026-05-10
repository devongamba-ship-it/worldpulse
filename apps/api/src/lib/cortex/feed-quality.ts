/**
 * Feed Quality Scoring — Phase 1.6.6
 *
 * Computes per-source quality metrics to identify which feeds are
 * contributing high-value intelligence vs noise.
 *
 * Metrics per source:
 *   - Freshness: average time between signal publication and ingestion
 *   - Accuracy: average reliability score of signals from this source
 *   - Corroboration: % of signals that get multi-source corroboration
 *   - Volume consistency: signal count stability over time
 *   - Quality score: weighted composite 0-100
 *
 * Designed to run nightly after baselines (5am UTC) or on-demand.
 *
 * @module cortex/feed-quality
 */

import { db } from '../../db/postgres'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface SourceQuality {
  source_id: string
  source_name: string
  total_signals: number
  avg_reliability: number
  corroboration_rate: number
  avg_freshness_min: number
  volume_7d: number
  volume_30d: number
  last_signal_at: string | null
  quality_score: number
  trend: 'improving' | 'stable' | 'declining'
}

// ─── Compute feed quality scores ────────────────────────────────────────────

/**
 * Compute quality scores for all active sources.
 * A source is "active" if it produced at least 1 signal in the last 30 days.
 */
export async function computeFeedQuality(): Promise<{
  sources_scored: number
  avg_quality: number
  top_sources: Array<{ source_id: string; name: string; score: number }>
  bottom_sources: Array<{ source_id: string; name: string; score: number }>
}> {
  console.log('[CORTEX] Computing feed quality scores...')

  // Get per-source metrics from the last 30 days
  const sourceMetrics = await db.raw(`
    WITH source_signals AS (
      SELECT
        s.id as signal_id,
        unnest(s.source_ids) as source_id,
        s.reliability_score,
        s.source_count,
        s.created_at,
        s.published_at,
        s.last_corroborated_at
      FROM signals s
      WHERE s.created_at >= NOW() - INTERVAL '30 days'
        AND s.status IN ('verified', 'pending')
    ),
    metrics AS (
      SELECT
        ss.source_id,
        COUNT(*) as total_signals,
        AVG(ss.reliability_score) as avg_reliability,
        -- Corroboration rate: signals that got multi-source confirmation
        AVG(CASE WHEN ss.source_count >= 2 THEN 1.0 ELSE 0.0 END) as corroboration_rate,
        -- Freshness: avg minutes between publication and ingestion
        AVG(EXTRACT(EPOCH FROM (ss.created_at - COALESCE(ss.published_at, ss.created_at))) / 60.0)
          as avg_freshness_min,
        -- 7-day volume
        COUNT(*) FILTER (WHERE ss.created_at >= NOW() - INTERVAL '7 days') as volume_7d,
        -- Last signal timestamp
        MAX(ss.created_at) as last_signal_at
      FROM source_signals ss
      GROUP BY ss.source_id
      HAVING COUNT(*) >= 3
    )
    SELECT
      m.*,
      COALESCE(src.name, m.source_id) as source_name
    FROM metrics m
    LEFT JOIN sources src ON src.id::text = m.source_id
    ORDER BY m.total_signals DESC
  `)

  const rows = sourceMetrics.rows ?? []
  if (rows.length === 0) {
    console.log('[CORTEX] No active sources found for quality scoring')
    return { sources_scored: 0, avg_quality: 0, top_sources: [], bottom_sources: [] }
  }

  // Get previous scores for trend detection
  const prevScores = new Map<string, number>()
  const prevRows = await db('source_quality').select('source_id', 'quality_score')
  for (const r of prevRows as any[]) {
    prevScores.set(r.source_id, Number(r.quality_score))
  }

  // Compute quality score for each source
  const scored: SourceQuality[] = rows.map((r: any) => {
    const totalSignals = Number(r.total_signals)
    const avgReliability = Number(r.avg_reliability ?? 0)
    const corrobRate = Number(r.corroboration_rate ?? 0)
    const avgFreshness = Math.max(0, Number(r.avg_freshness_min ?? 0))
    const volume7d = Number(r.volume_7d ?? 0)
    const volume30d = totalSignals

    // Score components (each 0-100):
    // 1. Reliability (30% weight) — avg reliability score
    const reliabilityScore = Math.min(100, avgReliability * 100)

    // 2. Corroboration (25% weight) — signals confirmed by other sources
    const corrobScore = Math.min(100, corrobRate * 100)

    // 3. Freshness (20% weight) — how quickly signals are ingested
    //    0 min = 100, 60 min = 70, 360 min (6h) = 30, >1440 min (24h) = 0
    const freshnessScore = avgFreshness <= 0 ? 100
      : avgFreshness <= 60 ? 100 - (avgFreshness / 60) * 30
      : avgFreshness <= 360 ? 70 - ((avgFreshness - 60) / 300) * 40
      : avgFreshness <= 1440 ? 30 - ((avgFreshness - 360) / 1080) * 30
      : 0

    // 4. Volume consistency (15% weight) — steady output, not bursty
    //    Ideal: 7d volume is ~25% of 30d volume (consistent daily rate)
    const expectedRatio = 7 / 30
    const actualRatio = volume30d > 0 ? volume7d / volume30d : 0
    const volumeConsistency = actualRatio > 0
      ? Math.min(100, 100 - Math.abs(actualRatio - expectedRatio) / expectedRatio * 100)
      : 0

    // 5. Recency (10% weight) — when was the last signal
    const hoursSinceLastSignal = r.last_signal_at
      ? (Date.now() - new Date(r.last_signal_at).getTime()) / (3600 * 1000)
      : 999
    const recencyScore = hoursSinceLastSignal <= 1 ? 100
      : hoursSinceLastSignal <= 6 ? 90
      : hoursSinceLastSignal <= 24 ? 70
      : hoursSinceLastSignal <= 72 ? 40
      : 10

    // Weighted composite
    const qualityScore = Math.round(
      reliabilityScore * 0.30 +
      corrobScore * 0.25 +
      freshnessScore * 0.20 +
      volumeConsistency * 0.15 +
      recencyScore * 0.10
    )

    // Trend detection
    const prevScore = prevScores.get(r.source_id)
    const trend: 'improving' | 'stable' | 'declining' =
      prevScore == null ? 'stable'
      : qualityScore > prevScore + 5 ? 'improving'
      : qualityScore < prevScore - 5 ? 'declining'
      : 'stable'

    return {
      source_id: r.source_id,
      source_name: r.source_name ?? r.source_id,
      total_signals: totalSignals,
      avg_reliability: Math.round(avgReliability * 1000) / 1000,
      corroboration_rate: Math.round(corrobRate * 1000) / 1000,
      avg_freshness_min: Math.round(avgFreshness * 10) / 10,
      volume_7d: volume7d,
      volume_30d: volume30d,
      last_signal_at: r.last_signal_at,
      quality_score: qualityScore,
      trend,
    }
  })

  // Upsert all scores
  for (const s of scored) {
    await db('source_quality')
      .insert({
        source_id: s.source_id,
        source_name: s.source_name,
        total_signals: s.total_signals,
        avg_reliability: s.avg_reliability,
        corroboration_rate: s.corroboration_rate,
        avg_freshness_min: s.avg_freshness_min,
        volume_7d: s.volume_7d,
        volume_30d: s.volume_30d,
        last_signal_at: s.last_signal_at,
        quality_score: s.quality_score,
        trend: s.trend,
        updated_at: new Date().toISOString(),
      })
      .onConflict('source_id')
      .merge()
  }

  const avgQuality = Math.round(
    scored.reduce((sum, s) => sum + s.quality_score, 0) / scored.length
  )

  // Sort for top/bottom
  const sorted = [...scored].sort((a, b) => b.quality_score - a.quality_score)
  const top = sorted.slice(0, 5).map(s => ({
    source_id: s.source_id, name: s.source_name, score: s.quality_score,
  }))
  const bottom = sorted.slice(-5).reverse().map(s => ({
    source_id: s.source_id, name: s.source_name, score: s.quality_score,
  }))

  console.log(`[CORTEX] Feed quality: ${scored.length} sources scored, avg quality ${avgQuality}/100`)
  console.log(`[CORTEX] Top sources: ${top.map(s => `${s.name}(${s.score})`).join(', ')}`)
  console.log(`[CORTEX] Bottom sources: ${bottom.map(s => `${s.name}(${s.score})`).join(', ')}`)

  return {
    sources_scored: scored.length,
    avg_quality: avgQuality,
    top_sources: top,
    bottom_sources: bottom,
  }
}

/**
 * Get quality scores for all tracked sources.
 */
export async function getSourceQualityScores(): Promise<SourceQuality[]> {
  const rows = await db('source_quality')
    .orderBy('quality_score', 'desc')

  return rows as SourceQuality[]
}

/**
 * Get quality summary for the cortex health dashboard.
 */
export async function getFeedQualitySummary(): Promise<{
  total_sources: number
  avg_quality: number
  sources_above_70: number
  sources_below_30: number
  declining_count: number
}> {
  const stats = await db.raw(`
    SELECT
      COUNT(*) as total_sources,
      AVG(quality_score) as avg_quality,
      COUNT(*) FILTER (WHERE quality_score >= 70) as above_70,
      COUNT(*) FILTER (WHERE quality_score < 30) as below_30,
      COUNT(*) FILTER (WHERE trend = 'declining') as declining
    FROM source_quality
  `)

  const row = stats.rows?.[0] ?? {}
  return {
    total_sources: Number(row.total_sources ?? 0),
    avg_quality: Math.round(Number(row.avg_quality ?? 0)),
    sources_above_70: Number(row.above_70 ?? 0),
    sources_below_30: Number(row.below_30 ?? 0),
    declining_count: Number(row.declining ?? 0),
  }
}
