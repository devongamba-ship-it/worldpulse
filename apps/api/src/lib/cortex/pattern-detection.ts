/**
 * Cross-Domain Pattern Detection — Phase 1.6.5
 *
 * Discovers emergent patterns the hardcoded causal chain rules don't cover.
 *
 * Systems:
 *   1. Learned causal chains — analyze correlation data for actual category co-occurrences
 *   2. Cross-cluster bridging — detect when event threads share entities/geography
 *   3. Geographic hotspot detection — grid-based multi-category density analysis
 *   4. Temporal sequence mining — detect repeating event sequences
 *
 * Runs weekly (Sunday 5am UTC) as a deep analysis pass.
 *
 * @module cortex/pattern-detection
 */

import { db } from '../../db/postgres'
import { redis } from '../../db/redis'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface LearnedCausalChain {
  source_category: string
  target_category: string
  co_occurrence_count: number
  avg_time_delta_hours: number
  confidence: number
  example_signals: Array<{ source_id: string; target_id: string }>
}

export interface GeographicHotspot {
  region: string
  lat_center: number
  lng_center: number
  categories: string[]
  signal_count: number
  severity_distribution: Record<string, number>
  anomaly_score: number  // How unusual is this multi-category clustering
}

export interface CrossClusterBridge {
  thread_a_id: string
  thread_a_title: string
  thread_b_id: string
  thread_b_title: string
  shared_entities: string[]
  shared_region: string | null
  connection_strength: number
}

export interface TemporalSequence {
  sequence: string[]           // ['sanctions', 'dark_vessel_spike', 'chokepoint_alert']
  occurrences: number
  avg_interval_hours: number
  last_seen: string
  predictive_value: number     // How consistently does step N predict step N+1
}

// ─── Constants ───────────────────────────────────────────────────────────────

const CHAIN_MIN_OCCURRENCES = 3
const CHAIN_WINDOW_HOURS = 48
const HOTSPOT_GRID_SIZE_DEG = 2     // ~200km grid cells
const HOTSPOT_MIN_CATEGORIES = 2
const HOTSPOT_MIN_SIGNALS = 5
const BRIDGE_MIN_SHARED_ENTITIES = 2
const PATTERN_CACHE_TTL = 3600

// ─── Learned Causal Chains ───────────────────────────────────────────────────

/**
 * Analyze correlation data to discover which category pairs actually co-occur
 * within 48h windows, ranked by frequency and confidence.
 */
export async function learnCausalChains(
  days: number = 30,
): Promise<LearnedCausalChain[]> {
  console.log('[CORTEX] Learning causal chains from correlation data...')

  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()

  // Find signal pairs that were correlated (in same event thread or cluster)
  // and have different categories
  const pairs = await db.raw(`
    SELECT
      s1.category as source_cat,
      s2.category as target_cat,
      COUNT(*) as pair_count,
      AVG(EXTRACT(EPOCH FROM (s2.published_at - s1.published_at)) / 3600) as avg_delta_hours,
      json_agg(json_build_object('source_id', s1.id, 'target_id', s2.id) ORDER BY s1.published_at DESC) as examples
    FROM event_thread_signals ets1
    JOIN event_thread_signals ets2
      ON ets1.thread_id = ets2.thread_id
      AND ets1.signal_id != ets2.signal_id
    JOIN signals s1 ON ets1.signal_id = s1.id
    JOIN signals s2 ON ets2.signal_id = s2.id
    WHERE s1.category != s2.category
      AND s1.published_at >= ?
      AND s1.published_at < s2.published_at
      AND EXTRACT(EPOCH FROM (s2.published_at - s1.published_at)) / 3600 <= ?
    GROUP BY s1.category, s2.category
    HAVING COUNT(*) >= ?
    ORDER BY COUNT(*) DESC
    LIMIT 30
  `, [cutoff, CHAIN_WINDOW_HOURS, CHAIN_MIN_OCCURRENCES])

  const chains: LearnedCausalChain[] = (pairs.rows ?? []).map((r: any) => ({
    source_category: r.source_cat,
    target_category: r.target_cat,
    co_occurrence_count: Number(r.pair_count),
    avg_time_delta_hours: Math.round(Number(r.avg_delta_hours) * 10) / 10,
    confidence: Math.min(0.9, Number(r.pair_count) / 20), // Normalize to 0-0.9
    example_signals: (r.examples ?? []).slice(0, 3),
  }))

  console.log(`[CORTEX] Discovered ${chains.length} causal chains`)
  for (const chain of chains.slice(0, 5)) {
    console.log(`  ${chain.source_category} → ${chain.target_category}: ${chain.co_occurrence_count}x (avg ${chain.avg_time_delta_hours}h delta)`)
  }

  return chains
}

