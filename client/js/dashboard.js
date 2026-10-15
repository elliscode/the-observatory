// Live dashboard updates: polls the public status endpoint and re-renders the panels with the same
// renderer the server used for the initial HTML. No credentials are ever present in the browser.

import { renderPanels, renderSubsystems } from './render.js';

const POLL_MS = 5000;
const panels = document.getElementById('panels');
const subsystems = document.getElementById('subsystems');
const refresh = document.getElementById('refresh');
const clock = document.getElementById('clock');
let failures = 0;

async function update() {
  try {
    const r = await fetch('/api/v1/status', { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const status = await r.json();
    const scrollers = [...panels.querySelectorAll('ol.events')].map((el) => el.scrollTop);
    panels.innerHTML = renderPanels(status, Date.now());
    subsystems.innerHTML = renderSubsystems(status);
    [...panels.querySelectorAll('ol.events')].forEach((el, i) => { el.scrollTop = scrollers[i] || 0; });
    refresh.textContent = `telemetry received ${new Date().toISOString().slice(11, 19)}Z`;
    failures = 0;
  } catch (err) {
    failures++;
    refresh.textContent = `telemetry link interrupted (${err.message}); retrying`;
  } finally {
    setTimeout(update, Math.min(60_000, POLL_MS * 2 ** Math.min(failures, 4)));
  }
}

setInterval(() => { clock.textContent = new Date().toISOString().replace(/\.\d+Z$/, 'Z'); }, 1000);
setTimeout(update, POLL_MS);
