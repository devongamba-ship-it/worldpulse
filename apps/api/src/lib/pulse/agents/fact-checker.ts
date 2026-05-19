/**
 * PULSE Fact-Checker Agent — cross-references claims and flags contested info.
 *
 * The fact-checker monitors for:
 * 1. High-severity signals with low source count (under-corroborated claims)
 * 2. Signals where reliability score is below threshold but severity is critical
 * 3. Conflicting signals about the same event from different sources
 * 4. Score anomalies (identical reliability scores across unrelated signals)
 *
 * When issues are found, it publishes a "FACT CHECK" post in the AI Digest.
 * Signals classified as LIKELY FALSE are downgraded in the DB automatically.
 */
import { db } from '../../../db/postgres'
import { EDITORIAL_SYSTEM_PROMPT } from '../constants'
import { generateContent } from '../publisher'
import { PULSE_USER_ID, ContentType } from '../constants'
import { redis } from '../../../db/redis'
import type { AgentConfig, AgentScanResult } from './types'

// ─── Score Anomaly Detection ──────────────────────────────────────────────

interface ScoreAnomaly {
  score: number
  count: number
  signalIds: string[]
}

/**
 * Detect signals with identical reliability scores — indicates
 * a scoring pipeline issue, not real-world misinformation.
 */
async function detectScoreAnomalies(since: Date): Promise<ScoreAnomaly[]> {
  const rows = await db('signals')
    .where('created_at', '>', since)
    .whereIn('severity', ['critical', 'high'])
    .select('reliability_score')
    .select(db.raw('count(*)::int as cnt'))
    .select(db.raw('array_agg(id) as signal_ids'))
    .groupBy('reliability_score')
    .having(db.raw('count(*) >= 5'))
    .orderBy('cnt', 'desc')

  return rows.map((r: { reliability_score: number; cnt: number; signal_ids: string[] }) => ({
    score: Number(r.reliability_score),
    count: r.cnt,
    signalIds: r.signal_ids,
  }))
}

// ─── Feedback Loop: downgrade LIKELY FALSE signals ────────────────────────

/**
 * Parse the LLM fact-check output and downgrade signals labelled LIKELY FALSE.
 * Returns the IDs that were downgraded so we can log it.
 */
async function applyVerdicts(
  factCheckText: string,
  signals: Array<{ id: string; title: string }>,
): Promise<string[]> {
  const downgraded: string[] = []

  for (const signal of signals) {
    // Find the verdict for this signal by matching its title in the output
    const escapedTitle = signal.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').slice(0, 60)
    const titlePattern = new RegExp(escapedTitle.slice(0, 40), 'i')

    // Search for the verdict near the signal's title mention
    const lines = factCheckText.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (titlePattern.test(lines[i]) || (i > 0 && titlePattern.test(lines[i - 1]))) {
        // Check next few lines for a verdict
        const vicinity = lines.slice(Math.max(0, i - 1), i + 4).join(' ')
        if (/LIKELY\s*FALSE/i.test(vicinity)) {
          downgraded.push(signal.id)
          break
        }
      }
    }
  }

  if (downgraded.length > 0) {
    await db('signals')
      .whereIn('id', downgraded)
      .update({
        status: 'disputed',
        reliability_score: db.raw('LEAST(reliability_score, 0.25)'),
      })

    console.log(`[PULSE:FactCheck] Downgraded ${downgraded.length} LIKELY FALSE signal(s): ${downgraded.join(', ')}`)
  }

  return downgraded
}

/**
 * Run the fact-checker's review cycle.
 */
