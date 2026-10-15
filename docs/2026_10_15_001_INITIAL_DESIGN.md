# Claude Implementation Handoff: The Observatory

## Environmental Observation & Cryptographic Randomness Infrastructure

## 1. Mission and design philosophy

Build a new, independent web application named **The Observatory**, hosted at:

- **Dashboard:** `https://observatory.oneshot.elliscode.com`
- **API base:** `https://observatory.oneshot.elliscode.com/api/v1`

The Observatory is an intentionally overengineered environmental observation and cryptographic randomness service.

It observes the physical world, records environmental measurements, analyzes changes between observations, and provides cryptographically secure random material through an authenticated HTTP API consumed by another application.

The project is inspired by Cloudflare's LavaRand, which uses imagery of a physical lava-lamp installation as supplemental input to a cryptographic randomness system.

Reference: https://blog.cloudflare.com/randomness-101-lavarand-in-production/

The Observatory explores the same broad idea on a small, hobbyist scale: collecting environmental observations and placing them inside an unnecessarily elaborate scientific-looking infrastructure.

Its camera might observe a turtle aquarium, a houseplant in a window, lava lamps, a container of LEGO bricks in a cement mixer, or any other physical scene. Future inputs might include wearable step counts, basement carbon dioxide levels, humidity, temperature, ambient light, or other sensor readings.

**The engineering should be sound. The presentation should be grandiose. The humor should come from the overengineering, not from misleading technical claims.**

### Non-negotiable principles

1. The operating system's cryptographically secure random-number generator is the foundation of trustworthy randomness.
2. Environmental sources are optional, experimental inputs and observations. They are not required for the randomness service to operate.
3. The project does not claim to be a quantum random-number generator or a certified entropy source.
4. Adding more sensors does not automatically increase security or establish additional entropy.
5. The system must remain useful even if every environmental source is disconnected.
6. Another application will consume the authenticated randomness endpoints. Keep the API stable, documented, and independent of that application's internal implementation.

The initial implementation is a hobby project, not an attempt to reproduce Cloudflare's complete security architecture or achieve equivalent security assurance.

## 2. Inspect the existing infrastructure first

Before coding, inspect the existing Mac Mini environment and relevant repositories to understand:

- Node.js and npm versions.
- Existing project and deployment conventions.
- How applications are started, restarted, and kept running.
- How Caddy routes HTTPS subdomains to local services.
- How environment variables and secrets are managed.
- Existing SQLite usage, if any.
- Available camera hardware and existing camera software.
- Available disk space and image-retention constraints.

Reuse established conventions where practical. Do not assume a webcam is already configured.

The application must work without any camera or sensor attached.

### Architecture

Use a standalone Node.js application, with Express if appropriate to the existing environment.

Suggested structure:

- Web dashboard and server-rendered HTML metadata.
- Authenticated randomness API.
- Observation-source registry.
- Camera and sensor adapters.
- Image-analysis pipeline.
- Optional environmental-data conditioning interface.
- Cryptographic randomness service.
- Operational telemetry and persistence.

Use SQLite for lightweight persistent history if consistent with the existing environment.

Do not introduce Docker, Kubernetes, Redis, microservices, OAuth, or unnecessary dependencies. Keep deployment simple enough to operate on the existing Mac Mini.

The application must have its own configuration, process, and source code. Do not modify unrelated applications or existing reverse-proxy routes unnecessarily.

## 3. Branding and visual design

The application name is **The Observatory**.

Dashboard title:

**THE OBSERVATORY**

Subtitle:

*Environmental Observation & Cryptographic Randomness Infrastructure*

Suggested institutional designation:

*Directorate of Environmental Measurement and Cryptographic Systems*

Suggested tagline:

*Observing the physical world. Serving cryptographically secure randomness.*

The interface should resemble a serious scientific observatory, research laboratory, or infrastructure operations console.

Use restrained typography, precise timestamps, instrument panels, technical labels, historical charts, subsystem status indicators, and carefully organized data.

Avoid making the default interface cartoonish. The comedy should emerge from the contrast between the solemn presentation and the absurdity of the observed subject.

Use grandiose terminology where appropriate, including:

