// Camera adapter (Optical Measurement Subsystem). Captures a JPEG with ffmpeg/avfoundation at a
// configurable interval, runs Frame Differential Analysis against the previous valid frame, and
// reports the observation. Capture and decode functions are injectable for tests.

import { stat, rm } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { captureJpeg, decodeGray, CaptureError } from '../ffmpeg.js';
import { analyze } from '../analysis/frame-diff.js';
import { imageSize } from '../../web/preview.js';

export const CAMERA_SCHEMA = {
  subject: { type: 'string', default: 'Unspecified subject', maxLength: 120, label: 'Observation subject', help: 'What the camera is looking at, e.g. "Turtle aquarium".' },
  device: { type: 'string', default: '0', maxLength: 300, label: 'Device', help: 'avfoundation device index or name (see ffmpeg -f avfoundation -list_devices true -i ""), or file:/path/to/image.jpg for camera-free trials.' },
  intervalMs: { type: 'integer', default: 5000, min: 1000, max: 3_600_000, label: 'Capture interval (ms)' },
  width: { type: 'integer', default: 1280, min: 160, max: 4096, label: 'Capture width' },
  height: { type: 'integer', default: 720, min: 120, max: 4096, label: 'Capture height' },
  framerate: { type: 'string', default: '30', maxLength: 16, pattern: /^\d+(\.\d+)?$/, label: 'Framerate', help: 'Must match a mode the camera lists exactly, e.g. 30, 29.97 or 30.000030.' },
  pixelFormat: { type: 'string', default: '', maxLength: 16, pattern: /^[a-z0-9]+$/, label: 'Pixel format', help: 'Optional, e.g. uyvy422 or nv12.' },
  warmupFrames: { type: 'integer', default: 25, min: 0, max: 300, label: 'Warm-up frames discarded', help: 'Lets auto-exposure and white balance settle on each cold start.' },
  historyCount: { type: 'integer', default: 24, min: 0, max: 10_000, label: 'Unreferenced frames kept' },
  analysisWidth: { type: 'integer', default: 160, min: 16, max: 640, label: 'Analysis width' },
  analysisHeight: { type: 'integer', default: 90, min: 9, max: 480, label: 'Analysis height' },
  diffThreshold: { type: 'integer', default: 12, min: 1, max: 255, label: 'Pixel change threshold (0-255)' },
  blur: { type: 'boolean', default: true, label: 'Noise-suppression blur' },
};

export function createCameraAdapter({
  capture = null,
  decode = null,
  ffmpegPath = 'ffmpeg',
  now = Date.now,
  timers = { setTimeout, clearTimeout },
} = {}) {
  const doCapture = capture || ((cfg, out) => captureJpeg(cfg, out, { ffmpegPath }));
  const doDecode = decode || ((file, w, h) => decodeGray(file, w, h, { ffmpegPath }));

  return {
    type: 'camera',
    displayName: 'Optical Measurement Subsystem',
    description: 'Captures still images of a physical scene and measures frame-to-frame change. Images are ordinary measurements; no entropy assessment is made.',
    measurementKind: 'measurement',
    entropyAssessment: 'none',
    configSchema: CAMERA_SCHEMA,

    create(source, ctx) {
      const cfg = source.config;
      const clock = ctx.now || now;
      let timer = null;
      let running = false;
      let inflight = null;
      let prevGray = null;
      let prevSize = null;
      let lastObservedAt = null;

      async function captureOnce() {
        const tmp = ctx.tmpPath('.jpg');
        try {
          await doCapture(cfg, tmp);
          const st = await stat(tmp).catch(() => null);
          if (!st) throw new CaptureError('capture produced no file');
          if (st.size < 1024) throw new CaptureError(`captured image is too small (${st.size} bytes)`);
          const size = imageSize(tmp);
          if (!size) throw new CaptureError('captured file is not a readable image');
          const observedAt = clock();
          const t0 = performance.now();
          const gray = await doDecode(tmp, cfg.analysisWidth, cfg.analysisHeight);
          const analysis = prevGray
            ? analyze(prevGray, gray, {
              width: cfg.analysisWidth, height: cfg.analysisHeight, threshold: cfg.diffThreshold, blur: cfg.blur,
              sourceSizePrev: prevSize, sourceSizeCurr: size,
            })
            : null;
          const processingMs = performance.now() - t0;
          // The baseline always moves to the newest valid frame (also after a discontinuity).
          prevGray = gray;
          prevSize = size;
          const intervalMs = lastObservedAt === null ? null : observedAt - lastObservedAt;
          lastObservedAt = observedAt;
          await ctx.report({
            observedAt,
            kind: 'image',
            values: { width: size.width, height: size.height, bytes: st.size, subject: cfg.subject },
            image: { tmpFile: tmp, width: size.width, height: size.height },
            analysis,
            processingMs,
            intervalMs,
          });
        } catch (err) {
          await rm(tmp, { force: true }).catch(() => {});
          ctx.reportError(err);
        }
      }

      function runCapture() {
        if (!inflight) inflight = captureOnce().finally(() => { inflight = null; });
        return inflight;
      }

      function schedule(delay) {
        if (!running) return;
        timer = timers.setTimeout(async () => {
          timer = null;
          await runCapture();
          schedule(cfg.intervalMs);
        }, delay);
        timer?.unref?.();
      }

      return {
        start() {
          if (running) return;
          running = true;
          schedule(0);
        },
        stop() {
          running = false;
          if (timer) timers.clearTimeout(timer);
          timer = null;
        },
        captureNow: runCapture,
        getStatus: () => ({ capturing: !!inflight, running }),
      };
    },
  };
}