// ─── Cross-Cluster Bridging ──────────────────────────────────────────────────

/**
 * Detect when active event threads share entities, geography, or temporal overlap
 * but were classified in different categories.
 */
export async function detectCrossClusterBridges(): Promise<CrossClusterBridge[]> {
  console.log('[CORTEX] Detecting cross-cluster bridges...')

  // Find thread pairs that share entities via entity_nodes.signal_ids
  const bridges = await db.raw(`
    WITH thread_entities AS (
      SELECT
        et.id as thread_id,
        et.title as thread_title,
        et.category,
        et.region,
        en.canonical_name as entity_name,
        en.id as entity_id
      FROM event_threads et
      JOIN event_thread_signals ets ON et.id = ets.thread_id
      JOIN entity_nodes en ON ets.signal_id = ANY(
        CASE
          WHEN jsonb_typeof(to_jsonb(en.signal_ids)) = 'array'
          THEN ARRAY(SELECT jsonb_array_elements_text(to_jsonb(en.signal_ids)))
          ELSE ARRAY[en.signal_ids::text]
        END
      )
      WHERE et.status IN ('developing', 'escalating')
    )
    SELECT
      te1.thread_id as thread_a_id,
      te1.thread_title as thread_a_title,
      te2.thread_id as thread_b_id,
      te2.thread_title as thread_b_title,
      array_agg(DISTINCT te1.entity_name) as shared_entities,
      CASE WHEN te1.region = te2.region THEN te1.region ELSE NULL END as shared_region,
      COUNT(DISTINCT te1.entity_name) as entity_overlap
    FROM thread_entities te1
    JOIN thread_entities te2
      ON te1.entity_id = te2.entity_id
      AND te1.thread_id < te2.thread_id
      AND te1.category != te2.category
    GROUP BY te1.thread_id, te1.thread_title, te2.thread_id, te2.thread_title,
             te1.region, te2.region
    HAVING COUNT(DISTINCT te1.entity_name) >= ?
    ORDER BY COUNT(DISTINCT te1.entity_name) DESC
    LIMIT 20
  `, [BRIDGE_MIN_SHARED_ENTITIES])

  const results: CrossClusterBridge[] = (bridges.rows ?? []).map((r: any) => ({
    thread_a_id: r.thread_a_id,
    thread_a_title: r.thread_a_title,
    thread_b_id: r.thread_b_id,
    thread_b_title: r.thread_b_title,
    shared_entities: r.shared_entities ?? [],
    shared_region: r.shared_region,
    connection_strength: Math.min(1, Number(r.entity_overlap) / 5),
  }))

  if (results.length > 0) {
    console.log(`[CORTEX] Found ${results.length} cross-cluster bridges`)
  }

  return results
}

// ─── Geographic Hotspot Detection ────────────────────────────────────────────

/**
 * Grid-based signal density analysis to identify regions with unusual
 * multi-category activity.
 */
