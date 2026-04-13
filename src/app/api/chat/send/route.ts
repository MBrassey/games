import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { q } from "@/lib/db";
import { getKv, type ChatMsg } from "@/lib/kv";
import { z } from "zod";

export const runtime = "nodejs";

const SendBody = z.object({
  channel: z.string().min(1).max(64).regex(/^[a-z0-9:_-]+$/),
  body: z.string().min(1).max(1000),
});

export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const b = SendBody.parse(await req.json());

  const profile = (
    await q<{ handle: string }>(
      "SELECT handle FROM user_profiles WHERE user_id=$1",
      [Number(session.user.id)]
    )
  )[0];
  const handle = profile?.handle ?? (session.user.name ?? "anon");

  const rows = await q<{ id: string; created_at: Date }>(
    `INSERT INTO chat_messages(channel, user_id, body) VALUES($1,$2,$3)
     RETURNING id, created_at`,
    [b.channel, Number(session.user.id), b.body]
  );
  const msg: ChatMsg = {
    id: String(rows[0].id),
    channel: b.channel,
    userId: String(Number(session.user.id)),
    handle,
    avatar: session.user.image ?? null,
    body: b.body,
    ts: new Date(rows[0].created_at).getTime(),
    kind: "chat",
  };

  const kv = getKv();
  if (kv) {
    // @vercel/kv auto-JSON-serializes on write and auto-parses on read, so
    // we push the object directly (passing a pre-stringified string would
    // still be valid but the stream route below expects the parsed object).
    await kv.lpush(`stream:${b.channel}`, msg);
    await kv.ltrim(`stream:${b.channel}`, 0, 199);
    await kv.incr(`seq:${b.channel}`);
  }
  return NextResponse.json({ ok: true, message: msg });
}
