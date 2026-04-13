"use client";

import { useEffect, useRef, useState } from "react";
import { sound } from "@/lib/sound";

type IncomingMsg =
  | { type: "loveweb:ready"; game: string }
  | { type: "loveweb:save:write"; path: string; dataB64: string; meta?: Record<string, unknown> }
  | { type: "loveweb:save:read"; path: string; reqId: string }
  | { type: "loveweb:save:list"; reqId: string }
  | { type: "loveweb:log"; level: string; msg: string };

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

  // Soft-mute the portal music while a game page is loaded, without
  // tearing down the audio engine. UI SFX still work; navigating back
  // fades music in again. Important: we don't call sound.disable() /
  // sound.enable() here — those dispose and recreate audio nodes, which
  // made non-game link clicks occasionally kill music due to a race
  // between stopMusic's delayed cleanup and a fresh startMusic.
  useEffect(() => {
    const restore = sound.softMuteMusic();
    return () => { restore(); };
  }, []);

  // Playtime tracking: POST to /api/stats/heartbeat every 30s while the
  // runtime is alive. The server rolls heartbeats into sessions (see
  // migrations/0002_stats.sql). Only runs when signed in.
  useEffect(() => {
    if (!booted || !signedIn) return;
    const ping = () => {
      fetch("/api/stats/heartbeat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ game: slug }),
        keepalive: true,
      }).catch(() => {});
    };
    ping();
    const t = setInterval(ping, 30_000);
    return () => clearInterval(t);
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
        if (data.type === "loveweb:ready") {
          setBooted(true);
          // Push initial save manifest so runtime can prepopulate its FS
          if (signedIn) {
            const r = await fetch(`/api/saves?game=${encodeURIComponent(slug)}`);
            if (r.ok) {
              const { files } = await r.json();
              reply({ type: "loveweb:saves:manifest", files });
            }
          }
          reply({ type: "loveweb:auth", signedIn });
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
  const VERT_CHROME = 200; // px reserved for header + page title + status bar + padding
  const frameStyle = {
    maxHeight: `calc(100vh - ${VERT_CHROME}px)`,
    // width that maxes out at (max-height * 16/9) so vertical never spills
    width: `min(100%, calc((100vh - ${VERT_CHROME}px) * 16 / 9))`,
    aspectRatio: "16 / 9" as const,
  };

  return (
    <div className="flex flex-col items-center">
      <div
        ref={wrapRef}
        className="relative border border-eldritch-deep/60 bg-black overflow-hidden"
        style={frameStyle}
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
        />
        {!booted && (
          <div className="absolute inset-0 flex items-center justify-center bg-void-0/80 pointer-events-none">
            <div className="font-mono text-abyss-cyan glow-cyan text-xs tracking-[0.3em]">
              LOADING RUNTIME<span className="caret" />
            </div>
          </div>
        )}
      </div>
      <div className="mt-3 w-full flex items-center text-[0.65rem] uppercase tracking-[0.25em] text-bone/50">
        <div className="flex items-center gap-3">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${booted ? "bg-matrix-green shadow-[0_0_8px_#33ff66]" : "bg-amber-signal"}`} />
          {booted ? "runtime ready" : "loading…"}
          {!signedIn && <span className="text-amber-signal ml-3">· not signed in — saves disabled</span>}
        </div>
      </div>
    </div>
  );
}
