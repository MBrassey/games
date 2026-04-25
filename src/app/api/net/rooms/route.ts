import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { q } from "@/lib/db";
import { generateRoomCode, ONLINE_WINDOW_MS } from "@/lib/net";
import { GAMES } from "@/lib/games";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const CreateBody = z.object({
  game: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
  name: z.string().min(1).max(80).default("untitled room"),
  visibility: z.enum(["public", "unlisted"]).default("public"),
  capacity: z.number().int().min(1).max(64).default(8),
  state: z.record(z.any()).optional(),
});

type RoomRow = {
  id: string;
  game_slug: string;
  code: string;
  name: string;
  visibility: string;
  capacity: number;
  owner_id: number | null;
  state_version: string;
  created_at: Date;
  updated_at: Date;
  member_count: string;
  online_count: string;
};

function shapeRoom(r: RoomRow) {
  return {
    id: String(r.id),
    game: r.game_slug,
    code: r.code,
    name: r.name,
    visibility: r.visibility,
    capacity: r.capacity,
    ownerId: r.owner_id ? String(r.owner_id) : null,
    stateVersion: Number(r.state_version),
    createdAt: new Date(r.created_at).toISOString(),
    updatedAt: new Date(r.updated_at).toISOString(),
    memberCount: Number(r.member_count),
    onlineCount: Number(r.online_count),
  };
}

// GET /api/net/rooms?game=<slug>  — list public, non-closed rooms.
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const game = searchParams.get("game");
  if (!game) {
    return NextResponse.json({ error: "game required" }, { status: 400 });
  }
  const rows = await q<RoomRow>(
    `SELECT r.id, r.game_slug, r.code, r.name, r.visibility, r.capacity,
            r.owner_id, r.state_version, r.created_at, r.updated_at,
            COALESCE((
              SELECT COUNT(*) FROM net_room_members m
               WHERE m.room_id = r.id
            ), 0)::text AS member_count,
            COALESCE((
              SELECT COUNT(*) FROM net_room_members m
               WHERE m.room_id = r.id
                 AND m.last_seen_at > now() - ($2 || ' milliseconds')::interval
            ), 0)::text AS online_count
       FROM net_rooms r
      WHERE r.game_slug = $1
        AND r.visibility = 'public'
        AND r.closed_at IS NULL
      ORDER BY online_count DESC NULLS LAST, r.updated_at DESC
      LIMIT 100`,
    [game, String(ONLINE_WINDOW_MS)]
  );
  return NextResponse.json({ rooms: rows.map(shapeRoom) });
}

// POST /api/net/rooms — create a room. Auth required.
export async function POST(req: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const userId = Number(session.user.id);

  let body: z.infer<typeof CreateBody>;
  try {
    body = CreateBody.parse(await req.json());
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  if (!GAMES.find((g) => g.slug === body.game)) {
    return NextResponse.json({ error: "unknown game" }, { status: 404 });
  }

  // Retry on the (game_slug, code) UNIQUE constraint a few times — birthday
  // collisions on a 30^6 alphabet are vanishingly rare under any realistic
  // load but the constraint is the source of truth either way.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = generateRoomCode();
    try {
      const ins = await q<{ id: string }>(
        `INSERT INTO net_rooms (game_slug, code, name, visibility, capacity, owner_id, state)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING id`,
        [
          body.game,
          code,
          body.name,
          body.visibility,
          body.capacity,
          userId,
          body.state ?? {},
        ]
      );
      const roomId = ins[0].id;
      // Auto-join the creator. Their first heartbeat will then put them
      // in the live roster within seconds.
      await q(
        `INSERT INTO net_room_members(room_id, user_id) VALUES($1,$2)
         ON CONFLICT (room_id, user_id) DO UPDATE SET last_seen_at = now()`,
        [roomId, userId]
      );
      const rows = await q<RoomRow>(
        `SELECT r.id, r.game_slug, r.code, r.name, r.visibility, r.capacity,
                r.owner_id, r.state_version, r.created_at, r.updated_at,
                1::text AS member_count, 1::text AS online_count
           FROM net_rooms r WHERE r.id=$1`,
        [roomId]
      );
      return NextResponse.json({ ok: true, room: shapeRoom(rows[0]) });
    } catch (e) {
      lastErr = e;
      // Postgres unique_violation → retry with a new code; anything else
      // is fatal.
      const msg = (e as { code?: string })?.code;
      if (msg !== "23505") break;
    }
  }
  console.error("[net/rooms] create failed:", lastErr);
  return NextResponse.json({ error: "create failed" }, { status: 500 });
}
