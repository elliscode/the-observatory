// Random Material Distribution API: POST /api/v1/random.
// Never logs or records the returned material or credentials.

import express from 'express';
import { randomUUID } from 'node:crypto';
import { ALGORITHM, RngUnavailableError } from './core.js';
import { sendError, noStore, clientIp, bodyErrorHandler } from '../web/http.js';

export function createApiStats() {
  // Fixed latency histogram (ms upper bounds) for p50/p95 without storing every sample.
  const bounds = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, Infinity];
  return {
    requestsOk: 0,
    requestsFailed: 0,
    bytesServed: 0,
    authFailures: 0,
    rateLimited: 0,
    withEnvironmental: 0,
    withoutEnvironmental: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    latencyMax: null,
    bounds,
    buckets: new Array(bounds.length).fill(0),
    lastUse: null,
    observeLatency(ms) {
      this.buckets[this.bounds.findIndex((b) => ms <= b)]++;
      this.latencyMax = this.latencyMax === null ? ms : Math.max(this.latencyMax, ms);
    },
    percentile(p) {
      const total = this.buckets.reduce((a, b) => a + b, 0);
      if (!total) return null;
      let seen = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        seen += this.buckets[i];
        if (seen / total >= p) return this.bounds[i] === Infinity ? this.latencyMax : this.bounds[i];
      }
      return this.latencyMax;
    },
  };
}

export function createRandomRouter({
  core, apiKeyAuth, limiters, maxRandomBytes, requireHttps, events, telemetry, log, stats,
  onEnvironmentalUse = () => {},
}) {
  const router = express.Router();

  const fail = (res, code, message, started, headers) => {
    stats.requestsFailed++;
    stats.lastFailureAt = Date.now();
    stats.lastFailureCode = code;
    telemetry.record('random', { count: 0, errors: 1 });
    noStore(res);
    sendError(res, code, message, headers);
  };

  router.post(
    '/random',
    (req, res, next) => {
      req.startedAt = process.hrtime.bigint();
      noStore(res);
      if (requireHttps && !req.secure) return fail(res, 'HTTPS_REQUIRED', 'HTTPS is required', req.startedAt);
      const auth = apiKeyAuth.authenticate(req.headers.authorization);
      if (!auth.ok) {
        stats.authFailures++;
        const ip = clientIp(req);
        const lim = limiters.authFailure.take(ip);
        if (!lim.ok) {
          stats.rateLimited++;
          events.record('ratelimit.exceeded', { level: 'warn', message: 'Rate limit exceeded after repeated authentication failures', data: { scope: 'auth-failure', ip } });
          return fail(res, 'RATE_LIMITED', 'Too many failed authentication attempts', req.startedAt, { 'Retry-After': lim.retryAfterSec });
        }
        events.record('auth.failure', { level: 'warn', message: `Authentication failure (${auth.code})`, data: { ip, code: auth.code } });
        log.warn('auth.failure', { ip, code: auth.code });
        return fail(res, auth.code, auth.code === 'AUTH_REQUIRED' ? 'Missing Authorization: Bearer <key> header' : 'Invalid API key', req.startedAt);
      }
      req.keyId = auth.keyId;
      const lim = limiters.random.take(`key:${auth.keyId}`);
      if (!lim.ok) {
        stats.rateLimited++;
        events.record('ratelimit.exceeded', { level: 'warn', message: `Rate limit exceeded for key "${auth.keyId}"`, data: { scope: 'key', keyId: auth.keyId } });
        return fail(res, 'RATE_LIMITED', 'Rate limit exceeded', req.startedAt, { 'Retry-After': lim.retryAfterSec });
      }
      next();
    },
    express.json({ limit: '1kb', strict: true, verify: (req, res, buf) => { req.rawBodyLength = buf.length; } }),
    (req, res) => {
      if (!req.is('application/json') || req.body === undefined || !req.rawBodyLength) {
        return fail(res, 'INVALID_JSON', 'Content-Type must be application/json with a JSON object body', req.startedAt);
      }
      const body = req.body;
      if (body === null || typeof body !== 'object' || Array.isArray(body)) {
        return fail(res, 'INVALID_JSON', 'Request body must be a JSON object', req.startedAt);
      }
      const unknown = Object.keys(body).filter((k) => k !== 'bytes');
      if (unknown.length) return fail(res, 'UNKNOWN_FIELD', `Unknown field: ${unknown[0].slice(0, 40)}`, req.startedAt);
      const n = body.bytes;
      if (typeof n !== 'number' || !Number.isInteger(n) || n < 1) {
        return fail(res, 'INVALID_BYTES', '"bytes" must be a positive integer', req.startedAt);
      }
      if (n > maxRandomBytes) return fail(res, 'BYTES_TOO_LARGE', `"bytes" must be at most ${maxRandomBytes}`, req.startedAt);

      const requestId = randomUUID();
      let result;
      try {
        result = core.generate(n, requestId);
      } catch (err) {
        const code = err instanceof RngUnavailableError ? 'RNG_UNAVAILABLE' : 'INTERNAL';
        events.record('rng.failure', { level: 'error', message: 'Random material generation failed', data: { code } });
        log.error('rng.failure', { code, error: err });
        return fail(res, code, code === 'RNG_UNAVAILABLE' ? 'Random source unavailable' : 'Internal error', req.startedAt);
      }

      const timestamp = new Date().toISOString();
      const latencyMs = Number(process.hrtime.bigint() - req.startedAt) / 1e6;
      const environmental = result.environmental;
      res.status(200).json({
        requestId,
        bytes: n,
        encoding: 'base64url',
        data: result.data.toString('base64url'),
        algorithm: ALGORITHM,
        environmentalInput: environmental ? { sources: environmental } : null,
        timestamp,
      });

      // Bookkeeping after the response; none of it can affect the material already sent.
      try {
        stats.requestsOk++;
        stats.bytesServed += n;
        stats.lastSuccessAt = Date.now();
        stats.observeLatency(latencyMs);
        if (environmental) stats.withEnvironmental++;
        else stats.withoutEnvironmental++;
        stats.lastUse = { at: timestamp, keyId: req.keyId, observations: environmental };
        telemetry.record('random', { value: latencyMs, bytes: n });
        const obsText = environmental
          ? ` · incorporated ${environmental.map((o) => `observation #${o.observationId} of ${o.name}`).join(', ')}`
          : ' · no fresh environmental observation';
        events.record('random.fulfilled', {
          message: `Random material request fulfilled (${n} bytes, key "${req.keyId}")${obsText}`,
          data: { keyId: req.keyId, bytes: n, latencyMs: Math.round(latencyMs * 100) / 100, observationIds: environmental ? environmental.map((o) => o.observationId) : [] },
        });
        log.info('random.fulfilled', { requestId, keyId: req.keyId, bytes: n, latencyMs });
        if (environmental) onEnvironmentalUse(environmental);
      } catch (err) {
        log.error('random.bookkeeping_failed', { error: err });
      }
    },
  );

  router.use((err, req, res, next) => {
    if (err && !res.headersSent) {
      stats.requestsFailed++;
      stats.lastFailureAt = Date.now();
      telemetry.record('random', { count: 0, errors: 1 });
    }
    bodyErrorHandler(err, req, res, next);
  });
  router.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    log.error('random.unhandled', { error: err });
    noStore(res);
    sendError(res, 'INTERNAL', 'Internal error');
  });

  return router;
}
