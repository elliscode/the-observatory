import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, classifyActivity, boxBlur } from '../server/sources/analysis/frame-diff.js';
import { gradient } from './helpers.js';

const W = 16;
const H = 9;

test('fixed inputs produce reproducible measurements', () => {
  const a = gradient(W, H);
  const b = Uint8Array.from(a);
  for (let i = 0; i < 20; i++) b[i] = 250; // a bright block in the top rows
  const r1 = analyze(a, b, { width: W, height: H, blur: false });
  const r2 = analyze(a, b, { width: W, height: H, blur: false });
  assert.deepEqual(r1, r2);
  assert.equal(r1.histogram.length, 8);
  assert.ok(Math.abs(r1.histogram.reduce((s, v) => s + v, 0) - 1) < 1e-6);
  assert.ok(r1.changedFraction > 0.1 && r1.changedFraction < 0.2, String(r1.changedFraction));
  assert.equal(r1.classification, 'moderate');
  assert.ok(r1.activity > 0 && r1.activity <= 1);
  assert.equal(r1.settings.threshold, 12);
});

test('identical frames are static', () => {
  const a = gradient(W, H);
  const r = analyze(a, Uint8Array.from(a), { width: W, height: H });
  assert.equal(r.meanAbsDiff, 0);
  assert.equal(r.changedFraction, 0);
  assert.equal(r.classification, 'static');
  assert.equal(r.activity, 0);
});

test('an all-black frame is low_light and does not crash', () => {
  const black = new Uint8Array(W * H);
  const r = analyze(black, new Uint8Array(W * H), { width: W, height: H });
  assert.equal(r.classification, 'low_light');
  assert.equal(r.activity, null);
  const r2 = analyze(gradient(W, H), black, { width: W, height: H });
  assert.equal(r2.classification, 'low_light');
});

test('a uniform exposure shift is compensated (near-zero activity)', () => {
  const a = gradient(W, H);
  const b = gradient(W, H, 40);
  const r = analyze(a, b, { width: W, height: H });
  assert.ok(Math.abs(r.exposureShift - 40) < 1);
  assert.ok(r.changedFraction < 0.005, String(r.changedFraction));
  assert.equal(r.classification, 'static');
});

test('geometry changes are a scene discontinuity, not activity', () => {
  const r = analyze(gradient(W, H), gradient(8, 4), { width: W, height: H });
  assert.equal(r.classification, 'scene_discontinuity');
  assert.equal(r.activity, null);
  const r2 = analyze(gradient(W, H), gradient(W, H), {
    width: W, height: H, sourceSizePrev: { width: 1280, height: 720 }, sourceSizeCurr: { width: 640, height: 480 },
  });
  assert.equal(r2.classification, 'scene_discontinuity');
});

test('a replaced scene (nearly every pixel changed, uncorrelated) is a discontinuity', () => {
  const a = gradient(W, H);
  const b = Uint8Array.from(a).reverse(); // anti-correlated structure, same brightness
  const r = analyze(a, b, { width: W, height: H, blur: false });
  assert.ok(r.changedFraction > 0.85, String(r.changedFraction));
  assert.equal(r.classification, 'scene_discontinuity');
});

test('activity thresholds are documented constants', () => {
  assert.equal(classifyActivity(0), 'static');
  assert.equal(classifyActivity(0.004), 'static');
  assert.equal(classifyActivity(0.01), 'low');
  assert.equal(classifyActivity(0.1), 'moderate');
  assert.equal(classifyActivity(0.5), 'high');
});

test('box blur preserves flat regions', () => {
  const flat = new Uint8Array(W * H).fill(100);
  assert.ok(boxBlur(flat, W, H).every((v) => v === 100));
});
