/**
 * PULSE API routes — endpoints for the autonomous AI editorial system.
 *
 * Public routes:
 *   GET  /api/v1/pulse/feed     — PULSE-authored posts for AI Digest tab
 *   GET  /api/v1/pulse/stats    — publishing statistics
 *   GET  /api/v1/pulse/latest   — latest PULSE post by content type
 *
 * Internal routes (require PULSE_API_KEY):
 *   POST /api/v1/pulse/publish/flash     — publish a flash brief
 *   POST /api/v1/pulse/publish/analysis  — publish an analysis
 *   POST /api/v1/pulse/publish/briefing  — publish daily briefing
 *   POST /api/v1/pulse/publish/syndicate — syndicate a social post
 *   POST /api/v1/pulse/check-flash       — auto-check for new flash briefs
 */
import type { FastifyPluginAsync, FastifyRequest, FastifyReply } from 'fastify'
import { db } from '../db/postgres'
import { optionalAuth } from '../middleware/auth'
import { sendError } from '../lib/errors'
import { PULSE_USER_ID, ContentType } from '../lib/pulse/constants'
import {
  publishFlashBrief,
  publishAnalysis,
  publishDailyBriefing,
  publishBriefingUpdate,
  syndicatePost,
  checkAndPublishFlashBriefs,
  getTopSignals,
  getPublishStats,
} from '../lib/pulse/publisher'
import { getAgentStatus, runAgentBeatScan } from '../lib/pulse/agents/coordinator'
import {
  registerSocialPost,
  batchRegisterSocialPosts,
  getSyndicatedPosts,
} from '../lib/pulse/syndication'
import { generateSignalSummary } from '../lib/signal-summary'
import { detectTrends, getEscalatingEvents } from '../lib/pulse/trending'
import { generateContent } from '../lib/pulse/publisher'

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Word-level Jaccard similarity between two titles (0-1). */
function titleWordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.split(/\s+/).filter(w => w.length > 2))
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 2))
  if (wordsA.size === 0 || wordsB.size === 0) return 0
  let intersection = 0
  for (const w of wordsA) { if (wordsB.has(w)) intersection++ }
  const union = new Set([...wordsA, ...wordsB]).size
  return union > 0 ? intersection / union : 0
}

// ─── Internal auth — requires PULSE_API_KEY env var ───────────────────────

function requirePulseKey(req: FastifyRequest, reply: FastifyReply, done: () => void) {
  const key = process.env.PULSE_API_KEY
  if (!key) {
    reply.status(503).send({ success: false, error: 'PULSE system not configured' })
    return
  }
  const provided = req.headers['x-pulse-key'] ?? req.headers.authorization?.replace('Bearer ', '')
  if (provided !== key) {
    reply.status(401).send({ success: false, error: 'Invalid PULSE API key' })
    return
  }
  done()
}

// ─── Plugin ───────────────────────────────────────────────────────────────

