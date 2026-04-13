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
  // Paths relative to /public
  runtimePath: string; // e.g. /games/claude-mythos/runtime
  lovePath: string;    // e.g. /games/claude-mythos/game.love
  accentColor: string; // tailwind-ish hex for accent
  multiplayer: "single" | "coop" | "mmo";
  status: "live" | "beta" | "soon";
};

export const GAMES: GameEntry[] = [
  {
    slug: "claude-mythos",
    title: "Claude: Mythos",
    codename: "CLAUDE.MYTHOS",
    tagline: "An eldritch bullet survivor descent into the void sea.",
    description:
      "A wave-based arcade survivor threaded with eldritch horror. Navigate the void sea, build decks of cosmic powers, and hold the line against the rising tide of the deep.",
    author: "matt",
    version: "0.9.0",
    category: "action",
    tags: ["bullet-hell", "roguelite", "eldritch", "cards"],
    year: 2026,
    runtimePath: "/games/claude-mythos/runtime",
    lovePath: "/games/claude-mythos/game.love",
    accentColor: "#8a4fff",
    multiplayer: "single",
    status: "live",
  },
];

export function getGame(slug: string): GameEntry | undefined {
  return GAMES.find((g) => g.slug === slug);
}
