# Integrating another application

The Observatory is consumed server to server over HTTPS. Consumers never import its code. Field details are in [API.md](API.md). This page covers the contract and the recommended usage pattern.

## Configuration in the consuming app's backend

| Variable | Example |
|---|---|
| `OBSERVATORY_URL` | `https://observatory.elliscode.com/api/v1` |
| `OBSERVATORY_API_KEY` | the key configured for this consumer in The Observatory's `OBSERVATORY_API_KEYS` |
| `OBSERVATORY_TIMEOUT_MS` | `5000` |

- Keep the key on the server. Never send it to a browser, put it in client-side JavaScript, or log it.
- CORS is not an authentication mechanism, and the API sends no CORS headers.
- Each consuming app should get its own key id (e.g. `oneshot:<key>`), so it has its own rate limit and can be revoked on its own.

## Reference client

[`examples/observatory-client.js`](../examples/observatory-client.js) is a dependency-free client you can copy into the consumer. It's tested against the real server and against misbehaving stubs.

```js
import { createObservatoryClient } from './observatory-client.js';

const observatory = createObservatoryClient({
  baseUrl: process.env.OBSERVATORY_URL,
  apiKey: process.env.OBSERVATORY_API_KEY,
  timeoutMs: Number(process.env.OBSERVATORY_TIMEOUT_MS) || 5000,
});

const seed = await observatory.fetchSeed();
// seed.bytes              Buffer of exactly 32 bytes
// seed.requestId          string
// seed.environmentalInput { sources: [{ id, name, observationId, observedAt, imageUrl? }] } | null
```

It validates every response and rejects it with `INVALID_RESPONSE` unless:

- `encoding` is `base64url`;
- the decoded length equals the requested byte count;
- `bytes` matches the request;
- `requestId` and `timestamp` are present and well-formed.

## Timeouts and retries

- **Timeout:** 5 s per attempt by default.
- **Retried (bounded):** network errors, timeouts, `429` and `5xx`. Default is 2 retries with jittered exponential backoff (about 0.25–0.5 s, then 0.5–1 s). A `Retry-After` header is honored if it is ≤ 10 s; otherwise the client gives up immediately.
- **Not retried:** `400`, `401`, `403`, `413` and invalid responses. These are bugs or configuration errors, and repeating them won't help.
- **Worst case:** about 17 s per cycle with the defaults, well inside a 60 s polling interval.
- **Never** retry in a tight loop or indefinitely. If a cycle fails, wait for the next tick.

## Recommended pattern: a seed every 60 seconds

The intended use is that the consumer fetches 32 bytes about once a minute. Every call returns new, unique material, whether or not any observation has changed since the last call.

```js
let current = null;

async function tick() {
  try {
    const seed = await observatory.fetchSeed();
    current = seed;            // or reseed a generator, see below
  } catch (err) {
    console.warn(`observatory seed fetch failed (${err.code}); keeping the current seed`);
  }
}
tick();
setInterval(tick, 60_000).unref();
```

32 bytes (256 bits) is the standard size for a seed or key. On the wire it is a 43-character base64url string; always decode it to bytes before use.

## Dice rolls (and other integers)

**Mapping random bytes to dice faces must avoid modulo bias.** `byte % 20` is biased: 256 is not divisible by 20, so faces 1–16 come up slightly more often than faces 17–20. Use rejection sampling.

Node's `crypto.randomInt()` and `crypto.randomBytes()` take no seed. If you want every roll to involve the Observatory's material, key a ChaCha20 stream with it. Mix in local randomness too, so the dice are never weaker than the local generator even if the network or the Observatory has a problem:

```js
import { createCipheriv, createHash, randomBytes } from 'node:crypto';

// Starts with a local key, so rolls work before the first fetch and during outages.
let cipher = createCipheriv('chacha20', randomBytes(32), Buffer.alloc(16));

// Call every 60 s with seed.bytes (exactly 32 bytes).
export function reseed(observatorySeed) {
  if (observatorySeed.length !== 32) throw new Error('expected 32 bytes');
  const key = createHash('sha256').update(observatorySeed).update(randomBytes(32)).digest();
  cipher = createCipheriv('chacha20', key, Buffer.alloc(16)); // fresh key per reseed, so a zero nonce is safe
}

// roll(20) -> 1..20 with every face exactly equally likely (sides <= 256).
export function roll(sides) {
  const limit = 256 - (256 % sides);        // 240 for a d20
  for (;;) {
    const b = cipher.update(Buffer.alloc(1))[0];
    if (b < limit) return (b % sides) + 1;  // reject 240–255 so no face gets an extra share
  }
}
```

How this pattern behaves:

- **Fetch failures:** if a fetch fails, keep rolling on the current key. ChaCha20 can safely produce vastly more output from one key than a minute of dice needs.
- **Nonce:** never reuse a key with the same nonce. Deriving a fresh key on every reseed takes care of that.
- **Plain alternative:** `crypto.randomInt(1, 21)` alone already gives perfect d20 rolls. The Observatory seed adds the story ("rolled with observatory randomness"), not extra security. The mixing above makes sure it never costs any security either.

### Showing the frame that seeded a roll

`seed.environmentalInput?.sources[0]?.imageUrl` is a public path such as `/observations/tank-cam/9120.jpg`. Join it with the Observatory origin (`new URL(imageUrl, 'https://observatory.elliscode.com')`) and use the result as an image URL. Frames referenced by a `/random` response are kept for 7 days by default. `environmentalInput` is `null` when no fresh observation was available, so handle that case.

## Error codes to handle

| Code | Suggested handling |
|---|---|
| `AUTH_REQUIRED`, `AUTH_INVALID` | Configuration error: alert, don't retry |
| `RATE_LIMITED` | Back off; you're polling too often |
| `RNG_UNAVAILABLE`, `INTERNAL`, `TIMEOUT`, `NETWORK_ERROR` | Transient: keep the current seed, try next cycle |
| `INVALID_RESPONSE` | Don't use the data; try next cycle |
| `INVALID_BYTES`, `BYTES_TOO_LARGE`, `UNKNOWN_FIELD`, `INVALID_JSON` | Client bug |

## Checklist

- [ ] Key stored only in the backend environment
- [ ] HTTPS base URL
- [ ] Per-request timeout, bounded retries, 60 s polling
- [ ] Response validated (decoded length = requested)
- [ ] Unbiased integer mapping (rejection sampling or `crypto.randomInt`)
- [ ] App keeps working when the Observatory is down
