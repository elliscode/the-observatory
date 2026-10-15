import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, addCamera, KEY, KEY2 } from './helpers.js';

const decode = (s) => Buffer.from(s, 'base64url');

test('valid authenticated requests return exactly the requested bytes, fresh each time', async () => {
  const ctx = await startServer({ rateLimits: { random: { perMinute: 1000, burst: 1000 } } });
  try {
    for (const n of [1, 32, 1024]) {
      const r = await ctx.random({ bytes: n });
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.equal(body.bytes, n);
      assert.equal(body.encoding, 'base64url');
      assert.equal(decode(body.data).length, n, 'decoded length equals requested bytes');
      assert.match(body.requestId, /^[0-9a-f-]{36}$/);
      assert.ok(Math.abs(Date.parse(body.timestamp) - Date.now()) < 5000);
      assert.equal(body.algorithm, 'hkdf-sha256(os-csprng-32B, environmental-salt)');
      assert.equal(body.environmentalInput, null);
      assert.match(r.headers.get('cache-control'), /no-store/);
      assert.equal(r.headers.get('pragma'), 'no-cache');
    }
    const seen = new Set();
    const ids = new Set();
    for (let i = 0; i < 100; i++) {
      const body = await (await ctx.random({ bytes: 32 })).json();
      seen.add(body.data);
      ids.add(body.requestId);
    }
    assert.equal(seen.size, 100, '100 requests return 100 distinct values');
    assert.equal(ids.size, 100);
  } finally {
    await ctx.close();
  }
});

test('credentials: missing, malformed, wrong and removed keys are rejected with 401', async () => {
  const ctx = await startServer();
  try {
    const cases = [
      [{ key: null }, 'AUTH_REQUIRED'],
      [{ key: 'nope' }, 'AUTH_INVALID'],
      [{ key: `${KEY}x` }, 'AUTH_INVALID'],
      [{ key: null, headers: { authorization: `Basic ${KEY}` } }, 'AUTH_INVALID'],
    ];
    for (const [opts, code] of cases) {
      const r = await ctx.random({ bytes: 32 }, opts);
      assert.equal(r.status, 401);
      const text = await r.text();
      assert.equal(JSON.parse(text).error.code, code);
      assert.ok(!text.includes(KEY) && !text.includes(KEY2), 'error bodies never echo keys');
    }
    assert.equal((await ctx.random({ bytes: 32 }, { key: KEY2 })).status, 200, 'second configured key works');
  } finally {
    await ctx.close();
  }
  // Rotation: after removing the old key from configuration, it no longer works.
  const rotated = await startServer({ apiKeys: [{ id: 'primary', key: KEY }] });
  try {
    assert.equal((await rotated.random({ bytes: 32 }, { key: KEY2 })).status, 401);
    assert.equal((await rotated.random({ bytes: 32 })).status, 200);
  } finally {
    await rotated.close();
  }
});

test('invalid bodies are rejected with stable error codes', async () => {
  const ctx = await startServer({ rateLimits: { random: { perMinute: 1000, burst: 1000 } } });
  try {
    const cases = [
      [{ bytes: 0 }, 400, 'INVALID_BYTES'],
      [{ bytes: -1 }, 400, 'INVALID_BYTES'],
      [{ bytes: 1.5 }, 400, 'INVALID_BYTES'],
      [{ bytes: '32' }, 400, 'INVALID_BYTES'],
      [{ bytes: null }, 400, 'INVALID_BYTES'],
      [{}, 400, 'INVALID_BYTES'],
      [{ bytes: 1025 }, 400, 'BYTES_TOO_LARGE'],
      [{ bytes: 32, extra: 1 }, 400, 'UNKNOWN_FIELD'],
      [[32], 400, 'INVALID_JSON'],
      ['{"bytes":', 400, 'INVALID_JSON'],
      ['"32"', 400, 'INVALID_JSON'],
      [`{"bytes":32,"pad":"${'x'.repeat(2000)}"}`, 413, 'PAYLOAD_TOO_LARGE'],
    ];
    for (const [body, status, code] of cases) {
      const r = await ctx.random(body);
      assert.equal(r.status, status, JSON.stringify(body).slice(0, 40));
      assert.equal((await r.json()).error.code, code, JSON.stringify(body).slice(0, 40));
      assert.match(r.headers.get('cache-control'), /no-store/);
    }
    const plain = await fetch(`${ctx.base}/api/v1/random`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'text/plain' }, body: '{"bytes":32}' });
    assert.equal(plain.status, 400);
    assert.equal((await plain.json()).error.code, 'INVALID_JSON');
    const noType = await fetch(`${ctx.base}/api/v1/random`, { method: 'POST', headers: { authorization: `Bearer ${KEY}` }, body: new Uint8Array(Buffer.from('{"bytes":32}')) });
    assert.equal((await noType.json()).error.code, 'INVALID_JSON');
    const empty = await fetch(`${ctx.base}/api/v1/random`, { method: 'POST', headers: { authorization: `Bearer ${KEY}`, 'content-type': 'application/json' } });
    assert.equal(empty.status, 400);
    assert.equal((await empty.json()).error.code, 'INVALID_JSON');
  } finally {
    await ctx.close();
  }
});

