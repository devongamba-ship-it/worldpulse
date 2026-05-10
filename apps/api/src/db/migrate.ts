/**
 * WorldPulse database migration runner.
 * Called by deploy.sh as: node dist/db/migrate.js
 * Idempotent — safe to run on both fresh and existing databases.
 */
import Knex from 'knex'

const DATABASE_URL = process.env.DATABASE_URL
if (!DATABASE_URL) {
  console.error('❌  DATABASE_URL environment variable is required')
  process.exit(1)
}

const db = Knex({
  client: 'pg',
  connection: {
    connectionString: DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production'
      ? { rejectUnauthorized: false }
      : false,
  },
  acquireConnectionTimeout: 30_000,
})

async function run() {
  console.log('🚀  WorldPulse migrations starting…')

  // ── Extensions ────────────────────────────────────────────────────────────
  await db.raw(`CREATE EXTENSION IF NOT EXISTS postgis`)
  await db.raw(`CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`)
  await db.raw(`CREATE EXTENSION IF NOT EXISTS pg_trgm`)
  await db.raw(`CREATE EXTENSION IF NOT EXISTS btree_gin`)

  // ── Enum types (skip if already exist) ───────────────────────────────────
  await db.raw(`DO $$ BEGIN
    CREATE TYPE signal_severity AS ENUM ('critical','high','medium','low','info');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`)

  await db.raw(`DO $$ BEGIN
    CREATE TYPE signal_status AS ENUM ('pending','verified','disputed','false','retracted');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`)

  await db.raw(`DO $$ BEGIN
    CREATE TYPE account_type AS ENUM ('community','journalist','official','expert','ai','bot','admin');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`)

  await db.raw(`DO $$ BEGIN
    CREATE TYPE post_type AS ENUM ('signal','thread','report','boost','deep_dive','poll','ai_digest');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`)

  await db.raw(`DO $$ BEGIN
    CREATE TYPE source_tier AS ENUM ('wire','national','regional','community','user');
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`)

  await db.raw(`DO $$ BEGIN
    CREATE TYPE category AS ENUM (
      'breaking','conflict','geopolitics','climate','health',
      'economy','technology','science','elections','culture',
      'disaster','security','sports','space','politics','other'
    );
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`)

  // ── users ─────────────────────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS users (
      id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      handle          VARCHAR(50)  UNIQUE NOT NULL,
      display_name    VARCHAR(100) NOT NULL,
      email           VARCHAR(255) UNIQUE,
      password_hash   VARCHAR(255),
      bio             TEXT,
      avatar_url      VARCHAR(512),
      location        VARCHAR(100),
      website         VARCHAR(255),
      account_type    account_type NOT NULL DEFAULT 'community',
      trust_score     DECIMAL(4,3) NOT NULL DEFAULT 0.500 CHECK (trust_score BETWEEN 0 AND 1),
      follower_count  INTEGER NOT NULL DEFAULT 0,
      following_count INTEGER NOT NULL DEFAULT 0,
      signal_count    INTEGER NOT NULL DEFAULT 0,
      verified        BOOLEAN NOT NULL DEFAULT FALSE,
      verified_at     TIMESTAMPTZ,
      verified_by     UUID REFERENCES users(id),
      suspended       BOOLEAN NOT NULL DEFAULT FALSE,
      suspended_at    TIMESTAMPTZ,
      suspension_reason TEXT,
      oauth_github    VARCHAR(255) UNIQUE,
      oauth_google    VARCHAR(255) UNIQUE,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen_at    TIMESTAMPTZ
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_users_handle  ON users(handle)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_users_trust   ON users(trust_score DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_users_type    ON users(account_type)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_users_created ON users(created_at DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_users_search  ON users USING gin(display_name gin_trgm_ops)`)

  // ── sources ───────────────────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS sources (
      id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      slug            VARCHAR(100) UNIQUE NOT NULL,
      name            VARCHAR(255) NOT NULL,
      description     TEXT,
      url             VARCHAR(512) NOT NULL,
      logo_url        VARCHAR(512),
      tier            source_tier NOT NULL DEFAULT 'community',
      trust_score     DECIMAL(4,3) NOT NULL DEFAULT 0.700 CHECK (trust_score BETWEEN 0 AND 1),
      language        CHAR(2) NOT NULL DEFAULT 'en',
      country         CHAR(2),
      categories      category[] NOT NULL DEFAULT '{}',
      rss_feeds       TEXT[] NOT NULL DEFAULT '{}',
      api_endpoint    VARCHAR(512),
      scrape_interval INTEGER NOT NULL DEFAULT 300,
      last_scraped    TIMESTAMPTZ,
      active          BOOLEAN NOT NULL DEFAULT TRUE,
      article_count   INTEGER NOT NULL DEFAULT 0,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_sources_tier    ON sources(tier, trust_score DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_sources_country ON sources(country)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_sources_active  ON sources(active) WHERE active = TRUE`)

  // ── signals ───────────────────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS signals (
      id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      title             VARCHAR(500) NOT NULL,
      summary           TEXT,
      body              TEXT,
      category          category NOT NULL DEFAULT 'other',
      severity          signal_severity NOT NULL DEFAULT 'info',
      status            signal_status NOT NULL DEFAULT 'pending',
      reliability_score DECIMAL(4,3) NOT NULL DEFAULT 0.000 CHECK (reliability_score BETWEEN 0 AND 1),
      source_count      INTEGER NOT NULL DEFAULT 0,
      location          GEOMETRY(POINT, 4326),
      location_name     VARCHAR(255),
      country_code      CHAR(2),
      region            VARCHAR(100),
      tags              TEXT[] NOT NULL DEFAULT '{}',
      source_ids        UUID[] NOT NULL DEFAULT '{}',
      original_urls     TEXT[] NOT NULL DEFAULT '{}',
      language          CHAR(2) NOT NULL DEFAULT 'en',
      view_count        INTEGER NOT NULL DEFAULT 0,
      share_count       INTEGER NOT NULL DEFAULT 0,
      post_count        INTEGER NOT NULL DEFAULT 0,
      event_time        TIMESTAMPTZ,
      first_reported    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      verified_at       TIMESTAMPTZ,
      last_updated      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signals_category   ON signals(category, created_at DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signals_severity   ON signals(severity, created_at DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signals_status     ON signals(status) WHERE status = 'verified'`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signals_location   ON signals USING GIST(location)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signals_country    ON signals(country_code, created_at DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signals_created    ON signals(created_at DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signals_event_time ON signals(event_time DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signals_tags       ON signals USING gin(tags)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signals_text       ON signals USING gin(
    to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,''))
  )`)

  // ── communities (before posts — posts.pinned_in_community_id references it) ─
  await db.raw(`
    CREATE TABLE IF NOT EXISTS communities (
      id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      slug         VARCHAR(100) UNIQUE NOT NULL,
      name         VARCHAR(255) NOT NULL,
      description  TEXT,
      avatar_url   VARCHAR(512),
      banner_url   VARCHAR(512),
      categories   category[] NOT NULL DEFAULT '{}',
      member_count INTEGER NOT NULL DEFAULT 0,
      post_count   INTEGER NOT NULL DEFAULT 0,
      public       BOOLEAN NOT NULL DEFAULT TRUE,
      created_by   UUID NOT NULL REFERENCES users(id),
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  await db.raw(`
    CREATE TABLE IF NOT EXISTS community_members (
      community_id UUID NOT NULL REFERENCES communities(id) ON DELETE CASCADE,
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role         VARCHAR(20) NOT NULL DEFAULT 'member',
      joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (community_id, user_id)
    )
  `)

  // ── posts ─────────────────────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS posts (
      id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      author_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_type       post_type NOT NULL DEFAULT 'signal',
      content         TEXT NOT NULL CHECK (char_length(content) <= 2000),
      signal_id       UUID REFERENCES signals(id) ON DELETE SET NULL,
      parent_id       UUID REFERENCES posts(id) ON DELETE CASCADE,
      boost_of_id     UUID REFERENCES posts(id) ON DELETE SET NULL,
      thread_root_id  UUID REFERENCES posts(id) ON DELETE CASCADE,
      location        GEOMETRY(POINT, 4326),
      location_name   VARCHAR(255),
      media_urls      TEXT[] NOT NULL DEFAULT '{}',
      media_types     TEXT[] NOT NULL DEFAULT '{}',
      source_url      VARCHAR(512),
      source_name     VARCHAR(255),
      tags            TEXT[] NOT NULL DEFAULT '{}',
      mentions        UUID[] NOT NULL DEFAULT '{}',
      like_count      INTEGER NOT NULL DEFAULT 0,
      boost_count     INTEGER NOT NULL DEFAULT 0,
      reply_count     INTEGER NOT NULL DEFAULT 0,
      view_count      INTEGER NOT NULL DEFAULT 0,
      reliability_score DECIMAL(4,3),
      flagged         BOOLEAN NOT NULL DEFAULT FALSE,
      flagged_reason  TEXT,
      is_edited       BOOLEAN NOT NULL DEFAULT FALSE,
      poll_data       JSONB,
      pinned          BOOLEAN NOT NULL DEFAULT FALSE,
      pinned_in_community_id UUID REFERENCES communities(id) ON DELETE SET NULL,
      language        CHAR(2) NOT NULL DEFAULT 'en',
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      deleted_at      TIMESTAMPTZ
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_posts_author      ON posts(author_id, created_at DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_posts_signal      ON posts(signal_id, created_at DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_posts_parent      ON posts(parent_id, created_at DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_posts_thread_root ON posts(thread_root_id, created_at DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_posts_created     ON posts(created_at DESC) WHERE deleted_at IS NULL`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_posts_location    ON posts USING GIST(location)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_posts_tags        ON posts USING gin(tags)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_posts_text        ON posts USING gin(to_tsvector('english', content))`)
  // Patch existing posts table if columns are missing (handles init.sql-seeded DBs)
  await db.raw(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS is_edited BOOLEAN NOT NULL DEFAULT FALSE`)
  await db.raw(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS poll_data JSONB`)
  await db.raw(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE`)
  await db.raw(`ALTER TABLE posts ADD COLUMN IF NOT EXISTS pinned_in_community_id UUID REFERENCES communities(id) ON DELETE SET NULL`)

  // Must come after the pinned column is guaranteed to exist
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_posts_pinned      ON posts(pinned_in_community_id) WHERE pinned = TRUE`)

  // ── follows ───────────────────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS follows (
      follower_id  UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      following_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (follower_id, following_id),
      CHECK (follower_id != following_id)
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_follows_follower  ON follows(follower_id)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_follows_following ON follows(following_id)`)

  // ── likes ─────────────────────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS likes (
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id    UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, post_id)
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_likes_post ON likes(post_id)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_likes_user ON likes(user_id, created_at DESC)`)

  // ── bookmarks ─────────────────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS bookmarks (
      user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id    UUID NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, post_id)
    )
  `)

  // ── alert_subscriptions ───────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS alert_subscriptions (
      id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name          VARCHAR(100) NOT NULL,
      keywords      TEXT[] NOT NULL DEFAULT '{}',
      categories    category[] NOT NULL DEFAULT '{}',
      countries     CHAR(2)[] NOT NULL DEFAULT '{}',
      min_severity  signal_severity NOT NULL DEFAULT 'medium',
      channels      JSONB NOT NULL DEFAULT '{"email":true,"push":true,"in_app":true}',
      active        BOOLEAN NOT NULL DEFAULT TRUE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_alerts_user ON alert_subscriptions(user_id) WHERE active = TRUE`)

  // ── notifications ─────────────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS notifications (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type        VARCHAR(50) NOT NULL,
      actor_id    UUID REFERENCES users(id) ON DELETE CASCADE,
      post_id     UUID REFERENCES posts(id) ON DELETE CASCADE,
      signal_id   UUID REFERENCES signals(id) ON DELETE CASCADE,
      payload     JSONB NOT NULL DEFAULT '{}',
      read        BOOLEAN NOT NULL DEFAULT FALSE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_notif_user   ON notifications(user_id, created_at DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_notif_unread ON notifications(user_id) WHERE read = FALSE`)

  // ── signal_sources (junction) ─────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS signal_sources (
      signal_id     UUID NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
      source_id     UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      article_url   VARCHAR(512) NOT NULL,
      article_title VARCHAR(500),
      published_at  TIMESTAMPTZ,
      PRIMARY KEY (signal_id, source_id)
    )
  `)

  // ── raw_articles ──────────────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS raw_articles (
      id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      source_id    UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      url          VARCHAR(512) UNIQUE NOT NULL,
      title        VARCHAR(500),
      body         TEXT,
      summary      TEXT,
      author       VARCHAR(255),
      published_at TIMESTAMPTZ,
      fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      processed    BOOLEAN NOT NULL DEFAULT FALSE,
      signal_id    UUID REFERENCES signals(id) ON DELETE SET NULL,
      language     CHAR(2) DEFAULT 'en',
      word_count   INTEGER,
      hash         VARCHAR(64)
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_articles_source      ON raw_articles(source_id, fetched_at DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_articles_unprocessed ON raw_articles(processed) WHERE processed = FALSE`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_articles_hash        ON raw_articles(hash)`)

  // ── verification_log ──────────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS verification_log (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      signal_id   UUID NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
      check_type  VARCHAR(50) NOT NULL,
      result      VARCHAR(20) NOT NULL,
      confidence  DECIMAL(4,3),
      notes       TEXT,
      actor_id    UUID REFERENCES users(id),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_verify_signal ON verification_log(signal_id, created_at DESC)`)

  // Add Phase 6a columns to verification_log (idempotent via IF NOT EXISTS)
  await db.raw(`ALTER TABLE verification_log ADD COLUMN IF NOT EXISTS verifier_type VARCHAR(50)`)
  await db.raw(`ALTER TABLE verification_log ADD COLUMN IF NOT EXISTS verdict       VARCHAR(20)`)
  await db.raw(`ALTER TABLE verification_log ADD COLUMN IF NOT EXISTS score_delta   DECIMAL(8, 4)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_verify_verifier_type ON verification_log (signal_id, verifier_type)`)

  // ── moderation_actions ────────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS moderation_actions (
      id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      moderator_id UUID NOT NULL REFERENCES users(id),
      target_type  VARCHAR(20) NOT NULL,
      target_id    UUID NOT NULL,
      action       VARCHAR(50) NOT NULL,
      reason       TEXT NOT NULL,
      public_note  TEXT,
      reversed     BOOLEAN NOT NULL DEFAULT FALSE,
      reversed_at  TIMESTAMPTZ,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_mod_target  ON moderation_actions(target_type, target_id, created_at DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_mod_created ON moderation_actions(created_at DESC)`)

  // ── polls ─────────────────────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS polls (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      author_id   UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      post_id     UUID REFERENCES posts(id) ON DELETE SET NULL,
      question    VARCHAR(500) NOT NULL,
      options     JSONB NOT NULL DEFAULT '[]',
      expires_at  TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_polls_author ON polls(author_id, created_at DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_polls_post   ON polls(post_id) WHERE post_id IS NOT NULL`)

  await db.raw(`
    CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id      UUID NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
      user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      option_index INTEGER NOT NULL CHECK (option_index BETWEEN 0 AND 9),
      voted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (poll_id, user_id)
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_poll_votes_poll ON poll_votes(poll_id)`)

  // ── trending_topics ───────────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS trending_topics (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      tag         VARCHAR(100) NOT NULL,
      category    category,
      "window"    VARCHAR(20) NOT NULL DEFAULT '1h',
      score       DECIMAL(10,2) NOT NULL DEFAULT 0,
      delta       DECIMAL(6,2) NOT NULL DEFAULT 0,
      count       INTEGER NOT NULL DEFAULT 0,
      momentum    VARCHAR(20) NOT NULL DEFAULT 'steady',
      snapshot_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(tag, "window", snapshot_at)
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_trending_window ON trending_topics("window", score DESC, snapshot_at DESC)`)

  // ── source_suggestions ────────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS source_suggestions (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
      name        VARCHAR(255) NOT NULL,
      url         VARCHAR(512) NOT NULL,
      rss_url     VARCHAR(512),
      category    category NOT NULL DEFAULT 'other',
      reason      TEXT NOT NULL,
      status      VARCHAR(20) NOT NULL DEFAULT 'pending',
      reviewer_id UUID REFERENCES users(id) ON DELETE SET NULL,
      reviewed_at TIMESTAMPTZ,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_source_suggestions_status ON source_suggestions(status, created_at DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_source_suggestions_user   ON source_suggestions(user_id)`)

  // ── device_push_tokens ────────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS device_push_tokens (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token       VARCHAR(512) NOT NULL,
      platform    VARCHAR(20) NOT NULL DEFAULT 'expo',
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, token)
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_push_tokens(user_id) WHERE active = TRUE`)

  // ── search_analytics ──────────────────────────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS search_analytics (
      id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
      ts           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      query        TEXT        NOT NULL,
      search_type  VARCHAR(20) NOT NULL DEFAULT 'all',
      result_count INTEGER     NOT NULL DEFAULT 0,
      zero_results BOOLEAN     NOT NULL DEFAULT FALSE
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_search_analytics_ts   ON search_analytics(ts DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_search_analytics_type ON search_analytics(search_type, ts DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_search_analytics_zero ON search_analytics(zero_results, ts DESC) WHERE zero_results = TRUE`)

  // ── Functions & triggers (CREATE OR REPLACE — always safe to re-run) ─────
  await db.raw(`
    CREATE OR REPLACE FUNCTION update_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
    $$ LANGUAGE plpgsql
  `)

  // Create triggers only if they don't exist
  await db.raw(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'users_updated_at') THEN
      CREATE TRIGGER users_updated_at   BEFORE UPDATE ON users   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
  END $$`)
  await db.raw(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'posts_updated_at') THEN
      CREATE TRIGGER posts_updated_at   BEFORE UPDATE ON posts   FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
  END $$`)
  // signals uses 'last_updated' not 'updated_at' — drop the broken trigger if it exists
  await db.raw(`DROP TRIGGER IF EXISTS signals_updated_at ON signals`)
  await db.raw(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'sources_updated_at') THEN
      CREATE TRIGGER sources_updated_at BEFORE UPDATE ON sources FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    END IF;
  END $$`)

  await db.raw(`
    CREATE OR REPLACE FUNCTION update_follow_counts()
    RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        UPDATE users SET follower_count  = follower_count  + 1 WHERE id = NEW.following_id;
        UPDATE users SET following_count = following_count + 1 WHERE id = NEW.follower_id;
      ELSIF TG_OP = 'DELETE' THEN
        UPDATE users SET follower_count  = GREATEST(0, follower_count  - 1) WHERE id = OLD.following_id;
        UPDATE users SET following_count = GREATEST(0, following_count - 1) WHERE id = OLD.follower_id;
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `)
  await db.raw(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'follows_count_trigger') THEN
      CREATE TRIGGER follows_count_trigger
      AFTER INSERT OR DELETE ON follows
      FOR EACH ROW EXECUTE FUNCTION update_follow_counts();
    END IF;
  END $$`)

  await db.raw(`
    CREATE OR REPLACE FUNCTION update_like_count()
    RETURNS TRIGGER AS $$
    BEGIN
      IF TG_OP = 'INSERT' THEN
        UPDATE posts SET like_count = like_count + 1 WHERE id = NEW.post_id;
      ELSIF TG_OP = 'DELETE' THEN
        UPDATE posts SET like_count = GREATEST(0, like_count - 1) WHERE id = OLD.post_id;
      END IF;
      RETURN NULL;
    END;
    $$ LANGUAGE plpgsql
  `)
  await db.raw(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'likes_count_trigger') THEN
      CREATE TRIGGER likes_count_trigger
      AFTER INSERT OR DELETE ON likes
      FOR EACH ROW EXECUTE FUNCTION update_like_count();
    END IF;
  END $$`)

  // ── Seed default sources (skip duplicates) ────────────────────────────────
  await db.raw(`
    INSERT INTO sources (slug, name, url, tier, trust_score, language, country, categories, rss_feeds, scrape_interval)
    VALUES
      ('ap-news',    'AP News',       'https://apnews.com',         'wire',     0.97, 'en', 'US', '{breaking,geopolitics,economy}', '{https://feeds.apnews.com/rss/apf-topnews,https://feeds.apnews.com/rss/apf-intlnews}', 600),
      ('reuters',    'Reuters',       'https://reuters.com',        'wire',     0.96, 'en', 'GB', '{breaking,economy,geopolitics}', '{https://feeds.reuters.com/Reuters/worldNews,https://feeds.reuters.com/reuters/topNews}', 600),
      ('bbc-world',  'BBC World',     'https://bbc.com/news/world', 'wire',     0.95, 'en', 'GB', '{breaking,geopolitics,culture}', '{https://feeds.bbci.co.uk/news/world/rss.xml}', 600),
      ('al-jazeera', 'Al Jazeera',    'https://aljazeera.com',      'national', 0.88, 'en', 'QA', '{geopolitics,conflict,culture}', '{https://www.aljazeera.com/xml/rss/all.xml}', 900),
      ('guardian',   'The Guardian',  'https://theguardian.com',    'national', 0.87, 'en', 'GB', '{climate,science,geopolitics}',  '{https://www.theguardian.com/world/rss}', 900),
      ('who',        'World Health Org.', 'https://who.int',        'wire',     0.98, 'en', 'CH', '{health}',                       '{https://www.who.int/rss-feeds/news-english.xml}', 1800),
      ('usgs-quakes','USGS Earthquakes','https://earthquake.usgs.gov','wire',   0.99, 'en', 'US', '{disaster}',                     '{https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_day.atom}', 300),
      ('france24',   'France 24',     'https://france24.com/en',    'national', 0.88, 'en', 'FR', '{breaking,geopolitics,culture}', '{https://www.france24.com/en/rss}', 900),
      ('dw-world',   'Deutsche Welle','https://dw.com',             'national', 0.90, 'en', 'DE', '{geopolitics,economy,culture}',  '{https://rss.dw.com/rdf/rss-en-all}', 900),
      ('nasa-news',  'NASA',          'https://nasa.gov',           'wire',     0.99, 'en', 'US', '{science,space}',                '{https://www.nasa.gov/news-release/feed/}', 1800)
    ON CONFLICT (slug) DO NOTHING
  `)

  // ── Fix broken RSS feeds — runs on every deploy, safe to re-run ──────────
  // AP: apnews.com/rss returns 404; correct sub-domain is feeds.apnews.com
  await db.raw(`
    UPDATE sources
    SET rss_feeds = '{https://feeds.apnews.com/rss/apf-topnews,https://feeds.apnews.com/rss/apf-intlnews}',
        last_scraped = NULL,
        scrape_interval = 600
    WHERE slug = 'ap-news'
  `)
  // Reuters: feeds.reuters.com is unreachable (domain decommissioned) — clear RSS so scraper skips it
  await db.raw(`
    UPDATE sources
    SET rss_feeds = '{}',
        last_scraped = NULL
    WHERE slug = 'reuters'
  `)
  // BBC: ensure https (old seeds used http)
  await db.raw(`
    UPDATE sources
    SET rss_feeds = '{https://feeds.bbci.co.uk/news/world/rss.xml}',
        last_scraped = NULL
    WHERE slug = 'bbc-world'
  `)

  // ── Seed AI digest bot user ────────────────────────────────────────────────
  await db.raw(`
    INSERT INTO users (handle, display_name, account_type, verified, trust_score, bio)
    VALUES ('worldpulse_ai', 'WorldPulse AI Digest', 'ai', TRUE, 0.950,
            'Automated synthesis of verified global signals. Powered by open-source AI.')
    ON CONFLICT (handle) DO NOTHING
  `)

  // ── Onboarding fields (patch for existing DBs) ────────────────────────────
  await db.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarded  BOOLEAN NOT NULL DEFAULT FALSE`)
  await db.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS interests  TEXT[]  NOT NULL DEFAULT '{}'`)
  await db.raw(`ALTER TABLE users ADD COLUMN IF NOT EXISTS regions    TEXT[]  NOT NULL DEFAULT '{}'`)

  // ── signal_flags (community flagging) ────────────────────────────────────
  await db.raw(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS is_breaking BOOLEAN NOT NULL DEFAULT FALSE`)
  await db.raw(`ALTER TABLE signals ADD COLUMN IF NOT EXISTS community_flag_count INTEGER NOT NULL DEFAULT 0`)
  await db.raw(`
    CREATE TABLE IF NOT EXISTS signal_flags (
      id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
      signal_id   UUID NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
      user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
      ip_hash     VARCHAR(64),
      reason      VARCHAR(50) NOT NULL,
      notes       TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signal_flags_signal ON signal_flags(signal_id, created_at DESC)`)
  await db.raw(`CREATE UNIQUE INDEX IF NOT EXISTS idx_signal_flags_user_dedup ON signal_flags(signal_id, user_id) WHERE user_id IS NOT NULL`)

  // ── Performance indexes (Phase 6 — query optimization) ───────────────────
  //
  // idx_posts_feed: partial covering index for global feed.
  // Eliminates heap fetches for the very common deleted_at IS NULL + parent_id
  // IS NULL filter combo used by /feed/global and /feed/following.
  await db.raw(`
    CREATE INDEX IF NOT EXISTS idx_posts_feed
    ON posts(created_at DESC)
    WHERE deleted_at IS NULL AND parent_id IS NULL
  `)

  // idx_posts_author_feed: composite for /feed/following — avoids a full
  // posts scan when filtering by author_id on live top-level posts.
  await db.raw(`
    CREATE INDEX IF NOT EXISTS idx_posts_author_feed
    ON posts(author_id, created_at DESC)
    WHERE deleted_at IS NULL AND parent_id IS NULL
  `)

  // idx_posts_signal_active: used by GET /signals/:id/posts (top-level only).
  await db.raw(`
    CREATE INDEX IF NOT EXISTS idx_posts_signal_active
    ON posts(signal_id, created_at DESC)
    WHERE deleted_at IS NULL AND parent_id IS NULL
  `)

  // idx_signals_status_created: the existing idx_signals_status is a partial
  // index WHERE status = 'verified' only.  The list + stream endpoints also
  // query status IN ('verified','pending').  A full composite covers both.
  await db.raw(`
    CREATE INDEX IF NOT EXISTS idx_signals_status_created
    ON signals(status, created_at DESC)
  `)

  // idx_signals_map: partial index tuned for the /signals/map/points query.
  // Predicate matches the WHERE clause exactly so PG can skip the heap for
  // signals that have no location or are in a non-displayable status.
  await db.raw(`
    CREATE INDEX IF NOT EXISTS idx_signals_map
    ON signals(created_at DESC, category, severity)
    WHERE location IS NOT NULL AND (status = 'verified' OR status = 'pending')
  `)

  // idx_bookmarks_user: the bookmarks table had no index at all.
  await db.raw(`
    CREATE INDEX IF NOT EXISTS idx_bookmarks_user
    ON bookmarks(user_id, post_id)
  `)

  // idx_signals_tags_trgm: expression trgm index so that
  //   array_to_string(tags, ' ') ILIKE ?
  // uses a GIN bitmap scan instead of a seqscan.  Required by autocomplete.
  await db.raw(`
    CREATE OR REPLACE FUNCTION immutable_array_to_string(arr text[], sep text)
    RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS
    $fn$ SELECT array_to_string(arr, sep) $fn$
  `)
  await db.raw(`
    CREATE INDEX IF NOT EXISTS idx_signals_tags_trgm
    ON signals USING gin(immutable_array_to_string(tags, ' ') gin_trgm_ops)
  `)

  // ── Expanded source coverage (Phase 7 — closing Crucix feed gap) ──────────
  // Brings total active feeds from ~10 → 28+. All slugs use ON CONFLICT DO NOTHING
  // so this block is safe to re-run on every deploy.
  await db.raw(`
    INSERT INTO sources (slug, name, url, tier, trust_score, language, country, categories, rss_feeds, scrape_interval)
    VALUES
      -- Broadcasters / Wire
      ('sky-news',       'Sky News',                'https://news.sky.com',           'national', 0.88, 'en', 'GB', '{breaking,geopolitics,conflict}',  '{https://feeds.skynews.com/feeds/rss/world.xml}',                                        600),
      ('npr-world',      'NPR World',               'https://npr.org/sections/world',  'national', 0.91, 'en', 'US', '{geopolitics,culture,economy}',   '{https://feeds.npr.org/1004/rss.xml}',                                                   900),
      ('cbc-news',       'CBC News',                'https://cbc.ca/news',            'national', 0.90, 'en', 'CA', '{breaking,geopolitics,economy}',   '{https://www.cbc.ca/cmlink/rss-topstories}',                                             900),
      ('nhk-world',      'NHK World',               'https://www3.nhk.or.jp/nhkworld','national', 0.91, 'en', 'JP', '{geopolitics,economy,disaster}',   '{https://www3.nhk.or.jp/nhkworld/en/news/feeds/}',                                       900),
      ('euronews',       'Euronews',                'https://euronews.com',           'national', 0.85, 'en', 'FR', '{geopolitics,economy,culture}',    '{https://www.euronews.com/rss}',                                                         900),
      ('voa-news',       'Voice of America',        'https://voanews.com',            'national', 0.87, 'en', 'US', '{geopolitics,conflict,economy}',   '{https://www.voanews.com/rss?section=world-news}',                                       900),
      ('abc-australia',  'ABC Australia',           'https://abc.net.au/news',        'national', 0.88, 'en', 'AU', '{geopolitics,economy,climate}',    '{https://www.abc.net.au/news/feed/51120/rss.xml}',                                       900),
      ('trt-world',      'TRT World',               'https://trtworld.com',           'national', 0.82, 'en', 'TR', '{geopolitics,conflict,culture}',   '{https://www.trtworld.com/rss}',                                                         900),
      ('spiegel-intl',   'Der Spiegel International','https://spiegel.de/international','national',0.89,'en','DE', '{geopolitics,economy,culture}',    '{https://www.spiegel.de/international/index.rss}',                                       1200),
      ('rferl',          'Radio Free Europe/RL',    'https://rferl.org',              'national', 0.83, 'en', 'CZ', '{geopolitics,conflict,politics}',  '{https://www.rferl.org/api/zp-jqyhzpjeiq}',                                              900),
      ('dawn-pk',        'Dawn (Pakistan)',          'https://dawn.com',               'national', 0.83, 'en', 'PK', '{geopolitics,conflict,economy}',   '{https://www.dawn.com/feed}',                                                            1200),
      ('cna-world',      'Channel NewsAsia',        'https://channelnewsasia.com',    'national', 0.86, 'en', 'SG', '{geopolitics,economy,health}',     '{https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511}',   900),
      ('japan-times',    'Japan Times',             'https://japantimes.co.jp',       'national', 0.86, 'en', 'JP', '{geopolitics,economy,culture}',    '{https://www.japantimes.co.jp/feed/}',                                                   1200),
      -- Emergency / Disaster / Science
      ('gdacs',          'GDACS',                   'https://gdacs.org',              'wire',     0.97, 'en', 'XX', '{disaster}',                       '{https://www.gdacs.org/xml/rss.xml}',                                                    300),
      ('reliefweb',      'ReliefWeb / OCHA',        'https://reliefweb.int',          'wire',     0.95, 'en', 'XX', '{disaster,health,conflict}',       '{https://reliefweb.int/updates/rss.xml}',                                                600),
      ('emsc-quakes',    'EMSC Earthquakes',        'https://emsc-csem.org',          'wire',     0.99, 'en', 'XX', '{disaster}',                       '{https://www.emsc-csem.org/service/rss/rss.php}',                                        300),
      ('cdc-global',     'CDC Global Health',       'https://cdc.gov',                'wire',     0.98, 'en', 'US', '{health}',                         '{https://tools.cdc.gov/api/v2/resources/media/132608.rss}',                              1800),
      -- Investigative / OSINT
      ('bellingcat',     'Bellingcat',              'https://bellingcat.com',         'national', 0.88, 'en', 'GB', '{conflict,security,geopolitics}',  '{https://www.bellingcat.com/feed/}',                                                     1800),
      -- International organisations
      ('un-news',        'UN News',                 'https://news.un.org',            'wire',     0.95, 'en', 'XX', '{geopolitics,health,disaster}',    '{https://news.un.org/feed/subscribe/en/news/all/rss.xml}',                               900),
      ('swissinfo',      'SWI swissinfo.ch',        'https://swissinfo.ch',           'national', 0.87, 'en', 'CH', '{geopolitics,economy,culture}',    '{https://www.swissinfo.ch/eng/rss/Top_News_English}',                                    1200)
    ON CONFLICT (slug) DO NOTHING
  `)

  // ── Knowledge Graph: Entity Nodes + Edges ─────────────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS entity_nodes (
      id               TEXT PRIMARY KEY,
      type             TEXT NOT NULL,
      canonical_name   TEXT NOT NULL,
      aliases          TEXT[] DEFAULT '{}',
      first_seen       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      mention_count    INTEGER NOT NULL DEFAULT 1,
      signal_ids       TEXT[] DEFAULT '{}',
      metadata         JSONB DEFAULT '{}'
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_entity_nodes_type ON entity_nodes (type)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_entity_nodes_last_seen ON entity_nodes (last_seen DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_entity_nodes_mention_count ON entity_nodes (mention_count DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_entity_nodes_canonical ON entity_nodes (canonical_name)`)

  await db.raw(`
    CREATE TABLE IF NOT EXISTS entity_edges (
      id                 TEXT PRIMARY KEY,
      source_entity_id   TEXT NOT NULL REFERENCES entity_nodes(id) ON DELETE CASCADE,
      target_entity_id   TEXT NOT NULL REFERENCES entity_nodes(id) ON DELETE CASCADE,
      predicate          TEXT NOT NULL,
      weight             REAL NOT NULL DEFAULT 0.5,
      signal_ids         TEXT[] DEFAULT '{}',
      first_seen         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_seen          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_entity_edges_source ON entity_edges (source_entity_id)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_entity_edges_target ON entity_edges (target_entity_id)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_entity_edges_predicate ON entity_edges (predicate)`)

  // Fix: weight column was created as INTEGER in early deploys — must be REAL for decimal weights (0.0–1.0)
  await db.raw(`ALTER TABLE entity_edges ALTER COLUMN weight TYPE REAL`)

  // ─── Signal Baselines (Phase 1.6.1) ─────────────────────────────────────────
  // Daily signal counts by category × region × severity for rolling average
  // and z-score anomaly detection.

  await db.raw(`
    CREATE TABLE IF NOT EXISTS signal_baselines (
      id                 SERIAL PRIMARY KEY,
      date               DATE NOT NULL,
      category           TEXT NOT NULL,
      region             TEXT NOT NULL DEFAULT 'global',
      severity           TEXT NOT NULL DEFAULT 'all',
      signal_count       INTEGER NOT NULL DEFAULT 0,
      avg_reliability    REAL NOT NULL DEFAULT 0,
      corroborated_count INTEGER NOT NULL DEFAULT 0,
      day_of_week        SMALLINT NOT NULL DEFAULT 0,
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(date, category, region, severity)
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signal_baselines_date ON signal_baselines (date)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signal_baselines_category ON signal_baselines (category)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signal_baselines_category_region ON signal_baselines (category, region)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signal_baselines_dow ON signal_baselines (day_of_week)`)

  await db.raw(`
    CREATE TABLE IF NOT EXISTS signal_anomalies (
      id                 SERIAL PRIMARY KEY,
      date               DATE NOT NULL,
      category           TEXT NOT NULL,
      region             TEXT NOT NULL DEFAULT 'global',
      current_count      INTEGER NOT NULL,
      baseline_avg       REAL NOT NULL,
      baseline_stddev    REAL NOT NULL,
      z_score            REAL NOT NULL,
      direction          TEXT NOT NULL DEFAULT 'above',
      window             TEXT NOT NULL DEFAULT '30d',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signal_anomalies_date ON signal_anomalies (date)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signal_anomalies_category ON signal_anomalies (category)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signal_anomalies_z_score ON signal_anomalies (z_score DESC)`)

  // ── Event threads: add columns expected by event-threads.ts ─────────────
  // These were added to prod DB in prior sessions but never captured in migrations.
  await db.raw(`ALTER TABLE event_threads ADD COLUMN IF NOT EXISTS peak_severity VARCHAR(10) DEFAULT 'medium'`)
  await db.raw(`ALTER TABLE event_threads ADD COLUMN IF NOT EXISTS source_count INTEGER DEFAULT 0`)
  await db.raw(`ALTER TABLE event_threads ADD COLUMN IF NOT EXISTS avg_reliability REAL DEFAULT 0`)
  await db.raw(`ALTER TABLE event_threads ADD COLUMN IF NOT EXISTS severity_trajectory JSONB DEFAULT '[]'::jsonb`)
  await db.raw(`ALTER TABLE event_threads ADD COLUMN IF NOT EXISTS related_entities TEXT[] DEFAULT '{}'`)
  await db.raw(`ALTER TABLE event_threads ADD COLUMN IF NOT EXISTS cluster_id TEXT DEFAULT NULL`)
  await db.raw(`ALTER TABLE event_threads ADD COLUMN IF NOT EXISTS first_seen TIMESTAMPTZ DEFAULT NOW()`)
  await db.raw(`ALTER TABLE event_thread_signals ADD COLUMN IF NOT EXISTS role VARCHAR(20) DEFAULT 'member'`)

  // ── Semantic dedup: duplicate_of column on signals ─────────────────────
  await db.raw(`
    ALTER TABLE signals ADD COLUMN IF NOT EXISTS duplicate_of TEXT DEFAULT NULL
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_signals_duplicate_of ON signals (duplicate_of) WHERE duplicate_of IS NOT NULL`)

  // ── Feed quality scoring: source_quality table ─────────────────────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS source_quality (
      source_id          TEXT PRIMARY KEY,
      source_name        TEXT NOT NULL DEFAULT '',
      total_signals      INTEGER NOT NULL DEFAULT 0,
      avg_reliability    REAL NOT NULL DEFAULT 0,
      corroboration_rate REAL NOT NULL DEFAULT 0,
      avg_freshness_min  REAL NOT NULL DEFAULT 0,
      volume_7d          INTEGER NOT NULL DEFAULT 0,
      volume_30d         INTEGER NOT NULL DEFAULT 0,
      last_signal_at     TIMESTAMPTZ,
      quality_score      REAL NOT NULL DEFAULT 0,
      trend              TEXT NOT NULL DEFAULT 'stable',
      updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)

  // ── Event thread summaries column ──────────────────────────────────────
  await db.raw(`
    ALTER TABLE event_threads ADD COLUMN IF NOT EXISTS summary_generated_at TIMESTAMPTZ DEFAULT NULL
  `)

  // ── Correlation clusters table (Redis → PostgreSQL migration) ───────────
  await db.raw(`
    CREATE TABLE IF NOT EXISTS correlation_clusters (
      cluster_id        TEXT PRIMARY KEY,
      primary_signal_id UUID REFERENCES signals(id) ON DELETE SET NULL,
      signal_ids        TEXT[] NOT NULL DEFAULT '{}',
      categories        TEXT[] NOT NULL DEFAULT '{}',
      sources           TEXT[] NOT NULL DEFAULT '{}',
      severity          VARCHAR(20) DEFAULT 'medium',
      correlation_score REAL DEFAULT 0,
      signal_count      INT DEFAULT 0,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_correlation_clusters_created ON correlation_clusters(created_at DESC)`)
  await db.raw(`CREATE INDEX IF NOT EXISTS idx_correlation_clusters_score ON correlation_clusters(correlation_score DESC)`)

  console.log('✅  Migrations complete.')
}

run()
  .catch((err: unknown) => {
    console.error('❌  Migration failed:', err)
    process.exit(1)
  })
  .finally(() => db.destroy())
