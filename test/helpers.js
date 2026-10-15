import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server/index.js';
import { silentLogger } from '../server/log.js';
import { createCameraAdapter } from '../server/sources/adapters/camera.js';
import { buildCatalogue } from '../server/sources/adapters/index.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const KEY = 'test-key-0123456789abcdefghijklmnopqrstuvwxyz';
export const KEY2 = 'other-key-0123456789abcdefghijklmnopqrstuvwxyz';
export const PUBLIC_URL = 'https://observatory.elliscode.com';

// A minimal JPEG-shaped file (SOI + SOF0 header + padding) that imageSize() can read. Tests fake
// the decoder, so it never needs to be a decodable image.
export function fakeJpeg(width, height, seq = 0) {
  const head = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03]);
  const pad = Buffer.alloc(2048);
  pad.writeUInt32BE(seq, 0);
  return Buffer.concat([head, pad]);
}

export function gradient(w = 16, h = 9, offset = 0) {
  const b = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) b[y * w + x] = Math.min(255, 40 + x * 8 + y * 4 + offset);
  return b;
}

// Camera adapter whose capture/decode are controlled by the test. Timers are inert, so captures
// happen only through registry.captureNow().
export function fakeCamera() {
  const ctl = { mode: 'ok', width: 1280, height: 720, seq: 0, frames: [], captures: 0 };
  const adapter = createCameraAdapter({
    capture: async (cfg, out) => {
      ctl.captures++;
      if (ctl.mode === 'fail') throw new Error('Selected framerate (30.000000) is not supported by the device');
      if (ctl.mode === 'tiny') return writeFileSync(out, Buffer.alloc(10));
      writeFileSync(out, fakeJpeg(ctl.width, ctl.height, ++ctl.seq));
    },
    decode: async (file, w, h) => ctl.frames.shift() ?? gradient(w, h, (ctl.seq % 2) * 60),
    timers: { setTimeout: () => null, clearTimeout: () => {} },
  });
  return { ctl, adapter };
}

export const CAMERA_CONFIG = { subject: 'Turtle aquarium', analysisWidth: 16, analysisHeight: 9, historyCount: 2 };

export async function startServer(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'observatory-test-'));
  const cam = fakeCamera();
  const server = createServer({
    dataDir: dir,
    apiKeys: [{ id: 'primary', key: KEY }, { id: 'secondary', key: KEY2 }],
    publicUrl: PUBLIC_URL,
    logger: silentLogger,
    adapters: buildCatalogue([cam.adapter, ...(opts.extraAdapters || [])]),
    timers: false,
    ...opts,
  });
  await new Promise((r) => server.httpServer.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  return {
    server, base, dir, cam: cam.ctl,
    random: (body, { key = KEY, headers = {} } = {}) => fetch(`${base}/api/v1/random`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    async close() {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export async function addCamera(ctx, config = CAMERA_CONFIG, id = 'tank-cam') {
  return ctx.server.registry.create({ id, name: 'Aquarium Camera', type: 'camera', config });
}
