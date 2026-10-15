# The Observatory — Initial Implementation Specification

**Status:** implemented, 46/46 tests passing. Not yet deployed to the Mac Mini.
**Supersedes, where they differ:** [2026_10_15_001_INITIAL_DESIGN.md](2026_10_15_001_INITIAL_DESIGN.md)
**Audience:** maintainers and agents changing this codebase. It describes the system as built. Operator and consumer docs are listed in §14.

---

## 1. Summary

The Observatory is a standalone Node.js application. It has three jobs:

1. It observes a physical scene through registered **observation sources**. The camera is the first source type.
2. It records and analyzes those observations, then shows them on a public, server-rendered dashboard.
3. It serves **cryptographically secure random material** at `POST /api/v1/random` to other applications. Each request is authenticated with an API key.

Every random response is derived from 32 fresh bytes from the operating system's CSPRNG. The latest observations are mixed in as an HKDF salt, so observations really change the output. Security never depends on them, and no entropy credit is claimed.

| | |
|---|---|
| Dashboard | `https://observatory.elliscode.com/` |
| API base | `https://observatory.elliscode.com/api/v1` |
| Runtime | Node ≥ 24 (`.nvmrc`: 24), ESM |
| Dependencies | `express` only |
| External tools | `ffmpeg` (camera capture and frame decoding) |
| Persistence | built-in `node:sqlite` (WAL), plus JPEG files under `data/` |
| Host | Mac Mini, behind Caddy on `127.0.0.1:3100` |

## 2. Changes from the initial design

| Design (001) | As built | Reason |
|---|---|---|
| Domain `observatory.oneshot.elliscode.com` | `observatory.elliscode.com` | The service may serve apps other than oneshot |
| Optional `POST /api/v1/die` | Not implemented | Out of scope. The consumer maps bytes to dice itself, and [INTEGRATION.md](INTEGRATION.md) documents the unbiased method |
| Observations may be collected without being incorporated | Observations are **incorporated as an HKDF salt** | User decision. It makes "the turtle influenced this number" true without weakening the output (§5) |
| Bounded image history only | Frames mixed into a response are **pinned** and served by URL for 7 days | Lets a consumer show "the frame that seeded this roll" |
| — | Each consumer gets its own named API key | Gives each consumer its own rate limit and lets one key be revoked without touching the others |

Expected consumer behavior: fetch a 32-byte seed about every 60 s. Every call returns new, unique material, whether or not any observation has changed.

## 3. Architecture

```
                          ┌───────────────────────────── server/index.js (wiring) ─────────────────────────────┐
 camera ──ffmpeg──▶ CameraAdapter ──report()──▶ SourceRegistry ──submit(digest)──▶ ConditioningBoundary          │
                    (acquire +                  (lifecycle, health,                 (latest fresh digest         │
                     frame-diff)                 persistence, events,                per source → 32-byte salt) │
                                                 retention)                                │                     │
                                                      │                     getEnvironmentalSalt() (injected)    │
                                                      ▼                                    ▼                     │
                                   SQLite + data/observations/          RandomnessCore: randomBytes(32) → HKDF   │
                                                      │                                    │                     │
                          Dashboard / status ◀────────┴──── Telemetry, EventLog ◀── /api/v1/random router ◀──────┘
```

Rules the code enforces:

- **Isolated core.** `server/randomness/core.js` imports only `node:crypto`, and a test checks that. The salt provider is injected and treated as untrusted.
- **Bookkeeping after the response.** Statistics, events, telemetry and observation pinning run after the response is sent, inside try/catch. None of them can block or alter the random material.
- **One path from observations to randomness.** The conditioning boundary is the only route, and it carries only a 32-byte salt plus public metadata.
- **Contained adapter failures.** They stay inside the registry. A camera failure changes source health, never the RNG.

### Source tree

