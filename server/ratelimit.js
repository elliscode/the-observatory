// Token-bucket rate limiter. Buckets hold `burst` tokens and refill at `perMinute` per minute.

export function createRateLimiter({ perMinute, burst, now = Date.now, maxKeys = 10_000 }) {
  const buckets = new Map();
  const ratePerMs = perMinute / 60_000;

  return {
    take(key) {
      const t = now();
      let b = buckets.get(key);
      if (!b) {
        if (buckets.size >= maxKeys) {
          // Drop buckets that have fully refilled; they carry no state worth keeping.
          for (const [k, v] of buckets) if (v.tokens + (t - v.at) * ratePerMs >= burst) buckets.delete(k);
          if (buckets.size >= maxKeys) buckets.delete(buckets.keys().next().value);
        }
        b = { tokens: burst, at: t };
        buckets.set(key, b);
      }
      b.tokens = Math.min(burst, b.tokens + (t - b.at) * ratePerMs);
      b.at = t;
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { ok: true };
      }
      return { ok: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / ratePerMs / 1000)) };
    },
  };
}
