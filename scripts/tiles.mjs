// Cuts a big PNG into a Deep Zoom (DZI) pyramid so the viewer streams only the tiles on screen
// instead of decoding the whole 25-megapixel map up front (matters a lot on phones).
//   node scripts/tiles.mjs out/map.png site/out/map   ->  site/out/map.dzi + site/out/map_files/<level>/<col>_<row>.png
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG, crop, resize } from './png.mjs';

export function buildDZI(img, outBase, { tileSize = 510, overlap = 1 } = {}) {
  const maxLevel = Math.ceil(Math.log2(Math.max(img.width, img.height)));
  const dir = outBase + '_files';
  fs.rmSync(dir, { recursive: true, force: true });
  let level = img, count = 0;
  for (let L = maxLevel; L >= 0; L--) {
    if (L !== maxLevel) level = resize(level, Math.max(1, Math.ceil(level.width / 2)), Math.max(1, Math.ceil(level.height / 2)));
    const ld = path.join(dir, String(L));
    fs.mkdirSync(ld, { recursive: true });
    const cols = Math.ceil(level.width / tileSize), rows = Math.ceil(level.height / tileSize);
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
      const x0 = Math.max(0, c * tileSize - overlap), y0 = Math.max(0, r * tileSize - overlap);
      const x1 = Math.min(level.width, (c + 1) * tileSize + overlap), y1 = Math.min(level.height, (r + 1) * tileSize + overlap);
      fs.writeFileSync(path.join(ld, `${c}_${r}.png`), encodePNG(crop(level, x0, y0, x1 - x0, y1 - y0)));
      count++;
    }
  }
  fs.writeFileSync(outBase + '.dzi',
    `<?xml version="1.0" encoding="UTF-8"?>\n<Image xmlns="http://schemas.microsoft.com/deepzoom/2008" Format="png" Overlap="${overlap}" TileSize="${tileSize}">\n` +
    `  <Size Width="${img.width}" Height="${img.height}"/>\n</Image>\n`);
  return { levels: maxLevel + 1, tiles: count };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [src, out] = process.argv.slice(2);
  if (!src || !out) { console.error('usage: node scripts/tiles.mjs <in.png> <out-base>'); process.exit(1); }
  const t = Date.now();
  const r = buildDZI(decodePNG(fs.readFileSync(src)), out);
  console.log(`${out}.dzi: ${r.levels} levels, ${r.tiles} tiles in ${((Date.now() - t) / 1000).toFixed(1)}s`);
}
