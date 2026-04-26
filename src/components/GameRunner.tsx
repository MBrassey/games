"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { sound } from "@/lib/sound";
import { gameIdentity, getGame } from "@/lib/games";
import AchievementToast, { type ToastItem } from "./AchievementToast";
import MobileControls from "./MobileControls";
import type { AchievementDef } from "@/lib/achievements";

type IncomingMsg =
  | { type: "loveweb:hello"; game: string }
  | { type: "loveweb:ready"; game: string }
  | { type: "loveweb:save:write"; path: string; dataB64: string; meta?: Record<string, unknown> }
  | { type: "loveweb:save:read"; path: string; reqId: string }
  | { type: "loveweb:save:list"; reqId: string }
  | { type: "loveweb:log"; level: string; msg: string }
  | { type: "loveweb:achievement:unlock"; key: string; meta?: Record<string, unknown> | null }
  | { type: "loveweb:quit"; status?: number; reason?: string | null }
  // Multi-user net layer.
  | { type: "loveweb:net:list"; reqId?: string }
  | { type: "loveweb:net:create"; reqId?: string; name?: string; visibility?: "public" | "unlisted"; capacity?: number; state?: Record<string, unknown> }
  | { type: "loveweb:net:join"; reqId?: string; code?: string; roomId?: string }
  | { type: "loveweb:net:leave"; reqId?: string }
  | { type: "loveweb:net:send"; reqId?: string; verb: string; payload?: unknown; target?: string | number }
  | { type: "loveweb:net:state"; reqId?: string; patch: Record<string, unknown>; expectedVersion?: number; replace?: boolean }
  // Slug-scoped extensions (#3 / #4 / #5 / #6 of the spec).
  | { type: "loveweb:net:broadcast"; reqId?: string; verb: string; payload?: unknown }
  | { type: "loveweb:net:slug_state"; reqId?: string; patch: Record<string, unknown>; expectedVersion?: number; replace?: boolean }
  | { type: "loveweb:net:profile"; reqId?: string; userId: string }
  | { type: "loveweb:net:slug_presence"; reqId?: string; rankBy?: string; limit?: number };

type UnlockEntry = { key: string; unlockedAt: string; points: number };

type NetRosterEntry = { userId: string; handle: string; avatar: string | null; joinedAt: number; lastSeen: number };
type NetIdentity = { signedIn: boolean; userId?: string; handle?: string; avatar?: string | null };

