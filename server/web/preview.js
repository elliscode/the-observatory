import { openSync, readSync, closeSync } from 'node:fs';

// Width/height from an image header (PNG, GIF, WebP, JPEG). Returns null if unknown.
// Copied from dungeons-and-ellis server/preview.js.
function readHead(file, bytes = 65536) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    return buf.subarray(0, readSync(fd, buf, 0, bytes, 0));
  } finally {
    closeSync(fd);
  }
}

export function imageSize(file) {
  let b;
  try { b = readHead(file); } catch { return null; }
  return imageSizeFromBuffer(b);
}

export function imageSizeFromBuffer(b) {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b.length >= 10 && b.subarray(0, 3).toString('latin1') === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.length >= 30 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') {
    const kind = b.subarray(12, 16).toString('latin1');
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L') {
      return {
        width: 1 + (((b[22] & 0x3f) << 8) | b[21]),
        height: 1 + (((b[24] & 0x0f) << 10) | (b[23] << 2) | ((b[22] & 0xc0) >> 6)),
      };
    }
    if (kind === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    return null;
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      const len = b.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