```
server/
  index.js                 createServer(options) factory + main() (env → loadConfig → listen)
  config.js                env parsing, API-key parsing/validation (≥ 32 chars), limits
  log.js                   JSON-lines logger with field redaction
  db.js                    schema, openDb(), meta helpers
  integrity.js             Observation Integrity Monitor (DB error tracking)
  events.js                EventLog (SQLite + in-memory ring), pruning
  telemetry.js             per-minute aggregates, flushed once a minute
  ratelimit.js             token buckets
  auth.js                  API-key auth, admin HMAC cookie auth, safeEqual
  randomness/core.js       RandomnessCore
  randomness/routes.js     POST /api/v1/random, API statistics
  conditioning/boundary.js observationDigest(), ConditioningBoundary
  sources/adapter.js       adapter contract, config-schema validation
  sources/adapters/camera.js, adapters/index.js (catalogue)
  sources/registry.js      SourceRegistry
  sources/ffmpeg.js        capture / decode helpers
  sources/analysis/frame-diff.js
  web/http.js              error shape, no-store, body-parser error mapping
  web/status.js            /status payload + telemetry series
  web/dashboard.js         server-rendered page + Open Graph tags
  web/routes.js            /, /api/v1/health, /api/v1/status, /observations/*
  web/preview.js           imageSize() (copied from dungeons-and-ellis), esc()
  web/admin.js             /admin and /admin/api/*
client/
  js/render.js, js/charts.js   pure HTML/SVG renderers shared by server and browser
  js/dashboard.js              5 s polling
  js/admin.js, admin.html      source management UI
  css/observatory.css
static/og-fallback.png (1200×630, from scripts/gen-fallback.js), favicon.svg
examples/observatory-client.js reference consumer
deploy/Caddyfile, deploy/com.elliscode.observatory.plist
test/*.test.js
```

## 4. Randomness core (`server/randomness/core.js`)

`createRandomnessCore({ randomBytes = crypto.randomBytes, getEnvironmentalSalt = () => null, now })`

### `generate(n, context)` (context = requestId)

1. Reject `n` outside `1..8160` (the HKDF-SHA256 maximum, 255 × 32).
2. Call `getEnvironmentalSalt()` inside try/catch. Accept the result only if it is `{ salt: Buffer(32), observations: Array }`; otherwise use `null` and increment `saltErrors`.
3. `ikm = randomBytes(32)`. If the call throws or returns anything other than a 32-byte Buffer, record the failure and throw `RngUnavailableError`. **There is no fallback generator.**
4. `data = Buffer.from(hkdfSync('sha256', ikm, salt ?? Buffer.alloc(0), 'observatory/v1/random:' + context, n))`. `hkdfSync` returns an ArrayBuffer, so the `Buffer.from` is required.
5. Zero `ikm` and return `{ data, environmental: observations | null }`.

### Self-test and status

- **Startup self-test:** `selfTest()` draws 32 bytes once.
- **`status()`:**
  - `UNAVAILABLE` if the self-test failed and nothing has succeeded since, or if the most recent attempt failed.
  - `DEGRADED` if any failure happened in the last 5 min.
  - `OPERATIONAL` otherwise.
- **Counters:** generations, failures, salt errors, last success/failure, recovery time, uptime.

### Invariants

- Each response is unique because of its own fresh `ikm`, never because observations changed.
- The salt changes the output on purpose and must not be removed as dead code.
- `Algorithm` string: `hkdf-sha256(os-csprng-32B, environmental-salt)`. `Random source` string: `operating-system-cryptographic-rng`.

## 5. Conditioning boundary (`server/conditioning/boundary.js`)

### Digest

The registry computes one per successful observation:

```
SHA-256("observatory/digest/v1" || u32be(len(sourceId)) || sourceId || u64be(observedAtMs) || u32be(len(payload)) || payload)
```

The payload is the full JPEG bytes for image observations, or `JSON.stringify(values)` for other readings.

### API

- **`submit({ sourceId, sourceName, observationId, observedAt, digest, imageUrl? })`** keeps the latest entry per source and throws on a malformed digest. The registry calls it inside try/catch.
- **`contributing()`** returns each source's latest entry if it is younger than `ENV_MAX_AGE_MS` (default 600 000), sorted by source id.
- **`currentSalt()`** returns `null` when nothing qualifies. Otherwise it returns `{ salt, observations }`:
  ```
  salt = SHA-256("observatory/salt/v1" || u32be(count) || for each: u32be(len(id)) || id || digest)
  ```
  `observations` holds `{ id, name, observationId, observedAt (ISO), imageUrl? }`.
- **`remove(sourceId)`** is called when a source is disabled or removed.
- **`currentObservationIds()`** returns the observations the boundary currently holds. These are protected from image pruning.

Digests and salts are never returned by the API, logged or persisted. They are rebuilt on startup from the latest stored observation, and they only count while fresh.

## 6. Observation sources

### 6.1 Adapter contract (`server/sources/adapter.js`, [ADAPTERS.md](ADAPTERS.md))

```
{ type, displayName, description?, measurementKind: 'measurement', entropyAssessment: 'none',
  configSchema: { field: { type: 'string'|'integer'|'boolean', default, min, max, maxLength, pattern, label, help, secret, required } },
  create(source, ctx) -> { start(), stop(), captureNow?(), getStatus?() } }
```

`ctx` provides:

| Member | Purpose |
|---|---|
| `report(obs)` | `obs = { observedAt, kind, values, image?: { tmpFile, width, height }, analysis?, processingMs?, intervalMs? }` |
| `reportError(err)` | Report a failed attempt |
| `tmpPath(ext)` | A temp file path in the source's data directory |
| `now()` | The registry clock |
| `log` | Structured logger |

