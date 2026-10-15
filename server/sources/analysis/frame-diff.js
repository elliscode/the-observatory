// Frame Differential Analysis: a pure, deterministic comparison of two grayscale frames.
//
// Frames are normalized upstream to a fixed analysis size (default 160x90), so resolution changes
// never look like motion. Processing steps:
//   1. Optional 3x3 box blur on both frames to suppress JPEG/sensor noise.
//   2. Exposure compensation: the median signed pixel difference (a global brightness offset that
//      local motion cannot skew) is subtracted before diffing.
//   3. Per-pixel absolute difference -> mean, changed fraction (> threshold), 8-bin histogram.
//   4. Classification (see ACTIVITY_THRESHOLDS, LOW_LIGHT_LUMA, discontinuity rule).
//
// These are measurements of visible change in the scene. They are NOT entropy measurements and
// say nothing about how unpredictable a frame is.

export const DEFAULTS = Object.freeze({
  threshold: 12,
  blur: true,
  lowLightLuma: 8,
  discontinuityFraction: 0.85,
  discontinuityCorrelation: 0.3,
});

// changedFraction below `max` -> label. activity = min(1, changedFraction / 0.25).
export const ACTIVITY_THRESHOLDS = Object.freeze([
  { max: 0.005, label: 'static' },
  { max: 0.05, label: 'low' },
  { max: 0.25, label: 'moderate' },
  { max: Infinity, label: 'high' },
]);
export const ACTIVITY_FULL_SCALE = 0.25;

export function boxBlur(buf, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          sum += buf[yy * w + xx];
          n++;
        }
      }
      out[y * w + x] = Math.round(sum / n);
    }
  }
  return out;
}

const mean = (buf) => {
  let s = 0;
  for (let i = 0; i < buf.length; i++) s += buf[i];
  return buf.length ? s / buf.length : 0;
};

// Median of (b[i] - a[i]) via a 511-bin histogram.
function medianShift(a, b) {
  const counts = new Uint32Array(511);
  for (let i = 0; i < a.length; i++) counts[b[i] - a[i] + 255]++;
  const half = a.length / 2;
  let seen = 0;
  for (let k = 0; k < counts.length; k++) {
    seen += counts[k];
    if (seen >= half) return k - 255;
  }
  return 0;
}

function correlation(a, b, ma, mb) {
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  // Flat frames have no structure to correlate; treat as fully correlated (no evidence of a move).
  if (va === 0 || vb === 0) return 1;
  return cov / Math.sqrt(va * vb);
}

export function classifyActivity(changedFraction) {
  return ACTIVITY_THRESHOLDS.find((t) => changedFraction < t.max).label;
}

const round = (v, d = 6) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);

// prev/curr: Uint8Array|Buffer grayscale frames of width*height pixels.
// sourceSizePrev/sourceSizeCurr: original capture dimensions; a change resets the baseline.
export function analyze(prev, curr, { width, height, sourceSizePrev = null, sourceSizeCurr = null, ...opts } = {}) {
  const o = { ...DEFAULTS, ...opts };
  const base = {
    meanAbsDiff: null, changedFraction: null, histogram: null, meanLumaPrev: null, meanLumaCurr: null,
    exposureShift: null, correlation: null, activity: null,
    settings: { width, height, threshold: o.threshold, blur: o.blur },
  };
  const sizeChanged = sourceSizePrev && sourceSizeCurr
    && (sourceSizePrev.width !== sourceSizeCurr.width || sourceSizePrev.height !== sourceSizeCurr.height);
  if (!prev || !curr || prev.length !== curr.length || prev.length !== width * height || sizeChanged) {
    return { ...base, classification: 'scene_discontinuity', reason: 'frame geometry changed' };
  }

  const a = o.blur ? boxBlur(prev, width, height) : prev;
  const b = o.blur ? boxBlur(curr, width, height) : curr;
  const ma = mean(a);
  const mb = mean(b);
  const offset = medianShift(a, b);
  const histogram = new Array(8).fill(0);
  let sum = 0;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    const d = Math.min(255, Math.abs(b[i] - a[i] - offset));
    sum += d;
    if (d > o.threshold) changed++;
    histogram[Math.min(7, Math.floor(d / 32))]++;
  }
  const n = a.length;
  const changedFraction = changed / n;
  const corr = correlation(a, b, ma, mb);
  const result = {
    ...base,
    meanAbsDiff: round(sum / n, 4),
    changedFraction: round(changedFraction),
    histogram: histogram.map((c) => round(c / n)),
    meanLumaPrev: round(ma, 3),
    meanLumaCurr: round(mb, 3),
    exposureShift: round(offset, 3),
    correlation: round(corr, 4),
  };

  if (mb < o.lowLightLuma) {
    return { ...result, classification: 'low_light', reason: `mean luminance below ${o.lowLightLuma}` };
  }
  if (changedFraction > o.discontinuityFraction && corr < o.discontinuityCorrelation) {
    return { ...result, classification: 'scene_discontinuity', reason: 'nearly every pixel changed with little structural correlation (camera moved or scene replaced)' };
  }
  return {
    ...result,
    activity: round(Math.min(1, changedFraction / ACTIVITY_FULL_SCALE), 4),
    classification: classifyActivity(changedFraction),
  };
}
