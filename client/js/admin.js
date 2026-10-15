// Source administration UI. Uses the httpOnly admin cookie; no secrets are handled in JavaScript.

import { esc, lamp } from './render.js';

const $ = (id) => document.getElementById(id);
let adapters = [];
let editing = null;

async function api(method, path, body) {
  const r = await fetch(`/admin/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error?.message || `HTTP ${r.status}`);
  return data;
}

function adapterFor(type) {
  return adapters.find((a) => a.type === type);
}

function renderConfigFields(type, values = {}) {
  const a = adapterFor(type);
  $('adapter-desc').textContent = a ? `${a.displayName}: ${a.description} Entropy assessment: ${a.entropyAssessment}.` : '';
  $('config-fields').innerHTML = a ? Object.entries(a.configSchema).map(([k, f]) => {
    const v = values[k] ?? f.default ?? '';
    const input = f.type === 'boolean'
      ? `<select name="cfg.${esc(k)}"><option value="true"${v === true ? ' selected' : ''}>on</option><option value="false"${v === false ? ' selected' : ''}>off</option></select>`
      : `<input name="cfg.${esc(k)}" value="${esc(v)}" ${f.type === 'integer' ? `type="number" step="1"${f.min !== undefined ? ` min="${f.min}"` : ''}${f.max !== undefined ? ` max="${f.max}"` : ''}` : 'type="text"'}>`;
    return `<label>${esc(f.label)} ${input}${f.help ? `<span class="help">${esc(f.help)}</span>` : ''}</label>`;
  }).join('') : '';
}

function formValues() {
  const fd = new FormData($('source-form'));
  const a = adapterFor(fd.get('type'));
  const config = {};
  for (const [k, f] of Object.entries(a.configSchema)) {
    const raw = fd.get(`cfg.${k}`);
    if (raw === null) continue;
    config[k] = f.type === 'integer' ? Number(raw) : f.type === 'boolean' ? raw === 'true' : String(raw);
  }
  return { type: fd.get('type'), name: String(fd.get('name')), id: String(fd.get('id') || '') || undefined, enabled: fd.get('enabled') === 'true', config };
}

async function loadSources() {
  const { sources } = await api('GET', '/sources');
  $('sources').innerHTML = sources.length ? `<div class="tablewrap"><table>
    <thead><tr><th>ID</th><th>Name</th><th>Status</th><th class="num">OK / Failed</th><th>Last error</th><th></th></tr></thead>
    <tbody>${sources.map((s) => `<tr>
      <td><code>${esc(s.id)}</code></td><td>${esc(s.name)}<div class="sub">${esc(s.adapter)}</div></td>
      <td>${lamp(s.status)}</td><td class="num">${s.successCount} / ${s.failureCount}</td>
      <td class="err">${esc(s.lastError || '—')}</td>
      <td><div class="actions">
        <button type="button" class="secondary" data-act="edit" data-id="${esc(s.id)}">Configure</button>
        <button type="button" class="secondary" data-act="toggle" data-id="${esc(s.id)}" data-enabled="${s.enabled}">${s.enabled ? 'Disable' : 'Enable'}</button>
        ${s.enabled ? `<button type="button" class="secondary" data-act="capture" data-id="${esc(s.id)}">Capture now</button>` : ''}
        <button type="button" class="danger" data-act="delete" data-id="${esc(s.id)}">Remove</button>
      </div></td></tr>`).join('')}</tbody></table></div>` : '<p class="sub">No sources registered.</p>';
  return sources;
}

function resetForm() {
  editing = null;
  $('source-form').reset();
  $('form-title').textContent = 'Register a Source';
  $('save').textContent = 'Register source';
  $('cancel').hidden = true;
  $('type').disabled = false;
  $('source-form').elements.id.disabled = false;
  renderConfigFields($('type').value);
}

async function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  adapters = (await api('GET', '/adapters')).adapters;
  $('type').innerHTML = adapters.map((a) => `<option value="${esc(a.type)}">${esc(a.displayName)} (${esc(a.type)})</option>`).join('');
  resetForm();
  await loadSources();
}

$('type').addEventListener('change', () => renderConfigFields($('type').value));
$('cancel').addEventListener('click', resetForm);

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('login-msg').textContent = 'Authenticating…';
  try {
    await api('POST', '/login', { password: new FormData(e.target).get('password') });
    $('login-msg').textContent = '';
    await showApp();
  } catch (err) {
    $('login-msg').textContent = err.message;
    $('login-msg').className = 'msg err';
  }
});

$('logout').addEventListener('click', async () => {
  await api('POST', '/logout');
  location.reload();
});

$('source-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('form-msg');
  msg.className = 'msg';
  try {
    const v = formValues();
    if (editing) await api('PATCH', `/sources/${encodeURIComponent(editing)}`, { name: v.name, enabled: v.enabled, config: v.config });
    else await api('POST', '/sources', v);
    msg.textContent = editing ? 'Configuration saved.' : 'Source registered.';
    resetForm();
    await loadSources();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg err';
  }
});

$('sources').addEventListener('click', async (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.dataset.id;
  const msg = $('form-msg');
  msg.className = 'msg';
  try {
    if (b.dataset.act === 'edit') {
      const { source } = await api('GET', `/sources/${encodeURIComponent(id)}`);
      editing = id;
      const f = $('source-form');
      $('type').value = source.type;
      $('type').disabled = true;
      f.elements.name.value = source.name;
      f.elements.id.value = source.id;
      f.elements.id.disabled = true;
      f.elements.enabled.value = String(source.enabled);
      renderConfigFields(source.type, source.config);
      $('form-title').textContent = `Configure ${source.name}`;
      $('save').textContent = 'Save configuration';
      $('cancel').hidden = false;
      f.scrollIntoView({ behavior: 'smooth' });
    } else if (b.dataset.act === 'toggle') {
      await api('PATCH', `/sources/${encodeURIComponent(id)}`, { enabled: b.dataset.enabled !== 'true' });
    } else if (b.dataset.act === 'capture') {
      msg.textContent = 'Capturing…';
      await api('POST', `/sources/${encodeURIComponent(id)}/capture`);
      msg.textContent = 'Capture attempt complete.';
    } else if (b.dataset.act === 'delete') {
      if (!confirm(`Remove source "${id}" and its stored observations?`)) return;
      await api('DELETE', `/sources/${encodeURIComponent(id)}`);
    }
    await loadSources();
  } catch (err) {
    msg.textContent = err.message;
    msg.className = 'msg err';
  }
});

api('GET', '/me').then(({ admin }) => (admin ? showApp() : ($('login').hidden = false))).catch(() => { $('login').hidden = false; });
