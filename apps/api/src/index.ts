import Fastify from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import jwt from '@fastify/jwt'
import rateLimit from '@fastify/rate-limit'
import websocket from '@fastify/websocket'
import swagger from '@fastify/swagger'
import swaggerUI from '@fastify/swagger-ui'
import rawBody from 'fastify-raw-body'
import { redis } from './db/redis'
import { db } from './db/postgres'
import { registerFeedRoutes } from './routes/feed'
import { registerAuthRoutes } from './routes/auth'
import { registerPostRoutes } from './routes/posts'
import { registerSignalRoutes } from './routes/signals'
import { registerSearchRoutes } from './routes/search'
import { registerUserRoutes } from './routes/users'
import { registerAlertRoutes } from './routes/alerts'
import { registerAnalyticsRoutes } from './routes/analytics'
import { registerCommunityRoutes } from './routes/communities'
import { registerPollRoutes } from './routes/polls'
import { registerSourceRoutes } from './routes/sources'
import { registerAdminRoutes } from './routes/admin'
import { registerDeveloperRoutes } from './routes/developer'
import { registerEmbedRoutes } from './routes/embed'
import { registerStixRoutes } from './routes/stix'
import { registerPublicRoutes } from './routes/public'
import { registerNotificationRoutes } from './routes/notifications'
import { registerUploadRoutes } from './routes/uploads'
import { registerBriefingRoutes } from './routes/briefings'
import { registerBriefingDailyRoutes } from './routes/briefing'
import { registerPersonalizationRoutes } from './routes/personalization'
import { registerDisputeRoutes } from './routes/disputes'
import { registerCountryRoutes } from './routes/countries'
import { registerBreakingRoutes } from './routes/breaking'
import { registerTradeRoutes } from './routes/trade'
import { registerCameraRoutes } from './routes/cameras'
import { registerPatentRoutes } from './routes/patents'
import { registerMaritimeRoutes } from './routes/maritime'
import { registerThreatsRoutes }  from './routes/threats'
import { registerJammingRoutes }  from './routes/jamming'
import { registerHazardsRoutes }  from './routes/hazards'
import { registerOutagesRoutes }  from './routes/outages'
import { registerThreadRoutes }   from './routes/threads'
import { registerEntityRoutes }  from './routes/entities'
import { registerAdminKafkaRoutes } from './routes/admin-kafka'
import { registerSlopRoutes } from './routes/slop'
import { registerRssRoutes } from './routes/rss'
import { registerBundleRoutes } from './routes/bundles'
import { registerSourcePacksRoutes } from './routes/source-packs'
import { registerBiasCorrectionsRoutes } from './routes/bias-corrections'
import { registerBillingRoutes } from './routes/billing'
import { registerDigestRoutes, registerAdminDigestRoutes } from './routes/digest'
import { registerFinanceRoutes } from './routes/finance'
import { registerSanctionsRoutes } from './routes/sanctions'
import { registerSpaceWeatherRoutes } from './routes/space-weather'
import { registerCyberRoutes }        from './routes/cyber'
import { registerPolymarketRoutes }   from './routes/polymarket'
import { registerAIInfrastructureRoutes } from './routes/ai-infrastructure'
import { registerWindRoutes }             from './routes/wind'
import { registerTimelineRoutes }        from './routes/timeline'
import underseaCablesPlugin              from './routes/undersea-cables'
import governancePlugin                  from './routes/governance'
import foodSecurityPlugin                from './routes/food-security'
import digitalRightsPlugin               from './routes/digital-rights'
import waterSecurityPlugin               from './routes/water-security'
import laborRightsPlugin                 from './routes/labor-rights'
import { registerMapOgRoutes }           from './routes/map/og'
import { registerClaimsRoutes }          from './routes/claims'
import { registerPulseRoutes }           from './routes/pulse'
import { registerWSHandler, startRedisSubscriber } from './ws/handler'
import { registerGraphQL } from './graphql'
import { metricsPlugin } from './middleware/metrics'
import { requestLoggerPlugin } from './middleware/request-logger'
import { securityPlugin } from './middleware/security'
import { cloudflareMiddlewarePlugin, buildCfAwareKeyGenerator } from './middleware/cloudflare'
import { registerHealthRoutes } from './routes/health'
import { registerStatusRoutes } from './routes/status'
import { logger } from './lib/logger'
import { initSentry, flushSentry } from './lib/sentry'
import { setupSearchIndexes } from './lib/search'
import { runStartupBackfill, syncRecentSignalsOnStartup } from './lib/search-backfill'
import { connectSearchProducer, disconnectSearchProducer } from './lib/search-events'
import { startSearchConsumer, stopSearchConsumer } from './lib/search-consumer'
import { initClickHouse } from './lib/search-analytics'
import { startDispatcher, stopDispatcher } from './lib/alert-dispatcher'
import { startPulseScheduler, stopPulseScheduler } from './lib/pulse/scheduler'

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? 'info',
    transport: process.env.NODE_ENV === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
  trustProxy: true,
})

