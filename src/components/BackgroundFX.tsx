"use client";

import { useEffect, useRef } from "react";

// Slow-drifting eldritch particles behind everything. All canvas-based so
// it doesn't slow down text rendering or React. Pauses when tab is hidden.
export default function BackgroundFX() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d", { alpha: true });
    if (!ctx) return;

    let dpr = Math.max(1, window.devicePixelRatio || 1);
    let w = 0, h = 0;
    const resize = () => {
      dpr = Math.max(1, window.devicePixelRatio || 1);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    // Particle pool. Three layers for depth. Counts tuned for 1080p desktop;
    // we downscale by viewport area to stay light on mobile.
    type P = {
      x: number; y: number; z: number;
      vx: number; vy: number;
      r: number; hue: number; alpha: number;
      twink: number;
    };
    const area = w * h;
    const density = Math.min(1, area / (1920 * 1080));
    const count = Math.floor(160 * density);

    // Palette hues pulled from the ClaudeMythos eldritch palette.
    const HUES = [
      [138, 80, 255],  // eldritch purple
      [102, 224, 255], // abyss cyan
      [51, 255, 102],  // matrix green
      [255, 179, 71],  // amber
    ];

    const rand = (a: number, b: number) => a + Math.random() * (b - a);
    const ps: P[] = [];
    for (let i = 0; i < count; i++) {
      const z = rand(0.3, 1.0);
      const c = HUES[Math.floor(Math.random() * HUES.length)];
      ps.push({
        x: Math.random() * w,
        y: Math.random() * h,
        z,
        vx: rand(-0.06, 0.06) * z,
        vy: rand(-0.03, -0.01) - 0.02 * z, // slow upward drift
        r: rand(0.4, 1.8) * z,
        hue: (c[0] << 16) | (c[1] << 8) | c[2], // packed RGB
        alpha: rand(0.15, 0.55) * z,
        twink: rand(0, Math.PI * 2),
      });
    }

    // Occasional "streaks" — faint diagonal falling lines, like data motes.
    type Streak = { x: number; y: number; len: number; speed: number; life: number; max: number; hue: number };
    const streaks: Streak[] = [];
    const spawnStreak = () => {
      const c = HUES[Math.floor(Math.random() * HUES.length)];
      streaks.push({
        x: Math.random() * w,
        y: -20,
        len: rand(40, 120),
        speed: rand(40, 90),
        life: 0,
        max: rand(2.5, 5),
        hue: (c[0] << 16) | (c[1] << 8) | c[2],
      });
    };

    let last = performance.now();
    let running = true;
    let streakTimer = 0;

    const frame = (now: number) => {
      if (!running) return;
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;

      ctx.clearRect(0, 0, w, h);

      // Streaks
      streakTimer -= dt;
      if (streakTimer <= 0) {
        if (Math.random() < 0.6) spawnStreak();
        streakTimer = rand(0.8, 2.4);
      }
      for (let i = streaks.length - 1; i >= 0; i--) {
        const s = streaks[i];
        s.life += dt;
        s.y += s.speed * dt;
        s.x += s.speed * 0.3 * dt;
        const fade = Math.max(0, 1 - s.life / s.max);
        if (fade <= 0) { streaks.splice(i, 1); continue; }
        const r = (s.hue >> 16) & 0xff;
        const g = (s.hue >> 8) & 0xff;
        const b = s.hue & 0xff;
        const grad = ctx.createLinearGradient(s.x, s.y, s.x + s.len * 0.3, s.y + s.len);
        grad.addColorStop(0, `rgba(${r},${g},${b},0)`);
        grad.addColorStop(0.5, `rgba(${r},${g},${b},${0.28 * fade})`);
        grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
        ctx.strokeStyle = grad;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(s.x + s.len * 0.3, s.y + s.len);
        ctx.stroke();
      }

      // Particles
      for (const p of ps) {
        p.x += p.vx;
        p.y += p.vy;
        p.twink += dt * 1.8;
        if (p.y < -10) { p.y = h + 10; p.x = Math.random() * w; }
        if (p.x < -10) p.x = w + 10;
        if (p.x > w + 10) p.x = -10;

        const a = Math.max(0, p.alpha * (0.6 + 0.4 * Math.sin(p.twink)));
        const r = (p.hue >> 16) & 0xff;
        const g = (p.hue >> 8) & 0xff;
        const b = p.hue & 0xff;
        ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
        ctx.fill();
        // Soft halo on brighter ones
        if (p.r > 1.2) {
          ctx.fillStyle = `rgba(${r},${g},${b},${a * 0.18})`;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.r * 3, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);

    const onVis = () => {
      if (document.hidden) running = false;
      else { running = true; last = performance.now(); requestAnimationFrame(frame); }
    };
    document.addEventListener("visibilitychange", onVis);

    return () => {
      running = false;
      window.removeEventListener("resize", resize);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 z-0 opacity-80"
      style={{ mixBlendMode: "screen" }}
    />
  );
}
