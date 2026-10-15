import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  config TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_success_at INTEGER,
  success_count INTEGER NOT NULL DEFAULT 0,
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  last_error_at INTEGER
);
-- One row per successful observation. referenced = 1 once the observation was mixed into a
-- /random response; its image is then kept for the referenced-image retention period.
CREATE TABLE IF NOT EXISTS observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  vals TEXT,
  image_file TEXT,
  width INTEGER,
  height INTEGER,
  referenced INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS observations_source ON observations(source_id, id);
CREATE INDEX IF NOT EXISTS observations_time ON observations(observed_at);
CREATE TABLE IF NOT EXISTS frame_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id TEXT NOT NULL,
  observation_id INTEGER NOT NULL,
  analyzed_at INTEGER NOT NULL,
  classification TEXT NOT NULL,
  mean_abs_diff REAL,
  changed_fraction REAL,
  histogram TEXT,
  mean_luma_prev REAL,
  mean_luma_curr REAL,
  exposure_shift REAL,
  activity REAL,
  interval_ms INTEGER,
  processing_ms REAL,
  settings TEXT
);
CREATE INDEX IF NOT EXISTS frame_analyses_source ON frame_analyses(source_id, analyzed_at);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  level TEXT NOT NULL,
  type TEXT NOT NULL,
  source_id TEXT,
  message TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS events_type ON events(type, id);
-- Per-minute aggregates. Metric names: heartbeat, random, capture:<sourceId>.
CREATE TABLE IF NOT EXISTS telemetry_minutes (
  minute INTEGER NOT NULL,
  metric TEXT NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  sum REAL NOT NULL DEFAULT 0,
  max REAL,
  bytes INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (minute, metric)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export function openDb(file) {
  if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