- Environmental Observation Array
- Optical Measurement Subsystem
- Frame Differential Analysis
- Atmospheric Composition Monitor
- Human Locomotion Telemetry
- Observation Source Registry
- Environmental Input Conditioning
- Cryptographic Randomness Core
- Random Material Distribution API
- Observation Integrity Monitor
- Subsystem Operational Status

These are presentation names, not certifications or claims about security properties.

Make the dashboard responsive on desktop and mobile devices, including iPad Safari.

## 4. Dashboard

Implement the following sections.

### A. Observation Source Registry

This is a first-class feature, not a hardcoded camera widget.

The operator should be able to view registered sources and their current status. The architecture must allow additional source types to be added without redesigning the dashboard or rewriting the cryptographic service.

Each source should have:

- A unique identifier.
- A configurable display name.
- A source type and adapter.
- Enabled or disabled state.
- Configuration appropriate to its adapter.
- Latest observation and timestamp, when available.
- Connection and health status.
- Last successful update.
- Recent errors.
- A history of actual observations where appropriate.
- Clear documentation of whether it is an ordinary measurement source or has a defensible entropy assessment.

Provide a source-management interface for registering, configuring, enabling, disabling, and inspecting sources.

Protect configuration-changing operations. Do not expose privileged administration functions to unauthenticated public users.

The initial release should implement the camera adapter. Define the common source interface now so future adapters can be added independently.

Potential future adapters include:

- Webcam imagery.
- Temperature and humidity sensors.
- Ambient light sensors.
- Carbon dioxide sensors.
- Wearable step counts.
- Smart-home telemetry.
- Other environmental or physical measurements.

Do not attempt to integrate every possible source in the initial release. Implement a clean extension point and document how to add adapters.

### B. Environmental Observation Array

For camera sources, display:

- Latest successfully captured image.
- Configured observation subject.
- Capture timestamp.
- Time since last capture.
- Image dimensions.
- Capture interval.
- Number of successful captures and failures.
- Camera availability.
- Processing status.

The subject must be configurable. Do not hardcode turtle-specific assumptions.

If no camera is configured, show a clear `NOT CONFIGURED` state. The rest of the application must continue working normally.

### C. Frame Differential Analysis

Implement a simple, documented image-analysis pipeline.

For consecutive images, calculate actual measurements such as:

- Mean absolute pixel difference.
- Fraction of pixels exceeding a configurable change threshold.
- Distribution of pixel differences.
- Capture interval.
- Image-processing duration.
- Image dimensions and preprocessing settings.

Handle resolution changes, camera movement, compression artifacts, and exposure changes carefully enough to avoid treating every technical image change as meaningful scene motion.

Display a normalized observation-activity indicator if useful, with documented thresholds.

**Do not label frame differences as entropy measurements.**

A dark image, static scene, or high-motion image may be a valid observation, but none independently establishes a quantity of unpredictable entropy.

Keep the image-analysis implementation modular so other source types can use their own measurement pipelines.

### D. Cryptographic Randomness Core

Display actual runtime information about:

- Operating-system cryptographic randomness availability.
- Random-material generation status.
- API availability.
- Total successful and failed requests.
- Total bytes served.
- Request latency.
- Last successful request.
- Service uptime.
- Recent errors and recovery events.

Use truthful statuses such as `OPERATIONAL`, `DEGRADED`, and `UNAVAILABLE`.

The cryptographic RNG must remain operational when environmental sources fail.

Do not display fabricated entropy counts, unsupported certification labels, or claims that statistical tests prove unpredictability.

### E. Operational Event Log

Maintain a chronological record of events such as:

- Observation captured.
- Frame analysis completed.
- Sensor reading received.
- Source disconnected.
- Source reconnected.
- Random-material request fulfilled.
- Authentication failure.
- Rate limit exceeded.
- Service restarted.

Record real events with timestamps.

Never log API credentials, secret generator state, or complete returned random byte streams.

### F. Historical Telemetry

Provide useful charts and historical data for:

- Observation-source availability.
- Capture frequency.
- Frame-difference measurements.
- Sensor readings.
- API request volume.
- Bytes served.
- Request latency.
- Errors and recovery events.

Only show metrics that are actually collected. Missing data must appear as missing, not as fabricated readings.

