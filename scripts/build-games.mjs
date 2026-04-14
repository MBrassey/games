#!/usr/bin/env node
// Build every game registered in src/lib/games.ts from its GitHub source.
//
// Steps per game:
//   1. Shallow-clone the repo at the configured ref into .cache/game-src/<slug>.
//      Re-used across builds; fetched fresh each invocation so latest HEAD
//      of the ref is always what ships.
//   2. Run scripts/web-compat-patch.mjs over the source into
//      .cache/game-patched/<slug> (LuaJIT → Lua 5.1 compat for love.js).
//   3. Pack the patched tree into a .love archive via make-love.mjs.
//   4. Invoke love.js (npm bundled, no emscripten install required) to
//      compile the .love into public/games/<slug>/runtime/.
//   5. Overwrite the default index.html with our bridge-enabled template
//      from templates/love-runtime-index.html (postMessage save sync + FS
//      prepopulate + canvas visibility fixes).
//
// Runs as prebuild (see package.json), so every Vercel deploy ships the
// latest commit of every registered game.
//
// Usage:
//   node scripts/build-games.mjs           # build all
//   node scripts/build-games.mjs <slug>    # build one

import { mkdirSync, readdirSync, cpSync, rmSync, existsSync, copyFileSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const CACHE_SRC = join(ROOT, ".cache", "game-src");
const CACHE_PATCH = join(ROOT, ".cache", "game-patched");
const CACHE_LOVE = join(ROOT, ".cache", "game-love");
const PUBLIC_GAMES = join(ROOT, "public", "games");
const TEMPLATE_HTML = join(ROOT, "templates", "love-runtime-index.html");
const PATCH_SCRIPT = join(ROOT, "scripts", "web-compat-patch.mjs");
const MAKELOVE_SCRIPT = join(ROOT, "scripts", "make-love.mjs");

const only = process.argv[2] ?? null;

// Lightweight loader for src/lib/games.ts so we don't need tsx here.
// We only read the GAMES array, which is a plain object literal.
async function loadGames() {
  const file = join(ROOT, "src", "lib", "games.ts");
  const raw = await (await import("node:fs/promises")).readFile(file, "utf8");
  // Strip TS bits that would confuse Function(): types, declarations.
  // We extract just the GAMES = [...]; assignment and eval it as JS.
  const m = raw.match(/export\s+const\s+GAMES\s*(?::[^=]+)?=\s*(\[[\s\S]*?\n\]);/);
  if (!m) throw new Error("Could not locate GAMES array in src/lib/games.ts");
  // Remove trailing TS type assertions on tagged-template repo strings.
  const body = m[1].replace(/`\$\{string\}\/\$\{string\}`/g, "string");
  // eslint-disable-next-line no-new-func
  const fn = new Function(`return (${body});`);
  return fn();
}

function run(cmd, args, opts = {}) {
  console.log(`  $ ${cmd} ${args.join(" ")}`);
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} exited with ${r.status}`);
  }
}

function cloneOrUpdate(repo, ref, dest) {
  const url = `https://github.com/${repo}.git`;
  if (existsSync(join(dest, ".git"))) {
    // Refresh existing clone to the tip of the ref. If that fails (repo
    // rewritten, ref renamed), nuke and re-clone.
    try {
      run("git", ["-C", dest, "fetch", "--depth", "1", "origin", ref]);
      run("git", ["-C", dest, "reset", "--hard", "FETCH_HEAD"]);
      run("git", ["-C", dest, "clean", "-fdx"]);
      return;
    } catch {
      rmSync(dest, { recursive: true, force: true });
    }
  }
  mkdirSync(dirname(dest), { recursive: true });
  run("git", ["clone", "--depth", "1", "--branch", ref, url, dest]);
}

function currentHeadSha(dest) {
  try {
    return execFileSync("git", ["-C", dest, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch { return ""; }
}

async function buildGame(game) {
  const { slug, repo, ref = "main", subdir = ".", title } = game;
  console.log(`\n=== ${slug}  (${repo}@${ref}) ===`);

  const srcDir = join(CACHE_SRC, slug);
  cloneOrUpdate(repo, ref, srcDir);
  const sha = currentHeadSha(srcDir);
  if (sha) console.log(`  HEAD = ${sha.slice(0, 10)}`);

  const loveSrc = subdir === "." ? srcDir : join(srcDir, subdir);
  if (!existsSync(join(loveSrc, "main.lua"))) {
    throw new Error(`no main.lua at ${loveSrc} — check 'subdir' for ${slug}`);
  }

  // Patch
  const patchDir = join(CACHE_PATCH, slug);
  rmSync(patchDir, { recursive: true, force: true });
  mkdirSync(patchDir, { recursive: true });
  run("node", [PATCH_SCRIPT, loveSrc, patchDir]);

  // Pack .love
  mkdirSync(CACHE_LOVE, { recursive: true });
  const loveFile = join(CACHE_LOVE, `${slug}.love`);
  try { rmSync(loveFile); } catch {}
  run("node", [MAKELOVE_SCRIPT, patchDir, loveFile]);

  // Compile with love.js
  const loveJsOut = join(CACHE_LOVE, `${slug}-out`);
  rmSync(loveJsOut, { recursive: true, force: true });
  run("npx", ["--yes", "love.js@11", "-c", "-t", title, loveFile, loveJsOut]);

  // Copy into public/games/<slug>/runtime/
  const runtimeDir = join(PUBLIC_GAMES, slug, "runtime");
  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true });
  for (const f of readdirSync(loveJsOut)) {
    const src = join(loveJsOut, f);
    const dst = join(runtimeDir, f);
    const st = statSync(src);
    if (st.isDirectory()) cpSync(src, dst, { recursive: true });
    else copyFileSync(src, dst);
  }
  // Overwrite index.html with the bridge-enabled template
  copyFileSync(TEMPLATE_HTML, join(runtimeDir, "index.html"));

  // Post-patch love.js to expose the emscripten FS object on Module.
  // love.js's default build only exports a handful of FS_* helpers
  // (FS_createDataFile, FS_createPath, ...) and keeps the full FS
  // closure-private. We need FS.readdir / FS.stat / FS.readFile in the
  // bridge to pre-populate saves and sync changes back to the server.
  // This adds `Module["FS"]=FS` right next to where emscripten exports
  // the other helpers — one-line patch, safe across love.js versions
  // since it only adds an extra assignment.
  const loveJsPath = join(runtimeDir, "love.js");
  let js = readFileSync(loveJsPath, "utf8");
  if (!js.includes('Module["FS"]=FS')) {
    const before = js.length;
    js = js.replace(
      /(Module\["FS_createDataFile"\]\s*=\s*FS\.createDataFile\s*;?)/,
      '$1Module["FS"]=FS;'
    );
    if (js.length === before) {
      console.warn(`  warn: could not inject Module["FS"]=FS into love.js — save bridge will not work`);
    } else {
      writeFileSync(loveJsPath, js);
      console.log(`  ok  patched love.js to export Module.FS`);
    }
  }

  console.log(`  ok  ${runtimeDir}`);
}

async function main() {
  const games = await loadGames();
  const targets = only ? games.filter((g) => g.slug === only) : games;
  if (only && targets.length === 0) {
    throw new Error(`no game with slug "${only}"`);
  }
  mkdirSync(PUBLIC_GAMES, { recursive: true });
  for (const g of targets) {
    await buildGame(g);
  }
  console.log(`\n» built ${targets.length} game(s).`);
}

main().catch((e) => {
  console.error(`\nerror: ${e.message}`);
  process.exit(1);
});
