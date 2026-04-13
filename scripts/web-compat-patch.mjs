#!/usr/bin/env node
// LuaJIT → Lua 5.1 compatibility patcher for love.js.
//
// love.js compiles LÖVE with plain Lua 5.1 (LuaJIT's trace compiler can't
// target WebAssembly), so `goto LABEL` + `::LABEL::` — valid under LuaJIT —
// become parse errors. This script rewrites those pairs to the portable
// `repeat ... break ... until true` idiom, which compiles identically under
// both runtimes.
//
// Strategy:
//   1. Parse each .lua file with a shallow block-scope tracker (function /
//      for / while / repeat / do / if-then). Every line gets a snapshot of
//      the current scope stack.
//   2. For each `::LABEL::` line, collect every `goto LABEL` that precedes
//      it in the same file.
//   3. Find the innermost scope containing all of them (deepest common
//      prefix of their scope stacks).
//   4. Wrap that scope's body in `repeat ... until true`, replace each
//      `goto` with `break`, and remove the label line.
//
// Idempotent — re-running on a patched file does nothing.
//
// Usage: node scripts/web-compat-patch.mjs <src-dir> <out-dir>

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, copyFileSync } from "node:fs";
import { join, relative, dirname, sep } from "node:path";

const [srcDir, outDir] = process.argv.slice(2);
if (!srcDir || !outDir) {
  console.error("usage: web-compat-patch.mjs <src-dir> <out-dir>");
  process.exit(1);
}

// -------- Lua scope parser (line-granular) --------

// Scope kinds:
//   "function"  — function body (ends with `end`)
//   "for"       — for-loop body
//   "while"     — while-loop body
//   "repeat"    — repeat body (ends with `until`)
//   "do"        — standalone `do ... end` block
//   "then"      — a single `then`/`elseif`/`else` branch (ends at next
//                 elseif/else/end)
//
// We return, for each line, the scope stack at *that* line (a list of
// {kind, openLine, closeLine}). This lets us find the innermost common
// scope for any set of labels + gotos.

function parseScopes(lines) {
  // Strip strings and comments to avoid misdetecting keywords inside them.
  const stripped = lines.map(stripLuaNonCode);

  const scopes = []; // accumulated {kind, openLine, closeLine}
  const stack = [];  // active scopes (indices into scopes[])
  const perLine = new Array(lines.length);

  function open(kind, openLine) {
    const idx = scopes.length;
    scopes.push({ kind, openLine, closeLine: -1 });
    stack.push(idx);
    return idx;
  }
  function closeTopIf(kinds, closeLine) {
    while (stack.length) {
      const top = scopes[stack[stack.length - 1]];
      if (kinds.includes(top.kind)) {
        top.closeLine = closeLine;
        stack.pop();
        return true;
      }
      // Pop phantom scopes too? If we were given a closer that doesn't match
      // the top, something's off — bail out of this attempt.
      return false;
    }
    return false;
  }

  // Regexes that operate on a single (stripped) line.
  // Conservative: we match simple common forms. Fine for typical LÖVE code.
  const reFunction = /(^|[^\w])function\b[^=]*\(.*?\)\s*$/;
  const reLocalFn  = /^\s*local\s+function\b/;
  const reAnonFn   = /=\s*function\b/; // var = function(...) — still opens a function scope
  const reFor      = /^\s*for\b[\s\S]*\bdo\s*$/;
  const reWhile    = /^\s*while\b[\s\S]*\bdo\s*$/;
  const reRepeat   = /^\s*repeat\b\s*$/;
  const reDoOnly   = /^\s*do\s*$/;
  const reIfThen   = /^\s*if\b[\s\S]*\bthen\s*$/;
  const reElseif   = /^\s*elseif\b[\s\S]*\bthen\s*$/;
  const reElse     = /^\s*else\s*$/;
  const reEnd      = /^\s*end\b/;
  const reUntil    = /^\s*until\b/;

  for (let i = 0; i < lines.length; i++) {
    // Snapshot current stack BEFORE processing this line — that way the
    // `end`/`until` line itself is considered "inside" the closing scope.
    perLine[i] = stack.slice();

    const s = stripped[i];

    if (reEnd.test(s)) {
      // Pops any of: function, for, while, do, then (and implicit else/elseif)
      closeTopIf(["function", "for", "while", "do", "then"], i);
    }
    if (reUntil.test(s)) {
      closeTopIf(["repeat"], i);
    }

    // Handle else/elseif: close the current "then" scope, open a new one.
    if (reElse.test(s) || reElseif.test(s)) {
      closeTopIf(["then"], i);
      open("then", i);
      continue;
    }

    if (reRepeat.test(s))           { open("repeat", i); continue; }
    if (reFor.test(s))              { open("for", i);    continue; }
    if (reWhile.test(s))            { open("while", i);  continue; }
    if (reDoOnly.test(s))           { open("do", i);     continue; }
    if (reIfThen.test(s))           { open("then", i);   continue; }

    // Function openers (may appear multiple ways on one line).
    if (reLocalFn.test(s) || reFunction.test(s) || reAnonFn.test(s)) {
      // Only count it as opening a function if the line doesn't close on the
      // same line (one-liner `function() return x end` is rare in LÖVE src;
      // we skip it).
      if (!/\bend\s*$/.test(s)) open("function", i);
    }
  }

  return { scopes, perLine };
}

