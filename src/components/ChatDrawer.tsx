"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { sound } from "@/lib/sound";
import Avatar, { colorForHandle } from "./Avatar";

type Msg = {
  id: string;
  channel: string;
  userId: string;
  handle: string;
  avatar?: string | null;
  body: string;
  ts: number;
  kind?: string;
};

// Per-user accent (rounded-square avatar border, handle color, etc.) comes
// from Avatar.colorForHandle so it stays consistent across the portal.
const colorFor = colorForHandle;

// Lightweight syntax highlighter for chat bodies. Colors:
//   - `inline code`            → amber/orange (like bash strings)
//   - "double-quoted strings"  → green
//   - URLs                     → cyan, linked
//   - @mentions                → magenta
//   - #channels                → yellow
//   - numbers                  → purple
//   - /commands                → red
function renderBody(body: string) {
  const nodes: React.ReactNode[] = [];
  // Simple tokenizer: split on a combined regex capturing each category in
  // its own group, emit styled spans as we go.
  const re =
    /(`[^`]+`)|("[^"\n]+")|(https?:\/\/\S+)|(@[A-Za-z0-9_-]+)|(#[A-Za-z0-9_-]+)|(\b\d+(?:\.\d+)?\b)|(^\/[a-zA-Z][\w-]*)/gm;
  let last = 0;
  let idx = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m.index > last) {
      nodes.push(<span key={idx++} className="text-bone/90">{body.slice(last, m.index)}</span>);
    }
    const t = m[0];
    if (m[1]) {
      nodes.push(
        <code key={idx++} className="text-amber-signal bg-void-2/60 border border-eldritch-deep/40 px-1 rounded-sm">
          {t.slice(1, -1)}
        </code>
      );
    } else if (m[2]) {
      nodes.push(<span key={idx++} className="text-matrix-green glow-green">{t}</span>);
    } else if (m[3]) {
      nodes.push(
        <a key={idx++} href={t} target="_blank" rel="noreferrer" className="text-abyss-cyan glow-cyan underline decoration-dotted underline-offset-2 hover:text-eldritch-purple">
          {t}
        </a>
      );
    } else if (m[4]) {
      nodes.push(<span key={idx++} className="text-[#ff6bd6] glow-accent">{t}</span>);
    } else if (m[5]) {
      nodes.push(<span key={idx++} className="text-[#ffe066]">{t}</span>);
    } else if (m[6]) {
      nodes.push(<span key={idx++} className="text-eldritch-purple">{t}</span>);
    } else if (m[7]) {
      nodes.push(<span key={idx++} className="text-blood-red glow-red">{t}</span>);
    }
    last = m.index + t.length;
  }
  if (last < body.length) {
    nodes.push(<span key={idx++} className="text-bone/90">{body.slice(last)}</span>);
  }
  return nodes;
}

export default function ChatDrawer({
  signedIn,
  meHandle,
  gameSlug,
}: {
  signedIn: boolean;
  meHandle: string | null;
  gameSlug?: string;
}) {
  const [open, setOpen] = useState(true);
  const [channel, setChannel] = useState<string>(
    gameSlug ? `chat:game:${gameSlug}` : "chat:global"
  );
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [connected, setConnected] = useState(false);
  const [reconnectTick, setReconnectTick] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const channels = useMemo(() => {
    return gameSlug
      ? [
          { id: "chat:global", label: "#global" },
          { id: `chat:game:${gameSlug}`, label: `#${gameSlug}` },
        ]
      : [{ id: "chat:global", label: "#global" }];
  }, [gameSlug]);

  const channelIds = channels.map((c) => c.id).join(",");

  // Connect SSE — one stream per set of channels. Auto-reconnects on error.
  useEffect(() => {
    if (!signedIn) return;
    const es = new EventSource(`/api/chat/stream?channels=${channelIds}`);
    es.addEventListener("hello", () => setConnected(true));
    es.addEventListener("chat", (evt) => {
      try {
        const m = JSON.parse((evt as MessageEvent).data) as Msg;
        setMessages((prev) => {
          if (prev.some((p) => p.id === m.id)) return prev;
          // Fresh-live message: play a per-user chime (pitch varies by
          // handle so each operator has an identifiable tone), trigger a
          // short haptic on mobile, and ignore sound for backfill batches
          // whose messages are already >5s stale.
          const age = Date.now() - m.ts;
          if (age < 5000) {
            const isMine = meHandle && m.handle === meHandle;
            if (!isMine) {
              try { sound.notifyAs(m.handle); } catch {}
              try {
                // navigator.vibrate is a no-op on desktop; on mobile it
                // gives a short palpable tap. Short enough to not be
                // annoying — a "look here" signal, not an alert.
                (navigator as Navigator & { vibrate?: (p: number | number[]) => boolean })
                  .vibrate?.([40, 30, 60]);
              } catch {}
            }
          }
          return [...prev, m]
            .sort((a, b) => a.ts - b.ts)
            .slice(-200);
        });
      } catch {}
    });
    es.onerror = () => {
      setConnected(false);
      es.close();
      const t = setTimeout(() => setReconnectTick((n) => n + 1), 2000);
      return () => clearTimeout(t);
    };
    return () => es.close();
  }, [signedIn, channelIds, reconnectTick]);

  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, open, channel]);

  const send = useCallback(async () => {
    const body = input.trim();
    if (!body || sending) return;
    setSending(true);
    setInput("");
    try {
      const r = await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, body }),
      });
      // Optimistically append the sender's own message to local state the
      // moment the server confirms it was persisted. This guarantees the
      // user sees their message immediately regardless of broadcast
      // health — previously, when Upstash KV was rate-limited, the send
      // would succeed server-side but no SSE echo-back ever arrived, so
      // the sender saw their message vanish into the void.
      if (r.ok) {
        try {
          const j = (await r.json()) as { ok: boolean; message: Msg };
          if (j?.message) {
            setMessages((prev) => {
              if (prev.some((p) => p.id === j.message.id)) return prev;
              return [...prev, j.message].sort((a, b) => a.ts - b.ts).slice(-200);
            });
          }
        } catch { /* response without JSON body — SSE will catch up */ }
      }
    } finally {
      setSending(false);
    }
  }, [channel, input, sending]);

  const visible = messages.filter((m) => m.channel === channel);

  return (
    <aside
      id="chat"
      // Translucent enough for the BackgroundFX starfield (mounted at the
      // root layout, z-0) to drift through the drawer — a thin 1px blur
      // softens the particles without smearing them into mud, and a
      // subtle linear gradient deepens the top/bottom edges so the chat
      // chrome still has some weight against the motion behind it.
      className={`fixed right-0 top-14 z-30 flex h-[calc(100vh-3.5rem)] flex-col border-l border-eldritch-deep/60 bg-gradient-to-b from-void-0/35 via-void-0/20 to-void-0/35 backdrop-blur-[1px] transition-all ${
        open ? "w-[380px]" : "w-10"
      }`}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-full items-center justify-between border-b border-eldritch-deep/60 px-3 text-[0.65rem] uppercase tracking-[0.3em] text-bone/70 hover:text-abyss-cyan"
        title={open ? "collapse chat" : "expand chat"}
      >
        {open ? (
          <>
            <span>
              <span
                className={`mr-2 inline-block h-1.5 w-1.5 rounded-full ${
                  connected ? "bg-matrix-green shadow-[0_0_8px_#33ff66] animate-pulse" : "bg-blood-red"
                }`}
              />
              signal ▸ <span className={connected ? "text-matrix-green" : "text-blood-red"}>{connected ? "linked" : "scanning"}</span>
            </span>
            <span className="text-eldritch-purple">⟨</span>
          </>
        ) : (
          <span className="rotate-180 [writing-mode:vertical-rl]">chat ▸</span>
        )}
      </button>

      {open && (
        <>
          <div className="flex items-center gap-1 border-b border-eldritch-deep/40 px-3 py-2">
            {channels.map((c) => (
              <button
                key={c.id}
                onClick={() => setChannel(c.id)}
                className={`px-2 py-1 text-[0.7rem] uppercase tracking-[0.2em] transition-colors ${
                  channel === c.id
                    ? "text-abyss-cyan border-b border-abyss-cyan glow-cyan"
                    : "text-bone/60 hover:text-bone"
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>

          <div ref={listRef} className="flex-1 overflow-y-auto py-1 text-sm scrollbar-slim">
            {!signedIn ? (
              // Channel traffic is gated behind auth, both server-side (the
              // /api/chat/stream route 401s without a session cookie) and
              // client-side here — unauthenticated visitors see only a
              // locked-feed prompt, never any message body or handle.
              // Double belt: if for any reason `messages` ever contained
              // rows while signedIn was false (e.g. session expired mid-
              // session), we wouldn't render them.
              <div className="flex flex-col items-center justify-center h-full p-6 text-center gap-3">
                <div className="stamp text-eldritch-purple">uplink :: sealed</div>
                <p className="text-bone/55 text-xs leading-relaxed">
                  Channel traffic is visible only to authenticated operators.
                </p>
                <a href="/signin" className="btn cyan mt-1 text-[0.65rem]">
                  ▸ Authenticate
                </a>
              </div>
            ) : (
              <>
                {visible.length === 0 && (
                  <p className="text-bone/50 text-xs px-3 py-3">
                    <span className="text-eldritch-purple">» </span>
                    the channel is quiet. say hello.
                  </p>
                )}
                {visible.map((m, i) => (
                  <Line key={m.id} m={m} isMe={m.handle === meHandle} zebra={i % 2 === 0} />
                ))}
              </>
            )}
          </div>

          <div className="border-t border-eldritch-deep/60 p-3">
            {signedIn ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  send();
                }}
                className="flex items-center gap-2 border border-eldritch-deep/60 bg-void-1/80 px-2 py-1.5 focus-within:border-eldritch-purple focus-within:shadow-[0_0_12px_#8a4fff33]"
              >
                <span className="text-abyss-cyan text-xs">▸</span>
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  placeholder={`transmit on ${channel.replace("chat:", "#").replace("game:", "")}…`}
                  maxLength={1000}
                  className="flex-1 bg-transparent text-sm text-bone placeholder:text-bone/30 outline-none"
                />
                <button
                  type="submit"
                  disabled={!input.trim() || sending}
                  className="text-[0.65rem] uppercase tracking-[0.2em] text-bone/60 hover:text-abyss-cyan disabled:opacity-30"
                >
                  send ↵
                </button>
              </form>
            ) : (
              <a href="/signin" className="btn cyan w-full justify-center">
                ▸ Authenticate
              </a>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function Line({ m, isMe, zebra }: { m: Msg; isMe: boolean; zebra: boolean }) {
  const t = new Date(m.ts);
  const hh = t.getHours().toString().padStart(2, "0");
  const mm = t.getMinutes().toString().padStart(2, "0");
  const ss = t.getSeconds().toString().padStart(2, "0");
  const userColor = colorFor(m.handle);
  const profileHref = `/u/${encodeURIComponent(m.handle)}`;
  // "fresh" flash: only render the marker if this message arrived within
  // the last 3s on first render. The CSS animation (see globals.css
  // `.chat-msg[data-fresh="true"]`) runs once on DOM insert. Removing the
  // marker later wouldn't retrigger anything — React won't unmount the
  // row — so we don't need to flip it back to false.
  const isFresh = Date.now() - m.ts < 3000;
  return (
    <div
      className={`chat-msg group relative flex items-start gap-2.5 px-3 py-1.5 font-mono text-[0.85rem] leading-snug transition-colors hover:bg-eldritch-purple/5 ${
        zebra ? "bg-eldritch-deep/10" : "bg-transparent"
      }`}
      data-fresh={isFresh ? "true" : "false"}
      data-mine={isMe ? "true" : "false"}
    >
      <Link href={profileHref} aria-label={`View ${m.handle}'s profile`} className="mt-0.5 shrink-0">
        <Avatar src={m.avatar} handle={m.handle} size={30} radius={7} />
      </Link>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <Link
            href={profileHref}
            className="font-semibold tracking-wide text-[0.82rem] hover:underline decoration-dotted underline-offset-2"
            style={{
              color: userColor,
              textShadow: `0 0 6px ${userColor}55`,
            }}
          >
            {m.handle}
          </Link>
          {isMe && <span className="text-bone/35 text-[0.6rem] uppercase tracking-widest">you</span>}
          <span className="ml-auto text-bone/30 text-[0.6rem] tabular-nums">
            {hh}:{mm}:{ss}
          </span>
        </div>
        <div className="break-words mt-0.5 text-bone/90">{renderBody(m.body)}</div>
      </div>
    </div>
  );
}
