-- Playtime tracking. A session is a continuous run of heartbeats from the
-- game runner. If a heartbeat arrives and the current session's
-- last_heartbeat is within 2 minutes, we bump it; otherwise we start a new
-- session row. Playtime is summed as (last_heartbeat - started_at) across
-- all sessions.

CREATE TABLE IF NOT EXISTS game_sessions (
  id BIGSERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_slug TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_heartbeat TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_game_sessions_user_game
  ON game_sessions (user_id, game_slug, last_heartbeat DESC);

CREATE INDEX IF NOT EXISTS idx_game_sessions_started
  ON game_sessions (started_at);
