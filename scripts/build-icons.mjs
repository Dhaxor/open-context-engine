#!/usr/bin/env node
// The site's icons, drawn from one 32-unit logo (a prompt chevron and a cursor
// block on the night canvas) so every size is the same mark:
//
//   web/favicon.svg          the browser tab (vector)
//   web/favicon.ico          48 px, PNG-in-ICO — the URL search engines fetch
//   web/apple-touch-icon.png 180 px, full-bleed (iOS rounds it itself)
//   web/logo.png             512 px, full-bleed — Organization.logo in JSON-LD
//
// Pure Node (zlib only), deterministic. Run: node scripts/build-icons.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web");

const BG = [10, 13, 18];
const CYAN = [69, 196, 233];
const INK = [232, 237, 244];
// The mark, in a 32×32 box.
const CHEVRON = [[8.2, 10.6], [13.2, 16], [8.2, 21.4]];
const STROKE = 2.7;
const BLOCK = { x: 17, y: 9, w: 7, h: 14, r: 1 };
const CORNER = 7;

fs.writeFileSync(path.join(web, "favicon.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
  `<rect width="32" height="32" rx="${CORNER}" fill="#0A0D12"/>` +
  `<path d="M${CHEVRON.map(p => p.join(" ")).join(" L")}" fill="none" stroke="#45C4E9" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round"/>` +
  `<rect x="${BLOCK.x}" y="${BLOCK.y}" width="${BLOCK.w}" height="${BLOCK.h}" rx="${BLOCK.r}" fill="#E8EDF4"/>` +
  `</svg>\n`);

function segDist(px, py, [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function inRounded(x, y, rx, ry, w, h, r) {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false;
  const cx = Math.max(rx + r, Math.min(x, rx + w - r));
  const cy = Math.max(ry + r, Math.min(y, ry + h - r));
  return Math.hypot(x - cx, y - cy) <= r;
}

/** RGBA pixels at `size`, 4×4 supersampled. `bleed`: fill the square (no transparent corners). */
function render(size, bleed) {
  const px = Buffer.alloc(size * size * 4);
  const s = 32 / size;
  const SS = 4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let j = 0; j < SS; j++) {
        for (let i = 0; i < SS; i++) {
          const ux = (x + (i + 0.5) / SS) * s;
          const uy = (y + (j + 0.5) / SS) * s;
          let c = null;
          if (inRounded(ux, uy, BLOCK.x, BLOCK.y, BLOCK.w, BLOCK.h, BLOCK.r)) c = INK;
          else if (Math.min(segDist(ux, uy, CHEVRON[0], CHEVRON[1]), segDist(ux, uy, CHEVRON[1], CHEVRON[2])) <= STROKE / 2) c = CYAN;
          else if (bleed || inRounded(ux, uy, 0, 0, 32, 32, CORNER)) c = BG;
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      // Premultiplied average → straight alpha.
      px[o + 3] = Math.round(a / n);
      if (a) { px[o] = Math.round(r * 255 / a); px[o + 1] = Math.round(g * 255 / a); px[o + 2] = Math.round(b * 255 / a); }
    }
  }
  return px;
}

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  let crc = 0xffffffff;
  for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  const crcB = Buffer.alloc(4); crcB.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crcB]);
}
function png(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** A single-image ICO whose payload is a PNG (every current browser and crawler reads it). */
function ico(size, pngBytes) {
  const head = Buffer.alloc(6 + 16);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head[6] = size >= 256 ? 0 : size; head[7] = size >= 256 ? 0 : size;
  head[8] = 0; head[9] = 0;
  head.writeUInt16LE(1, 10); head.writeUInt16LE(32, 12);
  head.writeUInt32LE(pngBytes.length, 14); head.writeUInt32LE(22, 18);
  return Buffer.concat([head, pngBytes]);
}

fs.writeFileSync(path.join(web, "favicon.ico"), ico(48, png(48, render(48, false))));
fs.writeFileSync(path.join(web, "apple-touch-icon.png"), png(180, render(180, true)));
fs.writeFileSync(path.join(web, "logo.png"), png(512, render(512, true)));
console.log("wrote web/favicon.svg, favicon.ico (48), apple-touch-icon.png (180), logo.png (512)");
