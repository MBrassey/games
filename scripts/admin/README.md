# Admin one-shots

Manual tools. Nothing in this repo auto-invokes them.

| Script | Purpose |
| --- | --- |
| `reset-stats.mjs` | Wipe `game_sessions` (playtime telemetry) for all users. Leaves `game_saves` and `chat_messages` untouched. Destructive but scoped. |

**User-specific save-seeding scripts were deleted** on 2026-04-14. Real
user progress now lives in the `game_saves` table and is advanced solely
by gameplay through the runtime bridge. Never reintroduce a script that
writes rows into `game_saves` keyed on a specific username — it's a
footgun that can erase players' real progress with a single misclick.

If you ever genuinely need to inspect save data, run an ad-hoc SELECT
via `psql` or a throwaway read-only node script. Don't commit it.
