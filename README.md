# games.brassey.io

A sophisticated dark-terminal portal for LÖVE2D games, running natively in
the browser via [love.js](https://github.com/Davidobot/love.js). Hosts many
games under one roof with GitHub sign-in, cross-device save sync, and a
global chat channel that spans every title. 100% Vercel — no Supabase, no
third-party auth, no per-vendor bills.

```
stack
├── Next.js 15 (App Router, React 19) on Vercel
├── Auth.js v5 + GitHub provider (self-hosted library)
├── Vercel Postgres (Neon)  ── users · saves · chat history
├── Vercel KV (Upstash Redis) ── pub/sub fanout
├── SSE (Node Edge)         ── realtime chat delivery
└── love.js (WASM)          ── embedded per-game runtime
```

## First run (local)

```sh
pnpm install
cp .env.example .env.local
# fill in AUTH_SECRET (openssl rand -base64 32), AUTH_GITHUB_SECRET,
# POSTGRES_* and KV_* — see below for how to get them free on Vercel.

pnpm build:claude-mythos   # compiles ~/Downloads/ClaudeMythos → public/games/claude-mythos/runtime/
pnpm db:migrate            # runs migrations/*.sql against your POSTGRES_URL
pnpm dev                   # http://localhost:3000
```

## Free Vercel services setup

Sign in to the Vercel dashboard for this project, then:

1. **Storage → Create → Postgres** (Neon under the hood, free tier: 256 MB).
   Vercel automatically injects `POSTGRES_URL`, `POSTGRES_URL_NON_POOLING`, etc.
2. **Storage → Create → KV** (Upstash Redis, free tier: 30k cmds/day).
   Injects `KV_REST_API_URL` + `KV_REST_API_TOKEN`.
3. Run `pnpm db:migrate` locally once with the Postgres URL pulled from
   `vercel env pull .env.local` — this creates the Auth.js tables plus the
   portal-specific ones.

## GitHub OAuth

OAuth App: **games** (`Ov23liwRyQruNmiCoPKc`).

Register these callback URLs on the app's settings page:

- `http://localhost:3000/api/auth/callback/github`
- `https://games.brassey.io/api/auth/callback/github`

Set `AUTH_GITHUB_ID` and `AUTH_GITHUB_SECRET` in Vercel → Project → Settings → Env Vars.
Also set `AUTH_SECRET` (generate with `openssl rand -base64 32`) and, for
production, `AUTH_URL=https://games.brassey.io`.

## Adding a new game

1. Copy the LÖVE2D source into some directory.
2. Add an entry to `src/lib/games.ts` with a unique `slug`.
3. Adapt `scripts/build-claude-mythos.sh` → point `SRC` at the new source,
   change output path to `public/games/<slug>/runtime/`. Commit the build.
4. Deploy.

Game saves are keyed by `(user_id, game_slug, path)` — cross-device by
default. No changes needed in Lua code; `love.filesystem` writes are
intercepted by the runtime's save-bridge and pushed to `/api/saves`.

## Chat

- **#global** — the always-on, portal-wide channel. Every signed-in user
  gets a live feed regardless of which game they're in.
- **#\<game-slug\>** — auto-joined when a player is on that game's page,
  for game-specific chatter.

Real-time delivery is via SSE (`/api/chat/stream`) with Vercel KV pub/sub
fanout. Messages are persisted to Postgres for history.

## Multiplayer

The chat layer doubles as a presence/realtime plane for tick-based
multiplayer (MMORPG-style, ~5–10 Hz). Per-game realtime channels can carry
state updates the same way chat does. Vercel does not host persistent
WebSockets — if a future game needs 60 Hz action sync, we'll add a tiny
self-hosted socket server for that specific game.

## Namecheap DNS — pointing games.brassey.io at Vercel

1. In the Vercel dashboard: **Project → Settings → Domains → Add**, enter
   `games.brassey.io`. Vercel will display the exact record values it wants
   (usually a single `CNAME` to `cname.vercel-dns.com`).
2. In **Namecheap → Domain List → brassey.io → Manage → Advanced DNS**, add:

   | Type  | Host  | Value                     | TTL       |
   | ----- | ----- | ------------------------- | --------- |
   | CNAME | games | `cname.vercel-dns.com.`   | Automatic |

   *(If Vercel shows different instructions — e.g. an A record to
   `76.76.21.21` — follow those instead. Namecheap's UI.)*

3. Wait up to ~30 min for propagation. Vercel auto-issues a Let's Encrypt
   cert once DNS resolves.

## Deploy

```sh
# First deploy
vercel link
vercel env pull .env.local
vercel --prod
```

Thereafter, pushes to `main` auto-deploy. Game runtimes under
`public/games/<slug>/runtime/` are committed to the repo so they ship with
every deploy.
