# Integration Guide — building LÖVE2D games for games.brassey.io

Audience: anyone (human or AI agent) building a LÖVE2D game that targets
[games.brassey.io](https://games.brassey.io). Follow this guide and your
game will run cleanly inside the portal with zero portal-side code
changes: cross-device save sync, achievements, playtime tracking, and
leaderboard integration all come for free.

**TL;DR contract** — stick to these and you are integrated:

1. **Pure LÖVE 11.x targeting Lua 5.1.** No LuaJIT-only features.
2. **State lives in `love.filesystem`** (the save dir). Nothing outside.
3. **Render into a 16:9 canvas** and scale to whatever size LÖVE gives
   you — the iframe is fixed-aspect but width-variable.
4. **Declare achievements** in `achievements.json` at your repo root,
   unlock them with `print("[[LOVEWEB_ACH]]unlock <key>")`.
5. **Don't write to `__loveweb__/`** — that path is reserved for
   portal-managed metadata.
6. **Don't use threads, sockets, or video.** `love.filesystem`,
   `love.graphics`, `love.audio`, `love.keyboard`, `love.mouse`,
   `love.physics`, `love.math`, and `love.timer` are all fine.
7. **Repo must be public on GitHub.** The portal clones fresh on every
   deploy; private repos and anything not reachable by
   `git clone https://github.com/…` won't build.

The rest of this guide is the "why" and the "how" for each bullet, plus
a sharp-edges list and a copy-paste starter skeleton.

---

## Contents

1. [Repository layout](#repository-layout)
2. [Target runtime](#target-runtime)
3. [`conf.lua`](#conflua)
4. [`main.lua` — boot order and callbacks](#mainlua--boot-order-and-callbacks)
5. [Rendering — canvas sizing and scaling](#rendering--canvas-sizing-and-scaling)
6. [Input](#input)
7. [Audio](#audio)
8. [Filesystem and save state](#filesystem-and-save-state)
9. [Reserved paths](#reserved-paths)
10. [Player identity](#player-identity)
11. [Networking, threads, video](#networking-threads-video)
12. [Achievements](#achievements)
13. [Bridge protocol reference](#bridge-protocol-reference)
14. [Debugging — getting logs out of the iframe](#debugging--getting-logs-out-of-the-iframe)
15. [Local development loop](#local-development-loop)
16. [Smoke testing](#smoke-testing)
17. [Getting listed on the portal](#getting-listed-on-the-portal)
18. [Upstream auto-deploy](#upstream-auto-deploy)
19. [Starter skeleton](#starter-skeleton)
20. [Shipping checklist](#shipping-checklist)
21. [Pitfalls & fixes](#pitfalls--fixes)

---

## Repository layout

One GitHub repo per game. Canonical layout:

```
<your-game-repo>/
├── main.lua                       ◀ entry point (mandatory)
├── conf.lua                       ◀ LÖVE config (strongly recommended)
├── achievements.json              ◀ optional — enables achievements
├── achievements_icons/            ◀ optional — icon images for achievements
│   └── first_blood.png
├── README.md                      ◀ describe your game + controls + license
├── LICENSE                        ◀ any OSI / CC license (the game stays yours)
│
├── assets/                        organize however you like; just reference
│   ├── images/                    with `love.graphics.newImage("assets/…")`
│   ├── sfx/                       etc.
│   └── music/
│
└── src/                           your Lua modules, whatever structure you prefer
    ├── player.lua
    ├── enemies/
    └── …
```

Rules the portal enforces:

- `main.lua` **must** sit at the repo root (or at `subdir` if you override
  it in the portal's `src/lib/games.ts` entry).
- The `conf.lua`, if present, must sit next to `main.lua`.
- The repo must be **public** on GitHub — the build pipeline does
  `git clone --depth 1` over HTTPS. No SSH deploy keys, no tokens.
- Everything under the repo root gets packed into the `.love` bundle and
  shipped to the browser. Keep the repo lean; avoid committing large
  binaries (>10 MB per file, >50 MB total is a soft ceiling — anything
  larger will make first-load slow even over fast connections).

---

## Target runtime

You are shipping to **[love.js](https://github.com/Davidobot/love.js)**,
which compiles LÖVE 11.x to WebAssembly using plain **Lua 5.1** (not
LuaJIT). This is the single biggest source of drift between "runs fine
on desktop" and "breaks on the portal."

### Lua version — 5.1, not LuaJIT

Features that **do not exist** in Lua 5.1 and that love.js cannot
provide:

| Feature                        | Status    | Notes                                        |
|--------------------------------|-----------|----------------------------------------------|
| `goto` + `::label::`           | **auto-patched** | Portal build rewrites to `repeat…until true`. Safe to use.  |
| `bit` / `bit.band` / etc.      | ❌ missing | Use `bit32` (not in 5.1 either — bundle a pure-Lua shim). |
| `ffi` / LuaJIT FFI             | ❌ missing | No WASM-callable FFI. Don't use.              |
| `__gc` metamethod on tables    | ❌ no-op   | Only works on userdata in 5.1.                |
| Integer/float split (5.3+)     | ❌ missing | Numbers are all double-precision.             |
| `//` integer division (5.3+)   | ❌ missing | Use `math.floor(a/b)`.                        |
| `~=` is fine                   | ✅         |                                                |
| `#<table>` on sparse tables    | ⚠ undefined | Works but results are implementation-dependent. |
| `string.pack` / `string.unpack`| ❌ missing | Write your own if you need binary framing.    |
| `table.move`                   | ❌ missing | Replace with a loop.                          |
| `table.unpack`                 | ❌ use `unpack` | The 5.1 name is `unpack`, not `table.unpack`. |

If your code works in **desktop LÖVE with LuaJIT**, run it once with
`lua5.1 -l luac` or a 5.1 interpreter to catch syntax issues.
LÖVE 12 (not yet used here) unifies this — stick to 5.1-safe syntax and
you are forward-compatible with LÖVE 12 too.

### LÖVE modules — what works, what doesn't

| Module                       | Status | Notes                                                 |
|------------------------------|--------|-------------------------------------------------------|
| `love.graphics`              | ✅     | Full. Canvases, shaders, fonts, images, quads.        |
| `love.audio`                 | ✅     | Subject to browser autoplay rules (see below).        |
| `love.keyboard`              | ✅     |                                                       |
| `love.mouse`                 | ✅     | Pointer lock works in fullscreen; see input notes.    |
| `love.touch`                 | ✅     | Mobile browsers.                                      |
| `love.joystick` / `love.gamepad` | ✅ | Chrome/Edge/Firefox gamepad API. Safari is spotty.    |
| `love.math`                  | ✅     |                                                       |
| `love.timer`                 | ✅     |                                                       |
| `love.physics`               | ✅     | Box2D, full.                                          |
| `love.filesystem`            | ✅     | **Cloud-synced** — see below.                          |
| `love.event`                 | ✅     |                                                       |
| `love.window`                | ⚠      | Works, but the iframe controls actual sizing. Don't try to resize. |
| `love.system`                | ⚠      | `getOS()` returns "Web"; `openURL()` is sandbox-blocked. |
| `love.thread`                | ❌ avoid | Not reliable under emscripten; use coroutines.        |
| `love.video`                 | ❌ avoid | Theora/OGV pipeline doesn't ship in love.js.          |
| `love.image` (decoders)      | ✅     | PNG, JPG, DDS. No EXR.                                |
| `love.sound` / `love.audio` decoders | ✅ | OGG Vorbis, WAV. MP3 works but prefer OGG.      |

TCP/UDP sockets: **no LuaSocket** ships with love.js. If you need
network play, that's out of scope for this portal's shared runtime —
you'd have to host a game-specific socket server and your Lua code
would need an HTTP polling fallback. The portal intentionally doesn't
solve this in v1.

---

## `conf.lua`

Minimal recommended `conf.lua`:

```lua
function love.conf(t)
  t.identity = "your-game"        -- save dir name. Keep stable forever.
  t.version  = "11.5"             -- target LÖVE 11.5
  t.console  = false              -- no OS console in a browser iframe

  t.window.title       = "Your Game"
  t.window.width       = 1920
  t.window.height      = 1080     -- any 16:9 pair. Portal scales to fit.
  t.window.resizable   = false    -- iframe controls real size
  t.window.vsync       = 1
  t.window.msaa        = 0        -- msaa>0 can break under some WebGL drivers
  t.window.highdpi     = true     -- let love.js pick DPR; looks sharper

  -- Drop modules you don't use so WASM init is faster.
  t.modules.thread = false        -- never reliable under love.js
  t.modules.video  = false        -- unsupported
  -- Keep the rest at default (true).
end
```

**`t.identity` is load-bearing.** It's baked into the save directory
path (`/home/web_user/love/<identity>/`). Change it after shipping and
every player's saves look empty to the game. Pick once, commit.
Recommended: use the same slug the portal uses for your game entry.

---

## Clean exit — `love.event.quit()`

Calling `love.event.quit()` from Lua is a **first-class clean-exit
signal** to the portal, not just an internal loop break. The portal:

1. Detects the exit via emscripten's `Module.quit` / `onExit` hooks
   (the runtime shell wires all three paths, so any love.js build
   version works).
2. Plays a short confirm chime.
3. Shows a brief "session :: ended" overlay over the canvas.
4. Router-pushes the player back to the library (`/`) automatically
   after ~1.4 s.

This means any in-game "quit to main menu" or "exit" button that
calls `love.event.quit()` just works on the portal — the player lands
back at the library with a clean UX. No postMessage plumbing
required.

An always-visible escape hatch is also rendered by the portal over
every game frame (a small floating "↩ exit" handle in the top-right
of the canvas plus a full "exit game" button in the status bar
below), so the player is never stranded even if the Lua runtime
itself has frozen.

## `main.lua` — boot order and callbacks

Standard LÖVE lifecycle applies:

```lua
function love.load()
  -- Called once after the filesystem is ready.
  -- BY THIS POINT: cloud saves have been pre-populated into MEMFS
  -- AND __loveweb__/achievements.json is already written.
  -- It is safe to read both here.
end

function love.update(dt) end
function love.draw() end

function love.keypressed(key, scancode, isrepeat) end
function love.mousepressed(x, y, button, istouch, presses) end
function love.resize(w, h)
  -- Fires when the parent page resizes. Keep your canvas logic
  -- responsive to whatever w/h you receive. Viewport can be as
  -- narrow as ~600px on mobile.
end

function love.focus(hasFocus)
  -- Fires when the user switches tabs or clicks outside the iframe.
  -- Respect it: pause audio/gameplay on !hasFocus.
end

function love.quit()
  -- Fires on browser navigation. `love.filesystem` writes you make
  -- here are still captured by the save-sync beforeunload flush
  -- before the iframe is torn down.
end
```

**Important boot-order fact:** the portal pre-populates both cloud
saves and the achievements metadata file *before* `love.load()` runs.
You can read `love.filesystem.getInfo(...)` on any of your own save
files, or on `__loveweb__/achievements.json`, inside `love.load` and
the data will already be there. No need to wait, no need to poll.

---

## Rendering — canvas sizing and scaling

The portal embeds your game in an `<iframe>` with `aspect-ratio: 16/9`
and `width: min(100%, (100vh - 200px) * 16 / 9)`. The iframe's own
canvas is then sized by `love.js` to match the iframe dimensions.

Concretely: you'll be rendering at anything from ~600×340 (narrow
mobile) to ~1920×1080 (desktop widescreen). **Design for 1920×1080 as
your logical resolution, then scale.**

### Frame backlight

The iframe automatically gets a CRT-bloom backlight tinted by your
game's `accentColor` (from the portal's `src/lib/games.ts` entry) —
a breathing radial glow behind the frame plus a layered box-shadow
rim. Nothing to wire up on the game side; just pick a nice accent
color in your portal-registration PR and your game inherits the
treatment.

Canonical pattern — render the world to an offscreen canvas at your
logical resolution, then blit with uniform scaling:

```lua
local DESIGN_W, DESIGN_H = 1920, 1080
local world

function love.load()
  world = love.graphics.newCanvas(DESIGN_W, DESIGN_H)
end

function love.draw()
  love.graphics.setCanvas(world)
  love.graphics.clear(0, 0, 0, 1)
  drawScene()                      -- all gameplay draw calls in design coords
  love.graphics.setCanvas()

  local w, h = love.graphics.getDimensions()
  local scale = math.min(w / DESIGN_W, h / DESIGN_H)
  local dx = (w - DESIGN_W * scale) * 0.5
  local dy = (h - DESIGN_H * scale) * 0.5
  love.graphics.draw(world, dx, dy, 0, scale, scale)
end
```

Mouse coords — if you use the above, remap them:

```lua
local function mouseToWorld(mx, my)
  local w, h = love.graphics.getDimensions()
  local scale = math.min(w / DESIGN_W, h / DESIGN_H)
  local dx = (w - DESIGN_W * scale) * 0.5
  local dy = (h - DESIGN_H * scale) * 0.5
  return (mx - dx) / scale, (my - dy) / scale
end
```

Font rendering: the portal runtime sets `image-rendering: auto` on the
canvas (not `pixelated`) so vector / TTF fonts scale smoothly. If you
want pixel-perfect bitmap fonts, render them to a canvas at integer
scale — never rely on `image-rendering: pixelated` in the iframe.

---

## Input

### Keyboard

Normal LÖVE keyboard callbacks work. The portal's outer page swallows
browser default behavior for space, arrow keys, and backspace inside
the iframe via `preventDefault` — so pressing space won't scroll the
page behind you.

### Mouse

Three things to be aware of:

1. **Side buttons (button 3 and 4) never reach your game.** The portal
   blocks `mousedown`/`mouseup`/`auxclick` for those buttons on both
   the parent page and the iframe, plus pushes an extra history entry
   so mouse-back doesn't navigate out of the game mid-play. Don't bind
   gameplay to buttons 3 or 4.
2. **Pointer lock** works only while the canvas is focused. Use
   `love.mouse.setRelativeMode(true)` for FPS-style capture.
3. **Right-click** calls `event.preventDefault()` at the HTML level so
   the browser context menu never appears. You still get
   `love.mousepressed` with `button == 2`.

### Gamepad

`love.joystick` and `love.gamepad` work via the browser Gamepad API.
The user must **press a button on the gamepad after page load** to
"wake it up" (browser security rule). No way around it. Your best bet:
show a prompt on screen when gameplay starts that says "press any
button to connect controller" and wait for the first
`love.joystickadded`.

### Focus traps

When the iframe loses focus (user tabs away, clicks on the chat
drawer), LÖVE emits `love.focus(false)`. **Pause gameplay.** Do not
keep simulating at full speed; it wastes battery and the player will
be frustrated when they return to a dead-or-worse game state.

---

## Audio

Browsers require a user gesture before audio plays. The portal wires
up global click/keydown listeners to unlock audio on first gesture;
your game's `love.audio` calls will just work from the user's first
interaction onward.

Gotchas specific to the web target:

- **Don't pre-load huge OGG streams.** Every sound you `love.audio.newSource("…", "static")`
  at `love.load` goes into the WASM heap. 10 MB of music = a 10 MB
  stall on first boot. Use `"stream"` mode for music.
- **MP3 works in Chromium but not reliably in Firefox/WebKit.** Prefer
  OGG Vorbis for full compatibility.
- **Don't call `love.audio.stop()` in a tight loop** — some browsers
  GC audio contexts lazily.
- **Procedural / runtime-synthesized audio** via
  `love.audio.newQueueableSource` works — the portal's own UI uses Web
  Audio synths exactly like this.

---

## Filesystem and save state

`love.filesystem.*` is the only filesystem API you should use. Under
the hood in the portal:

- The save directory (`love.filesystem.getSaveDirectory()`) maps to
  `/home/web_user/love/<identity>/` in an in-memory filesystem.
- Every **change** (any file mtime bump) is posted to the parent page
  and persisted to Postgres as base64 text, keyed by
  `(user_id, game_slug, path)`.
- On next boot **on any device the same user is signed in on**, the
  save files are pre-populated back into MEMFS **before** `love.load`
  runs.

So: **anything you write via `love.filesystem.write` is cloud-synced
across devices, automatically, with zero code on your end.** Same for
`love.filesystem.createDirectory`, `love.filesystem.remove`,
`love.filesystem.append`.

Rules:

- Stay under ~4 MB per file (hard server cap on `game_saves.data`).
- Don't write hundreds of tiny files per second; the sync loop runs on
  a 2-second poll and deduplicates, but you'll still generate DB churn.
  Prefer one consolidated `save.json` over per-entity files.
- If a user isn't signed in, `love.filesystem` still works — it's just
  MEMFS-only and evaporates on tab close. Treat "not signed in" as the
  same as "started a fresh profile."

Reading: `love.filesystem.read`, `getInfo`, `lines`, etc. — all work
identically to desktop LÖVE.

---

## Reserved paths

The portal writes to one reserved subtree in your save dir:

```
<save-dir>/__loveweb__/
└── achievements.json      ← your current unlock state, refreshed live
```

**Do not write into `__loveweb__/`.** The portal's save-watch loop
explicitly skips this subtree so that portal-managed files don't
round-trip into the DB. But if your game writes something under
`__loveweb__/`, it will never sync and will disappear on next boot
when the portal overwrites the directory. Use any other path for
your own state.

Conventional-but-unreserved names to *also* avoid, so you don't
accidentally collide with a future portal feature:

- `__loveweb__/` (reserved now)
- `__portal_*` (reserved for future use)

Everything else is yours.

---

## Player identity

Your game runs in an iframe. **It cannot see the portal user's
numeric ID or GitHub handle directly.** Intentional — saves and
achievements are bound to the session cookie on the portal's side, and
the game never handles auth.

Practical consequence: if you want to show "Welcome back, <name>" in
your own UI, you can't read it from the portal. Either:

- Ask the player for a display name in-game and store it in your save
  files (standard approach — works the same on desktop).
- Don't bother. Save files are already per-user, so "your save" is
  the right concept.

If you really need a stable "this is the same user" identifier across
sessions, write a random UUID to your save dir on first boot. It'll be
cloud-synced with the rest of their save.

---

## Networking, threads, video

Three big "don't":

1. **No network sockets.** LuaSocket isn't bundled. If your design
   needs online play, you'll need to host a dedicated server and use
   `love.data` + a plain XHR/WebSocket bridge via the runtime — but
   the portal's built-in bridge doesn't provide one, so it's all
   custom infrastructure. Out of scope for single-player and hot-seat
   coop.
2. **No `love.thread`.** Coroutines (`coroutine.create/resume/yield`)
   are fine and run cooperatively on the main thread. Use them for
   async work.
3. **No `love.video`.** If you want a title-screen video, render it as
   a sprite sheet.

---

## Achievements

Full author spec: [`docs/ACHIEVEMENTS.md`](./docs/ACHIEVEMENTS.md).
Quick-start here:

### Step 1 — declare the catalog

Create `achievements.json` at your repo root:

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
      "rarity": "common"
    },
    {
      "key": "boss_slain_cthulhu",
      "title": "Lord of the Deep",
      "description": "Defeat Cthulhu on any difficulty.",
      "glyph": "🐙",
      "points": 50,
      "rarity": "rare"
    },
    {
      "key": "pacifist_run",
      "title": "The Silent Path",
      "description": "Complete the game without killing anything.",
      "glyph": "☮",
      "points": 100,
      "rarity": "legendary",
      "hidden": true
    }
  ]
}
```

Fields (full schema in the spec):

- `key` — `^[a-z0-9_]+$`, max 64 chars. **Immutable after release.**
- `title`, `description` — display strings.
- `glyph` — 1–8 char emoji/symbol. OR:
- `icon` — relative path to a PNG under `achievements_icons/`.
- `points` — integer, 0–1000, default 10.
- `rarity` — `common` | `uncommon` | `rare` | `legendary`.
- `hidden` — if true, portal hides title/description until unlocked.
- `category` — optional free-form grouping.

### Step 2 — unlock from Lua

One `print` line at the trigger point:

```lua
-- Minimal
print("[[LOVEWEB_ACH]]unlock first_blood")

-- With metadata (any JSON object, single line):
local meta = { run = runId, score = finalScore, seed = worldSeed }
print(string.format("[[LOVEWEB_ACH]]unlock boss_slain_cthulhu %s",
                    json.encode(meta)))
```

Idempotent — calling twice is a no-op.

The runtime's stdout hook strips these lines from the log stream so
they don't clutter the console. Anything that doesn't match the prefix
flows through `print` normally.

### Step 3 — read unlock state for in-game UI

Wrapper you can drop into your project:

```lua
-- achievements.lua — read catalog and player state from the portal.
local json = require "lib.json"    -- any pure-Lua JSON lib; see below

local M = {}

function M.loadCatalog()
  -- Bundled in the .love — definitions authored in achievements.json.
  if not love.filesystem.getInfo("achievements.json") then return {} end
  local ok, data = pcall(json.decode, love.filesystem.read("achievements.json"))
  if not ok or type(data) ~= "table" then return {} end
  return data.achievements or {}
end

function M.loadUnlocks()
  -- Portal-provided, pre-populated before love.load(). Missing file
  -- = standalone run, not signed in, or nothing unlocked yet.
  local p = "__loveweb__/achievements.json"
  if not love.filesystem.getInfo(p) then return {} end
  local ok, data = pcall(json.decode, love.filesystem.read(p))
  if not ok or type(data) ~= "table" then return {} end
  local byKey = {}
  for _, u in ipairs(data.unlocks or {}) do byKey[u.key] = u end
  return byKey
end

function M.unlock(key, meta)
  -- One-shot fire-and-forget. Server dedupes; safe to spam.
  if meta then
    print(string.format("[[LOVEWEB_ACH]]unlock %s %s", key, json.encode(meta)))
  else
    print("[[LOVEWEB_ACH]]unlock " .. key)
  end
end

return M
```

Usage:

```lua
local Ach = require "achievements"

function love.load()
  CATALOG = Ach.loadCatalog()
  EARNED  = Ach.loadUnlocks()   -- { first_blood = {key=…, unlockedAt=…, points=10} }
end

function onEnemyDeath()
  if not EARNED["first_blood"] then
    Ach.unlock("first_blood")
    EARNED["first_blood"] = { key = "first_blood", unlockedAt = os.date("!%Y-%m-%dT%H:%M:%SZ"), points = 10 }
    showUnlockToast(CATALOG, "first_blood")
  end
end
```

### JSON library recommendation

LÖVE 11 doesn't ship a JSON library. Bundle one — they're tiny:

- [rxi/json.lua](https://github.com/rxi/json.lua) — 300 LoC, MIT,
  pure-Lua 5.1. Copy `json.lua` into your repo's `lib/` and
  `require "lib.json"`.

### Rate limits / abuse

The unlock endpoint has no hard rate limit, but:

- **Keys are catalog-gated** — unknown keys are rejected 404 server-side.
  You cannot spam arbitrary achievements.
- **Unlocks are idempotent** — calling the same key twice doesn't
  create duplicate rows.
- **Don't call unlock in `love.update`.** Wire it to a discrete event
  (enemy-death, boss-defeated, level-complete). Calling it every frame
  is wasteful even if harmless.

### What the player sees when you unlock

The moment your game emits the magic print line, the portal overlays a
**Steam-style toast** over the iframe:

- Icon (your `glyph` or `icon` PNG) framed by a radial glow in the
  rarity color (common = the game's accent; uncommon = green; rare =
  cyan; legendary = gold).
- **"▸ ACHIEVEMENT UNLOCKED"** stamp in the rarity color.
- Title + description.
- Rarity label and point value (e.g. `+50 pts`) on the right.
- A diagonal shimmer "glint" sweeps across on entry; legendary gets a
  stronger, gold-cored glint.
- A breathing box-shadow pulse keeps the tile visually alive for its
  ~5-second dwell.
- A short synthesized fanfare plays (D-major triad up to the octave
  with a glittery high-bell tail), slightly ducking the ambient
  soundtrack.

The toast:

- Auto-dismisses after ~5 seconds (or immediately on click).
- Up to 3 stack simultaneously; extras queue and render as earlier
  ones exit — e.g. triggering three unlocks in the same frame is
  handled gracefully.
- Only fires on **fresh** unlocks (`fresh: true` from the server). A
  replay unlock is a silent no-op — so you don't need dedup logic on
  the game side before calling `print("[[LOVEWEB_ACH]]unlock …")`.
- Is purely portal-side. Desktop LÖVE runs never see it (no `print`
  interception there), so it won't interfere with a native build.
- Respects `prefers-reduced-motion`: the glow/gradient stay, the
  animated sweeps are dropped.

**Game author implication:** you never need to render your own
unlock banner. Fire the print line, and the portal handles the
celebration. If you want an **in-game** notification too (e.g. for
players running your game standalone on desktop), gate it on your own
local state — the portal reading `__loveweb__/achievements.json` and
responding to it is orthogonal.

---

## Bridge protocol reference

You don't usually need this — the achievement magic-print and
`love.filesystem` abstractions cover 99% of cases. But if you're
debugging or want to wire something custom, here's the full message
table.

### Parent (portal) → runtime iframe

| Message type                   | Payload                                                  | Purpose                                               |
|--------------------------------|----------------------------------------------------------|-------------------------------------------------------|
| `loveweb:auth`                 | `{ signedIn: boolean }`                                  | Informs the runtime whether save sync is available.   |
| `loveweb:saves:manifest`       | `{ files: [{ path, updated_at }] }`                      | List of cloud save files to pull into MEMFS.          |
| `loveweb:save:data`            | `{ reqId, dataB64 \| null }`                             | Response to a save-read request.                      |
| `loveweb:achievements:state`   | `{ unlocks: [{ key, unlockedAt, points }] }`             | Current unlock state; written to `__loveweb__/…`.     |
| `loveweb:achievement:ack`      | `{ key, fresh, points }`                                 | Confirms an unlock landed server-side.                |

### Runtime iframe → parent (portal)

| Message type                    | Payload                                                 | Purpose                                                 |
|---------------------------------|---------------------------------------------------------|---------------------------------------------------------|
| `loveweb:hello`                 | `{ game }`                                              | Iframe parsed; WASM init about to start.                |
| `loveweb:ready`                 | `{ game }`                                              | `love.run` is active; heartbeats start.                 |
| `loveweb:save:write`            | `{ path, dataB64, meta }`                               | Pushes a MEMFS change to the server.                    |
| `loveweb:save:read`             | `{ path, reqId }`                                       | Requests a cloud save file on-demand.                   |
| `loveweb:log`                   | `{ level, msg }`                                        | Routed from Lua `print`/`printErr`.                     |
| `loveweb:achievement:unlock`    | `{ key, meta }`                                         | Produced by the `[[LOVEWEB_ACH]]unlock` magic print.    |
| `loveweb:quit`                  | `{ status, reason }`                                    | Clean-exit signal — emitted by the runtime shell when `love.event.quit()` flows through Module.quit / onExit. Parent overlays a "session ended" card and routes back to the library. |

From Lua you interact with this protocol via:

- `love.filesystem.*` — transparently triggers `loveweb:save:*`.
- `print("[[LOVEWEB_ACH]]unlock <key>")` — emits
  `loveweb:achievement:unlock`.
- `love.filesystem.read("__loveweb__/achievements.json")` — reads
  state delivered via `loveweb:achievements:state`.

---

## Debugging — getting logs out of the iframe

`print()` and `io.write()` from Lua are routed via
`loveweb:log` messages to the **parent page's browser console**. So:

1. Open games.brassey.io/games/your-slug.
2. Open the browser devtools console **on the outer page** (not on
   the iframe — its own console is discarded).
3. Watch for lines like: `[your-slug] info: <your message>`.

Common debug flow:

```lua
print("[DBG] enemy spawned at "..x..","..y)
```

Errors routed via `love.errorhandler` show up with `level: error`.
Unhandled Lua errors produce a red screen in the iframe; their trace
is captured in `loveweb:log` too.

The portal's `GameRunner` component also streams these into
`console.log` with the game slug prefix, so cross-tab grep works.

---

## Local development loop

The fastest feedback loop is to iterate **in desktop LÖVE** (which is
~instant), then occasionally verify in the web runtime.

### Desktop iteration

```sh
# In your game repo
love .
```

Every feature you implement should work here first.

### Web runtime verification

To test your game inside the exact love.js runtime the portal uses,
clone the portal repo and rebuild your slug:

```sh
# One-time
git clone https://github.com/MBrassey/games.git
cd games
pnpm install

# Point it at your in-development repo: edit src/lib/games.ts and add
# an entry with `repo: "your-gh-handle/your-game-repo"` (local-only
# change, don't commit unless you're contributing).
# OR: if you want to iterate without pushing to GitHub, temporarily
# replace .cache/game-src/<slug>/ with a symlink to your working tree:
ln -s /abs/path/to/your/game .cache/game-src/your-slug

# Build just your slug and serve:
pnpm build:games your-slug
pnpm dev
# → open http://localhost:3000/games/your-slug
```

Iterate: change Lua → `pnpm build:games your-slug` → refresh browser.

---

## Verifying the toast pipeline without a real unlock

Append `?_test_toast=<rarity>` to any game URL to pop a synthetic
achievement toast ~1.5 s after load. Fires the full visual + sound
pipeline (glint sweep, breathing pulse, fanfare chord) end-to-end so
you can confirm the portal wiring is alive without needing a real
catalog entry or an in-game trigger:

```
https://games.brassey.io/games/<slug>?_test_toast=common
https://games.brassey.io/games/<slug>?_test_toast=uncommon
https://games.brassey.io/games/<slug>?_test_toast=rare
https://games.brassey.io/games/<slug>?_test_toast=legendary
```

It's portal-only — no persistence, no DB writes. Pure UI preview.

## Smoke testing

Before any public release, run:

```sh
node scripts/test-game-runtime.mjs public/games/your-slug/runtime
```

This spins a headless Chromium, loads the runtime, captures 15 s of
logs + postMessages, and exits non-zero if:

- `loveweb:ready` never fires (game didn't boot),
- any line matches `Syntax error` (Lua parse failure),
- any error log mentions Lua (`boot.lua`, `xpcall`, `Error:`),
- any network request failed,
- any page-level JavaScript error was thrown.

CI-ready. Add it to your own repo's GitHub Actions if you like, though
the portal also runs a manual validation when you're added to
`src/lib/games.ts`.

---

## Getting listed on the portal

Once your game runs cleanly in the smoke test:

1. **Open a PR against `MBrassey/games`** adding a `GameEntry` to
   `src/lib/games.ts`:

   ```ts
   {
     slug: "your-game",
     title: "Your Game",
     codename: "YOUR.GAME",
     tagline: "one-line hook",
     description: "longer paragraph shown on the game page",
     author: "your-github-handle",
     version: "head",
     category: "action",           // action | puzzle | rpg | arcade | meta
     tags: ["bullet-hell"],
     year: 2026,
     repo: "your-gh-handle/your-game-repo",
     ref: "main",                  // optional; default "main"
     accentColor: "#8a4fff",       // hex, used in chrome around your game
     multiplayer: "single",        // single | coop | mmo
     status: "live",               // live | beta | soon
   }
   ```

2. **Portal admin merges.** On the next Vercel deploy, the pipeline
   clones your repo, patches, packs, compiles, and publishes your
   `/games/<slug>` page + adds you to the catalog grid.

3. **Get on the auto-deploy watchlist.** Add your `<owner>/<repo>` to
   the matrix in `.github/workflows/upstream-games-watch.yml`. After
   that, every push you make to your game repo's `main` triggers a
   portal redeploy within ~10 minutes.

---

## Upstream auto-deploy

Once listed, your deploy loop is:

```
you push to main on your game repo
   ↓  (≤10 min)
GitHub Action detects new HEAD
   ↓
Vercel deploy hook fires
   ↓
Portal rebuilds with your latest HEAD
   ↓
live on games.brassey.io/games/<slug>
```

You can also force an immediate check by running the **"Upstream game
watch"** workflow manually in the Actions tab (if you have access), or
asking the portal admin to trigger it.

---

## Starter skeleton

Copy-paste this into a new GitHub repo and you have a compliant
game that renders and integrates with every portal feature on day one.

**`main.lua`**

```lua
local Ach = require "achievements"

local state = {
  catalog = {},
  earned  = {},
  name    = nil,         -- filled from save on load
  enemies_killed = 0,
}

function love.load()
  state.catalog = Ach.loadCatalog()
  state.earned  = Ach.loadUnlocks()

  -- Example save load:
  if love.filesystem.getInfo("save.json") then
    local ok, data = pcall(json.decode, love.filesystem.read("save.json"))
    if ok and type(data) == "table" then
      state.name = data.name
      state.enemies_killed = data.enemies_killed or 0
    end
  end
end

function love.keypressed(key)
  if key == "space" then
    state.enemies_killed = state.enemies_killed + 1
    if state.enemies_killed == 1 and not state.earned["first_blood"] then
      Ach.unlock("first_blood")
      state.earned["first_blood"] = { key = "first_blood", points = 10 }
    end
    -- Persist — automatically cloud-synced.
    love.filesystem.write("save.json", json.encode({
      name = state.name,
      enemies_killed = state.enemies_killed,
    }))
  end
end

function love.draw()
  love.graphics.print(
    "enemies killed: "..state.enemies_killed.."\npress SPACE",
    20, 20
  )
  local row = 60
  for _, def in ipairs(state.catalog) do
    local e = state.earned[def.key]
    love.graphics.print(
      (e and "[x] " or "[ ] ") .. def.title,
      20, row
    )
    row = row + 20
  end
end
```

**`conf.lua`**

```lua
function love.conf(t)
  t.identity          = "your-game"
  t.version           = "11.5"
  t.console           = false
  t.window.title      = "Your Game"
  t.window.width      = 1920
  t.window.height     = 1080
  t.window.resizable  = false
  t.window.vsync      = 1
  t.window.highdpi    = true
  t.modules.thread    = false
  t.modules.video     = false
end
```

**`achievements.json`**

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
      "rarity": "common"
    }
  ]
}
```

**`achievements.lua`** — use the wrapper from the Achievements
section above.

**`lib/json.lua`** — drop in
[rxi/json.lua](https://github.com/rxi/json.lua) (MIT license).

That's it. Commit, push, submit the PR to add your slug, and the
portal does the rest.

---

## Shipping checklist

Before you submit the PR to get listed, verify:

- [ ] Repo is public on GitHub.
- [ ] `main.lua` and `conf.lua` are at repo root (or `subdir` is
      explicitly set in the portal entry).
- [ ] `conf.lua` has `t.identity` set to a stable string.
- [ ] `love .` runs cleanly on desktop.
- [ ] No `ffi`, no `love.thread`, no `love.video`, no sockets.
- [ ] `pnpm build:games <slug>` against the portal repo compiles with no
      Lua syntax errors.
- [ ] `node scripts/test-game-runtime.mjs public/games/<slug>/runtime`
      exits 0.
- [ ] `achievements.json` (if any) validates — keys `^[a-z0-9_]+$`,
      unique, all fields within the schema bounds.
- [ ] Every achievement you declare actually has an unlock path
      triggerable in-game (don't ship unreachable achievements).
- [ ] No write paths touch `__loveweb__/`.
- [ ] Saves stay under ~4 MB per file.
- [ ] Game pauses on `love.focus(false)`.
- [ ] Game renders correctly at both 1920×1080 and ~720×405 (narrow
      mobile viewport).
- [ ] `LICENSE` file is present.
- [ ] `README.md` describes the game, controls, and credits.

---

## Pitfalls & fixes

Sharp edges culled from real-world debugging on the portal.

### Black canvas, no errors

`theme/love.css` in the love.js bundle has `#canvas { visibility:
hidden; }` by default. The portal's runtime shell forces
`visibility: visible !important`, but if for any reason the canvas
isn't visible, check `getComputedStyle(canvas).visibility` in devtools.

### `"Cannot load game at path '/./game.love'"`

`game.js` (asset manifest) is out of sync with `game.data`. Happens
when a build only copies one of the pair. Re-run `pnpm build:games
<slug>` cleanly (delete `public/games/<slug>/runtime/` first).

### `"Syntax error: '=' expected near 'continue'"`

Your code uses a LuaJIT extension that didn't survive the 5.1 patch.
Most commonly: `continue` as an identifier (fine in 5.1) being parsed
as a reserved word somewhere, or unusual string escape sequences.
Check with `luac -p` on plain Lua 5.1.

### `"unable to create opengl window"` on Brave

The user's browser (Brave with Shields → Fingerprinting: Strict)
disabled WebGL. Portal shows inline fix instructions. Not a bug in
your game.

### Saves not appearing on second device

Check:
- User is **signed in** on both devices (GitHub OAuth).
- `t.identity` is unchanged between releases.
- File path passed to `love.filesystem.write` is identical (case
  matters).
- File size under 4 MB.

### Mouse coords wrong when canvas scales

You didn't remap mouse input through the `DESIGN_W`/`DESIGN_H` logic
in the Rendering section. Apply the `mouseToWorld` helper.

### Unlock POSTs return 404

Your achievement key isn't in the catalog. Verify:
- `achievements.json` is at repo root (not in a subdir).
- Build has been re-run since you added the key.
- Key spelling matches exactly, including case.

### Unlock succeeds but doesn't show on portal

Force-refresh `/stats` — it's server-rendered with
`cache: "no-store"`, so a hard reload is enough. If it still doesn't
show after 30 seconds, check the browser console for POST errors.

### Music stops when navigating between pages

Fixed portal-side. If you notice this recurring in your own build,
make sure you're not calling `love.audio.stop()` on every update, and
that you pause on `love.focus(false)`.

### Dialog boxes / modals in browser

`love.window.showMessageBox` is unreliable in the browser. Use an
in-game overlay instead. For `love.filesystem.getAppdataDirectory`:
don't — it returns a virtual path that means nothing to the user.

---

That's the full contract. If you stick to the checklist you get a
game that runs in-browser, survives across devices, surfaces
achievements on the global leaderboard, and auto-deploys on every
push to `main`. Everything else is gameplay.
