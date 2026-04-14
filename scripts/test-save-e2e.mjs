#!/usr/bin/env node
// End-to-end save prepopulation test.
//
// Spins up an HTTP server that mimics the real portal's save bridge:
//   - serves runtime files from public/games/<slug>/runtime/
//   - answers GET /saved-files with a manifest of one file
//   - answers GET /file-data?path=X with the base64-encoded contents
//
// The test page wraps the runtime iframe and forwards postMessages,
// matching what GameRunner.tsx does in production. After the runtime
// reports loveweb:ready, we poke into the iframe's FS and confirm the
// file is where LÖVE looks for it, then wait a bit and check whether
// ClaudeMythos' save.lua migrated it into slot 1.

import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join, extname, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const [slugArg, saveFileArg] = process.argv.slice(2);
const SLUG = slugArg || "claude-mythos";
const SAVE_FILE = saveFileArg || `${process.env.HOME}/Downloads/claude_mythos_save.txt`;

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const RUNTIME_DIR = join(ROOT, "public", "games", SLUG, "runtime");
const saveBytes = readFileSync(SAVE_FILE);
const saveB64 = saveBytes.toString("base64");
const activeB64 = Buffer.from("1", "utf8").toString("base64");

// Simulate the real reseeded DB state: three files, all server-side.
// Nothing on the client — IDBFS / IndexedDB / localStorage are not used.
const SEEDED = new Map([
  ["claude_mythos/claude_mythos_save_1.txt", saveB64],
  ["claude_mythos/claude_mythos_save.txt",   saveB64],
  ["claude_mythos/claude_mythos_active.txt", activeB64],
]);

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".css": "text/css",
  ".png": "image/png",
};

