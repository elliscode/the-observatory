// Dashboard panel rendering from the /api/v1/status payload. Pure functions returning HTML strings,
// imported by the server for the initial (no-JavaScript) render and by the browser for live updates.
// Every interpolated value goes through esc().

import { lineChart, barChart, histogramChart } from './charts.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const iso = (t) => (t === null || t === undefined ? '—' : new Date(t).toISOString().replace('.000Z', 'Z'));
const fixed = (v, d = 3) => (v === null || v === undefined ? '—' : Number(v).toFixed(d));
const int = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-US'));

export function ago(t, now) {
  if (t === null || t === undefined) return '—';
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 172800) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function duration(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`;
}

const bytes = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(2)} MiB`);

export function lamp(status) {
  const s = String(status || 'UNKNOWN').toUpperCase();
  const tone = { OPERATIONAL: 'ok', ACTIVE: 'ok', DEGRADED: 'warn', STARTING: 'warn', IDLE: 'idle', UNAVAILABLE: 'bad', NOT_CONFIGURED: 'idle', DISABLED: 'idle' }[s] || 'idle';
  return `<span class="lamp ${tone}"><i aria-hidden="true"></i>${esc(s.replace(/_/g, ' '))}</span>`;
}

const row = (k, v) => `<div class="kv"><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
const panel = (id, code, title, body, note = '') => `
<section class="panel" id="${id}" aria-labelledby="${id}-h">
  <header><span class="code">${esc(code)}</span><h2 id="${id}-h">${esc(title)}</h2></header>
  ${body}
  ${note ? `<p class="note">${note}</p>` : ''}
