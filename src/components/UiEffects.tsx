"use client";

import { useEffect, useRef } from "react";

// ============================================================
// UiEffects — game-driven portal chrome modulation
// ============================================================
//
// A game running in the sandboxed iframe can reach out and affect the
// surrounding portal UI via the magic-print channel. The runtime shell
// intercepts `print("[[LOVEWEB_FX]]<verb> <args...>")` from Lua, wraps
// it into a `loveweb:fx` postMessage, and this component applies the
// effect to the live DOM.
//
// What this enables (for game authors):
//   • Screen flashes tied to hits, explosions, crits
//   • Screen shake on impact
//   • Brief color inversion on death / altar trigger
//   • Persistent "mood" tint during a boss fight (cleared when the
//     encounter ends)
//   • Pulses, glows, chromatic aberration, vignette pushes
//
// What the portal guarantees:
//   • Every effect is clamped — max intensity 1.0, max duration 2.5s.
//     A buggy game can't lock the UI in a forever-strobe.
//   • `flash` and `invert` have an anti-strobe floor: consecutive
//     uses inside 140 ms get merged/ignored to stay photosensitive-safe.
//   • `prefers-reduced-motion` users get color-only effects (tint,
//     mood, glow) at reduced intensity; shake/flash/invert/chroma skip.
//   • All effects are pointer-events-none, so gameplay focus is never
//     stolen.
//
// Protocol reference (see INTEGRATION.md for full details):
//   flash     <css-color> <ms>                       — one-shot screen flash
//   shake     <0..1> <ms>                            — wrapper translate oscillation
//   invert    <ms>                                   — inverted colors for ms
//   tint      <css-color> <alpha> <ms>               — color wash, fades in/out
//   mood      <css-color> <0..1>                     — persistent breathing tint
//   mood      none                                   — clear mood
//   pulse     <css-color> <ms>                       — expanding ring from center
//   ripple    <css-color> <x%> <y%> <ms>             — ripple radiating from point
//   glow      <css-color> <0..1> <ms>                — edge-lit halo
//   chroma    <0..1> <ms>                            — RGB-split filter
//   vignette  <0..1> <ms>                            — darkened edges
//   shatter   <0..1> <ms>                            — glass-crack glitch + flash + shake
//   calm      <css-color> <0..1>                     — persistent soft breathing radial (soothing)
//   calm      none                                   — clear calm
//   pulsate   <css-color> <bpm> <0..1>               — rhythmic heartbeat throb
//   pulsate   off                                    — clear pulsate
//   flicker   <0..1> <ms>                            — brightness flicker
//   zoom      <-0.1..0.1> <ms>                       — brief scale push/pull
//   scanlines <0..1> <ms>                            — intensify CRT scanlines

type FxIncoming = {
  type: "loveweb:fx";
  verb: string;
  args: string[];
};

const MAX_DURATION_MS = 2500;
const DEFAULT_DURATION_MS = 300;
const MIN_FLASH_INTERVAL_MS = 140;      // anti-strobe floor
const MIN_INVERT_INTERVAL_MS = 180;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// Very permissive color sanitizer. Accepts named colors, hex (#rgb,
// #rgba, #rrggbb, #rrggbbaa), rgb()/rgba()/hsl()/hsla(). Anything else
// falls back to a neutral portal purple.
function sanitizeColor(c: string | undefined): string {
  if (!c) return "#8a4fff";
  const s = c.trim();
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return s;
  if (/^(rgb|hsl)a?\([^)]+\)$/i.test(s)) return s;
  if (/^[a-z]+$/i.test(s)) return s;
  return "#8a4fff";
}

function parseMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return clamp(Math.round(n), 30, MAX_DURATION_MS);
}
function parse01(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return clamp(n, 0, 1);
}

