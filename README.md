# The Observatory

*Environmental Observation & Cryptographic Randomness Infrastructure*

Production: `https://observatory.elliscode.com` (Mac Mini + Caddy). API: `https://observatory.elliscode.com/api/v1`.

The Observatory is an intentionally overengineered environmental-observation and randomness service.

- **Observes:** it photographs a physical scene (a turtle aquarium, a houseplant, lava lamps…) and measures frame-to-frame change.
- **Displays:** everything appears on a solemn operations dashboard.
- **Serves:** cryptographically secure random material through an authenticated API for other applications.

The engineering is plain: every random response is derived from 32 fresh bytes from the operating system's CSPRNG. The latest observations are mixed in as an HKDF salt, so the turtle really changes the output, but no entropy credit is claimed and the output is never weaker than the OS generator. See [docs/RANDOMNESS_AND_ENTROPY.md](docs/RANDOMNESS_AND_ENTROPY.md).

## Local development

Needs Node 24 (`nvm use`) and, for camera capture, ffmpeg (`brew install ffmpeg`).

```sh
npm install
cp .env.example .env      # set OBSERVATORY_API_KEYS (openssl rand -base64 32) and ADMIN_PASSWORD
npm run dev               # http://127.0.0.1:3100, restarts on file changes
npm test                  # node --test
```

For local HTTP, set `REQUIRE_HTTPS=false` and `SECURE_COOKIES=false` in `.env`. Without them the API rejects plain HTTP with `403 HTTPS_REQUIRED`, and the admin cookie is never sent.

Try it:

```sh
curl -s localhost:3100/api/v1/health
curl -s -X POST localhost:3100/api/v1/random -H "Authorization: Bearer $KEY" \
  -H 'Content-Type: application/json' -d '{"bytes":32}'
```

**No camera?** Everything works. The dashboard shows `NOT CONFIGURED` and `/random` returns `"environmentalInput": null`. To exercise the camera pipeline without a camera, register a camera source with device `file:/path/to/image.jpg` (see [docs/CAMERA.md](docs/CAMERA.md)).

## Layout

| Path | Contents |
|---|---|
| `server/randomness/` | Cryptographic Randomness Core (`crypto.randomBytes` + HKDF) and `POST /api/v1/random`. Imports nothing from sources or the database |
| `server/conditioning/` | The only bridge from observations to randomness: observation digests become the HKDF salt |
| `server/sources/` | Observation Source Registry, adapter contract, camera adapter, ffmpeg helpers, Frame Differential Analysis |
| `server/web/` | Server-rendered dashboard (with Open Graph metadata), public routes, admin routes |
| `client/` | Dashboard CSS/JS; `client/js/render.js` renders panels on both server and browser |
| `examples/observatory-client.js` | Reference server-to-server client |
| `scripts/gen-fallback.js` | Generates `static/og-fallback.png` |
| `deploy/` | Caddy site block and optional LaunchAgent |

## Dashboard

`/` is server-rendered and refreshes itself from `/api/v1/status` every 5 seconds. Its panels:

- **A. Observation Source Registry**
- **B. Environmental Observation Array**
- **C. Frame Differential Analysis**
- **D. Cryptographic Randomness Core**, including Environmental Input Conditioning
- **E. Operational Event Log**
- **F. Historical Telemetry**

Every figure is a live runtime value. Periods with no collected data show as gaps, never zeros.

`/admin`, enabled when `ADMIN_PASSWORD` is set, registers, configures, enables, disables, test-captures and removes sources.

Open Graph tags are in the initial HTML. `og:image` is the latest valid observation photo, or `static/og-fallback.png` before the first capture. Social platforms cache previews aggressively, so a shared link may show an older photo for hours or days. The `?v=` parameter changes with each capture, which helps platforms that re-scrape.

## Documentation

| Doc | For |
|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | Mac Mini install (brew prerequisites), startup and restart, LaunchAgent, Caddy, key rotation |
| [docs/API.md](docs/API.md) | Endpoints, request and response schemas, error codes, rate limits |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | Consuming app contract: config, timeouts, retries, 60 s seed polling, unbiased dice |
| [docs/CAMERA.md](docs/CAMERA.md) | Camera setup, modes, macOS permission, retention, no-camera operation |
| [docs/ADAPTERS.md](docs/ADAPTERS.md) | Adding new observation-source adapters |
| [docs/RANDOMNESS_AND_ENTROPY.md](docs/RANDOMNESS_AND_ENTROPY.md) | What is and isn't claimed about randomness and entropy |
| [docs/2026_10_15_001_INITIAL_DESIGN.md](docs/2026_10_15_001_INITIAL_DESIGN.md) | Original design brief. Since then: the domain moved to `observatory.elliscode.com`, `/die` was dropped, and observations are mixed in via HKDF |
