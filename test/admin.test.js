import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, PUBLIC_URL } from './helpers.js';

test('admin is disabled (404) when ADMIN_PASSWORD is unset', async () => {
  const ctx = await startServer();
  try {
    assert.equal((await fetch(`${ctx.base}/admin`)).status, 404);
    const r = await fetch(`${ctx.base}/admin/api/sources`, { method: 'POST', headers: { 'content-type': 'application/json', origin: PUBLIC_URL }, body: '{}' });
    assert.equal(r.status, 404);
  } finally {
    await ctx.close();
  }
});

test('admin routes require login and a same-origin Origin header', async () => {
  const ctx = await startServer({ adminPassword: 'correct horse battery', sessionSecret: 's'.repeat(40) });
  const post = (path, body, headers = {}) => fetch(`${ctx.base}/admin/api${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin: PUBLIC_URL, ...headers }, body: JSON.stringify(body),
  });
  try {
    assert.equal((await fetch(`${ctx.base}/admin`)).status, 200);
    assert.equal((await fetch(`${ctx.base}/admin/api/sources`)).status, 401);
    const src = { name: 'Cam', type: 'camera', config: { analysisWidth: 16, analysisHeight: 9 } };
    assert.equal((await post('/sources', src)).status, 401, 'unauthenticated config change rejected');

    assert.equal((await post('/login', { password: 'wrong' })).status, 401);
    const login = await post('/login', { password: 'correct horse battery' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    assert.match(login.headers.get('set-cookie'), /HttpOnly/i);

    assert.equal((await post('/sources', src, { cookie, origin: 'https://evil.example' })).status, 403, 'cross-origin rejected');
    assert.equal((await post('/sources', src, { cookie, origin: '' })).status, 403, 'missing origin rejected');
    const created = await post('/sources', src, { cookie });
    assert.equal(created.status, 201);
    const { source } = await created.json();
    assert.equal(source.id, 'cam');

    const patch = await fetch(`${ctx.base}/admin/api/sources/cam`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: PUBLIC_URL, cookie }, body: JSON.stringify({ enabled: false }) });
    assert.equal(patch.status, 200);
    assert.equal((await patch.json()).source.status, 'DISABLED');
    const bad = await fetch(`${ctx.base}/admin/api/sources/cam`, { method: 'PATCH', headers: { 'content-type': 'application/json', origin: PUBLIC_URL, cookie }, body: JSON.stringify({ config: { intervalMs: 1 } }) });
    assert.equal(bad.status, 400);

    const list = await (await fetch(`${ctx.base}/admin/api/sources`, { headers: { cookie } })).json();
    assert.equal(list.sources.length, 1);
    const del = await fetch(`${ctx.base}/admin/api/sources/cam`, { method: 'DELETE', headers: { origin: PUBLIC_URL, cookie } });
    assert.equal(del.status, 200);
    assert.equal(ctx.server.registry.list().length, 0);
  } finally {
    await ctx.close();
  }
});
