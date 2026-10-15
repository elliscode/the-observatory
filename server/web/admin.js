// Source-management administration. Disabled (404) unless ADMIN_PASSWORD is set.
// Every route needs the signed admin cookie; state-changing routes also need a same-origin Origin header.

import express from 'express';
import { ADMIN_COOKIE } from '../auth.js';
import { SourceError } from '../sources/registry.js';
import { sendError, noStore, clientIp, bodyErrorHandler } from './http.js';

export function createAdminRouter({ adminAuth, registry, events, secureCookies, expectedOrigin, adminPage, loginLimiter, log }) {
  const router = express.Router();
  const json = express.json({ limit: '16kb' });

  if (!adminAuth) {
    router.use('/admin', (req, res) => sendError(res, 'NOT_FOUND', 'Not found'));
    return router;
  }

  const sameOrigin = (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    if (req.headers.origin !== expectedOrigin(req)) return sendError(res, 'FORBIDDEN', 'Cross-origin request rejected');
    next();
  };
  const requireAdmin = (req, res, next) => (adminAuth.isAdmin(req) ? next() : sendError(res, 'AUTH_REQUIRED', 'Administrator login required'));
  const handle = (fn) => async (req, res) => {
    noStore(res);
    try {
      const out = await fn(req, res);
      if (out !== undefined) res.json(out);
    } catch (err) {
      if (err instanceof SourceError) return res.status(err.status).json({ error: { code: err.status === 404 ? 'NOT_FOUND' : 'INVALID_REQUEST', message: err.message } });
      log.error('admin.error', { error: err });
      sendError(res, 'INTERNAL', 'Internal error');
    }
  };

  router.get('/admin', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.type('html').send(adminPage());
  });

  router.use('/admin/api', sameOrigin);

  router.post('/admin/api/login', json, async (req, res) => {
    noStore(res);
    const lim = loginLimiter.take(`ip:${clientIp(req)}`);
    if (!lim.ok) return sendError(res, 'RATE_LIMITED', 'Too many login attempts', { 'Retry-After': lim.retryAfterSec });
    if (!adminAuth.checkPassword(req.body?.password)) {
      events.record('auth.failure', { level: 'warn', message: 'Administrator login failed', data: { ip: clientIp(req), scope: 'admin' } });
      await new Promise((r) => setTimeout(r, 600));
      return sendError(res, 'AUTH_INVALID', 'Wrong password');
    }
    res.cookie(ADMIN_COOKIE, adminAuth.issueToken(), {
      httpOnly: true, sameSite: 'strict', secure: secureCookies, maxAge: adminAuth.cookieMaxAgeMs, path: '/',
    });
    res.json({ ok: true });
  });
  router.post('/admin/api/logout', (req, res) => {
    noStore(res);
    res.clearCookie(ADMIN_COOKIE, { path: '/' });
    res.json({ ok: true });
  });
  router.get('/admin/api/me', (req, res) => {
    noStore(res);
    res.json({ admin: adminAuth.isAdmin(req) });
  });

  router.get('/admin/api/adapters', requireAdmin, handle(() => ({ adapters: registry.adapterCatalogue() })));
  router.get('/admin/api/sources', requireAdmin, handle(() => ({ sources: registry.list() })));
  router.get('/admin/api/sources/:id', requireAdmin, handle((req) => {
    const rt = registry.get(req.params.id);
    return { source: registry.view(rt), recentErrors: registry.recentErrors(rt.id) };
  }));
  router.post('/admin/api/sources', requireAdmin, json, handle((req, res) => {
    const view = registry.create(req.body || {});
    res.status(201);
    return { source: view };
  }));
  router.patch('/admin/api/sources/:id', requireAdmin, json, handle((req) => ({ source: registry.update(req.params.id, req.body || {}) })));
  router.delete('/admin/api/sources/:id', requireAdmin, handle((req) => {
    registry.remove(req.params.id);
    return { ok: true };
  }));
  router.post('/admin/api/sources/:id/capture', requireAdmin, handle(async (req) => ({ source: await registry.captureNow(req.params.id) })));

  router.use('/admin/api', bodyErrorHandler);
  return router;
}
