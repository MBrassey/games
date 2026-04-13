#!/usr/bin/env bash
# Build ClaudeMythos into a love.js web runtime under public/games/claude-mythos/runtime/.
#
# Inputs:  ~/Downloads/ClaudeMythos/    (LÖVE2D source)
# Outputs: <repo>/public/games/claude-mythos/game.love
#          <repo>/public/games/claude-mythos/runtime/index.html
#          <repo>/public/games/claude-mythos/runtime/love.js
#          <repo>/public/games/claude-mythos/runtime/love.wasm
#          <repo>/public/games/claude-mythos/runtime/game.data
#
# Requires: bash, zip, node + npx (love.js is an npm package we invoke on demand).
#   npx love.js  →  runs github.com/Davidobot/love.js web-exporter (no global install).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${CLAUDE_MYTHOS_SRC:-$HOME/Downloads/ClaudeMythos}"
OUT_DIR="$ROOT/public/games/claude-mythos"
RUNTIME_DIR="$OUT_DIR/runtime"
LOVE_FILE="$OUT_DIR/game.love"
TEMPLATE="$RUNTIME_DIR/index.html.template"

if [ ! -d "$SRC" ]; then
  echo "error: source not found at $SRC" >&2
  echo "       set CLAUDE_MYTHOS_SRC to point at your LÖVE2D project" >&2
  exit 1
fi

if [ ! -f "$SRC/main.lua" ] || [ ! -f "$SRC/conf.lua" ]; then
  echo "error: $SRC missing main.lua or conf.lua" >&2
  exit 1
fi

echo "» applying web-compat patches (LuaJIT → Lua 5.1)"
STAGING="$(mktemp -d)/src"
node "$ROOT/scripts/web-compat-patch.mjs" "$SRC" "$STAGING"

echo "» packing patched source → game.love"
mkdir -p "$OUT_DIR"
rm -f "$LOVE_FILE"
node "$ROOT/scripts/make-love.mjs" "$STAGING" "$LOVE_FILE"
rm -rf "$(dirname "$STAGING")"

echo "» compiling with love.js (npx)"
mkdir -p "$RUNTIME_DIR"
TMP="$(mktemp -d)"
# love.js CLI signature: love.js [options] <input.love> <output_dir>
#   -c   compatibility mode (wider browser support, slower)
#   -t   title
npx --yes love.js@11 -c -t "Claude: Mythos" "$LOVE_FILE" "$TMP/out" || {
  echo "error: love.js build failed." >&2
  echo "       try: npm i -g love.js   (or)   npx love.js --help" >&2
  exit 1
}

# love.js emits its own index.html; we replace it with our bridge-aware shell.
cp "$TMP/out/love.js"   "$RUNTIME_DIR/love.js"
cp "$TMP/out/love.wasm" "$RUNTIME_DIR/love.wasm" 2>/dev/null || true
cp "$TMP/out/game.data" "$RUNTIME_DIR/game.data" 2>/dev/null || true
# Some love.js versions emit a single .js file that embeds the wasm + data.
# In that case the two optional copies above are no-ops, which is fine.

cp -r "$TMP/out/theme" "$RUNTIME_DIR/theme" 2>/dev/null || true
if [ -f "$TEMPLATE" ]; then
  cp "$TEMPLATE" "$RUNTIME_DIR/index.html"
  echo "  ok  bridge-enabled index.html from template"
else
  echo "warn: template missing at $TEMPLATE, using love.js default index.html" >&2
  cp "$TMP/out/index.html" "$RUNTIME_DIR/index.html"
fi

rm -rf "$TMP"
echo "» done. runtime at: $RUNTIME_DIR"
ls -lh "$RUNTIME_DIR"
