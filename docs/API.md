# API reference — `/api/v1`

Base URL: `https://observatory.elliscode.com/api/v1`

| Endpoint | Auth | Purpose |
|---|---|---|
| `POST /random` | API key | Fresh random material (the integration contract) |
| `GET /health` | none | Basic operational status |
| `GET /status` | none | Full public dashboard data |

All responses are JSON. Every error has the same shape:

```json
{ "error": { "code": "INVALID_BYTES", "message": "\"bytes\" must be a positive integer" } }
```

Codes are stable; messages may change.

## `POST /random`

**Headers**

```
Authorization: Bearer <OBSERVATORY_API_KEY>
Content-Type: application/json
```

**Body** (a JSON object with exactly one field, at most 1 KB):

```json
{ "bytes": 32 }
```

`bytes` must be an integer from 1 to `MAX_RANDOM_BYTES` (default 1024; configurable up to 8160).

**200 response**

```json
{
  "requestId": "6f1c2a8e-8a8e-4c43-9a51-0d3b7f0f5c2e",
  "bytes": 32,
  "encoding": "base64url",
  "data": "<43 base64url characters>",
  "algorithm": "hkdf-sha256(os-csprng-32B, environmental-salt)",
  "environmentalInput": {
    "sources": [
      {
        "id": "tank-cam",
        "name": "Aquarium Camera",
        "observationId": 9120,
        "observedAt": "2026-10-15T16:00:02.114Z",
        "imageUrl": "/observations/tank-cam/9120.jpg"
      }
    ]
  },
  "timestamp": "2026-10-15T16:00:04.871Z"
}
```

(The values above are placeholders, not real output.)

| Field | Meaning |
|---|---|
| `requestId` | Unique UUID for this request |
| `bytes` | Number of bytes in `data` (always equals the request) |
| `encoding` | Always `base64url` (RFC 4648 §5, no padding). Decode with `Buffer.from(data, 'base64url')` |
| `data` | The random material. Fresh for every request; never cached or repeated |
| `algorithm` | How it was derived (see [RANDOMNESS_AND_ENTROPY.md](RANDOMNESS_AND_ENTROPY.md)) |
| `environmentalInput` | The observations mixed into this response, or `null` if none were fresh. Informational only |
| `environmentalInput.sources[].imageUrl` | Public path of the frame that was mixed in, relative to the site origin (join with `https://observatory.elliscode.com`). Present for camera sources only; kept for 7 days by default |
| `timestamp` | Server time when the material was generated (ISO 8601, UTC) |

The response has `Cache-Control: no-store` and `Pragma: no-cache`.

**Errors**

| Status | Code | When |
|---|---|---|
| 400 | `INVALID_JSON` | Body is not a JSON object, Content-Type is not `application/json`, or the body is empty |
| 400 | `INVALID_BYTES` | `bytes` missing, not a number, not an integer, or < 1 (strings like `"32"` are rejected) |
| 400 | `BYTES_TOO_LARGE` | `bytes` > `MAX_RANDOM_BYTES` |
| 400 | `UNKNOWN_FIELD` | Any field other than `bytes` |
| 401 | `AUTH_REQUIRED` | No `Authorization` header |
| 401 | `AUTH_INVALID` | Malformed header or unknown key |
| 403 | `HTTPS_REQUIRED` | Plain HTTP in production |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 1 KB |
| 429 | `RATE_LIMITED` | Rate limit exceeded; see the `Retry-After` header (seconds) |
| 500 | `INTERNAL` | Unexpected server error |
| 503 | `RNG_UNAVAILABLE` | The operating system's random source failed. There is never a fallback generator |

**Rate limits**

- Per API key: 30 requests per minute, with a burst of 10 (`RATE_LIMIT_PER_MINUTE`, `RATE_LIMIT_BURST`).
- After repeated authentication failures from one IP, that IP gets `429` for a while.

**Example**

```sh
curl -s -X POST https://observatory.elliscode.com/api/v1/random \
  -H "Authorization: Bearer $OBSERVATORY_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"bytes":32}'
```

## `GET /health`

Unauthenticated and rate-limited per IP. Returns 200, or 503 when the random source is unavailable.

```json
{
  "status": "ok",
  "service": "the-observatory",
  "version": "0.1.0",
  "randomSource": "operating-system-cryptographic-rng",
  "algorithm": "hkdf-sha256(os-csprng-32B, environmental-salt)",
  "rng": { "status": "operational" },
  "camera": { "configured": true, "id": "tank-cam", "status": "operational" },
  "sources": [{ "id": "tank-cam", "type": "camera", "status": "OPERATIONAL", "configured": true }],
  "timestamp": "2026-10-15T16:00:00.000Z"
}
```

- `status` is `ok`, `degraded` (random-source errors in the last 5 minutes) or `unavailable`.
- Camera status never changes `status`, because the random service doesn't depend on it.
- With no camera, `camera` is `{"configured": false, "status": "not_configured"}`.

## `GET /status`

The dashboard's data source: subsystem statuses, source details, the latest analysis, recent events, and telemetry series. It's unauthenticated, contains nothing sensitive (no keys, no random material, no digests, no filesystem paths), and its shape may evolve. Integrations should use `/random` and `/health`.

## Images

| Path | Notes |
|---|---|
| `GET /observations/<sourceId>/latest.jpg` | Latest valid image, `Cache-Control: no-cache` |
| `GET /observations/<sourceId>/<observationId>.jpg` | A specific stored frame, `Cache-Control: immutable`; 404 once pruned |
