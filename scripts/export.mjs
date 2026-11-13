// Renders the whitebox map headlessly and writes:
//   out/render.png   – isometric whitebox mosaic (input for the Colab painter)
//   out/idmap.png    – building ID map (R + G*256 = building id), for hover
//   out/meta.json    – mosaic size, projection and building info/outlines
// Usage: node scripts/export.mjs [--scale 2.5] [--azimuth -45]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startServer } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const scale = arg('scale', '2.5'), azimuth = arg('azimuth', '-45');

const port = 8765;
const server = await startServer(port);
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL || 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  page.on('pageerror', (e) => console.error('[page error]', e.message));
  await page.goto(`http://localhost:${port}/render/?scale=${scale}&azimuth=${azimuth}`);
  await page.waitForFunction(() => typeof window.exportMap === 'function');
  const t0 = Date.now();
  const res = await page.evaluate(() => window.exportMap());
  fs.mkdirSync(path.join(ROOT, 'out'), { recursive: true });
  const write = (name, dataUrl) => fs.writeFileSync(path.join(ROOT, 'out', name), Buffer.from(dataUrl.split(',')[1], 'base64'));
  write('render.png', res.render);
  write('idmap.png', res.idmap);
  fs.writeFileSync(path.join(ROOT, 'out/meta.json'), JSON.stringify(res.meta));
  console.log(`exported ${res.meta.width}x${res.meta.height}px (${res.meta.buildings.length} buildings) in ${((Date.now() - t0) / 1000).toFixed(1)}s -> out/`);
} finally {
  await browser.close();
  server.close();
}