test('per-key rate limit: 30/min with burst 10, 429 with Retry-After, keys limited independently', async () => {
  const ctx = await startServer();
  try {
    for (let i = 0; i < 10; i++) assert.equal((await ctx.random({ bytes: 8 })).status, 200, `request ${i + 1}`);
    const limited = await ctx.random({ bytes: 8 });
    assert.equal(limited.status, 429);
    assert.equal((await limited.json()).error.code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) >= 1);
    assert.equal((await ctx.random({ bytes: 8 }, { key: KEY2 })).status, 200, 'other key has its own bucket');
  } finally {
    await ctx.close();
  }
});

test('repeated authentication failures are rate limited per IP', async () => {
  const ctx = await startServer();
  try {
    let saw429 = false;
    for (let i = 0; i < 15; i++) {
      const r = await ctx.random({ bytes: 8 }, { key: 'wrong-key' });
      if (r.status === 429) { saw429 = true; break; }
      assert.equal(r.status, 401);
    }
    assert.ok(saw429);
  } finally {
    await ctx.close();
  }
});

test('REQUIRE_HTTPS rejects plain HTTP but accepts HTTPS forwarded by a loopback proxy', async () => {
  const ctx = await startServer({ requireHttps: true });
  try {
    const r = await ctx.random({ bytes: 8 });
    assert.equal(r.status, 403);
    assert.equal((await r.json()).error.code, 'HTTPS_REQUIRED');
    const ok = await ctx.random({ bytes: 8 }, { headers: { 'x-forwarded-proto': 'https' } });
    assert.equal(ok.status, 200);
  } finally {
    await ctx.close();
  }
});

test('with a camera source, responses reference the observation and pin its frame', async () => {
  const ctx = await startServer();
  try {
    await addCamera(ctx);
    await ctx.server.registry.captureNow('tank-cam');
    const body = await (await ctx.random({ bytes: 32 })).json();
    assert.equal(body.environmentalInput.sources.length, 1);
    const src = body.environmentalInput.sources[0];
    assert.equal(src.id, 'tank-cam');
    assert.equal(src.name, 'Aquarium Camera');
    assert.ok(Number.isInteger(src.observationId));
    assert.equal(src.imageUrl, `/observations/tank-cam/${src.observationId}.jpg`);
    assert.ok(!('digest' in src) && !('salt' in src));
    const img = await fetch(ctx.base + src.imageUrl);
    assert.equal(img.status, 200);
    assert.match(img.headers.get('content-type'), /image\/jpeg/);
    const row = ctx.server.db.prepare('SELECT referenced FROM observations WHERE id = ?').get(src.observationId);
    assert.equal(row.referenced, 1);
    // historyCount is 2: after many more captures the pinned frame is still served.
    for (let i = 0; i < 6; i++) await ctx.server.registry.captureNow('tank-cam');
    assert.equal((await fetch(ctx.base + src.imageUrl)).status, 200, 'referenced frame survives history pruning');
    const unreferenced = ctx.server.db.prepare('SELECT COUNT(*) AS n FROM observations WHERE source_id = ? AND referenced = 0 AND image_file IS NOT NULL').get('tank-cam').n;
    assert.ok(unreferenced <= 3, `unreferenced images bounded (got ${unreferenced})`);
  } finally {
    await ctx.close();
  }
});
