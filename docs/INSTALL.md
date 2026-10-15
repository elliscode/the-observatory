# Installing The Observatory on the Mac Mini

These steps assume the Mac Mini matches the development MacBook: Homebrew, nvm, Node 24, Caddy and ffmpeg. Every `brew` command below is safe to re-run.

## 1. Prerequisites

```sh
brew install nvm ffmpeg caddy

# nvm setup (skip if `nvm --version` already works)
mkdir -p ~/.nvm
# Add the lines `brew info nvm` prints to ~/.zshrc, then open a new terminal.

nvm install 24
nvm use 24
node -v        # v24.x

ffmpeg -version | head -1
caddy version
```

If Caddy isn't already running as a service (it is if other sites are served from this machine):

```sh
brew services start caddy
```

## 2. Get the code and dependencies

```sh
cd ~/git
git clone <repo-url> the-observatory   # or git pull in an existing checkout
cd the-observatory
nvm use                                 # reads .nvmrc (24)
npm ci --omit=dev
```

## 3. Configure

```sh
cp .env.example .env
openssl rand -base64 32    # one API key per consuming application
openssl rand -hex 32       # SESSION_SECRET
```

Edit `.env`:

| Setting | Value |
|---|---|
| `PUBLIC_URL` | `https://observatory.elliscode.com` |
| `HOST` / `PORT` | `127.0.0.1` / `3100` |
| `REQUIRE_HTTPS` | `true` |
| `OBSERVATORY_API_KEYS` | `oneshot:<key>` (add more consumers comma-separated) |
| `ADMIN_PASSWORD` | a strong password, or empty to disable `/admin` |
| `SESSION_SECRET` | the hex string |
| `SECURE_COOKIES` | `true` |

`.env` is git-ignored. Never commit it.

## 4. Find the camera

```sh
ffmpeg -f avfoundation -list_devices true -i ""
```

Note the video device index or name. [CAMERA.md](CAMERA.md) covers mode discovery (framerate and pixel format) and the macOS camera permission.

## 5. Start it

**Simple (same as dungeons-and-ellis):**

```sh
npm start
```

Stop it with Ctrl-C. Restarting is always safe: state is in `data/observatory.sqlite`, and startup never waits for a camera.

**Supervised (optional LaunchAgent):**

1. Copy `deploy/com.elliscode.observatory.plist` to `~/Library/LaunchAgents/`. Replace `/Users/YOU` and set the node path to the output of `nvm which 24`.
2. Turn on automatic login for this user (System Settings → Users & Groups). Camera access only exists inside a logged-in GUI session, which is why this must be a LaunchAgent, not a LaunchDaemon.
3. Load it:
   ```sh
   launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.elliscode.observatory.plist
   ```
4. Restart after code changes:
   ```sh
   launchctl kickstart -k gui/$(id -u)/com.elliscode.observatory
   ```
5. Stop and unload:
   ```sh
   launchctl bootout gui/$(id -u)/com.elliscode.observatory
   ```
6. Logs are in `~/Library/Logs/the-observatory.log`.

**Then check the camera survives a reboot:**

1. Reboot the Mini and let it auto-login.
2. Run `curl -s localhost:3100/api/v1/health`.
3. `camera.status` should be `operational`. If it is `unavailable`, the dashboard's Source Registry shows ffmpeg's error. See "Camera permission" in [CAMERA.md](CAMERA.md).

## 6. Caddy

Append the block from `deploy/Caddyfile` to the Mini's Caddyfile (`/opt/homebrew/etc/Caddyfile` for a Homebrew install), then:

```sh
caddy validate --config /opt/homebrew/etc/Caddyfile
caddy reload --config /opt/homebrew/etc/Caddyfile
```

DNS for `observatory.elliscode.com` must point at the Mini, the same way the other subdomains do. Caddy obtains the certificate on the first request.

## 7. Register the camera

Open `https://observatory.elliscode.com/admin`, sign in, and register a camera source:

- type `camera`
- device from step 4
- a subject, such as "Turtle aquarium"

Alternatively, set `OBSERVATORY_SEED_CAMERA=true` (with `OBSERVATORY_CAMERA_DEVICE` and `OBSERVATORY_CAMERA_SUBJECT`) before the first start.

## 8. Verify

```sh
curl -s https://observatory.elliscode.com/api/v1/health
curl -s -X POST https://observatory.elliscode.com/api/v1/random \
  -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' -d '{"bytes":32}'
```

## Updating

```sh
cd ~/git/the-observatory
git pull
npm ci --omit=dev
# then restart: Ctrl-C + npm start, or launchctl kickstart -k gui/$(id -u)/com.elliscode.observatory
```

## Key rotation

1. Add the new key next to the old one: `OBSERVATORY_API_KEYS=oneshot:<old>,oneshot-2026:<new>`. Restart.
2. Switch the consumer's `OBSERVATORY_API_KEY` to the new key and deploy it.
3. Remove the old entry and restart again. Requests using the old key now get `401 AUTH_INVALID`.

Key ids show up in the event log and in rate limits. Keys never appear in logs.
