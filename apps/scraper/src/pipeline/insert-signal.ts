/**
 * Shared Signal Insertion Helper
 *
 * Provides a unified function for OSINT source pollers to insert signals
 * and automatically run cross-source event correlation. This ensures every
 * signal — whether from RSS-based scrapers or OSINT API pollers — flows
 * through the correlation engine.
 *
 * Usage:
 *   import { insertAndCorrelate } from '../pipeline/insert-signal'
 *
 *   const signal = await insertAndCorrelate({
 *     title, summary, category, severity, reliability_score,
 *     source_count: 1, source_ids: [sourceId],
 *     location: db.raw(`ST_MakePoint(?, ?)`, [lng, lat]),
 *     location_name, country_code, region, tags,
 *     language: 'en', event_time: new Date(pubDate),
 *   }, { lat, lng, sourceId })
 *
 * @module pipeline/insert-signal
 */

import { db } from '../lib/postgres'
import { redis } from '../lib/redis'
import { logger } from '../lib/logger'
import { correlateSignal } from './correlate'
import type { CorrelationCandidate } from './correlate'
import { recordSuccess } from '../health'
import { computeReliabilityScore, maxSeverityForSourceCount } from './reliability-score'
import { dedup, checkSemanticDuplicate } from './dedup'
import { processSignalForKnowledgeGraph, extractEntitiesRuleBased, upsertEntityNode } from './entity-graph'
import { embedSignal } from './embeddings'

// ─── Alert Tier Classification (inlined — canonical in apps/api/src/lib/alert-tier.ts) ──
const FLASH_RELIABILITY_THRESHOLD = 0.65
const ELEVATED_CATEGORIES = new Set(['breaking', 'conflict', 'disaster'])

function computeAlertTier(
  severity: string,
  reliabilityScore: number,
  category: string,
  zScoreBoost: boolean = false,
): 'FLASH' | 'PRIORITY' | 'ROUTINE' {
  let tier: 'FLASH' | 'PRIORITY' | 'ROUTINE' = 'ROUTINE'

  if (severity === 'critical') {
    tier = (reliabilityScore >= FLASH_RELIABILITY_THRESHOLD || category === 'breaking')
      ? 'FLASH' : 'PRIORITY'
  } else if (severity === 'high' || ELEVATED_CATEGORIES.has(category)) {
    tier = 'PRIORITY'
  }

  // Z-score escalation: if this category is experiencing anomalous volume (≥2σ),
  // boost the tier by one level — surfaces signals in unusual surges faster
  if (zScoreBoost && tier !== 'FLASH') {
    tier = tier === 'ROUTINE' ? 'PRIORITY' : 'FLASH'
  }

  return tier
}

/**
 * Check if the signal's category is currently experiencing anomalous volume
 * by reading cached z-score from cortex baselines (Redis).
 */
async function checkZScoreBoost(category: string): Promise<boolean> {
  try {
    const cached = await redis.get(`cortex:baseline:${category}:global:all`)
    if (!cached) return false
    const stats = JSON.parse(cached)
    // Boost if 7-day z-score ≥ 2.0 (anomalous surge)
    return (stats.z_score_7d ?? 0) >= 2.0
  } catch {
    return false
  }
}

/** Extra metadata not in the DB row but needed for correlation */
export interface CorrelationMeta {
  lat?: number | null
  lng?: number | null
  sourceId: string
  /** Human-readable source name for health tracking (defaults to sourceId) */
  sourceName?: string
  /** URL-safe source slug for health tracking (defaults to sourceId) */
  sourceSlug?: string
}

/**
 * Insert a signal into the database and run correlation.
 *
 * @param signalData - Columns for the `signals` table insert
 * @param meta - Lat/lng and sourceId for correlation scoring
 * @returns The inserted signal row (with id)
 */