Use bounded retention and reasonable write frequency. Do not persist every individual pixel sample or create unbounded histories.

## 5. Camera capture and optional environmental inputs

The camera pipeline must be independent of the randomness API.

For a configured camera:

1. Capture an image at a configurable interval, initially approximately five seconds.
2. Save the latest successfully captured image.
3. Record its timestamp and metadata.
4. Run frame-difference analysis.
5. Record the measurements.
6. Optionally expose processed data to the experimental conditioning interface.
7. Retain a bounded history if configured.
8. Isolate camera failures from the primary randomness service.

If a capture fails, preserve the previous valid image and mark the source as degraded or unavailable as appropriate.

A dark or static image must not stop the application or compromise the RNG.

The initial implementation should not require a specific webcam brand, sensor, lighting condition, or observation subject.

### Future source extensions

The source registry should use a documented adapter interface. An adapter should be responsible for acquiring its source's data and reporting observations and health.

Keep acquisition, measurement, persistence, and optional conditioning separate.

For example, a future wearable adapter might report a step count and its observation timestamp. A CO₂ adapter might report a concentration reading, units, and sensor status.

These values are measurements. They must not automatically be treated as unpredictable random bits.

Do not add integrations that require credentials or external hardware until their configuration and operational behavior can be tested.

## 6. Environmental input conditioning

Provide an explicit architectural boundary between environmental observations and the cryptographic randomness core.

Environmental inputs may be incorporated into a documented conditioning process in the future. However, the initial implementation must not depend on them for security.

Important distinctions:

- Hashing predictable data does not create entropy.
- Combining multiple correlated readings does not guarantee independent entropy contributions.
- Image differences do not quantify unpredictability.
- Statistical randomness tests do not establish that an attacker cannot predict an output.
- A photograph does not establish quantum origin.

If a conditioning mechanism is implemented, document exactly what data enters it and what security properties are assumed. Do not claim that including environmental data improves security unless that claim is supported by a defensible design and assessment.

Do not invent entropy estimates or display unsupported values such as `256 bits of environmental entropy`.

For the initial release, it is acceptable for environmental observations to be collected, analyzed, persisted, and displayed without being incorporated into random-number generation.

The system's primary random-material endpoint must use the operating system's cryptographically secure random source regardless.

## 7. Cryptographic randomness service

Use Node.js's built-in `crypto` module.

Use `crypto.randomBytes()` for random material and `crypto.randomInt()` for unbiased integer generation where appropriate.

Requirements:

- Never use `Math.random()` for security-sensitive output.
- Never implement a custom cryptographic PRNG.
- Never derive the primary random seed from environmental readings, timestamps, process IDs, or other predictable values.
- Never expose internal generator state or secret seeds.
- Generate fresh random material for every successful request.
- Do not cache random API responses.
- Keep randomness generation independent of camera and sensor availability.

The initial implementation does not require a custom entropy pool or a claim of independently verified physical entropy.

## 8. Production API

Expose a versioned API under `/api/v1`.

### A. Health endpoint

`GET /api/v1/health`

Return basic operational status without exposing secrets.

Illustrative response:

```json
{
  "status": "ok",
  "service": "the-observatory",
  "randomSource": "operating-system-cryptographic-rng",
  "camera": {
    "configured": false,
    "status": "not_configured"
  }
}
```

The actual response must reflect real runtime state. If multiple observation sources exist, provide a suitable summary or source-status listing.

This endpoint may be unauthenticated if it exposes only non-sensitive operational information. Apply reasonable rate limiting.

### B. Random-material endpoint

`POST /api/v1/random`

This is the primary integration contract for another application.

Example request:

```json
{
  "bytes": 32
}
```

Illustrative response:

```json
{
  "requestId": "example-request-id",
  "bytes": 32,
  "encoding": "base64url",
  "data": "example-random-material",
  "algorithm": "node-crypto-randomBytes",
  "timestamp": "2026-10-15T16:00:00.000Z"
}
```

The example values are placeholders, not actual random output.

Requirements:

