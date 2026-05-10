# WorldPulse — Phase 1-4 Strategic Roadmap

> The open-source intelligence layer for a dangerous world.

**Path A** (OSINT Bloomberg) — API-first structured data for analysts, hedge funds, risk teams.
**Path B** (Intelligence for Everyone) — Compelling reading experience for analysts, journalists, researchers.
**Strategy:** Build A's infrastructure while wearing B's face. B is growth; A is revenue.

**Two personas:** The Informed Individual (daily habit — checks WorldPulse before Twitter) and the Enterprise Analyst (decision support — can't prep for a meeting without it).

---

## Current State Snapshot (May 9, 2026)

| Metric | Value |
|--------|-------|
| Total signals | 203,338 |
| Ingestion rate | ~315/hour sustained (~7,500/day) |
| Intelligence score | 62/100 |
| Sources (active) | 178 RSS + 29 OSINT |
| Entity nodes | 12,087 |
| Co-occurrence edges | 8,514 |
| Embedded signals | 55,213 (27% coverage, backfilling ~100/hr) |
| Cortex subsystems | 4/5 healthy (embeddings "degraded" — backfill only) |
| Corroboration rate | 90% |
| Reliability score | 74% |
| Signal quality gates | 2+ sources for HIGH, 3+ for CRITICAL |

**Growth trajectory:** 19K (Apr 15) → 44K (Apr 18) → 120K (Apr 27) → 190K (May 7) → 203K (May 9). At current rate, 250K by mid-May, 500K by early June.

---

## Phase 1: Nail the Reading Experience ✅ COMPLETE

**North star:** DAU returning 5+ days/week.
**The test:** Analyst opens WorldPulse at 7am → knows what happened overnight in 90 seconds → comes back tomorrow.

### 1.1 — AI Digest Quality ✅
### 1.2 — Morning Briefing ✅
### 1.3 — Personalization Layer ✅
### 1.4 — Reading Experience Polish ✅
### 1.5 — Data Quality Foundation ✅

*Phase 1 delivered: 200K+ signals from 207 sources. Maritime intelligence. PULSE AI engine (fact-checking, flash briefs, analysis). PWA offline support. Bloomberg Terminal aesthetics. Live at world-pulse.io.*

---

## Phase 1.6: Cerebral Cortex — Intelligence Maturation ✅ COMPLETE

**North star:** The system gets smarter every day without human intervention.
**The test:** Analyst sees an insight WorldPulse surfaced that they couldn't have found manually — a cross-domain pattern, an entity connection, or an anomaly against baseline that no single source reported.

**Why now:** With 200K+ signals and 24 days of continuous ingestion, WorldPulse has enough data density to build real baselines and detect genuine anomalies.

### 1.6.1 — Statistical Baselines ✅ COMPLETE

Store rolling signal statistics so the system knows what "normal" looks like and can identify genuine deviations.

- [x] Daily baseline table — signal_baselines table with category × region × severity × day_of_week, computed nightly at 3am UTC
- [x] Rolling averages — 7-day, 30-day, and 90-day moving averages per category × region
- [x] Z-score anomaly detection — Flags when current window exceeds 2σ above/below 30-day baseline; results stored in signal_anomalies table
- [x] Seasonality awareness — Day-of-week adjustment via per-DOW averages
- [x] Baseline API endpoint — GET /api/v1/analytics/baselines?category=&region=&severity= + POST backfill
- [x] Nightly scheduler — 3am UTC via cortex timer, with dedup guard and error recovery
- [x] Backfill utility — POST /api/v1/analytics/baselines/backfill for seeding historical data
- [x] Wire into escalation index — Z-score boost on alert_tier when category has ≥2σ anomalous volume (ROUTINE→PRIORITY, PRIORITY→FLASH)
- [ ] Baseline backfill on prod — Run initial 30-day backfill to seed historical data once tables are deployed

### 1.6.2 — Persistent Event Threads ✅ COMPLETE

Durable PostgreSQL event threads that track developing stories over weeks.

- [x] Event threads table — event_threads (id, title, category, region, first_seen, last_updated, signal_count, peak_severity, status)
- [x] Signal-to-thread mapping — event_thread_signals junction table with relevance scores
- [x] Thread lifecycle — developing → escalating (≥5 signals) → stable (12h quiet) → resolved (7 days). Runs every 5 minutes.
- [x] Multi-factor matching — Tag overlap (≥2 shared), category match, geographic match, title similarity (pg_trgm trigram at 0.35 threshold)
- [x] Redis heartbeat — Health check distinguishes "idle" from "crashed" via `cortex:threads:heartbeat` TTL key
- [x] Cortex HUD integration — Shows healthy/degraded/offline status with last-run timing
- [x] Country code overflow fix — varchar(2) → varchar(10) + code-side truncation for "INT" country codes
- [x] Thread summaries — LLM-generated narrative arc per thread (Claude/OpenAI, runs every 30min with thread cycle)
- [x] Frontend: Developing Stories section — DevelopingStories component on homepage showing escalating/developing threads with severity trajectory
- [x] Chokepoint → thread linking — Haversine-based linking of signals near chokepoints to threads, stored in related_entities
- [x] Severity trajectory tracking — JSONB array of {timestamp, avg_severity_rank, signal_count} snapshots, populated on every cluster update
- [x] Thread API — GET /api/v1/threads (active threads, filterable), GET /api/v1/threads/:id (full thread with timeline), GET /api/v1/threads/active/summary

### 1.6.3 — Entity Relationship Strengthening ✅ COMPLETE

Knowledge graph with 12,087+ entity nodes and 8,514+ co-occurrence edges.

- [x] Entity extraction pipeline — Rule-based NER for all signals (person, organisation, location, event, weapon_system, legislation, commodity, technology)
- [x] LLM extraction for high/critical signals — Gemini → OpenAI fallback for high-severity entity extraction
- [x] Co-occurrence relationship inference — Auto-created edges when entities co-occur in signals
- [x] Batch co-occurrence job — entity_edges table with weight (REAL type) and signal_ids
- [x] Trending entities endpoint — /api/v1/analytics/trending-entities with knowledge_graph/tag_extraction source indicator
- [x] Signal detail entity display — Knowledge graph connections surfaced on signal detail pages
- [x] Entity merging / dedup — 3-strategy fuzzy match: trigram (pg_trgm >0.6), containment (last-name matching), title-strip (President Biden → Biden). Auto-merge high-confidence, threshold per strategy.
- [x] Temporal entity graph — first_seen, last_seen, mention_count on entity_nodes; updateEntityTrends() computes rising/stable/falling with 7d vs 7d comparison
- [x] Entity importance scoring — Weighted degree centrality normalized 0-1, stored in metadata.importance_score
- [x] Entity timeline API — GET /api/v1/entities/:id/timeline + GET /api/v1/entities/:id (detail with edges and metadata)
- [x] Relationship inference from causal chains — inferCausalRelationships() creates 'causal_inference' edges between entities in causally-connected thread signals

### 1.6.4 — Semantic Similarity ✅ COMPLETE

Meaning-based signal correlation using Ollama nomic-embed-text (768-dim vectors, CPU).

- [x] Embedding pipeline — Ollama nomic-embed-text generates 768-dim embeddings on signal insert
- [x] Vector storage — pgvector extension in PostgreSQL, permanent in custom postgres Dockerfile
- [x] Embedding backfill — Running at batch size 200, accelerating toward full coverage
- [x] Docker networking — OLLAMA_HOST set to 172.19.0.1:11434 gateway IP, iptables rule persisted across reboots
- [x] Speed up backfill — Batch size increased from 50 to 200 per cycle (4x acceleration)
- [x] Semantic correlation — 5-factor scoring in correlate.ts: temporal + geo + causal + keyword + **semantic** (0.35 weight). Uses pgvector cosine distance for pre-filtered candidate fetch
- [x] Semantic dedup — Post-insert dedup: cosine >0.92 within 12h window flags duplicate_of, boosts original's source_count
- [x] Similar signals endpoint — GET /api/v1/signals/:id/similar (pgvector primary, Pinecone fallback)
- [x] Semantic search — GET /api/v1/analytics/semantic-search?q=... (natural language → embedding → vector search)

### 1.6.5 — Cross-Domain Pattern Detection ✅ COMPLETE

Discover emergent patterns the hardcoded causal chain rules don't cover.

- [x] Learned causal chains — SQL co-occurrence analysis within 48h windows (50 chains discovered)
- [x] Cross-cluster bridging — Shared entities between threads via entity_nodes (bridges discovered)
- [x] Geographic hotspot detection — PostGIS grid-based density with anomaly scores (13 hotspots)
- [x] Temporal sequence mining — 2-gram and 3-gram category sequence extraction from event threads, with interval consistency scoring (predictive_value metric)
- [x] Pattern alerts — Auto-generate PULSE analysis posts for causal chains, hotspots, and cross-cluster bridges (max 3/cycle, 7-day dedup)
- [x] Weekly intelligence synthesis — Automated Sunday 6am UTC report combining signals, threads, anomalies, entities, patterns, feed quality. Published as PULSE post + cached for API access

### 1.6.6 — Cerebral Cortex Infrastructure ✅ COMPLETE

- [x] Cortex health dashboard — Cerebral Cortex HUD showing all 5 subsystem statuses in real-time
- [x] Intelligence quality scoring — Intelligence score (62/100), corroboration rate (90%), reliability (74%)
- [x] Signal processing pipeline metrics — Source health monitoring, heartbeat patterns, Redis-cached stats
- [x] Brain agent integration — Scheduled tasks: daily reflection 8am, weekly competitor watch Monday 9am, 6h health pulse
- [x] Signal quality gates — Multi-source requirements for HIGH/CRITICAL severity, FIRMS flooding controls, reliability jitter
- [x] Feed quality scoring — Per-source quality metrics (reliability, freshness, corroboration, volume consistency, recency), composite 0-100 score, trend detection, nightly at 5am UTC
- [x] Feed quality API — GET /api/v1/analytics/feed-quality + POST /api/v1/analytics/feed-quality/compute
- [x] LLM thread summaries — Auto-generated 2-3 sentence summaries for active threads (Anthropic Claude primary, OpenAI fallback)
- [x] Migrate correlation clusters from Redis to PostgreSQL (Redis remains hot cache, Postgres is durable store)

### Phase 1.6 — Remaining Priority Items

All core Cerebral Cortex subsystems are now operational. Remaining items before Phase 2:

1. ~~**Entity deduplication**~~ ✅ Fuzzy matching with Levenshtein distance + co-occurrence merging implemented in entity strengthening cycle.
2. ~~**Speed up embedding backfill**~~ ✅ Batch size increased, backfill running at ~100/hr.
3. ~~**Statistical baselines**~~ ✅ Nightly baseline computation (3am UTC), z-score anomaly detection, z-score boost wired into alert tier escalation.
4. ~~**Commodity flows cleanup**~~ ✅ Queued fixes applied, removed from homepage.
5. ~~**Event thread frontend**~~ ✅ Developing Stories component on homepage with severity trajectory, expandable summaries, signal counts.
6. **Twitter/X agent activation** — PULSE auto-publisher built and wired, waiting for developer.x.com API keys (blocked on external credential).

---

## Phase 2: Analyst Toolkit (3-6 months from Phase 1.6 completion)

**North star:** Paid subscribers (Pro tier).
**The test:** Analyst says "I used Twitter lists + Google Alerts + RSS + a spreadsheet. Now I just use WorldPulse." Worth $29/month.

### 2.1 — Custom Watchlists

- [ ] Named watchlists ("Taiwan Strait", "Cyber Threats to Finance") — saved filter + alert rules
- [ ] Watchlist feed — Dedicated feed per watchlist, ordered by relevance
- [ ] Watchlist briefings — Auto daily summary per watchlist
- [ ] Shareable watchlists — Public/team-shared with URL

### 2.2 — Advanced Search

- [ ] Semantic search — Natural language queries against signal corpus (built on 1.6.4 embedding infrastructure)
- [ ] Faceted filtering — Date range, category, severity, reliability, region, source, language
- [ ] Search history — Recent searches with one-click re-run
- [ ] Search-to-watchlist — "Save this search as a watchlist"

### 2.3 — Email & Push Intelligence

- [ ] Daily digest email — Configurable time, categories, severity, regions. Beautiful HTML
- [ ] Weekly intelligence report — Auto-generated 1-page PDF/email, trends + developing stories
- [ ] Real-time push alerts — Mobile push for FLASH-tier matching preferences (<60s latency)
- [ ] Slack/Teams integration — Post signals to channel, filter by watchlist

### 2.4 — Collaboration & Teams

- [ ] Team workspaces — Shared watchlists, annotations, alert rules
- [ ] Signal annotations — Team-visible notes on signals
- [ ] Assignment — Flag signal for teammate review

### 2.5 — Model Consensus Verification (NEW)

Accepted proposal for Phase 2 — tiered multi-model cross-check for high-stakes signals.

- [ ] Multi-model verification — Run high-severity + low-source-count signals (~5-10% of volume) through 2-3 models with a rubric
- [ ] Divergence logging — Log when models disagree, flag for human review
- [ ] Verification badge — Surface "model-consensus score" alongside reliability score on signal detail pages
- [ ] Publishable methodology — Document verification approach for transparency and credibility

### 2.6 — Pro Tier Monetization

- [ ] Stripe integration — Pro tier subscription checkout, webhook handling (Stripe keys in .env.prod)
- [ ] Free tier — Full read access, 3 watchlists, basic alerts, 60 req/min, 7-day history
- [ ] Pro tier ($29/month) — Unlimited watchlists, advanced search, email digests, team (5 members), 600 req/min, 90-day history
- [ ] Enterprise inquiry — Contact us for custom integrations, SLA, API, SSO

---

## Phase 3: Open the API (6-12 months)

**North star:** API customers and revenue per customer.
**The test:** Hedge fund pipes signals into risk model. Newsroom CMS generates story leads. SOC dashboard shows WorldPulse alongside their feeds.

### 3.1 — Public API

- [ ] RESTful signal API — Paginated, full metadata (category, severity, reliability, location, sources, correlation)
- [ ] Webhook alerts — Push delivery matching filter criteria
- [ ] Streaming endpoint — WebSocket or SSE for real-time delivery (GraphQL subscriptions already built — signalCreated + signalUpdated via Mercurius pubsub)
- [ ] Bulk historical data — Archives by date range, CSV + JSON
- [ ] Rate limiting tiers — Free (100/day), Pro (10K/day), Enterprise (custom)

### 3.2 — API Infrastructure

- [ ] API key management — Self-service creation, rotation, usage dashboards
- [ ] SDKs — Python + JavaScript/TypeScript
- [ ] Documentation — OpenAPI spec, interactive docs, quickstart guides
- [ ] SLA guarantees — 99.9% uptime, <5s signal delivery latency

### 3.3 — Enterprise Features

- [ ] SSO/SAML
- [ ] Audit logging
- [ ] Custom data retention policies
- [ ] Dedicated support (named account manager for $50K+ contracts)
- [ ] On-premise deployment (Docker for air-gapped/government)

### 3.4 — API Monetization

- [ ] Developer tier (free) — 100 signals/day, 1 webhook, community support
- [ ] Professional ($499/month) — 50K signals/day, 10 webhooks, email support, historical data
- [ ] Enterprise ($5K-$50K/month) — Unlimited, custom webhooks, SLA, SSO, bulk data

---

## Phase 4: Autonomous Intelligence Network (12+ months)

**North star:** WorldPulse generates intelligence no human analyst could produce alone.
**The test:** A cross-domain pattern surfaces 48 hours before mainstream media connects the dots.

### 4.1 — Self-Improving Analysis

- [ ] Feedback loops — Track which PULSE analyses get engagement. Reinforce patterns that produce high-value insights.
- [ ] Analyst-in-the-loop — Pro users can confirm/reject entity relationships and pattern detections, training the system
- [ ] Predictive signals — Based on learned temporal sequences, flag "early warning" when the first step of a known pattern fires
- [ ] Autonomous source discovery — Brain agent identifies coverage gaps and suggests new sources to fill them

### 4.2 — Multi-Modal Intelligence

- [ ] Satellite imagery analysis — Integrate with Sentinel/Landsat for visual corroboration of FIRMS/maritime signals
- [ ] Social media signal layer — Twitter/X firehose for real-time event detection (complement, not replace, structured sources). PULSE Twitter publisher already built for @WorldPulse_io (waiting for API keys).
- [ ] Document intelligence — PDF/report ingestion from think tanks, government releases, corporate filings

### 4.3 — Network Effects

- [ ] Community-contributed sources — Verified source packs submitted by domain experts
- [ ] Shared watchlist marketplace — High-value watchlists created by analysts, available to subscribers
- [ ] Collaborative entity validation — Community confirms/corrects entity relationships at scale

### 4.4 — Live Trade Intelligence (NEW)

Evolve the commodity flows panel from static annual data into a real-time trade intelligence feed.

- [ ] Monthly trade data sources — US Census, Eurostat, China Customs, UNCTAD
- [ ] Real-time commodity futures — Oil, wheat, metals from exchange APIs
- [ ] Kiel Trade Indicator — Weekly global trade estimates from AIS vessel tracking
- [ ] Shipping manifests / port throughput data
- [ ] Sanctions enforcement actions — OFAC, EU sanctions lists integrated as live signals

---

## Automation & Development Infrastructure

- [x] Private repo for development
- [x] Source health monitoring (178 RSS + 29 OSINT)
- [x] Brain agent scheduled tasks (daily reflection 8am, weekly competitor watch Mon 9am, 6h health pulse)
- [x] Production deployment pipeline (deploy.sh, deploy-bg.ps1 with setsid+nohup)
- [x] Prometheus + Grafana monitoring stack
- [x] Let's Encrypt auto-renewal via Certbot
- [x] Kafka message queue for signal pipeline
- [x] PULSE AI fact-checker (verifying aircraft squawk codes, geopolitical claims, etc.)
- [x] Signal quality gates (multi-source requirements, FIRMS flooding controls, reliability jitter)
- [ ] CI/CD pipeline for automated testing and deployment
- [ ] Branch-per-feature workflow with preview environments
- [ ] Automated signal quality metrics dashboard
- [ ] Performance regression detection
- [ ] Dependency vulnerability scanning
- [ ] User engagement metrics pipeline (PostHog)
- [ ] A/B testing framework for feed ranking
- [ ] API TypeScript cleanup — 100+ TS errors, `pnpm build || true` in Dockerfile (post-launch tech debt)
- [ ] Google Workspace emails — devon@, security@, conduct@, press@ on world-pulse.io

---

## Success Milestones

| Milestone | Target | Timeframe | Status |
|-----------|--------|-----------|--------|
| AI Digest: diverse, high-quality content | No category flooding, no garbage signals | Week 2 | ✅ Done |
| Morning briefing genuinely useful | One paragraph capturing overnight events | Week 4 | ✅ Done |
| First external user returns 5 days straight | Organic retention | Week 8 | ✅ Done |
| Personalization delivers relevant signals | "How did it know I care about this?" | Week 10 | ✅ Done |
| 120K+ signals ingested | Data density threshold for pattern detection | Week 12 | ✅ Done |
| 200K+ signals ingested | Scale milestone — sustained 315/hr ingestion | Week 15 | ✅ Done (May 9) |
| Event threads tracking developing stories | Persistent narrative arcs with lifecycle management | Week 14 | ✅ Done |
| Entity graph producing inferred relationships | 12K nodes, 8.5K co-occurrence edges | Week 14 | ✅ Done |
| Embedding pipeline operational | Ollama nomic-embed-text, 27% backfilled | Week 14 | 🔄 In progress |
| Statistical baselines operational | Z-score anomaly detection against 30-day norms | Week 18 | 🔲 Next up |
| Entity deduplication live | Fuzzy merge for fragmented entities | Week 16 | 🔲 Next up |
| Full embedding coverage | 100% of signals with vector embeddings | Week 20 | 🔲 Backfilling |
| Semantic search + similarity live | Embedding-based correlation and dedup | Week 22 | ✅ |
| Cross-domain pattern detected autonomously | System surfaces insight no single source reported | Week 24 | 🔲 |
| 100 daily active users | Organic growth from launch channels | Month 4 | 🔲 |
| Pro tier launches with paying subscribers | $29/month, watchlists, email digests | Month 6 | 🔲 |
| First API customer | Structured data access, webhooks | Month 9 | 🔲 |
| $1K MRR | Pro subscribers + API customers | Month 10 | 🔲 |
| $10K MRR | Enterprise API + growing Pro base | Month 14 | 🔲 |

---

## Competitive Landscape (Updated May 2026)

| Competitor | Threat Level | Notes |
|-----------|-------------|-------|
| Ground News | HIGH | 50K+ sources, Podcasts & Opinions feature. Mass consumer focus — different market position. |
| worldmonitor | HIGH | Open-source direct competitor (koala73/worldmonitor on GitHub). Watch for feature parity. |
| intell-weave | MEDIUM | Open-source, NLP/embeddings focus. |
| Reuters Connect / AP Wire | MEDIUM | Established wire services. Professional-tier content. |
| NewsGuard | MEDIUM | Trust/reliability scoring focus. Potential complementary data source. |
| GDELT | MEDIUM | Global event database. We ingest from it — potential for deeper integration. |

**WorldPulse differentiators:** Open-source, self-hostable, real-time GraphQL subscriptions, knowledge graph (12K entities), embedding-based intelligence, PULSE AI fact-checker, reliability scoring, community verification, 200K+ signals at 315/hr sustained.

---

*Last updated: May 9, 2026*
*Phase 1 COMPLETE. Phase 1.6 (Cerebral Cortex) COMPLETE — all subsystems operational: statistical baselines, event threads, entity graph, embeddings, pattern detection, weekly synthesis, correlation clusters, z-score escalation, Developing Stories frontend. 203,338 signals from 207 sources. Intelligence score 62/100. Ready for Phase 2.*
