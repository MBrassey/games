#!/usr/bin/env node
// Pack a directory into a .love file (zip) without requiring the `zip` CLI.
// Uses Node's built-in deflate + writes a minimal ZIP container. No external
// npm deps.
//
// Usage: node scripts/make-love.mjs <src-dir> <out.love>

import { readdirSync, statSync, readFileSync, writeFileSync, createWriteStream } from "node:fs";
import { join, relative, sep } from "node:path";
import { deflateRawSync, crc32 } from "node:zlib";

const [srcDir, outFile] = process.argv.slice(2);
if (!srcDir || !outFile) {
  console.error("usage: make-love.mjs <src-dir> <out.love>");
  process.exit(1);
}

const EXCLUDE = [/^\.git(\/|$)/, /^\.claude(\/|$)/, /(^|\/)\.DS_Store$/];

function walk(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = relative(base, full).split(sep).join("/");
    if (EXCLUDE.some((re) => re.test(rel))) continue;
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full, base));
    else if (st.isFile()) out.push({ full, rel, size: st.size });
  }
  return out;
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

const files = walk(srcDir);
const chunks = [];
const central = [];
let offset = 0;

for (const f of files) {
  const data = readFileSync(f.full);
  const compressed = deflateRawSync(data);
  const crc = crc32(data);
  const nameBuf = Buffer.from(f.rel, "utf8");

  const localHeader = Buffer.concat([
    Buffer.from("504b0304", "hex"), // local file header signature
    u16(20),        // version needed
    u16(0),         // general purpose
    u16(8),         // compression method = deflate
    u16(0),         // mod time
    u16(0x21),      // mod date (jan 1 1980+)
    u32(crc),
    u32(compressed.length),
    u32(data.length),
    u16(nameBuf.length),
    u16(0),         // extra length
    nameBuf,
  ]);
  chunks.push(localHeader, compressed);

  const centralHeader = Buffer.concat([
    Buffer.from("504b0102", "hex"), // central directory header signature
    u16(20), u16(20), u16(0), u16(8),
    u16(0), u16(0x21),
    u32(crc),
    u32(compressed.length),
    u32(data.length),
    u16(nameBuf.length),
    u16(0), // extra
    u16(0), // comment
    u16(0), // disk
    u16(0), // internal attrs
    u32(0), // external attrs
    u32(offset), // local header offset
    nameBuf,
  ]);
  central.push(centralHeader);

  offset += localHeader.length + compressed.length;
}

const centralSize = central.reduce((n, b) => n + b.length, 0);
const centralOffset = offset;
const eocd = Buffer.concat([
  Buffer.from("504b0506", "hex"),
  u16(0), u16(0),
  u16(files.length), u16(files.length),
  u32(centralSize), u32(centralOffset),
  u16(0),
]);

const out = Buffer.concat([...chunks, ...central, eocd]);
writeFileSync(outFile, out);
console.log(`  ok  ${files.length} files → ${outFile} (${(out.length/1024).toFixed(1)} KB)`);
