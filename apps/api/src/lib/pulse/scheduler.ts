/**
 * PULSE Scheduler — runs periodic editorial tasks.
 *
 * Schedule (all times UTC, ET equivalents in parentheses):
 *   Every 5 min  — Flash brief check (auto-publish critical signals)
 *   11:00 UTC    — Morning briefing (7am ET)
 *   17:00 UTC    — Mid-day update  (1pm ET)
 *   23:00 UTC    — Evening wrap     (7pm ET)
 *   Every 2 hrs  — Agent beat scan (agents identify trends in their domains)
 *
 * Gated by PULSE_ENABLED env var.
 */
import { checkAndPublishFlashBriefs, publishDailyBriefing, publishBriefingUpdate } from './publisher'
import { runAgentBeatScan } from './agents/coordinator'
import { runTwitterPublisher } from './agents/twitter-publisher'
import { getAgent } from './agents/registry'
import { dispatchMorningBriefings } from './morning-email'
import { runNightlyBaselines } from '../cortex/baselines'
import { runEventThreadsCycle } from '../cortex/event-threads'
import { runEntityStrengtheningCycle } from '../cortex/entity-strengthen'
import { runPatternDetectionCycle } from '../cortex/pattern-detection'
import { computeFeedQuality } from '../cortex/feed-quality'
import { syncClustersToPostgres } from '../cortex/correlation-store'
import { generatePatternAlerts } from '../cortex/pattern-alerts'
import { publishWeeklySynthesis } from '../cortex/weekly-synthesis'

let flashTimer: ReturnType<typeof setInterval> | null = null
let briefingTimer: ReturnType<typeof setInterval> | null = null
let agentTimer: ReturnType<typeof setInterval> | null = null
let twitterTimer: ReturnType<typeof setInterval> | null = null
let cortexTimer: ReturnType<typeof setInterval> | null = null
let threadTimer: ReturnType<typeof setInterval> | null = null
let patternTimer: ReturnType<typeof setInterval> | null = null
let isRunning = false

const FLASH_INTERVAL_MS   = 5 * 60 * 1000   // 5 minutes
const BRIEFING_CHECK_MS   = 60 * 1000        // check every minute
const AGENT_SCAN_MS       = 2 * 60 * 60_000  // 2 hours
const TWITTER_INTERVAL_MS = 15 * 60 * 1000   // 15 minutes — check for new content to tweet
const CORTEX_CHECK_MS     = 60 * 1000        // check every minute (gated by hour)
const THREAD_CYCLE_MS     = 30 * 60 * 1000   // 30 minutes — event thread promotion

// UTC hours for briefing schedule (EDT: subtract 4)
const MORNING_HOUR_UTC = 11   // 7am ET
const MIDDAY_HOUR_UTC  = 17   // 1pm ET
const EVENING_HOUR_UTC = 23   // 7pm ET
const CORTEX_HOUR_UTC  = 3    // 3am UTC — nightly baseline computation
const ENTITY_HOUR_UTC  = 4    // 4am UTC — nightly entity strengthening
const FEED_QUALITY_HOUR_UTC = 5  // 5am UTC — daily feed quality scoring
const PATTERN_HOUR_UTC = 5    // 5am UTC Sunday — weekly pattern detection (runs after feed quality)
const SYNTHESIS_HOUR_UTC = 6  // 6am UTC Sunday — weekly intelligence synthesis (after patterns)

// Track what we've published today to avoid duplicates
const publishedToday = new Map<string, string>() // key → date string

function todayKey(prefix: string): string {
  return `${prefix}:${new Date().toISOString().slice(0, 10)}`
}

function alreadyPublished(key: string): boolean {
  const today = new Date().toISOString().slice(0, 10)
  return publishedToday.get(key) === today
}

function markPublished(key: string): void {
  const today = new Date().toISOString().slice(0, 10)
  publishedToday.set(key, today)

  // Clean old entries (keep only today's)
  for (const [k, v] of publishedToday) {
    if (v !== today) publishedToday.delete(k)
  }
}

function isPulseEnabled(): boolean {
  return process.env.PULSE_ENABLED === 'true' || process.env.PULSE_ENABLED === '1'
}

