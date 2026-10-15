// Shared HTTP helpers: stable error shape and request metadata.

export const ERROR_STATUS = {
  AUTH_REQUIRED: 401,
  AUTH_INVALID: 401,
  INVALID_JSON: 400,
  INVALID_BYTES: 400,
  BYTES_TOO_LARGE: 400,
  UNKNOWN_FIELD: 400,
  INVALID_REQUEST: 400,
  NOT_FOUND: 404,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  HTTPS_REQUIRED: 403,
  FORBIDDEN: 403,
  RNG_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export function sendError(res, code, message, extraHeaders = {}) {
  for (const [k, v] of Object.entries(extraHeaders)) res.set(k, String(v));
  res.status(ERROR_STATUS[code] ?? 500).json({ error: { code, message } });
}

export function noStore(res) {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.set('Pragma', 'no-cache');
}

export function clientIp(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

// Express body-parser errors -> stable codes.
export function bodyErrorHandler(err, req, res, next) {
  if (!err) return next();
  noStore(res);
  if (err.type === 'entity.too.large') return sendError(res, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  if (err.type === 'entity.parse.failed' || err instanceof SyntaxError) return sendError(res, 'INVALID_JSON', 'Request body is not valid JSON');
  if (err.type === 'encoding.unsupported' || err.type === 'charset.unsupported') return sendError(res, 'INVALID_JSON', 'Unsupported request encoding');
  return next(err);
}