- Authenticate every random-material request.
- Validate the request body.
- Require a positive integer byte count.
- Enforce a configurable maximum byte count.
- Return exactly the requested number of bytes.
- Generate fresh material for every successful request.
- Generate a unique request identifier.
- Return an accurate timestamp.
- Use an explicit encoding such as base64url.
- Set appropriate no-store cache headers.
- Apply request-size limits and rate limiting.
- Return structured errors with stable error codes.
- Never log the returned random material or API credentials.

The endpoint must not return a cached seed or the same precomputed material repeatedly.

### C. Optional die endpoint

Optionally implement:

`POST /api/v1/die`

Example request:

```json
{
  "sides": 20,
  "count": 1
}
```

Illustrative response:

```json
{
  "requestId": "example-request-id",
  "rolls": [17],
  "sides": 20,
  "timestamp": "2026-10-15T16:00:00.000Z"
}
```

If implemented, validate all parameters and use unbiased integer generation, such as `crypto.randomInt()`.

This endpoint is optional. The random-material endpoint is the primary deliverable.

## 9. API authentication and access control

The dashboard is public. The random-material endpoint is authenticated.

Use a high-entropy shared API key supplied through environment configuration.

Example:

`OBSERVATORY_API_KEY`

A separate consuming application will configure the same secret on its backend and send it with authenticated requests.

Requirements:

- Never commit secrets to source control.
- Include placeholders only in `.env.example`.
- Never expose the API key to browser JavaScript or public HTML.
- Require HTTPS for production API requests.
- Compare credentials safely.
- Return `401` for missing or invalid credentials.
- Apply per-client or per-key rate limits.
- Support key rotation.
- Avoid logging credentials.
- Do not rely on CORS as an authentication mechanism.
- Do not expose internal generator state or secret random material.

Keep public health information separate from privileged operational and configuration functions.

## 10. Integration with another application

The Observatory must be consumable by another application through its production HTTPS API without importing its internal modules.

Document a minimal server-to-server integration contract.

The consuming application's backend will configure:

- `OBSERVATORY_URL`
- `OBSERVATORY_API_KEY`
- A configurable request timeout.

Default API base:

`https://observatory.oneshot.elliscode.com/api/v1`

The consuming application should be able to request random material, validate the response, and use the returned bytes according to its own requirements.

Document the request and response schemas, authentication header, supported byte counts, error codes, rate limits, and timeout behavior.

The consuming application is responsible for its own application logic and for mapping random material to its particular use case.

If it uses raw bytes for dice, its integer-mapping algorithm must avoid modulo bias. For example, using one random byte followed by `% 20` can introduce bias because 256 is not divisible by 20. Use rejection sampling or an equivalent unbiased mapping, or use the optional die endpoint.

The Observatory must never assume that a consumer is a browser application. Keep credentials and privileged API calls server-side.

Document sensible timeout and retry behavior. Clients must not retry indefinitely or overwhelm the service during an outage.

## 11. Reliability and security

- Keep dashboard routes separate from authenticated API routes.
- Validate all input and cap request sizes.
- Apply rate limits.
- Use safe cache-control headers.
- Handle camera disconnection and corrupted images gracefully.
- Preserve the last valid image after a capture failure.
- Keep the random-material API available without camera hardware.
- Avoid excessive database writes.
- Use structured logging.
- Do not expose secrets or raw random material in logs.
- Never fabricate sensor readings, timestamps, entropy estimates, or subsystem status.
- Keep operational diagnostics separate from secret configuration.
- Ensure application restarts do not depend on a camera or external sensor being available.

## 12. Open Graph and social previews

Configure server-rendered metadata for:

`https://observatory.oneshot.elliscode.com/`

Required metadata:

- Title: `The Observatory — Environmental Observation & Cryptographic Randomness`
- Description: `Observing the physical world. Serving cryptographically secure randomness.`
- Canonical URL: `https://observatory.oneshot.elliscode.com/`
- Open Graph type: `website`
- Open Graph image: the latest successfully published observation photograph.

Requirements:

- Use absolute HTTPS URLs.
- Keep the latest valid photograph when a new capture fails.
- Provide a valid fallback image before the first capture.
- Include image dimensions when known.
- Include appropriate Twitter/X card metadata.
- Ensure metadata appears in the initial HTML response.
- Do not rely solely on client-side JavaScript to update social previews.
- Do not expose internal filesystem paths or private endpoints.

