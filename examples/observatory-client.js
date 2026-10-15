// Reference server-to-server client for The Observatory's random-material API.
// Copy this into a consuming application's backend. It never runs in a browser: the API key must
// stay server-side.
//
//   import { createObservatoryClient } from './observatory-client.js';
//   const client = createObservatoryClient({
//     baseUrl: process.env.OBSERVATORY_URL,        // https://observatory.elliscode.com/api/v1
//     apiKey: process.env.OBSERVATORY_API_KEY,
//     timeoutMs: Number(process.env.OBSERVATORY_TIMEOUT_MS) || 5000,
//   });
//   const seed = await client.fetchSeed();         // { bytes: Buffer(32), requestId, environmentalInput, ... }
//
// Retry policy: at most `maxRetries` retries (default 2) with jittered exponential backoff, only for
// network errors, timeouts, 429 and 5xx. Worst case with defaults stays well under a 60 s polling
// cycle; if a cycle fails, give up until the next tick instead of retrying indefinitely.

import { randomInt } from 'node:crypto';

export class ObservatoryError extends Error {
  constructor(code, message, { status = null, retryable = false } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

const BASE64URL = /^[A-Za-z0-9_-]*$/;

// Validates a /random response body and returns the decoded bytes.
export function validateRandomResponse(body, requested) {
  const bad = (why) => new ObservatoryError('INVALID_RESPONSE', `Invalid response from The Observatory: ${why}`);
  if (!body || typeof body !== 'object') throw bad('not a JSON object');
  if (typeof body.requestId !== 'string' || !body.requestId) throw bad('missing requestId');
  if (body.encoding !== 'base64url') throw bad(`unexpected encoding "${body.encoding}"`);
  if (body.bytes !== requested) throw bad(`bytes field is ${body.bytes}, expected ${requested}`);
  if (typeof body.data !== 'string' || !BASE64URL.test(body.data)) throw bad('data is not base64url');
  const bytes = Buffer.from(body.data, 'base64url');
  if (bytes.length !== requested) throw bad(`decoded ${bytes.length} bytes, expected ${requested}`);
  if (typeof body.timestamp !== 'string' || Number.isNaN(Date.parse(body.timestamp))) throw bad('invalid timestamp');
  if (body.environmentalInput !== null && (typeof body.environmentalInput !== 'object' || !Array.isArray(body.environmentalInput.sources))) {
    throw bad('invalid environmentalInput');
  }
  return bytes;
}

export function createObservatoryClient({
  baseUrl = process.env.OBSERVATORY_URL || 'https://observatory.elliscode.com/api/v1',
  apiKey = process.env.OBSERVATORY_API_KEY,
  timeoutMs = 5000,
  maxRetries = 2,
  backoffMs = 500,
  maxRetryAfterMs = 10_000,
  fetchImpl = globalThis.fetch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (!apiKey) throw new Error('OBSERVATORY_API_KEY is required');
  const base = baseUrl.replace(/\/+$/, '');

  async function attempt(n) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${base}/random`, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ bytes: n }),
        signal: controller.signal,
        cache: 'no-store',
      });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new ObservatoryError('TIMEOUT', `No response within ${timeoutMs} ms`, { retryable: true });
      throw new ObservatoryError('NETWORK_ERROR', `Network error: ${err.message}`, { retryable: true });
    }
    let body;
    try {
      body = await res.json();
    } catch {
      clearTimeout(timer);
      if (controller.signal.aborted) throw new ObservatoryError('TIMEOUT', `No response within ${timeoutMs} ms`, { retryable: true });
      throw new ObservatoryError('INVALID_RESPONSE', `Non-JSON response (HTTP ${res.status})`, { status: res.status, retryable: res.status >= 500 });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) {
      const code = body?.error?.code || `HTTP_${res.status}`;
      const err = new ObservatoryError(code, body?.error?.message || `HTTP ${res.status}`, { status: res.status, retryable: res.status === 429 || res.status >= 500 });
      const ra = Number(res.headers.get('retry-after'));
      if (res.status === 429 && Number.isFinite(ra)) err.retryAfterMs = ra * 1000;
      throw err;
    }
    const bytes = validateRandomResponse(body, n);
    return { requestId: body.requestId, bytes, algorithm: body.algorithm, environmentalInput: body.environmentalInput, timestamp: body.timestamp };
  }

  async function fetchRandom(n = 32) {
    if (!Number.isInteger(n) || n < 1) throw new RangeError('n must be a positive integer');
    let lastErr;
    for (let i = 0; i <= maxRetries; i++) {
      try {
        return await attempt(n);
      } catch (err) {
        lastErr = err;
        if (!(err instanceof ObservatoryError) || !err.retryable || i === maxRetries) throw err;
        if (err.retryAfterMs !== undefined && err.retryAfterMs > maxRetryAfterMs) throw err;
        const backoff = backoffMs * 2 ** i;
        const wait = Math.max(err.retryAfterMs ?? 0, backoff / 2 + randomInt(Math.max(1, Math.floor(backoff / 2))));
        await sleep(wait);
      }
    }
    throw lastErr;
  }

  return { fetchRandom, fetchSeed: () => fetchRandom(32) };
}

// CLI: node examples/observatory-client.js  (uses OBSERVATORY_URL / OBSERVATORY_API_KEY)
// Prints metadata only; the random material itself is never printed.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const client = createObservatoryClient();
  client.fetchSeed().then(
    (r) => console.log(JSON.stringify({ requestId: r.requestId, bytes: r.bytes.length, algorithm: r.algorithm, environmentalInput: r.environmentalInput, timestamp: r.timestamp }, null, 2)),
    (err) => { console.error(`${err.code || 'ERROR'}: ${err.message}`); process.exit(1); },
  );
}