Validation rules:

- `validateAdapter()` runs when the catalogue is built and requires `measurementKind === 'measurement'`.
- `applyConfigSchema()` applies defaults, coerces numeric strings and `"true"`/`"false"`, enforces bounds and patterns, and rejects unknown fields.
- `publicConfig()` drops fields marked `secret`.

### 6.2 Camera adapter (`server/sources/adapters/camera.js`)

**Config schema** (flat; defaults shown):

| Field | Default | Constraint |
|---|---|---|
| `subject` | `Unspecified subject` | ≤ 120 chars |
| `device` | `0` | avfoundation index or name, or `file:<path>` |
| `intervalMs` | 5000 | 1000 – 3 600 000 |
| `width` / `height` | 1280 / 720 | 160–4096 / 120–4096 |
| `framerate` | `"30"` | `^\d+(\.\d+)?$` (a string, so `29.97` or `30.000030` matches exactly) |
| `pixelFormat` | `""` | `^[a-z0-9]+$` or empty |
| `warmupFrames` | 25 | 0–300 |
| `historyCount` | 24 | 0–10 000 unreferenced frames kept |
| `analysisWidth` / `analysisHeight` | 160 / 90 | 16–640 / 9–480 |
| `diffThreshold` | 12 | 1–255 |
| `blur` | true | |

**Capture cycle.** The timer chain never overlaps. The next capture is scheduled `intervalMs` after the previous one finishes, and `captureNow()` joins any capture already in progress. Each cycle:

1. `captureJpeg(cfg, tmp)` runs:
   ```
   ffmpeg -hide_banner -loglevel error -nostdin -f avfoundation -framerate <fr> [-pixel_format <pf>] -video_size WxH -i <device>[:none] -vf select=gte(n\,<warmupFrames>) -frames:v 1 -q:v 3 -y <tmp>
   ```
   - A 15 s timeout applies (SIGKILL).
   - `device` gets `:none` appended unless it already contains `:` (video only).
   - `file:<path>` copies the file instead of using a camera.
   - On failure, the error message is the last line of ffmpeg's stderr, truncated to 300 chars.
2. The file must exist, be ≥ 1024 bytes, and be readable by `imageSize()`. Otherwise the cycle counts as a failure.
3. `decodeGray(tmp, aw, ah)` runs `ffmpeg … -vf scale=aw:ah,format=gray -f rawvideo pipe:1` and checks the decoded length is `aw*ah`.
4. If a previous frame exists, run `analyze(prev, curr, …)`. The baseline always moves to the newest valid frame.
5. `ctx.report(...)`. On any error the temp file is deleted and `ctx.reportError(err)` is called.

Dependencies are injectable for tests: `capture`, `decode`, `timers`, `now`, `ffmpegPath`.

### 6.3 Frame Differential Analysis (`server/sources/analysis/frame-diff.js`)

`analyze(prev, curr, { width, height, sourceSizePrev, sourceSizeCurr, threshold=12, blur=true, lowLightLuma=8, discontinuityFraction=0.85, discontinuityCorrelation=0.3 })` is a pure, deterministic function.

**Steps:**

1. Geometry check. If the buffer lengths differ, or the source dimensions changed, return `scene_discontinuity` with null metrics.
2. Optionally apply a 3×3 box blur to both frames.
3. Exposure compensation: `offset` = **median** signed difference (`curr − prev`), from a 511-bin histogram. The median resists local motion, unlike the mean.
4. Per pixel, `d = min(255, |curr − prev − offset|)`. Compute:
   - `meanAbsDiff`;
   - `changedFraction` (d > threshold);
   - an 8-bin histogram of `d` (32 levels per bin, as fractions);
   - mean luminance of both frames;
   - Pearson correlation (flat frames count as 1).
5. Classify:

   | Condition | Classification | `activity` |
   |---|---|---|
   | `meanLumaCurr < 8` | `low_light` | null |
   | `changedFraction > 0.85` and correlation < 0.3 | `scene_discontinuity` | null |
   | changedFraction < 0.005 | `static` | min(1, cf / 0.25) |
   | < 0.05 | `low` | ″ |
   | < 0.25 | `moderate` | ″ |
   | ≥ 0.25 | `high` | ″ |

The output includes `settings { width, height, threshold, blur }`. These values are always called "Observation Activity" and never entropy.

### 6.4 Source Registry (`server/sources/registry.js`)

**Source ids** match `^[a-z0-9][a-z0-9-]{0,63}$` and are derived from the name when not given (collisions get `-2`, `-3`, …). Names are 1–80 characters.