// Remove Lua strings (short & long) and comments so our regexes don't fire
// on literal occurrences of keywords. Doesn't need to be perfect — just
// avoid the common pitfalls.
function stripLuaNonCode(line) {
  let out = line;
  // long bracket comments/strings on a single line: --[[ ... ]]
  out = out.replace(/--\[\[.*?\]\]/g, " ");
  // short comment to end of line
  out = out.replace(/--.*$/, "");
  // simple quoted strings
  out = out.replace(/"(?:\\.|[^"\\])*"/g, '""');
  out = out.replace(/'(?:\\.|[^'\\])*'/g, "''");
  return out;
}

// -------- goto-label transformer --------

function patchLua(src) {
  const lines = src.split("\n");

  // Fast exit: no gotos in this file.
  if (!/\bgoto\b/.test(src)) return { out: src, changed: 0 };

  const { perLine } = parseScopes(lines);

  // Collect labels and gotos.
  const labels = [];
  const gotos = [];
  for (let i = 0; i < lines.length; i++) {
    const s = stripLuaNonCode(lines[i]);
    const m1 = s.match(/^\s*::\s*([A-Za-z_]\w*)\s*::\s*$/);
    if (m1) labels.push({ line: i, label: m1[1], scopes: perLine[i] });
    // Match `goto LABEL` anywhere on a line (including trailing on a stmt).
    const g = s.matchAll(/(?:^|[;\s])goto\s+([A-Za-z_]\w*)\b/g);
    for (const mm of g) gotos.push({ line: i, label: mm[1], scopes: perLine[i] });
  }

  if (labels.length === 0) return { out: src, changed: 0 };

  // Group gotos by label.
  const byLabel = new Map();
  for (const g of gotos) {
    if (!byLabel.has(g.label)) byLabel.set(g.label, []);
    byLabel.get(g.label).push(g);
  }

  // Plan edits per label. We collect: {wrapLine (insert `repeat` after this),
  // labelLine (replace with `until true`), gotos: [lines to rewrite]}.
  type: {
    // noop — labelled block just for readability
  }
  const edits = [];
  for (const lab of labels) {
    const gs = byLabel.get(lab.label) || [];
    if (gs.length === 0) continue;

    // Common scope prefix between label and every goto.
    let common = lab.scopes.slice();
    for (const g of gs) {
      const n = Math.min(common.length, g.scopes.length);
      let k = 0;
      while (k < n && common[k] === g.scopes[k]) k++;
      common = common.slice(0, k);
    }

    // Need at least one enclosing scope that we can wrap.
    if (common.length === 0) {
      // top-of-file goto — skip (rare in LÖVE)
      continue;
    }

    const innermostScopeIdx = common[common.length - 1];
    // Find that scope record via a cheap lookup — we kept it implicit above.
    // Rebuild: re-scan to pick the matching scope object.
    // (parseScopes returned scopes array in order; we can keep a direct ref.)
    edits.push({
      scopeIdx: innermostScopeIdx,
      labelLine: lab.line,
      gotoLines: gs.map((g) => g.line),
    });
  }

  if (edits.length === 0) return { out: src, changed: 0 };

  // Recover the scopes array (re-parse once more — small cost).
  const { scopes } = parseScopes(lines);

  // Apply edits bottom-up so line indices remain valid.
  edits.sort((a, b) => b.labelLine - a.labelLine);

  let changed = 0;
  for (const e of edits) {
    const scope = scopes[e.scopeIdx];
    if (!scope || scope.openLine < 0) continue;

    // Indent to match opener's indent.
    const opener = lines[scope.openLine] || "";
    const indent = (opener.match(/^(\s*)/) || ["", ""])[1];
    const body = indent + "  ";

    // 1) Replace label line with `until true`.
    lines[e.labelLine] = body + "until true  -- was: ::label::";

    // 2) Replace each `goto LABEL` with `break` (preserve surrounding ; structure).
    for (const gl of e.gotoLines) {
      lines[gl] = lines[gl].replace(
        /(^|[;\s])goto\s+[A-Za-z_]\w*/g,
        (match, pre) => (pre === "" ? "break" : pre + "break")
      );
      changed++;
    }

    // 3) Insert `repeat` right after the scope opener.
    lines.splice(scope.openLine + 1, 0, body + "repeat");
    // Everything below openLine shifts by +1. Our edits were sorted bottom-up
    // so this shift doesn't affect remaining passes. But labelLines we've
    // already edited lie AFTER this insert, so bump scope.closeLine bookkeeping
    // isn't needed (we don't use it again).
  }

  return { out: lines.join("\n"), changed };
}

// -------- file walk --------

function walk(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir)) {
    if (e === ".git" || e === ".claude" || e === ".DS_Store") continue;
    const full = join(dir, e);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else out.push({ full, rel: relative(base, full).split(sep).join("/") });
  }
  return out;
}

let totalPatched = 0;
let totalFiles = 0;

for (const f of walk(srcDir)) {
  const outPath = join(outDir, f.rel);
  mkdirSync(dirname(outPath), { recursive: true });
  totalFiles++;
  if (f.rel.endsWith(".lua")) {
    const src = readFileSync(f.full, "utf8");
    const { out, changed } = patchLua(src);
    writeFileSync(outPath, out);
    if (changed > 0) {
      totalPatched++;
      console.log(`  patched  ${f.rel}  (${changed} goto→break)`);
    }
  } else {
    copyFileSync(f.full, outPath);
  }
}

console.log(`  ok  ${totalFiles} files, ${totalPatched} lua file(s) patched`);