export const registerPulseRoutes: FastifyPluginAsync = async (app) => {

  app.addHook('onRoute', (routeOptions) => {
    routeOptions.schema ??= {}
    routeOptions.schema.tags = routeOptions.schema.tags ?? ['pulse']
  })

  // ══════════════════════════════════════════════════════════════════════════
  // PUBLIC ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/v1/pulse/feed
   * Returns posts authored by PULSE for the AI Digest tab.
   * Supports pagination, optional content_type filter.
   */
  app.get('/feed', { preHandler: [optionalAuth] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const cursor = query.cursor
    const contentType = query.content_type
    const limit = Math.min(Number(query.limit) || 20, 50)

    // ── Quality-filtered PULSE feed ─────────────────────────────────────────
    // Flash briefs pass through a tiered quality gate. Editorial content
    // (briefings, analysis) is always shown. Category diversity is enforced
    // post-query to prevent any single category from flooding the feed.
    //
    // We over-fetch (3x limit) to allow room for diversity filtering, then
    // trim to the requested page size.
    const overFetchLimit = limit * 3

    let q = db('posts as p')
      .join('users as u', 'p.author_id', 'u.id')
      .leftJoin('signals as s', 'p.signal_id', 's.id')
      .where('p.author_id', PULSE_USER_ID)
      .where('p.deleted_at', null)
      .where(function () {
        this
          // Editorial content (briefings, analysis) — always show
          .whereIn('p.pulse_content_type', ['daily_briefing', 'analysis', 'social_thread', 'weekly_report', 'syndicated'])
          // Flash briefs — tiered quality gate
          // Corroboration-aware: multi-source signals get easier passage,
          // single-source must clear higher bars or be from strategic categories
          .orWhere(function () {
            this.where('p.pulse_content_type', 'flash_brief')
              .whereNotIn('s.category', ['culture', 'sports', 'other'])
              .where(function () {
                // Tier 1a: CRITICAL with 3+ sources — fully corroborated
                this.where(function () {
                  this.where('s.severity', 'critical')
                    .where('s.reliability_score', '>=', 0.55)
                    .where('s.source_count', '>=', 3)
                })
                // Tier 1b: CRITICAL single/dual-source — only institutional categories + high reliability
                .orWhere(function () {
                  this.where('s.severity', 'critical')
                    .where('s.reliability_score', '>=', 0.70)
                    .whereIn('s.category', ['disaster', 'health', 'security', 'conflict'])
                })
                // Tier 2a: HIGH with 2+ sources — corroborated
                .orWhere(function () {
                  this.where('s.severity', 'high')
                    .where('s.reliability_score', '>=', 0.55)
                    .where('s.source_count', '>=', 2)
                })
                // Tier 2b: HIGH single-source — only strategic categories + high reliability
                .orWhere(function () {
                  this.where('s.severity', 'high')
                    .where('s.reliability_score', '>=', 0.70)
                    .whereIn('s.category', ['conflict', 'geopolitics', 'security', 'disaster', 'health', 'breaking'])
                })
                // Tier 3: MEDIUM from high-reliability, important sources (unchanged)
                .orWhere(function () {
                  this.where('s.severity', 'medium')
                    .where('s.reliability_score', '>=', 0.75)
                    .whereIn('s.category', ['conflict', 'geopolitics', 'security', 'disaster', 'health', 'economy', 'elections', 'breaking'])
                })
              })
          })
          // Posts without a content type (legacy) — let through if signal is decent
          .orWhere(function () {
            this.whereNull('p.pulse_content_type')
              .where(function () {
                this.whereNull('p.signal_id')  // no signal = editorial
                  .orWhere(function () {
                    this.whereIn('s.severity', ['critical', 'high', 'medium'])
                      .where('s.reliability_score', '>=', 0.65)
                      .whereNotIn('s.category', ['culture', 'sports', 'other'])
                  })
              })
          })
      })
      // Exclude posts with empty/stub content (LLM generation failures)
      .whereRaw("length(regexp_replace(p.content, '\\[.*?\\]|—\\s*PULSE[^\\n]*|\\s', '', 'g')) > 30")
      .orderBy('p.created_at', 'desc')
      .limit(overFetchLimit)
      .select([
        'p.id', 'p.post_type', 'p.content', 'p.media_urls', 'p.media_types',
        'p.source_url', 'p.source_name', 'p.tags', 'p.like_count',
        'p.boost_count', 'p.reply_count', 'p.view_count', 'p.reliability_score',
        'p.location_name', 'p.language', 'p.created_at', 'p.updated_at',
        'p.signal_id', 'p.pulse_content_type',
        // Signal metadata for enrichment
        's.title as signal_title', 's.summary as signal_summary',
        's.body as signal_body', 's.category as signal_category',
        's.severity as signal_severity', 's.source_count as signal_source_count',
        's.reliability_score as signal_reliability',
        's.tags as signal_tags', 's.language as signal_language',
        's.country_code as signal_country',
        's.source_ids as signal_source_ids',
        's.original_urls as signal_original_urls',
        // Author
        'u.id as author_id', 'u.handle as author_handle',
        'u.display_name as author_display_name', 'u.avatar_url as author_avatar',
        'u.account_type as author_type', 'u.trust_score as author_trust',
        'u.verified as author_verified',
      ])

    if (contentType) {
      q = q.where('p.pulse_content_type', contentType)
    }

    if (cursor) {
      q = q.where('p.created_at', '<', cursor)
    }

    // Enrichment: has the current user liked/bookmarked?
    const userId = (req as any).user?.id
    const rawPosts = await q

    // ── Event deduplication ───────────────────────────────────────────────
    // Multiple flash briefs can reference the same underlying event (e.g.,
    // 5 fire alerts in Myanmar, or 3 earthquake reports from different
    // sources). Group by event fingerprint and keep only the best signal,
    // annotating it with "N related signals".
    //
    // Fingerprint: same category + similar location_name + title overlap
    // within a 6-hour window.
    const dedupedPosts: typeof rawPosts = []
    const eventMap = new Map<string, { best: (typeof rawPosts)[0]; related: number }>()

    for (const post of rawPosts) {
      const p = post as any
      // Skip editorial content — never dedup
      if (!p.signal_id || p.pulse_content_type !== 'flash_brief') {
        dedupedPosts.push(post)
        continue
      }

      const cat = p.signal_category ?? 'other'
      const loc = (p.location_name ?? '').toLowerCase().trim()
      const title = (p.signal_title ?? '').toLowerCase()

      // Build a coarse event fingerprint: category + location bucket
      // For coordinate-based titles (FIRMS), use category + first word of location
      // For named locations, use category + location
      const locBucket = loc.replace(/[0-9°.,]+/g, '').trim().split(/\s+/).slice(0, 2).join(' ') || 'unknown'
      const fingerprint = `${cat}:${locBucket}`

      // Check if we already have a signal in this event bucket within 6 hours
      const existing = eventMap.get(fingerprint)
      if (existing) {
        const existingTime = new Date((existing.best as any).created_at).getTime()
        const currentTime  = new Date(p.created_at).getTime()
        const hoursDiff    = Math.abs(existingTime - currentTime) / (1000 * 60 * 60)

        // Also check title similarity — simple word overlap
        const existingTitle = ((existing.best as any).signal_title ?? '').toLowerCase()
        const commonWords   = titleWordOverlap(title, existingTitle)

        if (hoursDiff <= 6 && (commonWords >= 0.5 || loc === ((existing.best as any).location_name ?? '').toLowerCase().trim())) {
          existing.related++
          // Keep the one with higher reliability, or newer if tied
          const existingReliability = Number((existing.best as any).signal_reliability ?? 0)
          const currentReliability  = Number(p.signal_reliability ?? 0)
          if (currentReliability > existingReliability) {
            existing.best = post
          }
          continue
        }
      }

      eventMap.set(fingerprint, { best: post, related: 0 })
    }

    // Reassemble: editorial posts keep their positions, deduped signals fill in
    const dedupResults = Array.from(eventMap.values())
    for (const { best, related } of dedupResults) {
      ;(best as any)._relatedSignals = related
      dedupedPosts.push(best)
    }
    // Re-sort by created_at desc since we mixed editorial + deduped
    dedupedPosts.sort((a: any, b: any) =>
      new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
    )

    // ── Personalization boost ─────────────────────────────────────────────
    // If the user has interests/regions stored from onboarding, boost
    // matching signals higher in the feed. Uses a relevance score that
    // combines time-decay with interest matching, so personal signals
    // surface earlier without completely overriding recency.
    if (userId) {
      try {
        const user = await db('users').where('id', userId).first('interests', 'regions')
        if (user) {
          const interests = new Set<string>(Array.isArray(user.interests) ? user.interests : [])
          const regions   = new Set<string>(Array.isArray(user.regions) ? user.regions : [])

          if (interests.size > 0 || regions.size > 0) {
            // Category → interest mapping (signal categories to onboarding interests)
            const categoryToInterest: Record<string, string> = {
              conflict: 'conflict', security: 'conflict', terrorism: 'conflict',
              geopolitics: 'geopolitics', elections: 'geopolitics', governance: 'geopolitics',
              disaster: 'climate', environment: 'climate', climate: 'climate',
              health: 'health', pandemic: 'health',
              technology: 'technology', cyber: 'technology',
              economy: 'economy', finance: 'economy', trade: 'economy',
              science: 'science', space: 'science',
            }

            // Signal country_code → region mapping
            const countryToRegion: Record<string, string> = {
              US: 'North America', CA: 'North America', MX: 'North America',
              BR: 'South America', AR: 'South America', CO: 'South America', CL: 'South America', PE: 'South America',
              GB: 'Europe', FR: 'Europe', DE: 'Europe', IT: 'Europe', ES: 'Europe', PL: 'Europe', UA: 'Europe', NL: 'Europe', SE: 'Europe', NO: 'Europe',
              IL: 'Middle East', IR: 'Middle East', SA: 'Middle East', AE: 'Middle East', IQ: 'Middle East', SY: 'Middle East', TR: 'Middle East', LB: 'Middle East', JO: 'Middle East', PS: 'Middle East',
              NG: 'Africa', ZA: 'Africa', KE: 'Africa', EG: 'Africa', ET: 'Africa', SD: 'Africa', SO: 'Africa', CD: 'Africa', GH: 'Africa', SN: 'Africa',
              IN: 'South Asia', PK: 'South Asia', BD: 'South Asia', LK: 'South Asia', AF: 'South Asia',
              CN: 'East Asia', JP: 'East Asia', KR: 'East Asia', KP: 'East Asia', TW: 'East Asia',
              TH: 'Southeast Asia', VN: 'Southeast Asia', ID: 'Southeast Asia', PH: 'Southeast Asia', MY: 'Southeast Asia', SG: 'Southeast Asia',
              AU: 'Oceania', NZ: 'Oceania',
            }

            for (const post of dedupedPosts) {
              const p = post as any
              if (p.pulse_content_type !== 'flash_brief') continue

              let boost = 0
              const cat = p.signal_category ?? ''
              const mappedInterest = categoryToInterest[cat]
              if (mappedInterest && interests.has(mappedInterest)) boost += 0.3

              // Region boost — check signal's country code
              const cc = p.signal_country ?? p.country_code ?? ''
              const mappedRegion = countryToRegion[cc]
              if (mappedRegion && regions.has(mappedRegion)) boost += 0.2

              p._personalizationBoost = boost
            }

            // Stable re-sort: within each 2-hour window, boosted signals come first
            dedupedPosts.sort((a: any, b: any) => {
              const timeA = new Date(a.created_at).getTime()
              const timeB = new Date(b.created_at).getTime()
              const windowMs = 2 * 60 * 60 * 1000 // 2-hour windows
              const windowA = Math.floor(timeA / windowMs)
              const windowB = Math.floor(timeB / windowMs)

              // Different time windows → chronological order
              if (windowA !== windowB) return timeB - timeA

              // Same time window → boost matching interests
              const boostA = a._personalizationBoost ?? 0
              const boostB = b._personalizationBoost ?? 0
              if (boostA !== boostB) return boostB - boostA

              return timeB - timeA
            })
          }
        }
      } catch {
        // Non-fatal — fall back to chronological
      }
    }

    // ── Time-decay ranking ─────────────────────────────────────────────────
    // Composite relevance score: severity weight × time-decay factor.
    // A 2h-old CRITICAL beats a 5m-old LOW. Personalization boost stacks.
    const SEVERITY_WEIGHT: Record<string, number> = {
      critical: 1.0, high: 0.7, medium: 0.4, low: 0.15, info: 0.05,
    }
    const HALF_LIFE_MS = 4 * 60 * 60 * 1000 // 4-hour half-life for decay
    const now = Date.now()

    for (const post of dedupedPosts) {
      const p = post as any
      const sev = p.signal_severity ?? 'low'
      const sevWeight = SEVERITY_WEIGHT[sev] ?? 0.15
      const ageMs = now - new Date(p.created_at).getTime()
      const decay = Math.pow(0.5, ageMs / HALF_LIFE_MS) // exponential decay
      const boost = p._personalizationBoost ?? 0
      p._relevanceScore = (sevWeight + boost) * decay
    }

    // Sort by composite relevance score (highest first)
    dedupedPosts.sort((a: any, b: any) => (b._relevanceScore ?? 0) - (a._relevanceScore ?? 0))

    // ── Category diversity filter ─────────────────────────────────────────
    // Prevent any single category from flooding the feed. Max 2 consecutive
    // posts from the same category; max 5 total per category per page.
    // Disaster/fire signals get a tighter cap to prevent FIRMS flooding.
    const MAX_CONSECUTIVE = 2
    const MAX_PER_CATEGORY = 5
    const CATEGORY_CAPS: Record<string, number> = {
      disaster: 3,  // FIRMS fire signals were flooding the feed
    }
    const categoryCounts: Record<string, number> = {}
    let lastCategory = ''
    let consecutiveCount = 0
    const posts: typeof rawPosts = []

    for (const post of dedupedPosts) {
      if (posts.length >= limit) break
      const p = post as any
      const cat = p.signal_category ?? 'editorial'

      // Track consecutive
      if (cat === lastCategory) {
        consecutiveCount++
      } else {
        consecutiveCount = 1
        lastCategory = cat
      }

      // Per-category cap (disaster=3, default=5)
      const catCap = CATEGORY_CAPS[cat] ?? MAX_PER_CATEGORY

      // Skip if too many consecutive or too many total of this category
      if (consecutiveCount > MAX_CONSECUTIVE && cat !== 'editorial') continue
      if ((categoryCounts[cat] ?? 0) >= catCap && cat !== 'editorial') continue

      categoryCounts[cat] = (categoryCounts[cat] ?? 0) + 1
      posts.push(post)
    }

    // ── Source attribution: batch-load source names ─────────────────────
    const allSourceIds = [...new Set(
      posts.flatMap((p: any) => {
        const ids = p.signal_source_ids
        return Array.isArray(ids) ? ids : []
      })
    )]
    const sourcesById = new Map<string, string>()
    if (allSourceIds.length > 0) {
      try {
        const srcRows = await db('sources')
          .whereRaw('id::text = ANY(?)', [allSourceIds.map(String)])
          .select(['id', 'name'])
        for (const s of srcRows) {
          sourcesById.set(String(s.id), s.name as string)
        }
      } catch {
        // Non-fatal — attribution will fall back to source count
      }
    }

    const items = await Promise.all(posts.map(async (post: any) => {
      let hasLiked = false
      let hasBookmarked = false

      if (userId) {
        const [likeRow, bookmarkRow] = await Promise.all([
          db('likes').where({ post_id: post.id, user_id: userId }).first(),
          db('bookmarks').where({ post_id: post.id, user_id: userId }).first(),
        ])
        hasLiked = !!likeRow
        hasBookmarked = !!bookmarkRow
      }

      // ── Enrich flash briefs with AI summary ──────────────────────────────
      // If this is a flash brief linked to a signal, use the AI summary
      // (from signal-summary.ts) as the display content instead of the raw
      // headline echo. The AI summary is the good-quality 2-3 sentence
      // summary visible on each signal's detail page.
      let displayContent = post.content
      if (post.signal_id && post.signal_title && post.pulse_content_type === 'flash_brief') {
        try {
          const aiSummary = await generateSignalSummary({
            id:       post.signal_id,
            title:    post.signal_title,
            summary:  post.signal_summary,
            body:     post.signal_body,
            category: post.signal_category ?? 'other',
            severity: post.signal_severity ?? 'medium',
            tags:     post.signal_tags ?? [],
            language: post.signal_language ?? 'en',
          })
          if (aiSummary.text && aiSummary.text.length > 30) {
            displayContent = `${post.signal_title}\n\n${aiSummary.text}`
          }
        } catch {
          // Non-fatal — fall back to original content
        }
      }

      // Clean up display content
      displayContent = displayContent
        // Strip **RECOMMENDATIONS:** section (developer notes)
        .replace(/\n*\*\*RECOMMENDATIONS:?\*\*[\s\S]*$/i, '')
        // Strip markdown headers like "# Summary", "# News Summary", "## Analysis"
        .replace(/^#{1,3}\s*(News\s+)?Summary\s*\n+/im, '')
        .replace(/^#{1,3}\s*Analysis\s*\n+/im, '')
        .replace(/^#{1,3}\s*Intelligence\s+Brief\s*\n+/im, '')
        .trim()

      return {
        id: post.id,
        type: 'ai_digest' as const,
        postType: post.post_type,
        content: displayContent,
        mediaUrls: post.media_urls,
        mediaTypes: post.media_types,
        sourceUrl: post.source_url,
        sourceName: post.source_name,
        tags: post.tags,
        likeCount: post.like_count ?? 0,
        boostCount: post.boost_count ?? 0,
        replyCount: post.reply_count ?? 0,
        viewCount: post.view_count ?? 0,
        reliabilityScore: post.reliability_score,
        locationName: post.location_name,
        language: post.language,
        createdAt: post.created_at,
        updatedAt: post.updated_at,
        signalId: post.signal_id,
        pulseContentType: post.pulse_content_type,
        // Signal quality context for the UI
        signalSeverity: post.signal_severity,
        signalSourceCount: post.signal_source_count,
        signalReliability: post.signal_reliability,
        signalCategory: post.signal_category,
        relatedSignals: (post as any)._relatedSignals || 0,
        // Source attribution — "Based on 3 sources: Reuters, AP, USGS"
        sourceAttribution: (() => {
          const ids = Array.isArray(post.signal_source_ids) ? post.signal_source_ids : []
          const names = ids.map((id: string) => sourcesById.get(String(id))).filter(Boolean) as string[]
          const count = post.signal_source_count ?? names.length
          if (names.length > 0) {
            const display = names.slice(0, 3).join(', ')
            const extra = count > 3 ? ` and ${count - 3} more` : ''
            return `Based on ${count} source${count !== 1 ? 's' : ''}: ${display}${extra}`
          }
          if (count > 1) return `Based on ${count} verified sources`
          return null
        })(),
        author: {
          id: post.author_id,
          handle: post.author_handle,
          displayName: post.author_display_name,
          avatar: post.author_avatar,
          type: post.author_type,
          trustScore: post.author_trust,
          verified: post.author_verified,
        },
        hasLiked,
        hasBookmarked,
      }
    }))

    const nextCursor = items.length === limit
      ? items[items.length - 1]?.createdAt
      : null

    // Edge caching — stale-while-revalidate for fast feed loads
    reply.header('Cache-Control', 'public, max-age=30, stale-while-revalidate=60')

    return reply.send({
      success: true,
      items,
      cursor: nextCursor,
      hasMore: items.length === limit,
    })
  })

  /**
   * GET /api/v1/pulse/stats
   * Publishing statistics — public.
   */
  app.get('/stats', async (_req, reply) => {
    const stats = await getPublishStats()
    return reply.send({ success: true, data: stats })
  })

  /**
   * GET /api/v1/pulse/latest
   * Latest PULSE post, optionally filtered by content_type.
   */
  app.get('/latest', async (req, reply) => {
    const query = req.query as Record<string, string>
    const contentType = query.content_type

    let q = db('posts')
      .where('author_id', PULSE_USER_ID)
      .where('deleted_at', null)
      .orderBy('created_at', 'desc')
      .first()

    if (contentType) {
      q = q.where('pulse_content_type', contentType)
    }

    const post = await q
    if (!post) {
      return reply.send({ success: true, data: null })
    }

    return reply.send({ success: true, data: post })
  })

  /**
   * GET /api/v1/pulse/briefing
   * Morning Briefing — "What happened while you slept"
   * Timezone-aware: returns top overnight events based on user's timezone.
   *
   * Query params:
   *   tz         — IANA timezone (default: America/New_York)
   *   region     — ISO country code to focus on (optional, from user prefs)
   *   limit      — max events (default: 10)
   */
  app.get('/briefing', { preHandler: [optionalAuth] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const tzName = query.tz || 'America/New_York'
    const regionFilter = query.region || null
    const limit = Math.min(Number(query.limit) || 10, 20)
    const userId = (req as any).user?.id

    // ── Determine "overnight" window based on timezone ──────────────────
    // Overnight = from 10pm yesterday to 7am today in user's timezone.
    // We compute these boundaries in UTC for the DB query.
    const now = new Date()
    let sleepStartUTC: Date
    let sleepEndUTC: Date

    try {
      // Get current time in user's timezone
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tzName,
        hour: 'numeric', hour12: false,
      })
      const localHour = Number(formatter.format(now))

      // Calculate offset in ms between UTC and user timezone
      const utcStr = now.toLocaleString('en-US', { timeZone: 'UTC' })
      const localStr = now.toLocaleString('en-US', { timeZone: tzName })
      const offsetMs = new Date(utcStr).getTime() - new Date(localStr).getTime()

      // Sleep window: 10pm yesterday to 7am today (local)
      const todayLocal = new Date(now.getTime() - offsetMs)
      todayLocal.setHours(7, 0, 0, 0)
      sleepEndUTC = new Date(todayLocal.getTime() + offsetMs)

      const yesterdayLocal = new Date(todayLocal)
      yesterdayLocal.setDate(yesterdayLocal.getDate() - 1)
      yesterdayLocal.setHours(22, 0, 0, 0)
      sleepStartUTC = new Date(yesterdayLocal.getTime() + offsetMs)

      // If it's before 7am local, the sleep window hasn't ended yet — use last night
      if (localHour < 7) {
        sleepEndUTC = now
      }
      // If it's after 10pm local, we're in tonight's sleep window — show today's events
      if (localHour >= 22) {
        sleepStartUTC = new Date(now.getTime() - 12 * 3600_000) // last 12h
        sleepEndUTC = now
      }
    } catch {
      // Fallback: last 9 hours
      sleepStartUTC = new Date(Date.now() - 9 * 3600_000)
      sleepEndUTC = now
    }

    // ── Query overnight signals ──────────────────────────────────────────
    let signalQ = db('signals')
      .whereIn('status', ['verified', 'pending'])
      .where('created_at', '>', sleepStartUTC)
      .where('created_at', '<=', sleepEndUTC)
      .whereNotIn('category', ['culture', 'sports', 'other'])
      .where('reliability_score', '>=', 0.5)
      .orderByRaw(`
        CASE severity
          WHEN 'critical' THEN 1
          WHEN 'high' THEN 2
          WHEN 'medium' THEN 3
          WHEN 'low' THEN 4
          ELSE 5
        END,
        reliability_score DESC,
        source_count DESC
      `)
      .limit(limit * 3) // over-fetch for diversity
      .select([
        'id', 'title', 'summary', 'category', 'severity',
        'reliability_score', 'source_count', 'location_name',
        'country_code', 'region', 'created_at', 'alert_tier',
        'source_ids', 'tags',
      ])

    // ── Regional focus — from query param or user preferences ──────────
    let userRegions: string[] = []
    if (regionFilter) {
      signalQ = signalQ.where('country_code', regionFilter)
    } else if (userId) {
      try {
        const user = await db('users').where('id', userId).first('regions', 'interests')
        if (user?.regions && Array.isArray(user.regions) && user.regions.length > 0) {
          userRegions = user.regions
        }
      } catch { /* non-fatal */ }
    }

    const signals = await signalQ

    // ── Category diversity: max 3 per category ───────────────────────────
    const catCount: Record<string, number> = {}
    const diverseSignals = signals.filter((s: any) => {
      const cat = s.category ?? 'other'
      catCount[cat] = (catCount[cat] ?? 0) + 1
      return catCount[cat]! <= 3
    }).slice(0, limit)

    // ── Boost user's regions to top ──────────────────────────────────────
    if (userRegions.length > 0) {
      const countryToRegion: Record<string, string> = {
        US: 'North America', CA: 'North America', MX: 'North America',
        GB: 'Europe', FR: 'Europe', DE: 'Europe', UA: 'Europe',
        IL: 'Middle East', IR: 'Middle East', SA: 'Middle East',
        CN: 'East Asia', JP: 'East Asia', KR: 'East Asia', TW: 'East Asia',
        IN: 'South Asia', PK: 'South Asia',
        NG: 'Africa', ZA: 'Africa', KE: 'Africa', EG: 'Africa',
        AU: 'Oceania', NZ: 'Oceania',
        BR: 'South America', AR: 'South America',
        TH: 'Southeast Asia', VN: 'Southeast Asia', ID: 'Southeast Asia', PH: 'Southeast Asia',
      }
      const regionSet = new Set(userRegions)
      diverseSignals.sort((a: any, b: any) => {
        const aMatch = regionSet.has(countryToRegion[a.country_code] ?? '') ? 1 : 0
        const bMatch = regionSet.has(countryToRegion[b.country_code] ?? '') ? 1 : 0
        if (aMatch !== bMatch) return bMatch - aMatch
        return 0 // keep existing severity sort
      })
    }

    // ── Trend detection — "Escalating" tags ──────────────────────────────
    let escalating: Array<{ category: string; region: string | null; reason: string | null }> = []
    try {
      const trends = await getEscalatingEvents({ hours: 12 })
      escalating = trends.map(t => ({
        category: t.category,
        region: t.region,
        reason: t.escalationReason,
      }))
    } catch { /* non-fatal */ }

    // Create a set of escalating category:region pairs for tagging
    const escalatingSet = new Set(
      escalating.map(e => `${e.category}:${e.region ?? 'global'}`)
    )

    // ── Executive summary generation ─────────────────────────────────────
    let executiveSummary = ''
    if (diverseSignals.length > 0) {
      const signalList = diverseSignals.slice(0, 8).map((s: any, i: number) =>
        `${i + 1}. [${(s.severity ?? 'medium').toUpperCase()}] ${s.title} (${s.location_name ?? 'Global'}, ${s.source_count} sources)`
      ).join('\n')

      const escalatingNote = escalating.length > 0
        ? `\n\nESCALATING STORIES: ${escalating.map(e => `${e.category} in ${e.region ?? 'global'} — ${e.reason}`).join('; ')}`
        : ''

      try {
        const result = await generateContent(
          `Write a 3-4 sentence executive summary of overnight events for an intelligence analyst arriving at their desk. Be specific and quantitative. Lead with the most significant development. Reference source counts. Note any escalating situations.

Overnight signals (${sleepStartUTC.toISOString()} to ${sleepEndUTC.toISOString()} UTC):
${signalList}${escalatingNote}

Rules:
- 3-4 sentences maximum. Dense with information.
- Sentence 1: The single most important overnight development.
- Sentence 2-3: Other significant events, grouped by theme.
- Sentence 4: Any escalating or developing situations to monitor.
- Active voice. No filler. Every word earns its place.`,
          300,
          'fast',
        )
        if (result.text && result.text.trim().length > 30) {
          executiveSummary = result.text.trim()
        }
      } catch {
        // Fallback: build a template summary
        const topSignal = diverseSignals[0] as any
        executiveSummary = `The most significant overnight development: ${topSignal.title} (${topSignal.location_name ?? 'Global'}). ${diverseSignals.length} notable events detected across ${Object.keys(catCount).length} categories in the last ${Math.round((sleepEndUTC.getTime() - sleepStartUTC.getTime()) / 3600_000)} hours.`
      }
    }

    // ── Format response ──────────────────────────────────────────────────
    const events = diverseSignals.map((s: any) => {
      const key = `${s.category}:${s.country_code ?? 'global'}`
      return {
        id: s.id,
        title: s.title,
        summary: s.summary,
        category: s.category,
        severity: s.severity,
        reliabilityScore: s.reliability_score,
        sourceCount: s.source_count,
        locationName: s.location_name,
        countryCode: s.country_code,
        region: s.region,
        alertTier: s.alert_tier,
        createdAt: s.created_at,
        isEscalating: escalatingSet.has(key),
        tags: s.tags,
      }
    })

    return reply.send({
      success: true,
      briefing: {
        date: now.toISOString().slice(0, 10),
        generatedAt: now.toISOString(),
        timezone: tzName,
        overnightWindow: {
          start: sleepStartUTC.toISOString(),
          end: sleepEndUTC.toISOString(),
        },
        executiveSummary,
        eventCount: events.length,
        events,
        escalatingStories: escalating,
        severityBreakdown: {
          critical: events.filter((e: any) => e.severity === 'critical').length,
          high: events.filter((e: any) => e.severity === 'high').length,
          medium: events.filter((e: any) => e.severity === 'medium').length,
          low: events.filter((e: any) => e.severity === 'low').length,
        },
      },
    })
  })

  /**
   * GET /api/v1/pulse/trending
   * Returns trending/escalating events from the last N hours.
   */
  app.get('/trending', async (req, reply) => {
    const query = req.query as Record<string, string>
    const hours = Math.min(Number(query.hours) || 12, 48)
    const region = query.region || undefined
    const limit = Math.min(Number(query.limit) || 15, 30)

    const trends = await detectTrends({ hours, region, limit })
    return reply.send({
      success: true,
      data: trends,
      meta: { hours, region: region ?? 'all', count: trends.length },
    })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // INTERNAL ROUTES — require PULSE_API_KEY
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/v1/pulse/publish/flash
   * Publish a flash brief for a specific signal.
   * Body: { signalId: string }
   */
  app.post('/publish/flash', { preHandler: [requirePulseKey] }, async (req, reply) => {
    const { signalId } = req.body as { signalId: string }
    if (!signalId) return sendError(reply, 400, 'VALIDATION_ERROR', 'signalId required')

    const signal = await db('signals').where('id', signalId).first()
    if (!signal) return sendError(reply, 404, 'NOT_FOUND', 'Signal not found')

    const result = await publishFlashBrief(signal)
    return reply.status(result.success ? 201 : 500).send(result)
  })

  /**
   * POST /api/v1/pulse/publish/analysis
   * Publish an analysis connecting multiple signals.
   * Body: { signalIds: string[], topic: string }
   */
  app.post('/publish/analysis', { preHandler: [requirePulseKey] }, async (req, reply) => {
    const { signalIds, topic } = req.body as { signalIds: string[]; topic: string }
    if (!signalIds?.length || !topic) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'signalIds[] and topic required')
    }

    const signals = await db('signals').whereIn('id', signalIds)
    if (signals.length === 0) return sendError(reply, 404, 'NOT_FOUND', 'No signals found')

    const result = await publishAnalysis(signals, topic)
    return reply.status(result.success ? 201 : 500).send(result)
  })

  /**
   * POST /api/v1/pulse/publish/briefing
   * Trigger a daily briefing publication.
   */
  app.post('/publish/briefing', { preHandler: [requirePulseKey] }, async (_req, reply) => {
    const result = await publishDailyBriefing()
    return reply.status(result.success ? 201 : 500).send(result)
  })

  /**
   * POST /api/v1/pulse/publish/syndicate
   * Syndicate a social media post back into the feed.
   * Body: { platform, externalUrl, title, content, externalId? }
   */
  app.post('/publish/syndicate', { preHandler: [requirePulseKey] }, async (req, reply) => {
    const { platform, externalUrl, title, content, externalId } = req.body as {
      platform: string
      externalUrl: string
      title: string
      content: string
      externalId?: string
    }

    if (!platform || !externalUrl || !title || !content) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'platform, externalUrl, title, content required')
    }

    const result = await syndicatePost(platform, externalUrl, title, content, externalId)
    return reply.status(result.success ? 201 : 500).send(result)
  })

  /**
   * POST /api/v1/pulse/check-flash
   * Auto-check for critical signals and publish flash briefs.
   * Returns count of new flash briefs published.
   */
  app.post('/check-flash', { preHandler: [requirePulseKey] }, async (_req, reply) => {
    const count = await checkAndPublishFlashBriefs()
    return reply.send({ success: true, published: count })
  })

  /**
   * GET /api/v1/pulse/signals/top
   * Get top signals for editorial planning (internal).
   */
  app.get('/signals/top', { preHandler: [requirePulseKey] }, async (req, reply) => {
    const query = req.query as Record<string, string>
    const hours = Number(query.hours) || 24
    const limit = Math.min(Number(query.limit) || 20, 50)

    const signals = await getTopSignals(hours, limit)
    return reply.send({ success: true, data: signals })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // SYNDICATION ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/v1/pulse/syndicate
   * Register a social media post and auto-create a syndicated feed entry.
   * Body: { platform, externalUrl, title, content, externalId? }
   */
  app.post('/syndicate', { preHandler: [requirePulseKey] }, async (req, reply) => {
    const body = req.body as {
      platform: 'x' | 'reddit' | 'linkedin' | 'hackernews'
      externalUrl: string
      title: string
      content: string
      externalId?: string
    }

    if (!body.platform || !body.externalUrl || !body.title || !body.content) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'platform, externalUrl, title, content required')
    }

    const result = await registerSocialPost(body)
    return reply.status(result.skipped ? 200 : 201).send({ success: true, ...result })
  })

  /**
   * POST /api/v1/pulse/syndicate/batch
   * Batch-register multiple social posts at once.
   * Body: { posts: Array<{ platform, externalUrl, title, content, externalId? }> }
   */
  app.post('/syndicate/batch', { preHandler: [requirePulseKey] }, async (req, reply) => {
    const { posts } = req.body as { posts: any[] }
    if (!posts?.length) {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'posts[] required')
    }

    const created = await batchRegisterSocialPosts(posts)
    return reply.send({ success: true, created, total: posts.length })
  })

  /**
   * GET /api/v1/pulse/syndicated
   * List syndicated posts, optionally filtered by platform.
   */
  app.get('/syndicated', async (req, reply) => {
    const query = req.query as Record<string, string>
    const platform = query.platform
    const limit = Math.min(Number(query.limit) || 20, 50)

    const posts = await getSyndicatedPosts(platform, limit)
    return reply.send({ success: true, data: posts })
  })

  // ══════════════════════════════════════════════════════════════════════════
  // BRIEFING UPDATE ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * POST /api/v1/pulse/publish/update
   * Publish a mid-day or evening briefing update.
   * Body: { type: 'midday' | 'evening' }
   */
  app.post('/publish/update', { preHandler: [requirePulseKey] }, async (req, reply) => {
    const { type } = req.body as { type: 'midday' | 'evening' }
    if (type !== 'midday' && type !== 'evening') {
      return sendError(reply, 400, 'VALIDATION_ERROR', 'type must be "midday" or "evening"')
    }

    const result = await publishBriefingUpdate(type)
    return reply.status(result.success ? 201 : 500).send(result)
  })

  // ══════════════════════════════════════════════════════════════════════════
  // AGENT ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * GET /api/v1/pulse/agents
   * Get status of all PULSE agents — public.
   */
  app.get('/agents', async (_req, reply) => {
    const status = await getAgentStatus()
    return reply.send({ success: true, data: status })
  })

  /**
   * POST /api/v1/pulse/agents/scan
   * Trigger an immediate agent beat scan — internal.
   */
  app.post('/agents/scan', { preHandler: [requirePulseKey] }, async (_req, reply) => {
    const results = await runAgentBeatScan()
    const published = results.filter(r => r.published).length
    return reply.send({
      success: true,
      data: {
        agentsRun: results.length,
        postsPublished: published,
        results,
      },
    })
  })
}