**Health state machine** (per runtime):

| State | Condition |
|---|---|
| `STARTING` | Enabled, no attempts yet |
| `OPERATIONAL` | Last 10 attempts all succeeded |
| `DEGRADED` | Any failure in the last 10 attempts, but fewer than 3 consecutive |
| `UNAVAILABLE` | ≥ 3 consecutive failures, or an unknown adapter type |
| `DISABLED` | `enabled = false` |

Moving into `UNAVAILABLE` emits `source.disconnected`. Moving out emits `source.reconnected`.

**On report** (`handleReport`):

1. Insert an `observations` row.
2. Rename the temp file to `<obsId>.jpg`. Copy it to `.latest.tmp`, then rename that to `latest.jpg` (atomic).
3. Set `image_file`, read the bytes, insert a `frame_analyses` row if analysis is present, and increment `success_count` / `last_success_at`.
4. Record `capture:<id>` telemetry and the `observation.captured` and `analysis.completed` events.
5. Submit the digest to the boundary, then prune unreferenced images.

A persistence failure turns into a capture failure. The temp file is removed and `latest.jpg` is untouched.

**On error** (`handleError`):

- Increment `failure_count` and store `last_error` / `last_error_at`.
- Record `capture:<id>` errors telemetry.
- Emit `capture.failed` only when the message differs from the previous one, so repeats don't flood the log.

**Image retention:**

- **Unreferenced frames:** after each capture, `referenced = 0` images beyond the newest `historyCount` are deleted (file removed, `image_file = NULL`). The observation the boundary currently holds is always kept.
- **`markReferenced(observations)`:** sets `referenced = 1`. It is called after each `/random` response that used a salt.
- **`prune()`** (every 10 min):
  - deletes images of referenced rows older than `REFERENCED_IMAGE_RETENTION_DAYS`;
  - deletes images of any row older than `OBSERVATION_RETENTION_DAYS`;
  - deletes those old rows (except boundary and latest rows) and old `frame_analyses`.
- `latest.jpg` is never pruned.

**Administration:** `create`, `update` (name/enabled/config; a config change restarts a running source; disabling removes it from the boundary), `remove` (stops it and deletes rows and its directory), `captureNow`, `adapterCatalogue`, `summary()` (for `/health`).

## 7. HTTP API

Every error uses `{ "error": { "code", "message" } }`. Full reference: [API.md](API.md).

### 7.1 `POST /api/v1/random`

Middleware runs in this order:

1. `noStore` headers (`Cache-Control: no-store, max-age=0`, `Pragma: no-cache`).
2. HTTPS check when `REQUIRE_HTTPS` (`req.secure`, trust proxy = loopback) → `403 HTTPS_REQUIRED`.
3. Auth: `Authorization: Bearer <key>`.
   - Every configured key is compared with `safeEqual` (sha256 + `timingSafeEqual`), with no early exit.
   - A missing header gives `AUTH_REQUIRED`; anything else invalid gives `AUTH_INVALID` (both 401).
   - Each failure consumes a per-IP auth-failure token (10/min, burst 10). When those run out, the response becomes `429 RATE_LIMITED`.
   - Failures emit `auth.failure` or `ratelimit.exceeded`.
4. Per-key rate limit (30/min, burst 10) → `429 RATE_LIMITED` + `Retry-After`.
5. `express.json({ limit: '1kb', strict: true })`. A body over the limit gets `413 PAYLOAD_TOO_LARGE`; a parse error gets `INVALID_JSON`.
6. Validation:
   - not `application/json`, no body, or empty body → `INVALID_JSON`;
   - not a plain object → `INVALID_JSON`;
   - any key other than `bytes` → `UNKNOWN_FIELD`;
   - `bytes` not a number, not an integer, or < 1 → `INVALID_BYTES`;
   - `bytes` > `MAX_RANDOM_BYTES` → `BYTES_TOO_LARGE`.
7. `core.generate(n, randomUUID())`. An `RngUnavailableError` gives `503 RNG_UNAVAILABLE`; any other error gives `500 INTERNAL`. Both emit `rng.failure`.
8. Respond with 200:
   ```
   { requestId, bytes, encoding: "base64url", data, algorithm, environmentalInput: { sources: [...] } | null, timestamp }
   ```
9. After responding: update the statistics, record `random` telemetry (latency, bytes) and the `random.fulfilled` event (key id, byte count, latency, observation ids; **never data**), log it, and `markReferenced`.

### 7.2 Public endpoints

All are rate-limited per IP (120/min, burst 60), and the API endpoints are HTTPS-gated like `/random`.

