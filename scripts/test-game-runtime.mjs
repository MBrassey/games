#!/usr/bin/env node
// Smoke test a compiled love.js game runtime in a real headless browser.
// Serves the runtime directory over plain HTTP, loads index.html in
// Chromium, captures console output + page errors for 15 seconds, then
// reports whether anything looks like a LÖVE runtime error.
//
// Usage: node scripts/test-game-runtime.mjs <runtime-dir>
// Exit:  0 on clean boot, 1 on errors / timeout without "ready" signal.

import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import { chromium, firefox, webkit } from "playwright";

const runtimeDir = process.argv[2];
const browserName = (process.argv[3] || "chromium").toLowerCase();
if (!runtimeDir) {
  console.error("usage: test-game-runtime.mjs <runtime-dir> [chromium|firefox|webkit]");
  process.exit(2);
}
const launcher = browserName === "firefox" ? firefox : browserName === "webkit" ? webkit : chromium;

const MIME = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".css": "text/css",
  ".png": "image/png",
};

const server = createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const p = join(runtimeDir, url.pathname === "/" ? "index.html" : url.pathname);
  try {
    const st = statSync(p);
    if (st.isDirectory()) throw new Error("dir");
    const body = readFileSync(p);
    res.writeHead(200, {
      "Content-Type": MIME[extname(p)] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
});
const port = await new Promise((res) => {
  server.listen(0, () => res(server.address().port));
});

console.log(`» serving ${runtimeDir} at http://127.0.0.1:${port}`);

const launchArgs = browserName === "chromium"
  ? { headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] }
  : { headless: true };
console.log(`» launching ${browserName}`);
const browser = await launcher.launch(launchArgs);
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 720 },
  bypassCSP: true,
});
const page = await ctx.newPage();

const logs = [];
const errors = [];
let readySeen = false;

page.on("console", (msg) => {
  const text = msg.text();
  logs.push(`[${msg.type()}] ${text}`);
  if (text.includes("loveweb:ready") || text.includes("all downloads complete")) readySeen = true;
});
page.on("pageerror", (e) => errors.push(`page error: ${e.message}`));
page.on("requestfailed", (r) => errors.push(`req failed: ${r.url()} — ${r.failure()?.errorText}`));
// bridge message forwarding: intercept postMessage from runtime iframe, surface them.
await page.addInitScript(() => {
  window.addEventListener("message", (ev) => {
    try { console.log("[postMessage] " + JSON.stringify(ev.data)); } catch {}
  });
});

const url = `http://127.0.0.1:${port}/?slug=test`;
console.log(`» opening ${url}`);
await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch((e) => {
  errors.push(`nav: ${e.message}`);
});

// Let love.js finish its WASM init and first frames.
await page.waitForTimeout(12000);

// Pull any in-page Module state we can see.
const status = await page.evaluate(() => {
  const o = {};
  try {
    o.hasModule = typeof window.Module !== "undefined";
    o.deps = window.Module?.remainingDependencies;
    const c = document.querySelector("#canvas");
    if (c) { o.canvasW = c.width; o.canvasH = c.height; o.canvasVisible = getComputedStyle(c).visibility; }
  } catch (e) { o.error = String(e); }
  return o;
});

console.log("\n================ page status ================");
console.log(JSON.stringify(status, null, 2));

console.log("\n================ console logs ================");
for (const l of logs) console.log(l);

console.log("\n================ errors ================");
for (const e of errors) console.log(e);

await browser.close();
server.close();

const luaErr = logs.some((l) => /Error:.*lua|boot\.lua|xpcall/i.test(l));
const syntaxErr = logs.some((l) => /Syntax error/i.test(l));
const ok = readySeen && !syntaxErr && !luaErr && errors.length === 0;

console.log("\n================ verdict ================");
console.log(ok ? "PASS ✓ game booted clean" : "FAIL ✗ see logs above");
process.exit(ok ? 0 : 1);
