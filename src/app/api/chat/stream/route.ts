import { auth } from "@/lib/auth";
import { getKv } from "@/lib/kv";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeJson(s: string): unknown | null {
  try { return JSON.parse(s); } catch { return null; }
}

// Long-polling style SSE stream. Each client subscribes to one or more
// channels; the server tails the Redis list for each, emitting new entries
// as SSE events. Vercel limit: maxDuration is set in vercel.json (300s for
// this route) — client auto-reconnects on close.
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

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        );
      };

      // Initial hello + current seq per channel. Also backfill the most
      // recent ~20 messages per channel so the UI has immediate context on
      // every (re)connect without a separate /history endpoint.
      if (kv) {
        for (const ch of channels) {
          const seq = Number((await kv.get(`seq:${ch}`)) ?? 0);
          seqs.set(ch, seq);
          const recent = (await kv.lrange(`stream:${ch}`, 0, 19)) as unknown[];
          for (const raw of recent.reverse()) {
            const msg = typeof raw === "string" ? safeJson(raw) : raw;
            if (msg) send("chat", msg);
          }
        }
      }
      send("hello", { channels, at: Date.now() });

      const abort = (req as Request & { signal: AbortSignal }).signal;
      let closed = false;
      abort.addEventListener("abort", () => {
        closed = true;
        try { controller.close(); } catch {}
      });

      // Heartbeat every 15s
      const heartbeat = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`: ping ${Date.now()}\n\n`)); } catch {}
      }, 15000);

      // Poll every 1s; on seq change, fetch new items and emit.
      while (!closed) {
        if (!kv) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        try {
          for (const ch of channels) {
            const cur = Number((await kv.get(`seq:${ch}`)) ?? 0);
            const last = seqs.get(ch) ?? 0;
            if (cur > last) {
              const delta = Math.min(cur - last, 50);
              // @vercel/kv auto-parses JSON values, so `items` comes back as
              // an array of already-deserialized objects (not strings).
              const items = (await kv.lrange(`stream:${ch}`, 0, delta - 1)) as unknown[];
              for (const raw of items.reverse()) {
                const msg = typeof raw === "string" ? safeJson(raw) : raw;
                if (msg) send("chat", msg);
              }
              seqs.set(ch, cur);
            }
          }
        } catch (e) {
          // swallow transient KV errors; client will reconnect if we close
        }
        await new Promise((r) => setTimeout(r, 1000));
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
