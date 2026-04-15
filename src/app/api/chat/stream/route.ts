import { auth } from "@/lib/auth";
import { getKv, type ChatMsg } from "@/lib/kv";
import { q } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeJson(s: string): unknown | null {
  try { return JSON.parse(s); } catch { return null; }
}

// Chat delivery is tiered so the 500k/day Upstash free-tier cap stays out
// of reach even under multiple long-lived sessions:
//
//   • Per poll, a single `mget` reads ALL subscribed channels' seqs (1
//     KV command instead of N). Only when a seq advances do we spend an
//     extra `lrange` to fetch the delta.
//
//   • Adaptive backoff: active channels poll at 1.5s for snappiness;
//     after consecutive quiet polls we back off exponentially to 10s.
//     Any new message resets the cadence. Typical idle cost: ~9k
//     KV reads/day per connected client (was ~170k).
//
//   • Postgres fallback: if KV isn't configured OR a poll throws
//     (rate-limit, transient network), we switch to polling
//     `chat_messages` by id watermark at 3s. Delivery stays correct;
//     only the real-time "snappiness" degrades a touch.
//
//   • `maxDuration` is 300s in vercel.json, so each SSE connection
//     naturally terminates and the client reconnects (2s backoff) —
//     this caps per-connection spend too.

type DbChatRow = {
  id: string;
  channel: string;
  user_id: number;
  body: string;
  created_at: Date;
  kind: string | null;
  handle: string | null;
  avatar_url: string | null;
  name: string | null;
  image: string | null;
};

