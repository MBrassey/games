import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { q } from "@/lib/db";
import { z } from "zod";

export const runtime = "nodejs";

const PutBody = z.object({
  game: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  path: z.string().min(1).max(256),
  data: z.string().max(4 * 1024 * 1024), // 4 MB base64 cap per file
  meta: z.record(z.any()).optional(),
});

export async function GET(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { searchParams } = new URL(req.url);
  const game = searchParams.get("game");
  const path = searchParams.get("path");
  if (!game) return NextResponse.json({ error: "game required" }, { status: 400 });

  if (path) {
    const rows = await q<{ data: string; meta: unknown; updated_at: Date }>(
      "SELECT data, meta, updated_at FROM game_saves WHERE user_id=$1 AND game_slug=$2 AND path=$3",
      [session.user.id, game, path]
    );
    if (!rows.length) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json(rows[0]);
  }
  const rows = await q<{ path: string; updated_at: Date; meta: unknown }>(
    "SELECT path, meta, updated_at FROM game_saves WHERE user_id=$1 AND game_slug=$2",
    [session.user.id, game]
  );
  return NextResponse.json({ files: rows });
}

export async function PUT(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const body = PutBody.parse(await req.json());
  await q(
    `INSERT INTO game_saves(user_id, game_slug, path, data, meta)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, game_slug, path)
     DO UPDATE SET data=EXCLUDED.data, meta=EXCLUDED.meta, updated_at=now()`,
    [session.user.id, body.game, body.path, body.data, body.meta ?? {}]
  );
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const session = await auth();
  if (!session?.user?.id) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { searchParams } = new URL(req.url);
  const game = searchParams.get("game");
  const path = searchParams.get("path");
  if (!game || !path) return NextResponse.json({ error: "game & path required" }, { status: 400 });
  await q(
    "DELETE FROM game_saves WHERE user_id=$1 AND game_slug=$2 AND path=$3",
    [session.user.id, game, path]
  );
  return NextResponse.json({ ok: true });
}
