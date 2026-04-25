-- Multi-user "net" layer for LÖVE2D games hosted on the portal.
--
-- Three concepts:
--   * net_rooms          a named, joinable space scoped to one game.
--                        Rooms keep a small JSONB blob of persistent state
--                        so reconnects can resync without replaying every
--                        event since the world began.
--   * net_room_members   active participants. last_seen_at advances on
--                        every heartbeat; the SSE stream considers a
--                        member "online" while last_seen_at < 60s ago.
--                        Stale rows aren't pruned eagerly — they just stop
--                        showing up in the live roster — and disappear on
--                        explicit leave or room close.
--   * net_room_events    append-only event log. Acts as the source of
--                        truth and the Postgres-fallback delivery channel
--                        when KV is unavailable / rate-limited (mirrors
--                        the chat tier in src/app/api/chat/stream).

CREATE TABLE IF NOT EXISTS net_rooms (
  id            BIGSERIAL PRIMARY KEY,
  game_slug     TEXT NOT NULL,
  code          TEXT NOT NULL,
  name          TEXT NOT NULL,
  visibility    TEXT NOT NULL DEFAULT 'public'
                  CHECK (visibility IN ('public','unlisted','private')),
  capacity      INTEGER NOT NULL DEFAULT 8 CHECK (capacity BETWEEN 1 AND 64),
  owner_id      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  state         JSONB NOT NULL DEFAULT '{}'::jsonb,
  state_version BIGINT NOT NULL DEFAULT 0,
  closed_at     TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (game_slug, code)
);

CREATE INDEX IF NOT EXISTS idx_net_rooms_game_visibility
  ON net_rooms (game_slug, visibility, updated_at DESC)
  WHERE closed_at IS NULL;

CREATE TABLE IF NOT EXISTS net_room_members (
  room_id      BIGINT NOT NULL REFERENCES net_rooms(id) ON DELETE CASCADE,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_net_room_members_seen
  ON net_room_members (room_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_net_room_members_user
  ON net_room_members (user_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS net_room_events (
  id         BIGSERIAL PRIMARY KEY,
  room_id    BIGINT NOT NULL REFERENCES net_rooms(id) ON DELETE CASCADE,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verb       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_net_room_events_room_id
  ON net_room_events (room_id, id DESC);