function rowToMsg(r: DbChatRow): ChatMsg {
  return {
    id: String(r.id),
    channel: r.channel,
    userId: String(r.user_id),
    handle: r.handle ?? r.name ?? `user-${r.user_id}`,
    avatar: r.avatar_url ?? r.image ?? null,
    body: r.body,
    ts: new Date(r.created_at).getTime(),
    kind: (r.kind as ChatMsg["kind"]) ?? "chat",
  };
}

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return new Response("unauthorized", { status: 401 });

  const { searchParams } = new URL(req.url);
  const channels = (searchParams.get("channels") || "chat:global")
    .split(",")
    .filter(Boolean)
    .slice(0, 6);

  const kv = getKv();
  const encoder = new TextEncoder();
  const seqs = new Map<string, number>();
  // DB-fallback watermark: max BIGSERIAL id we've emitted. Only used when
  // KV is unavailable or failing.
  let lastId = 0n;
  let kvHealthy = !!kv;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(
            encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
          );
        } catch { /* controller closed */ }
      };

      // Initial backfill — prefer KV (cheaper), fall back to Postgres on
      // any failure. Same ~20/channel target either way.
      let backfilled = false;
      if (kv && kvHealthy) {
        try {
          const seqKeys = channels.map((ch) => `seq:${ch}`);
          const curs = (await kv.mget(...seqKeys)) as (string | number | null)[];
          channels.forEach((ch, i) => seqs.set(ch, Number(curs[i] ?? 0)));
          for (const ch of channels) {
            const recent = (await kv.lrange(`stream:${ch}`, 0, 19)) as unknown[];
            for (const raw of recent.reverse()) {
              const msg = typeof raw === "string" ? safeJson(raw) : raw;
              if (msg) send("chat", msg);
            }
          }
          backfilled = true;
        } catch (e) {
          console.warn("[chat/stream] KV backfill failed, falling back to Postgres:", (e as Error)?.message);
          kvHealthy = false;
        }
      }
      if (!backfilled) {
        try {
          const rows = await q<DbChatRow>(
            `SELECT cm.id, cm.channel, cm.user_id, cm.body, cm.created_at, cm.kind,
                    up.handle, up.avatar_url, u.name, u.image
               FROM chat_messages cm
               LEFT JOIN user_profiles up ON up.user_id = cm.user_id
               LEFT JOIN users         u  ON u.id      = cm.user_id
              WHERE cm.channel = ANY($1::text[])
              ORDER BY cm.id DESC
              LIMIT 120`,
            [channels]
          );
          // Emit oldest-first so the client feed stays chronological.
          for (const r of rows.reverse()) {
            send("chat", rowToMsg(r));
            if (BigInt(r.id) > lastId) lastId = BigInt(r.id);
          }
        } catch (e) {
          console.error("[chat/stream] Postgres backfill failed:", (e as Error)?.message);
        }
      }
      send("hello", { channels, at: Date.now(), mode: kvHealthy ? "kv" : "db" });

      const abort = (req as Request & { signal: AbortSignal }).signal;
      let closed = false;
      abort.addEventListener("abort", () => {
        closed = true;
        try { controller.close(); } catch {}
      });

      // Keep-alive comment every 15s so proxies / clients don't think
      // the connection died. No KV cost.
      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`)); } catch {}
      }, 15000);

      // KV path: 1.5s when active (1 mget/poll is dirt cheap), idle-backs
      // off to 10s. DB-fallback path: 1.2s when active (a single indexed
      // SELECT is also cheap; Neon's free tier handles this fine) — the
      // chat needs to feel instant for users whether or not KV is rate-
      // limited. Idle backoff caps at 8s for DB so dormant sessions still
      // don't hammer the DB.
      const POLL_MIN = 1500;
      const POLL_MAX = 10000;
      const POLL_DB  = 1200;
      const POLL_DB_MAX = 8000;
      const BACKOFF_STEP = 1.4;
      let interval = POLL_MIN;

      while (!closed) {
        let deliveredAny = false;

        if (kv && kvHealthy) {
          try {
            const seqKeys = channels.map((ch) => `seq:${ch}`);
            const curs = (await kv.mget(...seqKeys)) as (string | number | null)[];
            for (let i = 0; i < channels.length; i++) {
              const ch = channels[i];
              const cur = Number(curs[i] ?? 0);
              const last = seqs.get(ch) ?? 0;
              if (cur > last) {
                const delta = Math.min(cur - last, 50);
                const items = (await kv.lrange(`stream:${ch}`, 0, delta - 1)) as unknown[];
                for (const raw of items.reverse()) {
                  const msg = typeof raw === "string" ? safeJson(raw) : raw;
                  if (msg) send("chat", msg);
                }
                seqs.set(ch, cur);
                deliveredAny = true;
              }
            }
          } catch (e) {
            console.warn("[chat/stream] KV poll failed, switching to Postgres:", (e as Error)?.message);
            kvHealthy = false;
            // Seed the DB watermark so we don't re-emit already-sent
            // history on the next Postgres poll.
            try {
              const rows = await q<{ max: string | null }>(
                `SELECT MAX(id)::text AS max FROM chat_messages WHERE channel = ANY($1::text[])`,
                [channels]
              );
              lastId = BigInt(rows[0]?.max ?? "0");
            } catch { /* non-fatal */ }
          }
        }

        if (!kv || !kvHealthy) {
          try {
            const rows = await q<DbChatRow>(
              `SELECT cm.id, cm.channel, cm.user_id, cm.body, cm.created_at, cm.kind,
                      up.handle, up.avatar_url, u.name, u.image
                 FROM chat_messages cm
                 LEFT JOIN user_profiles up ON up.user_id = cm.user_id
                 LEFT JOIN users         u  ON u.id      = cm.user_id
                WHERE cm.channel = ANY($1::text[])
                  AND cm.id > $2
                ORDER BY cm.id ASC
                LIMIT 50`,
              [channels, lastId.toString()]
            );
            for (const r of rows) {
              send("chat", rowToMsg(r));
              if (BigInt(r.id) > lastId) lastId = BigInt(r.id);
              deliveredAny = true;
            }
          } catch (e) {
            console.error("[chat/stream] Postgres poll failed:", (e as Error)?.message);
          }
        }

        // Adapt cadence: active chat stays snappy, idle chat backs off.
        // DB path uses its own tighter ceiling since a cache miss costs
        // a lot less than a KV command.
        if (deliveredAny) {
          interval = kvHealthy ? POLL_MIN : POLL_DB;
        } else {
          const ceil = kvHealthy ? POLL_MAX : POLL_DB_MAX;
          interval = Math.min(interval * BACKOFF_STEP, ceil);
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
