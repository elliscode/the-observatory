// Server-rendered dashboard page. Open Graph / Twitter metadata is in the initial HTML so link
// previews work for crawlers that never run JavaScript.

import { renderPanels, renderSubsystems } from '../../client/js/render.js';
import { esc } from './preview.js';

export const TITLE = 'The Observatory — Environmental Observation & Cryptographic Randomness';
export const DESCRIPTION = 'Observing the physical world. Serving cryptographically secure randomness.';
export const FALLBACK_IMAGE = { path: '/static/og-fallback.png', width: 1200, height: 630 };

// The latest valid image from the first enabled camera, else the static fallback.
export function ogImage(sources, base) {
  const cam = sources.find((s) => s.type === 'camera' && s.enabled && s.latest?.imageUrl)
    || sources.find((s) => s.type === 'camera' && s.latest?.imageUrl);
  if (cam) {
    return {
      url: `${base}${cam.latest.imageUrl}`,
      width: cam.latest.width,
      height: cam.latest.height,
      alt: `Latest observation of ${cam.subject} by ${cam.name}`,
    };
  }
  return { url: `${base}${FALLBACK_IMAGE.path}`, width: FALLBACK_IMAGE.width, height: FALLBACK_IMAGE.height, alt: 'The Observatory' };
}

export function metaTags({ base, image }) {
  const url = `${base}/`;
  const tags = [
    ['name', 'description', DESCRIPTION],
    ['property', 'og:type', 'website'],
    ['property', 'og:site_name', 'The Observatory'],
    ['property', 'og:title', TITLE],
    ['property', 'og:description', DESCRIPTION],
    ['property', 'og:url', url],
    ['property', 'og:image', image.url],
    ...(image.url.startsWith('https://') ? [['property', 'og:image:secure_url', image.url]] : []),
    ...(image.width && image.height ? [['property', 'og:image:width', String(image.width)], ['property', 'og:image:height', String(image.height)]] : []),
    ['property', 'og:image:alt', image.alt],
    ['name', 'twitter:card', 'summary_large_image'],
    ['name', 'twitter:title', TITLE],
    ['name', 'twitter:description', DESCRIPTION],
    ['name', 'twitter:image', image.url],
    ['name', 'twitter:image:alt', image.alt],
  ];
  return [
    `<link rel="canonical" href="${esc(url)}">`,
    ...tags.map(([attr, key, value]) => `<meta ${attr}="${key}" content="${esc(value)}">`),
  ].join('\n  ');
}

export function renderDashboardPage({ status, base, now = Date.now() }) {
  const image = ogImage(status.sources, base);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(TITLE)}</title>
  ${metaTags({ base, image })}
  <meta name="color-scheme" content="dark light">
  <link rel="icon" href="/static/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/assets/css/observatory.css">
</head>
<body>
  <header class="masthead">
    <div class="designation">Directorate of Environmental Measurement and Cryptographic Systems</div>
    <h1>THE OBSERVATORY</h1>
    <p class="subtitle">Environmental Observation &amp; Cryptographic Randomness Infrastructure</p>
    <p class="tagline">Observing the physical world. Serving cryptographically secure randomness.</p>
    <div class="clock">Station time <time id="clock">${esc(new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'))}</time> · <span id="refresh">updated at render</span></div>
    <div id="subsystems">${renderSubsystems(status)}</div>
  </header>
  <main id="panels">
${renderPanels(status, now)}
  </main>
  <footer>
    <p>Subsystem Operational Status figures are live runtime values. Missing data is shown as missing.</p>
    <p>The Observatory is a hobbyist installation. Its random material comes from the operating system's cryptographically secure random-number generator; environmental observations are mixed in but are not credited as entropy. It is not a quantum random-number generator or a certified entropy source.</p>
  </footer>
  <script type="module" src="/assets/js/dashboard.js"></script>
</body>
</html>`;
}
