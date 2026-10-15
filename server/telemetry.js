// Historical Telemetry: per-minute aggregates kept in memory and flushed to SQLite about once a
// minute, so request volume never turns into per-request database writes.
// A "heartbeat" row is written every minute the service is up; a bucket without one is a period
// when nothing was being collected and is reported as missing (null), never as zero.

const MINUTE = 60_000;

export class Telemetry {
  constructor({ db, now = Date.now, integrity }) {
    this.db = db;
    this.now = now;
    this.integrity = integrity;
    this.pending = new Map();
    this.upsert = db.prepare(`
      INSERT INTO telemetry_minutes (minute, metric, count, sum, max, bytes, errors) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(minute, metric) DO UPDATE SET
        count = count + excluded.count,
        sum = sum + excluded.sum,
        max = CASE WHEN max IS NULL OR excluded.max > max THEN excluded.max ELSE max END,
        bytes = bytes + excluded.bytes,
        errors = errors + excluded.errors`);
  }

  minute(ts = this.now()) {
    return Math.floor(ts / MINUTE) * MINUTE;
  }

  record(metric, { count = 1, value = null, bytes = 0, errors = 0 } = {}) {
    const minute = this.minute();
    const k = `${minute}|${metric}`;
    let row = this.pending.get(k);
    if (!row) this.pending.set(k, (row = { minute, metric, count: 0, sum: 0, max: null, bytes: 0, errors: 0 }));
    row.count += count;
    if (value !== null) {
      row.sum += value;
      row.max = row.max === null ? value : Math.max(row.max, value);
    }
    row.bytes += bytes;
    row.errors += errors;
  }

  heartbeat() {
    this.record('heartbeat', { count: 0 });
  }

  flush() {
    if (!this.pending.size) return;
    const rows = [...this.pending.values()];
    this.pending.clear();
    try {
      for (const r of rows) this.upsert.run(r.minute, r.metric, r.count, r.sum, r.max, r.bytes, r.errors);
    } catch (err) {
      this.integrity?.dbError(err);
    }
  }

  // Rows for metrics matching `prefix` since `sinceMs`, merged with not-yet-flushed data.
  rows(sinceMs, prefix = '') {
    let stored = [];
    try {
      stored = this.db.prepare('SELECT * FROM telemetry_minutes WHERE minute >= ? AND metric LIKE ?').all(sinceMs, `${prefix}%`);
    } catch (err) {
      this.integrity?.dbError(err);
    }
    const merged = new Map(stored.map((r) => [`${r.minute}|${r.metric}`, { ...r }]));
    for (const [k, p] of this.pending) {
      if (p.minute < sinceMs || !p.metric.startsWith(prefix)) continue;
      const r = merged.get(k);
      if (!r) merged.set(k, { ...p });
      else {
        r.count += p.count; r.sum += p.sum; r.bytes += p.bytes; r.errors += p.errors;
        if (p.max !== null) r.max = r.max === null ? p.max : Math.max(r.max, p.max);
      }
    }
    return [...merged.values()];
  }

  prune(maxAgeMs) {
    this.db.prepare('DELETE FROM telemetry_minutes WHERE minute < ?').run(this.now() - maxAgeMs);
  }
}
