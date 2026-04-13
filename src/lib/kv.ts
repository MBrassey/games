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
