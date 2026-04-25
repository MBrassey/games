import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { q } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Identity surfaced to the in-iframe game runtime so multiplayer games
// can display "you are <handle>" and tag locally-originated events. Same
// session cookie that gates /api/saves; the iframe never sees the raw
// cookie, only this projection.
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ signedIn: false }, { status: 200 });
  }
  const userId = Number(session.user.id);
  const rows = await q<{
    handle: string | null;
    avatar_url: string | null;
    github_login: string | null;
    name: string | null;
    image: string | null;
  }>(
    `SELECT up.handle, up.avatar_url, up.github_login, u.name, u.image
       FROM users u
       LEFT JOIN user_profiles up ON up.user_id = u.id
      WHERE u.id = $1`,
    [userId]
  );
  const r = rows[0];
  const handle = r?.handle ?? r?.github_login ?? r?.name ?? `user-${userId}`;
  const avatar = r?.avatar_url ?? r?.image ?? null;
  return NextResponse.json({
    signedIn: true,
    userId: String(userId),
    handle,
    avatar,
  });
}
