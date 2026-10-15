# Camera setup

The camera adapter (Optical Measurement Subsystem) captures still images with ffmpeg's macOS `avfoundation` input. Any webcam macOS recognizes works. No particular brand, lighting or subject is needed, and the rest of the application works without any camera.

## 1. List devices

```sh
ffmpeg -f avfoundation -list_devices true -i ""
```

```
AVFoundation video devices:
[0] FaceTime HD Camera
[1] Capture screen 0
```

Use the index (`0`) or the exact name (`FaceTime HD Camera`) as the source's **device**. Indexes can change when cameras are plugged or unplugged; a name is more stable.

## 2. Try a capture by hand

```sh
ffmpeg -f avfoundation -framerate 30 -video_size 1280x720 -i "0:none" \
  -vf "select=gte(n\,25)" -frames:v 1 -y /tmp/test.jpg
```

This is exactly what the adapter runs. The `select` filter discards the first 25 frames (about 1 second) so auto-exposure and white balance can settle. Each capture is a cold start, and without warm-up frames come out dark or mis-exposed, which the frame-difference analysis would misreport as activity.

If ffmpeg says **"Selected framerate (30.000000) is not supported by the device"** or **"Selected video size … is not supported"**, it prints the modes the camera does support, for example:

```
  1280x720@[30.000030 30.000030]fps
  640x480@[29.970000 29.970000]fps
```

Put the exact framerate string (e.g. `30.000030`) and a listed size into the source config. If ffmpeg complains about the pixel format, set **pixelFormat** to one it lists (commonly `uyvy422` or `nv12`).

## 3. Source settings

| Field | Default | Notes |
|---|---|---|
| `subject` | Unspecified subject | Free text shown on the dashboard |
| `device` | `0` | avfoundation index or name, or `file:/path/to.jpg` (see below) |
| `intervalMs` | 5000 | Time between the end of one capture and the start of the next |
| `width` × `height` | 1280 × 720 | Must be a mode the camera supports |
| `framerate` | `30` | Must match the camera's listed rate exactly |
| `pixelFormat` | (empty) | Optional |
| `warmupFrames` | 25 | Frames discarded before the kept frame |
| `historyCount` | 24 | Unreferenced frames kept (see retention) |
| `analysisWidth` × `analysisHeight` | 160 × 90 | Grayscale size used for frame differencing |
| `diffThreshold` | 12 | Per-pixel change (0–255) counted as "changed" |
| `blur` | on | 3×3 blur that suppresses compression noise |

## Camera permission

macOS asks for camera access the first time a process opens the camera.

- **Running `npm start` in Terminal:** the permission is granted to Terminal. Approve the prompt and you're done.
- **Running under the LaunchAgent:** TCC (macOS's privacy-permission system) attributes access to the *responsible process*, which is the agent's `node` binary, not Terminal. A grant you gave Terminal may not carry over. After loading the agent:
  1. Watch for a camera prompt on the Mini's screen (Screen Sharing works) and approve it.
  2. Reboot and confirm `curl -s localhost:3100/api/v1/health` shows `"camera": {"configured": true, ..., "status": "operational"}`.
  3. If captures fail, the dashboard's Source Registry shows ffmpeg's error (often "Input/output error" or a permission message). Reset and retry:
     ```sh
     tccutil reset Camera
     launchctl kickstart -k gui/$(id -u)/com.elliscode.observatory
     ```
     Then approve the prompt again.
  4. Fallback that always works: skip the LaunchAgent and run `npm start` in a Terminal window that opens at login (auto-login plus a Login Item for a script that runs it).

Capture failures are never silent:
- The source moves to `DEGRADED`, then `UNAVAILABLE` after 3 consecutive failures.
- The last valid image stays on display.
- The error text is shown on the dashboard and written to the event log.
- `/api/v1/random` keeps working.

## Camera-free trials

`device: file:/path/to/image.jpg` copies that file on each "capture". It's useful for testing the whole pipeline on a machine without a camera, or before the camera is mounted. Make a test image with:

```sh
ffmpeg -f lavfi -i testsrc=size=1280x720:rate=1 -frames:v 1 -y /tmp/testsrc.jpg
```

## Image retention and disk use

Each capture is saved as `data/observations/<sourceId>/<observationId>.jpg`, and `latest.jpg` is updated.

- Only the newest `historyCount` **unreferenced** frames are kept.
- Frames that were mixed into a `/random` response are marked *referenced* and kept for `REFERENCED_IMAGE_RETENTION_DAYS` (default 7), so a consumer can show "the frame that seeded this roll".
- `latest.jpg` is never pruned.

Disk estimate: one consumer polling every 60 s references about 1,440 frames a day. At around 50–200 KB per 720p JPEG that's roughly 0.5–2 GB over 7 days. Lower `REFERENCED_IMAGE_RETENTION_DAYS` if needed.

## No camera at all

Leave the registry empty. The dashboard shows `NOT CONFIGURED`, `/api/v1/health` reports `"camera": {"configured": false, "status": "not_configured"}`, and `/api/v1/random` returns `"environmentalInput": null`. Output security is unchanged, because it never depended on the camera.
