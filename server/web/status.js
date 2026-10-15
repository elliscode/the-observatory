// Builds the public, non-sensitive /api/v1/status payload from live runtime state.
// Only collected metrics appear; buckets without collected data are null.

export const WINDOW_MINUTES = 360;
export const BUCKET_MINUTES = 10;
const MIN = 60_000;

function worst(statuses) {
  if (!statuses.length) return 'NOT_CONFIGURED';
  const enabled = statuses.filter((s) => s !== 'DISABLED');
  if (!enabled.length) return 'DISABLED';
  if (enabled.every((s) => s === 'OPERATIONAL')) return 'OPERATIONAL';
  if (enabled.every((s) => s === 'UNAVAILABLE')) return 'UNAVAILABLE';
  if (enabled.every((s) => s === 'STARTING')) return 'STARTING';
  return 'DEGRADED';
}

export function buildTelemetry({ telemetry, registry, now }) {
  const bucketMs = BUCKET_MINUTES * MIN;
  const end = Math.floor(now / bucketMs) * bucketMs;
  const start = end - (WINDOW_MINUTES / BUCKET_MINUTES - 1) * bucketMs;
  const idx = (t) => Math.floor((t - start) / bucketMs);
  const n = WINDOW_MINUTES / BUCKET_MINUTES;
  const times = Array.from({ length: n }, (_, i) => start + i * bucketMs);
  const blank = () => times.map(() => ({ count: 0, sum: 0, max: null, bytes: 0, errors: 0, seen: false }));

  const rows = telemetry.rows(start);
  const heartbeat = new Array(n).fill(false);
  const api = blank();
  const captures = new Map();
  for (const r of rows) {
    const i = idx(r.minute);
    if (i < 0 || i >= n) continue;
    if (r.metric === 'heartbeat') heartbeat[i] = true;
    else if (r.metric === 'random' || r.metric.startsWith('capture:')) {
      const target = r.metric === 'random' ? api : (captures.get(r.metric.slice(8)) || captures.set(r.metric.slice(8), blank()).get(r.metric.slice(8)));
      const b = target[i];
      b.count += r.count; b.sum += r.sum; b.bytes += r.bytes; b.errors += r.errors; b.seen = true;
      if (r.max !== null) b.max = b.max === null ? r.max : Math.max(b.max, r.max);
    }
  }
  // A bucket counts as "collected" if the service was up (heartbeat) or recorded anything.
  const up = (i) => heartbeat[i] || api[i].seen || [...captures.values()].some((c) => c[i].seen);
  const series = (fn) => times.map((t, i) => ({ t, v: up(i) ? fn(i) : null }));

  const sources = registry.list().map((s) => {
    const c = captures.get(s.id) || blank();
    const activity = times.map(() => ({ sum: 0, n: 0 }));
    if (s.type === 'camera') {
      try {
        for (const fa of registry.frameHistory(s.id, start)) {
          const i = idx(fa.analyzed_at);
          if (i >= 0 && i < n && fa.activity !== null) { activity[i].sum += fa.activity; activity[i].n++; }
        }
      } catch { /* telemetry is best effort */ }
    }
    return {
      id: s.id,
      name: s.name,
      type: s.type,
      availability: times.map((t, i) => {
        const total = c[i].count + c[i].errors;
        return { t, v: total ? c[i].count / total : null };
      }),
      captures: series((i) => c[i].count),
      activity: times.map((t, i) => ({ t, v: activity[i].n ? activity[i].sum / activity[i].n : null })),
    };
  });

  return {
    windowMinutes: WINDOW_MINUTES,
    bucketMinutes: BUCKET_MINUTES,
    series: {
      apiRequests: series((i) => api[i].count),
      apiBytes: series((i) => api[i].bytes),
      apiLatency: times.map((t, i) => ({ t, v: api[i].count ? api[i].sum / api[i].count : null })),
      apiErrors: series((i) => api[i].errors),
    },
    sources,
  };
}

export function buildStatus({ core, stats, registry, boundary, events, telemetry, integrity, apiConfigured, maxRandomBytes, now = Date.now() }) {
  const rng = core.status();
  const sources = registry.list();
  const contributing = boundary.contributing().map((e) => ({
    id: e.sourceId, name: e.sourceName, observationId: e.observationId, observedAt: new Date(e.observedAt).toISOString(),
    ...(e.imageUrl ? { imageUrl: e.imageUrl } : {}),
  }));
  const apiStatus = !apiConfigured ? 'NOT_CONFIGURED' : rng.status === 'UNAVAILABLE' ? 'UNAVAILABLE' : rng.status;
  const conditioningStatus = contributing.length ? 'ACTIVE' : 'IDLE';
  const integ = integrity.status();
  const observationStatus = worst(sources.map((s) => s.status));
  return {
    service: 'the-observatory',
    generatedAt: new Date(now).toISOString(),
    uptimeSec: rng.uptimeSec,
    subsystems: [
      { name: 'Cryptographic Randomness Core', status: rng.status },
      { name: 'Random Material Distribution API', status: apiStatus },
      { name: 'Environmental Observation Array', status: observationStatus },
      { name: 'Environmental Input Conditioning', status: conditioningStatus },
      { name: 'Observation Integrity Monitor', status: integ.status },
    ],
    rng,
    api: {
      status: apiStatus,
      requestsOk: stats.requestsOk,
      requestsFailed: stats.requestsFailed,
      bytesServed: stats.bytesServed,
      authFailures: stats.authFailures,
      rateLimited: stats.rateLimited,
      withEnvironmental: stats.withEnvironmental,
      withoutEnvironmental: stats.withoutEnvironmental,
      lastSuccessAt: stats.lastSuccessAt,
      lastFailureAt: stats.lastFailureAt,
      latency: { p50: stats.percentile(0.5), p95: stats.percentile(0.95), max: stats.latencyMax },
      lastUse: stats.lastUse ? { at: stats.lastUse.at, observations: stats.lastUse.observations } : null,
      maxBytes: maxRandomBytes,
    },
    conditioning: { status: conditioningStatus, mode: 'hkdf-salt', entropyCredit: 'none', contributing, maxAgeMs: boundary.maxAgeMs },
    integrity: { status: integ.status, lastErrorAt: integ.lastErrorAt },
    sources,
    events: events.list({ limit: 40 }),
    telemetry: buildTelemetry({ telemetry, registry, now }),
  };
}
