# Adding an observation-source adapter

Sources are pluggable. The camera is the only adapter in v1, but a thermometer, CO₂ sensor, step counter or anything else plugs in the same way. Adding one never touches the randomness core, the API, or the dashboard layout.

## Responsibilities

| Part | Owns |
|---|---|
| **Adapter** (`server/sources/adapters/<type>.js`) | Acquiring data on a schedule and reporting observations or errors |
| **Measurement module** (e.g. `server/sources/analysis/frame-diff.js`) | Pure functions that turn raw data into measurements |
| **Registry** (`server/sources/registry.js`) | Lifecycle, health state, persistence, events, image retention, and handing digests to the conditioning boundary |
| **Conditioning boundary** (`server/conditioning/boundary.js`) | Turning the latest observation digests into an HKDF salt |
| **Randomness core** | Untouched: it only sees a 32-byte salt through an injected function |

## The contract

```js
export function createThermometerAdapter({ readSensor }) {
  return {
    type: 'thermometer',                       // unique, lowercase
    displayName: 'Thermal Measurement Subsystem',
    description: 'Basement temperature probe.',
    measurementKind: 'measurement',            // required; every adapter reports measurements
    entropyAssessment: 'none',                 // required; no adapter claims entropy
    configSchema: {
      device: { type: 'string', default: '/dev/tty.usbserial', label: 'Serial device' },
      intervalMs: { type: 'integer', default: 60000, min: 5000, label: 'Read interval (ms)' },
      apiToken: { type: 'string', default: '', secret: true },   // secret: never shown publicly
    },
    create(source, ctx) {
      let timer = null;
      const read = async () => {
        try {
          const celsius = await readSensor(source.config.device);
          await ctx.report({ observedAt: ctx.now(), kind: 'reading', values: { celsius, units: 'C' } });
        } catch (err) {
          ctx.reportError(err);
        }
      };
      return {
        start() { read(); timer = setInterval(read, source.config.intervalMs); timer.unref(); },
        stop() { clearInterval(timer); },
        captureNow: read,                      // optional: enables "Capture now" in /admin
        getStatus: () => ({ capturing: false }), // optional
      };
    },
  };
}
```

**`configSchema`**

- Field types: `string`, `integer`, `boolean`.
- Options: `default`, `min`, `max`, `maxLength`, `pattern` (RegExp), `label`, `help`, `secret`.
- Config is validated on create and update. Unknown fields are rejected.
- The `/admin` form is generated from the schema.

**`ctx`** (provided by the registry)

| Member | Purpose |
|---|---|
| `report(observation)` | Async. `{ observedAt, kind, values, image?, analysis?, processingMs?, intervalMs? }`. `image` is `{ tmpFile, width, height }`: the registry moves the file into place, updates `latest.jpg`, and serves it. `analysis` (frame-difference results) is stored in `frame_analyses` |
| `reportError(err)` | Counts a failed attempt. Health moves to `DEGRADED`, then `UNAVAILABLE` after 3 consecutive failures. The last valid observation is kept |
| `tmpPath(ext)` | A temp file inside the source's data directory |
| `now()` | The registry's clock. Use it for `observedAt` |
| `log` | Structured logger |

## Register it

Add it to the catalogue in [server/sources/adapters/index.js](../server/sources/adapters/index.js):

```js
return buildCatalogue([createCameraAdapter({ ffmpegPath }), createThermometerAdapter({ readSensor })]);
```

It then appears in `/admin`. Its observations show up in the Source Registry, Historical Telemetry (availability and captures) and the event log. Each successful reading's digest is mixed into `/random` output like camera frames, and the response lists the source in `environmentalInput.sources` (without an `imageUrl`).

## Rules

- **Readings are measurements.** Never describe them as random bits or entropy, and never add an entropy estimate.
- **Report real data only.** Never fabricate a reading or timestamp. A missing reading is a `reportError`, not a zero.
- **Never throw out of `start`, `stop` or timers.** Catch errors and call `ctx.reportError`.
- **Don't integrate hardware or credentials you can't test.** Leave the adapter out of the catalogue until its configuration and failure behavior have been exercised.
- **Write a test.** [test/sources.test.js](../test/sources.test.js) ("a new adapter type registers…") shows how to drive an adapter with no hardware.
