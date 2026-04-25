import { createClient } from "@vercel/kv";

let _kv: ReturnType<typeof createClient> | null = null;

export function getKv() {
  if (_kv) return _kv;
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  _kv = createClient({
    url: process.env.KV_REST_API_URL,
    token: process.env.KV_REST_API_TOKEN,
  });
  return _kv;
}

// Channels
export const CH = {
  global: "chat:global",
  game: (slug: string) => `chat:game:${slug}`,
  presence: "presence:global",
} as const;

export type ChatMsg = {
  id: string;
  channel: string;
  userId: string;
  handle: string;
  avatar?: string | null;
  body: string;
  ts: number;
  kind?: "chat" | "system" | "join" | "leave";
};

// Net (multiplayer rooms) KV layout. We keep two parallel pairs per room:
//   stream:<seq, list>    event log fanout
//   roster:<seq, list>    membership delta fanout
// Each pair lets the SSE stream do one mget across all interesting keys
// per poll instead of one read per channel — same trick as chat.
export const NET_KV = {
  streamSeq: (roomId: number | string) => `net:room:${roomId}:stream:seq`,
  streamList: (roomId: number | string) => `net:room:${roomId}:stream`,
  rosterSeq: (roomId: number | string) => `net:room:${roomId}:roster:seq`,
  rosterList: (roomId: number | string) => `net:room:${roomId}:roster`,
  // Token bucket used by /api/net/rooms/send to soft-rate-limit chatty
  // games. One key per (user, room); refilled on read at SEND_RATE/sec.
  sendBucket: (userId: number | string, roomId: number | string) =>
    `net:rl:send:${userId}:${roomId}`,
} as const;

export type NetEvent = {
  id: string;          // monotonic, opaque to game side
  roomId: string;
  userId: string | null;
  handle: string | null;
  avatar: string | null;
  verb: string;
  payload: unknown;
  ts: number;
};

export type NetRosterEntry = {
  userId: string;
  handle: string;
  avatar: string | null;
  joinedAt: number;
  lastSeen: number;
};
