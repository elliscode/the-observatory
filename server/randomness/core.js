// Cryptographic Randomness Core.
//
// Every request gets 32 fresh bytes from the operating system's CSPRNG (crypto.randomBytes) as
// HKDF input key material. The latest environmental observation digest (if any) is mixed in as the
// HKDF salt, so observations genuinely change the output. Security rests entirely on the fresh OS
// bytes: HKDF output is secure whenever the input key material is secret, whatever the salt.
// The salt is not credited as entropy. Uniqueness of every response comes from the fresh OS bytes,
// never from the observation state — but the salt mixing is intentional and must not be removed.
//
// This module deliberately imports nothing from sources/, conditioning/ or the database. The salt
// provider is injected and treated as untrusted: if it throws or returns garbage, generation
// continues with an empty salt. There is no fallback generator: if the OS CSPRNG fails, the
// request fails.

import { randomBytes as osRandomBytes, hkdfSync } from 'node:crypto';

export const RANDOM_SOURCE = 'operating-system-cryptographic-rng';
export const ALGORITHM = 'hkdf-sha256(os-csprng-32B, environmental-salt)';
export const IKM_BYTES = 32;
export const HKDF_MAX_BYTES = 255 * 32;
const DEGRADED_WINDOW_MS = 5 * 60 * 1000;

export class RngUnavailableError extends Error {
  constructor(message = 'Operating-system random source unavailable') {
    super(message);
    this.code = 'RNG_UNAVAILABLE';
  }
}

export function createRandomnessCore({
  randomBytes = osRandomBytes,
  getEnvironmentalSalt = () => null,
  now = Date.now,
} = {}) {
  const state = {
    startedAt: now(),
    selfTest: { ok: false, at: null, error: null },
    generations: 0,
    failures: 0,
    saltErrors: 0,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastError: null,
    recoveredAt: null,
  };

  function osBytes(n) {
    const b = randomBytes(n);
    if (!Buffer.isBuffer(b) || b.length !== n) throw new Error('random source returned an unexpected value');
    return b;
  }

  function readSalt() {
    try {
      const env = getEnvironmentalSalt();
      if (!env) return null;
      if (!Buffer.isBuffer(env.salt) || env.salt.length !== 32 || !Array.isArray(env.observations)) {
        throw new Error('invalid environmental salt');
      }
      return env;
    } catch {
      state.saltErrors++;
      return null;
    }
  }

  return {
    selfTest() {
      try {
        osBytes(IKM_BYTES);
        state.selfTest = { ok: true, at: now(), error: null };
      } catch (err) {
        state.selfTest = { ok: false, at: now(), error: String(err?.message || err) };
      }
      return state.selfTest;
    },

    // Returns { data: Buffer(n), environmental: observations[] | null }.
    generate(n, context) {
      if (!Number.isInteger(n) || n < 1 || n > HKDF_MAX_BYTES) throw new RangeError('invalid byte count');
      const env = readSalt();
      let ikm;
      try {
        ikm = osBytes(IKM_BYTES);
      } catch (err) {
        state.failures++;
        state.lastFailureAt = now();
        state.lastError = String(err?.message || err);
        throw new RngUnavailableError();
      }
      // hkdfSync returns an ArrayBuffer, not a Buffer.
      const data = Buffer.from(hkdfSync('sha256', ikm, env ? env.salt : Buffer.alloc(0), `observatory/v1/random:${context}`, n));
      ikm.fill(0);
      if (state.lastFailureAt !== null && (state.lastSuccessAt === null || state.lastSuccessAt < state.lastFailureAt)) {
        state.recoveredAt = now();
      }
      state.generations++;
      state.lastSuccessAt = now();
      return { data, environmental: env ? env.observations : null };
    },

    status() {
      const t = now();
      let status = 'OPERATIONAL';
      if (!state.selfTest.ok && state.lastSuccessAt === null) status = 'UNAVAILABLE';
      else if (state.lastFailureAt !== null && state.lastSuccessAt !== null && state.lastFailureAt > state.lastSuccessAt) status = 'UNAVAILABLE';
      else if (state.lastFailureAt !== null && t - state.lastFailureAt < DEGRADED_WINDOW_MS) status = 'DEGRADED';
      return {
        status,
        randomSource: RANDOM_SOURCE,
        algorithm: ALGORITHM,
        osRandomAvailable: state.selfTest.ok || state.lastSuccessAt !== null,
        selfTest: { ...state.selfTest },
        generations: state.generations,
        failures: state.failures,
        environmentalSaltErrors: state.saltErrors,
        lastSuccessAt: state.lastSuccessAt,
        lastFailureAt: state.lastFailureAt,
        lastError: state.lastError,
        recoveredAt: state.recoveredAt,
        startedAt: state.startedAt,
        uptimeSec: Math.floor((t - state.startedAt) / 1000),
      };
    },
  };
}