export async function runFactCheck(agent: AgentConfig): Promise<AgentScanResult> {
  const since = new Date(Date.now() - 4 * 3600_000) // last 4 hours

  // ── Step 1: Detect score anomalies (data quality issues) ────────────────
  const anomalies = await detectScoreAnomalies(since)
  const anomalyContext = anomalies.length > 0
    ? `\n\nDATA QUALITY NOTE: ${anomalies.map(a =>
        `${a.count} signals share identical reliability score ${a.score.toFixed(3)}`
      ).join('; ')}. Identical scores across unrelated signals indicate a scoring pipeline issue, not real-world feed contamination. Mention this separately under "DATA QUALITY" — do not conflate it with claim verification.`
    : ''

  // ── Step 2: Find suspicious signals ─────────────────────────────────────
  const suspiciousSignals = await db('signals')
    .whereIn('status', ['verified', 'pending'])
    .where('created_at', '>', since)
    .whereIn('severity', ['critical', 'high'])
    .where(function() {
      this.where('reliability_score', '<', 0.6)
        .orWhere('source_count', '<', 2)
    })
    .orderBy('severity')
    .orderBy('reliability_score', 'asc')
    .limit(10)
    .select(['id', 'title', 'summary', 'category', 'severity',
      'reliability_score', 'source_count', 'location_name',
      'country_code', 'created_at'])

  if (suspiciousSignals.length === 0 && anomalies.length === 0) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      signalsReviewed: 0,
      trendsIdentified: 0,
      published: false,
    }
  }

  // ── Step 3: Deduplication ───────────────────────────────────────────────
  const alreadyChecked = await db('pulse_publish_log')
    .where('content_type', 'analysis')
    .where('published_at', '>', since)
    .whereRaw("metadata->>'agentId' = 'fact-checker'")
    .select('source_signals')

  const checkedIds = new Set<string>()
  for (const row of alreadyChecked) {
    for (const id of (row.source_signals ?? [])) {
      checkedIds.add(id)
    }
  }

  const unchecked = suspiciousSignals.filter(s => !checkedIds.has(s.id))

  if (unchecked.length === 0 && anomalies.length === 0) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      signalsReviewed: suspiciousSignals.length,
      trendsIdentified: 0,
      published: false,
    }
  }

  // ── Step 4: Generate fact-check with improved prompt ────────────────────
  const signalList = unchecked.map((s, i) =>
    `${i + 1}. [${s.severity.toUpperCase()}] ${s.title}\n   Reliability: ${s.reliability_score} | Sources: ${s.source_count}\n   Location: ${s.location_name ?? 'Unknown'}\n   Summary: ${s.summary ?? 'N/A'}`
  ).join('\n\n')

  const prompt = `As the PULSE Fact-Check Bureau, review these ${unchecked.length} signals that have high severity but low corroboration:

${signalList}
${anomalyContext}

Structure your response in TWO sections:

SECTION 1 — CLAIM VERIFICATION
For each signal, assess the real-world claim:
- CONFIRMED — multiple independent sources corroborate the core claim
- CONTESTED — sources disagree on key details (specify what's disputed)
- UNVERIFIED — insufficient independent corroboration (specify what's needed)
- LIKELY FALSE — evidence or source patterns suggest the claim is inaccurate

For each verdict, include:
- What evidence supports or undermines the claim
- What specific corroboration is missing
- Whether the source is known for sensationalism or has a track record

SECTION 2 — SIGNAL QUALITY ASSESSMENT
Rate the overall quality of the signal stream:
- HEALTHY — diverse sources, varied scores, strong corroboration
- DEGRADED — some gaps in source diversity or corroboration
- POOR — widespread single-source signals, scoring anomalies, or low diversity

${anomalies.length > 0 ? 'Note: Identical reliability scores across unrelated signals are a SCORING PIPELINE issue, not misinformation. Report this under signal quality, not claim verification.' : ''}

Do NOT include recommendations or developer notes — only report verdicts and quality assessment.`

  const result = await generateContent(prompt, 1000, 'deep', EDITORIAL_SYSTEM_PROMPT + '\n\n' + agent.specialization)

  // ── Quality gate: reject empty/short LLM output ───────────────────────
  const factCheckText = result.text.trim()
  if (!factCheckText || factCheckText.length < 50) {
    console.warn(`[PULSE:FactCheck] Rejected: LLM returned empty/short output (${factCheckText.length} chars)`)
    return {
      agentId: agent.id,
      agentName: agent.name,
      signalsReviewed: suspiciousSignals.length,
      trendsIdentified: unchecked.length,
      published: false,
      error: 'LLM output too short — skipping fact-check publication',
    }
  }

  // ── Step 5: Apply verdicts — downgrade LIKELY FALSE signals ─────────────
  const downgraded = await applyVerdicts(factCheckText, unchecked)

  // ── Step 6: Publish as a fact-check post ────────────────────────────────
  try {
    const [post] = await db('posts')
      .insert({
        author_id:          PULSE_USER_ID,
        post_type:          'signal',
        content:            `[FACT CHECK]\n\n${factCheckText}\n\n— PULSE Fact-Check Bureau · WorldPulse AI`,
        pulse_content_type: ContentType.ANALYSIS,
        tags:               ['pulse', 'fact-check', 'verification'],
        language:           'en',
      })
      .returning('*')

    await db('pulse_publish_log').insert({
      post_id:        post.id,
      content_type:   ContentType.ANALYSIS,
      source_signals: unchecked.map(s => s.id),
      model_used:     result.model,
      token_count:    result.tokens,
      generation_ms:  result.durationMs,
      metadata: {
        agentId: agent.id,
        agentName: agent.name,
        agentRole: 'fact-checker',
        provider: result.provider,
        signalsChecked: unchecked.length,
        signalsDowngraded: downgraded.length,
        scoreAnomalies: anomalies.length,
      },
    })

    await redis.publish('wp:post.new', JSON.stringify({
      event: 'post.new',
      payload: { postId: post.id, contentType: 'analysis', author: 'pulse' },
    })).catch(() => {})

    return {
      agentId: agent.id,
      agentName: agent.name,
      signalsReviewed: suspiciousSignals.length,
      trendsIdentified: unchecked.length,
      published: true,
      postId: post.id,
    }
  } catch (err) {
    return {
      agentId: agent.id,
      agentName: agent.name,
      signalsReviewed: suspiciousSignals.length,
      trendsIdentified: unchecked.length,
      published: false,
      error: err instanceof Error ? err.message : 'Publish failed',
    }
  }
}