// Embeds the love.js runtime in a sandboxed iframe and brokers save
// operations between it and /api/saves. Graceful fallback UI when the
// runtime bundle hasn't been built yet.
export default function GameRunner({
  slug,
  runtimePath,
  signedIn,
}: {
  slug: string;
  runtimePath: string;
  signedIn: boolean;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [runtimeAvailable, setRuntimeAvailable] = useState<boolean | null>(null);
  const [webglOk, setWebglOk] = useState<boolean | null>(null);
  const [booted, setBooted] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [exited, setExited] = useState<{ reason?: string | null; status?: number } | null>(null);
  const router = useRouter();
  const gameMeta = getGame(slug);
  const accent = gameMeta?.accentColor ?? "#8a4fff";
  const identity = gameMeta ? gameIdentity(gameMeta) : slug.replace(/-/g, "_");

  // Multi-user net layer. The portal owns the EventSource subscription
  // and forwards delivered events into the iframe. The game side never
  // sees /api/* directly — same trust model as save sync.
  const currentRoomIdRef = useRef<string | null>(null);
  const netEventSourceRef = useRef<EventSource | null>(null);
  const netHeartbeatRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Slug-wide stream — open for the whole game-page lifetime so guests
  // see "is anyone playing right now" + the global ticker before they
  // join any room.
  const slugEventSourceRef = useRef<EventSource | null>(null);

  const dismissToast = useCallback((id: string) => {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }, []);

  // Dev/verification hook: append `?_test_toast=1` to any game URL to fire
  // a synthetic achievement toast a couple seconds after boot. Lets us
  // exercise the full visual + sound pipeline without needing the game
  // to publish a real achievement. Rarity and glyph can be overridden
  // via ?_test_toast=legendary (etc).
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const rarityParam = params.get("_test_toast");
    if (!rarityParam) return;
    const rarity = (["common", "uncommon", "rare", "legendary"] as const).includes(
      rarityParam as "common" | "uncommon" | "rare" | "legendary"
    )
      ? (rarityParam as "common" | "uncommon" | "rare" | "legendary")
      : "rare";
    const t = setTimeout(() => {
      setToasts((cur) => [
        ...cur,
        {
          id: `demo:${Date.now()}`,
          game: slug,
          fresh: true,
          points: rarity === "legendary" ? 100 : rarity === "rare" ? 50 : rarity === "uncommon" ? 25 : 10,
          def: {
            key: "demo_achievement",
            title: rarity === "legendary" ? "Voidwalker" : "Test Transmission",
            description:
              rarity === "legendary"
                ? "You breached the outer veil. The deep ones noticed."
                : "Portal notification pipeline verified — end-to-end.",
            glyph: rarity === "legendary" ? "✦" : rarity === "rare" ? "☽" : rarity === "uncommon" ? "✧" : "·",
            points: rarity === "legendary" ? 100 : rarity === "rare" ? 50 : rarity === "uncommon" ? 25 : 10,
            hidden: false,
            rarity,
          },
        },
      ]);
      try { sound.achievement(); } catch { /* no-op pre-gesture */ }
    }, 1500);
    return () => clearTimeout(t);
  }, [slug]);

  // Detect WebGL up front. Brave's "Fingerprinting: Strict" shield disables
  // WebGL entirely — LÖVE errors out with "unable to create opengl window".
  // We surface a friendly message instead of shipping the user into a silent
  // black iframe.
  useEffect(() => {
    try {
      const c = document.createElement("canvas");
      const gl =
        c.getContext("webgl2") ||
        c.getContext("webgl") ||
        c.getContext("experimental-webgl");
      setWebglOk(!!gl);
    } catch {
      setWebglOk(false);
    }
  }, []);

  // Block mouse-back / mouse-forward navigation while on a game page. The
  // side buttons (button 3 / 4) trigger browser history navigation by
  // default — easy to press by accident mid-game. We preventDefault on
  // mousedown/mouseup/auxclick for those buttons on BOTH the parent page
  // and the iframe's contentDocument (same-origin, so we can attach
  // directly), and also push a history state so any nav that sneaks past
  // (OS gestures, trackpad swipes, Alt+Left) gets immediately cancelled.
  useEffect(() => {
    const blockSideButtons = (e: MouseEvent) => {
      if (e.button === 3 || e.button === 4) {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    const attach = (target: EventTarget) => {
      target.addEventListener("mousedown", blockSideButtons as EventListener, true);
      target.addEventListener("mouseup", blockSideButtons as EventListener, true);
      target.addEventListener("auxclick", blockSideButtons as EventListener, true);
    };
    const detach = (target: EventTarget) => {
      target.removeEventListener("mousedown", blockSideButtons as EventListener, true);
      target.removeEventListener("mouseup", blockSideButtons as EventListener, true);
      target.removeEventListener("auxclick", blockSideButtons as EventListener, true);
    };
    attach(window);
    const iframeDoc = iframeRef.current?.contentDocument ?? null;
    if (iframeDoc) attach(iframeDoc);

    // History trap: shove an extra entry on the stack. Any back gesture
    // pops it and we push it back — player stays on the game page until
    // they click a nav link.
    const href = window.location.href;
    window.history.pushState({ gameGuard: true }, "", href);
    const onPopstate = () => { window.history.pushState({ gameGuard: true }, "", href); };
    window.addEventListener("popstate", onPopstate);

    return () => {
      detach(window);
      if (iframeDoc) detach(iframeDoc);
      window.removeEventListener("popstate", onPopstate);
    };
  }, []);

  // Mute the portal soundtrack while a game is running. The game has
  // its own audio (love.audio) and the portal's procedural music
  // colliding with it muddies both. softMuteMusic() returns a refcount
  // release; on unmount we restore the previous state — the user's
  // explicit Mute button preference is preserved either way (the
  // suppression counter sits below the user toggle in sound.ts).
  useEffect(() => {
    const release = sound.softMuteMusic();
    return () => { try { release(); } catch {} };
  }, []);

  // Playtime tracking. Every 30s we POST to /api/stats/heartbeat, but
  // ONLY if the player has been interactive within the last 2 minutes
  // and the tab is visible. Otherwise we stop pinging — the server's
  // GAP_SECONDS=120 rule then rolls that into a new session when the
  // user comes back, so idle time never accrues as playtime.
  //
  // "Active" = any pointerdown / keydown / mousemove in either the
  // parent page OR the game iframe's contentDocument (same-origin,
  // so we can observe input directly).
  useEffect(() => {
    if (!booted || !signedIn) return;
    const IDLE_MS = 120_000;
    let lastActivity = Date.now();
    const markActive = () => { lastActivity = Date.now(); };

    const pageEvts = ["pointerdown", "keydown", "mousemove"] as const;
    for (const e of pageEvts) window.addEventListener(e, markActive, { passive: true });

    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument ?? null;
    if (doc) {
      for (const e of pageEvts) doc.addEventListener(e, markActive, { passive: true });
    }

    const ping = () => {
      if (document.hidden) return;                      // tab not visible — skip
      if (Date.now() - lastActivity > IDLE_MS) return;  // user idle — skip
      fetch("/api/stats/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game: slug }),
        keepalive: true,
      }).catch(() => {});
    };
    ping();
    const t = setInterval(ping, 30_000);
    return () => {
      clearInterval(t);
      for (const e of pageEvts) window.removeEventListener(e, markActive);
      if (doc) for (const e of pageEvts) doc.removeEventListener(e, markActive);
    };
  }, [booted, signedIn, slug]);

  // Probe for runtime index.html existence
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch(`${runtimePath}/index.html`, { method: "HEAD" });
        setRuntimeAvailable(r.ok);
      } catch {
        setRuntimeAvailable(false);
      }
    })();
  }, [runtimePath]);

  // Extracted so both `loveweb:hello` and the iframe's `onLoad` can use it.
  // Pushes the manifest + auth state + achievement state + identity to the
  // runtime, triggering save prepopulation and metadata-file injection
  // into the game's save dir. Safe to call more than once per iframe
  // lifetime — the runtime resolves its manifest/achievements/identity
  // promises at most once.
  const pushManifest = async () => {
    const iframe = iframeRef.current;
    if (!iframe || !iframe.contentWindow) return;
    const reply = (msg: unknown) => iframe.contentWindow?.postMessage(msg, "*");
    if (signedIn) {
      try {
        const r = await fetch(`/api/saves?game=${encodeURIComponent(slug)}`);
        const j = r.ok ? await r.json() : { files: [] };
        reply({ type: "loveweb:saves:manifest", files: j.files ?? [] });
      } catch {
        reply({ type: "loveweb:saves:manifest", files: [] });
      }
    } else {
      reply({ type: "loveweb:saves:manifest", files: [] });
    }
    // Achievement state: catalog lives in the game itself (bundled in
    // .love), but the unlocked set is portal-side. Send the unlocks — the
    // runtime writes them to __loveweb__/achievements.json in the save FS.
    try {
      const r = await fetch(`/api/achievements?game=${encodeURIComponent(slug)}`);
      const j = r.ok ? await r.json() : { unlocks: [] };
      reply({ type: "loveweb:achievements:state", unlocks: (j.unlocks ?? []) as UnlockEntry[], identity });
    } catch {
      reply({ type: "loveweb:achievements:state", unlocks: [], identity });
    }
    // Identity: who is the player? Tells the runtime to write
    // __loveweb__/identity.json so multi-user games can label local
    // events without re-asking the player for a name. The endpoint returns
    // {signedIn:false} for anonymous sessions; the runtime writes the
    // file regardless so games can branch on `payload.signedIn`.
    try {
      const r = await fetch("/api/net/identity");
      const j: NetIdentity = r.ok ? await r.json() : { signedIn: false };
      reply({ type: "loveweb:identity", identity: j });
    } catch {
      reply({ type: "loveweb:identity", identity: { signedIn: false } });
    }
    reply({ type: "loveweb:auth", signedIn });
  };

  // ---- net helpers --------------------------------------------------
  const netReply = (msg: unknown) => {
    iframeRef.current?.contentWindow?.postMessage(msg, "*");
  };

  // Tear down any active room subscription. Idempotent — safe to call
  // before joining a new room or on iframe unmount.
  const closeNetSubscription = () => {
    if (netEventSourceRef.current) {
      try { netEventSourceRef.current.close(); } catch {}
      netEventSourceRef.current = null;
    }
    if (netHeartbeatRef.current) {
      clearInterval(netHeartbeatRef.current);
      netHeartbeatRef.current = null;
    }
    currentRoomIdRef.current = null;
  };

  const openNetSubscription = (roomId: string) => {
    closeNetSubscription();
    currentRoomIdRef.current = roomId;
    const es = new EventSource(`/api/net/rooms/stream?roomId=${encodeURIComponent(roomId)}`);
    netEventSourceRef.current = es;
    es.addEventListener("hello", (evt) => {
      try {
        const j = JSON.parse((evt as MessageEvent).data);
        netReply({ type: "loveweb:net:hello", roomId, ...j });
      } catch {}
    });
    es.addEventListener("net", (evt) => {
      try {
        const j = JSON.parse((evt as MessageEvent).data);
        netReply({ type: "loveweb:net:event", event: j });
      } catch {}
    });
    es.addEventListener("roster", (evt) => {
      try {
        const j = JSON.parse((evt as MessageEvent).data) as NetRosterEntry[];
        netReply({ type: "loveweb:net:roster", roomId, members: j });
      } catch {}
    });
    es.addEventListener("closed", () => {
      netReply({ type: "loveweb:net:closed", roomId });
      closeNetSubscription();
    });
    es.onerror = () => {
      // Browser auto-reconnects EventSource by default. Surface the
      // dropped state to the game once so any "uplink lost" UI it shows
      // can clear when delivery resumes.
      netReply({ type: "loveweb:net:disconnected", roomId });
    };
    netHeartbeatRef.current = setInterval(() => {
      const id = currentRoomIdRef.current;
      if (!id) return;
      fetch("/api/net/rooms/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ roomId: id }),
        keepalive: true,
      }).catch(() => {});
    }, 15000);
  };

  // Cleanup on unmount: leave the room (best-effort) and tear down the
  // SSE / heartbeat. The leave call is `keepalive: true` so it has a
  // chance to flush even when the user is navigating away.
  useEffect(() => {
    return () => {
      const id = currentRoomIdRef.current;
      if (id && signedIn) {
        try {
          fetch("/api/net/rooms/leave", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ roomId: id }),
            keepalive: true,
          }).catch(() => {});
        } catch {}
      }
      closeNetSubscription();
    };
  }, [signedIn]);

  // Slug-wide stream — opens once per game-page mount, no auth required.
  // The portal forwards two event types into the iframe:
  //   loveweb:net:slug_event      a single global-tier NetEvent
  //   loveweb:net:slug_presence   active counts + topUsers snapshot
  // Plus loveweb:net:slug_hello on initial handshake.
  useEffect(() => {
    const es = new EventSource(`/api/net/slug/stream?game=${encodeURIComponent(slug)}`);
    slugEventSourceRef.current = es;
    es.addEventListener("hello", (evt) => {
      try {
        const j = JSON.parse((evt as MessageEvent).data);
        netReply({ type: "loveweb:net:slug_hello", ...j });
      } catch {}
    });
    es.addEventListener("net", (evt) => {
      try {
        const j = JSON.parse((evt as MessageEvent).data);
        netReply({ type: "loveweb:net:slug_event", event: j });
      } catch {}
    });
    es.addEventListener("presence", (evt) => {
      try {
        const j = JSON.parse((evt as MessageEvent).data);
        netReply({ type: "loveweb:net:slug_presence", presence: j });
      } catch {}
    });
    return () => {
      try { es.close(); } catch {}
      slugEventSourceRef.current = null;
    };
  }, [slug]);

  // postMessage bridge
  useEffect(() => {
    const onMessage = async (ev: MessageEvent) => {
      if (!iframeRef.current || ev.source !== iframeRef.current.contentWindow) return;
      const data = ev.data as IncomingMsg | undefined;
      if (!data || typeof data !== "object" || !("type" in data)) return;

      const reply = (msg: unknown) => {
        iframeRef.current?.contentWindow?.postMessage(msg, "*");
      };

      try {
        if (data.type === "loveweb:hello") {
          // Iframe script just parsed, WASM init hasn't started yet.
          // Push the manifest right now so it's waiting in the runtime's
          // message queue by the time preRun fires.
          await pushManifest();
        } else if (data.type === "loveweb:ready") {
          setBooted(true);
        } else if (data.type === "loveweb:save:write") {
          if (!signedIn) return;
          await fetch(`/api/saves`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              game: slug,
              path: data.path,
              data: data.dataB64,
              meta: data.meta ?? {},
            }),
          });
        } else if (data.type === "loveweb:save:read") {
          if (!signedIn) { reply({ type: "loveweb:save:data", reqId: data.reqId, dataB64: null }); return; }
          const r = await fetch(
            `/api/saves?game=${encodeURIComponent(slug)}&path=${encodeURIComponent(data.path)}`
          );
          if (r.ok) {
            const { data: dataB64 } = await r.json();
            reply({ type: "loveweb:save:data", reqId: data.reqId, dataB64 });
          } else {
            reply({ type: "loveweb:save:data", reqId: data.reqId, dataB64: null });
          }
        } else if (data.type === "loveweb:save:list") {
          if (!signedIn) { reply({ type: "loveweb:saves:list", reqId: data.reqId, files: [] }); return; }
          const r = await fetch(`/api/saves?game=${encodeURIComponent(slug)}`);
          const j = r.ok ? await r.json() : { files: [] };
          reply({ type: "loveweb:saves:list", reqId: data.reqId, files: j.files ?? [] });
        } else if (data.type === "loveweb:log") {
          // eslint-disable-next-line no-console
          console.log(`[${slug}] ${data.level}:`, data.msg);
        } else if (data.type === "loveweb:quit") {
          // The game emitted a clean exit signal (love.event.quit, or an
          // onExit/onAbort from the emscripten runtime). Show a short
          // overlay on the canvas, play a confirm ping, then route back
          // to the library — respecting our history trap (router.push,
          // not window.history.back).
          if (exited) return;
          setExited({ reason: data.reason ?? null, status: data.status });
          try { sound.confirm(); } catch {}
          setTimeout(() => { router.push("/"); }, 1400);
        } else if (data.type === "loveweb:net:list") {
          const r = await fetch(`/api/net/rooms?game=${encodeURIComponent(slug)}`);
          const j = r.ok ? await r.json() : { rooms: [] };
          reply({ type: "loveweb:net:list:result", reqId: data.reqId, rooms: j.rooms ?? [] });
        } else if (data.type === "loveweb:net:create") {
          if (!signedIn) {
            reply({ type: "loveweb:net:create:result", reqId: data.reqId, ok: false, error: "not signed in" });
            return;
          }
          const r = await fetch("/api/net/rooms", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              game: slug,
              name: data.name ?? "untitled room",
              visibility: data.visibility ?? "public",
              capacity: data.capacity ?? 8,
              state: data.state,
            }),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            reply({ type: "loveweb:net:create:result", reqId: data.reqId, ok: false, error: j?.error || `http ${r.status}` });
            return;
          }
          const j = await r.json();
          openNetSubscription(j.room.id);
          reply({ type: "loveweb:net:create:result", reqId: data.reqId, ok: true, room: j.room });
        } else if (data.type === "loveweb:net:join") {
          if (!signedIn) {
            reply({ type: "loveweb:net:join:result", reqId: data.reqId, ok: false, error: "not signed in" });
            return;
          }
          const r = await fetch("/api/net/rooms/join", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ game: slug, code: data.code, roomId: data.roomId }),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            reply({ type: "loveweb:net:join:result", reqId: data.reqId, ok: false, error: j?.error || `http ${r.status}` });
            return;
          }
          const j = await r.json();
          openNetSubscription(j.room.id);
          reply({ type: "loveweb:net:join:result", reqId: data.reqId, ok: true, room: j.room });
        } else if (data.type === "loveweb:net:leave") {
          const id = currentRoomIdRef.current;
          if (id && signedIn) {
            await fetch("/api/net/rooms/leave", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ roomId: id }),
            }).catch(() => {});
          }
          closeNetSubscription();
          reply({ type: "loveweb:net:leave:result", reqId: data.reqId, ok: true });
        } else if (data.type === "loveweb:net:send") {
          const id = currentRoomIdRef.current;
          if (!id) {
            reply({ type: "loveweb:net:send:result", reqId: data.reqId, ok: false, error: "not in room" });
            return;
          }
          const r = await fetch("/api/net/rooms/send", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              roomId: id,
              verb: data.verb,
              payload: data.payload ?? {},
              target: data.target ?? undefined,
            }),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            reply({ type: "loveweb:net:send:result", reqId: data.reqId, ok: false, error: j?.error || `http ${r.status}` });
            return;
          }
          const j = await r.json();
          reply({ type: "loveweb:net:send:result", reqId: data.reqId, ok: true, event: j.event });
        } else if (data.type === "loveweb:net:broadcast") {
          if (!signedIn) {
            reply({ type: "loveweb:net:broadcast:result", reqId: data.reqId, ok: false, error: "not signed in" });
            return;
          }
          const r = await fetch("/api/net/slug/broadcast", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ game: slug, verb: data.verb, payload: data.payload ?? {} }),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            reply({ type: "loveweb:net:broadcast:result", reqId: data.reqId, ok: false, error: j?.error || `http ${r.status}` });
            return;
          }
          const j = await r.json();
          reply({ type: "loveweb:net:broadcast:result", reqId: data.reqId, ok: true, event: j.event });
        } else if (data.type === "loveweb:net:slug_state") {
          if (!signedIn) {
            reply({ type: "loveweb:net:slug_state:result", reqId: data.reqId, ok: false, error: "not signed in" });
            return;
          }
          const r = await fetch("/api/net/slug/state", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              game: slug,
              patch: data.patch ?? {},
              expectedVersion: data.expectedVersion,
              replace: data.replace,
            }),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            reply({ type: "loveweb:net:slug_state:result", reqId: data.reqId, ok: false, error: j?.error || `http ${r.status}` });
            return;
          }
          const j = await r.json();
          reply({ type: "loveweb:net:slug_state:result", reqId: data.reqId, ok: true, state: j.state, version: j.version });
        } else if (data.type === "loveweb:net:profile") {
          const r = await fetch(`/api/net/profiles?game=${encodeURIComponent(slug)}&userId=${encodeURIComponent(data.userId)}`);
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            reply({ type: "loveweb:net:profile:result", reqId: data.reqId, ok: false, userId: data.userId, error: j?.error || `http ${r.status}` });
            return;
          }
          const j = await r.json();
          reply({ type: "loveweb:net:profile:result", reqId: data.reqId, ok: true, userId: data.userId, handle: j.handle, avatar: j.avatar, profile: j.profile, profileUpdatedAt: j.profileUpdatedAt });
        } else if (data.type === "loveweb:net:slug_presence") {
          const params = new URLSearchParams({ game: slug });
          if (data.rankBy) params.set("rankBy", data.rankBy);
          if (data.limit) params.set("limit", String(data.limit));
          const r = await fetch(`/api/net/slug/presence?${params.toString()}`);
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            reply({ type: "loveweb:net:slug_presence:result", reqId: data.reqId, ok: false, error: j?.error || `http ${r.status}` });
            return;
          }
          const j = await r.json();
          reply({ type: "loveweb:net:slug_presence:result", reqId: data.reqId, ok: true, presence: j });
        } else if (data.type === "loveweb:net:state") {
          const id = currentRoomIdRef.current;
          if (!id) {
            reply({ type: "loveweb:net:state:result", reqId: data.reqId, ok: false, error: "not in room" });
            return;
          }
          const r = await fetch("/api/net/rooms/state", {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              roomId: id,
              patch: data.patch ?? {},
              expectedVersion: data.expectedVersion,
              replace: data.replace,
            }),
          });
          if (!r.ok) {
            const j = await r.json().catch(() => ({}));
            reply({ type: "loveweb:net:state:result", reqId: data.reqId, ok: false, error: j?.error || `http ${r.status}` });
            return;
          }
          const j = await r.json();
          reply({ type: "loveweb:net:state:result", reqId: data.reqId, ok: true, state: j.state, version: j.version });
        } else if (data.type === "loveweb:achievement:unlock") {
          if (!signedIn) return;
          const r = await fetch(`/api/achievements/unlock`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ game: slug, key: data.key, meta: data.meta ?? {} }),
          });
          if (!r.ok) {
            // eslint-disable-next-line no-console
            console.warn(`[${slug}] achievement unlock failed:`, data.key, r.status);
            return;
          }
          const j = (await r.json()) as {
            fresh: boolean;
            unlock: { key: string; points: number };
            definition: AchievementDef;
          };
          // Surface a Steam-style toast only on the FIRST unlock for this
          // user + achievement. Replays shouldn't spam — the game side can
          // still safely call unlock idempotently.
          if (j.fresh) {
            setToasts((cur) => [
              ...cur,
              {
                id: `${slug}:${j.unlock.key}:${Date.now()}`,
                game: slug,
                def: j.definition,
                points: j.unlock.points,
                fresh: true,
              },
            ]);
            // Fanfare. Sound engine no-ops if audio isn't unlocked yet
            // (user hasn't gestured), so this is safe unconditionally.
            try { sound.achievement(); } catch { /* non-fatal */ }
          }
          // Re-push the full state so the in-game meta file stays fresh
          // for UI hydration if the game re-reads it. Also emit an ack
          // for debugging/logs.
          reply({
            type: "loveweb:achievement:ack",
            key: j.unlock.key,
            fresh: j.fresh,
            points: j.unlock.points,
          });
          try {
            const s = await fetch(`/api/achievements?game=${encodeURIComponent(slug)}`);
            const sj = s.ok ? await s.json() : { unlocks: [] };
            reply({ type: "loveweb:achievements:state", unlocks: sj.unlocks ?? [], identity });
          } catch { /* non-fatal */ }
        }
      } catch (e) {
        console.error("save-bridge error", e);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [slug, signedIn]);

  if (runtimeAvailable === null || webglOk === null) {
    return (
      <div className="panel p-10 text-center text-bone/60 text-sm">
        <div className="stamp mb-2">runtime</div>
        scanning runtime bundle…
      </div>
    );
  }

  if (webglOk === false) {
    return (
      <div className="panel p-8 text-sm">
        <div className="stamp mb-2 text-blood-red glow-red">webgl :: blocked</div>
        <p className="text-bone/80 mb-3">
          Your browser is not exposing a WebGL context. LÖVE2D cannot
          initialize without one, so the game can&apos;t start.
        </p>
        <p className="stamp mb-2 mt-5 text-abyss-cyan">if you&apos;re on brave</p>
        <ul className="text-bone/70 space-y-1.5 list-none pl-0">
          <li><span className="text-eldritch-purple">» </span>Click the <b className="text-bone">Brave Shields</b> icon in the address bar.</li>
          <li><span className="text-eldritch-purple">» </span>Set <b className="text-bone">Block fingerprinting</b> to <b className="text-abyss-cyan">Standard</b> (not Strict).</li>
          <li><span className="text-eldritch-purple">» </span>Or just turn <b className="text-bone">Shields Down</b> for <code className="text-amber-signal">games.brassey.io</code>.</li>
          <li><span className="text-eldritch-purple">» </span>Refresh the page.</li>
        </ul>
        <p className="stamp mb-2 mt-5 text-abyss-cyan">chrome / edge</p>
        <p className="text-bone/70">
          Check <code className="text-amber-signal">chrome://gpu</code> — WebGL should read
          <b className="text-matrix-green"> Hardware accelerated</b>. If it&apos;s disabled,
          turn on <b>Use hardware acceleration when available</b> in Settings → System.
        </p>
      </div>
    );
  }

  if (runtimeAvailable === false) {
    return (
      <div className="panel p-8 text-sm">
        <div className="stamp mb-2 text-amber-signal">runtime :: not yet compiled</div>
        <p className="text-bone/75 mb-3">
          The love.js bundle for <code className="text-abyss-cyan">{slug}</code> has
          not been compiled into this deployment yet.
        </p>
        <p className="text-bone/60 mb-3">Build it locally with:</p>
        <pre className="bg-void-1 border border-eldritch-deep/50 p-3 text-xs text-abyss-cyan overflow-auto">
pnpm build:claude-mythos
        </pre>
        <p className="text-bone/55 mt-4 text-xs">
          That script zips the LÖVE source at <code>~/Downloads/ClaudeMythos/</code> into
          a <code>.love</code> bundle and compiles it to <code>public/games/{slug}/runtime/</code>
          via love.js. Commit the result to deploy.
        </p>
      </div>
    );
  }

  // The frame sizes so the aspect ratio is always preserved AND the frame
  // never overflows the viewport vertically. We compute the max width the
  // 16:9 aspect ratio allows given available vertical space (100vh minus
  // header + page title + status bar + a bit of breathing room). The CSS
  // min() picks whichever axis is the binding constraint.
  //
  // Mobile: chrome is much tighter (~120px: header + title + status) and
  // the player wants every pixel they can get, so the desktop 200px
  // reserve would leave a tiny letterboxed canvas in portrait. We use
  // CSS env(safe-area-inset-*) to dodge home-indicators on iOS.
  const frameStyle = {
    // svh is the small-viewport unit — accounts for mobile browser
    // chrome that retracts on scroll. Falling back to vh on browsers
    // without svh support still works; just slightly conservative.
    maxHeight: `calc(100svh - var(--game-chrome, 200px))`,
    width: `min(100%, calc((100svh - var(--game-chrome, 200px)) * 16 / 9))`,
    aspectRatio: "16 / 9" as const,
  };

  return (
    <div className="flex flex-col items-center">
      <div
        ref={wrapRef}
        className="game-frame relative border border-eldritch-deep/60 bg-black overflow-hidden"
        style={
          {
            ...frameStyle,
            "--game-accent": accent,
          } as React.CSSProperties
        }
      >
        <iframe
          ref={iframeRef}
          src={`${runtimePath}/index.html?slug=${slug}`}
          title={slug}
          className="absolute inset-0 h-full w-full"
          // Permissions-Policy tokens. Chromium parses "fullscreen *" but
          // spec-strict browsers prefer the bare token — it defaults to the
          // iframe's own origin which is what we want for same-origin play.
          allow="autoplay; gamepad; fullscreen"
          allowFullScreen
          sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-popups allow-forms"
          // Belt-and-suspenders: push the manifest again on iframe load,
          // in case the iframe's inline `loveweb:hello` message fired
          // before our React `useEffect` attached its message listener.
          // The runtime's manifest promise only resolves once, so this is
          // a safe second chance and a no-op if hello was caught first.
          onLoad={() => { void pushManifest(); }}
        />
        {!booted && (
          <div className="absolute inset-0 flex items-center justify-center bg-void-0/80 pointer-events-none">
            <div className="font-mono text-abyss-cyan glow-cyan text-xs tracking-[0.3em]">
              LOADING RUNTIME<span className="caret" />
            </div>
          </div>
        )}
        {/* Floating exit handle. Sits above the iframe at top-right, low
            opacity until hovered so it doesn't distract during play.
            Always pointer-events-auto — the whole point is that it
            remains clickable even if the game has locked up, so the
            player is never stranded. */}
        <Link
          href="/"
          data-sfx="confirm"
          title="exit to library"
          className="absolute top-2 right-2 z-20 inline-flex items-center gap-1.5 px-2 py-1 text-[0.58rem] uppercase tracking-[0.22em] font-mono text-bone/55 bg-void-0/70 border border-eldritch-deep/60 hover:text-abyss-cyan hover:border-abyss-cyan/70 hover:bg-void-0/90 hover:shadow-[0_0_10px_#66e0ff55] transition-colors"
        >
          <span aria-hidden="true">↩</span>
          <span>exit</span>
        </Link>
        {/* Mobile touch overlay. No-op on desktop. The component itself
            checks `pointer:coarse` and the per-game `controls` config
            to decide what (if anything) to render. Synthesizes
            keyboard events into the iframe so games author for desktop
            input remain playable on a phone without any game-side
            change. */}
        <MobileControls iframeRef={iframeRef} config={gameMeta?.controls} />
        {/* Clean-exit overlay — shown when the game signaled love.event.quit
            (or onExit/onAbort). Auto-routes to /; the text here is just a
            friendly hand-off. */}
        {exited && (
          <div className="absolute inset-0 z-30 flex flex-col items-center justify-center bg-void-0/92 backdrop-blur-sm">
            <div
              className="stamp mb-2"
              style={{ color: accent, textShadow: `0 0 10px ${accent}aa` }}
            >
              session :: ended
            </div>
            <div className="text-lg uppercase tracking-[0.28em] text-bone/85">
              game exited cleanly
            </div>
            <div className="mt-3 text-[0.65rem] uppercase tracking-[0.28em] text-bone/45">
              returning to library<span className="caret" />
            </div>
          </div>
        )}
      </div>
      <div className="mt-3 w-full flex items-center justify-between gap-2 text-[0.6rem] sm:text-[0.65rem] uppercase tracking-[0.2em] sm:tracking-[0.25em] text-bone/50">
        <div className="flex items-center gap-2 sm:gap-3 min-w-0">
          <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${booted ? "bg-matrix-green shadow-[0_0_8px_#33ff66]" : "bg-amber-signal"}`} />
          <span className="truncate">{booted ? "runtime ready" : "loading…"}</span>
          {!signedIn && <span className="hidden sm:inline text-bone/45 ml-2">· sign in to save progress</span>}
        </div>
        {/* Reliable exit path. Lives OUTSIDE the iframe so it still works
            even if the Lua runtime has frozen itself with love.event.quit()
            or a hard lockup. Uses Next <Link> (not window.history.back —
            our popstate trap would re-push the guard state). */}
        <Link
          href="/"
          className="btn cyan !py-1 !px-2.5 !text-[0.62rem]"
          data-sfx="confirm"
          title="exit game — return to the library"
        >
          <span>↩</span>
          <span>exit game</span>
        </Link>
      </div>
      {/* Live achievement notifications — render at portal root (position:
          fixed) so they overlay the iframe even when the canvas is in
          fullscreen. Stack 3-deep; older ones auto-dismiss. */}
      <AchievementToast queue={toasts} accent={accent} onDismiss={dismissToast} />
    </div>
  );
}
