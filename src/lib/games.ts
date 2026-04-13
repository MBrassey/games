export type GameEntry = {
  slug: string;
  title: string;
  codename: string;
  tagline: string;
  description: string;
  author: string;
  version: string;
  category: "action" | "puzzle" | "rpg" | "arcade" | "meta";
  tags: string[];
  year: number;

  // Source is pulled fresh from GitHub at build time by
  // scripts/build-games.mjs. Whatever's on the given ref when Vercel
  // builds is what ships.
  repo: `${string}/${string}`;      // e.g. "ThePearlKing/claude-mythos-game"
  ref?: string;                      // branch / tag, default "main"
  subdir?: string;                   // path to main.lua within the repo, default "."

  accentColor: string;               // hex accent used throughout the portal
  multiplayer: "single" | "coop" | "mmo";
  status: "live" | "beta" | "soon";
};

// Runtime path is derived — build output always lands at the same shape.
export function runtimePath(slug: string): string {
  return `/games/${slug}/runtime`;
}
export function lovePath(slug: string): string {
  return `/games/${slug}/game.love`;
}

export const GAMES: GameEntry[] = [
  {
    slug: "claude-mythos",
    title: "Claude: Mythos",
    codename: "CLAUDE.MYTHOS",
    tagline: "An eldritch bullet survivor descent into the void sea.",
    description:
      "A wave-based arcade survivor threaded with eldritch horror. Navigate the void sea, build decks of cosmic powers, and hold the line against the rising tide of the deep.",
    author: "ThePearlKing",
    version: "head",
    category: "action",
    tags: ["bullet-hell", "roguelite", "eldritch", "cards"],
    year: 2026,
    repo: "ThePearlKing/claude-mythos-game",
    ref: "main",
    accentColor: "#8a4fff",
    multiplayer: "single",
    status: "live",
  },
];

export function getGame(slug: string): GameEntry | undefined {
  return GAMES.find((g) => g.slug === slug);
}
