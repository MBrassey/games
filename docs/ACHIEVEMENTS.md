# Achievements — game author spec

This is the contract a LÖVE2D game ships to opt into the
[games.brassey.io](https://games.brassey.io) achievement system. Two
pieces on the game side:

1. A declarative catalog file: **`achievements.json`** at your repo root.
2. A runtime call to unlock: a one-line `print(...)` from Lua.

Nothing else. No HTTP, no auth, no emscripten hooks.

---

## 1. `achievements.json`

Drop this at the root of your game repo — same directory as `main.lua`.

The portal's build pipeline mirrors it to
`public/games/<slug>/achievements.json` every deploy. The game also
ships it inside the `.love` bundle so Lua code can read it directly.

### Schema

```json
{
  "version": 1,
  "achievements": [
    {
      "key": "first_blood",
      "title": "First Blood",
      "description": "Defeat your first enemy.",
      "glyph": "🗡",
      "points": 10,
      "rarity": "common",
      "category": "combat",
      "hidden": false
    }
  ]
}
```

| Field         | Type    | Required | Notes                                                                                                              |
|---------------|---------|----------|--------------------------------------------------------------------------------------------------------------------|
| `version`     | int     | yes      | Must be `1`. Reserved for future breaking changes.                                                                 |
| `key`         | string  | yes      | Stable id. `^[a-z0-9_]+$`, max 64 chars. **Never change after a release** — unlocks reference this forever.        |
| `title`       | string  | yes      | Display name. Max 120 chars.                                                                                       |
| `description` | string  | no       | One-sentence unlock condition. Max 500 chars.                                                                      |
| `glyph`       | string  | no       | 1–8 char emoji or symbol shown when there's no icon image.                                                         |
| `icon`        | string  | no       | Relative path to an image under `achievements_icons/` in the repo. Whole dir gets mirrored to `/games/<slug>/`.     |
| `points`      | int     | no       | 0–1000. Default 10. Feeds into the site-wide leaderboard total.                                                    |
| `rarity`      | string  | no       | `common` \| `uncommon` \| `rare` \| `legendary`. Visual accent only.                                                |
| `category`    | string  | no       | Free-form grouping label (e.g. `"combat"`, `"exploration"`). Max 40 chars.                                         |
| `hidden`      | bool    | no       | If `true`, the portal renders the title/description as `???` until the user unlocks it.                            |

### Rules the portal enforces

- **Unique `key` per file.** Duplicates reject the whole catalog.
- **Unknown keys can't be unlocked.** The unlock API rejects anything the
  catalog doesn't list — so you can't award an achievement you haven't
  declared first.
- **Points are snapshotted at unlock time.** If you later bump a
  `points` value, existing unlocks keep their original value. New
  unlocks pick up the new value.
- **Catalog changes ship on deploy.** The portal rebuilds whenever this
  repo advances past the last-deployed commit (within ~10 min).

---

## 2. Unlocking from Lua

To unlock an achievement, emit a single `print` line with the magic
prefix `[[LOVEWEB_ACH]]`:

```lua
-- Minimal
print("[[LOVEWEB_ACH]]unlock first_blood")

-- With optional structured metadata (JSON object, single line)
print(string.format(
  "[[LOVEWEB_ACH]]unlock boss_slain_cthulhu %s",
  json.encode({ run = runId, score = finalScore, seed = seed })
))
```

The runtime's stdout hook intercepts the line, strips it from the log
stream, and POSTs to `/api/achievements/unlock` with the signed-in
user's session. The server validates the key against your catalog,
writes to the DB, and re-pushes the full unlock state back into the
running game (see §3).

### Idempotence

Unlocks are idempotent. Calling unlock for the same `key` twice is a
no-op after the first — the `unlocked_at` timestamp never moves. Safe
to call on every "boss died" event without dedup logic.

### Rate limits

None currently, but keep it reasonable: one unlock per achievement,
one postMessage per event. Don't emit unlocks in a tight loop.

---

## 3. Reading current state from Lua

The portal pre-populates a metadata file in the LÖVE save directory
**before** `main.lua` runs, so you can hydrate UI at startup:

```
<save-dir>/__loveweb__/achievements.json
```

```json
{
  "version": 1,
  "unlocks": [
    { "key": "first_blood",  "unlockedAt": "2026-04-15T03:21:00Z", "points": 10 },
    { "key": "boss_slain_cthulhu", "unlockedAt": "2026-04-15T04:02:11Z", "points": 50 }
  ]
}
```

Read it with `love.filesystem`:

```lua
local function loadPortalAchievements()
  if not love.filesystem.getInfo("__loveweb__/achievements.json") then
    return {}  -- standalone run, or no unlocks yet
  end
  local raw = love.filesystem.read("__loveweb__/achievements.json")
  local ok, data = pcall(json.decode, raw)
  if not ok or type(data) ~= "table" then return {} end
  local byKey = {}
  for _, u in ipairs(data.unlocks or {}) do byKey[u.key] = u end
  return byKey
end
```

The file also refreshes live: whenever a new unlock lands, the runtime
rewrites this file so subsequent reads see it. If your game always
reads fresh at scene load, you'll catch mid-session updates for free.

### What if the file's missing?

It will be missing if:
- The game is running outside the portal (e.g. native desktop).
- The user isn't signed in to the portal.
- The portal failed to fetch state (transient; catalog keys still work).

Treat this as "no unlocks yet" — never a hard failure.

---

## 4. Icons (optional)

Ship PNGs next to `achievements.json`:

```
my-game-repo/
├─ main.lua
├─ achievements.json
└─ achievements_icons/
   ├─ first_blood.png
   ├─ boss_slain_cthulhu.png
   └─ ...
```

Reference them by relative path in the catalog:

```json
{ "key": "first_blood", "title": "First Blood", "icon": "achievements_icons/first_blood.png" }
```

The build mirrors the entire `achievements_icons/` dir to
`public/games/<slug>/achievements_icons/`, so the portal renders
`/games/<slug>/achievements_icons/first_blood.png`.

Recommend: 64×64 square PNGs, transparent background, readable at 32px.

---

## 5. End-to-end checklist

Shipping achievements in a new game or adding to an existing one:

- [ ] Add `achievements.json` at repo root with `version: 1` and at
      least one entry. Keys locked in forever.
- [ ] (Optional) Add `achievements_icons/*.png` next to it.
- [ ] Wire `print("[[LOVEWEB_ACH]]unlock <key>")` into your game's
      unlock-trigger points. One line per achievement.
- [ ] (Optional) Read `__loveweb__/achievements.json` at game start to
      gray-out already-earned entries in your in-game UI.
- [ ] Commit and push `main`. The portal redeploys within ~10 min
      and surfaces the catalog on every player's stats page.

That's it. The portal handles everything else:

- Catalog rendering on `/stats` and `/u/<handle>` profile pages
- Lock/unlock state, dates, rarity, points
- Leaderboard column showing achievement count + points
- Hidden achievement obfuscation
- Idempotent, authenticated unlock persistence
