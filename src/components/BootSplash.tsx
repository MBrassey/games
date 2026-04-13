"use client";

import { useEffect, useState } from "react";

const LINES = [
  "BRASSEY TERMINAL v2.6.1 :: LOVE2D HOST RUNTIME",
  "> establishing uplink .................... ok",
  "> mounting /games ........................ ok",
  "> loading aesthetic: void.grid ........... ok",
  "> warming kv pub/sub ..................... ok",
  "> initializing crt rasterizer ............ ok",
  "> auth module: github oauth .............. ready",
  "> all systems nominal. welcome, operator.",
];

export default function BootSplash() {
  const [done, setDone] = useState(false);
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    try {
      if (sessionStorage.getItem("booted") === "1") {
        setDone(true);
        return;
      }
    } catch {}
    const t = setInterval(() => {
      setIdx((i) => {
        if (i + 1 >= LINES.length) {
          clearInterval(t);
          setTimeout(() => {
            try { sessionStorage.setItem("booted", "1"); } catch {}
            setDone(true);
          }, 700);
          return i + 1;
        }
        return i + 1;
      });
    }, 160);
    return () => clearInterval(t);
  }, []);

  if (done) return null;
  return (
    <div className="fixed inset-0 z-[100] bg-void-0 flex items-center justify-center">
      <div className="scan-sweep" />
      <div className="panel panel-glow w-[min(720px,90vw)] p-6 font-mono text-sm">
        <div className="flex items-center justify-between border-b border-eldritch-deep/50 pb-2 mb-3">
          <span className="stamp">session :: boot</span>
          <span className="stamp text-abyss-cyan">crt ok</span>
        </div>
        <div className="space-y-1">
          {LINES.slice(0, idx + 1).map((l, i) => {
            const isOk = l.includes("ok") || l.includes("ready");
            return (
              <div key={i} className="whitespace-pre">
                <span className="text-eldritch-purple">{"» "}</span>
                <span className={isOk ? "text-bone/80" : "text-bone/60"}>{l}</span>
                {i === idx && <span className="caret" />}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
