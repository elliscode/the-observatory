// Public routes: dashboard page, /api/v1/health, /api/v1/status, and observation images.
// Nothing here exposes credentials, random material, digests or filesystem paths.

import express from 'express';
import { existsSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { SOURCE_ID } from '../sources/registry.js';
import { RANDOM_SOURCE, ALGORITHM } from '../randomness/core.js';
import { sendError, noStore, clientIp } from './http.js';
import { renderDashboardPage } from './dashboard.js';

export function createPublicRouter({ getStatus, core, registry, publicLimiter, requireHttps, baseUrl, observationsRoot, version }) {
  const router = express.Router();

  const limit = (req, res, next) => {
    const r = publicLimiter.take(`ip:${clientIp(req)}`);
    if (!r.ok) {
      noStore(res);
      return sendError(res, 'RATE_LIMITED', 'Rate limit exceeded', { 'Retry-After': r.retryAfterSec });
    }
    next();
  };
  const https = (req, res, next) => (requireHttps && !req.secure ? sendError(res, 'HTTPS_REQUIRED', 'HTTPS is required') : next());

  router.get('/', limit, (req, res) => {
    res.set('Cache-Control', 'no-cache');
    res.type('html').send(renderDashboardPage({ status: getStatus(), base: baseUrl(req) }));
  });

  router.get('/api/v1/health', https, limit, (req, res) => {
    noStore(res);
    const rng = core.status();
    const summary = registry.summary();
    const status = rng.status === 'OPERATIONAL' ? 'ok' : rng.status === 'DEGRADED' ? 'degraded' : 'unavailable';
    res.status(status === 'unavailable' ? 503 : 200).json({
      status,
      service: 'the-observatory',
      version,
      randomSource: RANDOM_SOURCE,
      algorithm: ALGORITHM,
      rng: { status: rng.status.toLowerCase() },
      camera: summary.camera,
      sources: summary.sources,
      timestamp: new Date().toISOString(),
    });
  });

  router.get('/api/v1/status', https, limit, (req, res) => {
    noStore(res);
    res.json(getStatus());
  });

  // /observations/<sourceId>/latest.jpg and /observations/<sourceId>/<observationId>.jpg
  router.get('/observations/:sourceId/:file', (req, res) => {
    const { sourceId, file } = req.params;
    if (!SOURCE_ID.test(sourceId)) return sendError(res, 'NOT_FOUND', 'Not found');
    let path;
    if (file === 'latest.jpg') {
      path = join(observationsRoot, sourceId, 'latest.jpg');
      res.set('Cache-Control', 'no-cache');
    } else {
      const m = /^(\d{1,15})\.jpg$/.exec(file);
      if (!m) return sendError(res, 'NOT_FOUND', 'Not found');
      const row = registry.imageRow(sourceId, Number(m[1]));
      if (!row) return sendError(res, 'NOT_FOUND', 'Not found');
      path = join(observationsRoot, sourceId, `${row.id}.jpg`);
      res.set('Cache-Control', 'public, max-age=86400, immutable');
    }
    const full = resolve(path);
    if (!full.startsWith(resolve(observationsRoot) + sep) || !existsSync(full)) return sendError(res, 'NOT_FOUND', 'Not found');
    res.type('jpeg');
    res.sendFile(full, { dotfiles: 'deny' }, (err) => {
      if (err && !res.headersSent) sendError(res, 'NOT_FOUND', 'Not found');
    });
  });

  return router;
}
