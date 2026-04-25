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

  // LÖVE identity from the game's conf.lua — this is the subdir name
  // inside `/home/web_user/love/` where love.js stores its save files.
  // We need it portal-side so `__loveweb__/achievements.json` lands
  // where the game's love.filesystem can actually read it (i.e. inside
  // <save-root>/<identity>/, not as a sibling of it). Default is the
  // slug with dashes converted to underscores (what most games pick
  // anyway).
  identity?: string;

  accentColor: string;               // hex accent used throughout the portal
  multiplayer: "single" | "coop" | "mmo";
  status: "live" | "beta" | "soon";
};

// Resolve the effective LÖVE identity for a game — explicit entry
// first, else derive from the slug (s/-/_/g).
export function gameIdentity(g: Pick<GameEntry, "slug" | "identity">): string {
  return g.identity ?? g.slug.replace(/-/g, "_");
}

// Runtime path is derived — build output always lands at the same shape.
export function runtimePath(slug: string): string {
  return `/games/${slug}/runtime`;
}
export function lovePath(slug: string): string {
  return `/games/${slug}/game.love`;
}

// Newest games first. Library grid renders in array order, so prepend
// new entries here to keep "latest at the top-left."
export const GAMES: GameEntry[] = [
  {
    slug: "zmine",
    title: "ZMINE — Zepton Mining",
    codename: "ZMINE",
    tagline: "Glowing-green proof-of-work tycoon — mine zeptons, balance the grid.",
    description:
      "A real-physics proof-of-work tycoon. Deploy ASIC hashboards, GPU clusters, cryogenic quantum rigs, and exotic neural forges to mine zeptons — but every miner consumes power. Build the grid that feeds them: solar, wind, hydro, geothermal, fission, fusion, antimatter, zero-point. Climb the tech tree, ride the halvings, and light up the void.",
    author: "MBrassey",
    version: "head",
    category: "puzzle",
    tags: ["tycoon", "idle", "proof-of-work", "energy", "neon"],
    year: 2026,
    repo: "MBrassey/zmine",
    ref: "main",
    identity: "zmine",                // matches the game's conf.lua t.identity
    accentColor: "#3eff8b",
    multiplayer: "single",
    status: "live",
  },
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
    identity: "claude_mythos",        // matches the game's conf.lua t.identity
    accentColor: "#8a4fff",
    multiplayer: "single",
    status: "live",
  },
];

export function getGame(slug: string): GameEntry | undefined {
  return GAMES.find((g) => g.slug === slug);
}
