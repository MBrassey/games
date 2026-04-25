// Helpers for the multi-user net layer (rooms, events, presence).
//
// Rooms get a short alphanumeric code instead of exposing the BIGSERIAL
// id in URLs / chat messages — easier to type, no leakage of total room
// count, immune to accidentally sharing an enemy room's id. The id is
// still the canonical join target on the wire; code is the convenience
// handle.

const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // skip 0/O/1/I/l
const CODE_LEN = 6;

export function generateRoomCode(): string {
  let s = "";
  // Math.random is fine — collision is checked at insert via UNIQUE
  // constraint and retried up to 4 times. Cryptographic randomness
  // doesn't buy anything here.
  for (let i = 0; i < CODE_LEN; i++) {
    s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return s;
}

export const ROOM_CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LEN}}$`);

// Members are considered "online" while last_seen_at is within this
// window. Heartbeats are sent every 15s by the runtime; 60s is forgiving
// enough to absorb a tab-switch or a few dropped requests without
// flickering people in and out of the roster.
export const ONLINE_WINDOW_MS = 60_000;

// Lua games push events through `print("[[LOVEWEB_NET]]send …")`. To keep
// a runaway update loop from torching the KV / DB budget we cap each
// (user, room) sender at this many events per second; bursts above the
// cap are dropped server-side with a 429.
export const SEND_RATE_PER_SEC = 12;
export const SEND_RATE_BURST = 24;

// Catalog-style verb allowlist. Games can pick any verb name they like
// for their own protocol, but a few are reserved by the portal so the
// runtime can recognize them in the event stream.
export const RESERVED_VERBS = new Set([
  "join",
  "leave",
  "presence",
  "state",
  "kick",
]);
