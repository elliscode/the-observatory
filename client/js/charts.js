// Minimal SVG charts. Shared by the server (initial HTML) and the browser (live updates).
// Missing data (null) renders as a gap, never as zero.

const W = 320;
const H = 90;
const PAD = { l: 34, r: 6, t: 8, b: 16 };

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => (Number.isFinite(v) ? v : null);

function axis(maxV, fmt) {
  const y0 = H - PAD.b;
  return `<line class="ax" x1="${PAD.l}" y1="${y0}" x2="${W - PAD.r}" y2="${y0}"/>`
    + `<text class="tick" x="${PAD.l - 4}" y="${PAD.t + 4}" text-anchor="end">${esc(fmt(maxV))}</text>`
    + `<text class="tick" x="${PAD.l - 4}" y="${y0}" text-anchor="end">0</text>`;
}

function timeLabels(points) {
  if (!points.length) return '';
  const f = (t) => new Date(t).toISOString().slice(11, 16) + 'Z';
  return `<text class="tick" x="${PAD.l}" y="${H - 3}">${f(points[0].t)}</text>`
    + `<text class="tick" x="${W - PAD.r}" y="${H - 3}" text-anchor="end">${f(points[points.length - 1].t)}</text>`;
}

// points: [{ t, v }]; v null = missing.
export function lineChart(points, { fmt = String, max = null, label = '' } = {}) {
  const vals = points.map((p) => num(p.v)).filter((v) => v !== null);
  if (!vals.length) return emptyChart(label);
  const maxV = max ?? Math.max(...vals, 1e-9);
  const n = points.length;
  const x = (i) => PAD.l + (n === 1 ? 0 : (i / (n - 1)) * (W - PAD.l - PAD.r));
  const y = (v) => H - PAD.b - (Math.min(v, maxV) / maxV) * (H - PAD.t - PAD.b);
  let d = '';
  let pen = false;
  const dots = [];
  points.forEach((p, i) => {
    const v = num(p.v);
    if (v === null) { pen = false; return; }
    d += `${pen ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
    const prev = num(points[i - 1]?.v);
    const next = num(points[i + 1]?.v);
    if (prev === null && next === null) dots.push(`<circle class="dot" cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="1.8"/>`);
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${axis(maxV, fmt)}<path class="line" d="${d}"/>${dots.join('')}${timeLabels(points)}</svg>`;
}

export function barChart(points, { fmt = String, label = '', cls = '' } = {}) {
  const vals = points.map((p) => num(p.v)).filter((v) => v !== null);
  if (!vals.length) return emptyChart(label);
  const maxV = Math.max(...vals, 1);
  const n = points.length;
  const slot = (W - PAD.l - PAD.r) / n;
  const bars = points.map((p, i) => {
    const v = num(p.v);
    if (v === null) return `<rect class="gap" x="${(PAD.l + i * slot).toFixed(1)}" y="${PAD.t}" width="${Math.max(1, slot - 1).toFixed(1)}" height="${H - PAD.t - PAD.b}"/>`;
    const h = (v / maxV) * (H - PAD.t - PAD.b);
    return `<rect class="bar ${cls}" x="${(PAD.l + i * slot).toFixed(1)}" y="${(H - PAD.b - h).toFixed(1)}" width="${Math.max(1, slot - 1).toFixed(1)}" height="${h.toFixed(1)}"/>`;
  });
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${axis(maxV, fmt)}${bars.join('')}${timeLabels(points)}</svg>`;
}

export function histogramChart(fractions) {
  if (!Array.isArray(fractions)) return emptyChart('histogram');
  const w = 240;
  const h = 70;
  const maxV = Math.max(...fractions, 1e-9);
  const slot = w / fractions.length;
  const bars = fractions.map((f, i) => {
    const bh = (f / maxV) * (h - 14);
    return `<rect class="bar" x="${(i * slot + 1).toFixed(1)}" y="${(h - 12 - bh).toFixed(1)}" width="${(slot - 2).toFixed(1)}" height="${bh.toFixed(1)}"/>`
      + `<text class="tick" x="${(i * slot + slot / 2).toFixed(1)}" y="${h - 2}" text-anchor="middle">${i * 32}</text>`;
  });
  return `<svg class="chart hist" viewBox="0 0 ${w} ${h}" role="img" aria-label="Distribution of pixel differences">${bars.join('')}</svg>`;
}

function emptyChart(label) {
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}: no data"><text class="nodata" x="${W / 2}" y="${H / 2}" text-anchor="middle">NO DATA COLLECTED</text></svg>`;
}
