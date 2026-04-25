"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Touch overlay that synthesizes keyboard events into the game iframe so
// LÖVE games authored for desktop input become playable on a phone
// without any game-side change. love.js attaches its keyboard listeners
// at the iframe's `document` level — we dispatch standard KeyboardEvents
// there with `code`, `key`, and the legacy `keyCode` populated, which is
// indistinguishable from a real keypress as far as the runtime cares.
//
// Same-origin iframe access is required (sandbox grants `allow-same-origin`
// in GameRunner). If a future hardening tightens the sandbox, this whole
// component degrades to a no-op without breaking the game.

const KEY_CODE_MAP: Record<string, number> = {
  Space: 32,
  Enter: 13,
  Escape: 27,
  Tab: 9,
  ShiftLeft: 16,
  ShiftRight: 16,
  ControlLeft: 17,
  KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68,
  KeyE: 69, KeyQ: 81, KeyR: 82, KeyF: 70,
  KeyZ: 90, KeyX: 88, KeyC: 67,
  ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39,
  Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52,
};

function codeToKey(code: string): string {
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  if (code === "Space") return " ";
  if (code === "ShiftLeft" || code === "ShiftRight") return "Shift";
  if (code === "ControlLeft") return "Control";
  return code; // ArrowUp, Enter, Tab, Escape, …
}

function dispatchKey(doc: Document, type: "keydown" | "keyup", code: string) {
  const win = doc.defaultView;
  const init: KeyboardEventInit & { keyCode: number; which: number } = {
    code,
    key: codeToKey(code),
    keyCode: KEY_CODE_MAP[code] ?? 0,
    which: KEY_CODE_MAP[code] ?? 0,
    bubbles: true,
    cancelable: true,
    composed: true,
    view: win ?? undefined,
  };
  // love.js / emscripten attach to the document; some games bind window
  // too. Fan out to both for compatibility — the game will only see
  // each press once because it tracks the same logical key.
  try { doc.dispatchEvent(new KeyboardEvent(type, init)); } catch {}
  try {
    if (win) win.dispatchEvent(new (win as Window & typeof globalThis).KeyboardEvent(type, init));
  } catch {}
}

type ActionDef = { code: string; label: string };

export type MobileControlsConfig = {
  mode: "movement" | "tap" | "off";
  actions?: ActionDef[];
};

const DEFAULT_ACTIONS: ActionDef[] = [
  { code: "Space", label: "✦" },
  { code: "KeyE",  label: "E" },
];

