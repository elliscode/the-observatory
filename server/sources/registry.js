// Observation Source Registry: owns source configuration, adapter lifecycle, health state,
// persistence of observations and analyses, operational events, image retention, and the hand-off
// of observation digests to the conditioning boundary. Failures here never reach the randomness core.

import { mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { rename, copyFile, readFile, rm, unlink } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { applyConfigSchema, publicConfig, describeAdapter, SourceConfigError } from './adapter.js';
import { observationDigest } from '../conditioning/boundary.js';

export const SOURCE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const NAME_MAX = 80;

export class SourceError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'source';

export class SourceRegistry {
  constructor({
    db, adapters, events, telemetry, boundary, dataDir, log, integrity,
    now = Date.now, unavailableAfter = 3, healthWindow = 10,
    retention = { observationMs: 7 * 864e5, referencedImageMs: 7 * 864e5 },
  }) {
    Object.assign(this, { db, adapters, events, telemetry, boundary, log, integrity, now, unavailableAfter, healthWindow, retention });
    this.root = resolve(join(dataDir, 'observations'));
    mkdirSync(this.root, { recursive: true });
    this.runtimes = new Map();
  }

  // ---------- lifecycle ----------

  init({ start = true } = {}) {
    for (const row of this.db.prepare('SELECT * FROM sources ORDER BY created_at, id').all()) {
      const def = this.adapters[row.type];
      let config = {};
      try {
        config = JSON.parse(row.config);
        if (def) config = applyConfigSchema(def.configSchema, config);
      } catch (err) {
        this.log.warn('source.config_invalid', { sourceId: row.id, error: err });
      }
      const rt = this.makeRuntime({ ...row, enabled: !!row.enabled, config }, def);
      this.restoreLatest(rt);
      this.runtimes.set(row.id, rt);
    }
    if (start) for (const rt of this.runtimes.values()) if (rt.row.enabled) this.startRuntime(rt);
  }

  makeRuntime(row, def) {
    return {
      id: row.id,
      row,
      def,
      instance: null,
      attempts: [],
      consecutiveFailures: 0,
      state: !def ? 'UNAVAILABLE' : row.enabled ? 'STARTING' : 'DISABLED',
      latest: null,
      lastAnalysis: null,
      lastErrorLogged: null,
    };
  }

  restoreLatest(rt) {
    try {
      const obs = this.db.prepare('SELECT * FROM observations WHERE source_id = ? ORDER BY id DESC LIMIT 1').get(rt.id);
      if (!obs) return;
      rt.latest = this.observationView(rt, obs, existsSync(this.latestFile(rt.id)));
      const fa = this.db.prepare('SELECT * FROM frame_analyses WHERE source_id = ? ORDER BY id DESC LIMIT 1').get(rt.id);
      if (fa) rt.lastAnalysis = this.analysisView(fa);
      // Re-offer the last observation to the boundary; it only counts while younger than maxAge.
      const file = obs.image_file ? this.observationFile(rt.id, obs.id) : null;
      const payload = file && existsSync(file) ? readFileSync(file) : Buffer.from(obs.vals || '{}');
      this.submitDigest(rt, obs.id, obs.observed_at, payload, !!(file && existsSync(file)));
    } catch (err) {
      this.log.warn('source.restore_failed', { sourceId: rt.id, error: err });
    }
  }

  startRuntime(rt) {
    if (!rt.def) {
      rt.state = 'UNAVAILABLE';
      return;
    }
    mkdirSync(this.sourceDir(rt.id), { recursive: true });
    const ctx = {
      report: (obs) => this.handleReport(rt, obs),
      reportError: (err) => this.handleError(rt, err),
      tmpPath: (ext = '') => join(this.sourceDir(rt.id), `.capture-${this.now()}-${randomBytes(4).toString('hex')}${ext}`),
      log: this.log,
      now: this.now,
    };
    try {
      rt.instance = rt.def.create({ id: rt.id, name: rt.row.name, config: rt.row.config }, ctx);
      rt.state = 'STARTING';
      rt.attempts = [];
      rt.consecutiveFailures = 0;
      rt.instance.start();
    } catch (err) {
      rt.instance = null;
      this.handleError(rt, err);
    }
  }

  stopRuntime(rt) {
    try {
      rt.instance?.stop();
    } catch (err) {
      this.log.warn('source.stop_failed', { sourceId: rt.id, error: err });
    }
    rt.instance = null;
  }

  stopAll() {
    for (const rt of this.runtimes.values()) this.stopRuntime(rt);
  }

  // ---------- paths ----------

  sourceDir(id) {
    const dir = resolve(join(this.root, id));
    if (!dir.startsWith(this.root + sep)) throw new SourceError('invalid source id');
    return dir;
  }
  latestFile(id) { return join(this.sourceDir(id), 'latest.jpg'); }
  observationFile(id, obsId) { return join(this.sourceDir(id), `${obsId}.jpg`); }
  latestUrl(id) { return `/observations/${id}/latest.jpg`; }
  observationUrl(id, obsId) { return `/observations/${id}/${obsId}.jpg`; }

  // ---------- adapter reports ----------

  async handleReport(rt, obs) {
    if (!rt.instance && rt.row.enabled === false) {
      if (obs.image?.tmpFile) await rm(obs.image.tmpFile, { force: true });
      return;
    }
    const observedAt = Number.isFinite(obs.observedAt) ? obs.observedAt : this.now();
    let obsId;
    let payload;
    try {
      const r = this.db.prepare('INSERT INTO observations (source_id, observed_at, kind, vals, image_file, width, height) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(rt.id, observedAt, obs.kind || 'reading', JSON.stringify(obs.values ?? {}), null, obs.image?.width ?? null, obs.image?.height ?? null);
      obsId = Number(r.lastInsertRowid);
      if (obs.image?.tmpFile) {
        const final = this.observationFile(rt.id, obsId);
        await rename(obs.image.tmpFile, final);
        const latestTmp = join(this.sourceDir(rt.id), '.latest.tmp');
        await copyFile(final, latestTmp);
        await rename(latestTmp, this.latestFile(rt.id));
        this.db.prepare('UPDATE observations SET image_file = ? WHERE id = ?').run(`${obsId}.jpg`, obsId);
        payload = await readFile(final);
      } else {
        payload = Buffer.from(JSON.stringify(obs.values ?? {}));
      }
    } catch (err) {
      this.integrity?.dbError(err);
      if (obs.image?.tmpFile) await rm(obs.image.tmpFile, { force: true }).catch(() => {});
      this.handleError(rt, new Error(`could not persist observation: ${err.message}`));
      return;
    }

    let analysisRow = null;
    if (obs.analysis) {
      const a = obs.analysis;
      try {
        this.db.prepare(`INSERT INTO frame_analyses (source_id, observation_id, analyzed_at, classification, mean_abs_diff, changed_fraction,
          histogram, mean_luma_prev, mean_luma_curr, exposure_shift, activity, interval_ms, processing_ms, settings)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          rt.id, obsId, observedAt, a.classification, a.meanAbsDiff, a.changedFraction, a.histogram ? JSON.stringify(a.histogram) : null,
          a.meanLumaPrev, a.meanLumaCurr, a.exposureShift, a.activity, obs.intervalMs ?? null,
          obs.processingMs ?? null, JSON.stringify(a.settings ?? {}),
        );
      } catch (err) {
        this.integrity?.dbError(err);
      }
      analysisRow = { ...a, observationId: obsId, analyzedAt: observedAt, intervalMs: obs.intervalMs ?? null, processingMs: obs.processingMs ?? null };
      rt.lastAnalysis = analysisRow;
    }

    try {
      this.db.prepare('UPDATE sources SET success_count = success_count + 1, last_success_at = ? WHERE id = ?').run(observedAt, rt.id);
    } catch (err) {
      this.integrity?.dbError(err);
    }
    rt.row.success_count = (rt.row.success_count || 0) + 1;
    rt.row.last_success_at = observedAt;
    rt.latest = this.observationView(rt, {
      id: obsId, observed_at: observedAt, kind: obs.kind, vals: JSON.stringify(obs.values ?? {}),
      width: obs.image?.width ?? null, height: obs.image?.height ?? null, image_file: obs.image ? `${obsId}.jpg` : null,
    }, !!obs.image);
    this.telemetry.record(`capture:${rt.id}`);
    this.recordAttempt(rt, true);

    const dims = obs.image ? ` (${obs.image.width}×${obs.image.height})` : '';
    this.events.record('observation.captured', { sourceId: rt.id, message: `Observation #${obsId} captured by ${rt.row.name}${dims}`, data: { observationId: obsId } });
    if (analysisRow) {
      const act = analysisRow.activity === null ? '' : ` · activity ${analysisRow.activity.toFixed(3)}`;
      this.events.record('analysis.completed', {
        sourceId: rt.id,
        message: `Frame differential analysis completed for observation #${obsId}: ${analysisRow.classification}${act}`,
        data: { observationId: obsId, classification: analysisRow.classification, changedFraction: analysisRow.changedFraction },
      });
    }

    this.submitDigest(rt, obsId, observedAt, payload, !!obs.image);
    await this.pruneUnreferenced(rt);
  }

  submitDigest(rt, obsId, observedAt, payload, hasImage) {
    try {
      this.boundary.submit({
        sourceId: rt.id,
        sourceName: rt.row.name,
        observationId: obsId,
        observedAt,
        digest: observationDigest({ sourceId: rt.id, observedAt, payload }),
        ...(hasImage ? { imageUrl: this.observationUrl(rt.id, obsId) } : {}),
      });
    } catch (err) {
      this.log.warn('conditioning.submit_failed', { sourceId: rt.id, error: err });
    }
  }

  handleError(rt, err) {
    const message = String(err?.message || err).slice(0, 300);
    const at = this.now();
    rt.row.failure_count = (rt.row.failure_count || 0) + 1;
    rt.row.last_error = message;
    rt.row.last_error_at = at;
    try {
      this.db.prepare('UPDATE sources SET failure_count = failure_count + 1, last_error = ?, last_error_at = ? WHERE id = ?').run(message, at, rt.id);
    } catch (e) {
      this.integrity?.dbError(e);
    }
    this.telemetry.record(`capture:${rt.id}`, { count: 0, errors: 1 });
    // Log a failure when the message changes; repeats are counted in telemetry, not the event log.
    if (rt.lastErrorLogged !== message) {
      rt.lastErrorLogged = message;
      this.events.record('capture.failed', { level: 'warn', sourceId: rt.id, message: `${rt.row.name}: capture failed: ${message}` });
      this.log.warn('capture.failed', { sourceId: rt.id, error: message });
    }
    this.recordAttempt(rt, false);
  }

  recordAttempt(rt, ok) {
    const before = rt.state;
    rt.attempts.push(ok);
    if (rt.attempts.length > this.healthWindow) rt.attempts.shift();
    rt.consecutiveFailures = ok ? 0 : rt.consecutiveFailures + 1;
    if (ok) rt.lastErrorLogged = null;
    let state;
    if (rt.consecutiveFailures >= this.unavailableAfter) state = 'UNAVAILABLE';
    else if (rt.attempts.includes(false)) state = 'DEGRADED';
    else state = 'OPERATIONAL';
    rt.state = state;
    if (state === 'UNAVAILABLE' && before !== 'UNAVAILABLE') {
      this.events.record('source.disconnected', { level: 'error', sourceId: rt.id, message: `${rt.row.name} is UNAVAILABLE after ${rt.consecutiveFailures} consecutive failures; last valid observation retained` });
    } else if (before === 'UNAVAILABLE' && state !== 'UNAVAILABLE') {
      this.events.record('source.reconnected', { sourceId: rt.id, message: `${rt.row.name} reconnected` });
    }
  }

  // ---------- conditioning / retention ----------

  markReferenced(observations) {
    const ids = observations.map((o) => o.observationId).filter(Number.isInteger);
    if (!ids.length) return;
    try {
      this.db.prepare(`UPDATE observations SET referenced = 1 WHERE id IN (${ids.map(() => '?').join(',')})`).run(...ids);
    } catch (err) {
      this.integrity?.dbError(err);
    }
  }

  async removeImage(sourceId, obsId) {
    await unlink(this.observationFile(sourceId, obsId)).catch(() => {});
    this.db.prepare('UPDATE observations SET image_file = NULL WHERE id = ?').run(obsId);
  }

  // Unreferenced frames beyond historyCount are deleted. The observation currently offered to the
  // conditioning boundary is always kept so a response can still link to it.
  async pruneUnreferenced(rt) {
    const keep = Number.isInteger(rt.row.config.historyCount) ? rt.row.config.historyCount : 24;
    const protectedIds = new Set(this.boundary.currentObservationIds());
    try {
      const rows = this.db.prepare(`SELECT id FROM observations WHERE source_id = ? AND image_file IS NOT NULL AND referenced = 0
        ORDER BY id DESC LIMIT -1 OFFSET ?`).all(rt.id, keep);
      for (const r of rows) if (!protectedIds.has(r.id)) await this.removeImage(rt.id, r.id);
    } catch (err) {
      this.integrity?.dbError(err);
    }
  }

  async prune() {
    const t = this.now();
    const refCutoff = t - this.retention.referencedImageMs;
    const rowCutoff = t - this.retention.observationMs;
    const protectedIds = new Set(this.boundary.currentObservationIds());
    for (const r of this.db.prepare('SELECT id, source_id FROM observations WHERE image_file IS NOT NULL AND referenced = 1 AND observed_at < ?').all(refCutoff)) {
      if (!protectedIds.has(r.id)) await this.removeImage(r.source_id, r.id);
    }
    for (const r of this.db.prepare('SELECT id, source_id FROM observations WHERE image_file IS NOT NULL AND observed_at < ?').all(rowCutoff)) {
      if (!protectedIds.has(r.id)) await this.removeImage(r.source_id, r.id);
    }
    const latestIds = [...this.runtimes.values()].map((rt) => rt.latest?.observationId).filter(Number.isInteger);
    const keepIds = [...new Set([...protectedIds, ...latestIds])];
    const notIn = keepIds.length ? ` AND id NOT IN (${keepIds.map(() => '?').join(',')})` : '';
    this.db.prepare(`DELETE FROM observations WHERE observed_at < ?${notIn}`).run(rowCutoff, ...keepIds);
    this.db.prepare('DELETE FROM frame_analyses WHERE analyzed_at < ?').run(rowCutoff);
  }

  // ---------- views ----------

  observationView(rt, obs, hasLatestFile) {
    let values = {};
    try { values = JSON.parse(obs.vals || '{}'); } catch { /* ignore */ }
    return {
      observationId: obs.id,
      observedAt: obs.observed_at,
      kind: obs.kind,
      values,
      width: obs.width,
      height: obs.height,
      imageUrl: hasLatestFile ? `${this.latestUrl(rt.id)}?v=${obs.observed_at}` : null,
    };
  }

  analysisView(fa) {
    return {
      observationId: fa.observation_id,
      analyzedAt: fa.analyzed_at,
      classification: fa.classification,
      meanAbsDiff: fa.mean_abs_diff,
      changedFraction: fa.changed_fraction,
      histogram: fa.histogram ? JSON.parse(fa.histogram) : null,
      meanLumaPrev: fa.mean_luma_prev,
      meanLumaCurr: fa.mean_luma_curr,
      exposureShift: fa.exposure_shift,
      activity: fa.activity,
      intervalMs: fa.interval_ms,
      processingMs: fa.processing_ms,
      settings: fa.settings ? JSON.parse(fa.settings) : null,
    };
  }

  view(rt) {
    const def = rt.def;
    const status = rt.instance?.getStatus?.() || {};
    return {
      id: rt.id,
      name: rt.row.name,
      type: rt.row.type,
      adapter: def ? def.displayName : `Unknown adapter "${rt.row.type}"`,
      measurementKind: def?.measurementKind ?? 'measurement',
      entropyAssessment: def?.entropyAssessment ?? 'none',
      enabled: !!rt.row.enabled,
      status: rt.row.enabled ? rt.state : 'DISABLED',
      processing: status.capturing ? 'CAPTURING' : rt.row.enabled ? 'IDLE' : 'STOPPED',
      config: def ? publicConfig(def.configSchema, rt.row.config) : {},
      subject: rt.row.config.subject ?? null,
      intervalMs: rt.row.config.intervalMs ?? null,
      successCount: rt.row.success_count || 0,
      failureCount: rt.row.failure_count || 0,
      consecutiveFailures: rt.consecutiveFailures,
      lastSuccessAt: rt.row.last_success_at ?? null,
      lastError: rt.row.last_error ?? null,
      lastErrorAt: rt.row.last_error_at ?? null,
      latest: rt.latest,
      latestAnalysis: rt.lastAnalysis,
      createdAt: rt.row.created_at,
    };
  }

  list() {
    return [...this.runtimes.values()].map((rt) => this.view(rt));
  }

  get(id) {
    const rt = this.runtimes.get(id);
    if (!rt) throw new SourceError('source not found', 404);
    return rt;
  }

  // Observation row for image serving (only rows whose image file still exists).
  imageRow(sourceId, obsId) {
    return this.db.prepare('SELECT id, source_id, image_file FROM observations WHERE id = ? AND source_id = ? AND image_file IS NOT NULL').get(obsId, sourceId) || null;
  }

  recentErrors(id, limit = 10) {
    return this.events.list({ limit: 100, sourceId: id }).filter((e) => e.level !== 'info').slice(0, limit);
  }

  frameHistory(id, sinceMs) {
    return this.db.prepare('SELECT analyzed_at, activity, changed_fraction, mean_abs_diff, classification FROM frame_analyses WHERE source_id = ? AND analyzed_at >= ? ORDER BY analyzed_at')
      .all(id, sinceMs);
  }

  // ---------- administration ----------

  adapterCatalogue() {
    return Object.values(this.adapters).map(describeAdapter);
  }

  create({ id, name, type, enabled = true, config = {} } = {}) {
    const def = this.adapters[type];
    if (!def) throw new SourceError(`unknown source type "${type}"`);
    if (typeof name !== 'string' || !name.trim() || name.trim().length > NAME_MAX) throw new SourceError(`name is required (max ${NAME_MAX} characters)`);
    let sid = id ?? slugify(name);
    if (!SOURCE_ID.test(sid)) throw new SourceError('id must be lowercase letters, digits and dashes');
    if (id && this.runtimes.has(sid)) throw new SourceError(`source "${sid}" already exists`, 409);
    for (let n = 2; this.runtimes.has(sid); n++) sid = `${slugify(name)}-${n}`;
    let cfg;
    try { cfg = applyConfigSchema(def.configSchema, config); } catch (err) { throw wrapConfig(err); }
    const t = this.now();
    this.db.prepare('INSERT INTO sources (id, name, type, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(sid, name.trim(), type, enabled ? 1 : 0, JSON.stringify(cfg), t, t);
    const rt = this.makeRuntime({ id: sid, name: name.trim(), type, enabled: !!enabled, config: cfg, created_at: t, updated_at: t, success_count: 0, failure_count: 0 }, def);
    this.runtimes.set(sid, rt);
    this.events.record('source.registered', { sourceId: sid, message: `Source "${name.trim()}" (${type}) registered` });
    if (enabled) this.startRuntime(rt);
    return this.view(rt);
  }

  update(id, { name, enabled, config } = {}) {
    const rt = this.get(id);
    if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > NAME_MAX)) throw new SourceError(`name must be 1-${NAME_MAX} characters`);
    if (enabled !== undefined && typeof enabled !== 'boolean') throw new SourceError('enabled must be true or false');
    let cfg = rt.row.config;
    if (config !== undefined) {
      if (!rt.def) throw new SourceError('cannot configure a source with an unknown adapter');
      try { cfg = applyConfigSchema(rt.def.configSchema, config, rt.row.config); } catch (err) { throw wrapConfig(err); }
    }
    const newName = name !== undefined ? name.trim() : rt.row.name;
    const newEnabled = enabled !== undefined ? enabled : !!rt.row.enabled;
    this.db.prepare('UPDATE sources SET name = ?, enabled = ?, config = ?, updated_at = ? WHERE id = ?')
      .run(newName, newEnabled ? 1 : 0, JSON.stringify(cfg), this.now(), id);
    const wasEnabled = !!rt.row.enabled;
    const restart = wasEnabled && (config !== undefined || !newEnabled);
    Object.assign(rt.row, { name: newName, enabled: newEnabled, config: cfg });
    if (restart || !newEnabled) this.stopRuntime(rt);
    if (!newEnabled) rt.state = 'DISABLED';
    if (newEnabled && (!wasEnabled || restart)) this.startRuntime(rt);
    if (enabled !== undefined && enabled !== wasEnabled) {
      this.events.record(enabled ? 'source.enabled' : 'source.disabled', { sourceId: id, message: `Source "${newName}" ${enabled ? 'enabled' : 'disabled'}` });
      if (!enabled) this.boundary.remove(id);
    } else {
      this.events.record('source.configured', { sourceId: id, message: `Source "${newName}" configuration updated` });
    }
    return this.view(rt);
  }

  remove(id) {
    const rt = this.get(id);
    this.stopRuntime(rt);
    this.boundary.remove(id);
    this.runtimes.delete(id);
    this.db.prepare('DELETE FROM sources WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM observations WHERE source_id = ?').run(id);
    this.db.prepare('DELETE FROM frame_analyses WHERE source_id = ?').run(id);
    rmSync(this.sourceDir(id), { recursive: true, force: true });
    this.events.record('source.removed', { sourceId: id, message: `Source "${rt.row.name}" removed` });
  }

  async captureNow(id) {
    const rt = this.get(id);
    if (!rt.instance?.captureNow) throw new SourceError('source is not running or does not support on-demand capture');
    await rt.instance.captureNow();
    return this.view(rt);
  }

  // Summary used by /health and the dashboard header.
  summary() {
    const list = this.list();
    const cameras = list.filter((s) => s.type === 'camera');
    const primary = cameras.find((s) => s.enabled) || cameras[0] || null;
    return {
      sources: list.map((s) => ({ id: s.id, type: s.type, status: s.status, configured: true })),
      camera: primary
        ? { configured: true, id: primary.id, status: primary.status.toLowerCase() }
        : { configured: false, status: 'not_configured' },
    };
  }
}

function wrapConfig(err) {
  return err instanceof SourceConfigError ? new SourceError(err.message) : err;
}
