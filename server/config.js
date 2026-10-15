// Environment configuration. Everything the server needs comes through createServer() options;
// this module only turns process.env into those options and rejects unsafe values early.

export class ConfigError extends Error {}

export const MIN_API_KEY_LENGTH = 32;
export const HKDF_SHA256_MAX_BYTES = 255 * 32;
const KEY_ID = /^[A-Za-z0-9_.-]{1,64}$/;

// "oneshot:<key>,otherapp:<key>" -> [{ id, key }]. A bare OBSERVATORY_API_KEY becomes id "default".
export function parseApiKeys({ keys, key } = {}) {
  const out = [];
  if (keys && keys.trim()) {
    for (const part of keys.split(',').map((s) => s.trim()).filter(Boolean)) {
      const i = part.indexOf(':');
      if (i <= 0) throw new ConfigError('OBSERVATORY_API_KEYS entries must look like "<id>:<key>"');
      out.push({ id: part.slice(0, i).trim(), key: part.slice(i + 1).trim() });
    }
  }
  if (key && key.trim()) out.push({ id: 'default', key: key.trim() });
  return validateApiKeys(out);
}

export function validateApiKeys(list) {
  const ids = new Set();
  for (const { id, key } of list) {
    if (!KEY_ID.test(id)) throw new ConfigError(`API key id "${id}" must be 1-64 characters of A-Z a-z 0-9 _ . -`);
    if (ids.has(id)) throw new ConfigError(`API key id "${id}" is configured twice`);
    ids.add(id);
    // The key itself is never echoed in errors.
    if (typeof key !== 'string' || key.length < MIN_API_KEY_LENGTH) {
      throw new ConfigError(`API key "${id}" is shorter than ${MIN_API_KEY_LENGTH} characters; generate one with: openssl rand -base64 32`);
    }
  }
  return list;
}

const int = (v, fallback) => {
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ConfigError(`Expected an integer, got "${v}"`);
  return n;
};
const bool = (v, fallback = false) => (v === undefined || v === '' ? fallback : v === 'true' || v === '1');
const DAY = 24 * 60 * 60 * 1000;

export function loadConfig(env = process.env) {
  const maxRandomBytes = int(env.MAX_RANDOM_BYTES, 1024);
  if (maxRandomBytes < 1 || maxRandomBytes > HKDF_SHA256_MAX_BYTES) {
    throw new ConfigError(`MAX_RANDOM_BYTES must be between 1 and ${HKDF_SHA256_MAX_BYTES}`);
  }
  return {
    port: int(env.PORT, 3100),
    host: env.HOST || '127.0.0.1',
    publicUrl: env.PUBLIC_URL || null,
    dbFile: env.DB_FILE || undefined,
    dataDir: env.DATA_DIR || undefined,
    apiKeys: parseApiKeys({ keys: env.OBSERVATORY_API_KEYS, key: env.OBSERVATORY_API_KEY }),
    maxRandomBytes,
    requireHttps: bool(env.REQUIRE_HTTPS),
    rateLimits: {
      random: { perMinute: int(env.RATE_LIMIT_PER_MINUTE, 30), burst: int(env.RATE_LIMIT_BURST, 10) },
      public: { perMinute: int(env.PUBLIC_RATE_LIMIT_PER_MINUTE, 120), burst: int(env.PUBLIC_RATE_LIMIT_BURST, 60) },
      authFailure: { perMinute: 10, burst: 10 },
    },
    adminPassword: env.ADMIN_PASSWORD || null,
    sessionSecret: env.SESSION_SECRET || null,
    secureCookies: bool(env.SECURE_COOKIES),
    envMaxAgeMs: int(env.ENV_MAX_AGE_MS, 10 * 60 * 1000),
    retention: {
      observationMs: int(env.OBSERVATION_RETENTION_DAYS, 7) * DAY,
      referencedImageMs: int(env.REFERENCED_IMAGE_RETENTION_DAYS, 7) * DAY,
      eventMs: int(env.EVENT_RETENTION_DAYS, 30) * DAY,
      eventMaxRows: int(env.EVENT_MAX_ROWS, 20000),
      routineEventMaxRows: int(env.ROUTINE_EVENT_MAX_ROWS, 2000),
      telemetryMs: int(env.TELEMETRY_RETENTION_DAYS, 30) * DAY,
    },
    seedCamera: bool(env.OBSERVATORY_SEED_CAMERA)
      ? { device: env.OBSERVATORY_CAMERA_DEVICE || '0', subject: env.OBSERVATORY_CAMERA_SUBJECT || 'Unspecified subject' }
      : null,
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    logLevel: env.LOG_LEVEL || 'info',
  };
}
