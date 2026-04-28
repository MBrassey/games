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
   portal-managed metadata (identity, achievements, net inbox).
6. **For multiplayer**, use the `[[LOVEWEB_NET]]` magic-print verbs.
   No raw sockets, no threads, no `love.video` — `love.filesystem`,
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
11. [Multiplayer & shared world](#multiplayer--shared-world)
12. [Achievements](#achievements)
13. [Runtime UI effects](#runtime-ui-effects)
14. [Bridge protocol reference](#bridge-protocol-reference)
15. [Debugging — getting logs out of the iframe](#debugging--getting-logs-out-of-the-iframe)
16. [Local development loop](#local-development-loop)
17. [Verifying the toast pipeline](#verifying-the-toast-pipeline-without-a-real-unlock)
18. [Smoke testing](#smoke-testing)
19. [Getting listed on the portal](#getting-listed-on-the-portal)
20. [Upstream auto-deploy](#upstream-auto-deploy)
21. [Starter skeleton](#starter-skeleton)
22. [Shipping checklist](#shipping-checklist)
23. [Pitfalls & fixes](#pitfalls--fixes)

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

TCP/UDP sockets: **no LuaSocket** ships with love.js, and games on the
portal **must not** open raw sockets. The portal provides a complete
multi-user layer (rooms, presence, event broadcast, persistent room
state) that you reach via the `[[LOVEWEB_NET]]` magic-print verbs —
see [Multiplayer & shared world](#multiplayer--shared-world). Effective
event-delivery cadence is sub-second when active; the right substrate
for MMORPG-style worlds, lobbies, turn-based games, and chat. For
60Hz twitch shooters with shared simulation, you'll need to fall back
to single-player or hot-seat coop until/unless we add a separate
high-tick-rate socket server.

---

## `conf.lua`

Minimal recommended `conf.lua`:

```lua
function love.conf(t)
  t.identity = "your_game"        -- save dir name. Keep stable forever.
                                  -- Must match the portal's GameEntry
                                  -- `identity` (default: slug with
                                  -- dashes → underscores).
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

**Tell the portal what your identity is.** The portal needs to know
your identity string to place `__loveweb__/achievements.json` inside
the right subdir (so `love.filesystem.read("__loveweb__/achievements.json")`
can actually find it). In your [registration PR](#getting-listed-on-the-portal)
add an explicit `identity:` field to your `GameEntry` — if you forget,
the portal defaults to `<your-slug>` with dashes converted to
underscores (e.g. slug `my-roguelike` → identity `my_roguelike`). Easiest:
make your `t.identity` match that derivation so the default Just Works.

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

Normal LÖVE keyboard callbacks work. The runtime shell inside the
iframe calls `preventDefault()` on keydowns for **space and the four
arrow keys** — so pressing space doesn't scroll the page behind you and
arrow keys don't move focus rings or scroll the viewport. Every other
key passes straight through to LÖVE untouched.

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

Browsers require a user gesture before any audio can play. The portal's
own ambient soundtrack attempts an eager resume on mount (works for
SPA navigations and returning visitors whose browsers have granted
autoplay permission) and otherwise unlocks on the first click/keydown
anywhere on the page. Once the AudioContext is running, `love.audio`
in your game works normally without any extra setup on your side.

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

The portal injects the signed-in player's identity into your save dir
**before `love.load()` runs**, at:

```
<save-dir>/__loveweb__/identity.json
```

Schema:

```json
{
  "signedIn": true,
  "userId":   "42",          // stable string id (BIGINT serialized)
  "handle":   "thepearlking", // GitHub login or override; stable per user
  "avatar":   "https://avatars.githubusercontent.com/u/...png"
}
```

For an unauthenticated session the file still exists but reads as
`{ "signedIn": false }`. Treat that as a signal to fall back to a
locally-stored display name (or a guest UUID written into your own save
on first boot).

```lua
local function loadIdentity()
  if not love.filesystem.getInfo("__loveweb__/identity.json") then
    return { signedIn = false }
  end
  local ok, data = pcall(json.decode, love.filesystem.read("__loveweb__/identity.json"))
  if not ok or type(data) ~= "table" then return { signedIn = false } end
  return data
end

function love.load()
  local me = loadIdentity()
  if me.signedIn then
    Player.handle  = me.handle
    Player.avatar  = me.avatar
    Player.userId  = me.userId
  else
    Player.handle = "guest-" .. love.math.random(1000, 9999)
  end
end
```

Identity is **hot-rewritten** if it changes mid-session (rare: only
happens on a SPA-style navigation between games while signed in), so a
game that re-reads the file in response to a `love.focus(true)` event
always sees the current value. Don't poll it every frame; once-per-load
plus on focus-regain is plenty.

---

## Multiplayer & shared world

The portal ships a complete multi-user layer for LÖVE2D games. Same
trust model as save sync — your game **never** talks HTTP directly.
You emit `print("[[LOVEWEB_NET]]<verb> <args>")` lines, the runtime
forwards them to the portal server, and the responses + live event
stream land as files in `__loveweb__/net/` that you tail with
`love.filesystem.*`. No JS interop. No HTTP keys in your bundle. No
sockets.

### What it gives you

- **Rooms.** Named, capacity-bounded joinable spaces scoped to your
  game. Public rooms are listable; unlisted rooms join by 6-char code.
- **Event broadcast.** Any member sends an event with a verb of your
  choice and a JSON payload; every other member receives it through
  Server-Sent Events with sub-second latency.
- **Persistent room state.** A JSONB blob attached to the room. Merge
  patches into it (with optional CAS via `expectedVersion`) and the
  whole room is notified when it changes. Survives reconnects, late
  joiners, and the portal redeploying.
- **Live presence.** A roster of online members, refreshed when people
  join, leave, or stop heartbeating (60s grace).
- **Catch-up on reconnect.** The SSE stream backfills the last ~50
  events when the player reconnects, so a momentary network drop
  doesn't desync your simulation state.
- **Per-user rate-limit.** Send is capped at 12/s burst 24/s per
  (user, room). Above that, sends 429 — the runtime surfaces it via
  `__loveweb__/net/last_result.json`.

### Tick-rate guidance

The portal is a Vercel-only stack (no persistent WebSocket). Effective
event-delivery cadence is **~750 ms when active, backing off to 8 s
when the room is idle**. That makes it the right substrate for:

- MMORPG-style worlds (chat, slow movement, presence)
- Turn-based / hot-seat games (shared state is the source of truth)
- Lobbies, matchmaking, party chat
- Asynchronous interactions (mail, gifts, leaderboards-with-context)
- Co-op exploration where 1–2 Hz updates feel fine
- Real-time chat between players outside the global #channels

It is **not** a fit for 60Hz fighting games or twitch shooters with
shared simulation. For those, the room state is still useful as a
session/lobby coordinator, but the actual gameplay simulation needs to
stay client-authoritative or local-only.

### Files in `__loveweb__/net/`

| Path                              | Written by                | Contains                                                |
|-----------------------------------|---------------------------|---------------------------------------------------------|
| `__loveweb__/identity.json`       | runtime, before love.load | The signed-in player's identity (see above section).    |
| `__loveweb__/net/room.json`       | runtime, on room join     | `{ roomId, mode, state, stateVersion, connectedAt }`.   |
| `__loveweb__/net/roster.json`     | runtime, on roster delta  | `{ roomId, members: [{userId, handle, avatar, joinedAt, lastSeen}], at }`. |
| `__loveweb__/net/inbox.jsonl`     | runtime, on every event   | Append-only JSONL log of delivered `NetEvent`s. Trimmed once it crosses ~256 KB. |
| `__loveweb__/net/status.json`     | runtime, on conn changes  | `{ status: "connected" \| "disconnected" \| "closed", roomId, at }`. |
| `__loveweb__/net/last_result.json`| runtime, after each verb  | The most recent `*:result` envelope (incl. `error` if any). |

The save-watch loop excludes `__loveweb__/` entirely, so none of these
files round-trip into your `game_saves` rows.

### Magic-print verbs

```lua
-- Create + auto-join a public room. Result lands in last_result.json:
--   { ok = true,  room = { id, code, name, capacity, ... } }
--   { ok = false, error = "..." }
print("[[LOVEWEB_NET]]create lobby Anglerfish Den")

-- Join an existing room by its 6-char code (case-insensitive on the way
-- in; canonical form is uppercase). Result schema same as create.
print("[[LOVEWEB_NET]]join 7HQ4N2")

-- Leave the current room. Idempotent — calling twice is safe.
print("[[LOVEWEB_NET]]leave")

-- List public rooms for THIS game. Result:
--   { type="loveweb:net:list:result", rooms=[{id,code,name,memberCount,onlineCount,...}] }
print("[[LOVEWEB_NET]]list")

-- Broadcast an event to every other member of the room. The verb must
-- match `^[a-z][a-z0-9_]*$` and not collide with reserved verbs
-- (join, leave, state, presence, kick).
print('[[LOVEWEB_NET]]send move {"x":124.5,"y":-87.2,"facing":"left"}')

-- Merge a patch into the room's persistent state. Default is shallow
-- merge (jsonb `||` operator); pass replace=true (via Lua wrapper) to
-- overwrite. Server bumps state_version and emits a `state` event so
-- everyone re-syncs.
print('[[LOVEWEB_NET]]state {"phase":"voting","timer":90}')
```

### Lua wrapper

Drop this in as `net.lua`:

```lua
-- net.lua — thin wrapper over the [[LOVEWEB_NET]] magic-print protocol.
local json = require "lib.json"

local M = {
  room      = nil,        -- { id, code, name, capacity, ownerId, ... } once joined
  state     = {},         -- last-seen room state (live-updated by tick)
  members   = {},         -- last-seen roster
  status    = "idle",     -- "idle" | "connecting" | "connected" | "disconnected" | "closed"
  watermark = "0",        -- highest event id we've consumed
  identity  = nil,        -- { signedIn, handle, userId, avatar }
}

local function readJson(path)
  if not love.filesystem.getInfo(path) then return nil end
  local ok, data = pcall(json.decode, love.filesystem.read(path))
  if not ok then return nil end
  return data
end

function M.refreshIdentity()
  M.identity = readJson("__loveweb__/identity.json") or { signedIn = false }
end

function M.create(name)         print("[[LOVEWEB_NET]]create " .. (name or "room"))   end
function M.join(code)           print("[[LOVEWEB_NET]]join "   .. (code or ""))       end
function M.leave()              print("[[LOVEWEB_NET]]leave")                          end
function M.list()               print("[[LOVEWEB_NET]]list")                           end

function M.send(verb, payload)
  if payload then
    print(string.format("[[LOVEWEB_NET]]send %s %s", verb, json.encode(payload)))
  else
    print("[[LOVEWEB_NET]]send " .. verb)
  end
end

function M.setState(patch)
  print("[[LOVEWEB_NET]]state " .. json.encode(patch))
end

-- Read all events past M.watermark, hand them to `onEvent(evt)`, advance
-- the watermark. Call once per frame from love.update.
function M.poll(onEvent)
  -- Roster + room snapshots are cheap to re-read each tick; they're
  -- updated on the runtime side only when something changes.
  local roster = readJson("__loveweb__/net/roster.json")
  if roster then M.members = roster.members or {} end
  local room   = readJson("__loveweb__/net/room.json")
  if room then
    M.room   = M.room or {}
    M.room.id           = room.roomId
    M.room.stateVersion = room.stateVersion
    M.state             = room.state or M.state
  end
  local status = readJson("__loveweb__/net/status.json")
  if status and status.status then M.status = status.status end

  if not love.filesystem.getInfo("__loveweb__/net/inbox.jsonl") then return end
  for line in love.filesystem.lines("__loveweb__/net/inbox.jsonl") do
    local ok, evt = pcall(json.decode, line)
    if ok and type(evt) == "table" and evt.id and tonumber(evt.id) > tonumber(M.watermark) then
      M.watermark = evt.id
      if evt.verb == "state" and evt.payload and evt.payload.state then
        M.state = evt.payload.state
      end
      if onEvent then onEvent(evt) end
    end
  end
end

return M
```

### End-to-end example

```lua
local Net  = require "net"
local json = require "lib.json"

function love.load()
  Net.refreshIdentity()
  -- Fire-and-forget. Result arrives a second later in last_result.json.
  Net.create("Anglerfish Den")
end

function love.update(dt)
  Net.poll(function (evt)
    if     evt.verb == "join"   then chat("» " .. evt.handle .. " entered")
    elseif evt.verb == "leave"  then chat("» " .. evt.handle .. " left")
    elseif evt.verb == "move"   then world:applyRemoteMove(evt.userId, evt.payload)
    elseif evt.verb == "shout"  then chat("<" .. evt.handle .. "> " .. evt.payload.text)
    elseif evt.verb == "state"  then phase = evt.payload.state.phase end
  end)
end

function love.keypressed(key)
  if key == "space" then
    Net.send("shout", { text = "ahoy!" })
  end
end

function love.draw()
  -- Render the live roster as a sidebar.
  local y = 20
  for _, m in ipairs(Net.members or {}) do
    love.graphics.print(m.handle, 20, y); y = y + 18
  end
end
```

### Authority model

- **Any current member** of a room can mutate `state` and broadcast
  `send` events. The portal does not enforce a "host" by itself —
  if you need authority, encode it in your own state schema (e.g.
  `{owner_id, only_owner_writes}`) and reject conflicting events
  on the receiving side.
- **State updates** are atomic on the portal side: each PATCH increments
  `state_version`. Pass the version you read (via the wrapper or with
  the magic-print verb extended manually) and a stale write will be
  rejected with a 409 in `last_result.json`. Default semantics is
  last-write-wins.
- **Capacity** is enforced server-side at join time. Default is 8 per
  room, max 64. Pass `capacity` to `create` to change it.
- **Visibility** is `public` (listed via `list`) or `unlisted` (joinable
  by code only). Private/invite-only rooms are not in v1.
- **Eviction** of stale members is implicit: if a player's heartbeat
  lapses for more than 60 s, they fall out of the live roster. They're
  not formally removed until they explicitly `leave`, so a momentary
  network blip won't kick them out of the room.

### Slug-wide (cross-room) layer

Once your population grows past one room's capacity, players in
different rooms can't see each other through the per-room channel —
that's intentional, since broadcasting every move from every room to
the whole slug would melt the KV budget. The portal provides a
**slug-scoped** tier on top: lower-rate, mirrors only "global ticker"
verbs, and is open to every player on the same game whether they're in
a room or not (even guests).

Three things sit on this tier:

#### 1. Slug presence — "is anyone playing right now?"

The runtime maintains a live snapshot at `__loveweb__/slug/active.json`
refreshed every ~8 s while the game page is open:

```json
{
  "slug":          "zmine",
  "activeUsers":   7,
  "totalRooms":    3,
  "last24hUsers":  23,
  "allTimeUsers":  156,
  "topUsers": [
    {
      "userId":     "42",
      "handle":     "thepearlking",
      "avatar":     "https://avatars.…/u/…png",
      "lastSeenAt": "2026-04-25T14:22:01Z",
      "profile":    { /* whatever the user wrote to public_profile.json */ }
    },
    …
  ],
  "at": 1745618521234
}
```

Read it from Lua any time:

```lua
local function loadSlugPresence()
  if not love.filesystem.getInfo("__loveweb__/slug/active.json") then
    return nil
  end
  local ok, data = pcall(json.decode, love.filesystem.read("__loveweb__/slug/active.json"))
  return ok and data or nil
end
```

The `topUsers[*].profile` payload is whatever your game previously
wrote to `public_profile.json` (see #3 below). The portal does not
prescribe its shape — `facility_name`, `z_lifetime`, `hashrate`, or
anything else you care about. To rank by a top-level numeric field of
your profile, request a refresh with the rank verb:

```lua
print("[[LOVEWEB_NET]]slug_presence z_lifetime 12")
-- result lands in __loveweb__/slug/active.json with topUsers[] sorted desc
```

The HTTP endpoint behind it is also publicly readable (`GET /api/net/slug/presence?game=<slug>&rankBy=<field>&limit=<n>`),
so portal-side widgets can show the same population badge.

#### 2. Slug event stream (the "global ticker")

The portal automatically mirrors a small set of room events into a
slug-wide stream — the verbs every other player on the same game
should hear, regardless of room. Default mirror set:

```
stats   block   halving   build   wave   flag   achievement
```

Anything you `[[LOVEWEB_NET]]send` with one of these verbs gets
mirrored to the slug stream **once** (no double-fanout to other room
members; they get it through the room stream). Targeted (`--target=`)
sends are NOT mirrored — they're 1:1 messages, not world news.

For verbs outside the mirror set, use the explicit broadcast verb:

```lua
print('[[LOVEWEB_NET]]broadcast surge_started {"started_at":1745618521,"duration_ms":120000}')
```

Both auto-mirrored and explicitly-broadcast events land at
`__loveweb__/slug/global_inbox.jsonl`, an append-only JSONL with the
same ~256 KB rolling cap as the room inbox. Tail it the same way:

```lua
local watermark = state.global_watermark or "0"
for line in love.filesystem.lines("__loveweb__/slug/global_inbox.jsonl") do
  local ok, evt = pcall(json.decode, line)
  if ok and tonumber(evt.id) > tonumber(watermark) then
    watermark = evt.id
    onSlugEvent(evt) -- handle stats / block / build / your-custom-verb
  end
end
state.global_watermark = watermark
```

`broadcast` is rate-limited at half the per-room ceiling (~6/s burst
12/s) so a bug in your update loop can't torch every other player's
session. Rate-limit failures show up in `__loveweb__/net/last_result.json`
with `ok:false, error:"rate limited"`.

#### 3. Public profile (peer ghosts)

If your game `love.filesystem.write`s a file at the relative path
`public_profile.json`, anyone (signed in or not) can read it via the
profiles endpoint. This is the substrate for "ghost facilities" —
showing a peer's last-known stats / cosmetics / facility name even
when they're offline and have never been in your room.

The file is a regular cloud-save: write whatever JSON you like, and
the existing save-sync round-trips it like any other file. Just keep
it small — under ~32 KB is courteous.

```lua
local function publishProfile()
  love.filesystem.write("public_profile.json", json.encode({
    facility_name = state.facility_name,
    z_lifetime    = stats.z_lifetime,
    z_per_sec     = stats.z_per_sec,
    hashrate      = stats.hashrate,
    cosmetics     = state.cosmetics,
    updated_at    = os.time(),
  }))
end
```

Fetch a peer's profile by user id:

```lua
print("[[LOVEWEB_NET]]profile 42")
-- result lands at __loveweb__/net/profiles/42.json (canonical) and
-- __loveweb__/profiles/42.json (legacy mirror, same content):
--   { userId, handle, avatar, profile, profileUpdatedAt, fetchedAt }
```

`profile` is `null` if the peer has never written one. Cache the file
locally — re-fetch on demand when the game wants a fresh snapshot.

The portal-side endpoint is `GET /api/net/profiles?game=<slug>&userId=<id>`
if you ever want to call it from somewhere outside Lua.

#### 4. Slug-wide persistent state

A single durable JSONB blob keyed on the slug, separate from any
room. Useful for an all-time leaderboard, a scheduled surge timer, a
world-flag, an "all-time blocks found" counter — anything that needs
to outlive any individual room.

```lua
-- Read (passive — the runtime auto-mirrors latest snapshot here):
local function readSlugState()
  if not love.filesystem.getInfo("__loveweb__/slug/state.json") then return {} end
  local ok, data = pcall(json.decode, love.filesystem.read("__loveweb__/slug/state.json"))
  if not ok then return {} end
  return data.state or data or {}
end

-- Write (shallow merge by default; pass `{replace=true}` payload via
-- HTTP if you need full replace; the magic-print form is always merge):
print('[[LOVEWEB_NET]]slug_state {"all_time_blocks":12345,"surge_until":1745700000}')
```

Like room state, every slug_state mutation increments `state_version`.
Pass `expectedVersion` (via direct HTTP only — the magic-print form is
last-write-wins) to do CAS.

The state-mutation event is auto-mirrored into `slug/global_inbox.jsonl`
with `verb = "slug_state"` so all subscribers can re-sync without
polling — same pattern as room state.

#### 5. Targeted unicast (per-recipient delivery)

Add `--target=<userId>` to a `send` to address it to one peer. The
portal stream filters delivery: only the sender and the addressed
recipient see the event; other room members don't.

```lua
-- Without target — broadcast to every member of the room:
print('[[LOVEWEB_NET]]send wave {"emoji":"👋"}')

-- With target — only userId 42 sees it (plus the sender, in their
-- own send:result echo):
print('[[LOVEWEB_NET]]send boost --target=42 {"amount":10,"kind":"hash"}')
```

Targeted sends bypass the slug-mirror auto-fanout and don't show up in
`slug/global_inbox.jsonl`. The `target` field is also present on the
delivered NetEvent (and the row in `last_result.json`) so the receiver
can confirm "this was for me" before applying the side-effect.

#### Authority model (recap)

- **Anyone** can read slug presence + slug state + any peer's public
  profile. No auth required.
- **Authenticated members** can:
  - mutate room state and broadcast room events (existing rules)
  - mutate slug state via `slug_state`
  - emit slug-wide broadcast events
  - target a `send` at any user id (the recipient doesn't have to be in
    the room — they just won't see it unless they are)
- **`public_profile.json`** is opt-in: games that don't want any
  cross-game peer visibility simply don't write the file.

### What's still off-limits

- **Raw sockets** (LuaSocket, TCP, UDP). The portal protocol above is
  the only way to do online play.
- **`love.thread`.** Use coroutines (`coroutine.create/resume/yield`).
- **`love.video`.** Render a sprite sheet for cinematics instead.

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

## Runtime UI effects

Your game can reach out and affect the surrounding portal chrome — the
topbar, the chat drawer, the background, the whole viewport — as if
the cabinet itself is responding to gameplay. This is what makes a
boss fight feel *weighty*: a ripple on a staff slam, a shatter on
death, a persistent blood-red mood during an encounter, a slow
soothing glow when the player reaches a sanctuary.

It's all declarative. Emit one magic-print line per effect:

```lua
print("[[LOVEWEB_FX]]flash #ff6699 300")
print("[[LOVEWEB_FX]]shake 0.8 400")
print("[[LOVEWEB_FX]]mood #ff3366 0.2")
print("[[LOVEWEB_FX]]shatter 1.0 650")
```

No JS interop. No portal API calls. The runtime shell intercepts the
line (same path as `[[LOVEWEB_ACH]]unlock`), strips it from the log
stream, and posts it to the parent, which applies the effect.

### Catalog

| Verb        | Args                                        | What it does                                                                                                                |
|-------------|---------------------------------------------|-----------------------------------------------------------------------------------------------------------------------------|
| `flash`     | `<color> <ms> [intensity]`                  | One-shot screen flash. Fades over `ms`. Default intensity 0.6.                                                              |
| `shake`     | `<intensity> <ms>`                          | Shakes the entire UI wrapper with a dampened random oscillation. Intensity 0..1. Starfield stays still — the cabinet rattles. |
| `invert`    | `<ms>`                                      | Inverts viewport colors for `ms`. Great on death.                                                                           |
| `tint`      | `<color> <alpha> <ms>`                      | Color wash over the viewport. Fades out.                                                                                    |
| `mood`      | `<color> <intensity>`                       | **Persistent.** Ambient tint that breathes. Clear with `mood none`.                                                         |
| `calm`      | `<color> <intensity>`                       | **Persistent.** Soft radial soothing glow from center. Meditative — reads as a sanctuary, not an alarm. Clear with `calm none`. |
| `pulsate`   | `<color> <bpm> <intensity>`                 | **Persistent.** Rhythmic heartbeat throb at `bpm` (20–200). Clear with `pulsate off`.                                       |
| `pulse`     | `<color> <ms>`                              | Expanding ring out from viewport center. One-shot.                                                                          |
| `ripple`    | `<color> <x> <y> <ms>`                      | Concentric wave expanding from an origin point — `x` and `y` are fractions of the viewport (`0.0`–`1.0`; `0.5 0.5` = center). Multiple ripples can overlap. |
| `glow`      | `<color> <intensity> <ms>`                  | Edge-lit halo, inset into the viewport rim. Fades out.                                                                      |
| `chroma`    | `<intensity> <ms>`                          | Brief chromatic aberration / RGB-split.                                                                                     |
| `vignette`  | `<intensity> <ms>`                          | Darkens the viewport edges for `ms`.                                                                                        |
| `shatter`   | `<intensity> <ms>`                          | The big one. Composite: flash + chroma + shake + a glass-crack overlay. Use sparingly — for death, defeat, catastrophic hits. |
| `flicker`   | `<intensity> <ms>`                          | Brightness flicker — reads as transmission interference.                                                                    |
| `zoom`      | `<amount> <ms>`                             | Brief scale push/pull on the UI. Amount is -0.1..0.1 (negative = zoom out).                                                 |
| `scanlines` | `<intensity> <ms>`                          | Intensifies the ambient CRT scanline overlay.                                                                               |

### Colors

Any valid CSS color string works:

- Hex: `#ff6699`, `#f39`, `#ff6699cc`
- `rgb()`, `rgba()`, `hsl()`, `hsla()`
- Named colors: `red`, `cyan`, `crimson`

Invalid colors fall back to a neutral portal purple — your game won't
crash the portal over a typo.

### Patterns

```lua
-- Hit feedback (light)
print("[[LOVEWEB_FX]]flash #ffffff 120 0.35")
print("[[LOVEWEB_FX]]shake 0.25 180")

-- Critical hit
print("[[LOVEWEB_FX]]flash #ffdd66 220 0.7")
print("[[LOVEWEB_FX]]chroma 0.6 180")
print("[[LOVEWEB_FX]]shake 0.55 260")

-- Player death
print("[[LOVEWEB_FX]]shatter 1.0 800")
print("[[LOVEWEB_FX]]invert 200")
print("[[LOVEWEB_FX]]mood #330011 0.35")   -- lingers until cleared

-- Boss encounter start
print("[[LOVEWEB_FX]]mood #6a0a28 0.3")
print("[[LOVEWEB_FX]]pulsate #ff3366 72 0.35")  -- 72 BPM menacing heartbeat
print("[[LOVEWEB_FX]]vignette 0.5 900")

-- Boss encounter end / sanctuary / save point
print("[[LOVEWEB_FX]]mood none")
print("[[LOVEWEB_FX]]pulsate off")
print("[[LOVEWEB_FX]]calm #66e0ff 0.35")        -- soothing meditation glow
print("[[LOVEWEB_FX]]pulse #66e0ff 900")

-- Elemental impact at a specific on-screen point
-- (x and y are 0..1 fractions of the viewport)
print("[[LOVEWEB_FX]]ripple #66e0ff 0.5 0.4 900")
print("[[LOVEWEB_FX]]ripple #66e0ff 0.5 0.4 1400")  -- stacking = thicker wave

-- "Game is glitching out"
print("[[LOVEWEB_FX]]flicker 0.7 240")
print("[[LOVEWEB_FX]]chroma 0.8 200")
print("[[LOVEWEB_FX]]scanlines 0.9 400")

-- Subtle mood shift as night falls
print("[[LOVEWEB_FX]]mood #1a0833 0.12")
```

### Safety rails (what the portal does for you)

You cannot break the portal with FX:

- **Duration is clamped** to 2.5 s max. A game can't hold the UI in
  a permanent flash.
- **Intensity is clamped** to 0..1 everywhere.
- **Anti-strobe floors**: consecutive `flash` or `invert` calls inside
  140–180 ms get merged/dropped so a bug in your update loop can't
  turn the viewport into a strobe.
- **BPM is clamped** to 20–200 for `pulsate`.
- **Colors are sanitized** — malformed color strings fall back.
- **`prefers-reduced-motion`** users get color-only effects at reduced
  intensity; shake, flash, invert, chroma, flicker, pulse, ripple,
  shatter, and zoom are all skipped for them. Your FX script runs the
  same; only the *visible* output is different.
- **Pointer-events-none overlay** — FX can never steal clicks from the
  player.
- **Forward compatible** — unknown verbs are silently ignored. New
  portal features won't break older games; older games can't emit
  verbs that don't exist yet.

### Verifying from the console

Every running portal page exposes `window.__portalFx(verb, ...args)`
so you can exercise effects from the browser devtools without a
running game. Examples:

```js
__portalFx("flash", "#ff6699", "300")
__portalFx("shatter", "1", "700")
__portalFx("mood", "#330011", "0.4")
__portalFx("calm", "#66e0ff", "0.4")
__portalFx("pulsate", "#ff3366", "60", "0.35")
__portalFx("ripple", "#ffffff", "0.5", "0.5", "1200")
```

Use this to explore what your effect palette *feels* like before
wiring it into your game loop.

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
| `loveweb:achievements:state`   | `{ unlocks: [{ key, unlockedAt, points }], identity }`   | Current unlock state + LÖVE identity; parent writes the file at `<save-root>/<identity>/__loveweb__/achievements.json`. |
| `loveweb:achievement:ack`      | `{ key, fresh, points }`                                 | Confirms an unlock landed server-side.                |
| `loveweb:saves:list`           | `{ reqId, files: [{ path, updated_at, meta? }] }`        | Response to a `loveweb:save:list` request.            |
| `loveweb:identity`             | `{ identity: { signedIn, userId?, handle?, avatar? } }`  | Player identity. Runtime writes to `__loveweb__/identity.json` before `love.load`. |
| `loveweb:net:hello`            | `{ roomId, mode, state, stateVersion, at }`              | Room SSE handshake. Runtime writes `__loveweb__/net/room.json` and resets the inbox. |
| `loveweb:net:event`            | `{ event: NetEvent }`                                    | Single delivered room event. Appended to `__loveweb__/net/inbox.jsonl`. |
| `loveweb:net:roster`           | `{ roomId, members: NetRosterEntry[] }`                  | Live roster snapshot. Written to `__loveweb__/net/roster.json`. |
| `loveweb:net:closed`           | `{ roomId }`                                             | Room subscription ended (left or evicted).            |
| `loveweb:net:disconnected`     | `{ roomId }`                                             | SSE dropped; browser is reconnecting in the background. |
| `loveweb:net:create:result`    | `{ reqId?, ok, room?, error? }`                          | Response to a `[[LOVEWEB_NET]]create`. Written to `__loveweb__/net/last_result.json`. |
| `loveweb:net:join:result`      | `{ reqId?, ok, room?, error? }`                          | Response to a `[[LOVEWEB_NET]]join`. Written to `__loveweb__/net/last_result.json`. |
| `loveweb:net:leave:result`     | `{ reqId?, ok }`                                         | Response to a `[[LOVEWEB_NET]]leave`.                 |
| `loveweb:net:send:result`      | `{ reqId?, ok, event?, error? }`                         | Response to a `[[LOVEWEB_NET]]send`. Includes 429 rate-limit errors. |
| `loveweb:net:state:result`     | `{ reqId?, ok, state?, version?, error? }`               | Response to a `[[LOVEWEB_NET]]state`. 409 on version conflict. |
| `loveweb:net:list:result`      | `{ reqId?, rooms: RoomSummary[] }`                       | Response to a `[[LOVEWEB_NET]]list`.                  |
| `loveweb:net:slug_hello`       | `{ slug, mode, at }`                                     | Slug-stream handshake. Runtime resets `__loveweb__/slug/global_inbox.jsonl`. |
| `loveweb:net:slug_event`       | `{ event: NetEvent }`                                    | Slug-tier event (mirrored room verb or explicit broadcast). Appended to `__loveweb__/slug/global_inbox.jsonl`. |
| `loveweb:net:slug_presence`    | `{ presence: { slug, activeUsers, totalRooms, last24hUsers, allTimeUsers, topUsers } }` | ~8s presence snapshot. Written to `__loveweb__/slug/active.json`. |
| `loveweb:net:broadcast:result` | `{ reqId?, ok, event?, error? }`                         | Response to a `[[LOVEWEB_NET]]broadcast`. Rate-limit errors land here. |
| `loveweb:net:slug_state:result`| `{ reqId?, ok, state?, version?, error? }`               | Response to a `[[LOVEWEB_NET]]slug_state`. Mirrored to `__loveweb__/slug/state.json` on success. |
| `loveweb:net:profile:result`   | `{ reqId?, ok, userId, handle?, avatar?, profile?, profileUpdatedAt?, error? }` | Response to a `[[LOVEWEB_NET]]profile <userId>`. Written to `__loveweb__/net/profiles/<userId>.json` (canonical) and mirrored to `__loveweb__/profiles/<userId>.json` for older wrappers. |
| `loveweb:net:slug_presence:result` | `{ reqId?, ok, presence?, error? }`                  | Response to a `[[LOVEWEB_NET]]slug_presence` request. Same shape as the streamed snapshot. |

### Runtime iframe → parent (portal)

| Message type                    | Payload                                                 | Purpose                                                 |
|---------------------------------|---------------------------------------------------------|---------------------------------------------------------|
| `loveweb:hello`                 | `{ game }`                                              | Iframe parsed; WASM init about to start.                |
| `loveweb:ready`                 | `{ game }`                                              | `love.run` is active; heartbeats start.                 |
| `loveweb:save:write`            | `{ path, dataB64, meta }`                               | Pushes a MEMFS change to the server.                    |
| `loveweb:save:read`             | `{ path, reqId }`                                       | Requests a cloud save file on-demand.                   |
| `loveweb:save:list`             | `{ reqId }`                                             | Requests the full list of cloud save files for this game. Parent replies with `loveweb:saves:list`. |
| `loveweb:log`                   | `{ level, msg }`                                        | Routed from Lua `print`/`printErr`.                     |
| `loveweb:achievement:unlock`    | `{ key, meta }`                                         | Produced by the `[[LOVEWEB_ACH]]unlock` magic print.    |
| `loveweb:fx`                    | `{ verb, args[] }`                                      | Produced by `[[LOVEWEB_FX]]<verb> <args...>` magic prints. Parent applies UI effects (flash, shake, mood, shatter, calm, pulsate, ripple, etc.). See **Runtime UI effects** above. |
| `loveweb:quit`                  | `{ status, reason }`                                    | Clean-exit signal — emitted by the runtime shell when `love.event.quit()` flows through Module.quit / onExit. Parent overlays a "session ended" card and routes back to the library. |
| `loveweb:net:create`            | `{ name?, visibility?, capacity?, state? }`             | Produced by `[[LOVEWEB_NET]]create <name>`. Parent calls `POST /api/net/rooms` and auto-joins. |
| `loveweb:net:join`              | `{ code? \| roomId? }`                                  | Produced by `[[LOVEWEB_NET]]join <CODE>`. Parent calls `POST /api/net/rooms/join`. |
| `loveweb:net:leave`             | `{}`                                                    | Produced by `[[LOVEWEB_NET]]leave`. Tears down SSE.     |
| `loveweb:net:send`              | `{ verb, payload?, target? }`                           | Produced by `[[LOVEWEB_NET]]send <verb> [--target=<userId>] <json>`. Optional `target` makes it unicast. |
| `loveweb:net:state`             | `{ patch, expectedVersion?, replace? }`                 | Produced by `[[LOVEWEB_NET]]state <patch>`. Mutates persistent state. |
| `loveweb:net:list`              | `{}`                                                    | Produced by `[[LOVEWEB_NET]]list`. Parent calls `GET /api/net/rooms`. |
| `loveweb:net:broadcast`         | `{ verb, payload? }`                                    | Produced by `[[LOVEWEB_NET]]broadcast <verb> <json>`. Slug-wide fanout (no room required). |
| `loveweb:net:slug_state`        | `{ patch, expectedVersion?, replace? }`                 | Produced by `[[LOVEWEB_NET]]slug_state <patch>`. Mutates the slug-scoped JSONB blob. |
| `loveweb:net:profile`           | `{ userId }`                                            | Produced by `[[LOVEWEB_NET]]profile <userId>`. Fetches a peer's `public_profile.json`. |
| `loveweb:net:slug_presence`     | `{ rankBy?, limit? }`                                   | Produced by `[[LOVEWEB_NET]]slug_presence [<rankBy> [<limit>]]`. Forces a fresh presence refresh. |

`NetEvent` shape:

```ts
{
  id:      string,            // monotonic; tail by comparing to a watermark
  roomId:  string,
  userId:  string | null,     // null on portal-issued system events
  handle:  string | null,
  avatar:  string | null,
  verb:    string,            // game-defined ('move', 'shout', 'attack', ...)
                              // or reserved: 'join' | 'leave' | 'state'
  payload: any,
  ts:      number             // ms since epoch
}
```

`NetRosterEntry` shape:

```ts
{
  userId:   string,
  handle:   string,
  avatar:   string | null,
  joinedAt: number,           // ms since epoch
  lastSeen: number            // ms since epoch
}
```

From Lua you interact with this protocol via:

- `love.filesystem.*` — transparently triggers `loveweb:save:*`.
- `print("[[LOVEWEB_ACH]]unlock <key>")` — emits
  `loveweb:achievement:unlock`.
- `love.filesystem.read("__loveweb__/achievements.json")` — reads
  state delivered via `loveweb:achievements:state`.
- `print("[[LOVEWEB_NET]]<verb> <args>")` — emits
  `loveweb:net:<verb>`. Responses + delivered events are mirrored
  into files in `__loveweb__/net/` (see **Multiplayer & shared world**).
- `love.filesystem.read("__loveweb__/identity.json")` — reads the
  current player identity (handle, userId, avatar).

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

This spins a headless browser (Chromium by default; pass `firefox` or
`webkit` as the second arg to pick another), serves the runtime dir
over plain HTTP, loads it, captures ~12 s of logs + postMessages, and
exits non-zero if:

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
     identity: "your_game",        // match conf.lua t.identity exactly.
                                   //   optional — defaults to slug with
                                   //   dashes → underscores. Setting
                                   //   this explicitly is required if
                                   //   your t.identity differs from
                                   //   that derivation (otherwise the
                                   //   portal can't find your save dir
                                   //   and __loveweb__/achievements.json
                                   //   won't be reachable from Lua).
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
  -- identity must match the `identity:` field in your GameEntry PR
  -- (or the default: your slug with dashes → underscores). Dashes
  -- aren't allowed in Lua filesystem path conventions here — use
  -- underscores to match the portal's default.
  t.identity          = "your_game"
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
- [ ] `conf.lua` has `t.identity` set to a stable string that **matches
      the `identity:` field** in your portal `GameEntry` PR (or the
      default derivation `slug.replaceAll("-", "_")`).
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

### `__loveweb__/achievements.json` is missing / empty when read from Lua

The portal can't find your save dir. This happens when your
`conf.lua` `t.identity` doesn't match the `identity` field in your
`GameEntry` on the portal side (or doesn't match the default
derivation of `slug.replaceAll("-", "_")`). Fix: set `identity:` in
your `GameEntry` to exactly the value of `t.identity` in your
`conf.lua`, ship the PR, wait for the next deploy.

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
