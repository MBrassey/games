"use client";

import type { StatsPayload } from "@/app/api/stats/route";

// Terminal-styled SVG charts. No chart library — everything is inline SVG
// so the aesthetic matches the rest of the portal (dither grid, eldritch
// glow, mono labels).

const PURPLE = "#8a4fff";
const CYAN = "#66e0ff";
const GREEN = "#33ff66";
const AMBER = "#ffb347";
const BONE = "#d8d0e6";

export function ActivityChart({
  data,
}: {
  data: StatsPayload["activity30d"];
}) {
  // Wider viewBox to breathe on 30-day data sets.
  const W = 960;
  const H = 200;
  const PAD_L = 44;
  const PAD_R = 20;
  const PAD_T = 16;
  const PAD_B = 28;
  const innerW = W - PAD_L - PAD_R;
  const innerH = H - PAD_T - PAD_B;
  const barW = innerW / Math.max(1, data.length);

  const maxPt = Math.max(1, ...data.map((d) => d.playtimeSeconds));
  const maxMsg = Math.max(1, ...data.map((d) => d.messages));

  const ptY = (s: number) => PAD_T + innerH - (s / maxPt) * innerH;
  const msgY = (n: number) => PAD_T + innerH - (n / maxMsg) * innerH;

  const msgPath =
    data.length > 0
      ? data
          .map((d, i) => {
            const x = PAD_L + i * barW + barW / 2;
            return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${msgY(d.messages).toFixed(1)}`;
          })
          .join(" ")
      : "";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-[220px]" aria-label="14 day activity">
      <defs>
        <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={PURPLE} stopOpacity="0.95" />
          <stop offset="100%" stopColor={PURPLE} stopOpacity="0.25" />
        </linearGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="2" />
          <feMerge>
            <feMergeNode />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>

      {/* dither grid */}
      {Array.from({ length: 4 }).map((_, i) => {
        const y = PAD_T + (innerH * i) / 3;
        return (
          <g key={i}>
            <line
              x1={PAD_L}
              y1={y}
              x2={W - PAD_R}
              y2={y}
              stroke="#2a1a55"
              strokeDasharray="3 5"
              strokeWidth="1"
            />
            <text
              x={PAD_L - 6}
              y={y + 3}
              textAnchor="end"
              fill={BONE}
              fillOpacity="0.4"
              fontFamily="ui-monospace, JetBrains Mono"
              fontSize="9"
            >
              {formatMinutes(((maxPt * (3 - i)) / 3) / 60)}
            </text>
          </g>
        );
      })}

      {/* playtime bars */}
      {data.map((d, i) => {
        const x = PAD_L + i * barW + barW * 0.12;
        const w = barW * 0.76;
        const y = ptY(d.playtimeSeconds);
        const h = PAD_T + innerH - y;
        return (
          <g key={d.day}>
            <rect
              x={x}
              y={y}
              width={w}
              height={h}
              fill="url(#barGrad)"
              stroke={PURPLE}
              strokeOpacity="0.6"
            />
          </g>
        );
      })}

      {/* messages line */}
      {data.length > 1 && (
        <path
          d={msgPath}
          fill="none"
          stroke={CYAN}
          strokeWidth="1.5"
          filter="url(#glow)"
        />
      )}
      {data.map((d, i) => {
        const x = PAD_L + i * barW + barW / 2;
        return (
          <circle
            key={`msg-${i}`}
            cx={x}
            cy={msgY(d.messages)}
            r="2"
            fill={CYAN}
            filter="url(#glow)"
          />
        );
      })}

      {/* x axis ticks — roughly every 5 days */}
      {data.map((d, i) => {
        if (i % 5 !== 0 && i !== data.length - 1) return null;
        const x = PAD_L + i * barW + barW / 2;
        const label = d.day.slice(5); // MM-DD
        return (
          <text
            key={`x-${i}`}
            x={x}
            y={H - 10}
            textAnchor="middle"
            fill={BONE}
            fillOpacity="0.45"
            fontFamily="ui-monospace, JetBrains Mono"
            fontSize="9"
          >
            {label}
          </text>
        );
      })}

      {/* legend */}
      <g transform={`translate(${PAD_L}, ${PAD_T - 4})`}>
        <rect width="10" height="10" y="-8" fill="url(#barGrad)" stroke={PURPLE} strokeOpacity="0.6" />
        <text x="16" y="1" fill={BONE} fillOpacity="0.65" fontFamily="ui-monospace" fontSize="10">
          playtime
        </text>
        <g transform="translate(110, 0)">
          <line x1="0" y1="-3" x2="14" y2="-3" stroke={CYAN} strokeWidth="1.5" filter="url(#glow)" />
          <text x="20" y="1" fill={BONE} fillOpacity="0.65" fontFamily="ui-monospace" fontSize="10">
            messages
          </text>
        </g>
      </g>
    </svg>
  );
}

export function PerGameChart({ data }: { data: StatsPayload["perGame"] }) {
  if (data.length === 0) {
    return <p className="text-bone/40 text-xs">no games played yet.</p>;
  }
  const W = 640;
  const rowH = 32;
  const PAD_L = 160;
  const PAD_R = 80;
  const H = data.length * rowH + 16;
  const innerW = W - PAD_L - PAD_R;
  const max = Math.max(1, ...data.map((d) => d.playtimeSeconds));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" aria-label="per-game playtime">
      <defs>
        <linearGradient id="gameGrad" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor={PURPLE} stopOpacity="0.85" />
          <stop offset="100%" stopColor={CYAN} stopOpacity="0.85" />
        </linearGradient>
      </defs>
      {data.map((d, i) => {
        const y = 8 + i * rowH;
        const w = (d.playtimeSeconds / max) * innerW;
        return (
          <g key={d.slug}>
            <text
              x={PAD_L - 10}
              y={y + 14}
              textAnchor="end"
              fill={BONE}
              fillOpacity="0.85"
              fontFamily="ui-monospace"
              fontSize="11"
            >
              {d.slug}
            </text>
            <rect
              x={PAD_L}
              y={y + 4}
              width={innerW}
              height={rowH - 12}
              fill="#0c0820"
              stroke="#2a1a55"
              strokeDasharray="3 3"
            />
            <rect
              x={PAD_L}
              y={y + 4}
              width={Math.max(2, w)}
              height={rowH - 12}
              fill="url(#gameGrad)"
            />
            <text
              x={PAD_L + w + 8}
              y={y + 14}
              fill={CYAN}
              fontFamily="ui-monospace"
              fontSize="10"
            >
              {formatDuration(d.playtimeSeconds)}
            </text>
            <text
              x={W - 4}
              y={y + 28}
              textAnchor="end"
              fill={BONE}
              fillOpacity="0.4"
              fontFamily="ui-monospace"
              fontSize="9"
            >
              {d.sessions} sess · {d.saves} saves
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function formatMinutes(mins: number): string {
  if (mins < 1) return "0m";
  if (mins < 60) return `${mins.toFixed(0)}m`;
  return `${(mins / 60).toFixed(1)}h`;
}
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const mins = seconds / 60;
  if (mins < 60) return `${mins.toFixed(1)}m`;
  return `${(mins / 60).toFixed(1)}h`;
}
