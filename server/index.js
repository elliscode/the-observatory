import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { openDb, setMeta, getMeta } from './db.js';
import { loadConfig, validateApiKeys, ConfigError, HKDF_SHA256_MAX_BYTES } from './config.js';
import { createLogger } from './log.js';
import { createIntegrityMonitor } from './integrity.js';
import { EventLog } from './events.js';
import { Telemetry } from './telemetry.js';
import { createRateLimiter } from './ratelimit.js';
import { createApiKeyAuth, createAdminAuth } from './auth.js';
import { createRandomnessCore } from './randomness/core.js';
import { createRandomRouter, createApiStats } from './randomness/routes.js';
import { createConditioningBoundary } from './conditioning/boundary.js';
import { SourceRegistry } from './sources/registry.js';
import { defaultAdapters } from './sources/adapters/index.js';
import { buildStatus } from './web/status.js';
import { createPublicRouter } from './web/routes.js';
import { createAdminRouter } from './web/admin.js';
import { sendError } from './web/http.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

export function createServer({
  dataDir = join(ROOT, 'data'),
  dbFile,
  staticDir = join(ROOT, 'static'),
  clientDir = join(ROOT, 'client'),
  apiKeys = [],
  maxRandomBytes = 1024,
  requireHttps = false,
  publicUrl = null,
  rateLimits = {},
  adminPassword = null,
  sessionSecret = null,
  secureCookies = false,
  envMaxAgeMs = 10 * 60 * 1000,
  retention = {},
  adapters = null,
  seedCamera = null,
  ffmpegPath = 'ffmpeg',
  randomBytes,
  logger = null,
  logLevel = 'info',
  now = Date.now,
  startSources = true,
  timers = true,
} = {}) {
  validateApiKeys(apiKeys);
  if (!Number.isInteger(maxRandomBytes) || maxRandomBytes < 1 || maxRandomBytes > HKDF_SHA256_MAX_BYTES) {
    throw new ConfigError(`maxRandomBytes must be between 1 and ${HKDF_SHA256_MAX_BYTES}`);
  }
  const log = logger || createLogger({ level: logLevel });
  const limits = {
    random: { perMinute: 30, burst: 10, ...rateLimits.random },
    public: { perMinute: 120, burst: 60, ...rateLimits.public },
    authFailure: { perMinute: 10, burst: 10, ...rateLimits.authFailure },
  };
  const ret = {
    observationMs: 7 * 864e5, referencedImageMs: 7 * 864e5, eventMs: 30 * 864e5,
    eventMaxRows: 20000, routineEventMaxRows: 2000, telemetryMs: 30 * 864e5, ...retention,
  };

  const db = openDb(dbFile ?? join(dataDir, 'observatory.sqlite'));
  const integrity = createIntegrityMonitor({ now });
  const events = new EventLog({ db, now, integrity });
  const telemetry = new Telemetry({ db, now, integrity });
  const boundary = createConditioningBoundary({ now, maxAgeMs: envMaxAgeMs });
  const registry = new SourceRegistry({
    db, adapters: adapters || defaultAdapters({ ffmpegPath }), events, telemetry, boundary, dataDir, log, integrity, now, retention: ret,
  });

  // The randomness core sees only an injected salt provider: no registry, database or filesystem.
  const core = createRandomnessCore({
    ...(randomBytes ? { randomBytes } : {}),
    getEnvironmentalSalt: () => boundary.currentSalt(),
    now,
  });
  const selfTest = core.selfTest();
  if (!selfTest.ok) log.error('rng.self_test_failed', { error: selfTest.error });

  const stats = createApiStats();
  const limiters = {
    random: createRateLimiter({ ...limits.random, now }),
    authFailure: createRateLimiter({ ...limits.authFailure, now }),
    public: createRateLimiter({ ...limits.public, now }),
    adminLogin: createRateLimiter({ perMinute: 10, burst: 5, now }),
  };

  const baseUrl = (req) => (publicUrl ? publicUrl.replace(/\/+$/, '') : `${req.protocol}://${req.get('host')}`);
  const getStatus = () => buildStatus({
    core, stats, registry, boundary, events, telemetry, integrity,
    apiConfigured: apiKeys.length > 0, maxRandomBytes, now: now(),
  });

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.set('X-Frame-Options', 'DENY');
    next();
  });

  app.use('/api/v1', createRandomRouter({
    core, apiKeyAuth: createApiKeyAuth(apiKeys), limiters, maxRandomBytes, requireHttps, events, telemetry, log, stats,
    onEnvironmentalUse: (observations) => registry.markReferenced(observations),
  }));
  app.use(createPublicRouter({
    getStatus, core, registry, publicLimiter: limiters.public, requireHttps, baseUrl,
    observationsRoot: registry.root, version: VERSION,
  }));
  app.use(createAdminRouter({
    adminAuth: adminPassword ? createAdminAuth({ password: adminPassword, secret: sessionSecret, now }) : null,
    registry, events, secureCookies, log,
    loginLimiter: limiters.adminLogin,
    expectedOrigin: (req) => (publicUrl ? new URL(publicUrl).origin : `${req.protocol}://${req.get('host')}`),
    adminPage: () => readFileSync(join(clientDir, 'admin.html'), 'utf8'),
  }));
  app.use('/static', express.static(staticDir, { maxAge: '1h', index: false }));
  app.use('/assets', express.static(clientDir, { maxAge: '5m', index: false }));
  app.use('/api', (req, res) => sendError(res, 'NOT_FOUND', 'Not found'));
  app.use((req, res) => sendError(res, 'NOT_FOUND', 'Not found'));
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    log.error('http.unhandled', { error: err });
    sendError(res, 'INTERNAL', 'Internal error');
  });

  // Startup bookkeeping. Restarts never depend on a camera or sensor being available.
  const previousStart = (() => { try { return getMeta(db, 'last_start'); } catch { return null; } })();
  try { setMeta(db, 'last_start', now()); } catch (err) { integrity.dbError(err); }
  events.record(previousStart ? 'service.restarted' : 'service.started', {
    message: `The Observatory ${previousStart ? 'restarted' : 'started'} (v${VERSION}); random-number self-test ${selfTest.ok ? 'passed' : 'FAILED'}`,
  });
  telemetry.heartbeat();

  try {
    registry.init({ start: startSources });
    if (seedCamera && registry.list().length === 0) {
      registry.create({ id: 'camera-1', name: 'Primary Optical Instrument', type: 'camera', config: { device: seedCamera.device, subject: seedCamera.subject } });
    }
  } catch (err) {
    log.error('sources.init_failed', { error: err });
    events.record('sources.init_failed', { level: 'error', message: `Observation sources failed to initialize: ${err.message}` });
  }

  const intervals = [];
  const runPrune = async () => {
    try {
      await registry.prune();
      events.prune({ maxAgeMs: ret.eventMs, maxRows: ret.eventMaxRows, routineMaxRows: ret.routineEventMaxRows });
      telemetry.prune(ret.telemetryMs);
    } catch (err) {
      integrity.dbError(err);
      log.error('prune.failed', { error: err });
    }
  };
  if (timers) {
    intervals.push(setInterval(() => { telemetry.heartbeat(); telemetry.flush(); }, 60_000));
    intervals.push(setInterval(runPrune, 10 * 60_000));
    for (const i of intervals) i.unref();
  }

  const httpServer = createHttpServer(app);
  return {
    app, httpServer, db, core, registry, boundary, events, telemetry, stats, getStatus, prune: runPrune,
    async close() {
      for (const i of intervals) clearInterval(i);
      registry.stopAll();
      telemetry.flush();
      await new Promise((r) => (httpServer.listening ? httpServer.close(() => r()) : r()));
      db.close();
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    console.error(`Configuration error: ${err.message}`);
    process.exit(1);
  }
  if (!config.apiKeys.length) console.warn('No OBSERVATORY_API_KEYS configured: POST /api/v1/random will reject every request.');
  const server = createServer(config);
  server.httpServer.listen(config.port, config.host, () => {
    console.log(JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'listening', url: `http://${config.host}:${config.port}`, publicUrl: config.publicUrl }));
  });
  const shutdown = () => server.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
