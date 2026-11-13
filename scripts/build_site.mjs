// Builds a static, deployable copy of the viewer in site/ (for GitHub Pages, Cloudflare Pages, Netlify…).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(path.join(SITE, 'out'), { recursive: true });
const html = fs.readFileSync(path.join(ROOT, 'viewer/index.html'), 'utf8').replace("new URL('../out/', location.href)", "new URL('./out/', location.href)");
fs.writeFileSync(path.join(SITE, 'index.html'), html);
for (const f of ['map.png', 'render.png', 'idmap.png', 'meta.json']) {
  const src = path.join(ROOT, 'out', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SITE, 'out', f));
}
console.log('site/ ready:', fs.readdirSync(path.join(SITE, 'out')).join(', '));
