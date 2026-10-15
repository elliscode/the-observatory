import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hkdfSync, randomBytes } from 'node:crypto';
import { createRandomnessCore, RngUnavailableError } from '../server/randomness/core.js';
import { createConditioningBoundary, observationDigest } from '../server/conditioning/boundary.js';
import { startServer, addCamera, ROOT } from './helpers.js';

const fixedIkm = Buffer.alloc(32, 7);
const salt = (b) => ({ salt: Buffer.alloc(32, b), observations: [{ id: 's', name: 'S', observationId: 1, observedAt: new Date(0).toISOString() }] });

function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

test('the core draws its key material from the injected OS randomBytes', () => {
  const calls = [];
  const core = createRandomnessCore({ randomBytes: (n) => { calls.push(n); return randomBytes(n); } });
  core.generate(64, 'r1');
  assert.deepEqual(calls, [32]);
});

test('no Math.random anywhere in server code', () => {
  for (const file of walk(join(ROOT, 'server')).filter((f) => f.endsWith('.js'))) {
    assert.ok(!/Math\.random/.test(readFileSync(file, 'utf8')), `${file} uses Math.random`);
  }
});

test('the randomness core imports nothing from sources, conditioning or the database', () => {
  for (const f of ['core.js']) {
    const src = readFileSync(join(ROOT, 'server', 'randomness', f), 'utf8');
    const imports = [...src.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    assert.deepEqual(imports, ['node:crypto']);
  }
});

test('mixing: the salt changes the output; same inputs give the same output (proves the salt is used)', () => {
  const mk = (b) => createRandomnessCore({ randomBytes: () => Buffer.from(fixedIkm), getEnvironmentalSalt: () => salt(b) });
  const a = mk(1).generate(32, 'req').data;
  const a2 = mk(1).generate(32, 'req').data;
  const b = mk(2).generate(32, 'req').data;
  assert.deepEqual(a, a2);
  assert.notDeepEqual(a, b);
  const none = createRandomnessCore({ randomBytes: () => Buffer.from(fixedIkm) }).generate(32, 'req').data;
  assert.notDeepEqual(a, none);
});

test('mixing: known-answer check against crypto.hkdfSync', () => {
  const core = createRandomnessCore({ randomBytes: () => Buffer.from(fixedIkm), getEnvironmentalSalt: () => salt(9) });
  const out = core.generate(48, 'abc').data;
  const expected = Buffer.from(hkdfSync('sha256', fixedIkm, Buffer.alloc(32, 9), 'observatory/v1/random:abc', 48));
  assert.ok(Buffer.isBuffer(out));
  assert.deepEqual(out, expected);
  const noSalt = createRandomnessCore({ randomBytes: () => Buffer.from(fixedIkm) }).generate(16, 'abc').data;
  assert.deepEqual(noSalt, Buffer.from(hkdfSync('sha256', fixedIkm, Buffer.alloc(0), 'observatory/v1/random:abc', 16)));
});

test('real randomBytes with a constant salt still gives distinct outputs; exact lengths up to the max', () => {
  const core = createRandomnessCore({ getEnvironmentalSalt: () => salt(3) });
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(core.generate(32, 'same-context').data.toString('hex'));
  assert.equal(seen.size, 200);
  for (const n of [1, 31, 32, 33, 1024, 8160]) assert.equal(core.generate(n, 'x').data.length, n);
  assert.throws(() => core.generate(8161, 'x'), RangeError);
});

test('a throwing or malformed salt provider falls back to an empty salt, never to weaker randomness', () => {
  for (const provider of [() => { throw new Error('boom'); }, () => ({ salt: 'nope', observations: [] }), () => ({ salt: Buffer.alloc(5), observations: [] })]) {
    const core = createRandomnessCore({ randomBytes: () => Buffer.from(fixedIkm), getEnvironmentalSalt: provider });
    const r = core.generate(16, 'abc');
    assert.equal(r.environmental, null);
    assert.deepEqual(r.data, Buffer.from(hkdfSync('sha256', fixedIkm, Buffer.alloc(0), 'observatory/v1/random:abc', 16)));
  }
});

test('if the OS random source fails, generation fails: no fallback output', () => {
  const core = createRandomnessCore({ randomBytes: () => { throw new Error('entropy source offline'); } });
  assert.equal(core.selfTest().ok, false);
  assert.equal(core.status().status, 'UNAVAILABLE');
  assert.throws(() => core.generate(32, 'x'), RngUnavailableError);
  const short = createRandomnessCore({ randomBytes: () => Buffer.alloc(16) });
  assert.throws(() => short.generate(32, 'x'), RngUnavailableError);
});

test('RNG failure over HTTP returns 503 RNG_UNAVAILABLE and no data', async () => {
  const ctx = await startServer({ randomBytes: () => { throw new Error('offline'); } });
  try {
    const r = await ctx.random({ bytes: 32 });
    assert.equal(r.status, 503);
    const body = await r.json();
    assert.deepEqual(Object.keys(body), ['error']);
    assert.equal(body.error.code, 'RNG_UNAVAILABLE');
    const health = await fetch(`${ctx.base}/api/v1/health`);
    assert.equal(health.status, 503);
    assert.equal((await health.json()).status, 'unavailable');
  } finally {
    await ctx.close();
  }
});

test('frozen clock and no source updates: repeated /random calls are still distinct', async () => {
  const ctx = await startServer({ now: () => 1_700_000_000_000 });
  try {
    await addCamera(ctx);
    await ctx.server.registry.captureNow('tank-cam');
    const a = await (await ctx.random({ bytes: 32 })).json();
    const b = await (await ctx.random({ bytes: 32 })).json();
    assert.equal(a.environmentalInput.sources[0].observationId, b.environmentalInput.sources[0].observationId, 'same observation mixed in');
    assert.notEqual(a.data, b.data);
  } finally {
    await ctx.close();
  }
});

test('camera failures and conditioning failures do not affect /random', async () => {
  const ctx = await startServer();
  try {
    await addCamera(ctx);
    ctx.cam.mode = 'fail';
    for (let i = 0; i < 4; i++) await ctx.server.registry.captureNow('tank-cam');
    assert.equal(ctx.server.registry.list()[0].status, 'UNAVAILABLE');
    const r = await ctx.random({ bytes: 32 });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).environmentalInput, null);
    // Break the boundary entirely.
    ctx.server.boundary.currentSalt = () => { throw new Error('conditioning exploded'); };
    const r2 = await ctx.random({ bytes: 32 });
    assert.equal(r2.status, 200);
    const body = await r2.json();
    assert.equal(Buffer.from(body.data, 'base64url').length, 32);
    assert.equal(body.environmentalInput, null);
    // Referencing observations failing must not affect the response either.
    ctx.server.registry.markReferenced = () => { throw new Error('db down'); };
    assert.equal((await ctx.random({ bytes: 32 })).status, 200);
  } finally {
    await ctx.close();
  }
});