Document that social platforms may cache images and metadata.

## 13. Persistence and data retention

Use SQLite or the existing preferred lightweight persistence mechanism.

Persist only what is useful:

- Registered source configurations.
- Source status and recent errors.
- Capture metadata and bounded image history.
- Frame-difference measurements.
- Sensor observations and timestamps.
- API request metadata.
- Aggregate request counts and latency.
- Operational events.

Avoid storing unlimited photographs, every raw pixel sample, or complete random-material responses.

Make image retention configurable and bounded. Preserve the latest valid image independently of the historical retention policy.

Ensure that a database failure or unavailable camera does not silently cause the cryptographic RNG to use a weaker source.

## 14. Automated testing

### Randomness API

Test that:

- Valid authenticated requests return exactly the requested byte count.
- Invalid credentials are rejected.
- Invalid, zero, negative, non-integer, and excessive byte counts are rejected.
- Rate limiting works.
- Responses are not cacheable.
- Errors do not expose secrets.
- Every successful request generates fresh material.

### Cryptographic behavior

Test that:

- The implementation uses Node.js cryptographic APIs.
- Security-sensitive generation does not use `Math.random()`.
- Die results, if supported, are in range and unbiased by construction.
- Camera failure does not prevent secure random generation.
- Missing environmental inputs do not trigger predictable fallback randomness.
- Optional conditioning failures cannot compromise the primary RNG.

### Observation sources

Test that:

- The dashboard works without a camera.
- Successful captures update the latest image.
- Failed captures preserve the last valid image.
- Frame-difference analysis produces reproducible measurements for fixed inputs.
- Dark and static scenes are handled safely.
- Source health accurately reflects runtime state.
- New source adapters can be added without modifying the randomness API's core implementation.

### Dashboard and Open Graph

Test that:

- Initial HTML includes the expected metadata.
- The latest valid photograph is referenced.
- A fallback image works before the first capture.
- Telemetry reflects actual state.
- API credentials and random material are never exposed.

### Consumer integration contract

Test and document:

- Successful authenticated requests.
- Invalid responses.
- Timeouts and network failures.
- Rate-limit responses.
- Response validation.
- Correct byte-count interpretation.
- Stable error codes.

## 15. Deployment and documentation

Deliver:

- Complete application source.
- Dependency manifest and lockfile.
- `.env.example` with placeholders only.
- Local development instructions.
- Production startup and restart instructions.
- Caddy routing instructions for `observatory.oneshot.elliscode.com`.
- API documentation with example requests and responses.
- Authentication and key-rotation instructions.
- Integration documentation for a separate consuming application.
- Camera setup instructions.
- Documentation for adding new observation-source adapters.
- No-camera operation instructions.
- Automated tests and commands to run them.
- Documentation of the distinction between cryptographic randomness, environmental measurements, and verified entropy.

Keep the initial release focused. Do not add user accounts, OAuth, a complex administration system, a distributed entropy network, or unrelated features.

## 16. Definition of done

The project is complete when:

1. The independent application runs on the Mac Mini.
2. The dashboard is available at `https://observatory.oneshot.elliscode.com`.
3. The dashboard displays actual subsystem status and observation data.
4. Open Graph previews use the latest valid observation image or a fallback.
5. The source registry supports the camera adapter and provides a clean extension point for future sources.
6. Frame-difference analysis records actual measurements without presenting them as entropy estimates.
7. The authenticated API returns fresh cryptographically secure random material.
8. The API works without any camera or environmental sensor.
9. Another application can consume the API securely using the documented contract.
10. Automated tests cover security, validation, failure handling, and unbiased die mapping if applicable.
11. Deployment and maintenance instructions are complete.
12. All technical claims accurately distinguish observed environmental data from verified cryptographic properties.

Inspect the existing environment before implementation. Build the smallest complete solution, run the tests, and report exactly what changed, how to run it, how to deploy it, and how another application can integrate with the production API.

**Final principle:** The Observatory should look like an institution that has spent millions studying the physical world to support an operation that Node.js already performs perfectly well. Make the engineering reliable, the measurements honest, the architecture extensible, and the presentation magnificently excessive.