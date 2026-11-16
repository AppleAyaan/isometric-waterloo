// Renders the whitebox map headlessly and writes:
//   out/render.png   – isometric whitebox mosaic (input for the Colab painter)
//   out/idmap.png    – building ID map (R + G*256 = building id), for hover
//   out/meta.json    – mosaic size, projection and building info/outlines
// Usage: node scripts/export.mjs [--scale 2.5] [--azimuth -45] [--source osm|google|ion]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const source = arg('source', 'osm');
const photo = source === 'google' || source === 'ion';
const scale = arg('scale', photo ? '3' : '2.5'), azimuth = arg('azimuth', '-45');
let key = process.env.GOOGLE_MAPS_API_KEY;
const keyFile = path.join(ROOT, '.google-maps-key');
if (!key && fs.existsSync(keyFile)) key = fs.readFileSync(keyFile, 'utf8').trim();
if (source === 'google' && !key) {
  console.error('Google source needs an API key: put it in .google-maps-key (git-ignored) or set GOOGLE_MAPS_API_KEY.');
  process.exit(1);
}
let ion = process.env.CESIUM_ION_TOKEN;
const ionFile = path.join(ROOT, '.cesium-ion-token');
if (!ion && fs.existsSync(ionFile)) ion = fs.readFileSync(ionFile, 'utf8').trim();
if (source === 'ion' && !ion) {
  console.error('ion source needs a Cesium ion access token: put it in .cesium-ion-token (git-ignored) or set CESIUM_ION_TOKEN.');
  process.exit(1);
}
// whitebox -> render.png ; google/ion -> photo.png. ID map and meta are shared (same projection).
const colourName = photo ? 'photo.png' : 'render.png';

const port = 8765;
const server = await startServer(port);
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  page.on('console', (m) => { if (m.type() === 'log' || m.type() === 'warning') console.log('[page]', m.text()); });
  const q = new URLSearchParams({ scale, azimuth, source, ...(source === 'google' ? { key } : {}), ...(source === 'ion' ? { ion } : {}) });
  await page.goto(`http://localhost:${port}/render/?${q}`);
  await page.waitForFunction(() => typeof window.exportMap === 'function');
  const t0 = Date.now();
  page.setDefaultTimeout(0);
  const res = await page.evaluate(() => window.exportMap());
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const write = (name, dataUrl) => fs.writeFileSync(path.join(ROOT, 'out', name), Buffer.from(dataUrl.split(',')[1], 'base64'));
  write(colourName, res.render);
  write('idmap.png', res.idmap);
  fs.writeFileSync(path.join(ROOT, 'out/meta.json'), JSON.stringify(res.meta));
  console.log(`exported ${res.meta.width}x${res.meta.height}px (${res.meta.buildings.length} buildings) in ${((Date.now() - t0) / 1000).toFixed(1)}s -> out/${colourName}`);
} finally {
  await browser.close();
  server.close();
}
