"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// Synthesized audio — no external files. A low drone + hover/click blips.
// Starts muted; first click anywhere unlocks the AudioContext and begins the
// drone. A small UI toggle at the top of the chat panel flips it on/off.
export default function AmbientAudio() {
  const ctxRef = useRef<AudioContext | null>(null);
  const droneNodesRef = useRef<{ gain: GainNode; oscs: OscillatorNode[] } | null>(null);
  const [enabled, setEnabled] = useState(false);

  const ensureCtx = useCallback(() => {
    if (ctxRef.current) return ctxRef.current;
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const ctx = new AC();
    ctxRef.current = ctx;
    return ctx;
  }, []);

  const startDrone = useCallback(() => {
    const ctx = ensureCtx();
    if (droneNodesRef.current) return;
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);

    const filter = ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 420;
    filter.Q.value = 0.8;
    filter.connect(master);

    const makeOsc = (freq: number, type: OscillatorType, detune = 0) => {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = freq;
      o.detune.value = detune;
      const g = ctx.createGain();
      g.gain.value = 0.18;
      o.connect(g);
      g.connect(filter);
      o.start();
      return o;
    };

    const oscs = [
      makeOsc(55, "sine"),           // A1 sub
      makeOsc(82.4, "sine", -6),     // E2 slight detune
      makeOsc(110, "triangle", 4),   // A2
      makeOsc(164.8, "sine", 2),     // E3
      makeOsc(27.5, "sine"),         // deep rumble
    ];

    // LFO modulating the filter for an eldritch swell
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.07;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain);
    lfoGain.connect(filter.frequency);
    lfo.start();

    // Fade in
    master.gain.linearRampToValueAtTime(0.06, ctx.currentTime + 3.5);
    droneNodesRef.current = { gain: master, oscs };
  }, [ensureCtx]);

  const stopDrone = useCallback(() => {
    const nodes = droneNodesRef.current;
    if (!nodes || !ctxRef.current) return;
    const ctx = ctxRef.current;
    nodes.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
    setTimeout(() => {
      try { nodes.oscs.forEach((o) => o.stop()); } catch {}
      droneNodesRef.current = null;
    }, 700);
  }, []);

  const blip = useCallback((freq: number, dur = 0.06, vol = 0.04, type: OscillatorType = "square") => {
    const ctx = ensureCtx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    o.connect(g);
    g.connect(ctx.destination);
    const now = ctx.currentTime;
    g.gain.setValueAtTime(0, now);
    g.gain.linearRampToValueAtTime(vol, now + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, now + dur);
    o.start(now);
    o.stop(now + dur + 0.02);
  }, [ensureCtx]);

  // Wire hover + click events globally (delegated).
  useEffect(() => {
    if (!enabled) return;
    const onOver = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest(".btn, a, button")) blip(880, 0.04, 0.015, "triangle");
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (t.closest(".btn, a, button")) blip(420, 0.08, 0.04, "square");
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key.length === 1) blip(1240 + Math.random() * 80, 0.02, 0.01, "square");
    };
    window.addEventListener("mouseover", onOver, true);
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mouseover", onOver, true);
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [enabled, blip]);

  const toggle = async () => {
    const ctx = ensureCtx();
    if (ctx.state === "suspended") await ctx.resume();
    if (enabled) { stopDrone(); setEnabled(false); }
    else {
      // Boot chime
      blip(220, 0.15, 0.05, "sawtooth");
      setTimeout(() => blip(330, 0.12, 0.05, "sawtooth"), 110);
      setTimeout(() => blip(440, 0.2, 0.05, "sine"), 230);
      startDrone();
      setEnabled(true);
    }
  };

  return (
    <button
      onClick={toggle}
      className="btn"
      title={enabled ? "ambient audio: ON — click to mute" : "ambient audio: OFF — click to enable"}
    >
      {enabled ? "◉ audio" : "◌ audio"}
    </button>
  );
}
