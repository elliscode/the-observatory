import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { startServer, addCamera, CAMERA_CONFIG } from './helpers.js';
import { buildCaptureArgs } from '../server/sources/ffmpeg.js';

test('without sources, health, status, dashboard and random all work', async () => {
  const ctx = await startServer();
  try {
    const h = await (await fetch(`${ctx.base}/api/v1/health`)).json();
    assert.equal(h.status, 'ok');
    assert.equal(h.randomSource, 'operating-system-cryptographic-rng');
    assert.deepEqual(h.camera, { configured: false, status: 'not_configured' });
    assert.deepEqual(h.sources, []);
    const page = await (await fetch(`${ctx.base}/`)).text();
    assert.match(page, /NOT CONFIGURED/);
    const st = await (await fetch(`${ctx.base}/api/v1/status`)).json();
    assert.equal(st.subsystems.find((s) => s.name === 'Environmental Observation Array').status, 'NOT_CONFIGURED');
    assert.equal((await ctx.random({ bytes: 32 })).status, 200);
  } finally {
    await ctx.close();
  }
});

test('successful captures update latest.jpg; failures preserve it; health follows runtime state', async () => {
  const ctx = await startServer();
  const reg = () => ctx.server.registry.list()[0];
  try {
    await addCamera(ctx);
    assert.equal(reg().status, 'STARTING');
    await ctx.server.registry.captureNow('tank-cam');
    assert.equal(reg().status, 'OPERATIONAL');
    const latest = join(ctx.dir, 'observations', 'tank-cam', 'latest.jpg');
    const first = readFileSync(latest);
    assert.equal(reg().latest.width, 1280);
    assert.equal(reg().successCount, 1);

    await ctx.server.registry.captureNow('tank-cam');
    const second = readFileSync(latest);
    assert.notDeepEqual(first, second, 'latest image replaced by the new capture');
    assert.ok(reg().latestAnalysis, 'second frame produces an analysis');

    ctx.cam.mode = 'fail';
    await ctx.server.registry.captureNow('tank-cam');
    assert.equal(reg().status, 'DEGRADED');
    assert.match(reg().lastError, /framerate/);
    assert.deepEqual(readFileSync(latest), second, 'failed capture preserves the last valid image');
    await ctx.server.registry.captureNow('tank-cam');
    await ctx.server.registry.captureNow('tank-cam');
    assert.equal(reg().status, 'UNAVAILABLE');
    ctx.cam.mode = 'tiny';
    await ctx.server.registry.captureNow('tank-cam');
    assert.equal(reg().status, 'UNAVAILABLE', 'corrupt/tiny images count as failures');
    assert.deepEqual(readFileSync(latest), second);

    ctx.cam.mode = 'ok';
    await ctx.server.registry.captureNow('tank-cam');
    assert.equal(reg().status, 'DEGRADED', 'reconnected, recent failures still in the window');
    const types = ctx.server.events.list({ limit: 100 }).map((e) => e.type);
    assert.ok(types.includes('source.disconnected'));
    assert.ok(types.includes('source.reconnected'));
    assert.ok(types.includes('capture.failed'));
    assert.ok(types.includes('observation.captured'));
    assert.ok(types.includes('analysis.completed'));
    // The failure message only appears once while it repeats.
    assert.equal(types.filter((t) => t === 'capture.failed').length, 2, 'one per distinct message');

    const h = await (await fetch(`${ctx.base}/api/v1/health`)).json();
    assert.deepEqual(h.camera, { configured: true, id: 'tank-cam', status: 'degraded' });
  } finally {
    await ctx.close();
  }
});

test('dark and static scenes are handled safely', async () => {
  const ctx = await startServer();
  try {
    await addCamera(ctx);
    const black = new Uint8Array(16 * 9);
    ctx.cam.frames.push(black, black, black);
    for (let i = 0; i < 3; i++) await ctx.server.registry.captureNow('tank-cam');
    const s = ctx.server.registry.list()[0];
    assert.equal(s.status, 'OPERATIONAL');
    assert.equal(s.latestAnalysis.classification, 'low_light');
    assert.equal((await ctx.random({ bytes: 32 })).status, 200);
  } finally {
    await ctx.close();
  }
});

