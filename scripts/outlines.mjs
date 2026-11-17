// Computes the hover/selection outlines in out/meta.json: for each building, the exact screen-space
// silhouette of its extruded volumes (top, bottom and every wall), traced at mosaic resolution so the
// outline hugs the walls instead of bridging courtyards and L-shapes like a convex hull would.
//
// Runs automatically at the end of `npm run export`; `npm run outlines` refreshes meta.json alone
// (no re-render needed, the projection is recomputed from data/scene.json and the meta settings).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SLAB = 14; // must match render/render.js

// ---------- projection (mirrors makeCamera/computeLayout in render/render.js) ----------
function makeProjector(scene, meta) {
  const e = (meta.elevation * Math.PI) / 180, a = (meta.azimuth * Math.PI) / 180;
  const dir = [Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)];
  const norm = (v) => { const l = Math.hypot(...v); return v.map((c) => c / l); };
  const cross = (p, q) => [p[1] * q[2] - p[2] * q[1], p[2] * q[0] - p[0] * q[2], p[0] * q[1] - p[1] * q[0]];
  const right = norm(cross([0, 1, 0], dir));
  const up = cross(dir, right);
  const R = (x, h, y) => x * right[0] + h * right[1] - y * right[2];
  const U = (x, h, y) => x * up[0] + h * up[1] - y * up[2];

  const { minX, maxX, minY, maxY } = scene.bounds;
  let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity;
  const add = (x, h, y) => {
    const r = R(x, h, y), u = U(x, h, y);
    minR = Math.min(minR, r); maxR = Math.max(maxR, r); minU = Math.min(minU, u); maxU = Math.max(maxU, u);
  };
  for (const [x, y] of [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]) { add(x, 0, y); add(x, -SLAB, y); }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  for (const b of scene.buildings) for (const [x, y] of b.outer) add(clamp(x, minX, maxX), b.height, clamp(y, minY, maxY));
  const S = meta.scale;
  const padR = (meta.width / S - (maxR - minR)) / 2, padU = (meta.height / S - (maxU - minU)) / 2;
  const left = minR - padR, top = maxU + padU;
  return (x, y, h) => [(R(x, h, y) - left) * S, (top - U(x, h, y)) * S];
}

// ---------- 2D helpers ----------
// Sutherland–Hodgman against the bbox (the renderer clips the scene to it too).
function clipRect(ring, { minX, maxX, minY, maxY }) {
  const edges = [
    [(p) => p[0] >= minX, (p, q) => [minX, p[1] + ((q[1] - p[1]) * (minX - p[0])) / (q[0] - p[0])]],
    [(p) => p[0] <= maxX, (p, q) => [maxX, p[1] + ((q[1] - p[1]) * (maxX - p[0])) / (q[0] - p[0])]],
    [(p) => p[1] >= minY, (p, q) => [p[0] + ((q[0] - p[0]) * (minY - p[1])) / (q[1] - p[1]), minY]],
    [(p) => p[1] <= maxY, (p, q) => [p[0] + ((q[0] - p[0]) * (maxY - p[1])) / (q[1] - p[1]), maxY]],
  ];
  let out = ring;
  for (const [inside, cut] of edges) {
    const src = out;
    out = [];
    for (let i = 0; i < src.length; i++) {
      const p = src[i], q = src[(i + 1) % src.length];
      if (inside(p)) { out.push(p); if (!inside(q)) out.push(cut(p, q)); } else if (inside(q)) out.push(cut(p, q));
    }
    if (out.length < 3) return [];
  }
  return out;
}

// Binary mask over a pixel window; polygons are filled even-odd, sampled at pixel centres.
class Mask {
  constructor(x0, y0, w, h) { Object.assign(this, { x0, y0, w, h, d: new Uint8Array(w * h) }); }
  fill(rings) {
    const edges = [];
    for (const r of rings) for (let i = 0; i < r.length; i++) edges.push([r[i], r[(i + 1) % r.length]]);
    const xs = [];
    for (let j = 0; j < this.h; j++) {
      const y = this.y0 + j + 0.5;
      xs.length = 0;
      for (const [p, q] of edges) {
        if ((p[1] > y) !== (q[1] > y)) xs.push(p[0] + ((y - p[1]) * (q[0] - p[0])) / (q[1] - p[1]));
      }
      xs.sort((m, n) => m - n);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, Math.ceil(xs[k] - this.x0 - 0.5)), b = Math.min(this.w - 1, Math.floor(xs[k + 1] - this.x0 - 0.5));
        for (let i = a; i <= b; i++) this.d[j * this.w + i] = 1;
      }
    }
  }
  at(i, j) { return i >= 0 && j >= 0 && i < this.w && j < this.h ? this.d[j * this.w + i] : 0; }
  // Traces pixel-edge boundaries into closed rings (filled region on the left), in absolute pixel coords.
  trace() {
    const next = new Map(); // "x,y" -> list of end vertices
    const key = (x, y) => x * 100003 + y;
    const push = (ax, ay, bx, by) => { const k = key(ax, ay); (next.get(k) || next.set(k, []).get(k)).push([bx, by]); };
    for (let j = 0; j < this.h; j++) for (let i = 0; i < this.w; i++) {
      if (!this.d[j * this.w + i]) continue;
      if (!this.at(i, j - 1)) push(i, j, i + 1, j);
      if (!this.at(i + 1, j)) push(i + 1, j, i + 1, j + 1);
      if (!this.at(i, j + 1)) push(i + 1, j + 1, i, j + 1);
      if (!this.at(i - 1, j)) push(i, j + 1, i, j);
    }
    const rings = [];
    for (const [k0, list0] of next) {
      while (list0.length) {
        const sx = Math.floor(k0 / 100003), sy = k0 % 100003;
        const ring = [[sx, sy]];
        let [px, py] = [sx, sy], [cx, cy] = list0.pop();
        while (cx !== sx || cy !== sy) {
          ring.push([cx, cy]);
          const list = next.get(key(cx, cy));
          // at a saddle (two exits) keep the region on the left by preferring the left turn
          let idx = 0;
          if (list.length > 1) {
            const dx = cx - px, dy = cy - py;
            idx = list.findIndex(([nx, ny]) => (nx - cx) * dy - (ny - cy) * dx > 0);
            if (idx < 0) idx = 0;
          }
          [px, py] = [cx, cy];
          [cx, cy] = list.splice(idx, 1)[0];
        }
        rings.push(ring.map(([x, y]) => [x + this.x0, y + this.y0]));
      }
    }
    return rings;
  }
}

