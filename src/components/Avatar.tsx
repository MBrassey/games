// Rounded-square avatar with a per-user glowing border. The border color
// is derived deterministically from the handle so the same user lights up
// the same color everywhere — chat line, stats hero, anywhere else.
//
// No <Image/> — avatar URLs come from GitHub (githubusercontent.com) and
// adding them to `next.config.mjs` images.remotePatterns is unnecessary
// for a handful of static sources. Plain <img> is fine here.

const USER_COLORS = [
  "#66e0ff", // cyan
  "#8a4fff", // eldritch purple
  "#33ff66", // matrix green
  "#ffb347", // amber
  "#ff6bd6", // hot magenta
  "#ffe066", // yellow
  "#ff8c5a", // orange
  "#a0ff9a", // lime
  "#5ad1ff", // sky
  "#ff5c8a", // pink
  "#b28dff", // lavender
  "#6cffd0", // teal
];

export function colorForHandle(h: string): string {
  let x = 2166136261 >>> 0;
  for (let i = 0; i < h.length; i++) {
    x ^= h.charCodeAt(i);
    x = Math.imul(x, 16777619) >>> 0;
  }
  return USER_COLORS[x % USER_COLORS.length];
}

export default function Avatar({
  src,
  handle,
  size = 28,
  radius,
  className = "",
}: {
  src?: string | null;
  handle: string;
  size?: number;
  radius?: number;
  className?: string;
}) {
  const color = colorForHandle(handle || "anon");
  const r = radius ?? Math.round(size * 0.22);
  const initial = (handle || "?").slice(0, 1).toUpperCase();
  return (
    <span
      className={`relative inline-block shrink-0 ${className}`}
      style={{
        width: size,
        height: size,
        borderRadius: r,
        padding: 1.5,
        background: `linear-gradient(135deg, ${color}, ${color}55)`,
        boxShadow: `0 0 10px ${color}99, inset 0 0 6px ${color}66`,
      }}
      aria-label={handle}
      title={handle}
    >
      <span
        className="block w-full h-full overflow-hidden bg-void-1"
        style={{ borderRadius: Math.max(1, r - 1.5) }}
      >
        {src ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={src}
            alt={handle}
            width={size}
            height={size}
            className="h-full w-full object-cover"
            loading="lazy"
            referrerPolicy="no-referrer"
          />
        ) : (
          <span
            className="flex h-full w-full items-center justify-center font-mono font-semibold"
            style={{
              color,
              fontSize: Math.round(size * 0.5),
              textShadow: `0 0 8px ${color}aa`,
            }}
          >
            {initial}
          </span>
        )}
      </span>
    </span>
  );
}