export async function detectGeographicHotspots(
  days: number = 7,
): Promise<GeographicHotspot[]> {
  console.log('[CORTEX] Detecting geographic hotspots...')

  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()

  // Grid signals into cells and find multi-category clusters
  const cells = await db.raw(`
    SELECT
      FLOOR(ST_Y(location::geometry) / ?) * ? as lat_cell,
      FLOOR(ST_X(location::geometry) / ?) * ? as lng_cell,
      array_agg(DISTINCT category) as categories,
      COUNT(*) as signal_count,
      json_object_agg(severity, sev_count) as severity_dist,
      AVG(ST_Y(location::geometry)) as lat_center,
      AVG(ST_X(location::geometry)) as lng_center
    FROM (
      SELECT
        category, severity, location,
        COUNT(*) OVER (PARTITION BY category, severity,
          FLOOR(ST_Y(location::geometry) / ?),
          FLOOR(ST_X(location::geometry) / ?)) as sev_count
      FROM signals
      WHERE location IS NOT NULL
        AND created_at >= ?
    ) sub
    GROUP BY lat_cell, lng_cell
    HAVING COUNT(DISTINCT category) >= ?
      AND COUNT(*) >= ?
    ORDER BY COUNT(*) DESC
    LIMIT 20
  `, [
    HOTSPOT_GRID_SIZE_DEG, HOTSPOT_GRID_SIZE_DEG,
    HOTSPOT_GRID_SIZE_DEG, HOTSPOT_GRID_SIZE_DEG,
    HOTSPOT_GRID_SIZE_DEG, HOTSPOT_GRID_SIZE_DEG,
    cutoff,
    HOTSPOT_MIN_CATEGORIES,
    HOTSPOT_MIN_SIGNALS,
  ])

  // Enrich with region names
  const hotspots: GeographicHotspot[] = []
  for (const cell of (cells.rows ?? []) as any[]) {
    // Reverse geocode the center — use nearest signal's location_name
    const nearest = await db('signals')
      .whereNotNull('location_name')
      .whereNotNull('location')
      .where('created_at', '>=', cutoff)
      .whereRaw(
        'ST_DWithin(location::geography, ST_SetSRID(ST_MakePoint(?, ?), 4326)::geography, ?)',
        [Number(cell.lng_center), Number(cell.lat_center), HOTSPOT_GRID_SIZE_DEG * 111000],
      )
      .select('location_name')
      .first()

    hotspots.push({
      region: nearest?.location_name ?? `${Number(cell.lat_center).toFixed(1)}°, ${Number(cell.lng_center).toFixed(1)}°`,
      lat_center: Number(cell.lat_center),
      lng_center: Number(cell.lng_center),
      categories: cell.categories ?? [],
      signal_count: Number(cell.signal_count),
      severity_distribution: cell.severity_dist ?? {},
      anomaly_score: Math.min(1, (cell.categories?.length ?? 0) / 5 * (Number(cell.signal_count) / 20)),
    })
  }

  if (hotspots.length > 0) {
    console.log(`[CORTEX] Found ${hotspots.length} geographic hotspots`)
    for (const h of hotspots.slice(0, 3)) {
      console.log(`  ${h.region}: ${h.categories.join(', ')} (${h.signal_count} signals)`)
    }
  }

  return hotspots
}

// ─── Temporal Sequence Mining ────────────────────────────────────────────────

/**
 * Discover recurring event sequences from signal category chains within
 * event threads. For example: sanctions → dark_vessel_spike → chokepoint_alert.
 *
 * Looks at the order categories appear within threads, then finds sequences
 * that repeat across multiple threads.
 */