test('boundary: stale digests are excluded; digest encoding is length-prefixed', () => {
  let t = 1_000_000;
  const boundary = createConditioningBoundary({ now: () => t, maxAgeMs: 60_000 });
  boundary.submit({ sourceId: 'cam', sourceName: 'Cam', observationId: 5, observedAt: t, digest: Buffer.alloc(32, 1) });
  assert.ok(boundary.currentSalt());
  t += 60_001;
  assert.equal(boundary.currentSalt(), null, 'stale observation is not claimed as fresh input');

  const d1 = observationDigest({ sourceId: 'ab', observedAt: 1, payload: Buffer.from('1') });
  const d2 = observationDigest({ sourceId: 'a', observedAt: 1, payload: Buffer.from('b1') });
  assert.notDeepEqual(d1, d2);
  const d3 = observationDigest({ sourceId: 'ab', observedAt: 1, payload: Buffer.from('1') });
  assert.deepEqual(d1, d3);
  assert.equal(d1.length, 32);
});

test('boundary: salt combines sources in sorted order and is independent of submission order', () => {
  const mk = (order) => {
    const b = createConditioningBoundary({ now: () => 10 });
    for (const id of order) b.submit({ sourceId: id, sourceName: id, observationId: id.length, observedAt: 10, digest: Buffer.alloc(32, id.charCodeAt(0)) });
    return b.currentSalt();
  };
  const x = mk(['b', 'a']);
  const y = mk(['a', 'b']);
  assert.deepEqual(x.salt, y.salt);
  assert.deepEqual(x.observations.map((o) => o.id), ['a', 'b']);
});