// Host HTML that embeds the runtime and brokers save messages exactly
// the way GameRunner.tsx does.
const HOST_HTML = `<!doctype html><html><body style="margin:0;background:#000">
<iframe id="f" src="/runtime/index.html?slug=${SLUG}" style="width:100vw;height:100vh;border:0" sandbox="allow-scripts allow-same-origin allow-pointer-lock"></iframe>
<script>
  const iframe = document.getElementById("f");
  const SEEDED = ${JSON.stringify(Object.fromEntries(SEEDED))};
  const MANIFEST = Object.keys(SEEDED).map(p => ({ path: p, updated_at: new Date().toISOString() }));
  window._bridgeEvents = [];
  window.addEventListener("message", (e) => {
    if (e.source !== iframe.contentWindow) return;
    const d = e.data; if (!d || !d.type) return;
    window._bridgeEvents.push(d);
    const reply = (m) => iframe.contentWindow.postMessage(m, "*");
    if (d.type === "loveweb:hello") {
      reply({ type: "loveweb:saves:manifest", files: MANIFEST });
      reply({ type: "loveweb:auth", signedIn: true });
    } else if (d.type === "loveweb:save:read") {
      reply({ type: "loveweb:save:data", reqId: d.reqId, dataB64: SEEDED[d.path] ?? null });
    } else if (d.type === "loveweb:save:write") {
      // Capture what the runtime flushes back — this is what would hit
      // the real /api/saves endpoint in prod.
      window._serverWrites = window._serverWrites || [];
      window._serverWrites.push({ path: d.path, size: d.dataB64.length });
    }
  });
</script>
</body></html>`;

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HOST_HTML);
    return;
  }
  const rel = url.pathname.replace(/^\/runtime\//, "");
  const p = join(RUNTIME_DIR, rel);
  try {
    const st = statSync(p);
    if (st.isDirectory()) throw new Error("dir");
    res.writeHead(200, {
      "Content-Type": MIME[extname(p)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(readFileSync(p));
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
const port = await new Promise((r) => server.listen(0, () => r(server.address().port)));
console.log(`» host on http://127.0.0.1:${port}`);

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`PAGEERROR: ${e.message}`));

await page.goto(`http://127.0.0.1:${port}/`);

// Wait up to 20s for the game to boot (loveweb:ready), then let save.lua do its thing.
await page.waitForFunction(
  () => (window._bridgeEvents || []).some((e) => e.type === "loveweb:ready"),
  { timeout: 25000 }
).catch(() => {});
await page.waitForTimeout(6000); // let Game:load run + migration

// Reach into the iframe's FS to check what's actually on disk.
const fsDump = await page.evaluate(() => {
  const w = document.getElementById("f").contentWindow;
  const FS = w.FS || (w.Module && w.Module.FS);
  const Module = w.Module;
  const out = {
    events: window._bridgeEvents,
    files: {},
    fsPresent: typeof FS !== "undefined" && FS !== null,
    moduleStatus: Module ? { deps: Module.remainingDependencies } : null,
    moduleKeys: Module ? Object.keys(Module).filter(k => /^(FS|_|load|get|create)/i.test(k)).slice(0, 40) : [],
    windowKeysMatching: Object.keys(w).filter(k => /FS|fs|file/i.test(k)).slice(0, 30),
    topDirs: [],
    errors: [],
  };
  if (!FS) { out.errors.push("no FS on iframe window"); return out; }
  function readdirSafe(dir) {
    try { return FS.readdir(dir); } catch (e) { out.errors.push(`readdir ${dir}: ${e.message}`); return null; }
  }
  const rootEntries = readdirSafe("/");
  if (rootEntries) out.topDirs = rootEntries;
  function walk(dir) {
    const entries = readdirSafe(dir);
    if (!entries) return;
    for (const e of entries) {
      if (e === "." || e === "..") continue;
      const p = dir === "/" ? "/" + e : dir + "/" + e;
      let st;
      try { st = FS.stat(p); } catch { continue; }
      if (FS.isDir(st.mode)) walk(p);
      else {
        try {
          const data = FS.readFile(p, { encoding: "utf8" });
          out.files[p] = data.slice(0, 300);
        } catch { out.files[p] = "<binary or unreadable>"; }
      }
    }
  }
  walk("/");
  return out;
});

console.log("\n=== FS accessibility ===");
console.log("  FS present:", fsDump.fsPresent);
console.log("  Module status:", JSON.stringify(fsDump.moduleStatus));
console.log("  Module keys (FS/load/create):", JSON.stringify(fsDump.moduleKeys));
console.log("  window keys (fs):", JSON.stringify(fsDump.windowKeysMatching));
console.log("  top-level / dirs:", JSON.stringify(fsDump.topDirs));
if (fsDump.errors.length) {
  console.log("  errors:");
  for (const e of fsDump.errors.slice(0, 20)) console.log("    -", e);
}

console.log("\n=== bridge events observed ===");
for (const e of fsDump.events) console.log(" ", e.type, e.path || e.game || "");

console.log("\n=== FS files (whole tree) ===");
const paths = Object.keys(fsDump.files);
if (paths.length === 0) {
  console.log("  (no files found anywhere)");
} else {
  for (const p of paths) {
    console.log(`» ${p}`);
    console.log(fsDump.files[p].split("\n").slice(0, 3).map((l) => "    " + l).join("\n"));
  }
}

console.log("\n=== runtime logs ===");
for (const e of fsDump.events.filter((e) => e.type === "loveweb:log")) {
  console.log(" ", e.level || "?", "::", e.msg || "<empty>");
}

const serverWrites = await page.evaluate(() => window._serverWrites || []);

await browser.close();
server.close();

// Verdict: did the seeded files land, and is slot-1 readable?
const expectedLegacy = `/home/web_user/.local/share/love/claude_mythos/claude_mythos_save.txt`;
const expectedSlot1  = `/home/web_user/.local/share/love/claude_mythos/claude_mythos_save_1.txt`;
const hasLegacy = paths.includes(expectedLegacy);
const hasSlot1 = paths.includes(expectedSlot1);
const slot1ContainsKills = hasSlot1 && fsDump.files[expectedSlot1].includes("totalKills");

console.log("\n=== runtime → server writes observed ===");
for (const w of serverWrites) console.log(" ", w.path, `(${w.size}b b64)`);

console.log("\n=== verdict ===");
console.log(`  legacy seed present: ${hasLegacy}`);
console.log(`  slot-1 present     : ${hasSlot1}`);
console.log(`  slot-1 has content : ${slot1ContainsKills}`);
process.exit(hasSlot1 && slot1ContainsKills ? 0 : 1);
