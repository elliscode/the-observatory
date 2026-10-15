// Observation Integrity Monitor: tracks persistence failures so the dashboard can report them
// truthfully. Nothing on the random-material path depends on this.

export function createIntegrityMonitor({ now = Date.now, windowMs = 5 * 60 * 1000 } = {}) {
  let lastError = null;
  let lastErrorAt = null;
  let errorCount = 0;
  return {
    dbError(err) {
      errorCount++;
      lastError = String(err?.message || err);
      lastErrorAt = now();
    },
    status() {
      const recent = lastErrorAt !== null && now() - lastErrorAt < windowMs;
      return { status: recent ? 'DEGRADED' : 'OPERATIONAL', errorCount, lastError, lastErrorAt };
    },
  };
}
