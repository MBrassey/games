import { q } from "@/lib/db";
import { getKv, NET_KV, type NetEvent } from "@/lib/kv";
import { GAMES } from "@/lib/games";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// SSE stream of slug-wide events: anything from the explicit broadcast
// endpoint, anything mirrored from net_room_events whose verb is in
// SLUG_MIRROR_VERBS, and slug_state changes from /api/net/slug/state.
//
// Architecture mirrors /api/net/rooms/stream: KV poll fast path with
// Postgres fallback. Cadence is intentionally slower (~1.5 s active
// floor, 12 s ceiling) since this is the "global ticker" tier and not
// per-frame gameplay traffic.
//
// Output:
//   event: hello       initial handshake
//   event: net         single slug NetEvent
//   event: presence    rolled-up counts + topUsers (refresh on a 8 s timer)
//
// Public endpoint (no auth required for read) — slug presence is part
// of the "is anyone playing right now?" UX guests should see before
// signing in.

function safeJson(s: unknown): unknown | null {
  if (s == null) return null;
  if (typeof s === "object") return s;
  if (typeof s === "string") {
    try { return JSON.parse(s); } catch { return null; }
  }
  return null;
}

type EventRow = {
  id: string;
  user_id: number | null;
  verb: string;
  payload: unknown;
  created_at: Date;
  handle: string | null;
  avatar_url: string | null;
  name: string | null;
  image: string | null;
};

function rowToEvent(r: EventRow): NetEvent {
  return {
    id: String(r.id),
    roomId: "",
    userId: r.user_id != null ? String(r.user_id) : null,
    handle: r.handle ?? r.name ?? (r.user_id ? `user-${r.user_id}` : null),
    avatar: r.avatar_url ?? r.image ?? null,
    verb: r.verb,
    payload: safeJson(r.payload) ?? r.payload ?? {},
    ts: new Date(r.created_at).getTime(),
  };
}