/** Start the PULSE scheduler */
export function startPulseScheduler(): void {
  if (isRunning) return
  if (!isPulseEnabled()) {
    console.log('[PULSE] Scheduler disabled (set PULSE_ENABLED=true to enable)')
    return
  }

  isRunning = true
  console.log('[PULSE] Scheduler started — flash briefs (5m), briefings (7am/1pm/7pm ET), agent scans (2h), twitter (15m), cortex baselines (3am UTC), threads (30m)')

  // ── Flash brief checker ────────────────────────────────────────────────
  flashTimer = setInterval(async () => {
    try {
      const count = await checkAndPublishFlashBriefs()
      if (count > 0) {
        console.log(`[PULSE] Published ${count} flash brief(s)`)
      }
    } catch (err) {
      console.error('[PULSE] Flash brief check failed:', err)
    }
  }, FLASH_INTERVAL_MS)

  // ── Briefing schedule checker ──────────────────────────────────────────
  briefingTimer = setInterval(async () => {
    const hour = new Date().getUTCHours()

    // Scheduled email delivery — check every minute if any subscriber is due
    try {
      const emailsSent = await dispatchMorningBriefings()
      if (emailsSent > 0) {
        console.log(`[PULSE] Dispatched ${emailsSent} morning briefing email(s)`)
      }
    } catch (err) {
      console.error('[PULSE] Morning briefing email dispatch failed:', err)
    }

    // Morning briefing — full daily briefing via Anthropic (deep)
    if (hour === MORNING_HOUR_UTC && !alreadyPublished('morning')) {
      markPublished('morning')
      try {
        console.log('[PULSE] Publishing morning briefing (deep/Anthropic)...')
        const result = await publishDailyBriefing()
        if (result.success) {
          console.log(`[PULSE] Morning briefing published: ${result.postId}`)
        } else {
          console.error(`[PULSE] Morning briefing failed: ${result.error}`)
          publishedToday.delete('morning') // retry next minute
        }
      } catch (err) {
        console.error('[PULSE] Morning briefing error:', err)
        publishedToday.delete('morning')
      }
    }

    // Mid-day update — shorter, via OpenAI (fast)
    if (hour === MIDDAY_HOUR_UTC && !alreadyPublished('midday')) {
      markPublished('midday')
      try {
        console.log('[PULSE] Publishing mid-day update (fast/OpenAI)...')
        const result = await publishBriefingUpdate('midday')
        if (result.success) {
          console.log(`[PULSE] Mid-day update published: ${result.postId}`)
        } else {
          console.error(`[PULSE] Mid-day update failed: ${result.error}`)
          publishedToday.delete('midday')
        }
      } catch (err) {
        console.error('[PULSE] Mid-day update error:', err)
        publishedToday.delete('midday')
      }
    }

    // Evening wrap — shorter, via OpenAI (fast)
    if (hour === EVENING_HOUR_UTC && !alreadyPublished('evening')) {
      markPublished('evening')
      try {
        console.log('[PULSE] Publishing evening wrap (fast/OpenAI)...')
        const result = await publishBriefingUpdate('evening')
        if (result.success) {
          console.log(`[PULSE] Evening wrap published: ${result.postId}`)
        } else {
          console.error(`[PULSE] Evening wrap failed: ${result.error}`)
          publishedToday.delete('evening')
        }
      } catch (err) {
        console.error('[PULSE] Evening wrap error:', err)
        publishedToday.delete('evening')
      }
    }
  }, BRIEFING_CHECK_MS)

  // ── Agent beat scan ────────────────────────────────────────────────────
  // Every 2 hours, agents scan their beats for trends worth covering.
  agentTimer = setInterval(async () => {
    try {
      const results = await runAgentBeatScan()
      const published = results.filter(r => r.published).length
      if (published > 0) {
        console.log(`[PULSE] Agent scan: ${published} posts published from ${results.length} agents`)
      }
    } catch (err) {
      console.error('[PULSE] Agent beat scan failed:', err)
    }
  }, AGENT_SCAN_MS)

  // ── Twitter auto-publisher ────────────────────────────────────────────
  // Every 15 minutes, check for new PULSE posts to tweet.
  // Gated by TWITTER_API_KEY — no-ops if not configured.
  twitterTimer = setInterval(async () => {
    if (!process.env.TWITTER_API_KEY) return // Skip if not configured

    const agent = getAgent('twitter-publisher')
    if (!agent || !agent.enabled) return

    try {
      const result = await runTwitterPublisher(agent)
      if (result.published) {
        console.log(`[PULSE] Twitter: posted for ${result.postId}`)
      }
    } catch (err) {
      console.error('[PULSE] Twitter publisher failed:', err)
    }
  }, TWITTER_INTERVAL_MS)

  // ── Cortex: nightly baselines + entity strengthening ───────────────────
  // At 3am UTC: compute yesterday's baselines and scan for anomalies.
  // At 4am UTC: run entity strengthening (co-occurrence, trends, dedup, importance).
  cortexTimer = setInterval(async () => {
    const hour = new Date().getUTCHours()

    // 3am UTC: baselines
    if (hour === CORTEX_HOUR_UTC && !alreadyPublished('cortex-baselines')) {
      markPublished('cortex-baselines')
      try {
        console.log('[CORTEX] Running nightly baselines...')
        const result = await runNightlyBaselines()
        console.log(`[CORTEX] Nightly complete: ${result.baselines_stored} baselines, ${result.anomalies_detected} anomalies`)
      } catch (err) {
        console.error('[CORTEX] Nightly baselines failed:', err)
        publishedToday.delete('cortex-baselines')
      }
    }

    // 4am UTC: entity strengthening (was previously unreachable — nested inside 3am guard)
    if (hour === ENTITY_HOUR_UTC && !alreadyPublished('cortex-entities')) {
      markPublished('cortex-entities')
      try {
        console.log('[CORTEX] Running entity strengthening...')
        const result = await runEntityStrengtheningCycle()
        console.log(`[CORTEX] Entity strengthening: ${result.edges_created} edges, ${result.trends_updated} trends, ${result.entities_merged} merges, ${result.entities_scored} scored`)
      } catch (err) {
        console.error('[CORTEX] Entity strengthening failed:', err)
        publishedToday.delete('cortex-entities')
      }
    }

    // 5am UTC: daily feed quality scoring
    if (hour === FEED_QUALITY_HOUR_UTC && !alreadyPublished('cortex-feed-quality')) {
      markPublished('cortex-feed-quality')
      try {
        console.log('[CORTEX] Running feed quality scoring...')
        const result = await computeFeedQuality()
        console.log(`[CORTEX] Feed quality: ${result.sources_scored} sources scored, avg ${result.avg_quality}/100`)
      } catch (err) {
        console.error('[CORTEX] Feed quality scoring failed:', err)
        publishedToday.delete('cortex-feed-quality')
      }
    }
  }, CORTEX_CHECK_MS)

  // ── Event threads: cluster → thread promotion ──────────────────────────
  // Every 30 minutes, promote qualifying Redis clusters to persistent threads.
  threadTimer = setInterval(async () => {
    try {
      const result = await runEventThreadsCycle()
      if (result.promoted + result.updated + result.merged + (result.summarized ?? 0) > 0) {
        console.log(`[CORTEX] Threads: ${result.promoted} new, ${result.updated} updated, ${result.merged} merged, ${result.stabilized} stabilized, ${result.resolved} resolved, ${result.summarized ?? 0} summarized`)
      }

      // Sync correlation clusters to PostgreSQL alongside thread promotion
      await syncClustersToPostgres().catch(err => {
        console.error('[CORTEX] Cluster sync failed:', err)
      })
    } catch (err) {
      console.error('[CORTEX] Event threads cycle failed:', err)
    }
  }, THREAD_CYCLE_MS)

  // ── Cross-domain pattern detection (weekly, Sunday 5am UTC) ───────────
  patternTimer = setInterval(async () => {
    const now = new Date()
    if (now.getUTCDay() !== 0 || now.getUTCHours() !== PATTERN_HOUR_UTC) return
    if (alreadyPublished('cortex-patterns')) return

    markPublished('cortex-patterns')
    try {
      console.log('[CORTEX] Running weekly pattern detection...')
      const result = await runPatternDetectionCycle()
      console.log(`[CORTEX] Pattern detection: ${result.causal_chains} chains, ${result.bridges} bridges, ${result.hotspots} hotspots, ${result.temporal_sequences} sequences`)

      // Generate PULSE posts from significant patterns
      try {
        const alerts = await generatePatternAlerts()
        if (alerts.alerts_published > 0) {
          console.log(`[CORTEX] Pattern alerts: ${alerts.alerts_published} posts published`)
        }
      } catch (alertErr) {
        console.error('[CORTEX] Pattern alerts failed:', alertErr)
      }
    } catch (err) {
      console.error('[CORTEX] Pattern detection failed:', err)
      publishedToday.delete('cortex-patterns')
    }

    // 6am UTC Sunday: weekly intelligence synthesis
    if (now.getUTCDay() === 0 && now.getUTCHours() === SYNTHESIS_HOUR_UTC && !alreadyPublished('cortex-synthesis')) {
      markPublished('cortex-synthesis')
      try {
        console.log('[CORTEX] Publishing weekly intelligence synthesis...')
        const result = await publishWeeklySynthesis()
        if (result.success) {
          console.log(`[CORTEX] Weekly synthesis published: ${result.postId}`)
        }
      } catch (err) {
        console.error('[CORTEX] Weekly synthesis failed:', err)
        publishedToday.delete('cortex-synthesis')
      }
    }
  }, CORTEX_CHECK_MS)
}

/** Stop the PULSE scheduler */
export function stopPulseScheduler(): void {
  if (flashTimer)    { clearInterval(flashTimer);    flashTimer = null }
  if (briefingTimer) { clearInterval(briefingTimer); briefingTimer = null }
  if (agentTimer)    { clearInterval(agentTimer);    agentTimer = null }
  if (twitterTimer)  { clearInterval(twitterTimer);  twitterTimer = null }
  if (cortexTimer)   { clearInterval(cortexTimer);   cortexTimer = null }
  if (threadTimer)   { clearInterval(threadTimer);   threadTimer = null }
  if (patternTimer)  { clearInterval(patternTimer);  patternTimer = null }
  isRunning = false
  console.log('[PULSE] Scheduler stopped')
}