export async function insertAndCorrelate(
  signalData: Record<string, unknown>,
  meta: CorrelationMeta,
): Promise<Record<string, unknown>> {
  // 0. Extract raw fields used throughout
  const rawSeverity  = String(signalData.severity ?? 'low')
  const rawCategory  = String(signalData.category ?? 'other')
  const sourceCount  = Number(signalData.source_count ?? 1)
  const rawSummary   = String(signalData.summary ?? '')
  const rawTitle     = String(signalData.title ?? '')
  const rawTags      = Array.isArray(signalData.tags) ? signalData.tags as string[] : []

  // 0a. Cross-source event dedup — skip if a very similar signal was already
  //     inserted within the last 6 hours. This prevents the same earthquake,
  //     fire, or conflict report from appearing multiple times in the feed
  //     when covered by different sources.
  try {
    const isDupe = await dedup.checkCrossSource(rawTitle, rawCategory)
    if (isDupe) {
      logger.debug({ title: rawTitle.slice(0, 80), category: rawCategory }, 'Cross-source duplicate — skipping insert')
      // Still record source health so the source appears active
      recordSuccess(
        meta.sourceId,
        meta.sourceName ?? meta.sourceId,
        meta.sourceSlug ?? meta.sourceId,
        undefined,
        1,
      ).catch(() => {})
      return { id: null, title: rawTitle, _skipped: true } as any
    }
  } catch {
    // Non-fatal — proceed with insert if dedup check fails
  }

  // 0b. Dynamic reliability scoring — adds per-signal variance

  const dynamicScore = computeReliabilityScore({
    baseReliability: Number(signalData.reliability_score ?? 0.5),
    severity:        rawSeverity,
    category:        rawCategory,
    hasSummary:      rawSummary.length > 0 && rawSummary !== rawTitle,
    hasLocation:     !!(meta.lat != null && meta.lng != null),
    tagCount:        rawTags.length,
    isStateMedia:    rawTags.includes('state-media'),
    sourceCount,
    language:        String(signalData.language ?? 'en'),
  })
  signalData.reliability_score = dynamicScore

  // 0c. Corroboration threshold — cap severity for single-source signals
  const maxSev = maxSeverityForSourceCount(sourceCount, rawCategory)
  const SEVERITY_RANK: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1, info: 0 }
  const MAX_RANK = SEVERITY_RANK[maxSev] ?? 4
  const currentRank = SEVERITY_RANK[rawSeverity] ?? 1
  if (currentRank > MAX_RANK) {
    signalData.severity = maxSev
    logger.info({
      title:      rawTitle.slice(0, 80),
      original:   rawSeverity,
      capped:     maxSev,
      sourceCount,
      category:   rawCategory,
    }, 'Severity capped by corroboration threshold')
  }

  // 1. Compute alert tier before insert (FLASH/PRIORITY/ROUTINE urgency classification)
  // Check if this category is in an anomalous surge (z-score ≥ 2σ) — boosts tier
  const zScoreBoost = await checkZScoreBoost(rawCategory)
  const alertTierComputed = computeAlertTier(
    String(signalData.severity ?? 'low'),
    dynamicScore,
    rawCategory,
    zScoreBoost,
  )
  const signalWithTier = { ...signalData, alert_tier: alertTierComputed }

  // 1. Insert the signal
  const [signal] = await db('signals').insert(signalWithTier).returning('*')

  // 1a. Record source health so the stability tracker can see this source as active.
  //     Non-blocking — a health tracking failure must never fail signal insertion.
  recordSuccess(
    meta.sourceId,
    meta.sourceName ?? meta.sourceId,
    meta.sourceSlug ?? meta.sourceId,
    undefined,
    1,
  ).catch(err => logger.debug({ err, sourceId: meta.sourceId }, 'Health recordSuccess failed (non-fatal)'))

  // 2. Run cross-source correlation (non-blocking — errors are non-fatal)
  try {
    // Fetch embedding if it exists (may have been set by on-insert embedding)
    let embedding: number[] | null = null
    try {
      const embRow = await db.raw(
        'SELECT embedding::text FROM signals WHERE id = ? AND embedding IS NOT NULL',
        [signal.id],
      )
      if (embRow.rows?.[0]?.embedding) {
        // pgvector format: "[0.1,0.2,...]" → number[]
        const raw = embRow.rows[0].embedding as string
        embedding = JSON.parse(raw.replace(/^\[/, '[').replace(/\]$/, ']'))
      }
    } catch { /* non-fatal — correlate without semantic scoring */ }

    const candidate: CorrelationCandidate = {
      id:               String(signal.id),
      title:            String(signal.title ?? ''),
      category:         String(signal.category ?? ''),
      severity:         String(signal.severity ?? 'low'),
      source_id:        meta.sourceId,
      location_name:    signal.location_name ?? null,
      lat:              meta.lat ?? null,
      lng:              meta.lng ?? null,
      published_at:     signal.event_time ?? signal.created_at ?? new Date(),
      reliability_score: Number(signal.reliability_score ?? 0.5),
      tags:             Array.isArray(signal.tags) ? signal.tags : [],
      embedding,
    }

    const cluster = await correlateSignal(candidate)

    if (cluster) {
      logger.info({
        signalId:    signal.id,
        clusterId:   cluster.cluster_id,
        clusterSize: cluster.signal_ids.length,
        corrType:    cluster.correlation_type,
        corrScore:   cluster.correlation_score.toFixed(2),
      }, 'OSINT signal correlated into event cluster')
    }
  } catch (err) {
    logger.warn({ err, signalId: signal.id }, 'OSINT signal correlation failed (non-fatal)')
  }

  // 3. Publish every signal to Redis so the live map WebSocket feed shows all new
  //    signals in real time — not just breaking/critical ones. The API-side ws/handler
  //    calls checkAndEmitBreakingAlert() for all signal.new events; that function
  //    performs its own severity/reliability gate, so it's safe to publish everything.
  try {
    const alertTier       = String(signal.alert_tier ?? alertTierComputed)
    const reliabilityScore = Number(signal.reliability_score ?? 0)

    // Include lat/lng so the live map WebSocket handler can render real-time pins.
    // extractLatLng() in the frontend requires these fields; without them the signal
    // is silently dropped from the map even when location data exists in the DB.
    const geoFields: Record<string, number> = {}
    if (meta.lat != null && meta.lng != null && isFinite(meta.lat) && isFinite(meta.lng)) {
      geoFields.lat = meta.lat
      geoFields.lng = meta.lng
    }

    await redis.publish('wp:signal.new', JSON.stringify({
      event: 'signal.new',
      payload: {
        id:               String(signal.id),
        title:            String(signal.title ?? ''),
        category:         String(signal.category ?? ''),
        severity:         String(signal.severity ?? 'low'),
        alert_tier:       alertTier,
        reliability_score: reliabilityScore,
        location_name:    signal.location_name ?? undefined,
        country_code:     signal.country_code ?? undefined,
        source_url:       signal.source_url ?? undefined,
        created_at:       signal.created_at instanceof Date
          ? signal.created_at.toISOString()
          : String(signal.created_at ?? new Date().toISOString()),
        ...geoFields,
      },
    }))

    if (alertTier === 'FLASH') {
      logger.warn({
        signalId:  signal.id,
        title:     signal.title,
        alertTier,
        severity:  String(signal.severity ?? 'low'),
        reliabilityScore,
      }, '[ALERT] FLASH tier signal — immediate dispatch triggered')
    }
  } catch (err) {
    logger.warn({ err, signalId: signal.id }, 'Breaking alert publish failed (non-fatal)')
  }

  // 4. Knowledge Graph — extract entities and build relationship graph.
  //    Cost control: rule-based extraction for ALL signals (free, decent quality).
  //    LLM extraction reserved for high/critical severity only (precision matters).
  try {
    const signalSeverity = String(signal.severity ?? 'low')
    const signalTitle    = String(signal.title ?? '')
    const signalSummary  = String(signal.summary ?? '')
    const signalId       = String(signal.id)
    const signalTime     = signal.created_at instanceof Date
      ? signal.created_at.toISOString()
      : String(signal.created_at ?? new Date().toISOString())

    if (signalSeverity === 'high' || signalSeverity === 'critical') {
      // Full LLM extraction for high-value signals (with rule-based fallback)
      await processSignalForKnowledgeGraph(signalId, signalTitle, signalSummary, signalTime)
    } else {
      // Rule-based extraction only — zero API cost
      const extraction = extractEntitiesRuleBased(signalTitle, signalSummary)
      for (const entity of extraction.entities) {
        await upsertEntityNode(entity, signalId, signalTime)
      }
      if (extraction.entities.length > 0) {
        logger.debug({ signalId, entities: extraction.entities.length }, 'Rule-based entity extraction complete')
      }
    }
  } catch (err) {
    logger.debug({ err, signalId: signal.id }, 'Knowledge graph processing failed (non-fatal)')
  }

  // 5. Vector embedding — async, non-blocking
  //    Generates embedding for semantic search & similarity matching.
  //    After embedding succeeds, run semantic dedup to detect near-identical signals.
  try {
    embedSignal(String(signal.id), String(signal.title ?? ''), String(signal.summary ?? ''))
      .then(async (embedded) => {
        if (!embedded) return
        // 5a. Semantic dedup — flag near-duplicates (cosine > 0.92 within 12h)
        const originalId = await checkSemanticDuplicate(String(signal.id))
        if (originalId) {
          logger.info({ signalId: signal.id, originalId }, 'Signal flagged as semantic duplicate')
        }
      })
      .catch(err => logger.debug({ err, signalId: signal.id }, 'Embedding/dedup failed (non-fatal)'))
  } catch (err) {
    logger.debug({ err, signalId: signal.id }, 'Embedding setup failed (non-fatal)')
  }

  return signal
}