async function fetchPresence(game: string, rankBy: string | null) {
  // Re-uses the same /api/net/slug/presence logic. We don't HTTP-call
  // ourselves; just inline the same query family.
  const counts = (
    await q<{ active_users: string; total_rooms: string; last24h_users: string; all_time_users: string }>(
      `SELECT
         (SELECT COUNT(DISTINCT m.user_id)
            FROM net_room_members m
            JOIN net_rooms r ON r.id = m.room_id
           WHERE r.game_slug = $1
             AND m.last_seen_at > now() - interval '60 seconds'
         )::text AS active_users,
         (SELECT COUNT(*) FROM net_rooms WHERE game_slug = $1 AND closed_at IS NULL)::text AS total_rooms,
         (SELECT COUNT(DISTINCT u) FROM (
            SELECT e.user_id AS u FROM net_room_events e
              JOIN net_rooms r ON r.id = e.room_id
             WHERE r.game_slug = $1 AND e.user_id IS NOT NULL
               AND e.created_at > now() - interval '24 hours'
            UNION
            SELECT s.user_id FROM net_slug_events s
             WHERE s.game_slug = $1 AND s.user_id IS NOT NULL
               AND s.created_at > now() - interval '24 hours'
            UNION
            SELECT m.user_id FROM net_room_members m
              JOIN net_rooms r ON r.id = m.room_id
             WHERE r.game_slug = $1
               AND m.last_seen_at > now() - interval '24 hours'
         ) sub)::text AS last24h_users,
         (SELECT COUNT(DISTINCT u) FROM (
            SELECT e.user_id AS u FROM net_room_events e
              JOIN net_rooms r ON r.id = e.room_id
             WHERE r.game_slug = $1 AND e.user_id IS NOT NULL
            UNION
            SELECT s.user_id FROM net_slug_events s
             WHERE s.game_slug = $1 AND s.user_id IS NOT NULL
            UNION
            SELECT m.user_id FROM net_room_members m
              JOIN net_rooms r ON r.id = m.room_id
             WHERE r.game_slug = $1
            UNION
            SELECT gs.user_id FROM game_saves gs WHERE gs.game_slug = $1
         ) sub)::text AS all_time_users`,
      [game]
    )
  )[0];

  // Top-N — capped tighter on the stream tier (12) vs the polled
  // /api/net/slug/presence (default 20) to keep event payload size small.
  const candidates = await q<{
    user_id: number;
    handle: string | null;
    github_login: string | null;
    avatar_url: string | null;
    name: string | null;
    image: string | null;
    data: string | null;
    last_seen_at: Date | null;
  }>(
    `WITH active AS (
       SELECT m.user_id, MAX(m.last_seen_at) AS last_seen_at
         FROM net_room_members m
         JOIN net_rooms r ON r.id = m.room_id
        WHERE r.game_slug = $1
        GROUP BY m.user_id
       UNION
       SELECT gs.user_id, MAX(gs.updated_at) AS last_seen_at
         FROM game_saves gs
        WHERE gs.game_slug = $1 AND gs.path = 'public_profile.json'
        GROUP BY gs.user_id
     )
     SELECT a.user_id, up.handle, up.github_login, up.avatar_url, u.name, u.image,
            (SELECT data FROM game_saves
              WHERE user_id = a.user_id AND game_slug = $1 AND path = 'public_profile.json'
              LIMIT 1) AS data,
            MAX(a.last_seen_at) AS last_seen_at
       FROM active a
       JOIN users u ON u.id = a.user_id
       LEFT JOIN user_profiles up ON up.user_id = u.id
      GROUP BY a.user_id, up.handle, up.github_login, up.avatar_url, u.name, u.image
      ORDER BY MAX(a.last_seen_at) DESC NULLS LAST
      LIMIT 60`,
    [game]
  );

  let top = candidates.map((r) => {
    let profile: unknown | null = null;
    if (r.data) {
      try {
        profile = JSON.parse(Buffer.from(r.data, "base64").toString("utf8"));
      } catch {}
    }
    return {
      userId: String(r.user_id),
      handle: r.handle ?? r.github_login ?? r.name ?? `user-${r.user_id}`,
      avatar: r.avatar_url ?? r.image ?? null,
      profile,
      lastSeenAt: r.last_seen_at ? new Date(r.last_seen_at).toISOString() : null,
    };
  });
  if (rankBy && /^[a-zA-Z_][a-zA-Z0-9_]{0,63}$/.test(rankBy)) {
    top.sort((a, b) => {
      const av = (a.profile && typeof a.profile === "object" && rankBy in (a.profile as Record<string, unknown>))
        ? Number((a.profile as Record<string, unknown>)[rankBy]) : -Infinity;
      const bv = (b.profile && typeof b.profile === "object" && rankBy in (b.profile as Record<string, unknown>))
        ? Number((b.profile as Record<string, unknown>)[rankBy]) : -Infinity;
      return (Number.isFinite(bv) ? bv : -Infinity) - (Number.isFinite(av) ? av : -Infinity);
    });
  }
  top = top.slice(0, 12);

  return {
    slug: game,
    activeUsers: Number(counts.active_users),
    totalRooms: Number(counts.total_rooms),
    last24hUsers: Number(counts.last24h_users),
    allTimeUsers: Number(counts.all_time_users),
    topUsers: top,
    at: Date.now(),
  };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const game = searchParams.get("game");
  const rankBy = searchParams.get("rankBy");
  if (!game || !GAMES.find((g) => g.slug === game)) {
    return new Response("unknown game", { status: 404 });
  }

  const kv = getKv();
  const encoder = new TextEncoder();
  let kvHealthy = !!kv;

  let lastSeq = 0;
  let lastId = 0n;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch { /* closed */ }
      };

      // Backfill: last 30 events. Skip if the stream subscriber doesn't
      // care about history (could add ?backfill=0 later — kept for now).
      let backfilled = false;
      if (kv && kvHealthy) {
        try {
          lastSeq = Number((await kv.get(NET_KV.slugStreamSeq(game))) ?? 0);
          const recent = (await kv.lrange(NET_KV.slugStreamList(game), 0, 29)) as unknown[];
          for (const raw of recent.reverse()) {
            const evt = safeJson(raw);
            if (evt) send("net", evt);
          }
          backfilled = true;
        } catch (e) {
          console.warn("[net/slug/stream] KV backfill failed:", (e as Error)?.message);
          kvHealthy = false;
        }
      }
      if (!backfilled) {
        try {
          // Slug events from net_slug_events PLUS the auto-mirrored
          // verbs from net_room_events. Both come back tagged with the
          // user/profile join.
          const rows = await q<EventRow & { source: string }>(
            `(
               SELECT s.id, s.user_id, s.verb, s.payload, s.created_at,
                      up.handle, up.avatar_url, u.name, u.image, 'slug' AS source
                 FROM net_slug_events s
                 LEFT JOIN users u ON u.id = s.user_id
                 LEFT JOIN user_profiles up ON up.user_id = s.user_id
                WHERE s.game_slug = $1
             )
             UNION ALL
             (
               SELECT e.id, e.user_id, e.verb, e.payload, e.created_at,
                      up.handle, up.avatar_url, u.name, u.image, 'room' AS source
                 FROM net_room_events e
                 JOIN net_rooms r ON r.id = e.room_id
                 LEFT JOIN users u ON u.id = e.user_id
                 LEFT JOIN user_profiles up ON up.user_id = e.user_id
                WHERE r.game_slug = $1
                  AND e.verb = ANY ($2::text[])
             )
             ORDER BY id DESC
             LIMIT 30`,
            [game, ["stats", "block", "halving", "build", "wave", "flag", "achievement"]]
          );
          for (const r of rows.reverse()) {
            send("net", rowToEvent(r));
            if (BigInt(r.id) > lastId) lastId = BigInt(r.id);
          }
        } catch (e) {
          console.error("[net/slug/stream] DB backfill failed:", (e as Error)?.message);
        }
      }

      const presence0 = await fetchPresence(game, rankBy);
      send("presence", presence0);
      send("hello", { slug: game, mode: kvHealthy ? "kv" : "db", at: Date.now() });

      const abort = (req as Request & { signal: AbortSignal }).signal;
      let closed = false;
      abort.addEventListener("abort", () => {
        closed = true;
        try { controller.close(); } catch {}
      });

      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`)); } catch {}
      }, 15000);

      const POLL_MIN_KV = 1500;
      const POLL_MAX_KV = 12000;
      const POLL_MIN_DB = 2000;
      const POLL_MAX_DB = 10000;
      const PRESENCE_INTERVAL_MS = 8000;
      let interval = POLL_MIN_KV;
      let lastPresenceCheck = Date.now();

      while (!closed) {
        let deliveredAny = false;

        // 1) New events --------------------------------------------------
        if (kv && kvHealthy) {
          try {
            const cur = Number((await kv.get(NET_KV.slugStreamSeq(game))) ?? 0);
            if (cur > lastSeq) {
              const delta = Math.min(cur - lastSeq, 50);
              const items = (await kv.lrange(NET_KV.slugStreamList(game), 0, delta - 1)) as unknown[];
              for (const raw of items.reverse()) {
                const evt = safeJson(raw);
                if (evt) send("net", evt);
              }
              lastSeq = cur;
              deliveredAny = true;
            }
          } catch (e) {
            console.warn("[net/slug/stream] KV poll failed:", (e as Error)?.message);
            kvHealthy = false;
            try {
              const max = await q<{ max: string | null }>(
                `SELECT GREATEST(
                          COALESCE((SELECT MAX(id) FROM net_slug_events WHERE game_slug=$1),0),
                          COALESCE((SELECT MAX(e.id) FROM net_room_events e
                                      JOIN net_rooms r ON r.id = e.room_id
                                     WHERE r.game_slug=$1),0)
                        )::text AS max`,
                [game]
              );
              lastId = BigInt(max[0]?.max ?? "0");
            } catch { /* non-fatal */ }
          }
        }
        if (!kv || !kvHealthy) {
          try {
            const rows = await q<EventRow>(
              `(
                 SELECT s.id, s.user_id, s.verb, s.payload, s.created_at,
                        up.handle, up.avatar_url, u.name, u.image
                   FROM net_slug_events s
                   LEFT JOIN users u ON u.id = s.user_id
                   LEFT JOIN user_profiles up ON up.user_id = s.user_id
                  WHERE s.game_slug = $1 AND s.id > $2
               )
               UNION ALL
               (
                 SELECT e.id, e.user_id, e.verb, e.payload, e.created_at,
                        up.handle, up.avatar_url, u.name, u.image
                   FROM net_room_events e
                   JOIN net_rooms r ON r.id = e.room_id
                   LEFT JOIN users u ON u.id = e.user_id
                   LEFT JOIN user_profiles up ON up.user_id = e.user_id
                  WHERE r.game_slug = $1
                    AND e.verb = ANY ($3::text[])
                    AND e.id > $2
               )
               ORDER BY id ASC
               LIMIT 50`,
              [game, lastId.toString(), ["stats", "block", "halving", "build", "wave", "flag", "achievement"]]
            );
            for (const r of rows) {
              send("net", rowToEvent(r));
              if (BigInt(r.id) > lastId) lastId = BigInt(r.id);
              deliveredAny = true;
            }
          } catch (e) {
            console.error("[net/slug/stream] DB poll failed:", (e as Error)?.message);
          }
        }

        // 2) Presence (slow timer; one DB pass) -------------------------
        if (Date.now() - lastPresenceCheck >= PRESENCE_INTERVAL_MS) {
          try {
            const p = await fetchPresence(game, rankBy);
            send("presence", p);
            deliveredAny = true;
          } catch (e) {
            console.warn("[net/slug/stream] presence failed:", (e as Error)?.message);
          }
          lastPresenceCheck = Date.now();
        }

        if (deliveredAny) {
          interval = kvHealthy ? POLL_MIN_KV : POLL_MIN_DB;
        } else {
          const ceil = kvHealthy ? POLL_MAX_KV : POLL_MAX_DB;
          interval = Math.min(interval * 1.4, ceil);
        }
        await new Promise((r) => setTimeout(r, interval));
      }

      clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
