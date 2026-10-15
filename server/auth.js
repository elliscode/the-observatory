import { createHmac, createHash, timingSafeEqual } from 'node:crypto';

export const ADMIN_COOKIE = 'obs_admin';
const ADMIN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const key = part.slice(0, i).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(part.slice(i + 1).trim());
    } catch { /* malformed cookie value: ignore it */ }
  }
  return out;
}

// API keys for server-to-server consumers. Every configured key is compared (no early exit), and
// only the matching key's id is ever returned or logged.
export function createApiKeyAuth(keys) {
  return {
    authenticate(header) {
      if (typeof header !== 'string' || !header) return { ok: false, code: 'AUTH_REQUIRED' };
      const m = /^Bearer\s+(\S+)\s*$/i.exec(header);
      if (!m) return { ok: false, code: 'AUTH_INVALID' };
      let match = null;
      for (const k of keys) if (safeEqual(m[1], k.key) && !match) match = k.id;
      return match ? { ok: true, keyId: match } : { ok: false, code: 'AUTH_INVALID' };
    },
  };
}

// Admin login cookie (same pattern as dungeons-and-ellis): HMAC-signed timestamp, httpOnly.
export function createAdminAuth({ password, secret, now = Date.now }) {
  const key = secret || createHash('sha256').update(`the-observatory:${password}`).digest('hex');
  const sign = (value) => createHmac('sha256', key).update(value).digest('base64url');
  return {
    checkPassword: (candidate) => safeEqual(String(candidate ?? ''), password),
    issueToken() {
      const payload = `admin.${now()}`;
      return `${payload}.${sign(payload)}`;
    },
    verifyToken(token) {
      if (typeof token !== 'string') return false;
      const i = token.lastIndexOf('.');
      if (i < 0) return false;
      const payload = token.slice(0, i);
      if (!safeEqual(sign(payload), token.slice(i + 1))) return false;
      const issued = Number(payload.split('.')[1]);
      return Number.isFinite(issued) && now() - issued < ADMIN_MAX_AGE_MS;
    },
    isAdmin(req) {
      return this.verifyToken(parseCookies(req.headers.cookie)[ADMIN_COOKIE]);
    },
    cookieMaxAgeMs: ADMIN_MAX_AGE_MS,
  };
}
