import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { createObservatoryClient, ObservatoryError } from '../examples/observatory-client.js';
import { startServer, KEY } from './helpers.js';

const noSleep = async () => {};

async function stub(handler) {
  let hits = 0;
  const server = createHttpServer((req, res) => { hits++; handler(req, res, hits); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}/api/v1`,
    hits: () => hits,
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}

const json = (res, status, body, headers = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

test('reference client: successful authenticated request against the real server', async () => {
  const ctx = await startServer();
  try {
    const client = createObservatoryClient({ baseUrl: `${ctx.base}/api/v1`, apiKey: KEY });
    const seed = await client.fetchSeed();
    assert.ok(Buffer.isBuffer(seed.bytes));
    assert.equal(seed.bytes.length, 32);
    assert.match(seed.requestId, /^[0-9a-f-]{36}$/);
    const other = await client.fetchRandom(100);
    assert.equal(other.bytes.length, 100);
    const wrong = createObservatoryClient({ baseUrl: `${ctx.base}/api/v1`, apiKey: 'x'.repeat(40), sleep: noSleep });
    await assert.rejects(wrong.fetchSeed(), (e) => e instanceof ObservatoryError && e.code === 'AUTH_INVALID' && e.status === 401);
    await assert.rejects(client.fetchRandom(5000), (e) => e.code === 'BYTES_TOO_LARGE');
  } finally {
    await ctx.close();
  }
});

test('reference client: invalid responses are rejected and not retried', async () => {
  const bodies = [
    { requestId: 'r', bytes: 32, encoding: 'base64url', data: Buffer.alloc(31).toString('base64url'), timestamp: new Date().toISOString(), environmentalInput: null },
    { requestId: 'r', bytes: 32, encoding: 'hex', data: 'ab', timestamp: new Date().toISOString(), environmentalInput: null },
    { requestId: 'r', bytes: 32, encoding: 'base64url', data: '!!!', timestamp: new Date().toISOString(), environmentalInput: null },
    { bytes: 32 },
  ];
  for (const body of bodies) {
    const s = await stub((req, res) => json(res, 200, body));
    try {
      const client = createObservatoryClient({ baseUrl: s.url, apiKey: KEY, sleep: noSleep });
      await assert.rejects(client.fetchSeed(), (e) => e.code === 'INVALID_RESPONSE');
      assert.equal(s.hits(), 1);
    } finally {
      await s.close();
    }
  }
  const s = await stub((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>'); });
  try {
    await assert.rejects(createObservatoryClient({ baseUrl: s.url, apiKey: KEY, sleep: noSleep }).fetchSeed(), (e) => e.code === 'INVALID_RESPONSE');
  } finally {
    await s.close();
  }
});

test('reference client: 429 and 503 are retried a bounded number of times', async () => {
  const s = await stub((req, res) => json(res, 503, { error: { code: 'RNG_UNAVAILABLE', message: 'x' } }));
  try {
    const client = createObservatoryClient({ baseUrl: s.url, apiKey: KEY, maxRetries: 2, sleep: noSleep });
    await assert.rejects(client.fetchSeed(), (e) => e.code === 'RNG_UNAVAILABLE' && e.status === 503);
    assert.equal(s.hits(), 3, 'one attempt + two retries, then give up');
  } finally {
    await s.close();
  }
  const waits = [];
  const ok = { requestId: 'r', bytes: 32, encoding: 'base64url', data: Buffer.alloc(32, 1).toString('base64url'), timestamp: new Date().toISOString(), environmentalInput: null };
  const s2 = await stub((req, res, n) => (n === 1 ? json(res, 429, { error: { code: 'RATE_LIMITED', message: 'slow down' } }, { 'retry-after': '2' }) : json(res, 200, ok)));
  try {
    const client = createObservatoryClient({ baseUrl: s2.url, apiKey: KEY, sleep: async (ms) => waits.push(ms) });
    const r = await client.fetchSeed();
    assert.equal(r.bytes.length, 32);
    assert.ok(waits[0] >= 2000, 'honours Retry-After');
  } finally {
    await s2.close();
  }
  const s3 = await stub((req, res) => json(res, 429, { error: { code: 'RATE_LIMITED', message: 'x' } }, { 'retry-after': '60' }));
  try {
    const client = createObservatoryClient({ baseUrl: s3.url, apiKey: KEY, sleep: noSleep });
    await assert.rejects(client.fetchSeed(), (e) => e.code === 'RATE_LIMITED');
    assert.equal(s3.hits(), 1, 'a long Retry-After ends the cycle instead of waiting');
  } finally {
    await s3.close();
  }
});

test('reference client: timeouts and network failures', async () => {
  const s = await stub(() => { /* never responds */ });
  try {
    const client = createObservatoryClient({ baseUrl: s.url, apiKey: KEY, timeoutMs: 100, maxRetries: 1, sleep: noSleep });
    const t = Date.now();
    await assert.rejects(client.fetchSeed(), (e) => e.code === 'TIMEOUT');
    assert.ok(Date.now() - t < 2000);
    assert.equal(s.hits(), 2);
  } finally {
    await s.close();
  }
  const dead = createObservatoryClient({ baseUrl: 'http://127.0.0.1:9/api/v1', apiKey: KEY, maxRetries: 0, sleep: noSleep });
  await assert.rejects(dead.fetchSeed(), (e) => e.code === 'NETWORK_ERROR');
});
