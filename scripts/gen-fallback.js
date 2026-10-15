// Generates static/og-fallback.png (1200x630): the link-preview image used before the first
// successful camera capture. Pure Node (zlib); no image libraries.
// Run: npm run fallback-image

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const W = 1200;
const H = 630;
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'static', 'og-fallback.png');

// 5x7 bitmap glyphs for the letters needed.
const FONT = {
  T: ['11111', '00100', '00100', '00100', '00100', '00100', '00100'],
  H: ['10001', '10001', '10001', '11111', '10001', '10001', '10001'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  S: ['01111', '10000', '10000', '01110', '00001', '00001', '11110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  N: ['10001', '11001', '10101', '10011', '10001', '10001', '10001'],
  I: ['11111', '00100', '00100', '00100', '00100', '00100', '11111'],
  M: ['10001', '11011', '10101', '10101', '10001', '10001', '10001'],
  G: ['01111', '10000', '10000', '10011', '10001', '10001', '01111'],
  P: ['11110', '10001', '10001', '11110', '10000', '10000', '10000'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  W: ['10001', '10001', '10001', '10101', '10101', '11011', '10001'],
  F: ['11111', '10000', '10000', '11110', '10000', '10000', '10000'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

const px = new Uint8Array(W * H * 3);
const BG = [14, 17, 22];
const INK = [226, 229, 233];
const MUTED = [110, 120, 132];
const ACCENT = [143, 184, 222];

function set(x, y, c, alpha = 1) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 3;
  for (let k = 0; k < 3; k++) px[i + k] = Math.round(px[i + k] * (1 - alpha) + c[k] * alpha);
}

for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) set(x, y, BG);

// Instrument graticule: concentric rings and crosshair centred on the right.
const cx = 990;
const cy = 315;
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    const r = Math.hypot(x - cx, y - cy);
    for (const ring of [48, 96, 144, 192, 236]) if (Math.abs(r - ring) < 0.8) set(x, y, ACCENT, ring === 144 ? 0.55 : 0.25);
    if ((Math.abs(x - cx) < 0.6 || Math.abs(y - cy) < 0.6) && r < 244) set(x, y, ACCENT, 0.3);
  }
}
for (let a = 0; a < 360; a += 5) {
  const rad = (a * Math.PI) / 180;
  const len = a % 30 === 0 ? 16 : 7;
  for (let t = 0; t < len; t++) set(Math.round(cx + Math.cos(rad) * (236 - t)), Math.round(cy + Math.sin(rad) * (236 - t)), ACCENT, 0.6);
}

function text(str, x0, y0, scale, color) {
  let x = x0;
  for (const ch of str) {
    const g = FONT[ch] || FONT[' '];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
      if (g[r][c] !== '1') continue;
      for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) set(x + c * scale + dx, y0 + r * scale + dy, color);
    }
    x += 6 * scale;
  }
}

text('THE', 80, 190, 10, MUTED);
text('OBSERVATORY', 80, 280, 10, INK);
for (let x = 80; x < 740; x++) set(x, 380, ACCENT, 0.8);
text('AWAITING FIRST OBSERVATION', 80, 410, 4, ACCENT);

// PNG encoding.
const crcTable = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});
const crc32 = (buf) => {
  let c = -1;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // truecolor RGB
const raw = Buffer.alloc((W * 3 + 1) * H);
for (let y = 0; y < H; y++) {
  raw[y * (W * 3 + 1)] = 0;
  Buffer.from(px.buffer, y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} (${png.length} bytes)`);
