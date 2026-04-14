#!/usr/bin/env node
// Empirically discover where LÖVE actually writes saves in love.js.
//
// 1. Patch the game's main.lua to print getSaveDirectory / getAppdataDirectory
//    / getIdentity right at boot (before anything else).
// 2. Also wrap love.filesystem.write to print the final path it sees.
// 3. Boot the game headless, ignore everything, capture the logs.
// 4. Print the real save paths so we can hard-code the bridge to match.

import { createServer } from "node:http";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { execFileSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, ".cache", "game-src", "claude-mythos");
const TMP = "/tmp/probe-love-src";

// Clean copy of the game.
execFileSync("rm", ["-rf", TMP]);
execFileSync("cp", ["-r", SRC, TMP]);

// Inject diagnostic prints at the top of main.lua so we see them as soon
// as love.load runs.
const mainPath = join(TMP, "main.lua");
const origMain = readFileSync(mainPath, "utf8");
const diag = [
  "do",
  "  local function p(k,v) print('LOVEWEB-PROBE ' .. k .. '=' .. tostring(v)) end",
  "  local fs = love.filesystem",
  "  p('identity',        fs.getIdentity and fs.getIdentity() or '(no-api)')",
  "  p('saveDir',         fs.getSaveDirectory and fs.getSaveDirectory() or '(no-api)')",
  "  p('appdataDir',      fs.getAppdataDirectory and fs.getAppdataDirectory() or '(no-api)')",
  "  p('sourceBaseDir',   fs.getSourceBaseDirectory and fs.getSourceBaseDirectory() or '(no-api)')",
  "  p('workingDir',      fs.getWorkingDirectory and fs.getWorkingDirectory() or '(no-api)')",
  "  p('realDirForSave',  fs.getRealDirectory and (fs.getRealDirectory('claude_mythos_save_1.txt') or 'nil') or '(no-api)')",
  "  p('hasLegacy',       fs.getInfo and (fs.getInfo('claude_mythos_save.txt') ~= nil and 'yes' or 'no') or '(no-api)')",
  "  p('hasSlot1',        fs.getInfo and (fs.getInfo('claude_mythos_save_1.txt') ~= nil and 'yes' or 'no') or '(no-api)')",
  "  p('hasActive',       fs.getInfo and (fs.getInfo('claude_mythos_active.txt') ~= nil and 'yes' or 'no') or '(no-api)')",
  "  local origWrite = fs.write",
  "  fs.write = function(name, data, size)",
  "    p('WRITE path=', name)",
  "    return origWrite(name, data, size)",
  "  end",
  "end",
  "",
].join("\n");
writeFileSync(mainPath, diag + origMain);

// Patch + pack + compile the probe build.
const patched = "/tmp/probe-love-patched";
execFileSync("rm", ["-rf", patched]);
execFileSync("node", [join(ROOT, "scripts/web-compat-patch.mjs"), TMP, patched]);
const loveFile = "/tmp/probe.love";
execFileSync("node", [join(ROOT, "scripts/make-love.mjs"), patched, loveFile]);
execFileSync("rm", ["-rf", "/tmp/probe-out"]);
execFileSync("npx", ["--yes", "love.js@11", "-c", "-t", "probe", loveFile, "/tmp/probe-out"], { stdio: "inherit" });

// Copy compiled runtime next to a minimal host page.
const RUNTIME = "/tmp/probe-out";

// Post-patch love.js the same way build-games.mjs does — inject
// `Module["FS"]=FS` alongside FS_createDataFile so we could inspect FS.
{
  const p = join(RUNTIME, "love.js");
  let js = readFileSync(p, "utf8");
  if (!js.includes('Module["FS"]=FS')) {
    js = js.replace(/(Module\["FS_createDataFile"\]\s*=\s*FS\.createDataFile\s*;?)/, '$1Module["FS"]=FS;');
    writeFileSync(p, js);
  }
}

const HOST = `<!doctype html><html><body style="margin:0;background:#000">
<iframe id="f" src="/runtime/index.html" style="width:100vw;height:100vh;border:0"
  sandbox="allow-scripts allow-same-origin allow-pointer-lock"></iframe>
</body></html>`;

const INDEX = `<!doctype html><html>
<head><meta charset="utf-8"></head>
<body>
<canvas id="canvas" oncontextmenu="event.preventDefault()"></canvas>
<script>
var Module = {
  arguments: ["./game.love"],
  INITIAL_MEMORY: 33554432,
  canvas: document.getElementById("canvas"),
  print: function(t){ console.log(t); },
  printErr: function(t){ console.log("ERR:" + t); },
  setStatus: function(){},
  totalDependencies: 0, remainingDependencies: 0,
  monitorRunDependencies: function(){}
};
var applicationLoad = function(){ Love(Module); };
</script>
<script src="game.js"></script>
<script async src="love.js" onload="applicationLoad(this)"></script>
</body></html>`;

const MIME = {".html":"text/html",".js":"application/javascript",".wasm":"application/wasm",".data":"application/octet-stream",".css":"text/css"};
const server = createServer((req,res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/") { res.writeHead(200, {"Content-Type":"text/html"}); res.end(HOST); return; }
  if (url.pathname === "/runtime/index.html") { res.writeHead(200,{"Content-Type":"text/html"}); res.end(INDEX); return; }
  const p = join(RUNTIME, url.pathname.replace(/^\/runtime\//, ""));
  try { const st = statSync(p); if (st.isDirectory()) throw 0;
    res.writeHead(200, {"Content-Type": MIME[p.slice(p.lastIndexOf("."))] || "application/octet-stream"});
    res.end(readFileSync(p));
  } catch { res.writeHead(404); res.end("nf"); }
});
const port = await new Promise(r => server.listen(0, () => r(server.address().port)));

const browser = await chromium.launch({ headless: true, args:["--no-sandbox"] });
const page = await browser.newPage();
const probeLines = [];
page.on("console", (m) => {
  const t = m.text();
  if (t.includes("LOVEWEB-PROBE")) probeLines.push(t);
});
await page.goto(`http://127.0.0.1:${port}/`);
await page.waitForTimeout(10000);
await browser.close();
server.close();

console.log("\n=== PROBE RESULTS ===");
for (const l of probeLines) console.log(" ", l);
