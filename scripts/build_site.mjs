// Builds a static, deployable copy of the viewer in site/ (GitHub Pages, Cloudflare Pages, Netlify…).
//   npm run site                      -> site/
//   SITE_URL=https://example.com/ npm run site   (absolute URL used for social-preview tags)
// The painted map is cut into Deep Zoom tiles so visitors only download what is on screen.
// photo.png (raw Google imagery) and render.png are never shipped.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG, crop, resize } from './png.mjs';
import { buildDZI } from './tiles.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'site');
const OUT = path.join(ROOT, 'out');
const SITE_URL = (process.env.SITE_URL || 'https://appleayaan.github.io/isometric-waterloo/').replace(/\/?$/, '/');
const t0 = Date.now();

fs.rmSync(SITE, { recursive: true, force: true });
fs.mkdirSync(path.join(SITE, 'out'), { recursive: true });

// viewer files (sprites/, icons, traffic.js…)
for (const f of fs.readdirSync(path.join(ROOT, 'viewer'))) {
  if (f === 'index.html' || f.startsWith('.')) continue;
  fs.cpSync(path.join(ROOT, 'viewer', f), path.join(SITE, f), { recursive: true, filter: (s) => !path.basename(s).startsWith('.') });
}

// data the viewer reads
for (const f of ['meta.json', 'traffic.json', 'walk.json', 'idmap.png']) {
  const src = path.join(OUT, f);
  if (!fs.existsSync(src)) { if (f === 'traffic.json' || f === 'walk.json') continue; /* optional: the viewer hides those features */ throw new Error(`missing out/${f}: run npm run export first`); }
  fs.copyFileSync(src, path.join(SITE, 'out', f));
}

// the map itself, as a tile pyramid (painted map, or the whitebox if it hasn't been painted yet)
const mapSrc = ['map.png', 'render.png'].map((f) => path.join(OUT, f)).find((f) => fs.existsSync(f));
if (!mapSrc) throw new Error('no out/map.png or out/render.png to publish');
const img = decodePNG(fs.readFileSync(mapSrc));
const { tiles, levels } = buildDZI(img, path.join(SITE, 'out', 'map'));
fs.writeFileSync(path.join(SITE, 'out', 'layer.json'), JSON.stringify({ painted: path.basename(mapSrc) === 'map.png' }));

// the night map (npm run night), tiled the same way; the viewer only fetches it when night mode is on
let nightNote = '';
if (fs.existsSync(path.join(OUT, 'night.png')) && fs.existsSync(path.join(OUT, 'night.json'))) {
  const n = buildDZI(decodePNG(fs.readFileSync(path.join(OUT, 'night.png'))), path.join(SITE, 'out', 'night'));
  nightNote = `, night map ${n.tiles} tiles`;
  // seasonal night maps (npm run night -- --season winter); the viewer swaps to one when that season is shown
  const info = JSON.parse(fs.readFileSync(path.join(OUT, 'night.json'), 'utf8'));
  info.variants = ['winter'].filter((v) => fs.existsSync(path.join(OUT, `night-${v}.png`)));
  for (const v of info.variants) {
    const t = buildDZI(decodePNG(fs.readFileSync(path.join(OUT, `night-${v}.png`))), path.join(SITE, 'out', `night-${v}`));
    nightNote += `, ${v} night ${t.tiles} tiles`;
  }
  fs.writeFileSync(path.join(SITE, 'out', 'night.json'), JSON.stringify(info));
}

// social preview: the middle of campus at 1200x630
const meta = JSON.parse(fs.readFileSync(path.join(OUT, 'meta.json'), 'utf8'));
const cw = Math.round(img.width * 0.46), ch = Math.round(cw * 630 / 1200);
const og = resize(crop(img, Math.round(img.width * 0.5 - cw / 2), Math.round(img.height * 0.4 - ch / 2), cw, ch), 1200, 630);
fs.writeFileSync(path.join(SITE, 'og.png'), encodePNG(og));

// page: point at ./out/, fill in absolute URLs for link previews
const src = fs.readFileSync(path.join(ROOT, 'viewer/index.html'), 'utf8');
for (const needle of ["new URL('../out/', location.href)", 'const TILED = false;']) if (!src.includes(needle)) throw new Error(`viewer/index.html no longer contains ${needle}`);
const html = src
  .replace("new URL('../out/', location.href)", "new URL('./out/', location.href)")
  .replace('const TILED = false;', 'const TILED = true;')
  .replaceAll('%SITE_URL%', SITE_URL);
fs.writeFileSync(path.join(SITE, 'index.html'), html);

fs.writeFileSync(path.join(SITE, 'site.webmanifest'), JSON.stringify({
  name: 'Isometric UWaterloo', short_name: 'Iso UW', start_url: './', display: 'standalone',
  background_color: meta.background || '#f3eee4', theme_color: meta.background || '#f3eee4',
  icons: [{ src: 'icon-192.png', sizes: '192x192', type: 'image/png' }, { src: 'icon-512.png', sizes: '512x512', type: 'image/png' }],
}, null, 2));
fs.writeFileSync(path.join(SITE, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${SITE_URL}sitemap.xml\n`);
fs.writeFileSync(path.join(SITE, 'sitemap.xml'),
  `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${SITE_URL}</loc></url></urlset>\n`);
fs.writeFileSync(path.join(SITE, '404.html'), `<!doctype html><meta charset="utf-8"><title>Not found · Isometric UWaterloo</title><meta http-equiv="refresh" content="0; url=${SITE_URL}"><a href="${SITE_URL}">Back to the map</a>\n`);
fs.writeFileSync(path.join(SITE, '.nojekyll'), ''); // GitHub Pages: serve map_files/ etc. as-is
// Cloudflare Pages / Netlify: tiles never change between builds of the same map, the page and data might
fs.writeFileSync(path.join(SITE, '_headers'), [
  '/out/map_files/*', '  Cache-Control: public, max-age=604800', '',
  '/out/night_files/*', '  Cache-Control: public, max-age=604800', '',
  '/sprites/*', '  Cache-Control: public, max-age=604800', '',
  '/*', '  X-Content-Type-Options: nosniff', '  Referrer-Policy: strict-origin-when-cross-origin', '',
].join('\n'));

const size = (d) => fs.readdirSync(d, { withFileTypes: true }).reduce((s, e) => s + (e.isDirectory() ? size(path.join(d, e.name)) : fs.statSync(path.join(d, e.name)).size), 0);
console.log(`site/ ready in ${((Date.now() - t0) / 1000).toFixed(1)}s: ${path.basename(mapSrc)} -> ${levels} levels / ${tiles} tiles${nightNote}, ` +
  `${(size(SITE) / 1e6).toFixed(1)} MB total, social image + manifest for ${SITE_URL}`);
