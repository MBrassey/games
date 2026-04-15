-- Per-user achievement unlocks. The catalog (titles, descriptions, icons,
-- point values) is the game's own achievements.json, shipped in its repo
-- and mirrored into public/games/<slug>/achievements.json by build-games.mjs.
-- We only persist WHO unlocked WHAT and WHEN.
--
-- `points` is denormalized at unlock time: earned points should never
-- retroactively change if a game bumps the value later, and it lets the
-- leaderboard do a cheap SUM without cross-referencing a catalog table.
-- `meta` is free-form JSON for game-supplied extras (run id, seed, score, etc).

CREATE TABLE IF NOT EXISTS user_achievements (
  user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_slug        TEXT NOT NULL,
  achievement_key  TEXT NOT NULL,
  unlocked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  points           INTEGER NOT NULL DEFAULT 0,
  meta             JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (user_id, game_slug, achievement_key)
);

CREATE INDEX IF NOT EXISTS idx_user_achievements_game_key
  ON user_achievements (game_slug, achievement_key);

CREATE INDEX IF NOT EXISTS idx_user_achievements_user_unlocked
  ON user_achievements (user_id, unlocked_at DESC);
