// Generates web/og-image.png — a 1200x630 branded card for social/OG tags.
// Pure Node (zlib only), deterministic: dark background, terminal caret motif,
// "result row" bars echoing the site's chunks. Run: node scripts/build-og-image.mjs
import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const W = 1200, H = 630;
const px = Buffer.alloc(W * H * 3);

function rect(x0, y0, w, h, [r, g, b]) {
  for (let y = Math.max(0, y0); y < Math.min(H, y0 + h); y++)
    for (let x = Math.max(0, x0); x < Math.min(W, x0 + w); x++) {
      const i = (y * W + x) * 3;
      px[i] = r; px[i + 1] = g; px[i + 2] = b;
    }
}

// background #0A0D12
rect(0, 0, W, H, [10, 13, 18]);
// faint grid
for (let x = 0; x < W; x += 60) rect(x, 0, 1, H, [22, 27, 36]);
for (let y = 0; y < H; y += 60) rect(0, y, W, 1, [22, 27, 36]);
// accent caret block (#45C4E9) — the wordmark motif
rect(88, 210, 26, 150, [69, 196, 233]);
rect(126, 210, 74, 150, [232, 237, 244]);
// "terminal window" card
rect(340, 120, 780, 390, [15, 19, 26]);
rect(340, 120, 780, 3, [45, 196, 233]);
// result rows (dim bars with score chips), echoing the evidence rail
const rows = [[210, 420], [270, 340], [330, 480], [390, 300]];
for (const [y, w] of rows) {
  rect(400, y, w, 26, [30, 37, 48]);
  rect(400, y, 6, 26, [69, 196, 233]);
  rect(400 + w - 60, y, 54, 26, [52, 44, 92]); // purple score chip
}
// bottom accent bar
rect(0, H - 8, W, 8, [69, 196, 233]);

// PNG encode: RGB, no interlace, filter 0 per scanline.
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  px.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3);
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crcTable = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c >>> 0; }
  let crc = 0xffffffff;
  for (const b of body) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  const crcB = Buffer.alloc(4); crcB.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([len, body, crcB]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 2; // 8-bit, truecolor
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk("IHDR", ihdr),
  chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
  chunk("IEND", Buffer.alloc(0)),
]);
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "og-image.png");
fs.writeFileSync(out, png);
console.log(`wrote ${out} (${png.length} bytes)`);
