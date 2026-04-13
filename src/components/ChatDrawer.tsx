"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AmbientAudio from "./AmbientAudio";

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
  const listRef = useRef<HTMLDivElement>(null);
  const esRef = useRef<EventSource | null>(null);

  const channels = useMemo(() => {
    return gameSlug
      ? [{ id: "chat:global", label: "#global" }, { id: `chat:game:${gameSlug}`, label: `#${gameSlug}` }]
      : [{ id: "chat:global", label: "#global" }];
  }, [gameSlug]);

  // Connect SSE
  useEffect(() => {
    if (!signedIn) return;
    const es = new EventSource(
      `/api/chat/stream?channels=${channels.map((c) => c.id).join(",")}`
    );
    esRef.current = es;
    es.addEventListener("hello", () => setConnected(true));
    es.addEventListener("chat", (evt) => {
      try {
        const m = JSON.parse((evt as MessageEvent).data) as Msg;
        setMessages((prev) => {
          if (prev.some((p) => p.id === m.id)) return prev;
          const next = [...prev, m].slice(-200);
          return next;
        });
      } catch {}
    });
    es.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects; close + reopen after a short delay
      es.close();
      setTimeout(() => {
        // trigger effect re-run
        setChannel((c) => c);
      }, 2000);
    };
    return () => { es.close(); esRef.current = null; };
  }, [signedIn, channels]);

  // Autoscroll
  useEffect(() => {
    if (!listRef.current) return;
    listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, open]);

  const send = useCallback(async () => {
    const body = input.trim();
    if (!body || sending) return;
    setSending(true);
    setInput("");
    try {
      await fetch("/api/chat/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, body }),
      });
    } finally {
      setSending(false);
    }
  }, [channel, input, sending]);

  const visible = messages.filter((m) => m.channel === channel);

  return (
    <aside
      id="chat"
      className={`fixed right-0 top-14 z-30 flex h-[calc(100vh-3.5rem)] flex-col border-l border-eldritch-deep/60 bg-void-0/90 backdrop-blur transition-all ${
        open ? "w-[360px]" : "w-10"
      }`}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex h-10 w-full items-center justify-between border-b border-eldritch-deep/60 px-3 text-[0.65rem] uppercase tracking-[0.3em] text-bone/60 hover:text-abyss-cyan"
        title={open ? "collapse chat" : "expand chat"}
      >
        {open ? (
          <>
            <span>
              <span className={`mr-2 inline-block h-1.5 w-1.5 rounded-full ${connected ? "bg-matrix-green shadow-[0_0_8px_#33ff66] animate-pulse" : "bg-blood-red"}`} />
              signal ▸ {connected ? "linked" : "scanning"}
            </span>
            <span>⟨</span>
          </>
        ) : (
          <span className="rotate-180 [writing-mode:vertical-rl]">chat ▸</span>
        )}
      </button>

      {open && (
        <>
          <div className="flex items-center justify-between gap-2 border-b border-eldritch-deep/40 px-3 py-2">
            <div className="flex gap-1">
              {channels.map((c) => (
                <button
                  key={c.id}
                  onClick={() => setChannel(c.id)}
                  className={`px-2 py-1 text-[0.65rem] uppercase tracking-[0.2em] transition-colors ${
                    channel === c.id
                      ? "text-abyss-cyan border-b border-abyss-cyan glow-cyan"
                      : "text-bone/50 hover:text-bone"
                  }`}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <AmbientAudio />
          </div>

          <div ref={listRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2 text-sm">
            {!signedIn && (
              <p className="text-bone/40 text-xs">
                Authenticate to join the uplink.
              </p>
            )}
            {signedIn && visible.length === 0 && (
              <p className="text-bone/40 text-xs">
                <span className="text-eldritch-purple">» </span>
                the channel is quiet. say hello.
              </p>
            )}
            {visible.map((m) => (
              <Line key={m.id} m={m} isMe={m.handle === meHandle} />
            ))}
          </div>

          <div className="border-t border-eldritch-deep/60 p-3">
            {signedIn ? (
              <form
                onSubmit={(e) => { e.preventDefault(); send(); }}
                className="flex items-center gap-2 border border-eldritch-deep/60 bg-void-1/80 px-2 py-1.5 focus-within:border-eldritch-purple"
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
                  className="text-[0.65rem] uppercase tracking-[0.2em] text-bone/50 hover:text-abyss-cyan disabled:opacity-30"
                >
                  send ↵
                </button>
              </form>
            ) : (
              <a href="/api/auth/signin" className="btn cyan w-full justify-center">
                ▸ Authenticate
              </a>
            )}
          </div>
        </>
      )}
    </aside>
  );
}

function Line({ m, isMe }: { m: Msg; isMe: boolean }) {
  const t = new Date(m.ts);
  const hh = t.getHours().toString().padStart(2, "0");
  const mm = t.getMinutes().toString().padStart(2, "0");
  const ss = t.getSeconds().toString().padStart(2, "0");
  return (
    <div className="group">
      <div className="flex items-baseline gap-2">
        <span className="text-[0.65rem] text-bone/35">{hh}:{mm}:{ss}</span>
        <span className={`text-xs tracking-wider ${isMe ? "text-abyss-cyan glow-cyan" : "text-eldritch-purple"}`}>
          {m.handle}
        </span>
      </div>
      <div className="pl-[3.75rem] -mt-0.5 text-bone/90 text-sm break-words leading-snug">
        {m.body}
      </div>
    </div>
  );
}