export async function mineTemporalSequences(
  days: number = 60,
): Promise<TemporalSequence[]> {
  console.log('[CORTEX] Mining temporal sequences...')

  const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString()

  // Get category sequences per thread (ordered by published_at)
  const threadSequences = await db.raw(`
    SELECT
      et.id as thread_id,
      array_agg(DISTINCT s.category ORDER BY s.published_at) as category_sequence,
      array_agg(s.published_at ORDER BY s.published_at) as timestamps
    FROM event_threads et
    JOIN event_thread_signals ets ON et.id = ets.thread_id
    JOIN signals s ON ets.signal_id = s.id
    WHERE et.created_at >= ?
      AND et.signal_count >= 3
    GROUP BY et.id
    HAVING COUNT(DISTINCT s.category) >= 2
    ORDER BY et.created_at DESC
    LIMIT 200
  `, [cutoff])

  const rows = threadSequences.rows ?? []
  if (rows.length < 3) {
    console.log('[CORTEX] Not enough multi-category threads for sequence mining')
    return []
  }

  // Extract 2-gram and 3-gram category sequences and count occurrences
  const sequenceCounts = new Map<string, {
    count: number
    intervals: number[]
    last_seen: string
  }>()

  for (const row of rows as any[]) {
    const cats: string[] = row.category_sequence ?? []
    const timestamps: string[] = row.timestamps ?? []

    // 2-grams
    for (let i = 0; i < cats.length - 1; i++) {
      const key = `${cats[i]}→${cats[i + 1]}`
      if (!sequenceCounts.has(key)) {
        sequenceCounts.set(key, { count: 0, intervals: [], last_seen: '' })
      }
      const entry = sequenceCounts.get(key)!
      entry.count++

      // Compute interval between the two categories
      if (timestamps[i] && timestamps[i + 1]) {
        const delta = (new Date(timestamps[i + 1]).getTime() - new Date(timestamps[i]).getTime()) / 3600000
        if (delta > 0 && delta < 720) entry.intervals.push(delta) // Cap at 30 days
      }

      if (!entry.last_seen || timestamps[i + 1] > entry.last_seen) {
        entry.last_seen = timestamps[i + 1]
      }
    }

    // 3-grams
    for (let i = 0; i < cats.length - 2; i++) {
      const key = `${cats[i]}→${cats[i + 1]}→${cats[i + 2]}`
      if (!sequenceCounts.has(key)) {
        sequenceCounts.set(key, { count: 0, intervals: [], last_seen: '' })
      }
      const entry = sequenceCounts.get(key)!
      entry.count++
      if (timestamps[i + 2] && (!entry.last_seen || timestamps[i + 2] > entry.last_seen)) {
        entry.last_seen = timestamps[i + 2]
      }
    }
  }

  // Filter to sequences occurring 3+ times
  const sequences: TemporalSequence[] = []

  for (const [key, data] of sequenceCounts) {
    if (data.count < 3) continue

    const parts = key.split('→')
    const avgInterval = data.intervals.length > 0
      ? data.intervals.reduce((a, b) => a + b, 0) / data.intervals.length
      : 0

    // Predictive value: how consistent is the interval? (lower variance = more predictive)
    let predictiveValue = 0
    if (data.intervals.length >= 3) {
      const mean = avgInterval
      const variance = data.intervals.reduce((sum, v) => sum + (v - mean) ** 2, 0) / data.intervals.length
      const cv = mean > 0 ? Math.sqrt(variance) / mean : 1 // coefficient of variation
      predictiveValue = Math.max(0, Math.min(1, 1 - cv)) // Lower CV = more predictive
    }

    sequences.push({
      sequence: parts,
      occurrences: data.count,
      avg_interval_hours: Math.round(avgInterval * 10) / 10,
      last_seen: data.last_seen,
      predictive_value: Math.round(predictiveValue * 100) / 100,
    })
  }

  // Sort by occurrences desc, then predictive value
  sequences.sort((a, b) => b.occurrences - a.occurrences || b.predictive_value - a.predictive_value)

  const top = sequences.slice(0, 20)
  console.log(`[CORTEX] Temporal sequences: ${sequences.length} total, top ${top.length} kept`)
  for (const s of top.slice(0, 5)) {
    console.log(`  ${s.sequence.join(' → ')}: ${s.occurrences}x (avg ${s.avg_interval_hours}h, predictive ${s.predictive_value})`)
  }

  return top
}

// ─── Full Pattern Detection Cycle ────────────────────────────────────────────

/**
 * Run the full weekly pattern detection pass.
 * Stores results in Redis for API access.
 */
export async function runPatternDetectionCycle(): Promise<{
  causal_chains: number
  bridges: number
  hotspots: number
  temporal_sequences: number
}> {
  console.log('[CORTEX] Running weekly pattern detection...')

  const chains = await learnCausalChains(30)
  const bridges = await detectCrossClusterBridges()
  const hotspots = await detectGeographicHotspots(7)
  const sequences = await mineTemporalSequences(60)

  // Cache results for API access
  const report = {
    generated_at: new Date().toISOString(),
    causal_chains: chains,
    cross_cluster_bridges: bridges,
    geographic_hotspots: hotspots,
    temporal_sequences: sequences,
  }

  await redis.setex('cortex:patterns:latest', 7 * 24 * 3600, JSON.stringify(report)).catch(() => {})

  console.log(`[CORTEX] Pattern detection complete: ${chains.length} chains, ${bridges.length} bridges, ${hotspots.length} hotspots, ${sequences.length} sequences`)

  return {
    causal_chains: chains.length,
    bridges: bridges.length,
    hotspots: hotspots.length,
    temporal_sequences: sequences.length,
  }
}
