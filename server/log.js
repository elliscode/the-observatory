// Structured JSON-lines logger. Field names that could carry credentials or random material are
// redacted wherever they appear, so a careless call site cannot leak them.

const REDACTED_FIELDS = new Set(['authorization', 'cookie', 'key', 'apikey', 'api_key', 'data', 'password', 'secret', 'salt', 'digest', 'ikm']);
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function redact(value, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Buffer.isBuffer(value)) return '[buffer]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACTED_FIELDS.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export function createLogger({ level = 'info', write = (line) => process.stdout.write(line + '\n'), now = Date.now } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  const emit = (lvl) => (msg, fields = {}) => {
    if (LEVELS[lvl] < min) return;
    write(JSON.stringify({ ts: new Date(now()).toISOString(), level: lvl, msg, ...redact(fields) }));
  };
  return { debug: emit('debug'), info: emit('info'), warn: emit('warn'), error: emit('error') };
}

export const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
