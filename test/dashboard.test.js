import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, addCamera, KEY, KEY2, PUBLIC_URL } from './helpers.js';

const meta = (html, attr, key) => {
  const m = new RegExp(`<meta ${attr}="${key.replace(/:/g, ':')}" content="([^"]*)">`).exec(html);
  return m ? m[1].replace(/&amp;/g, '&') : null;
};

test('initial HTML carries Open Graph and Twitter metadata with the fallback image', async () => {
  const ctx = await startServer();
  try {
    const r = await fetch(`${ctx.base}/`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /<title>The Observatory — Environmental Observation &amp; Cryptographic Randomness<\/title>/);
    assert.equal(meta(html, 'property', 'og:title'), 'The Observatory — Environmental Observation & Cryptographic Randomness');
    assert.equal(meta(html, 'property', 'og:description'), 'Observing the physical world. Serving cryptographically secure randomness.');
    assert.equal(meta(html, 'property', 'og:type'), 'website');
    assert.equal(meta(html, 'property', 'og:url'), `${PUBLIC_URL}/`);
    assert.match(html, new RegExp(`<link rel="canonical" href="${PUBLIC_URL}/">`));
    assert.equal(meta(html, 'property', 'og:image'), `${PUBLIC_URL}/static/og-fallback.png`);
    assert.equal(meta(html, 'property', 'og:image:width'), '1200');
    assert.equal(meta(html, 'property', 'og:image:height'), '630');
    assert.equal(meta(html, 'name', 'twitter:card'), 'summary_large_image');
    assert.equal(meta(html, 'name', 'twitter:image'), `${PUBLIC_URL}/static/og-fallback.png`);
    const img = await fetch(`${ctx.base}/static/og-fallback.png`);
    assert.equal(img.status, 200);
    assert.equal(img.headers.get('content-type'), 'image/png');
    assert.match(html, /THE OBSERVATORY/);
    assert.ok(!html.includes(KEY) && !html.includes(KEY2));
    assert.ok(!html.includes(ctx.dir), 'no filesystem paths');
  } finally {
    await ctx.close();
  }
});

test('after a capture the latest photograph is referenced; a failed capture keeps it', async () => {
  const ctx = await startServer();
  try {
    await addCamera(ctx);
    await ctx.server.registry.captureNow('tank-cam');
    let html = await (await fetch(`${ctx.base}/`)).text();
    const image = meta(html, 'property', 'og:image');
    assert.match(image, new RegExp(`^${PUBLIC_URL}/observations/tank-cam/latest\\.jpg\\?v=\\d+$`));
    assert.equal(meta(html, 'property', 'og:image:width'), '1280');
    assert.equal(meta(html, 'property', 'og:image:height'), '720');
    assert.match(html, /Turtle aquarium/);
    const local = image.replace(PUBLIC_URL, ctx.base);
    assert.equal((await fetch(local)).status, 200);

    ctx.cam.mode = 'fail';
    await ctx.server.registry.captureNow('tank-cam');
    html = await (await fetch(`${ctx.base}/`)).text();
    assert.equal(meta(html, 'property', 'og:image'), image, 'still the last valid photograph');
  } finally {
    await ctx.close();
  }
});

test('status reflects real counters and never exposes secrets or random material', async () => {
  const ctx = await startServer();
  try {
    const sent = [];
    for (let i = 0; i < 3; i++) sent.push((await (await ctx.random({ bytes: 16 })).json()).data);
    await ctx.random({ bytes: 16 }, { key: 'bad' });
    const r = await fetch(`${ctx.base}/api/v1/status`);
    assert.match(r.headers.get('cache-control'), /no-store/);
    const text = await r.text();
    const st = JSON.parse(text);
    assert.equal(st.api.requestsOk, 3);
    assert.equal(st.api.requestsFailed, 1);
    assert.equal(st.api.bytesServed, 48);
    assert.equal(st.api.authFailures, 1);
    assert.equal(st.api.withoutEnvironmental, 3);
    assert.equal(st.rng.status, 'OPERATIONAL');
    assert.equal(st.rng.generations, 3);
    assert.ok(st.events.some((e) => e.type === 'random.fulfilled'));
    assert.ok(st.events.some((e) => e.type === 'auth.failure'));
    for (const d of sent) assert.ok(!text.includes(d), 'random material not exposed');
    assert.ok(!text.includes(KEY));
    const html = await (await fetch(`${ctx.base}/`)).text();
    for (const d of sent) assert.ok(!html.includes(d));
    // Event rows in the database never contain the material either.
    const rows = ctx.server.db.prepare('SELECT message, data FROM events').all();
    for (const d of sent) assert.ok(!JSON.stringify(rows).includes(d));
  } finally {
    await ctx.close();
  }
});

test('telemetry shows gaps (null) for periods with no collected data', async () => {
  const ctx = await startServer();
  try {
    await ctx.random({ bytes: 8 });
    const st = await (await fetch(`${ctx.base}/api/v1/status`)).json();
    const s = st.telemetry.series.apiRequests;
    assert.equal(s.length, st.telemetry.windowMinutes / st.telemetry.bucketMinutes);
    assert.equal(s.at(-1).v, 1, 'current bucket has the request');
    assert.equal(s[0].v, null, 'buckets before the service started are missing, not zero');
  } finally {
    await ctx.close();
  }
});

test('observation image route rejects traversal and unknown ids', async () => {
  const ctx = await startServer();
  try {
    for (const p of ['/observations/..%2F..%2Fetc/passwd', '/observations/tank-cam/..%2Fobservatory.sqlite', '/observations/tank-cam/999.jpg', '/observations/Tank/latest.jpg']) {
      assert.equal((await fetch(ctx.base + p)).status, 404, p);
    }
  } finally {
    await ctx.close();
  }
});