export default function MobileControls({
  iframeRef,
  config,
}: {
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  config: MobileControlsConfig | undefined;
}) {
  // Treat undefined config as "movement" — most games are keyboard-driven.
  const mode = config?.mode ?? "movement";
  const actions = config?.actions ?? DEFAULT_ACTIONS;

  const [isTouch, setIsTouch] = useState(false);
  const [open, setOpen] = useState(false);
  const heldRef = useRef<Set<string>>(new Set());
  const stickOriginRef = useRef<{ x: number; y: number } | null>(null);
  const stickPosRef = useRef<{ x: number; y: number } | null>(null);
  const [stickVisible, setStickVisible] = useState(false);
  const [stickOriginXY, setStickOriginXY] = useState<{ x: number; y: number } | null>(null);
  const [stickKnobXY, setStickKnobXY] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const m = window.matchMedia("(pointer: coarse)");
    const sync = () => setIsTouch(m.matches);
    sync();
    // Open by default on touch devices for movement-mode games.
    if (m.matches && mode === "movement") setOpen(true);
    try { m.addEventListener("change", sync); } catch { m.addListener(sync); }
    return () => {
      try { m.removeEventListener("change", sync); } catch { m.removeListener(sync); }
    };
  }, [mode]);

  // Apply a desired held-set: dispatch keydowns/keyups to bring the
  // iframe into matching state. Idempotent — repeat calls with the same
  // set do nothing.
  const applyHeld = useCallback((next: Set<string>) => {
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    const prev = heldRef.current;
    for (const code of next) {
      if (!prev.has(code)) dispatchKey(doc, "keydown", code);
    }
    for (const code of prev) {
      if (!next.has(code)) dispatchKey(doc, "keyup", code);
    }
    heldRef.current = next;
  }, [iframeRef]);

  // Release everything when the overlay closes / unmounts so the game
  // doesn't get stuck thinking a key is held.
  useEffect(() => {
    if (!open) applyHeld(new Set());
    return () => { applyHeld(new Set()); };
  }, [open, applyHeld]);

  const STICK_RADIUS = 56; // px; max thumb travel
  const DEAD_ZONE = 0.18;  // 0..1 fraction of stick radius

  const updateStick = (clientX: number, clientY: number) => {
    const origin = stickOriginRef.current;
    if (!origin) return;
    const dx = clientX - origin.x;
    const dy = clientY - origin.y;
    const r = Math.hypot(dx, dy);
    const clamped = Math.min(r, STICK_RADIUS);
    const ux = r === 0 ? 0 : (dx / r) * (clamped / STICK_RADIUS);
    const uy = r === 0 ? 0 : (dy / r) * (clamped / STICK_RADIUS);

    const next = new Set<string>();
    if (Math.abs(ux) > DEAD_ZONE || Math.abs(uy) > DEAD_ZONE) {
      // Threshold lower than full magnitude so corners trigger reliably.
      if (ux < -0.32) { next.add("ArrowLeft");  next.add("KeyA"); }
      if (ux >  0.32) { next.add("ArrowRight"); next.add("KeyD"); }
      if (uy < -0.32) { next.add("ArrowUp");    next.add("KeyW"); }
      if (uy >  0.32) { next.add("ArrowDown");  next.add("KeyS"); }
    }
    applyHeld(next);

    const knobX = origin.x + ux * STICK_RADIUS;
    const knobY = origin.y + uy * STICK_RADIUS;
    stickPosRef.current = { x: knobX, y: knobY };
    setStickKnobXY({ x: knobX, y: knobY });
  };

  const onStickStart = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    stickOriginRef.current = { x: e.clientX, y: e.clientY };
    setStickOriginXY({ x: e.clientX, y: e.clientY });
    setStickKnobXY({ x: e.clientX, y: e.clientY });
    setStickVisible(true);
  };

  const onStickMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!stickOriginRef.current) return;
    e.preventDefault();
    updateStick(e.clientX, e.clientY);
  };

  const onStickEnd = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    stickOriginRef.current = null;
    stickPosRef.current = null;
    setStickVisible(false);
    setStickOriginXY(null);
    setStickKnobXY(null);
    applyHeld(new Set());
  };

  const onActionDown = (code: string) => (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    if (!heldRef.current.has(code)) {
      heldRef.current.add(code);
      dispatchKey(doc, "keydown", code);
    }
  };

  const onActionUp = (code: string) => (e: React.PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;
    if (heldRef.current.has(code)) {
      heldRef.current.delete(code);
      dispatchKey(doc, "keyup", code);
    }
  };

  // Don't render anything on desktop / non-touch.
  if (!isTouch || mode === "off") return null;

  // Mode "tap" — game already handles native touch events via
  // love.touch/mousepressed. Nothing to inject; render a tiny info pill
  // so the user understands they can just tap the game directly.
  if (mode === "tap") {
    return null;
  }

  // Collapsed: just a small floating button bottom-left so the game UI
  // is unobstructed. Tap to expand the joystick + action buttons.
  if (!open) {
    return (
      <button
        onClick={(e) => { e.preventDefault(); setOpen(true); }}
        className="absolute bottom-2 left-2 z-30 inline-flex items-center gap-1.5 px-3 py-2 text-[0.6rem] uppercase tracking-[0.2em] font-mono text-bone/75 bg-void-0/80 border border-eldritch-deep/70 rounded-sm hover:text-abyss-cyan hover:border-abyss-cyan/70 active:scale-95 transition"
        aria-label="Show touch controls"
      >
        <span aria-hidden>🎮</span>
        <span>controls</span>
      </button>
    );
  }

  return (
    <>
      {/* Joystick zone — left third of the frame, bottom 60%. Rest of
          the frame stays click-through so on-screen game UI keeps
          working. */}
      <div
        onPointerDown={onStickStart}
        onPointerMove={onStickMove}
        onPointerUp={onStickEnd}
        onPointerCancel={onStickEnd}
        onPointerLeave={onStickEnd}
        className="absolute left-0 bottom-0 z-30 h-[55%] w-[42%] touch-none select-none"
        style={{ pointerEvents: "auto" }}
        aria-label="Movement joystick zone"
      >
        {stickVisible && stickOriginXY && stickKnobXY && (
          <>
            {/* Stick base */}
            <div
              className="pointer-events-none fixed rounded-full border border-bone/40 bg-bone/5 backdrop-blur-sm"
              style={{
                left: stickOriginXY.x - STICK_RADIUS,
                top: stickOriginXY.y - STICK_RADIUS,
                width: STICK_RADIUS * 2,
                height: STICK_RADIUS * 2,
                boxShadow: "0 0 18px rgba(102,224,255,0.20) inset",
              }}
            />
            {/* Stick knob */}
            <div
              className="pointer-events-none fixed rounded-full border border-abyss-cyan bg-abyss-cyan/30"
              style={{
                left: stickKnobXY.x - 22,
                top: stickKnobXY.y - 22,
                width: 44,
                height: 44,
                boxShadow: "0 0 12px rgba(102,224,255,0.55)",
              }}
            />
          </>
        )}
      </div>

      {/* Action buttons — right side, stacked. */}
      <div
        className="absolute bottom-3 right-3 z-30 flex flex-col items-end gap-2 select-none"
        style={{ pointerEvents: "none" }}
      >
        {actions.map((a) => (
          <button
            key={a.code}
            onPointerDown={onActionDown(a.code)}
            onPointerUp={onActionUp(a.code)}
            onPointerCancel={onActionUp(a.code)}
            onPointerLeave={onActionUp(a.code)}
            onContextMenu={(e) => e.preventDefault()}
            className="touch-none flex items-center justify-center h-14 w-14 rounded-full font-mono text-base text-bone/90 bg-void-0/80 border border-eldritch-purple/70 active:bg-eldritch-purple/30 active:scale-95 transition"
            style={{ pointerEvents: "auto", boxShadow: "0 0 10px rgba(138,79,255,0.35)" }}
            aria-label={`Action ${a.label}`}
          >
            {a.label}
          </button>
        ))}
      </div>

      {/* Hide-controls pill — top-left of the frame so it doesn't fight
          the always-visible exit handle on the top-right. */}
      <button
        onClick={(e) => { e.preventDefault(); setOpen(false); }}
        className="absolute top-2 left-2 z-30 inline-flex items-center gap-1.5 px-2 py-1 text-[0.55rem] uppercase tracking-[0.22em] font-mono text-bone/55 bg-void-0/70 border border-eldritch-deep/60 hover:text-abyss-cyan hover:border-abyss-cyan/70"
        aria-label="Hide touch controls"
      >
        <span aria-hidden>×</span>
        <span>hide controls</span>
      </button>
    </>
  );
}
