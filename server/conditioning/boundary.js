// Environmental Input Conditioning boundary: the only bridge between observations and randomness.
//
// Sources submit a digest of each successful observation. currentSalt() combines the latest fresh
// digest from each source into a 32-byte HKDF salt for the randomness core. Observations are
// measurements; mixing them in as a salt is not credited as entropy and cannot weaken the output,
// because the core's security rests on fresh OS random bytes.
//
// All encodings are length-prefixed so different field splits can never produce the same input.

import { createHash } from 'node:crypto';

const DIGEST_DOMAIN = 'observatory/digest/v1';
const SALT_DOMAIN = 'observatory/salt/v1';

const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u64 = (n) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
};
const lp = (buf) => [u32(buf.length), buf];

// SHA-256("observatory/digest/v1" || u32(len id) || id || u64(observedAtMs) || u32(len payload) || payload)
export function observationDigest({ sourceId, observedAt, payload }) {
  if (!Buffer.isBuffer(payload)) throw new TypeError('payload must be a Buffer');
  const h = createHash('sha256');
  h.update(Buffer.from(DIGEST_DOMAIN));
  for (const part of [...lp(Buffer.from(sourceId, 'utf8')), u64(observedAt), ...lp(payload)]) h.update(part);
  return h.digest();
}

export function createConditioningBoundary({ now = Date.now, maxAgeMs = 10 * 60 * 1000 } = {}) {
  const latest = new Map();

  return {
    maxAgeMs,

    // entry: { sourceId, sourceName, observationId, observedAt, digest: Buffer(32), imageUrl? }
    submit(entry) {
      if (!entry || typeof entry.sourceId !== 'string' || !Buffer.isBuffer(entry.digest) || entry.digest.length !== 32) {
        throw new TypeError('invalid observation digest submission');
      }
      latest.set(entry.sourceId, { ...entry, digest: Buffer.from(entry.digest) });
    },

    remove(sourceId) {
      latest.delete(sourceId);
    },

    // Latest observation per source that is younger than maxAgeMs, in sorted source-id order.
    contributing() {
      const t = now();
      return [...latest.values()]
        .filter((e) => t - e.observedAt <= maxAgeMs)
        .sort((a, b) => (a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : 0));
    },

    currentObservationIds() {
      return [...latest.values()].map((e) => e.observationId);
    },

    // { salt: Buffer(32), observations: [public metadata] } or null when nothing qualifies.
    currentSalt() {
      const fresh = this.contributing();
      if (!fresh.length) return null;
      const h = createHash('sha256');
      h.update(Buffer.from(SALT_DOMAIN));
      h.update(u32(fresh.length));
      for (const e of fresh) {
        for (const part of lp(Buffer.from(e.sourceId, 'utf8'))) h.update(part);
        h.update(e.digest);
      }
      return {
        salt: h.digest(),
        observations: fresh.map((e) => ({
          id: e.sourceId,
          name: e.sourceName,
          observationId: e.observationId,
          observedAt: new Date(e.observedAt).toISOString(),
          ...(e.imageUrl ? { imageUrl: e.imageUrl } : {}),
        })),
      };
    },
  };
}
