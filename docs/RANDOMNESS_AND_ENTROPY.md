# Cryptographic randomness, environmental measurements, and entropy

The Observatory looks like an institution measuring the physical world to produce randomness. This page states exactly what it does and what it does not claim.

## What produces the random material

For every `POST /api/v1/random` request ([server/randomness/core.js](../server/randomness/core.js)):

1. `ikm = crypto.randomBytes(32)`: 32 fresh bytes from the operating system's cryptographically secure random-number generator (on macOS, the kernel CSPRNG behind `getentropy`).
2. `salt` = a 32-byte digest of the latest fresh observation from each source, or an empty salt if there is none (see below).
3. `data = HKDF-SHA256(ikm, salt, info = "observatory/v1/random:" + requestId, length = bytes)`.

The response's `algorithm` field says this: `hkdf-sha256(os-csprng-32B, environmental-salt)`.

## Why it is never weaker than the OS generator

HKDF (RFC 5869) output is pseudorandom whenever its input keying material is secret and high-entropy. Here that material is 32 fresh bytes from the OS CSPRNG, generated per request, never stored and zeroed after use. The salt does not need to be secret or random for this to hold. A predictable, attacker-known, repeated or absent salt leaves the output exactly as strong as `randomBytes` alone.

So:

- A dark frame, a static scene, an unplugged camera or a failed conditioning step cannot weaken the output.
- Every response is unique because every response has its own fresh 32-byte key material. Uniqueness never depends on observations changing.
- If the OS random source fails, the request fails with `503 RNG_UNAVAILABLE`. There is no fallback generator, and the system never derives material from timestamps, process IDs or observations alone.

## What the observations do

The salt makes the observations really change the output: a different frame gives completely different bytes. The design intends this, and it is what makes "the turtle influenced this number" true. The salt mixing must not be removed as "dead code".

### What enters the salt

For each successful observation, the registry computes:

```
digest = SHA-256( "observatory/digest/v1"
                  || u32be(len(sourceId)) || sourceId
                  || u64be(observedAtMs)
                  || u32be(len(payload)) || payload )
```

The payload is the full JPEG file for camera sources, or the canonical JSON of the reading for other sources. The salt combines the latest digest from every source whose observation is younger than `ENV_MAX_AGE_MS` (default 10 minutes), in sorted source-id order:

```
salt = SHA-256( "observatory/salt/v1" || u32be(count)
                || for each source: u32be(len(id)) || id || digest )
```

All fields are length-prefixed, so different field splits cannot collide. Digests are never published.

## What we do not claim

- **No entropy credit.** We make no estimate of how much unpredictability an image contains, and we display none. Phrases like "256 bits of environmental entropy" would be invented numbers.
- **Hashing does not create entropy.** SHA-256 of a predictable image is still predictable to anyone who can reproduce the image.
- **Correlated readings are not independent.** More sensors do not automatically mean more unpredictability.
- **Frame differences are not entropy measurements.** The Frame Differential Analysis measures visible change in the scene. A busy scene is not "more random", and a dark or static scene is a valid observation.
- **Statistical tests don't prove unpredictability.** Passing them says nothing about whether an attacker can predict the output.
- **Not quantum, not certified.** A photograph doesn't establish quantum origin. This is a hobbyist installation, not a certified entropy source or a reproduction of Cloudflare's security architecture.

## How this compares to LavaRand

Cloudflare's [LavaRand](https://blog.cloudflare.com/randomness-101-lavarand-in-production/) also feeds camera imagery into systems whose security rests on conventional CSPRNGs. The camera is an additional, defense-in-depth input there too. The Observatory follows the same principle on a much smaller scale.

## Frame Differential Analysis thresholds

[server/sources/analysis/frame-diff.js](../server/sources/analysis/frame-diff.js) works in four steps:

1. **Preprocess:** scale each frame to 160×90 grayscale and apply a 3×3 box blur.
2. **Compensate exposure:** subtract the median signed pixel difference, a global brightness offset that local motion cannot skew.
3. **Measure:** compute the mean absolute difference, the fraction of pixels whose difference is over the threshold (default 12/255), and an 8-bin difference histogram.
4. **Classify** the frame using the table below.

| Condition | Classification |
|---|---|
| mean luminance < 8 | `low_light` (recorded, not interpreted) |
| geometry changed, or > 85% changed with structural correlation < 0.3 | `scene_discontinuity` (camera moved or reconfigured; baseline resets) |
| changed fraction < 0.5% | `static` |
| < 5% | `low` |
| < 25% | `moderate` |
| ≥ 25% | `high` |

Observation Activity = min(1, changed fraction ÷ 0.25).
