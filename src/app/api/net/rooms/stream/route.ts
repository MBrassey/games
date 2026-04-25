import { auth } from "@/lib/auth";
import { q } from "@/lib/db";
import { getKv, NET_KV, type NetEvent, type NetRosterEntry } from "@/lib/kv";
import { ONLINE_WINDOW_MS } from "@/lib/net";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// SSE stream of one room's events + roster updates. Mirrors the
// architecture of /api/chat/stream:
//   • KV poll (1 mget across stream-seq + roster-seq) is the cheap path.
//   • Postgres fallback by id watermark if KV is unhealthy.
//   • Adaptive backoff: 750ms when active → 8s idle ceiling. Multiplayer
//     rooms can have higher event cadence than chat, so the floor is a
//     bit tighter than chat's 1.5s.
//   • Independent of member status: if a user is removed from the room
//     mid-stream the next poll sees it and ends the stream.
//
// Output events:
//   event: hello       initial handshake (mode + roster snapshot + backfill)
//   event: net         room event (NetEvent JSON)
//   event: roster      membership snapshot (NetRosterEntry[])
//   event: closed      room is no longer reachable
//
// `maxDuration` is 300s in vercel.json so each stream naturally ends and
// the client reconnects (handled by EventSource auto-retry).

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

function rowToEvent(roomId: string, r: EventRow): NetEvent {
  return {
    id: String(r.id),
    roomId,
    userId: r.user_id != null ? String(r.user_id) : null,
    handle: r.handle ?? r.name ?? (r.user_id ? `user-${r.user_id}` : null),
    avatar: r.avatar_url ?? r.image ?? null,
    verb: r.verb,
    payload: safeJson(r.payload) ?? r.payload ?? {},
    ts: new Date(r.created_at).getTime(),
  };
}