// Douglas–Peucker on a closed ring (staircase pixel edges -> clean straight lines).
function simplify(ring, tol) {
  const dp = (pts) => {
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      const [ax, ay] = pts[a], [bx, by] = pts[b];
      const len = Math.hypot(bx - ax, by - ay) || 1;
      let best = -1, bi = -1;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((bx - ax) * (ay - pts[i][1]) - (ax - pts[i][0]) * (by - ay)) / len;
        if (d > best) { best = d; bi = i; }
      }
      if (best > tol) { keep[bi] = 1; stack.push([a, bi], [bi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  };
  // split at the point farthest from the start so both halves are open chains
  let far = 0, fd = -1;
  ring.forEach(([x, y], i) => { const d = Math.hypot(x - ring[0][0], y - ring[0][1]); if (d > fd) { fd = d; far = i; } });
  const a = dp(ring.slice(0, far + 1)), b = dp(ring.slice(far).concat([ring[0]]));
  return a.concat(b.slice(1, -1)).map(([x, y]) => [+x.toFixed(1), +y.toFixed(1)]);
}
const ringArea = (r) => { let s = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]); return s / 2; };

// Rasterises faces (lists of rings, pixel coords) and traces the result back into simplified rings.
function traceShapes(faces, { minArea = 4, tol = 1.5 } = {}) {
  const pts = faces.flat(2);
  if (!pts.length) return [];
  const pad = 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  x0 = Math.floor(x0) - pad; y0 = Math.floor(y0) - pad;
  const m = new Mask(x0, y0, Math.ceil(x1) - x0 + pad + 1, Math.ceil(y1) - y0 + pad + 1);
  for (const f of faces) m.fill(f);
  return m.trace()
    .filter((r) => Math.abs(ringArea(r)) >= minArea)
    .map((r) => simplify(r, tol)).filter((r) => r.length >= 3);
}

// ---------- outlines ----------
export function computeOutlines(scene, meta) {
  const toPx = makeProjector(scene, meta);
  const byId = new Map();
  for (const b of scene.buildings) (byId.get(b.id) || byId.set(b.id, []).get(b.id)).push(b);
  for (const info of meta.buildings) {
    const faces = [];
    for (const b of byId.get(info.id) || []) {
      for (const v of b.volumes) {
        const rings = [v.outer, ...(v.holes || [])].map((r) => clipRect(r, scene.bounds)).filter((r) => r.length >= 3);
        if (!rings.length) continue;
        const h0 = v.minHeight || 0, h1 = Math.max(h0 + 0.5, v.height);
        faces.push(rings.map((r) => r.map(([x, y]) => toPx(x, y, h1))));
        faces.push(rings.map((r) => r.map(([x, y]) => toPx(x, y, h0))));
        for (const r of rings) for (let i = 0; i < r.length; i++) {
          const p = r[i], q = r[(i + 1) % r.length];
          faces.push([[toPx(p[0], p[1], h0), toPx(q[0], q[1], h0), toPx(q[0], q[1], h1), toPx(p[0], p[1], h1)]]);
        }
      }
    }
    const outlines = traceShapes(faces);
    if (outlines.length) info.outlines = outlines;
  }

  return meta;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const scene = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/scene.json'), 'utf8'));
  const metaFile = path.join(ROOT, 'out/meta.json');
  const meta = computeOutlines(scene, JSON.parse(fs.readFileSync(metaFile, 'utf8')));
  // keep codes/names in sync with the scene (overrides) without a re-render
  const src = new Map(scene.buildings.map((b) => [b.id, b]));
  for (const b of meta.buildings) { const s = src.get(b.id); if (s) { b.ref = s.ref; b.name = s.name; } }
  fs.writeFileSync(metaFile, JSON.stringify(meta));
  console.log(`outlines: ${meta.buildings.length} buildings`);
}