- **`GET /api/v1/health`** returns `{ status: ok|degraded|unavailable, service, version, randomSource, algorithm, rng: { status }, camera, sources[], timestamp }`.
  - It returns 503 only when the RNG is `UNAVAILABLE`.
  - Source health never changes `status`.
  - Without a camera, `camera` is `{ configured: false, status: "not_configured" }`.
- **`GET /api/v1/status`** returns the full dashboard payload (§9), with no-store.
- **`GET /`** returns the server-rendered dashboard, `Cache-Control: no-cache`.
- **`GET /observations/:sourceId/latest.jpg`** serves the latest image (`no-cache`). **`GET /observations/:sourceId/:id.jpg`** serves a stored frame (`public, max-age=86400, immutable`). For both:
  - the source id is validated against `SOURCE_ID`;
  - a numeric id must match an `observations` row whose `image_file` is not null;
  - the resolved path must stay inside `data/observations`;
  - anything else returns 404.
- **Static files:** `/static/*` serves `static/` (1 h max-age) and `/assets/*` serves `client/` (5 min).
- **Fallbacks:** unknown routes return `404 NOT_FOUND`. Every response carries `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin` and `X-Frame-Options: DENY`. There are no CORS headers.

### 7.3 Admin (`/admin`, `/admin/api/*`)

- Without `ADMIN_PASSWORD`, every `/admin*` route returns 404.
- **Login:** `POST /admin/api/login {password}`.
  - Per IP: 10/min, burst 5.
  - A wrong password waits 600 ms, then returns 401 and emits `auth.failure`.
  - Success sets the `obs_admin` cookie: HMAC-SHA256-signed timestamp keyed by `SESSION_SECRET` (falling back to a hash of the password), httpOnly, `SameSite=Strict`, `Secure` when `SECURE_COOKIES`, 7-day lifetime.
