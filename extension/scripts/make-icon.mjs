#!/usr/bin/env node
/**
 * Generate the marketplace icon (extension/icon.png) from the brand mark —
 * the same `›` prompt + block caret as the site favicon and CLI wordmark.
 *
 * Dependency-free: rasterizes to raw RGBA and writes a PNG by hand (zlib is in
 * node core), so no image toolchain is required in CI or on a fresh clone.
 *
 *   node scripts/make-icon.mjs [size]     # default 256
 */
import { deflateSync } from "zlib";
import { writeFileSync } from "fs";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const SIZE = Number(process.argv[2]) || 256;
const BG = [0x0a, 0x0d, 0x12];      // --void
const PROMPT = [0x45, 0xc4, 0xe9];  // --prompt (cyan)
const INK = [0xe8, 0xed, 0xf4];     // --ink

const px = new Uint8Array(SIZE * SIZE * 4);
const s = SIZE / 256; // design at 256, scale to requested size

function setPx(x, y, [r, g, b], a = 1) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  // alpha-blend onto whatever is there (for antialiased edges)
  px[i] = Math.round(px[i] * (1 - a) + r * a);
  px[i + 1] = Math.round(px[i + 1] * (1 - a) + g * a);
  px[i + 2] = Math.round(px[i + 2] * (1 - a) + b * a);
  px[i + 3] = 255;
}

/** Distance from point to line segment — used for thick, round-capped strokes. */
function distToSegment(px_, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px_ - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px_ - (x1 + t * dx), py - (y1 + t * dy));
}

// 1. Canvas
for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) setPx(x, y, BG, 1);

// 2. The chevron `›` — two strokes meeting at a point, cyan.
// Sized so the mark spans ~168 of 256 (≈44px margin): legible down to 32px.
const strokeW = 31 * s;
const cx = 60 * s, cyTop = 58 * s, cyMid = 128 * s, cyBot = 198 * s, tipX = 127 * s;
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = Math.min(
      distToSegment(x, y, cx, cyTop, tipX, cyMid),
      distToSegment(x, y, tipX, cyMid, cx, cyBot),
    );
    const edge = d - strokeW / 2;
    if (edge < 0) setPx(x, y, PROMPT, 1);
    else if (edge < 1.5) setPx(x, y, PROMPT, 1 - edge / 1.5); // antialias
  }
}

// 3. The block caret — a filled rect in ink, echoing the terminal cursor.
const bx = 164 * s, by = 52 * s, bw = 48 * s, bh = 152 * s;
for (let y = Math.round(by); y < Math.round(by + bh); y++) {
  for (let x = Math.round(bx); x < Math.round(bx + bw); x++) setPx(x, y, INK, 1);
}

// 4. Encode PNG (RGBA, no interlace).
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crcTable = chunk._t || (chunk._t = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE((crc ^ -1) >>> 0);
  return Buffer.concat([len, body, crcBuf]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;   // bit depth
ihdr[9] = 6;   // color type: RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0; // filter: none
  Buffer.from(px.buffer, y * SIZE * 4, SIZE * 4).copy(raw, y * (SIZE * 4 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);

const out = join(dirname(fileURLToPath(import.meta.url)), "..", "icon.png");
writeFileSync(out, png);
console.log(`wrote ${out} — ${SIZE}x${SIZE}, ${(png.length / 1024).toFixed(1)} KB, sha256 ${createHash("sha256").update(png).digest("hex").slice(0, 12)}`);