async function fetchRoster(roomId: string): Promise<NetRosterEntry[]> {
  const rows = await q<{
    user_id: number;
    handle: string | null;
    avatar_url: string | null;
    name: string | null;
    image: string | null;
    joined_at: Date;
    last_seen_at: Date;
  }>(
    `SELECT m.user_id, up.handle, up.avatar_url, u.name, u.image,
            m.joined_at, m.last_seen_at
       FROM net_room_members m
       JOIN users u ON u.id = m.user_id
       LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE m.room_id = $1
        AND m.last_seen_at > now() - ($2 || ' milliseconds')::interval
      ORDER BY m.joined_at ASC`,
    [roomId, String(ONLINE_WINDOW_MS)]
  );
  return rows.map((r) => ({
    userId: String(r.user_id),
    handle: r.handle ?? r.name ?? `user-${r.user_id}`,
    avatar: r.avatar_url ?? r.image ?? null,
    joinedAt: new Date(r.joined_at).getTime(),
    lastSeen: new Date(r.last_seen_at).getTime(),
  }));
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return new Response("unauthorized", { status: 401 });
  const userId = Number(session.user.id);

  const { searchParams } = new URL(req.url);
  const roomId = searchParams.get("roomId");
  if (!roomId || !/^\d+$/.test(roomId)) {
    return new Response("bad roomId", { status: 400 });
  }

  // Membership gate. If the user isn't in the room they have no business
  // tailing its event log.
  const isMember = await q<{ user_id: number }>(
    `SELECT user_id FROM net_room_members WHERE room_id=$1 AND user_id=$2`,
    [roomId, userId]
  );
  if (!isMember.length) {
    return new Response("not in room", { status: 403 });
  }

  const room = (
    await q<{ closed_at: Date | null; state: unknown; state_version: string }>(
      `SELECT closed_at, state, state_version FROM net_rooms WHERE id=$1`,
      [roomId]
    )
  )[0];
  if (!room) return new Response("room missing", { status: 404 });
  if (room.closed_at) return new Response("room closed", { status: 410 });

  const kv = getKv();
  const encoder = new TextEncoder();
  let kvHealthy = !!kv;

  let lastEventSeq = 0;
  let lastRosterSeq = 0;
  let lastEventId = 0n;
  let lastRosterFingerprint = "";

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch { /* closed */ }
      };

      // Initial backfill: deliver up to 50 recent events so the joiner can
      // catch up on the room's near-past, plus the live roster snapshot
      // and the current persistent state. Prefer KV for the events; fall
      // back to Postgres on any KV failure.
      let backfilledViaKv = false;
      if (kv && kvHealthy) {
        try {
          const seqs = (await kv.mget(
            NET_KV.streamSeq(roomId),
            NET_KV.rosterSeq(roomId)
          )) as (string | number | null)[];
          lastEventSeq = Number(seqs[0] ?? 0);
          lastRosterSeq = Number(seqs[1] ?? 0);
          const recent = (await kv.lrange(
            NET_KV.streamList(roomId),
            0,
            49
          )) as unknown[];
          for (const raw of recent.reverse()) {
            const evt = safeJson(raw);
            if (evt) send("net", evt);
          }
          backfilledViaKv = true;
        } catch (e) {
          console.warn("[net/stream] KV backfill failed:", (e as Error)?.message);
          kvHealthy = false;
        }
      }
      if (!backfilledViaKv) {
        try {
          const rows = await q<EventRow>(
            `SELECT e.id, e.user_id, e.verb, e.payload, e.created_at,
                    up.handle, up.avatar_url, u.name, u.image
               FROM net_room_events e
               LEFT JOIN users u ON u.id = e.user_id
               LEFT JOIN user_profiles up ON up.user_id = e.user_id
              WHERE e.room_id = $1
              ORDER BY e.id DESC
              LIMIT 50`,
            [roomId]
          );
          for (const r of rows.reverse()) {
            send("net", rowToEvent(roomId, r));
            if (BigInt(r.id) > lastEventId) lastEventId = BigInt(r.id);
          }
        } catch (e) {
          console.error("[net/stream] DB backfill failed:", (e as Error)?.message);
        }
      }

      const roster = await fetchRoster(roomId);
      lastRosterFingerprint = JSON.stringify(roster.map((r) => `${r.userId}:${Math.floor(r.lastSeen / 5000)}`));
      send("roster", roster);

      send("hello", {
        roomId,
        mode: kvHealthy ? "kv" : "db",
        state: room.state ?? {},
        stateVersion: Number(room.state_version),
        at: Date.now(),
      });

      const abort = (req as Request & { signal: AbortSignal }).signal;
      let closed = false;
      abort.addEventListener("abort", () => {
        closed = true;
        try { controller.close(); } catch {}
      });

      // Comment-line ping so Vercel's edge proxy / EventSource clients
      // don't decide the connection is stale.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`)); } catch {}
      }, 15000);

      // Poll cadence — events bias to active (750ms / 8s ceiling). Roster
      // is a lower-frequency check (every ~10s) since membership changes
      // arrive as events too; the dedicated roster poll exists only to
      // flush stale members whose heartbeats lapsed without an explicit
      // leave.
      const POLL_MIN_KV = 750;
      const POLL_MAX_KV = 8000;
      const POLL_MIN_DB = 1000;
      const POLL_MAX_DB = 6000;
      const ROSTER_INTERVAL_MS = 10_000;
      let interval = POLL_MIN_KV;
      let lastRosterCheck = Date.now();

      while (!closed) {
        let deliveredAny = false;

        // 1) New events ------------------------------------------------
        if (kv && kvHealthy) {
          try {
            const seqs = (await kv.mget(
              NET_KV.streamSeq(roomId),
              NET_KV.rosterSeq(roomId)
            )) as (string | number | null)[];
            const curEventSeq = Number(seqs[0] ?? 0);
            const curRosterSeq = Number(seqs[1] ?? 0);
            if (curEventSeq > lastEventSeq) {
              const delta = Math.min(curEventSeq - lastEventSeq, 100);
              const items = (await kv.lrange(
                NET_KV.streamList(roomId),
                0,
                delta - 1
              )) as unknown[];
              for (const raw of items.reverse()) {
                const evt = safeJson(raw);
                if (evt) send("net", evt);
              }
              lastEventSeq = curEventSeq;
              deliveredAny = true;
            }
            if (curRosterSeq > lastRosterSeq) {
              lastRosterSeq = curRosterSeq;
              // Force a roster fetch on the next iteration of the
              // periodic check by zeroing the timer.
              lastRosterCheck = 0;
            }
          } catch (e) {
            console.warn("[net/stream] KV poll failed:", (e as Error)?.message);
            kvHealthy = false;
            try {
              const max = await q<{ max: string | null }>(
                `SELECT MAX(id)::text AS max FROM net_room_events WHERE room_id=$1`,
                [roomId]
              );
              lastEventId = BigInt(max[0]?.max ?? "0");
            } catch { /* non-fatal */ }
          }
        }
        if (!kv || !kvHealthy) {
          try {
            const rows = await q<EventRow>(
              `SELECT e.id, e.user_id, e.verb, e.payload, e.created_at,
                      up.handle, up.avatar_url, u.name, u.image
                 FROM net_room_events e
                 LEFT JOIN users u ON u.id = e.user_id
                 LEFT JOIN user_profiles up ON up.user_id = e.user_id
                WHERE e.room_id = $1
                  AND e.id > $2
                ORDER BY e.id ASC
                LIMIT 100`,
              [roomId, lastEventId.toString()]
            );
            for (const r of rows) {
              send("net", rowToEvent(roomId, r));
              if (BigInt(r.id) > lastEventId) lastEventId = BigInt(r.id);
              deliveredAny = true;
            }
          } catch (e) {
            console.error("[net/stream] DB poll failed:", (e as Error)?.message);
          }
        }

        // 2) Roster (rate-limited DB hit) -------------------------------
        if (Date.now() - lastRosterCheck >= ROSTER_INTERVAL_MS) {
          try {
            const r = await fetchRoster(roomId);
            const fp = JSON.stringify(
              r.map((m) => `${m.userId}:${Math.floor(m.lastSeen / 5000)}`)
            );
            if (fp !== lastRosterFingerprint) {
              lastRosterFingerprint = fp;
              send("roster", r);
              deliveredAny = true;
            }
            // Membership self-check: if the caller is no longer in the
            // room, end the stream cleanly so the client stops reconnecting.
            if (!r.find((m) => m.userId === String(userId))) {
              const stillRow = await q<{ user_id: number }>(
                `SELECT user_id FROM net_room_members WHERE room_id=$1 AND user_id=$2`,
                [roomId, userId]
              );
              if (!stillRow.length) {
                send("closed", { reason: "left" });
                clearInterval(heartbeat);
                try { controller.close(); } catch {}
                closed = true;
                return;
              }
            }
          } catch (e) {
            console.warn("[net/stream] roster check failed:", (e as Error)?.message);
          }
          lastRosterCheck = Date.now();
        }

        // 3) Adapt cadence ---------------------------------------------
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