export default function UiEffects() {
  const layersRef = useRef<HTMLDivElement>(null);

  // Track last-fired timestamps for anti-strobe rails. Stored in refs so
  // they survive re-renders but never reach React state (no re-render
  // churn).
  const lastFlashAt = useRef(0);
  const lastInvertAt = useRef(0);

  // Shake control: RAF loop that applies a dampened oscillation to CSS
  // variables on the #ui-shake root. Wrapper component in layout.tsx is
  // responsible for `transform: translate3d(var(--shake-x), var(--shake-y), 0)`.
  const shakeUntil = useRef(0);
  const shakeRaf = useRef<number | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const layers = layersRef.current;
    if (!layers) return;

    const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    // Resolve child layer nodes once; we update their inline styles
    // imperatively. React never re-renders from a fx message — we
    // deliberately bypass state to avoid committing 60Hz updates during
    // shake.
    const flash    = layers.querySelector<HTMLDivElement>("#ui-fx-flash");
    const tint     = layers.querySelector<HTMLDivElement>("#ui-fx-tint");
    const mood     = layers.querySelector<HTMLDivElement>("#ui-fx-mood");
    const glow     = layers.querySelector<HTMLDivElement>("#ui-fx-glow");
    const pulse    = layers.querySelector<HTMLDivElement>("#ui-fx-pulse");
    const vignette = layers.querySelector<HTMLDivElement>("#ui-fx-vignette");
    const shakeRoot = document.getElementById("ui-shake");

    function fireFlash(color: string, durationMs: number, intensity: number) {
      if (!flash) return;
      if (prefersReduced) { fireTint(color, intensity * 0.25, 200); return; }
      const now = performance.now();
      if (now - lastFlashAt.current < MIN_FLASH_INTERVAL_MS) return;
      lastFlashAt.current = now;

      flash.style.background = color;
      flash.style.opacity = String(clamp(intensity, 0, 0.9));
      flash.style.transition = "none";
      // Force reflow so the transition starts from the peak
      void flash.offsetHeight;
      flash.style.transition = `opacity ${durationMs}ms cubic-bezier(0.2, 0, 0.3, 1)`;
      flash.style.opacity = "0";
    }

    function fireShake(intensity: number, durationMs: number) {
      if (!shakeRoot) return;
      if (prefersReduced) return;
      const now = performance.now();
      const end = now + durationMs;
      if (end > shakeUntil.current) shakeUntil.current = end;

      const startedAt = shakeUntil.current - durationMs;
      const basePx = 14 * intensity;
      if (shakeRaf.current) return; // already ticking
      const tick = () => {
        const t = performance.now();
        if (t >= shakeUntil.current) {
          shakeRoot.style.setProperty("--shake-x", "0px");
          shakeRoot.style.setProperty("--shake-y", "0px");
          shakeRaf.current = null;
          return;
        }
        // Dampen amplitude linearly to zero across the remaining time.
        const remain = (shakeUntil.current - t) / (shakeUntil.current - startedAt);
        const amp = basePx * Math.max(0, remain);
        // Jitter at ~60Hz; high-frequency random is the goal, not a
        // structured sine. Two independent axes with slight bias toward
        // horizontal (plays better on widescreen viewports).
        const x = (Math.random() * 2 - 1) * amp;
        const y = (Math.random() * 2 - 1) * amp * 0.8;
        shakeRoot.style.setProperty("--shake-x", `${x.toFixed(2)}px`);
        shakeRoot.style.setProperty("--shake-y", `${y.toFixed(2)}px`);
        shakeRaf.current = requestAnimationFrame(tick);
      };
      shakeRaf.current = requestAnimationFrame(tick);
    }

    function fireInvert(durationMs: number) {
      if (prefersReduced) return;
      const now = performance.now();
      if (now - lastInvertAt.current < MIN_INVERT_INTERVAL_MS) return;
      lastInvertAt.current = now;
      document.body.classList.add("fx-invert");
      window.setTimeout(() => { document.body.classList.remove("fx-invert"); }, durationMs);
    }

    function fireTint(color: string, alpha: number, durationMs: number) {
      if (!tint) return;
      // Reduced-motion: cap alpha to stay gentle.
      const finalAlpha = prefersReduced ? clamp(alpha, 0, 0.35) : clamp(alpha, 0, 0.8);
      tint.style.background = color;
      tint.style.transition = "opacity 120ms ease-out";
      tint.style.opacity = String(finalAlpha);
      window.setTimeout(() => {
        if (!tint) return;
        tint.style.transition = `opacity ${Math.max(160, durationMs)}ms cubic-bezier(0.2, 0, 0.3, 1)`;
        tint.style.opacity = "0";
      }, Math.max(40, durationMs - 160));
    }

    function setMood(color: string | null, intensity: number) {
      if (!mood) return;
      if (!color) {
        mood.style.transition = "opacity 900ms ease-out";
        mood.style.opacity = "0";
        return;
      }
      const finalIntensity = prefersReduced ? clamp(intensity, 0, 0.12) : clamp(intensity, 0, 0.45);
      mood.style.background = color;
      mood.style.transition = "background 900ms ease, opacity 900ms ease";
      mood.style.opacity = String(finalIntensity);
    }

    function firePulse(color: string, durationMs: number) {
      if (!pulse) return;
      if (prefersReduced) return;
      pulse.style.setProperty("--pulse-color", color);
      // The animation runs on #ui-fx-pulse::after; pseudo-elements
      // inherit custom properties, so the duration is piped via a
      // CSS var. Remove/force reflow/re-add the run class so each
      // call retriggers the keyframe from frame 0.
      pulse.classList.remove("fx-pulse-run");
      void pulse.offsetHeight;
      pulse.style.setProperty("--pulse-duration", `${durationMs}ms`);
      pulse.classList.add("fx-pulse-run");
    }

    function fireGlow(color: string, intensity: number, durationMs: number) {
      if (!glow) return;
      const finalIntensity = prefersReduced ? clamp(intensity, 0, 0.25) : clamp(intensity, 0, 1);
      glow.style.setProperty("--glow-color", color);
      glow.style.setProperty("--glow-intensity", String(finalIntensity));
      glow.style.transition = "opacity 140ms ease-out";
      glow.style.opacity = "1";
      window.setTimeout(() => {
        glow.style.transition = `opacity ${durationMs}ms cubic-bezier(0.2, 0, 0.3, 1)`;
        glow.style.opacity = "0";
      }, Math.max(40, durationMs - 160));
    }

    function fireChroma(intensity: number, durationMs: number) {
      if (prefersReduced) return;
      document.body.style.setProperty("--chroma-intensity", String(clamp(intensity, 0, 1)));
      document.body.classList.add("fx-chroma");
      window.setTimeout(() => { document.body.classList.remove("fx-chroma"); }, durationMs);
    }

    function fireVignette(intensity: number, durationMs: number) {
      if (!vignette) return;
      const finalIntensity = prefersReduced ? clamp(intensity, 0, 0.35) : clamp(intensity, 0, 0.9);
      vignette.style.transition = "opacity 160ms ease-out";
      vignette.style.opacity = String(finalIntensity);
      window.setTimeout(() => {
        vignette.style.transition = `opacity ${durationMs}ms cubic-bezier(0.2, 0, 0.3, 1)`;
        vignette.style.opacity = "0";
      }, Math.max(40, durationMs - 160));
    }

    // Ripple — a concentric wave expanding from an origin point. We
    // instantiate a detached DOM node per ripple so multiple can overlap
    // without stepping on each other's animation timers. GC'd by CSS
    // `animationend`.
    const rippleHost = layers;
    function fireRipple(color: string, xPct: number, yPct: number, durationMs: number) {
      if (prefersReduced) return;
      const r = document.createElement("span");
      r.className = "fx-ripple";
      r.style.setProperty("--rx", `${clamp(xPct, 0, 100)}%`);
      r.style.setProperty("--ry", `${clamp(yPct, 0, 100)}%`);
      r.style.setProperty("--ripple-color", color);
      r.style.setProperty("animation-duration", `${durationMs}ms`);
      rippleHost.appendChild(r);
      const cleanup = () => { r.remove(); };
      r.addEventListener("animationend", cleanup, { once: true });
      // Safety: guarantee cleanup even if animationend misfires.
      window.setTimeout(cleanup, durationMs + 400);
    }

    // Shatter — the screen "cracks". Implemented as a composite: a bright
    // flash + strong chroma + strong shake + an SVG glass-crack overlay
    // that fades. Lasts ~durationMs. Photosensitive-safe: we still honor
    // anti-strobe rails on the flash component.
    function fireShatter(intensity: number, durationMs: number) {
      if (prefersReduced) return;
      const i = clamp(intensity, 0, 1);
      const flashColor = "#fff3c8";
      fireFlash(flashColor, Math.max(140, durationMs * 0.4), 0.55 + 0.35 * i);
      fireChroma(0.5 + 0.5 * i, Math.max(180, durationMs * 0.6));
      fireShake(0.65 + 0.35 * i, Math.max(320, durationMs * 0.85));
      const s = document.createElement("span");
      s.className = "fx-shatter";
      s.style.setProperty("animation-duration", `${Math.max(400, durationMs)}ms`);
      s.style.setProperty("--shatter-intensity", String(i));
      rippleHost.appendChild(s);
      const cleanup = () => { s.remove(); };
      s.addEventListener("animationend", cleanup, { once: true });
      window.setTimeout(cleanup, durationMs + 600);
    }

    // Calm — persistent soothing breathing radial glow from the center.
    // Different from `mood` (which tints the whole viewport uniformly):
    // calm is a soft circular falloff that radiates outward and feels
    // meditative rather than ambient. Toggle with `calm none`.
    function setCalm(color: string | null, intensity: number) {
      const host = document.getElementById("ui-fx-calm");
      if (!host) return;
      if (!color) {
        host.style.transition = "opacity 1800ms ease";
        host.style.opacity = "0";
        return;
      }
      const i = prefersReduced ? clamp(intensity, 0, 0.12) : clamp(intensity, 0, 0.55);
      host.style.setProperty("--calm-color", color);
      host.style.transition = "background 1400ms ease, opacity 1400ms ease";
      host.style.opacity = String(i);
    }

    // Pulsate — rhythmic throb at BPM. Different from `pulse` (single
    // ring out) — pulsate is a persistent heartbeat on a dedicated layer.
    // `pulsate off` stops it. BPM clamped to 20–200 so an errant 9999 BPM
    // can't drive the browser into a seizure-strobe pattern.
    function setPulsate(color: string | null, bpm: number, intensity: number) {
      const host = document.getElementById("ui-fx-pulsate");
      if (!host) return;
      if (!color) {
        host.style.animation = "none";
        host.style.opacity = "0";
        return;
      }
      const safeBpm = clamp(bpm, 20, 200);
      const period = 60 / safeBpm;
      const i = prefersReduced ? clamp(intensity, 0, 0.15) : clamp(intensity, 0, 0.7);
      host.style.setProperty("--pulsate-color", color);
      host.style.setProperty("--pulsate-peak", String(i));
      host.style.animation = `fx-pulsate ${period.toFixed(3)}s ease-in-out infinite`;
      host.style.opacity = "1";
    }

    // Flicker — rapid brightness jitter on the entire UI for durationMs.
    // Reads as "transmission interference". We add a class that drives a
    // keyframe; remove after the duration.
    function fireFlicker(intensity: number, durationMs: number) {
      if (prefersReduced) return;
      const i = clamp(intensity, 0, 1);
      document.body.style.setProperty("--flicker-amp", String(0.4 * i));
      document.body.classList.add("fx-flicker");
      window.setTimeout(() => { document.body.classList.remove("fx-flicker"); }, durationMs);
    }

    // Zoom — brief scale push/pull. Applies to the shake-root wrapper
    // via a CSS variable so it composes cleanly with live shake.
    function fireZoom(amount: number, durationMs: number) {
      if (!shakeRoot) return;
      if (prefersReduced) return;
      const a = clamp(amount, -0.1, 0.1);
      shakeRoot.style.setProperty("--zoom-scale", String(1 + a));
      shakeRoot.style.transition = `transform ${Math.round(durationMs * 0.45)}ms cubic-bezier(0.2, 0, 0.2, 1)`;
      window.setTimeout(() => {
        if (!shakeRoot) return;
        shakeRoot.style.setProperty("--zoom-scale", "1");
        shakeRoot.style.transition = `transform ${Math.round(durationMs * 0.55)}ms cubic-bezier(0.3, 1, 0.3, 1)`;
      }, Math.round(durationMs * 0.45));
    }

    // Scanline surge — intensify the persistent CRT scanline overlay for
    // durationMs. Body::before owns the scanlines; we poke a CSS variable
    // it consumes. Cleared by unsetting the class.
    function fireScanlines(intensity: number, durationMs: number) {
      const i = prefersReduced ? clamp(intensity, 0, 0.4) : clamp(intensity, 0, 1);
      document.body.style.setProperty("--scanlines-surge", String(i));
      document.body.classList.add("fx-scanlines-surge");
      window.setTimeout(() => {
        if (!prefersReduced) document.body.style.setProperty("--scanlines-surge", "0");
        document.body.classList.remove("fx-scanlines-surge");
      }, durationMs);
    }

    function onMessage(ev: MessageEvent) {
      const d = ev.data as FxIncoming | undefined;
      if (!d || typeof d !== "object" || d.type !== "loveweb:fx") return;
      const args = Array.isArray(d.args) ? d.args : [];
      switch (d.verb) {
        case "flash": {
          const color = sanitizeColor(args[0]);
          const ms = parseMs(args[1], DEFAULT_DURATION_MS);
          const intensity = parse01(args[2], 0.6);
          fireFlash(color, ms, intensity);
          break;
        }
        case "shake": {
          const intensity = parse01(args[0], 0.5);
          const ms = parseMs(args[1], 280);
          fireShake(intensity, ms);
          break;
        }
        case "invert": {
          const ms = parseMs(args[0], 120);
          fireInvert(ms);
          break;
        }
        case "tint": {
          const color = sanitizeColor(args[0]);
          const alpha = parse01(args[1], 0.2);
          const ms = parseMs(args[2], 500);
          fireTint(color, alpha, ms);
          break;
        }
        case "mood": {
          const first = args[0];
          if (!first || first === "none" || first === "null" || first === "off") {
            setMood(null, 0);
          } else {
            const color = sanitizeColor(first);
            const intensity = parse01(args[1], 0.15);
            setMood(color, intensity);
          }
          break;
        }
        case "pulse": {
          const color = sanitizeColor(args[0]);
          const ms = parseMs(args[1], 600);
          firePulse(color, ms);
          break;
        }
        case "glow": {
          const color = sanitizeColor(args[0]);
          const intensity = parse01(args[1], 0.5);
          const ms = parseMs(args[2], 400);
          fireGlow(color, intensity, ms);
          break;
        }
        case "chroma": {
          const intensity = parse01(args[0], 0.4);
          const ms = parseMs(args[1], 200);
          fireChroma(intensity, ms);
          break;
        }
        case "vignette": {
          const intensity = parse01(args[0], 0.5);
          const ms = parseMs(args[1], 500);
          fireVignette(intensity, ms);
          break;
        }
        case "ripple": {
          const color = sanitizeColor(args[0]);
          const x = parse01(args[1], 0.5) * 100;
          const y = parse01(args[2], 0.5) * 100;
          const ms = parseMs(args[3], 900);
          fireRipple(color, x, y, ms);
          break;
        }
        case "shatter": {
          const intensity = parse01(args[0], 0.8);
          const ms = parseMs(args[1], 650);
          fireShatter(intensity, ms);
          break;
        }
        case "calm": {
          const first = args[0];
          if (!first || first === "none" || first === "off" || first === "null") {
            setCalm(null, 0);
          } else {
            const color = sanitizeColor(first);
            const intensity = parse01(args[1], 0.3);
            setCalm(color, intensity);
          }
          break;
        }
        case "pulsate": {
          const first = args[0];
          if (!first || first === "none" || first === "off") {
            setPulsate(null, 0, 0);
          } else {
            const color = sanitizeColor(first);
            const bpm = Number(args[1]);
            const safeBpm = Number.isFinite(bpm) ? bpm : 60;
            const intensity = parse01(args[2], 0.35);
            setPulsate(color, safeBpm, intensity);
          }
          break;
        }
        case "flicker": {
          const intensity = parse01(args[0], 0.5);
          const ms = parseMs(args[1], 240);
          fireFlicker(intensity, ms);
          break;
        }
        case "zoom": {
          const amt = Number(args[0]);
          const safe = Number.isFinite(amt) ? amt : 0.04;
          const ms = parseMs(args[1], 360);
          fireZoom(safe, ms);
          break;
        }
        case "scanlines": {
          const intensity = parse01(args[0], 0.6);
          const ms = parseMs(args[1], 600);
          fireScanlines(intensity, ms);
          break;
        }
        default:
          // Unknown verb — silent. Forward compat: future game ships a
          // newer verb; old portal gracefully ignores.
          break;
      }
    }

    window.addEventListener("message", onMessage);

    // Dev hook: `window.__portalFx("flash", "#ff6699", "300")` mirrors
    // the postMessage path so the FX system can be exercised from the
    // console without a running game. Also useful for the /integration
    // examples in the docs.
    try {
      (window as unknown as { __portalFx: (verb: string, ...args: string[]) => void }).__portalFx =
        (verb: string, ...args: string[]) => {
          onMessage(new MessageEvent("message", { data: { type: "loveweb:fx", verb, args } }));
        };
    } catch { /* no-op */ }

    return () => {
      window.removeEventListener("message", onMessage);
      if (shakeRaf.current) cancelAnimationFrame(shakeRaf.current);
    };
  }, []);

  return (
    <div
      ref={layersRef}
      id="ui-fx-layers"
      className="pointer-events-none fixed inset-0 z-[9998]"
      aria-hidden
    >
      {/* Persistent, slow-moving. Cleared with `mood none`. */}
      <div id="ui-fx-mood" className="absolute inset-0" style={{ opacity: 0, mixBlendMode: "screen" }} />
      {/* Soothing soft radial — set/cleared via `calm`. Different blend
          mode than mood so it reads as a warm glow rather than a wash. */}
      <div id="ui-fx-calm" className="absolute inset-0" style={{ opacity: 0 }} />
      {/* Rhythmic heartbeat — runs an infinite keyframe when active. */}
      <div id="ui-fx-pulsate" className="absolute inset-0" style={{ opacity: 0, mixBlendMode: "screen" }} />
      {/* One-shot tint wash. */}
      <div id="ui-fx-tint" className="absolute inset-0" style={{ opacity: 0, mixBlendMode: "screen" }} />
      {/* Bright-as-needed flash. Opacity animates from intensity → 0. */}
      <div id="ui-fx-flash" className="absolute inset-0" style={{ opacity: 0, mixBlendMode: "screen" }} />
      {/* Edge-lit halo — inset box-shadow so the halo reads as
          backlit UI rim, not a center light. */}
      <div id="ui-fx-glow" className="absolute inset-0" style={{ opacity: 0 }} />
      {/* Expanding concentric ring — triggered by `pulse`. */}
      <div id="ui-fx-pulse" className="absolute inset-0 flex items-center justify-center" />
      {/* Darken-edges vignette surge. */}
      <div id="ui-fx-vignette" className="absolute inset-0" style={{ opacity: 0 }} />
    </div>
  );
}