</section>`;

export function renderSubsystems(st) {
  return `<ul class="subsystems">${st.subsystems.map((s) => `<li><span class="sname">${esc(s.name)}</span>${lamp(s.status)}</li>`).join('')}</ul>`;
}

function registryPanel(st, now) {
  if (!st.sources.length) {
    return panel('registry', 'A', 'Observation Source Registry',
      `<div class="empty">${lamp('NOT_CONFIGURED')}<p>No observation sources are registered. The Cryptographic Randomness Core operates normally without them.</p></div>`);
  }
  const rows = st.sources.map((s) => `<tr>
    <td><code>${esc(s.id)}</code></td>
    <td>${esc(s.name)}<div class="sub">${esc(s.adapter)} · <code>${esc(s.type)}</code></div></td>
    <td>${lamp(s.status)}</td>
    <td>${esc(iso(s.lastSuccessAt))}<div class="sub">${esc(ago(s.lastSuccessAt, now))}</div></td>
    <td class="num">${int(s.successCount)} / ${int(s.failureCount)}</td>
    <td><span class="tag">MEASUREMENT</span><div class="sub">entropy assessment: ${esc(s.entropyAssessment)}</div></td>
    <td class="err">${s.lastError ? `${esc(s.lastError)}<div class="sub">${esc(iso(s.lastErrorAt))}</div>` : '—'}</td>
  </tr>`).join('');
  return panel('registry', 'A', 'Observation Source Registry', `
    <div class="tablewrap"><table>
      <thead><tr><th>ID</th><th>Source</th><th>Status</th><th>Last successful update</th><th class="num">OK / Failed</th><th>Classification</th><th>Most recent error</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`,
  'Every registered source reports ordinary measurements. No source carries a defensible entropy assessment, and none is required for random-material generation.');
}

function observationPanel(st, now) {
  const cams = st.sources.filter((s) => s.type === 'camera');
  if (!cams.length) {
    return panel('observation', 'B', 'Environmental Observation Array',
      `<div class="empty">${lamp('NOT_CONFIGURED')}<p>Optical Measurement Subsystem: no camera configured.</p></div>`);
  }
  const body = cams.map((s) => {
    const l = s.latest;
    const img = l?.imageUrl
      ? `<img src="${esc(l.imageUrl)}" alt="Latest observation of ${esc(s.subject)}" width="${esc(l.width)}" height="${esc(l.height)}" loading="lazy">`
      : `<div class="noimg">NO VALID OBSERVATION RECORDED</div>`;
    const total = s.successCount + s.failureCount;
    return `<div class="camera">
      <figure>${img}<figcaption>${esc(s.name)} · Observation #${esc(l?.observationId ?? '—')}</figcaption></figure>
      <dl class="readouts">
        ${row('Subject', esc(s.subject))}
        ${row('Status', lamp(s.status))}
        ${row('Captured', esc(iso(l?.observedAt)))}
        ${row('Time since capture', esc(ago(l?.observedAt, now)))}
        ${row('Dimensions', l?.width ? `${esc(l.width)} × ${esc(l.height)} px` : '—')}
        ${row('Capture interval', s.intervalMs ? `${(s.intervalMs / 1000).toFixed(1)} s` : '—')}
        ${row('Captures OK / failed', `${int(s.successCount)} / ${int(s.failureCount)}`)}
        ${row('Success ratio', total ? `${((s.successCount / total) * 100).toFixed(1)} %` : '—')}
        ${row('Processing', esc(s.processing))}
      </dl>
    </div>`;
  }).join('');
  return panel('observation', 'B', 'Environmental Observation Array', body);
}

function analysisPanel(st) {
  const cam = st.sources.find((s) => s.type === 'camera' && s.latestAnalysis) || null;
  const a = cam?.latestAnalysis;
  if (!a) {
    return panel('analysis', 'C', 'Frame Differential Analysis',
      `<div class="empty">${lamp('IDLE')}<p>Awaiting two consecutive valid frames.</p></div>`,
      'Measures visible change between consecutive frames. These are not entropy measurements.');
  }
  const pct = a.activity === null || a.activity === undefined ? null : Math.round(a.activity * 100);
  const gauge = `<div class="gauge" role="meter" aria-label="Observation activity" aria-valuemin="0" aria-valuemax="1" aria-valuenow="${a.activity ?? ''}">
      <div class="fill" style="width:${pct ?? 0}%"></div>
      <span class="t" style="left:2%"></span><span class="t" style="left:20%"></span>
    </div>
    <div class="gauge-scale"><span>STATIC &lt;0.5%</span><span>LOW &lt;5%</span><span>MODERATE &lt;25%</span><span>HIGH ≥25%</span></div>`;
  return panel('analysis', 'C', 'Frame Differential Analysis', `
    <div class="analysis">
      <div>
        <div class="classification">${esc(String(a.classification).replace(/_/g, ' ').toUpperCase())}</div>
        <div class="sub">${esc(cam.name)} · observation #${esc(a.observationId)}</div>
        <h3>Observation Activity ${pct === null ? '<span class="sub">(not interpreted)</span>' : `<span class="big">${fixed(a.activity, 3)}</span>`}</h3>
        ${gauge}
        <h3>Distribution of pixel differences</h3>
        ${histogramChart(a.histogram)}
      </div>
      <dl class="readouts">
        ${row('Mean absolute difference', `${fixed(a.meanAbsDiff, 2)} / 255`)}
        ${row('Pixels over threshold', a.changedFraction === null ? '—' : `${(a.changedFraction * 100).toFixed(2)} %`)}
        ${row('Exposure shift (compensated)', fixed(a.exposureShift, 2))}
        ${row('Mean luminance', fixed(a.meanLumaCurr, 1))}
        ${row('Structural correlation', fixed(a.correlation ?? null, 3))}
        ${row('Capture interval', a.intervalMs ? `${(a.intervalMs / 1000).toFixed(2)} s` : '—')}
        ${row('Processing duration', a.processingMs === null || a.processingMs === undefined ? '—' : `${fixed(a.processingMs, 1)} ms`)}
        ${row('Preprocessing', a.settings ? `${esc(a.settings.width)}×${esc(a.settings.height)} gray · threshold ${esc(a.settings.threshold)} · blur ${a.settings.blur ? 'on' : 'off'}` : '—')}
      </dl>
    </div>`,
  'Activity = min(1, changed fraction ÷ 0.25). Exposure offsets are subtracted and a 3×3 blur suppresses compression noise before differencing. Frames darker than luminance 8 are recorded as <em>low light</em> and not interpreted; geometry changes or near-total change with low correlation are recorded as <em>scene discontinuity</em>. These are measurements of visible change, not entropy measurements.');
}

function rngPanel(st, now) {
  const r = st.rng;
  const a = st.api;
  const c = st.conditioning;
  const lastUse = a.lastUse?.observations?.length
    ? a.lastUse.observations.map((o) => `observation <a href="${esc(o.imageUrl || '#')}">#${esc(o.observationId)}</a> of ${esc(o.name)}`).join(', ')
    : a.lastUse ? 'none (no fresh observation available)' : '—';
  return panel('rng', 'D', 'Cryptographic Randomness Core', `
    <div class="cols">
      <dl class="readouts">
        ${row('Core status', lamp(r.status))}
        ${row('Random source', `<code>${esc(r.randomSource)}</code>`)}
        ${row('OS CSPRNG available', r.osRandomAvailable ? 'YES' : 'NO')}
        ${row('Startup self-test', r.selfTest.ok ? `PASSED · ${esc(iso(r.selfTest.at))}` : `FAILED${r.selfTest.error ? ` · ${esc(r.selfTest.error)}` : ''}`)}
        ${row('Derivation', `<code>${esc(r.algorithm)}</code>`)}
        ${row('Service uptime', esc(duration(st.uptimeSec)))}
        ${row('Last generation failure', r.lastFailureAt ? `${esc(iso(r.lastFailureAt))} · ${esc(r.lastError)}` : 'none')}
        ${row('Last recovery', r.recoveredAt ? esc(iso(r.recoveredAt)) : '—')}
      </dl>
      <dl class="readouts">
        ${row('Distribution API', lamp(a.status))}
        ${row('Requests fulfilled / failed', `${int(a.requestsOk)} / ${int(a.requestsFailed)}`)}
        ${row('Bytes served', esc(bytes(a.bytesServed)))}
        ${row('Latency p50 / p95 / max', `${a.latency.p50 ?? '—'} / ${a.latency.p95 ?? '—'} / ${a.latency.max === null ? '—' : fixed(a.latency.max, 2)} ms`)}
        ${row('Last successful request', `${esc(iso(a.lastSuccessAt))} <span class="sub">${esc(ago(a.lastSuccessAt, now))}</span>`)}
        ${row('Authentication failures', int(a.authFailures))}
        ${row('Rate-limited requests', int(a.rateLimited))}
        ${row('Maximum request size', `${int(a.maxBytes)} bytes`)}
      </dl>
    </div>
    <div class="conditioning">
      <h3>Environmental Input Conditioning ${lamp(c.status)}</h3>
      <p>Mode: <strong>INCORPORATED</strong> as HKDF-SHA256 salt alongside 32 fresh bytes from the operating-system CSPRNG per request · <strong>no entropy credit claimed</strong>.</p>
      <dl class="readouts">
        ${row('Contributing observations', c.contributing.length ? c.contributing.map((o) => `#${esc(o.observationId)} of ${esc(o.name)} <span class="sub">${esc(ago(Date.parse(o.observedAt), now))}</span>`).join('<br>') : 'none fresh (requests use OS bytes with an empty salt)')}
        ${row('Freshness window', `${Math.round(c.maxAgeMs / 60000)} min`)}
        ${row('Most recent request incorporated', lastUse)}
        ${row('Requests with / without observations', `${int(a.withEnvironmental)} / ${int(a.withoutEnvironmental)}`)}
      </dl>
    </div>`,
  'Random material security rests entirely on the operating system\'s cryptographic random-number generator. Environmental observations change the output but are not credited as entropy, and their absence cannot weaken it. This installation is not a quantum or certified entropy source.');
}

function eventPanel(st) {
  const items = st.events.map((e) => `<li class="ev ${esc(e.level)}"><time>${esc(iso(e.ts))}</time><span class="etype">${esc(e.type)}</span><span class="emsg">${esc(e.message)}</span></li>`).join('');
  return panel('events', 'E', 'Operational Event Log', items ? `<ol class="events">${items}</ol>` : '<p class="empty">No events recorded.</p>');
}

function telemetryPanel(st) {
  const t = st.telemetry;
  const s = t.series;
  const charts = [
    ['API request volume', barChart(s.apiRequests, { label: 'API request volume' })],
    ['Bytes served', barChart(s.apiBytes, { label: 'Bytes served', fmt: (v) => bytes(Math.round(v)) })],
    ['Request latency (mean, ms)', lineChart(s.apiLatency, { label: 'Request latency', fmt: (v) => v.toFixed(1) })],
    ['Errors and rejected requests', barChart(s.apiErrors, { label: 'Errors', cls: 'bad' })],
  ];
  for (const src of t.sources) {
    charts.push([`${src.name}: availability`, lineChart(src.availability, { label: `${src.name} availability`, max: 1, fmt: (v) => `${Math.round(v * 100)}%` })]);
    charts.push([`${src.name}: captures per bucket`, barChart(src.captures, { label: `${src.name} captures` })]);
    if (src.type === 'camera') charts.push([`${src.name}: frame difference (mean activity)`, lineChart(src.activity, { label: `${src.name} activity`, max: 1, fmt: (v) => v.toFixed(2) })]);
  }
  return panel('telemetry', 'F', 'Historical Telemetry', `
    <p class="sub">Window: last ${esc(t.windowMinutes / 60)} h · ${esc(t.bucketMinutes)}-minute buckets · gaps indicate periods with no data collected.</p>
    <div class="charts">${charts.map(([title, svg]) => `<figure class="chartbox"><figcaption>${esc(title)}</figcaption>${svg}</figure>`).join('')}</div>`);
}

export function renderPanels(st, now = Date.now()) {
  return [registryPanel(st, now), observationPanel(st, now), analysisPanel(st), rngPanel(st, now), eventPanel(st), telemetryPanel(st)].join('\n');
}
