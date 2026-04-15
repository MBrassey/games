# games.brassey.io

<p align="center">
  <img src="public/brand/logo-wide.svg" alt="GAMES :: BRASSEY — a terminal for LÖVE2D // web native" width="100%">
</p>

<p align="center">
  <a href="https://games.brassey.io"><img alt="Live" src="https://img.shields.io/badge/live-games.brassey.io-66e0ff?labelColor=030208&style=flat-square"></a>
  <a href="./LICENSE"><img alt="License: CC0-1.0" src="https://img.shields.io/badge/license-CC0--1.0-8a4fff?labelColor=030208&style=flat-square"></a>
  <img alt="Stack" src="https://img.shields.io/badge/stack-Next.js%2015%20%C2%B7%20Auth.js%20%C2%B7%20love.js-33ff66?labelColor=030208&style=flat-square">
  <img alt="Host" src="https://img.shields.io/badge/host-Vercel%20only-ff6bd6?labelColor=030208&style=flat-square">
</p>

A dark-terminal portal for LÖVE2D games, running in the browser via
[love.js](https://github.com/Davidobot/love.js). Features: GitHub sign-in,
cross-device save sync, a global chat channel spanning every title,
playtime telemetry, public per-user profiles, a game→portal UI-effects
protocol (games can flash/shake/ripple/shatter the whole viewport),
Steam-style live achievement toasts, synthesized UI SFX, and a
procedural-EDM soundtrack that never repeats.

Deployed at [games.brassey.io](https://games.brassey.io). Hosted on Vercel;
Postgres via Neon, Redis via Upstash, auth via Auth.js (self-hosted
library, no auth-as-a-service dependency).

Portal code: [CC0](./LICENSE). Games: each under its own license.

---

## Games on the portal

> The majority of titles on `games.brassey.io` come from
> **[@ThePearlKing](https://github.com/ThePearlKing)** — primary game
> developer for the platform. His game repos are the source of truth.
> A GitHub Actions workflow
> ([`.github/workflows/upstream-games-watch.yml`](./.github/workflows/upstream-games-watch.yml))
> polls every 10 minutes; the moment any watched repo advances, the
> portal is redeployed and the newest game code ships automatically.
> New features, tweaks, and fixes land on the live site without any
> manual step.

<table>
  <tr>
    <td width="50%" valign="top">
      <h3>
        <a href="https://github.com/ThePearlKing/claude-mythos-game">
          Claude: Mythos
        </a>
      </h3>
      <p>
        <em>An eldritch bullet-survivor descent into the void sea.</em>
      </p>
      <p>
        Wave-based arcade survivor threaded with eldritch horror. Navigate
        the void sea, build decks of cosmic powers, and hold the line
        against the rising tide.
      </p>
      <p>
        <strong>Developer:</strong>
        <a href="https://github.com/ThePearlKing">@ThePearlKing</a><br/>
        <strong>Source:</strong>
        <a href="https://github.com/ThePearlKing/claude-mythos-game">
          github.com/ThePearlKing/claude-mythos-game
        </a><br/>
        <strong>Tags:</strong> bullet-hell · roguelite · eldritch · cards<br/>
        <strong>Play:</strong>
        <a href="https://games.brassey.io/games/claude-mythos">
          games.brassey.io/games/claude-mythos
        </a>
      </p>
    </td>
    <td width="50%" valign="top">
      <h3>Add your own</h3>
      <p>
        The portal is built to onboard new titles with a single entry in
        <code>src/lib/games.ts</code>, pointing at any LÖVE2D GitHub repo.
        The build pipeline handles the rest: clones the source, applies
        LuaJIT → Lua 5.1 compat patches, packs a <code>.love</code>,
        compiles via love.js, and drops it into
        <code>public/games/&lt;slug&gt;/runtime/</code> on every deploy.
      </p>
      <p>
        See <a href="#adding-a-new-game">Adding a new game</a> below for
        the one-line registry entry.
      </p>
    </td>
  </tr>
</table>

---

## Brand assets

- **Icon / favicon** — [`public/favicon.svg`](./public/favicon.svg) · 32×32 version of the mark.
- **Square logo** — [`public/brand/logo.svg`](./public/brand/logo.svg) + [`logo.png`](./public/brand/logo.png) · 512×512, bracketed-chrome frame, hex mark with inner spokes and glowing cyan core.
- **Wide wordmark** — [`public/brand/logo-wide.svg`](./public/brand/logo-wide.svg) + [`logo-wide.png`](./public/brand/logo-wide.png) · 1600×400, usable as OG image or header banner.

<p>
  <a href="./public/brand/logo.svg">
    <img src="public/brand/logo.svg" alt="logo" height="160" align="left">
  </a>
  The mark is a hexagonal node — one central cyan core, three spokes into
  three violet nodes, scanlined CRT plate, bracketed corner chrome. Palette
  lifted from <em>Claude: Mythos</em>: void purples, abyss cyan, matrix green,
  blood red.
</p>

<br clear="left">

## Contents

1. [Games on the portal](#games-on-the-portal)
2. [Architecture at a glance](#architecture-at-a-glance)
3. [Stack](#stack)
4. [Data model](#data-model)
5. [Authentication](#authentication)
6. [The game build pipeline](#the-game-build-pipeline)
7. [Runtime bridge (iframe ↔ portal)](#runtime-bridge-iframe--portal)
8. [Save-state sync](#save-state-sync)
9. [Chat system (SSE + KV pub/sub)](#chat-system-sse--kv-pubsub)
10. [Presence, multiplayer, and Vercel's WebSocket limit](#presence-multiplayer-and-vercels-websocket-limit)
11. [Telemetry and stats](#telemetry-and-stats)
12. [Achievements](#achievements)
13. [Audio engine](#audio-engine)
14. [Visual theme and effects](#visual-theme-and-effects)
15. [Adding a new game](#adding-a-new-game) · see also [INTEGRATION.md](./INTEGRATION.md)
16. [Local development](#local-development)
17. [Vercel setup](#vercel-setup)
18. [GitHub OAuth](#github-oauth)
19. [Namecheap DNS](#namecheap-dns)
20. [Troubleshooting](#troubleshooting)
21. [File layout](#file-layout)
22. [Scripts](#scripts)
23. [License](#license)

---

## Architecture at a glance

```
┌──────────────────────────────── games.brassey.io ────────────────────────────────┐
│                                                                                  │
│   ┌────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐        │
│   │  Library   │   │ /games/<id>  │   │   /stats     │   │ /u/<handle>  │        │
│   │  (catalog) │   │ (runner)     │   │ (own telem)  │   │ (pub profile)│        │
│   └─────┬──────┘   └──────┬───────┘   └──────┬───────┘   └──────┬───────┘        │
│         │                 │                  │                  │                │
│         │  ┌──────────────┼──────────────────┼──────────────────┼───────────┐    │
│         │  │                     Next.js 15 App Router                      │    │
│         │  │  top bar · chat drawer · particle FX · UiEffects overlay       │    │
│         │  │  procedural-EDM soundtrack · SFX bus · shake/zoom wrapper      │    │
│         │  └──────────────┬──────────────────┬──────────────────┬───────────┘    │
│         │                 │                  │                  │                │
│   ┌─────▼─────┐     ┌─────▼──────┐      ┌────▼─────┐      ┌─────▼──────┐         │
│   │/api/saves │     │/api/chat/  │      │/api/stats│      │/api/auth/  │         │
│   │ (CRUD)    │     │ send·stream│      │ heartbeat│      │ next-auth  │         │
│   └─────┬─────┘     └─────┬──────┘      └────┬─────┘      └─────┬──────┘         │
│         │                 │                  │                  │                │
│   ┌─────▼─────────────────▼──────────────────▼──────────────────▼──────┐         │
│   │                         Postgres (Neon)                            │         │
│   │  users · accounts · sessions · user_profiles · user_preferences    │         │
│   │  game_saves · game_sessions · chat_messages · chat_presence        │         │
│   │  user_achievements (per-user unlock records)                       │         │
│   └──────────────────────────┬─────────────────────────────────────────┘         │
│                              │                                                   │
│                        ┌─────▼──────┐                                            │
│                        │  Vercel KV │  stream:<channel> (list) + seq:<channel>   │
│                        │  (Upstash) │  pub/sub fanout for SSE chat stream        │
│                        └────────────┘                                            │
│                                                                                  │
└───────────────────────────────────▲──────────────────────────────────────────────┘
                                    │
                         ┌──────────┴──────────┐
                         │  love.js iframe     │   postMessage bridge
                         │  (WASM + Lua)       │   save read/write · ready · log
                         └──────────▲──────────┘
                                    │
                         ┌──────────┴──────────┐       Game sources pulled fresh from
                         │  github.com/<you>/  │──────▶ GitHub at every Vercel build
                         │  <your-love-game>   │        via scripts/build-games.mjs
                         └─────────────────────┘
```

At a high level:

- **Portal** renders library, game runner, stats, profiles, and chat.
- **Games** are pulled from GitHub at build time, patched for Lua 5.1
  (love.js drops LuaJIT), compiled to WASM via `love.js`, and embedded in
  sandboxed iframes. A `postMessage` bridge translates LÖVE filesystem
  writes into HTTP calls to `/api/saves`.
- **Chat + presence** runs over Server-Sent Events with Vercel KV as the
  pub/sub fanout layer. Postgres keeps the scrollback.
- **Stats** come from heartbeats the runner pings every 30 seconds;
  aggregated with Postgres window queries.

---

## Stack

```
Next.js 15 (App Router, React 19) on Vercel
Tailwind CSS 3 · TypeScript 5
Auth.js v5 + GitHub provider (self-hosted library)
Vercel Postgres (Neon)  ── users · saves · chat history · sessions
Vercel KV (Upstash Redis) ── pub/sub fanout + presence
Server-Sent Events       ── realtime chat delivery (Node runtime)
love.js (WASM + Lua 5.1) ── embedded per-game runtime
Web Audio API            ── synthesized SFX + procedural soundtrack
Playwright (dev-only)    ── headless smoke test for game runtimes
```

Zero vendor services you sign up for separately. Neon and Upstash are
marketplace integrations billed through Vercel as a single line.

---

## Data model

All schema lives in `migrations/*.sql` — applied in order, tracked in
`_migrations`. Idempotent by design (`CREATE TABLE IF NOT EXISTS`).

### Auth.js tables (`0001_init.sql`)

- `users` — `id SERIAL`, `name`, `email`, `image`.
- `accounts`, `sessions`, `verification_token` — managed by Auth.js's
  [Postgres adapter](https://authjs.dev/getting-started/adapters/pg).

### Portal-specific (`0001_init.sql`, extended in `0003_profile_github.sql`)

- `user_profiles` — one row per user. Extended profile pulled from GitHub
  at sign-in: `handle`, `avatar_url`, `github_login`, `github_id`,
  `bio`, `location`, `blog`, `company`, `twitter`, `public_repos`,
  `followers`, `github_html_url`, `accent_color`, plus timestamps.
- `user_preferences` — free-form `JSONB` for per-user portal settings.

### Saves and sessions (`0001_init.sql`, `0002_stats.sql`)

- `game_saves` — primary key `(user_id, game_slug, path)`. Each row holds
  one virtual filesystem file as base64 text in `data` plus `meta JSONB`.
- `game_sessions` — one row per continuous play session. Heartbeats from
  the runner bump `last_heartbeat`; gaps of more than 2 minutes start a
  new session. Playtime = `SUM(last_heartbeat - started_at)`.

### Achievements (`0004_achievements.sql`)

- `user_achievements` — primary key `(user_id, game_slug, achievement_key)`.
  Records *who unlocked what and when*; `points` is snapshotted at unlock
  time so catalog bumps don't retroactively change earned totals, and
  `meta JSONB` stores any game-supplied context (run id, seed, score).
  Catalog definitions themselves live per-game in `achievements.json` at
  the game's repo root — see [Achievements](#achievements).

### Chat (`0001_init.sql`)

- `chat_messages` — `BIGSERIAL id`, `channel`, `user_id`, `body`, `kind`,
  `created_at`. Indexed by `(channel, created_at DESC)`.
- `chat_presence` — heartbeat per user with `current_channel`.

### Optional registry

- `game_registry` — in-DB toggle for enabling/disabling games without
  redeploying. Source of truth for now is `src/lib/games.ts`, but the
  table exists for a future admin flow.

---

## Authentication

[Auth.js v5](https://authjs.dev) (self-hosted library, not a service) with
**GitHub** as the single provider. The Postgres adapter stores sessions in
the `sessions` table, so we use the database session strategy (not JWT).

On every sign-in, `events.signIn` in `src/lib/auth.ts` pulls the full
GitHub OAuth profile (`login`, `avatar_url`, `bio`, `location`, `blog`,
`company`, `twitter_username`, `public_repos`, `followers`, `html_url`)
and upserts it into `user_profiles`. Result: every user has a full public
profile without ever filling out a form.

There is no manual profile editor; GitHub is the source of truth.

---

## The game build pipeline

Games are **pulled from GitHub** on every Vercel deploy. No game source
lives in this repo. The pipeline lives in three scripts:

### 1. `scripts/web-compat-patch.mjs` — LuaJIT → Lua 5.1

Native LÖVE uses LuaJIT. love.js uses vanilla **Lua 5.1** (LuaJIT's trace
compiler can't be built to WebAssembly). Lua 5.1 doesn't support `goto` +
`::label::`, so any LÖVE game using the standard "continue" idiom breaks.

The patcher is a scope-aware parser: it tracks block scopes (`function`,
`for`, `while`, `repeat`, `do`, `if/then`), finds each `::LABEL::` and
every matching `goto LABEL`, picks the innermost common enclosing scope,
and wraps its body in `repeat ... until true`. `goto` becomes `break`,
and the label is removed. The result compiles identically under both Lua
runtimes, so the same source runs on desktop (LuaJIT) and the web (plain
5.1). Verified with `luac -p`. Idempotent.

### 2. `scripts/make-love.mjs` — zero-dep zipper

Packages a directory tree into a `.love` archive (which is a zip) using
only Node's built-in `zlib.deflateRaw`. No `zip` CLI dependency, no
`archiver` npm package — just a minimal ZIP container writer.

### 3. `scripts/build-games.mjs` — the orchestrator

For every game registered in `src/lib/games.ts`:

1. **Shallow-clone** the repo at the configured `ref` into
   `.cache/game-src/<slug>`. Subsequent builds `git fetch` + `reset --hard
   FETCH_HEAD` to snap to the current tip.
2. Run the compatibility patcher into `.cache/game-patched/<slug>`.
3. Pack the patched tree into `.cache/game-love/<slug>.love`.
4. Invoke `npx love.js@11 -c -t "<title>" <.love> <out>` — love.js ships
   its own pre-built emscripten WASM, so no system Emscripten install is
   required. Works on Vercel's build environment unmodified.
5. Copy the output (`love.js`, `love.wasm`, `game.js`, `game.data`,
   `theme/`) into `public/games/<slug>/runtime/` and overwrite
   `index.html` with the bridge-enabled template from
   `templates/love-runtime-index.html`.

This runs as a `prebuild` hook in `package.json`, so every `next build`
(including Vercel deploys) automatically pulls and rebuilds every game.

> The `game.js` file carries the preload manifest (UUID, size, file list)
> for `game.data`. Skipping it was the source of a day of "black screen /
> Cannot load /./game.love" debugging — we always copy all four files now.

The compiled runtimes are **.gitignored**. They're regenerated on every
deploy, so the latest `main` of each game repo is what ships.

---

## Runtime bridge (iframe ↔ portal)

Each game runs in a sandboxed `<iframe>` (`allow-scripts allow-same-origin
allow-pointer-lock allow-popups allow-forms`). The iframe loads
`/games/<slug>/runtime/index.html`, which is a **modified version** of the
default love.js HTML.

The modifications:

1. **Canvas visibility** is forced visible with `!important` — default
   `theme/love.css` hides it until `setStatus` unhides, and our custom
   `setStatus` had to be adjusted to do the same.
2. `Module` is declared with `var` (not `const`) so `game.js` can
   re-declare + merge into it without a `SyntaxError`.
3. A `preRun` hook pre-populates the Emscripten virtual FS from
   cloud-stored saves before `love.filesystem` reads anything.
   love.js's save dir sits at `/home/web_user/love/<identity>/` — an
   emscripten-specific flat layout (not the Linux
   `~/.local/share/love/<id>/` XDG convention). The template's
   `SAVE_ROOT` is `/home/web_user/love` and it walks one level deeper
   to each game's identity dir.
4. A `postRun` hook polls the save directory every 2 seconds, diffs
   `mtime`, and posts changes up to the parent.
5. All LÖVE `print`/`printErr` output is routed to the parent via
   `postMessage` as `loveweb:log` events. Two magic-print prefixes
   are intercepted: `[[LOVEWEB_ACH]]` for achievement unlocks and
   `[[LOVEWEB_FX]]` for runtime UI effects.

### Protocol

```
parent → runtime:
  { type: "loveweb:auth",                signedIn: boolean }
  { type: "loveweb:saves:manifest",      files: [{ path, updated_at }] }
  { type: "loveweb:save:data",           reqId, dataB64 | null }
  { type: "loveweb:saves:list",          reqId, files: […] }
  { type: "loveweb:achievements:state",  unlocks: [{ key, unlockedAt, points }], identity }
  { type: "loveweb:achievement:ack",     key, fresh, points }

runtime → parent:
  { type: "loveweb:hello",               game: slug }
  { type: "loveweb:ready",               game: slug }
  { type: "loveweb:save:write",          path, dataB64, meta }
  { type: "loveweb:save:read",           path, reqId }
  { type: "loveweb:save:list",           reqId }
  { type: "loveweb:log",                 level, msg }
  { type: "loveweb:achievement:unlock",  key, meta }
  { type: "loveweb:fx",                  verb, args[] }
  { type: "loveweb:quit",                status, reason }
```

The `identity` field on `loveweb:achievements:state` is load-bearing —
the runtime uses it to write the `__loveweb__/achievements.json` meta
file *inside* the game's save-dir (so the game can read it with plain
`love.filesystem.read(...)`). It's piped in from the game's
`GameEntry.identity` in `src/lib/games.ts` (default: slug with
dashes converted to underscores).

Achievement unlocks also support a **magic-print** escape hatch for Lua
code that doesn't want to touch the JS bridge directly: emitting
`print("[[LOVEWEB_ACH]]unlock <key>")` from Lua is intercepted by the
runtime's stdout hook and forwarded as a `loveweb:achievement:unlock`
message. See [Achievements](#achievements) for the full spec.

### Clean exit — `love.event.quit()`

The runtime shell wires `Module.quit`, `Module.onExit`, and
`Module.onAbort` so `love.event.quit()` from Lua flows out as a single
`loveweb:quit` message to the parent. `GameRunner` responds by playing a
confirm chime, overlaying a "session :: ended" card over the canvas, and
router-pushing back to `/` after ~1.4s — zero postMessage plumbing
required on the game side. An always-visible "↩ exit" handle over the
top-right of the iframe (plus a full button in the status bar) serves as
a hard escape hatch if the Lua runtime itself has frozen.

### Game → UI effects

Games can reach out and modulate the surrounding portal chrome (topbar,
chat drawer, whole viewport) via a second magic-print namespace:
`print("[[LOVEWEB_FX]]<verb> <args...>")`. The `UiEffects` component
(mounted at the root layout) subscribes and applies the effects to a
stack of fixed overlays + a shake/zoom transform wrapper. Verbs include:

- **flash · shake · invert · chroma · flicker · zoom · scanlines** —
  one-shot dramatic modulations.
- **tint · vignette · glow · pulse · ripple** — one-shot with fade.
- **mood · calm · pulsate** — persistent states (boss fight, sanctuary,
  heartbeat) with explicit `off` / `none` clearing.
- **shatter** — composite flash + chroma + shake + glass-crack overlay
  for death / defeat beats.

All effects are duration-clamped (≤2.5 s), intensity-clamped (0..1),
anti-strobe-floored, pointer-events-none, and honor
`prefers-reduced-motion`. Every page exposes `window.__portalFx(verb,
...args)` for devtools verification. Full author-facing docs:
[INTEGRATION.md → Runtime UI effects](./INTEGRATION.md#runtime-ui-effects).

The `GameRunner` React component holds the parent side of the bridge in
`src/components/GameRunner.tsx`.

### Sizing

The iframe wrapper uses a width/height constraint that keeps the canvas
at its native 16:9 without overflowing the viewport:

```css
max-height: calc(100vh - 200px);
width: min(100%, calc((100vh - 200px) * 16 / 9));
aspect-ratio: 16 / 9;
```

Canvas uses `image-rendering: auto` (not `pixelated`) so vector fonts
stay crisp on non-integer scale.

---

## Save-state sync

`love.filesystem.read` / `write` calls go to Emscripten's in-memory
filesystem (MEMFS) inside the iframe. The bridge turns that into durable
storage:

- **On game start:** the runner fetches `GET /api/saves?game=<slug>` and
  posts the manifest to the runtime. The runtime fetches each file's
  contents via `loveweb:save:read` round-trips and writes them into
  MEMFS before LÖVE boots.
- **While playing:** the runtime polls the save directory every 2 s, and
  any file whose mtime changes is sent up as `loveweb:save:write`. The
  runner forwards to `PUT /api/saves` which upserts into `game_saves`.
- **On unload:** `beforeunload` flushes every save file one last time
  with `keepalive: true`.

Saves are keyed `(user_id, game_slug, path)` in Postgres as base64 text
in a `TEXT` column, so any device the user signs in on sees identical
save state. No code changes required in the Lua game — it just uses
`love.filesystem` as normal.

---

## Chat system (SSE + KV pub/sub)

Vercel **does not host persistent WebSockets** at the serverless edge,
but it *does* allow long-lived streaming responses. Chat uses
Server-Sent Events fanning out from Vercel KV:

### Write path — `POST /api/chat/send`

1. Insert into `chat_messages` (Postgres). Returns `id`, `created_at`.
2. Look up sender handle + avatar from `user_profiles` (fallback to
   Auth.js session data).
3. Construct the outbound `ChatMsg` object.
4. `LPUSH stream:<channel>` (capped to 200 via `LTRIM`) — this is the
   ring buffer for late joiners.
5. `INCR seq:<channel>` — monotonic counter SSE clients diff against.

### Read path — `GET /api/chat/stream?channels=a,b,c`

1. Authenticates via Auth.js session cookie; 401 if not signed in.
2. Opens a `ReadableStream` with SSE headers.
3. Emits `event: hello` + a backfill of the last ~20 messages per
   channel — from `LRANGE stream:<ch> 0 19` on the KV path, or from
   `chat_messages` ordered by id on the Postgres fallback path.
4. Poll loop with adaptive backoff:
   - KV path: one `MGET` collapses every channel's `seq:*` into a
     single command per poll; on any advance, `LRANGE` the delta
     and emit `event: chat` frames. Base 1.5 s cadence when active,
     exponential idle back-off up to 10 s.
   - Postgres fallback: triggered transparently if KV is down or
     throws (e.g. Upstash's free-tier 500k/day cap). Polls
     `chat_messages` by an id watermark at 1.2 s active / 8 s idle.
     Delivery stays correct; latency degrades from ~1.5 s → ~1.2 s
     (the DB path is actually snappier, just "spendier" per client).
5. Sends `: ping` comments every 15 s to keep the connection warm.
6. Auto-closes on client disconnect; the client reconnects in 2 s.

The send path (`POST /api/chat/send`) persists to Postgres first and
treats KV fanout as best-effort — so a KV outage doesn't swallow
messages, and the sender's own row optimistically appends to the
local feed from the send response.

Vercel function `maxDuration` is set to 300 s in `vercel.json` for this
route on Pro; Hobby plans cap it at 60 s. The client transparently
reconnects either way.

### Channels

- `chat:global` — portal-wide. Everyone signed in, across every game.
- `chat:game:<slug>` — auto-joined when the user is on a game's page.

### Rendering

The `ChatDrawer` is a semi-transparent sidebar fixed to the right
(vertical void gradient `from-void-0/35 via-void-0/20 to-void-0/35`
with `backdrop-blur-[1px]`). Transparent enough that the
`BackgroundFX` starfield drifts through the chat column while the
chrome still has weight.

Each message renders with a **rounded-square, glowing-border avatar**
colored by a deterministic hash of the user's handle (same color
everywhere they appear — chat, stats hero, top bar). The message body
is syntax-highlighted in a bash-terminal palette: URLs as links,
`` `code` `` in amber, `"strings"` in green, `@mentions` in magenta,
`#channels` in yellow, `/commands` in red, numbers in purple.

**Per-user chimes.** Incoming messages play `sound.notifyAs(handle)` —
an FNV-1a hash of the sender's handle selects a pitch in D dorian
(two-octave range), so every operator has a recognizable tone that
still lands musically against the procedural-EDM soundtrack (same
key). Fresh messages
also trigger a brief accent-colored border flash (`.chat-msg[data-fresh="true"]`
animates for 900 ms) and a short haptic vibration on mobile. Chat
history is hard-gated behind auth on the client too — unauthenticated
visitors see only an "uplink sealed" callout, never any handles or
message bodies.

Handles are **clickable** and link to `/u/<handle>` — a public profile
page with full GitHub-derived bio and 30-day stats.

Chat rows use subtle zebra-striping (`bg-eldritch-deep/10` alternating
with transparent) and hover highlights.

---

## Presence, multiplayer, and Vercel's WebSocket limit

Vercel **cannot** host persistent 60 Hz WebSocket servers. SSE + KV gives
us everything we need for:

- global chat (done),
- per-game chat channels (done),
- presence (users currently in a channel),
- turn-based games,
- slow-tick MMORPG-style overworlds (5-10 Hz).

For twitchy PvP action sync, the path is a separate self-hosted socket
server (Fly.io free tier, or $5 VPS) signaled through the existing SSE
channels. The portal itself stays on Vercel; only the specific game that
needs 60 Hz sync spins up its own socket server.

---

## Telemetry and stats

### Heartbeat

The `GameRunner` component pings `POST /api/stats/heartbeat` every 30
seconds while a game is open. The endpoint either:

- bumps `last_heartbeat` on the most recent `game_sessions` row for
  that `(user_id, game_slug)` if the gap is under 2 minutes, or
- inserts a new session row.

### Stats endpoint — `GET /api/stats`

Authenticated. Aggregates the current user's data:

- **Totals**: total playtime in seconds, session count, unique game
  count, save count, chat message count.
- **Per-game**: playtime, sessions, saves, last played, for every game
  the user has touched.
- **30-day activity**: bucketed by day via Postgres
  `generate_series('now' - interval '29 days', 'now', 'interval 1 day')`
  — one row per day even if the user did nothing that day (clean chart
  axes). Each bucket clips session time at day boundaries using
  `LEAST/GREATEST`.
- **Recent saves** and **recent sessions**: last 10 of each, for the
  scrollback lists.

### Public profiles — `/u/[handle]`

Server component that looks up a user by handle or github_login, pulls
the same aggregate queries (no auth required), and renders the stats
hero + charts. All handles in chat link here.

### Leaderboard rank medallions

The rank column is tier-aware: **podium** (1–3) gets a large numeral
with a breathing glow in the medal color (gold / silver / bronze),
**high** (4–10) gets a medium purple-glowed numeral, and **low**
(11+) stays subdued. Every rank cell also runs a **continuous 10-second
shimmer cycle** — a tier-colored highlight sweeps across the numeral
for ~1.3 s, then idles for ~8.7 s. Rows stagger 0.7 s apart (set
inline as `--shimmer-delay`), so the board ripples top-to-bottom like
a slow neon sign rather than pulsing in unison. Tie-break order
prioritizes achievement points: playtime → achievement points →
sessions → messages → user id.

### Charts

Hand-rolled SVG, no chart library. `ActivityChart` renders 30 purple
playtime bars + a cyan "messages" line with a glow filter, dithered
grid, mono axis labels. `PerGameChart` is a horizontal bar chart with a
purple→cyan gradient per row. Everything is styled to match the CRT
terminal aesthetic.

---

## Achievements

Every game on the portal can publish its own achievements, and the
portal surfaces them on the player's stats page, on public profiles,
and on the leaderboard — with the games themselves needing only a JSON
file and a single `print` line.

The full author-facing spec lives in
[`docs/ACHIEVEMENTS.md`](./docs/ACHIEVEMENTS.md). The portal-side
wiring works like this:

### Catalog — shipped with the game

Each game declares its catalog in `achievements.json` at its repo root,
using the schema documented in the spec above. The build pipeline
(`scripts/build-games.mjs`) mirrors this file into
`public/games/<slug>/achievements.json` during every deploy, alongside
the compiled runtime bundle. The same file is also bundled into the
`.love` so the game can read its own definitions with
`love.filesystem` at runtime. One file, two readers, no drift.

Optional per-achievement icons go in `achievements_icons/` next to
`achievements.json`; the whole directory is mirrored to
`public/games/<slug>/achievements_icons/` for portal rendering.

### Unlock flow

1. Lua code emits `print("[[LOVEWEB_ACH]]unlock <key>")` — no JS
   interop, no HTTP client, no auth handling.
2. The runtime shell (`templates/love-runtime-index.html`) intercepts
   the line in its `print` hook, parses the verb, and forwards
   `{ type: "loveweb:achievement:unlock", key, meta }` via
   `postMessage` to the parent.
3. `GameRunner` POSTs to `/api/achievements/unlock` with the player's
   session cookie. The endpoint **validates the key against the
   catalog** (allowlist — unknown keys are rejected 404) and upserts
   into `user_achievements` with `points` snapshotted from the catalog.
4. On success the parent re-pushes the full unlocked state to the
   iframe; the runtime re-writes the in-game metadata file so the
   game's own UI can reflect the change immediately.

Unlocks are idempotent — a replay is a no-op, `unlocked_at` never moves.

### State delivery — game reads its own unlocks

Before `main.lua` runs, the runtime pre-populates
`<save-dir>/__loveweb__/achievements.json` with
`{ version: 1, unlocks: [{ key, unlockedAt, points }, …] }`. The game
can read it with standard `love.filesystem` to paint a "locked / earned
on <date>" grid in its own UI. The runtime refreshes this file
mid-session whenever a new unlock lands.

The save-watch loop skips the `__loveweb__/` subtree so portal-managed
metadata never round-trips into `game_saves`.

### API endpoints

- `GET /api/achievements?game=<slug>` — catalog + caller's unlocks.
  Accepts `?user=<id>` to look up another user's unlocks (used by
  public profile pages).
- `GET /api/achievements` — every registered game's catalog, no user
  unlocks. For aggregate views.
- `POST /api/achievements/unlock` — body `{ game, key, meta? }`.
  Authenticated, idempotent, catalog-gated.

### Portal rendering

- **Stats page** (`/stats`) and **public profiles** (`/u/<handle>`) —
  `AchievementsPanel` renders one card per game, listing every
  catalog entry with locked/unlocked state, date, points, and rarity.
  Hidden achievements display as `???` until earned.
- **Unlocked tiles shine.** Earned achievements get a layered
  box-shadow glow that breathes on a 4.5 s cycle, a diagonal shimmer
  streak that sweeps across every 6.5 s, and a pulsing sparkle at the
  top-right corner — all tinted by rarity (common = the game's
  accent; uncommon = green; rare = cyan; legendary = gold). Legendary
  unlocks add a brighter, gold-cored glint.
- **Leaderboard** — the row adds an `achv · pts` column showing count
  and total points. Achievement points slot in as a tie-break signal
  ahead of sessions and messages, so completionists surface above
  pure idle time when playtime is tied.
- **KPI row** — a new trophy tile on both stats and profile pages
  shows total unlocks and total points earned across every game.

### Live in-game unlock toasts

The moment a game emits `print("[[LOVEWEB_ACH]]unlock <key>")` the
portal shows a **Steam-style toast** in the bottom-right of the viewport,
overlaying the iframe. It mirrors the panel glow — rarity-colored radial
icon background, entry shimmer glint (gold-cored for legendary), a
breathing rim pulse, and a synthesized fanfare chord (D-major triad up
to the octave, with a glittery high-bell tail) that slightly ducks the
ambient soundtrack.

Toasts auto-dismiss after ~5 s (click to dismiss early), stack up to 3,
fire **only on fresh unlocks** (replays are silent no-ops), and honor
`prefers-reduced-motion`. Implementation: `src/components/AchievementToast.tsx`
+ the `.ach-toast*` / `.ach-tile*` CSS in `src/app/globals.css`.

**Verifying the pipeline without a real unlock:** append
`?_test_toast=<rarity>` to any game URL (e.g.
`/games/claude-mythos?_test_toast=legendary`) to fire a synthetic toast
~1.5 s after load. Purely portal-side — no DB writes, no persistence.
Useful for preview / QA passes and for game authors checking that their
accent color reads well through the toast chrome.

### Why not a DB-backed catalog?

The file-on-disk approach means builds don't need DB access — the
portal just reads JSON at request time with mtime-keyed in-process
caching. New catalogs ship via the normal
[upstream-games-watch](#auto-deploy-on-upstream-game-pushes) workflow:
push to the game repo → portal redeploys within 10 min → new
definitions go live. No migration dance, no schema sync step.

---

## Audio engine

All sound is **synthesized live** in the browser via the Web Audio API.
No audio files. Single `SoundEngine` singleton (`src/lib/sound.ts`):

### SFX palette

| Call                 | Sound                                                                      |
|----------------------|----------------------------------------------------------------------------|
| `sound.hover()`      | Upward chirp 1400→2200 Hz + octave-up "halo" sine + highpass noise tink    |
| `sound.click()`      | Bandpassed square w/ pitch drop + noise snap + bright 3.2 kHz onset tick   |
| `sound.confirm()`    | Ascending two-note "affirmative"                                           |
| `sound.deny()`       | Descending sawtooth two-note                                               |
| `sound.notify()`     | Neutral bell ping (delegates to `notifyAs(null)`)                          |
| `sound.notifyAs(h)`  | Per-user bell — pitch derived from FNV-1a hash of handle in D dorian        |
| `sound.achievement()`| D-major arpeggio 587→740→880→1175 Hz + high-bell tail (unlock fanfare)     |
| `sound.transition()` | Filter sweep on route changes                                              |
| `sound.boot()`       | 3-note startup chime                                                       |
| `sound.key()`        | Per-keystroke micro-tick                                                   |

All UI SFX route through a dedicated `sfxBus` at unity gain (parallel
to the music bus at 0.32) so hover/click/confirm cut clearly over the
soundtrack without needing boosted peaks. Every SFX routes through a
shared 200 ms convolution reverb built from a decaying noise impulse.
The master bus sits at −6 dBFS (gain 0.55).

### Procedural EDM soundtrack

**Driving, melodic, hardware-synth-flavored.** 120 BPM, straight
16ths (no swing), D dorian. Not a fixed loop — a three-tier
procedural composer that never repeats while still generating real
melodic hooks:

- **Per super-cycle (64 bars):** one 4-chord progression is drawn
  from a pool of six (e.g. `Dm → C → F → G`, `Dm → Am → F → C`,
  `Dm → Gmaj → Bm7b5 → Cmaj9`) plus one 8-note motif from a
  pool of eight. The progression rides through the whole
  super-cycle for cohesion; new progression + motif every 64 bars.
- **Per 16-bar section:** orchestration shifts through a four-part
  arc — **intro** (pad + sub only) → **build** (half-time kick +
  hats, motif enters in second half) → **drop** (4-on-the-floor
  kick + backbeat snare + 16th hats + full saw arp + lead motif)
  → **breakdown** (pad + lead + sparse hats; let the hook breathe).
- **Per 4-bar chord:** the motif develops rather than repeats
  blindly — bar 0 & 1 play it straight, bar 2 transposes up a
  third, bar 3 ornaments a rest slot with a neighbor tone.

Hardware-flavored voices:

- **Supersaw pad** — 7 detuned sawtooth voices per note through a
  slow-opening lowpass with subtle 0.35 Hz tremolo. Classic
  progressive-house texture.
- **Resonant saw lead** — detuned double-saw + sine sub through a
  Q=3.2 lowpass whose cutoff blooms open on attack, with delayed
  vibrato that ramps in over the first 40 % of held notes.
- **Plucky arp** — single saw with Q=6 resonant lowpass sweeping
  5500 → 700 Hz per note, plus a square octave below for bite.
- **Sub bass** — sine one octave under the root + triangle on the
  root, both lowpassed at 500 Hz.
- **Kick** — sine with 180 → 45 Hz pitch-drop over 90 ms, plus a
  3 ms bandpassed noise click for transient snap.
- **Snare** — bandpassed noise burst + triangle pitch-body.
- **Hi-hat** — short highpassed noise, 8th offbeats in build, 16ths
  in the drop.

Audio routing:

```
master (0.55 headroom)
  ├── sfxBus (unity)        ── all UI SFX (hover/click/confirm/etc.)
  └── musicBus (0→0.32 ramp)
        ├── drumBus         ── kick · snare · hat   (no sidechain)
        └── melodicBus      ── pad · lead · arp · sub (sidechain-pumped)
```

**Sidechain pump** — on every kick, the `melodicBus` gain snaps to
0.38 over 40 ms and springs back to 1.0 over 280 ms. The drums stay
at full level so you hear the classic EDM "breathing" feel where the
pad/lead/arp duck behind each beat.

A Web-Audio-clock scheduler looks 0.5 s ahead in 60 ms increments so
timing stays locked regardless of browser throttling.

### UI SFX ducking

`sound.duckMusic(depth, duration)` briefly dips the music bus when a
UI SFX fires, so the SFX punches through. Early-returns when
`musicSuppressed > 0` (i.e. on a game page) — if the music is
supposed to be silent, there's nothing to duck, and ducking would
otherwise re-write the suppression's gain schedule and unmute the
music.

### Autoplay policy and mute

Browsers (per the HTML5 autoplay spec) can't start audio without a
user gesture (`click`, `keydown`, `pointerdown`, `touchstart`). The
portal's strategy minimizes the felt delay:

1. **Eager silent start on mount.** `SoundBoot` calls
   `sound.enable({ silent: true })` the moment it mounts. This
   succeeds immediately on SPA navigations (the AudioContext
   survives across Next route changes) and on returning visitors
   whose browser has granted site-level autoplay permission.
2. **Self-healing gesture listeners.** The four gesture events
   stay attached for the component's lifetime (not removed after
   the first fire), so if the initial `resume()` attempt failed
   silently the next interaction retries.
3. **Visibility-change resume.** When the tab returns from
   background (where browsers auto-suspend contexts), the engine
   resumes immediately instead of waiting for a click.
4. **Per-SFX `resumeIfNeeded()`**. Every hover/click/confirm/etc.
   calls `ctx.resume()` if the context slipped back to
   "suspended", so brief tab-background dips don't kill sound.

The engine only sets `enabled = true` after confirming
`ctx.state === "running"` — a suspended-but-resume-promise-resolved
path doesn't count (scheduled events in that state never make sound).

The mute button in the top bar toggles `localStorage["brassey:audio-muted"]`
(colon separator). That preference persists across sessions.

### Music suppression on game pages

Game pages call `sound.softMuteMusic()` on mount and the returned
release fn on unmount. This is **refcounted** — multiple overlapping
suppressors compose correctly, and the flag is honored across
`startMusic()` calls. That matters because on a cold page-load the
music hasn't started yet when `softMuteMusic` is called; the
refcount survives until `startMusic` eventually runs, at which point
it sees the suppression and keeps the fresh bus at 0 gain. Without
this, navigating to a game before any gesture then clicking inside
the iframe would unmute music over gameplay.

### UI SFX delegation

`bindDelegatedUiSounds` attaches four global listeners (`pointerover`,
`mousedown`, `focusin`, `keydown`) with a broad selector covering
links, buttons, form controls, `[role]`-tagged elements, and
`[data-sfx]`/`.link-term`. The hover rate-limit is ~55 ms (~18 Hz)
so scanning across a dense UI stays snappy without machine-gunning.

### Per-user chat chimes + achievement fanfare

`sound.notifyAs(handle)` picks a pitch from the D-dorian two-octave
window via an FNV-1a hash of the handle, so each operator has a
recognizable tone. `sound.achievement()` fires a D-major arpeggio
(587 → 740 → 880 → 1175 Hz) with a glittery high-bell tail on every
fresh unlock, briefly ducking the music so the fanfare sits on top.

---

## Visual theme and effects

- **Palette** derived from the ClaudeMythos eldritch aesthetic: void
  purples, matrix green, deep-sea cyan, blood red, amber, magenta.
- **CRT overlay** — repeating 1px scanlines in `screen` blend mode, plus
  a corner vignette. `body::before` / `body::after`.
- **Background particles** — three-layer canvas with slow-drifting
  colored dots, occasional diagonal data-streaks, `mix-blend: screen`.
  Particle density auto-scales with viewport area; pauses when tab
  hidden. (`BackgroundFX`)
- **Custom scrollbars** — thin 10 px bar, dithered purple track,
  gradient thumb (purple→cyan) with glow on hover and blood-red on
  active drag. `.scrollbar-slim` variant at 6 px for dense panels.
- **Panel chrome** — bracketed corners, translucent backgrounds,
  inset + outer eldritch glow. `.panel` and `.panel-glow` utility
  classes in `globals.css`.

---

## Adding a new game

> Building a brand-new LÖVE2D game targeted at this portal?
> Start with **[INTEGRATION.md](./INTEGRATION.md)** — full guide covering
> repo layout, Lua 5.1 / love.js constraints, rendering, input, audio,
> saves, achievements, and a copy-paste starter skeleton. Designed to
> be read once (by a human or AI agent) and then followed as a
> checklist.

Append one entry to the `GAMES` array in `src/lib/games.ts`:

```ts
{
  slug: "your-game",
  title: "Your Game",
  codename: "YOUR.GAME",
  tagline: "one-line hook",
  description: "longer description shown on the game page",
  author: "yourhandle",
  version: "head",
  category: "action",        // action | puzzle | rpg | arcade | meta
  tags: ["bullet-hell"],
  year: 2026,

  repo: "owner/repo",        // GitHub owner/repo of the LÖVE source
  ref: "main",               // optional, defaults to "main"
  subdir: ".",               // optional, path to main.lua within repo
  identity: "your_game",     // optional — defaults to slug with dashes
                             //   → underscores. Must match conf.lua
                             //   `t.identity` or portal can't place
                             //   __loveweb__/achievements.json where
                             //   love.filesystem can read it.

  accentColor: "#8a4fff",
  multiplayer: "single",     // single | coop | mmo
  status: "live",            // live | beta | soon
}
```

Commit + `vercel --prod`. The next build clones the repo, patches, packs,
compiles with love.js, and lists it in the catalog.

Rebuild only one game locally:

```sh
pnpm build:games your-game
```

### Optional: achievements

Drop an `achievements.json` at the root of your game repo to opt into
the portal-wide achievement system. The file ships inside the `.love`
for the game to read, and is mirrored to
`public/games/<slug>/achievements.json` for portal validation and
rendering. See [`docs/ACHIEVEMENTS.md`](./docs/ACHIEVEMENTS.md) for the
full schema and the one-line `print("[[LOVEWEB_ACH]]unlock …")`
protocol used to unlock from Lua.

### Auto-deploy on upstream game pushes

A GitHub Actions workflow in this repo
([`.github/workflows/upstream-games-watch.yml`](./.github/workflows/upstream-games-watch.yml))
polls every watched upstream game repo every 10 minutes. When any repo's
`main` HEAD advances past the last-deployed SHA (tracked via
`actions/cache`), it POSTs to a Vercel deploy hook and the portal
redeploys, pulling the newest source through the normal build pipeline.

**One-time setup:**

1. **Vercel → Project → Settings → Git → Deploy Hooks → Create Hook**
   (name it e.g. *"upstream game push"*, branch `main`). Copy the URL.
2. **GitHub → Repo → Settings → Secrets and variables → Actions → New
   repository secret** — name `VERCEL_DEPLOY_HOOK`, paste the URL.

That's it. New commits to any watched game repo (currently
`ThePearlKing/claude-mythos-game`) auto-redeploy within ~10 minutes. You
can also manually run the workflow from the Actions tab ("Run workflow")
to force a check.

**To add another upstream repo to the watch list**, append its
`owner/repo` slug to the `matrix.repo` list in the workflow file. Done.

**Why polling, not a direct webhook?** A webhook from the upstream repo
would be instant but requires the game author to add a webhook URL in
their repo settings — this workflow lives entirely in the portal repo
and needs nothing from the upstream. If you want instant deploys, give
the same Vercel hook URL to the upstream repo maintainer and they can
add it as a GitHub webhook ("push" event) — the two mechanisms are
additive.

---

## Local development

### Prerequisites

- Node 20+ (tested on 25), pnpm 9, git.
- A Vercel account (free) if you want to pull env vars from a linked
  project.

### First run

```sh
pnpm install
cp .env.example .env.local

# Fill in (or pull from Vercel):
#   AUTH_SECRET=$(openssl rand -base64 32)
#   AUTH_GITHUB_ID=<from GitHub OAuth App>
#   AUTH_GITHUB_SECRET=<from GitHub OAuth App>
#   AUTH_URL=http://localhost:3000
#   POSTGRES_URL=...     (Vercel injects these once you add Neon storage)
#   KV_REST_API_URL=...  (Vercel injects these once you add Upstash storage)
#   KV_REST_API_TOKEN=...

pnpm db:migrate        # apply migrations/*.sql to your Postgres
pnpm build:games       # clone + compile every registered game locally
pnpm dev               # http://localhost:3000
```

### Pulling env vars from Vercel

```sh
vercel link            # associate this directory with the project
vercel env pull .env.local
```

### Running one game's build

```sh
pnpm build:games claude-mythos
```

### Smoke testing a game

```sh
node scripts/test-game-runtime.mjs public/games/<slug>/runtime
# optionally pick a browser: chromium (default), firefox, webkit
```

Spawns a headless browser, serves the runtime dir over HTTP, loads it,
collects every console log + postMessage, checks for the `loveweb:ready`
signal and absence of Lua errors, exits non-zero if the game doesn't
boot clean. Use this before every deploy when adding a new game.

---

## Vercel setup

1. **Link the project:** `vercel link`.
2. **Storage → Create Database → Neon Postgres** (free tier: 0.5 GB).
   Vercel auto-injects `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`,
   `POSTGRES_USER`, `POSTGRES_HOST`, `POSTGRES_PASSWORD`, `POSTGRES_DATABASE`.
3. **Storage → Create Database → Upstash for Redis** (free tier:
   500 000 commands/day; the chat stream route runs an adaptive-
   backoff poll + `MGET` batching so idle sessions cost under
   ~10k/day/client, and a Postgres fallback kicks in automatically
   if the cap is ever hit). Auto-injects `KV_REST_API_URL`,
   `KV_REST_API_TOKEN`, `KV_REST_API_READ_ONLY_TOKEN`, `KV_URL`.
4. **Environment Variables** (Production scope):
   - `AUTH_SECRET` — `openssl rand -base64 32`
   - `AUTH_GITHUB_ID` — GitHub OAuth App client ID
   - `AUTH_GITHUB_SECRET` — GitHub OAuth App client secret
   - `AUTH_URL` — `https://games.brassey.io` (no trailing space)
5. `vercel env pull .env.local` → `pnpm db:migrate` once.
6. `vercel --prod` — ships. Subsequent pushes to `main` auto-deploy if
   the project's Git integration is enabled.

### Build command

`vercel.json` sets `pnpm build` as the build command, which runs the
`prebuild` hook (game compilation) before `next build`.

---

## GitHub OAuth

1. https://github.com/settings/developers → **New OAuth App**.
2. Homepage: `https://games.brassey.io` (or your domain).
3. **Authorization callback URLs** (GitHub allows multiples; add both):
   - `http://localhost:3000/api/auth/callback/github`
   - `https://games.brassey.io/api/auth/callback/github`
4. **Generate a new client secret.** Copy immediately — GitHub shows it
   once. Paste into `AUTH_GITHUB_SECRET` in Vercel env vars.
5. Copy the Client ID into `AUTH_GITHUB_ID`.

The portal uses a GitHub OAuth App (not a GitHub App). The `Ov23li...`
client-ID prefix is correct; an `Iv1.`/`Iv23li...` prefix would be a
GitHub App (different product — wouldn't work with Auth.js's GitHub
provider out of the box).

---

## Namecheap DNS

The portal is served at `games.brassey.io`. Domain registered at Namecheap.

1. Vercel → Project → Settings → Domains → Add `games.brassey.io`. Vercel
   displays the exact record it wants.
2. **Namecheap → Domain List → brassey.io → Manage → Advanced DNS**:

   | Type  | Host    | Value                   | TTL       |
   |-------|---------|-------------------------|-----------|
   | CNAME | `games` | `cname.vercel-dns.com.` | Automatic |

   (Use whatever Vercel shows if it's different.)

3. Propagation + Let's Encrypt cert issuance: ~5-30 minutes.

---

## Troubleshooting

**"unable to create opengl window"** — Brave's **Shields → Fingerprinting:
Strict** disables WebGL. Switch to "Standard" or drop Shields for the
site. The game runner detects this up front and shows inline
instructions; on Chrome/Edge, check `chrome://gpu`.

**Chat messages persist but never reach the client** — almost certainly
a `@vercel/kv` double-parse issue: the SDK auto-parses JSON on read, so
don't call `JSON.parse` on `LRANGE` results — they're already objects.

**"Cannot load game at path '/./game.love'"** — means `game.js` (the
asset manifest) is out of sync with `game.data` (the packaged assets).
Make sure `scripts/build-games.mjs` copied **both** files, not just one.

**Lua syntax error `'=' expected near '<ident>'`** — the game uses
LuaJIT's `goto LABEL` extension. The patcher handles it; confirm
`scripts/web-compat-patch.mjs` ran before packing.

**Black canvas, no errors** — `love.css` has `visibility: hidden` on
`#canvas` by default. Our runtime template forces
`visibility: visible !important`, but if you use the default love.js
HTML you'll hit this.

**Music stops after navigating between pages** — fixed. An older
version disposed the music bus via `setTimeout` cleanup, and a fresh
`startMusic` that ran before the timeout could get its bus reference
null'd out by the stale cleanup. Current `stopMusic` only nulls if the
bus pointer hasn't been replaced. Game pages use `softMuteMusic()` —
fade only, no node disposal.

**`/api/health`** — GET this endpoint to verify DB + KV connectivity and
which `AUTH_*` env vars are set. Useful for quickly diagnosing prod
wiring.

---

## File layout

```
games/
├── README.md                          ◀ this file
├── INTEGRATION.md                     ◀ full game-author integration guide
├── LICENSE                            ◀ CC0 1.0 Universal (public domain)
├── package.json                       scripts (dev/build/db:migrate/build:games)
├── pnpm-lock.yaml
├── tsconfig.json
├── tailwind.config.ts
├── postcss.config.mjs
├── next.config.mjs                    Next.js config (cache-control for runtimes)
├── vercel.json                        build command + function maxDuration
├── .env.example                       template for local .env.local
├── .gitignore
│
├── docs/
│   └── ACHIEVEMENTS.md                author-facing spec: achievements.json + magic-print unlock
│
├── migrations/                        SQL migrations, applied in order
│   ├── 0001_init.sql                  ── Auth.js + portal tables
│   ├── 0002_stats.sql                 ── game_sessions (playtime heartbeats)
│   ├── 0003_profile_github.sql        ── user_profiles GitHub fields
│   └── 0004_achievements.sql          ── user_achievements (unlock records)
│
├── scripts/
│   ├── build-games.mjs                ┐ the game pipeline — prebuild hook
│   ├── web-compat-patch.mjs           │ LuaJIT → Lua 5.1 scope-aware patcher
│   ├── make-love.mjs                  │ zero-dep .love zipper (deflateRaw)
│   ├── test-game-runtime.mjs          │ headless Playwright smoke test
│   └── db-migrate.ts                  ┘ applies migrations/*.sql
│
├── templates/
│   └── love-runtime-index.html        bridge-enabled iframe shell injected
│                                      into every compiled game runtime
│
├── public/
│   ├── favicon.svg
│   └── games/<slug>/
│       ├── game.love                  ← generated by build-games.mjs (gitignored)
│       ├── achievements.json          ← mirrored from upstream repo (if declared)
│       ├── achievements_icons/        ← mirrored from upstream repo (optional)
│       └── runtime/                   ← generated by build-games.mjs (gitignored)
│           ├── index.html             (from templates/love-runtime-index.html)
│           ├── love.js                emscripten loader
│           ├── love.wasm              LÖVE core
│           ├── game.js                asset manifest (UUID, sizes, file list)
│           ├── game.data              packaged .love contents
│           └── theme/love.css         default love.js stylesheet
│
└── src/
    ├── app/                           Next.js 15 App Router
    │   ├── layout.tsx                 root — mounts BackgroundFX, SoundBoot, RouteSfx,
    │   │                              UiEffects; wraps children in #ui-shake (the
    │   │                              transform root consumed by shake/zoom FX)
    │   ├── globals.css                CRT theme · scrollbars · panel chrome · achievement
    │   │                              tiles · Steam-style toast · rank medallions ·
    │   │                              game-frame backlight · cursor spotlight ·
    │   │                              chat-msg entry flash · all UI-FX overlay layers
    │   ├── page.tsx                   / — library home (BootSplash, grid, chat)
    │   ├── signin/page.tsx            /signin — GitHub auth gate
    │   ├── stats/page.tsx             /stats — own telemetry (auth-gated)
    │   ├── u/[handle]/page.tsx        /u/<handle> — public profile + stats
    │   ├── games/[slug]/page.tsx      /games/<slug> — game runner frame
    │   └── api/
    │       ├── auth/[...nextauth]/route.ts    Auth.js handlers
    │       ├── saves/route.ts                 GET/PUT/DELETE game saves
    │       ├── chat/
    │       │   ├── send/route.ts              POST new message
    │       │   └── stream/route.ts            SSE delivery (KV-backed)
    │       ├── stats/route.ts                 GET aggregated user stats
    │       ├── stats/heartbeat/route.ts       POST session heartbeat (30s)
    │       ├── achievements/route.ts          GET catalog + caller's unlocks
    │       ├── achievements/unlock/route.ts   POST unlock (catalog-gated, idempotent)
    │       ├── leaderboard/route.ts           GET top-100 ranked leaderboard
    │       └── health/route.ts                GET diagnostics (DB + KV + env)
    │
    ├── components/
    │   ├── TopBar.tsx                 header — logo, nav, uplink pulse, mute, avatar
    │   ├── HeroBanner.tsx             landing hero on /
    │   ├── GameGrid.tsx               catalog grid of GameCards
    │   ├── GameCard.tsx               single game tile with corner brackets +
    │   │                              cursor-tracking spotlight
    │   ├── GameRunner.tsx             iframe + postMessage bridge + heartbeat +
    │   │                              achievements + quit overlay + exit button
    │   ├── AchievementsPanel.tsx      per-game achievement grid (stats + profiles)
    │   ├── AchievementToast.tsx       Steam-style live unlock toast (queue + entry
    │   │                              glint + breathing rim + auto-dismiss)
    │   ├── UiEffects.tsx              game→portal FX overlay (flash/shake/mood/
    │   │                              ripple/shatter/calm/pulsate/chroma/…)
    │   │                              subscribes to loveweb:fx postMessages
    │   ├── ChatDrawer.tsx             translucent right drawer w/ SSE client,
    │   │                              per-user chimes, fresh-msg flash, auth gate
    │   ├── Avatar.tsx                 rounded-square, glowing, deterministic color
    │   ├── UserMenu.tsx               click-avatar dropdown (Sign out, etc.)
    │   ├── MuteButton.tsx             audio toggle, persists to localStorage
    │   ├── SoundBoot.tsx              eager silent-start + self-healing gesture
    │   │                              listeners + visibilitychange resume
    │   ├── RouteSfx.tsx               plays transition SFX on route change
    │   ├── BackgroundFX.tsx           canvas particle field + data streaks
    │   ├── BootSplash.tsx             CRT boot sequence on first paint
    │   ├── SystemFooter.tsx           landing footer (technical platform facts)
    │   └── stats/
    │       └── StatsCharts.tsx        ActivityChart + PerGameChart (pure SVG)
    │
    ├── lib/
    │   ├── auth.ts                    Auth.js v5 config + GitHub profile sync
    │   ├── db.ts                      pg connection pool + q() helper
    │   ├── kv.ts                      @vercel/kv client + channel constants
    │   ├── games.ts                   GAMES registry ◀ add games here. Includes
    │   │                              `identity` per game for save-dir placement.
    │   ├── achievements.ts            catalog loader + validator (reads achievements.json)
    │   └── sound.ts                   Web Audio engine — UI SFX palette + procedural
    │                                  EDM composer + sfxBus/drumBus/melodicBus routing
    │                                  + sidechain pump + per-user notify chimes
    │
    └── types/                         (reserved for ambient type declarations)
```

---

## Scripts

```sh
pnpm dev                            # Next.js dev server (Turbopack)
pnpm build                          # prebuild games + next build
pnpm build:games                    # build all games from GitHub
pnpm build:games <slug>             # build one game
pnpm db:migrate                     # apply migrations/*.sql
pnpm typecheck                      # tsc --noEmit
pnpm lint
node scripts/test-game-runtime.mjs public/games/<slug>/runtime [browser]
```

---

## License

This codebase (portal, build scripts, templates, everything in this
repository) is released into the **public domain** under
[Creative Commons Zero v1.0 Universal (CC0-1.0)](https://creativecommons.org/publicdomain/zero/1.0/).

You can copy, modify, distribute, and use this code for any purpose,
commercial or non-commercial, without attribution, permission, or
payment. No rights reserved.

Games hosted on the portal are third-party works published under their
own licenses, **not covered** by this project's CC0 grant. See each
game's upstream repo for its terms:

- **Claude: Mythos** by [@ThePearlKing](https://github.com/ThePearlKing)
  — [github.com/ThePearlKing/claude-mythos-game](https://github.com/ThePearlKing/claude-mythos-game)
