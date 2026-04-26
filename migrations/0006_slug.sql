-- Slug-scoped persistence for the multi-user net layer. Three things:
--
--   * net_slug_state         per-game JSONB blob with optimistic-CAS
--                            via state_version. Lets a game host a
--                            leaderboard / scheduled surge / world flag /
--                            "all-time blocks found" counter without
--                            coordinating any canonical room.
--   * net_slug_events        slug-wide event log. Mirrors a subset of
--                            verbs from net_room_events (the "global
--                            ticker" verbs: stats / block / halving /
--                            build / wave / flag / achievement) plus
--                            anything sent through the explicit
--                            broadcast endpoint. Same id-watermark
--                            tailing pattern as net_room_events.
--   * net_room_events.target an optional user_id filter so a sender
--                            can address a single peer instead of
--                            everyone in the room. Stream routes
--                            silently drop events whose target ≠ self.

CREATE TABLE IF NOT EXISTS net_slug_state (
  game_slug     TEXT PRIMARY KEY,
  state         JSONB NOT NULL DEFAULT '{}'::jsonb,
  state_version BIGINT NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS net_slug_events (
  id         BIGSERIAL PRIMARY KEY,
  game_slug  TEXT NOT NULL,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verb       TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_net_slug_events_game_id
  ON net_slug_events (game_slug, id DESC);

ALTER TABLE net_room_events
  ADD COLUMN IF NOT EXISTS target_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_net_room_events_target
  ON net_room_events (target_user_id, id DESC)
  WHERE target_user_id IS NOT NULL;
