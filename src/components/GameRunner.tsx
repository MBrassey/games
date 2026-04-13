"use client";

import { useEffect, useRef, useState } from "react";

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
  const [runtimeAvailable, setRuntimeAvailable] = useState<boolean | null>(null);
  const [booted, setBooted] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

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

  if (runtimeAvailable === null) {
    return (
      <div className="panel p-10 text-center text-bone/60 text-sm">
        <div className="stamp mb-2">runtime</div>
        scanning runtime bundle…
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

  return (
    <div className={`relative ${fullscreen ? "fixed inset-0 z-50 bg-void-0 p-4" : ""}`}>
      <div className="relative border border-eldritch-deep/60 bg-black overflow-hidden" style={{ aspectRatio: "16/9" }}>
        <iframe
          ref={iframeRef}
          src={`${runtimePath}/index.html?slug=${slug}`}
          title={slug}
          className="absolute inset-0 h-full w-full"
          allow="autoplay; gamepad; fullscreen"
          sandbox="allow-scripts allow-same-origin allow-pointer-lock allow-popups"
        />
        {!booted && (
          <div className="absolute inset-0 flex items-center justify-center bg-void-0/80 pointer-events-none">
            <div className="font-mono text-abyss-cyan glow-cyan text-xs tracking-[0.3em]">
              LOADING RUNTIME<span className="caret" />
            </div>
          </div>
        )}
      </div>
      <div className="mt-3 flex items-center justify-between text-[0.65rem] uppercase tracking-[0.25em] text-bone/50">
        <div className="flex items-center gap-3">
          <span className={`inline-block h-1.5 w-1.5 rounded-full ${booted ? "bg-matrix-green shadow-[0_0_8px_#33ff66]" : "bg-amber-signal"}`} />
          {booted ? "runtime ready" : "loading…"}
          {!signedIn && <span className="text-amber-signal ml-3">· not signed in — saves disabled</span>}
        </div>
        <button className="btn" onClick={() => setFullscreen((f) => !f)}>
          {fullscreen ? "▸ exit fullscreen" : "▸ fullscreen"}
        </button>
      </div>
    </div>
  );
}
