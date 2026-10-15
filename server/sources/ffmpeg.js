// ffmpeg helpers: camera capture (avfoundation on macOS) and frame decoding to raw grayscale.
// No image library is needed; ffmpeg does both jobs.

import { spawn } from 'node:child_process';
import { copyFile } from 'node:fs/promises';

export class CaptureError extends Error {}

// Builds the avfoundation capture arguments. The first `warmupFrames` frames are discarded so
// auto-exposure and white balance can settle: every capture is a cold start of the camera.
export function buildCaptureArgs(cfg, output) {
  const device = String(cfg.device ?? '0');
  const input = device.includes(':') ? device : `${device}:none`;
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'avfoundation',
    '-framerate', String(cfg.framerate ?? '30'),
    ...(cfg.pixelFormat ? ['-pixel_format', String(cfg.pixelFormat)] : []),
    '-video_size', `${cfg.width}x${cfg.height}`,
    '-i', input,
    '-vf', `select=gte(n\\,${Number(cfg.warmupFrames ?? 25)})`,
    '-frames:v', '1',
    '-q:v', '3',
    '-y', output,
  ];
}

export function buildDecodeArgs(file, width, height) {
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', file,
    '-vf', `scale=${width}:${height},format=gray`,
    '-f', 'rawvideo', '-pix_fmt', 'gray',
    '-frames:v', '1',
    'pipe:1',
  ];
}

function run(ffmpegPath, args, { timeoutMs, collectStdout = false }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(ffmpegPath, args, { stdio: ['ignore', collectStdout ? 'pipe' : 'ignore', 'pipe'] });
    } catch (err) {
      reject(new CaptureError(`could not start ffmpeg: ${err.message}`));
      return;
    }
    const out = [];
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    if (collectStdout) child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString()).slice(-4000);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new CaptureError(err.code === 'ENOENT' ? 'ffmpeg not found (brew install ffmpeg)' : `ffmpeg failed: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return reject(new CaptureError(`ffmpeg timed out after ${timeoutMs} ms`));
      if (code !== 0) {
        const last = stderr.trim().split('\n').filter(Boolean).pop() || `exit code ${code}`;
        return reject(new CaptureError(last.slice(0, 300)));
      }
      resolve(Buffer.concat(out));
    });
  });
}

// `file:<path>` copies an existing image instead of using a camera (camera-free trials).
export async function captureJpeg(cfg, output, { ffmpegPath = 'ffmpeg', timeoutMs = 15_000 } = {}) {
  const device = String(cfg.device ?? '0');
  if (device.startsWith('file:')) {
    await copyFile(device.slice('file:'.length), output);
    return;
  }
  await run(ffmpegPath, buildCaptureArgs(cfg, output), { timeoutMs });
}

export async function decodeGray(file, width, height, { ffmpegPath = 'ffmpeg', timeoutMs = 10_000 } = {}) {
  const buf = await run(ffmpegPath, buildDecodeArgs(file, width, height), { timeoutMs, collectStdout: true });
  if (buf.length !== width * height) throw new CaptureError(`decoded frame has ${buf.length} bytes, expected ${width * height}`);
  return buf;
}