test('unreferenced history is bounded; referenced frames survive until the referenced-retention cutoff', async () => {
  let t = 1_700_000_000_000;
  const ctx = await startServer({ now: () => t, retention: { referencedImageMs: 1000, observationMs: 10_000 }, envMaxAgeMs: 100 });
  try {
    await addCamera(ctx, { ...CAMERA_CONFIG, historyCount: 1 });
    await ctx.server.registry.captureNow('tank-cam');
    const pinned = ctx.server.registry.list()[0].latest.observationId;
    ctx.server.registry.markReferenced([{ observationId: pinned }]);
    for (let i = 0; i < 5; i++) { t += 10; await ctx.server.registry.captureNow('tank-cam'); }
    const file = (id) => join(ctx.dir, 'observations', 'tank-cam', `${id}.jpg`);
    assert.ok(existsSync(file(pinned)), 'pinned frame kept');
    const kept = ctx.server.db.prepare('SELECT id FROM observations WHERE referenced = 0 AND image_file IS NOT NULL').all();
    assert.ok(kept.length <= 2, `history bounded, got ${kept.length}`);
    t += 2000;
    await ctx.server.prune();
    assert.ok(!existsSync(file(pinned)), 'pinned frame removed after referenced retention');
    assert.equal((await fetch(`${ctx.base}/observations/tank-cam/${pinned}.jpg`)).status, 404);
    assert.ok(existsSync(join(ctx.dir, 'observations', 'tank-cam', 'latest.jpg')), 'latest.jpg is never pruned');
  } finally {
    await ctx.close();
  }
});

test('ffmpeg capture args include warm-up, framerate and pixel format', () => {
  const args = buildCaptureArgs({ device: '0', width: 1280, height: 720, framerate: '29.97', pixelFormat: 'uyvy422', warmupFrames: 25 }, '/tmp/x.jpg');
  const s = args.join(' ');
  assert.match(s, /-f avfoundation/);
  assert.match(s, /-framerate 29\.97/);
  assert.match(s, /-pixel_format uyvy422/);
  assert.match(s, /-video_size 1280x720/);
  assert.match(s, /-i 0:none/);
  assert.ok(args.includes('select=gte(n\\,25)'));
  assert.match(s, /-frames:v 1/);
  assert.ok(!buildCaptureArgs({ device: 'FaceTime HD Camera', width: 640, height: 480 }, 'o.jpg').includes('-pixel_format'));
});

test('a new adapter type registers and reports without touching the randomness core', async () => {
  const reports = [];
  const thermometer = {
    type: 'thermometer',
    displayName: 'Thermal Measurement Subsystem',
    measurementKind: 'measurement',
    entropyAssessment: 'none',
    configSchema: { units: { type: 'string', default: 'C' } },
    create(source, ctx) {
      return {
        start() {},
        stop() {},
        captureNow: () => ctx.report({ observedAt: Date.now(), kind: 'reading', values: { celsius: 21.5 } }).then(() => reports.push(1)),
      };
    },
  };
  const ctx = await startServer({ extraAdapters: [thermometer] });
  try {
    ctx.server.registry.create({ id: 'basement-temp', name: 'Basement Thermometer', type: 'thermometer', config: {} });
    await ctx.server.registry.captureNow('basement-temp');
    const s = ctx.server.registry.list()[0];
    assert.equal(s.status, 'OPERATIONAL');
    assert.deepEqual(s.latest.values, { celsius: 21.5 });
    const body = await (await ctx.random({ bytes: 16 })).json();
    assert.equal(body.environmentalInput.sources[0].id, 'basement-temp');
    assert.ok(!('imageUrl' in body.environmentalInput.sources[0]), 'non-image sources have no imageUrl');
  } finally {
    await ctx.close();
  }
});

test('source config is validated', async () => {
  const ctx = await startServer();
  try {
    const reg = ctx.server.registry;
    assert.throws(() => reg.create({ name: 'x', type: 'camera', config: { intervalMs: 5 } }), /intervalMs/);
    assert.throws(() => reg.create({ name: 'x', type: 'camera', config: { bogus: 1 } }), /unknown config field/);
    assert.throws(() => reg.create({ name: 'x', type: 'nope' }), /unknown source type/);
    assert.throws(() => reg.create({ name: 'x', type: 'camera', config: { framerate: '30; rm -rf' } }), /framerate/);
    const v = reg.create({ name: 'Window Plant', type: 'camera', enabled: false });
    assert.equal(v.id, 'window-plant');
    assert.equal(v.status, 'DISABLED');
    assert.equal(v.config.subject, 'Unspecified subject');
  } finally {
    await ctx.close();
  }
});
