-- Auth.js v5 Postgres adapter schema
-- Ref: https://authjs.dev/getting-started/adapters/pg

CREATE TABLE IF NOT EXISTS verification_token (
  identifier TEXT NOT NULL,
  expires TIMESTAMPTZ NOT NULL,
  token TEXT NOT NULL,
  PRIMARY KEY (identifier, token)
);

CREATE TABLE IF NOT EXISTS accounts (
  id SERIAL,
  "userId" INTEGER NOT NULL,
  type VARCHAR(255) NOT NULL,
  provider VARCHAR(255) NOT NULL,
  "providerAccountId" VARCHAR(255) NOT NULL,
  refresh_token TEXT,
  access_token TEXT,
  expires_at BIGINT,
  id_token TEXT,
  scope TEXT,
  session_state TEXT,
  token_type TEXT,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id SERIAL,
  "userId" INTEGER NOT NULL,
  expires TIMESTAMPTZ NOT NULL,
  "sessionToken" VARCHAR(255) NOT NULL,
  PRIMARY KEY (id)
);

CREATE TABLE IF NOT EXISTS users (
  id SERIAL,
  name VARCHAR(255),
  email VARCHAR(255),
  "emailVerified" TIMESTAMPTZ,
  image TEXT,
  PRIMARY KEY (id)
);

-- Portal-specific tables below

-- Human-readable handle derived from GitHub; editable later.
CREATE TABLE IF NOT EXISTS user_profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  handle TEXT UNIQUE NOT NULL,
  bio TEXT,
  accent_color TEXT DEFAULT '#8a4fff',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_preferences (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cross-device game saves. One row per (user, game, relative filesystem path).
-- `data` is the raw file contents encoded as base64 text; `meta` can hold
-- version/mtime/etc. so games can detect stale saves across devices.
CREATE TABLE IF NOT EXISTS game_saves (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_slug TEXT NOT NULL,
  path TEXT NOT NULL,
  data TEXT NOT NULL,
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game_slug, path)
);

CREATE INDEX IF NOT EXISTS idx_game_saves_user_game
  ON game_saves (user_id, game_slug);

-- Chat history. Kept long enough for backscroll; old rows can be archived later.
CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGSERIAL PRIMARY KEY,
  channel TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_chat_messages_channel_time
  ON chat_messages (channel, created_at DESC);

-- Recent presence heartbeats; authoritative source is KV, this is the
-- persisted fallback / daily-active-users view.
CREATE TABLE IF NOT EXISTS chat_presence (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  current_channel TEXT,
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Optional game registry in-db so admins can toggle games without redeploy.
-- Front-end source of truth is src/lib/games.ts for now.
CREATE TABLE IF NOT EXISTS game_registry (
  slug TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  version TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  manifest JSONB NOT NULL DEFAULT '{}'::jsonb
);