async function bootstrap() {
  // ─── SENTRY (optional, env-gated) ────────────────────────
  initSentry()

  // ─── PLUGINS ─────────────────────────────────────────────
  const isDev = process.env.NODE_ENV !== 'production'
  const allowedOrigins = isDev
    ? [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://127.0.0.1:3000',
        ...(process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),
      ]
    : [
        'https://worldpulse.io',
        'https://www.worldpulse.io',
        'https://world-pulse.io',
        'https://www.world-pulse.io',
        'https://api.world-pulse.io',
        ...(process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean),
      ]

  await app.register(cors, {
    origin: (origin, cb) => {
      // Allow requests with no origin (server-to-server, curl, mobile apps, local files)
      if (!origin || origin === 'null' || allowedOrigins.includes(origin)) {
        cb(null, true)
      } else {
        cb(new Error(`CORS: origin '${origin}' not allowed`), false)
      }
    },
    credentials: true,
  })

  // ─── SECURITY HEADERS (helmet) ────────────────────────────
  // Must be registered after CORS so helmet doesn't override CORS headers.
  await app.register(helmet, {
    // Content-Security-Policy: locked down for an API-only server.
    // The Swagger UI at /api/docs needs inline styles/scripts, so we
    // use a relaxed policy only for that prefix via the contentSecurityPolicy
    // override below; all other routes get the strict policy.
    contentSecurityPolicy: {
      directives: {
        defaultSrc:     ["'none'"],
        scriptSrc:      ["'self'"],
        styleSrc:       ["'self'"],
        imgSrc:         ["'self'", 'data:'],
        connectSrc:     ["'self'"],
        fontSrc:        ["'self'"],
        objectSrc:      ["'none'"],
        mediaSrc:       ["'none'"],
        frameSrc:       ["'none'"],
        frameAncestors: ["'none'"],
        formAction:     ["'self'"],
        baseUri:        ["'none'"],
        upgradeInsecureRequests: isDev ? null : [],
      },
    },
    // X-Frame-Options: DENY — no iframing of the API
    frameguard: { action: 'deny' },
    // X-Content-Type-Options: nosniff
    noSniff: true,
    // Referrer-Policy: strict-origin-when-cross-origin
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    // Strict-Transport-Security: 1 year + includeSubDomains (prod only)
    hsts: isDev ? false : { maxAge: 31_536_000, includeSubDomains: true, preload: true },
    // X-DNS-Prefetch-Control: off
    dnsPrefetchControl: { allow: false },
    // X-Download-Options: noopen (IE)
    ieNoOpen: true,
    // X-Permitted-Cross-Domain-Policies: none
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
    // Cross-Origin-Opener-Policy
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    // Cross-Origin-Resource-Policy
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })

  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret && process.env.NODE_ENV === 'production') {
    throw new Error('JWT_SECRET environment variable is required in production')
  }
  await app.register(jwt, {
    secret: jwtSecret ?? 'dev_secret_change_in_prod',
    sign:   { expiresIn: '24h' },
  })

  // ─── CLOUDFLARE MIDDLEWARE ────────────────────────────────
  // Must be registered BEFORE rate-limit so the CF-aware key generator
  // can read req.cfClientIp and req.isBehindCloudflare reliably.
  await app.register(cloudflareMiddlewarePlugin)

  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    redis,
    keyGenerator: buildCfAwareKeyGenerator,
    errorResponseBuilder: () => ({
      success: false,
      error: 'Too many requests. Slow down.',
      code: 'RATE_LIMITED',
    }),
  })

  await app.register(websocket)
  await app.register(metricsPlugin)
  await app.register(requestLoggerPlugin)

  // ─── SECURITY MIDDLEWARE (Gate 6) ──────────────────────
  // Payload scanning (SQLi/XSS/path traversal), request fingerprinting,
  // and security event logging. Registered after rate-limit so rate-limited
  // requests are rejected before security scanning overhead.
  await app.register(securityPlugin)

  // ─── RAW BODY (Stripe webhook signature verification) ────
  // Must be registered before route handlers. Routes opt-in via
  // config: { rawBody: true } — only the Stripe webhook endpoint
  // needs it to call stripe.webhooks.constructEvent().
  await app.register(rawBody, {
    field:    'rawBody',   // req.rawBody
    global:   false,       // opt-in per route — avoids buffering all bodies
    encoding: 'utf8',
    runFirst: true,        // run before body parser plugins
  })

  // ─── SWAGGER / OPENAPI ───────────────────────────────────
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'WorldPulse API',
        description: [
          'Real-time global intelligence network.',
          '',
          '## Authentication',
          'Most endpoints require a Bearer JWT. Obtain tokens via `POST /api/v1/auth/login`.',
          'Pass the access token as `Authorization: Bearer <token>`.',
          '',
          '## Rate Limits',
          'Default: 200 req/min per user. Auth endpoints: 5 req/min.',
          'Rate-limit headers are included in every response.',
        ].join('\n'),
        version: '1.0.0',
        contact: {
          name: 'WorldPulse',
          url: 'https://worldpulse.io',
        },
        license: {
          name: 'MIT',
          url: 'https://opensource.org/licenses/MIT',
        },
      },
      servers: [
        { url: 'https://api.worldpulse.io', description: 'Production' },
        { url: 'http://localhost:3001', description: 'Local development' },
      ],
      tags: [
        { name: 'auth',          description: 'Authentication & session management' },
        { name: 'feed',          description: 'Global feed, following feed, trending' },
        { name: 'signals',       description: 'Verified world events / breaking signals' },
        { name: 'posts',         description: 'User-generated content & threads' },
        { name: 'search',        description: 'Full-text search & autocomplete' },
        { name: 'users',         description: 'User profiles, follows, notifications' },
        { name: 'communities',   description: 'Topic communities' },
        { name: 'polls',         description: 'Polls attached to posts' },
        { name: 'sources',       description: 'News sources & trust tiers' },
        { name: 'alerts',        description: 'User alert subscriptions' },
        { name: 'analytics',     description: 'Personal engagement analytics' },
        { name: 'notifications', description: 'Push notification device tokens' },
        { name: 'uploads',       description: 'Media uploads' },
        { name: 'developer',     description: 'Developer API keys' },
        { name: 'embed',         description: 'Public embeddable widgets' },
        { name: 'admin',         description: 'Admin-only operations' },
        { name: 'stix',          description: 'STIX 2.1 threat intelligence export' },
        { name: 'briefings',     description: 'AI-powered daily intelligence briefings' },
        { name: 'breaking-alerts', description: 'Real-time breaking news alert banners' },
        { name: 'cameras',         description: 'Live public CCTV/webcam feeds by region' },
        { name: 'maritime',        description: 'Naval intelligence — carrier strike groups and AIS vessel tracking' },
        { name: 'threats',         description: 'Missile and drone threat intelligence — ballistic, cruise, hypersonic, rocket, UAV' },
        { name: 'jamming',         description: 'GPS/GNSS jamming intelligence — military EW, spoofing, civilian interference zones' },
        { name: 'rss',             description: 'RSS/Atom, JSON Feed, and OPML syndication feeds for signal distribution' },
        { name: 'bundles',         description: 'Ed25519-signed verified source packs for AI agent pipelines' },
        { name: 'digest',          description: 'Weekly/daily email digest subscriptions' },
        { name: 'finance',         description: 'Financial intelligence — market signals, central bank alerts, crypto, sanctions' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http' as const,
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'JWT access token from POST /api/v1/auth/login',
          },
        },
      },
    },
    // Strip internal/runtime fields from the spec
    hideUntagged: false,
    refResolver: {
      buildLocalReference: (json, _baseUri, _fragment, _i) =>
        (json.$id as string | undefined) ?? `model-${_i}`,
    },
  })

  await app.register(swaggerUI, {
    routePrefix: '/api/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      tryItOutEnabled: true,
      persistAuthorization: true,
    },
    staticCSP: true,
  })

  // ─── HEALTH ──────────────────────────────────────────────
  // Legacy shallow health check (for load-balancer pings)
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))
  // Enhanced per-service health check
  await app.register(registerHealthRoutes, { prefix: '/api/v1/health' })
  // Public status page endpoint
  await app.register(registerStatusRoutes, { prefix: '/api/v1/status' })

  // ─── ROUTES ──────────────────────────────────────────────
  await app.register(registerAuthRoutes,   { prefix: '/api/v1/auth' })
  await app.register(registerFeedRoutes,   { prefix: '/api/v1/feed' })
  await app.register(registerPostRoutes,   { prefix: '/api/v1/posts' })
  await app.register(registerSignalRoutes, { prefix: '/api/v1/signals' })
  await app.register(registerTimelineRoutes, { prefix: '/api/v1/signals' })
  await app.register(registerSearchRoutes, { prefix: '/api/v1/search' })
  await app.register(registerUserRoutes,   { prefix: '/api/v1/users' })
  await app.register(registerAlertRoutes,     { prefix: '/api/v1/alerts' })
  await app.register(registerAnalyticsRoutes,  { prefix: '/api/v1/analytics' })
  await app.register(registerCommunityRoutes,  { prefix: '/api/v1/communities' })
  await app.register(registerPollRoutes,       { prefix: '/api/v1/polls' })
  await app.register(registerSourceRoutes,     { prefix: '/api/v1/sources' })
  await app.register(registerNotificationRoutes, { prefix: '/api/v1/notifications' })
  await app.register(registerUploadRoutes,       { prefix: '/api/v1/uploads' })
  await app.register(registerAdminRoutes,        { prefix: '/api/v1/admin' })
  await app.register(registerDeveloperRoutes,    { prefix: '/api/v1/developer/keys' })
  await app.register(registerEmbedRoutes,        { prefix: '/api/v1/embed' })
  await app.register(registerStixRoutes,         { prefix: '/api/v1/stix' })
  await app.register(registerPublicRoutes,       { prefix: '/api/v1/public' })
  await app.register(registerBriefingRoutes,        { prefix: '/api/v1/briefings' })
  await app.register(registerBriefingDailyRoutes,   { prefix: '/api/v1/briefing' })
  await app.register(registerCountryRoutes,     { prefix: '/api/v1/countries' })
  await app.register(registerBreakingRoutes,    { prefix: '/api/v1/breaking' })
  await app.register(registerTradeRoutes,       { prefix: '/api/v1/trade' })
  await app.register(registerCameraRoutes,      { prefix: '/api/v1/cameras' })
  await app.register(registerPatentRoutes,      { prefix: '/api/v1/patents' })
  await app.register(registerMaritimeRoutes,    { prefix: '/api/v1/maritime' })
  await app.register(registerThreatsRoutes,     { prefix: '/api/v1/threats' })
  await app.register(registerJammingRoutes,       { prefix: '/api/v1/jamming' })
  await app.register(registerHazardsRoutes,       { prefix: '/api/v1/hazards' })
  await app.register(registerOutagesRoutes,       { prefix: '/api/v1/outages' })
  await app.register(registerThreadRoutes,       { prefix: '/api/v1/threads' })
  await app.register(registerEntityRoutes,      { prefix: '/api/v1/entities' })
  await app.register(registerAdminKafkaRoutes,   { prefix: '/api/v1/admin' })
  await app.register(registerSlopRoutes,         { prefix: '/api/v1/slop' })
  await app.register(registerRssRoutes,          { prefix: '/api/v1/rss' })
  await app.register(registerBundleRoutes,       { prefix: '/api/v1/bundles' })
  await app.register(registerSourcePacksRoutes,     { prefix: '/api/v1/source-packs' })
  await app.register(registerBiasCorrectionsRoutes, { prefix: '/api/v1' })
  await app.register(registerPersonalizationRoutes, { prefix: '/api/v1/me' })
  await app.register(registerDisputeRoutes, { prefix: '/api/v1' })

  // ─── BILLING (Stripe Pro tier) ────────────────────────────
  // @fastify/raw-body is registered globally (global: false, per-route opt-in)
  // near the top of bootstrap(). The webhook route uses config: { rawBody: true }
  // to capture rawBody for stripe.webhooks.constructEvent() signature verification.
  await app.register(registerBillingRoutes, { prefix: '/api/v1/billing' })

  // ─── DIGEST (weekly/daily email newsletter) ───────────────
  await app.register(registerDigestRoutes,      { prefix: '/api/v1/digest' })
  await app.register(registerAdminDigestRoutes, { prefix: '/api/v1/admin' })

  // ─── FINANCE INTELLIGENCE ─────────────────────────────────
  await app.register(registerFinanceRoutes, { prefix: '/api/v1/finance' })

  // ─── SANCTIONS & WATCHLIST INTELLIGENCE ──────────────────
  await app.register(registerSanctionsRoutes, { prefix: '/api/v1/sanctions' })

  // ─── SPACE WEATHER INTELLIGENCE ──────────────────────────
  await app.register(registerSpaceWeatherRoutes, { prefix: '/api/v1/space-weather' })

  // ─── CYBER THREAT INTELLIGENCE ───────────────────────────
  await app.register(registerCyberRoutes,        { prefix: '/api/v1/cyber' })
  await app.register(registerPolymarketRoutes,   { prefix: '/api/v1/polymarket' })
  await app.register(registerAIInfrastructureRoutes, { prefix: '/api/v1/ai-infrastructure' })
  await app.register(registerWindRoutes)
  await app.register(underseaCablesPlugin,            { prefix: '/api/v1/undersea-cables' })
  await app.register(governancePlugin,                { prefix: '/api/v1/governance' })
  await app.register(foodSecurityPlugin,             { prefix: '/api/v1/food-security' })
  await app.register(digitalRightsPlugin,            { prefix: '/api/v1/digital-rights' })
  await app.register(waterSecurityPlugin,            { prefix: '/api/v1/water-security' })
  await app.register(laborRightsPlugin,              { prefix: '/api/v1/labor-rights' })
  await app.register(registerMapOgRoutes,             { prefix: '/api/v1/map' })
  await app.register(registerClaimsRoutes,            { prefix: '/api/v1/claims' })

  // ─── PULSE AI PUBLISHER ──────────────────────────────────
  await app.register(registerPulseRoutes,             { prefix: '/api/v1/pulse' })

  // ─── GRAPHQL ─────────────────────────────────────────────
  await registerGraphQL(app)

  // ─── WEBSOCKET ───────────────────────────────────────────
  await app.register(registerWSHandler)
  // Start Redis pub/sub subscriber so scraper-published signals are broadcast
  // to WebSocket clients and indexed in Meilisearch in real time.
  startRedisSubscriber().catch(err => {
    logger.warn({ err }, 'Redis pub/sub subscriber failed to start (non-fatal)')
  })

  // ─── SEARCH INDEX SETUP + BACKFILL ───────────────────────
  // 1. Ensure index settings are configured.
  // 2. Backfill signals, posts, and users if any index is empty
  //    (covers cold-start and first-deploy scenarios).
  setupSearchIndexes()
    .then(() => runStartupBackfill())
    .then(() => syncRecentSignalsOnStartup())
    .catch(err => {
      logger.warn({ err }, 'Meilisearch index setup/backfill failed — search may degrade gracefully')
    })

  // ─── CLICKHOUSE INIT ─────────────────────────────────────
  initClickHouse().catch(err => {
    logger.warn({ err }, 'ClickHouse init failed — search analytics will be silently skipped')
  })

  // ─── SEARCH KAFKA PRODUCER + CONSUMER ────────────────────
  // Both are non-fatal — routes fall back to direct Meilisearch calls.
  connectSearchProducer().catch(err => {
    logger.warn({ err }, 'Search producer failed to connect')
  })
  startSearchConsumer().catch(err => {
    logger.warn({ err }, 'Search consumer failed to start')
  })

  // ─── ALERT DISPATCHER ────────────────────────────────────
  // Non-fatal — starts 60s polling loop for Telegram/Discord alerts.
  startDispatcher()

  // ─── PULSE AI PUBLISHER SCHEDULER ────────────────────────
  // Gated by PULSE_ENABLED=true — runs flash brief checks (5m)
  // and daily briefing (7am ET).
  startPulseScheduler()

  // ─── GRACEFUL SHUTDOWN ────────────────────────────────────
  const shutdown = async () => {
    stopPulseScheduler()
    stopDispatcher()
    await Promise.allSettled([
      stopSearchConsumer(),
      disconnectSearchProducer(),
      flushSentry(2000),
      app.close(),
    ])
    process.exit(0)
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT',  shutdown)

  // ─── START ───────────────────────────────────────────────
  const port = Number(process.env.PORT ?? 3001)
  await app.listen({ port, host: '0.0.0.0' })
  logger.info(`WorldPulse API running on port ${port}`)
}

bootstrap().catch((err) => {
  logger.error(err, 'Fatal startup error')
  process.exit(1)
})
