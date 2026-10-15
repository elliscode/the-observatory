// Operational Event Log: real events with real timestamps, stored in SQLite (bounded) and kept in
// a small in-memory ring so the dashboard still works if the database is unhealthy.
// Callers must never put credentials or random material in `data`.

// High-frequency events that are capped by row count instead of by age.
export const ROUTINE_TYPES = ['observation.captured', 'analysis.completed', 'random.fulfilled'];

export class EventLog {
  constructor({ db, now = Date.now, integrity, maxRecent = 200 }) {
    this.db = db;
    this.now = now;
    this.integrity = integrity;
    this.maxRecent = maxRecent;
    this.recent = [];
    this.seq = 0;
    this.insert = db.prepare('INSERT INTO events (ts, level, type, source_id, message, data) VALUES (?, ?, ?, ?, ?, ?)');
  }

  record(type, { level = 'info', sourceId = null, message, data = null } = {}) {
    const event = { id: null, ts: this.now(), level, type, sourceId, message: message || type, data };
    try {
      const r = this.insert.run(event.ts, level, type, sourceId, event.message, data ? JSON.stringify(data) : null);
      event.id = Number(r.lastInsertRowid);
    } catch (err) {
      this.integrity?.dbError(err);
      event.id = `mem-${++this.seq}`;
    }
    this.recent.push(event);
    if (this.recent.length > this.maxRecent) this.recent.shift();
    return event;
  }

  list({ limit = 50, sourceId = null } = {}) {
    try {
      const rows = sourceId
        ? this.db.prepare('SELECT * FROM events WHERE source_id = ? ORDER BY id DESC LIMIT ?').all(sourceId, limit)
        : this.db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(limit);
      return rows.map((r) => ({
        id: r.id, ts: r.ts, level: r.level, type: r.type, sourceId: r.source_id, message: r.message,
        data: r.data ? JSON.parse(r.data) : null,
      }));
    } catch (err) {
      this.integrity?.dbError(err);
      const items = sourceId ? this.recent.filter((e) => e.sourceId === sourceId) : this.recent;
      return items.slice(-limit).reverse();
    }
  }

  prune({ maxAgeMs, maxRows, routineMaxRows }) {
    const cutoff = this.now() - maxAgeMs;
    this.db.prepare('DELETE FROM events WHERE ts < ?').run(cutoff);
    for (const type of ROUTINE_TYPES) {
      this.db.prepare('DELETE FROM events WHERE type = ? AND id NOT IN (SELECT id FROM events WHERE type = ? ORDER BY id DESC LIMIT ?)')
        .run(type, type, routineMaxRows);
    }
    this.db.prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)').run(maxRows);
  }
}