- **CSRF:** every non-GET `/admin/api` request must send `Origin` equal to the origin of `PUBLIC_URL` (or the request's host when `PUBLIC_URL` is unset). Otherwise it gets 403.
- **Routes:**
  - `GET me`, `POST logout`
  - `GET adapters`
  - `GET|POST sources`
  - `GET|PATCH|DELETE sources/:id`
  - `POST sources/:id/capture`
- All routes except `login`, `logout` and `me` need the cookie (otherwise `401 AUTH_REQUIRED`). Registry validation errors return 400; an unknown source returns 404.
- `client/admin.html` + `client/js/admin.js` generate their forms from each adapter's `configSchema`.

## 8. Persistence (`server/db.js`)

SQLite file `data/observatory.sqlite` (WAL).

| Table | Columns / purpose |
|---|---|
| `sources` | id PK, name, type, enabled, config JSON, created/updated, last_success_at, success_count, failure_count, last_error, last_error_at |
| `observations` | id AUTOINCREMENT, source_id, observed_at, kind, vals JSON, image_file, width, height, referenced (0/1) |
| `frame_analyses` | source_id, observation_id, analyzed_at, classification, mean_abs_diff, changed_fraction, histogram JSON, mean_luma_prev/curr, exposure_shift, activity, interval_ms, processing_ms, settings JSON |
| `events` | ts, level, type, source_id, message, data JSON (never secrets or random material) |
| `telemetry_minutes` | PK (minute, metric); count, sum, max, bytes, errors. Metrics: `heartbeat`, `random`, `capture:<sourceId>` |
| `meta` | `last_start` (decides between the started and restarted events) |

Files live in `data/observations/<sourceId>/{latest.jpg, <obsId>.jpg}`. Temp files start with `.capture-`.

**Write volume:** about 2 rows plus 2 events per capture. API metrics are aggregated in memory and upserted once a minute. Events of the routine types (`observation.captured`, `analysis.completed`, `random.fulfilled`) are capped by row count rather than by age.

**Retention defaults:**

| What | Default |
|---|---|
| Observations and analyses | 7 days |
| Referenced images | 7 days |
| Events | 30 days, at most 20 000 rows |
| Routine events | 2 000 rows per type |
| Telemetry | 30 days |

**DB failure handling:** the RNG path never touches the database. Event and telemetry writes that fail call `integrity.dbError()`, and the dashboard then shows the Observation Integrity Monitor as `DEGRADED` for 5 min. Events stay readable from a 200-entry in-memory ring.

## 9. Status payload and telemetry (`server/web/status.js`)

`buildStatus()` returns:

```
{ service, generatedAt, uptimeSec,
  subsystems: [ Cryptographic Randomness Core, Random Material Distribution API, Environmental Observation Array,
                Environmental Input Conditioning, Observation Integrity Monitor ] (name + status),
  rng: core.status(),
  api: { status, requestsOk, requestsFailed, bytesServed, authFailures, rateLimited, withEnvironmental, withoutEnvironmental,
         lastSuccessAt, lastFailureAt, latency: { p50, p95, max }, lastUse: { at, observations }, maxBytes },
  conditioning: { status: ACTIVE|IDLE, mode: 'hkdf-salt', entropyCredit: 'none', contributing[], maxAgeMs },
  integrity, sources: registry views, events: last 40, telemetry }
```

**Subsystem rules:**

- **Distribution API:** `NOT_CONFIGURED` with no keys; otherwise mirrors the RNG status.
- **Observation Array:**
  - `NOT_CONFIGURED` with no sources;
  - `DISABLED` if every source is disabled;
  - otherwise the worst state among enabled sources (all `OPERATIONAL` → `OPERATIONAL`, all `UNAVAILABLE` → `UNAVAILABLE`, all `STARTING` → `STARTING`, anything else → `DEGRADED`).
- **Conditioning:** `ACTIVE` when at least one fresh observation exists, else `IDLE`.

**Latency percentiles** come from a fixed histogram (1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000 ms, then ∞). They are held in memory and reset on restart.

**Telemetry** covers a 6 h window in 36 ten-minute buckets of `{ t, v }`:

- **API series:** `apiRequests`, `apiBytes`, `apiLatency` (mean), `apiErrors`.
- **Per source:** `availability` (ok / (ok + errors), null when there were no attempts), `captures`, and `activity` (mean of `frame_analyses.activity`, camera only).
- **Missing data:** a bucket counts as collected only if it has a heartbeat (recorded every 60 s while running, plus at startup) or any recorded metric. Otherwise `v` is `null` and renders as a gap, never as zero.

## 10. Dashboard and Open Graph

**Rendering:**

- `client/js/render.js` and `charts.js` are pure functions that build HTML/SVG strings with every value escaped.
- The server imports them for the initial HTML, so the page works without JavaScript.
- In the browser, `dashboard.js` fetches `/api/v1/status` 5 s after load and then every 5 s, re-renders the panels and keeps the event-log scroll position. After failed fetches it backs off exponentially up to 60 s.
- The header clock ticks every second.

**Panels:**

- **A. Observation Source Registry:** table of sources, `MEASUREMENT` tag, "entropy assessment: none", last error.
- **B. Environmental Observation Array:** per camera, the latest image plus subject, capture time and age, dimensions, interval, OK/failed counts, success ratio and processing state. `NOT CONFIGURED` when there is no camera.
- **C. Frame Differential Analysis:** classification, activity gauge with threshold ticks, difference histogram, readouts, preprocessing settings, and a note on methodology and the "not entropy" disclaimer.
- **D. Cryptographic Randomness Core:** RNG and API readouts, plus the **Environmental Input Conditioning** sub-panel: mode, contributing observations, freshness window, the observation used by the most recent request (linked to its frame), and counts of requests with and without observations.
- **E. Operational Event Log:** last 40 events.
- **F. Historical Telemetry:** SVG bar and line charts. Empty series read "NO DATA COLLECTED".

**Styling:** CSS custom properties with light and dark themes (`prefers-color-scheme`, overridable through `data-theme`). The two-column grid collapses to one column at ≤ 900 px. Checked at 375 px with no horizontal page overflow.

**Open Graph** (in the initial HTML, from `web/dashboard.js`):

- **Title:** `The Observatory — Environmental Observation & Cryptographic Randomness`.
- **Description:** `Observing the physical world. Serving cryptographically secure randomness.`
- **Canonical URL / `og:url`:** `${PUBLIC_URL}/`.
- **Type:** `og:type=website`.
- **`og:image`:**
  - The latest valid image of the first enabled camera, falling back to any camera: `${PUBLIC_URL}/observations/<id>/latest.jpg?v=<observedAtMs>`, with its width and height.
  - Before any capture: `${PUBLIC_URL}/static/og-fallback.png` (1200×630).
  - A failed capture leaves the URL unchanged.
- **Twitter:** `twitter:card=summary_large_image`, plus title, description, image and alt.

## 11. Logging and events

**Logging:**

- `log.js` writes JSON lines to stdout.
- These field names are redacted at any depth: `authorization`, `cookie`, `key`, `apikey`, `api_key`, `data`, `password`, `secret`, `salt`, `digest`, `ikm`.
- Buffers are logged as `[buffer]`.
- `LOG_LEVEL` sets the minimum level.

**Event types:**

| Group | Types |
|---|---|
| Service | `service.started`, `service.restarted` |
| Sources | `source.registered`, `source.configured`, `source.enabled`, `source.disabled`, `source.removed`, `source.disconnected`, `source.reconnected`, `sources.init_failed` |
| Observations | `observation.captured`, `analysis.completed`, `capture.failed` |
| Random material | `random.fulfilled`, `rng.failure` |
| Access control | `auth.failure`, `ratelimit.exceeded` |

## 12. Configuration (`server/config.js`, `.env.example`)

| Variable | Default | Notes |
|---|---|---|
| `PORT` / `HOST` | 3100 / 127.0.0.1 | |
| `PUBLIC_URL` | unset | Base for absolute OG URLs and the admin Origin check. Without it, the request's host and protocol are used |
| `REQUIRE_HTTPS` | false | `true` in production |
| `OBSERVATORY_API_KEYS` | — | `id:key,id:key`. Ids are `[A-Za-z0-9_.-]{1,64}`. Keys must be ≥ 32 chars or startup fails. The `.env.example` placeholder is deliberately too short |
| `OBSERVATORY_API_KEY` | — | Single key with id `default` |
| `MAX_RANDOM_BYTES` | 1024 | 1–8160 |
| `RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_BURST` | 30 / 10 | Per API key |
| `PUBLIC_RATE_LIMIT_PER_MINUTE` / `_BURST` | 120 / 60 | Per IP |
| `ADMIN_PASSWORD` | unset (admin disabled) | |
| `SESSION_SECRET` | derived from password | |
| `SECURE_COOKIES` | false | `true` in production |
| `OBSERVATORY_SEED_CAMERA` (+ `_CAMERA_DEVICE`, `_CAMERA_SUBJECT`) | false | Creates `camera-1` on first start if there are no sources |
| `ENV_MAX_AGE_MS` | 600000 | Freshness window for the salt |
| `OBSERVATION_RETENTION_DAYS`, `REFERENCED_IMAGE_RETENTION_DAYS`, `EVENT_RETENTION_DAYS`, `EVENT_MAX_ROWS`, `ROUTINE_EVENT_MAX_ROWS`, `TELEMETRY_RETENTION_DAYS` | 7, 7, 30, 20000, 2000, 30 | |
| `DATA_DIR`, `DB_FILE`, `FFMPEG_PATH`, `LOG_LEVEL` | `data`, `data/observatory.sqlite`, `ffmpeg`, `info` | |

`createServer(options)` accepts the same settings directly, plus test hooks: `randomBytes`, `adapters`, `logger`, `now`, `timers`, `startSources`, `staticDir`, `clientDir`.

**Timers:** a heartbeat and telemetry flush every 60 s, and a prune every 10 min. Both are unref'd, and `timers: false` disables them for tests.

**Shutdown:** `close()` clears the timers, stops sources, flushes telemetry, closes HTTP and closes the DB. `main()` calls it on SIGINT and SIGTERM.

## 13. Reference consumer (`examples/observatory-client.js`)

`createObservatoryClient({ baseUrl, apiKey, timeoutMs=5000, maxRetries=2, backoffMs=500, maxRetryAfterMs=10000, fetchImpl, sleep })` returns `{ fetchRandom(n), fetchSeed() }`.

**Response validation** (`validateRandomResponse`, which raises `INVALID_RESPONSE` on any failure):

- the body is an object;
- `requestId` is present;
- `encoding === 'base64url'` and `bytes === n`;
- `data` matches the base64url alphabet and decodes to exactly `n` bytes;
- `timestamp` parses;
- `environmentalInput` is null or `{ sources: [] }`.

**Retries:**

- **Retried:** `TIMEOUT` (AbortController), `NETWORK_ERROR`, 429 and 5xx. Backoff is jittered with `crypto.randomInt`, and a 429's `Retry-After` is honored when it is ≤ 10 s; a longer one fails immediately.
- **Not retried:** 4xx and `INVALID_RESPONSE`.
- **Worst case:** about 17 s, well inside a 60 s polling cycle.

**CLI:** `node examples/observatory-client.js` prints metadata only, never the bytes.

[INTEGRATION.md](INTEGRATION.md) documents the dice pattern in prose and snippets only; the example code doesn't include it. The pattern:

- the ChaCha20 key is `sha256(observatorySeed || randomBytes(32))`, with a zero nonce and a fresh key on every reseed;
- if a fetch fails, keep rolling on the current key;
- rejection sampling with `limit = 256 − 256 % sides`.

## 14. Deployment and documentation

| Doc | Contents |
|---|---|
| [INSTALL.md](INSTALL.md) | brew prerequisites (`nvm ffmpeg caddy`), Node 24, `.env`, startup via `npm start` or the LaunchAgent (`launchctl bootstrap/kickstart/bootout gui/$(id -u)`), reboot camera check, Caddy, updating, key rotation |
| [CAMERA.md](CAMERA.md) | device listing, manual capture, mode errors, settings table, TCC permission under Terminal vs LaunchAgent (`tccutil reset Camera`), `file:` trials, retention and disk estimate (~0.5–2 GB / 7 days at one 60 s consumer), no-camera operation |
| [API.md](API.md) | endpoint reference |
| [INTEGRATION.md](INTEGRATION.md) | consumer contract, retries, 60 s polling, dice |
| [ADAPTERS.md](ADAPTERS.md) | adding source types |
| [RANDOMNESS_AND_ENTROPY.md](RANDOMNESS_AND_ENTROPY.md) | exactly what enters HKDF, why it can't be weaker than the OS CSPRNG, and what isn't claimed |
| `deploy/Caddyfile` | `observatory.elliscode.com { encode gzip; reverse_proxy 127.0.0.1:3100 }` |
| `deploy/com.elliscode.observatory.plist` | LaunchAgent template (KeepAlive, ThrottleInterval 10, PATH includes `/opt/homebrew/bin`, logs to `~/Library/Logs/the-observatory.log`) |

## 15. Tests (`npm test` → `node --test "test/**/*.test.js"`)

46 tests. HTTP tests start the real server on port 0 with a temp data directory, `timers: false`, and a fake camera: a fake JPEG header readable by `imageSize`, scripted grayscale frames, and inert timers.

| File | Covers |
|---|---|
| `randomness-api.test.js` | exact byte counts (1/32/1024); 100 distinct values and ids; no-store headers; 401 for missing, malformed, wrong and removed keys, with no key echoed; all invalid bodies, including text/plain, missing Content-Type, empty body and oversize body; per-key 30/min burst 10 with `Retry-After`, independent per key; auth-failure IP limit; `REQUIRE_HTTPS` with a forwarded proto; `imageUrl` served and frame pinned through history pruning |
| `crypto.test.js` | injected `randomBytes` is used; no `Math.random` in `server/`; core imports only `node:crypto`; salt changes output and identical inputs reproduce it; known-answer check against `hkdfSync` with and without salt; distinct outputs with a constant salt; lengths up to 8160; a throwing or malformed salt provider gives an empty salt; RNG failure gives `RngUnavailableError` / HTTP 503 with no data and health 503; frozen clock still gives distinct outputs; camera, boundary and pinning failures don't affect `/random`; stale digests excluded; length-prefixed digest; salt independent of submission order |
| `frame-diff.test.js` | reproducibility; static; low light; exposure-shift compensation; geometry and replaced-scene discontinuities; thresholds; blur on flat input |
| `sources.test.js` | operation with no sources; latest.jpg updated on success and kept on failure; health transitions and events; tiny or corrupt frames; dark scenes; bounded history and referenced-retention pruning; ffmpeg argument construction; a new adapter type end to end; config validation |
| `dashboard.test.js` | OG/Twitter tags with the fallback, then the latest photo, kept after a failed capture; no keys, paths or random material in HTML, status or event rows; real counters; telemetry gaps are null; image-route traversal returns 404 |
| `admin.test.js` | 404 when disabled; 401 before login; wrong password; httpOnly cookie; cross-origin and missing-Origin requests get 403; create, disable, invalid config, list, delete |
| `client-contract.test.js` | reference client against the real server (success, 401, oversize request); invalid responses not retried; 503 retried exactly twice; 429 honoring `Retry-After`, and a long `Retry-After` failing fast; timeouts; network failure |

## 16. Verification performed and known limitations

**Verified on the development MacBook:**

- The full test suite passes.
- The real FaceTime camera captures correctly through `captureJpeg` (about 2.9 s including warm-up; decoded mean luminance about 151, so frames are not dark).
- The app runs end to end with a `file:` test-pattern camera: captures, analysis, the conditioning panel showing `ACTIVE`, and screenshots at desktop and 375 px.
- `/admin` returns 200 when enabled.

**Not yet verified:**

- The full app capturing from the real camera in a long-running process.
- Deployment on the Mac Mini.
- Camera permission under the LaunchAgent. TCC attributes it to the agent's `node`, not Terminal, so the reboot check in INSTALL.md is required.

**Known limitations:**

- Rate-limiter buckets, API counters and latency percentiles are in memory and reset on restart. Persisted telemetry covers history.
- Structural correlation isn't persisted in `frame_analyses`, so the dashboard shows "—" for it after a restart until the next analysis.
- Registry views and `/status` are computed on every request. That's fine at hobby scale, but nothing is cached.
- Social platforms cache OG images and metadata. `?v=` only helps platforms that re-scrape.
- Only the camera adapter exists. Other sensor types need an adapter (see ADAPTERS.md), and none that needs credentials or hardware should be added until it can be tested.
