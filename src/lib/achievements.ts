import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

// Catalog definition as authored in a game's achievements.json.
// Keep this schema identical to the one documented in docs/ACHIEVEMENTS.md —
// game authors code against it, so churn here breaks their integration.
export const AchievementDefSchema = z.object({
  key: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
  title: z.string().min(1).max(120),
  description: z.string().max(500).optional().default(""),
  glyph: z.string().max(8).optional(),        // single emoji/char shown in UI
  icon: z.string().max(256).optional(),       // relative URL under /games/<slug>/
  points: z.number().int().min(0).max(1000).optional().default(10),
  hidden: z.boolean().optional().default(false),
  rarity: z.enum(["common", "uncommon", "rare", "legendary"]).optional().default("common"),
  category: z.string().max(40).optional(),
});
export type AchievementDef = z.infer<typeof AchievementDefSchema>;

export const AchievementsFileSchema = z.object({
  version: z.literal(1),
  achievements: z.array(AchievementDefSchema).max(500),
});
export type AchievementsFile = z.infer<typeof AchievementsFileSchema>;

// In-process cache keyed by file mtime so rebuilds/redeploys pick up changes
// automatically but steady-state requests pay only a stat() cost. On Vercel
// each lambda instance holds its own copy, which is fine for a file this
// small.
type CacheEntry = { mtimeMs: number; data: AchievementsFile | null };
const CATALOG_CACHE = new Map<string, CacheEntry>();

function publicPath(slug: string): string {
  return join(process.cwd(), "public", "games", slug, "achievements.json");
}

// Returns null when the game has not declared any achievements — that's a
// valid state, not an error. Invalid JSON or schema violations are logged
// once (on cache miss) and then treated as "no achievements" so a broken
// upstream file can't take the portal down.
export async function loadCatalog(slug: string): Promise<AchievementsFile | null> {
  const path = publicPath(slug);
  let mtimeMs: number;
  try {
    const st = await stat(path);
    mtimeMs = st.mtimeMs;
  } catch {
    CATALOG_CACHE.set(slug, { mtimeMs: 0, data: null });
    return null;
  }
  const cached = CATALOG_CACHE.get(slug);
  if (cached && cached.mtimeMs === mtimeMs) return cached.data;

  try {
    const raw = await readFile(path, "utf8");
    const parsed = AchievementsFileSchema.parse(JSON.parse(raw));
    // Enforce unique keys — two defs with the same key would break the
    // unlock path's catalog lookup silently.
    const seen = new Set<string>();
    for (const a of parsed.achievements) {
      if (seen.has(a.key)) {
        throw new Error(`duplicate achievement key: ${a.key}`);
      }
      seen.add(a.key);
    }
    CATALOG_CACHE.set(slug, { mtimeMs, data: parsed });
    return parsed;
  } catch (e) {
    console.error(`[achievements] failed to load catalog for ${slug}:`, e);
    CATALOG_CACHE.set(slug, { mtimeMs, data: null });
    return null;
  }
}

export async function findDef(
  slug: string,
  key: string
): Promise<AchievementDef | null> {
  const cat = await loadCatalog(slug);
  if (!cat) return null;
  return cat.achievements.find((a) => a.key === key) ?? null;
}

// Represents an unlocked achievement joined with its catalog definition.
// UI code always wants both — return them together so callers never have
// to stitch them after the fact.
export type UnlockedEntry = {
  key: string;
  unlockedAt: string;
  points: number;
  def: AchievementDef | null;   // null if the catalog dropped this key
};
