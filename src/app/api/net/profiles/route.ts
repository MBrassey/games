import { NextResponse } from "next/server";
import { q } from "@/lib/db";
import { GAMES } from "@/lib/games";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/net/profiles?game=<slug>&userId=<id>
//
// Reads any peer's public_profile.json for a given game. The file is a
// regular cloud-saved file the game itself wrote via love.filesystem.write,
// stored as base64 in game_saves; we decode and return it inline along
// with the user's display info. Anyone can read — that's the point of
// "public profile". Games that don't want to expose anything simply
// don't write the file.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const game = searchParams.get("game");
  const userParam = searchParams.get("userId");
  if (!game || !userParam) {
    return NextResponse.json({ error: "game and userId required" }, { status: 400 });
  }
  if (!GAMES.find((g) => g.slug === game)) {
    return NextResponse.json({ error: "unknown game" }, { status: 404 });
  }
  const userId = Number(userParam);
  if (!Number.isFinite(userId) || userId <= 0) {
    return NextResponse.json({ error: "bad userId" }, { status: 400 });
  }

  const rows = await q<{
    handle: string | null;
    github_login: string | null;
    avatar_url: string | null;
    name: string | null;
    image: string | null;
    data: string | null;
    updated_at: Date | null;
  }>(
    `SELECT up.handle, up.github_login, up.avatar_url, u.name, u.image,
            gs.data, gs.updated_at
       FROM users u
       LEFT JOIN user_profiles up ON up.user_id = u.id
       LEFT JOIN game_saves gs ON gs.user_id = u.id
                              AND gs.game_slug = $2
                              AND gs.path = 'public_profile.json'
      WHERE u.id = $1`,
    [userId, game]
  );
  if (!rows.length) return NextResponse.json({ error: "user not found" }, { status: 404 });
  const r = rows[0];
  let profile: unknown | null = null;
  if (r.data) {
    try { profile = JSON.parse(Buffer.from(r.data, "base64").toString("utf8")); }
    catch { profile = null; }
  }
  return NextResponse.json({
    userId: String(userId),
    game,
    handle: r.handle ?? r.github_login ?? r.name ?? `user-${userId}`,
    avatar: r.avatar_url ?? r.image ?? null,
    profile,
    profileUpdatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  });
}
