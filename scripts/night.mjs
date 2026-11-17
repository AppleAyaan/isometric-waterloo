// Bakes the night version of the painted map: out/night.png, same size and projection as out/map.png.
//
//   - the daytime paint is graded to moonlight: darker, cooler, a little desaturated, purple in the shadows;
//   - every wall that faces the camera gets a grid of windows (floors x bays, from OSM heights and levels);
//     a hash per room decides which are lit, and how warm. Busy late-night buildings (Dana Porter, DC, MC,
//     SLC, the residences) are lit much more than offices and houses;
//   - street lights along the roads, paths and parking lots throw warm pools onto the ground. The pool
//     multiplies the painted ground, so asphalt, grass and paving keep their own texture under the light;
//   - lamp heads and lit windows bloom softly.
// Visibility comes from a depth buffer of the extruded OSM buildings, rasterised in the map's own projection,
// so a window is only drawn where its wall is actually the front-most surface.
//
//   npm run night                      -> out/night.png
//   npm run night -- --crop x,y,w,h    -> scratch preview of a region (out/night-crop.png)
//   npm run night -- --season winter   -> out/night-winter.png, from the day map under snow (viewer/seasons.js)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { decodePNG, encodePNG } from './png.mjs';
import { makeProjector, clipRect } from './outlines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const t0 = Date.now();
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };

const scene = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/scene.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/meta.json'), 'utf8'));
const srcFile = ['map.png', 'render.png'].map((f) => path.join(ROOT, 'out', f)).find((f) => fs.existsSync(f));
const day = decodePNG(fs.readFileSync(srcFile));
const crop = arg('--crop')?.split(',').map(Number);
const season = arg('--season');
if (season && season !== 'winter') throw new Error(`no ${season} recolour (only --season winter)`);
if (season) winterize(day);

// Snow on the day map before it's graded, with the viewer's own recolour (so day and night winter match).
// Lakes come from viewer/water.json, filled into a mask a strip of rows at a time.
function winterize(img) {
  const ctx = { onApp: () => {} };
  ctx.self = ctx;
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'viewer/seasons.js'), 'utf8'), ctx);
  const water = JSON.parse(fs.readFileSync(path.join(ROOT, 'viewer/water.json'), 'utf8'));
  const { width: w, height: h } = img, STRIP = 256;
  const edges = [];
  for (const { o, h: holes } of water) for (const ring of [o, ...holes]) for (let i = 0; i < ring.length; i += 2) {
    const k = (i + 2) % ring.length;
    edges.push([ring[i], ring[i + 1], ring[k], ring[k + 1]]);
  }
  for (let y0 = 0; y0 < h; y0 += STRIP) {
    const sh = Math.min(STRIP, h - y0), wm = new Uint8Array(w * sh * 4), xs = [];
    for (let j = 0; j < sh; j++) { // even-odd scanline fill at pixel centres
      const y = y0 + j + 0.5;
      xs.length = 0;
      for (const [ax, ay, bx, by] of edges) if ((ay <= y) !== (by <= y)) xs.push(ax + ((y - ay) / (by - ay)) * (bx - ax));
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x < Math.min(w, Math.ceil(xs[k + 1] - 0.5)); x++) wm[(j * w + x) * 4 + 3] = 255;
      }
    }
    // (a clamped view, as in the browser: snow can run past 255)
    const px = new Uint8ClampedArray(img.data.buffer, img.data.byteOffset + y0 * w * 4, sh * w * 4);
    ctx.winterRecolour(px, w, sh, { x0: 0, y0, s: 1, wm });
  }
}
const [OX, OY, W, H] = crop || [0, 0, day.width, day.height];

// ---------- projection + depth ----------
const P = makeProjector(scene, meta);
const o = P(0, 0, 0), ex = P(1, 0, 0), ey = P(0, 1, 0), eh = P(0, 0, 1);
const A = [ex[0] - o[0], ey[0] - o[0], eh[0] - o[0]], B = [ex[1] - o[1], ey[1] - o[1], eh[1] - o[1]];
const proj = (x, y, h) => [A[0] * x + A[1] * y + A[2] * h + o[0] - OX, B[0] * x + B[1] * y + B[2] * h + o[1] - OY];
const det = A[0] * B[1] - A[1] * B[0];
const ground = (sx, sy) => { const u = sx + OX - o[0], v = sy + OY - o[1]; return [(u * B[1] - v * A[1]) / det, (v * A[0] - u * B[0]) / det]; };
const el = (meta.elevation * Math.PI) / 180, az = (meta.azimuth * Math.PI) / 180;
const DIR = [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
const depthOf = (x, y, h) => x * DIR[0] + h * DIR[1] - y * DIR[2]; // larger = nearer the camera
const CAM = [Math.sin(az), -Math.cos(az)]; // horizontal direction towards the camera
const pxPerM = Math.hypot(A[0], B[0]);

const N = W * H;
const depth = new Float32Array(N).fill(-Infinity);
const owner = new Int32Array(N); // building id of the front-most surface (0 = ground)

// Even-odd scanline fill of a planar polygon (screen coords, with the 3D depth of each vertex).
// Calls fn(i, j, d) for every pixel centre inside, d = interpolated depth.
function raster(rings, depths, fn) {
  const pts = rings.flat(), ds = depths.flat();
  // depth is affine in screen space for a planar face under an orthographic camera: fit the plane
  let best = 0, tri = null;
  for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < Math.min(pts.length, a + 6); b++) for (let c = b + 1; c < Math.min(pts.length, b + 6); c++) {
    const ar = Math.abs((pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[c][0] - pts[a][0]) * (pts[b][1] - pts[a][1]));
    if (ar > best) { best = ar; tri = [a, b, c]; }
  }
  if (!tri || best < 0.5) return;
  const [p, q, r] = tri.map((k) => pts[k]), [dp, dq, dr] = tri.map((k) => ds[k]);
  const den = (q[0] - p[0]) * (r[1] - p[1]) - (r[0] - p[0]) * (q[1] - p[1]);
  const gx = ((dq - dp) * (r[1] - p[1]) - (dr - dp) * (q[1] - p[1])) / den;
  const gy = ((dr - dp) * (q[0] - p[0]) - (dq - dp) * (r[0] - p[0])) / den;
  let y0 = Infinity, y1 = -Infinity;
  for (const s of pts) { y0 = Math.min(y0, s[1]); y1 = Math.max(y1, s[1]); }
  const edges = [];
  for (const ring of rings) for (let i = 0; i < ring.length; i++) edges.push([ring[i], ring[(i + 1) % ring.length]]);
  const xs = [];
  for (let j = Math.max(0, Math.ceil(y0 - 0.5)); j <= Math.min(H - 1, Math.floor(y1 - 0.5)); j++) {
    const y = j + 0.5;
    xs.length = 0;
    for (const [s, t] of edges) if ((s[1] > y) !== (t[1] > y)) xs.push(s[0] + ((y - s[1]) * (t[0] - s[0])) / (t[1] - s[1]));
    xs.sort((m, n) => m - n);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] - 0.5)), b = Math.min(W - 1, Math.floor(xs[k + 1] - 0.5));
      for (let i = a; i <= b; i++) fn(i, j, dp + gx * (i + 0.5 - p[0]) + gy * (y - p[1]));
    }
  }
}

const signedArea = (r) => { let s = 0; for (let i = 0; i < r.length; i++) { const a = r[i], b = r[(i + 1) % r.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
const inView = (pts) => pts.some(([x, y]) => x > -50 && y > -50 && x < W + 50 && y < H + 50);

// every visible-side wall of every volume: { b, x0, y0, x1, y1, z0, z1, k }
const walls = [];
const solids = [];
for (const b of scene.buildings) {
  for (const v of b.volumes || [b]) {
    const rings = [v.outer, ...(v.holes || [])].map((r) => clipRect(r, scene.bounds)).filter((r) => r.length >= 3);
    if (!rings.length) continue;
    const z0 = v.minHeight || 0, z1 = v.height;
    solids.push({ b, rings, z0, z1 });
    rings.forEach((r, ri) => {
      const ccw = signedArea(r) > 0 !== (ri > 0); // holes wind the other way round their courtyard
      for (let i = 0; i < r.length; i++) {
        const [x0, y0] = r[i], [x1, y1] = r[(i + 1) % r.length];
        const len = Math.hypot(x1 - x0, y1 - y0);
        if (len < 0.4) continue;
        const nx = (ccw ? y1 - y0 : y0 - y1) / len, ny = (ccw ? x0 - x1 : x1 - x0) / len; // outward
        const facing = nx * CAM[0] + ny * CAM[1];
        if (facing <= 0.02) continue;
        // walls on the bbox cut are the clipping plane, not a facade
        const onEdge = (x, y) => Math.min(Math.abs(x - scene.bounds.minX), Math.abs(x - scene.bounds.maxX), Math.abs(y - scene.bounds.minY), Math.abs(y - scene.bounds.maxY)) < 0.05;
        if (onEdge(x0, y0) && onEdge(x1, y1)) continue;
        walls.push({ b, x0, y0, x1, y1, z0, z1, len, nx, ny, facing, k: walls.length });
      }
    });
  }
}

// ---------- pass 1: depth buffer (roofs + walls) ----------
for (const s of solids) {
  const top = s.rings.map((r) => r.map(([x, y]) => proj(x, y, s.z1)));
  if (!inView(top) && !inView(s.rings.map((r) => r.map(([x, y]) => proj(x, y, s.z0))).flat())) continue;
  raster(top, s.rings.map((r) => r.map(([x, y]) => depthOf(x, y, s.z1))), (i, j, d) => {
    const k = j * W + i;
    if (d > depth[k]) { depth[k] = d; owner[k] = s.b.id; }
  });
}
const wallQuad = (w, z0 = w.z0, z1 = w.z1) => [[proj(w.x0, w.y0, z0), proj(w.x1, w.y1, z0), proj(w.x1, w.y1, z1), proj(w.x0, w.y0, z1)]];
const wallDepth = (w, z0 = w.z0, z1 = w.z1) => [[depthOf(w.x0, w.y0, z0), depthOf(w.x1, w.y1, z0), depthOf(w.x1, w.y1, z1), depthOf(w.x0, w.y0, z1)]];
for (const w of walls) {
  const q = wallQuad(w);
  if (!inView(q[0])) continue;
  raster(q, wallDepth(w), (i, j, d) => { const k = j * W + i; if (d > depth[k]) { depth[k] = d; owner[k] = w.b.id; } });
}
console.log(`depth: ${solids.length} volumes, ${walls.length} camera-facing walls (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// ---------- how lit is each building tonight ----------
const hash = (...n) => { let h = 2166136261; for (const v of n) { h ^= v & 0xffff; h = Math.imul(h, 16777619); h ^= v >>> 16; h = Math.imul(h, 16777619); } h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15; return (h >>> 0) / 4294967296; };
// colour temperatures (linear-ish RGB, 1 = full)
const WARM = [1.0, 0.66, 0.34], SOFT = [1.0, 0.8, 0.55], NEUTRAL = [1.0, 0.9, 0.74], COOL = [0.84, 0.92, 1.0], TV = [0.55, 0.7, 1.0];
// late-night campus: the library, DC and the study spaces stay busy; residences are home time
const BUSY = { LIB: 0.94, DC: 0.72, MC: 0.6, SLC: 0.62, QNC: 0.5, E7: 0.55, E5: 0.5, E6: 0.45, EIT: 0.45, STC: 0.5, PAC: 0.35, CIF: 0.4, M3: 0.45, DWE: 0.4, EV3: 0.35, ML: 0.35, HH: 0.35, SCH: 0.45, PHY: 0.4, C2: 0.35, B1: 0.3, B2: 0.3, ESC: 0.3 };
const RES = new Set(['V1', 'REV', 'MKV', 'UWP', 'CMH', 'CLV', 'UC', 'STJ', 'REN', 'CGR', 'STP', 'WCR']);
function lighting(b) {
  const kind = b.kind, ref = b.ref;
  const t = { p: 0.3, ground: 0.4, colors: [[NEUTRAL, 0.4], [SOFT, 0.35], [COOL, 0.25]], bay: 3.2, ww: 0.72, sill: 0.3, wh: 0.5, floor: 4.0, gain: 0.6 };
  if (ref && BUSY[ref] != null) t.p = BUSY[ref];
  else if (ref) t.p = 0.26;
  else t.p = 0.2;
  if (ref === 'LIB') Object.assign(t, { ground: 0.95, colors: [[NEUTRAL, 0.5], [SOFT, 0.35], [COOL, 0.15]], bay: 2.4, ww: 0.62, sill: 0.18, wh: 0.66, gain: 1.0 });
  if (ref === 'DC' || ref === 'SLC') Object.assign(t, { ground: 0.85, gain: 0.72 });
  const res = RES.has(ref) || ['dormitory', 'apartments', 'residential'].includes(kind);
  const home = ['house', 'detached', 'terrace'].includes(kind);
  if (res) Object.assign(t, { p: Math.max(t.p, 0.46), ground: 0.6, colors: [[WARM, 0.45], [SOFT, 0.35], [NEUTRAL, 0.12], [TV, 0.08]], bay: 3.4, ww: 0.46, sill: 0.32, wh: 0.46, floor: 2.9 });
  if (home) Object.assign(t, { p: 0.36, ground: 0.45, colors: [[WARM, 0.6], [SOFT, 0.3], [TV, 0.1]], bay: 4.2, ww: 0.36, sill: 0.33, wh: 0.42, floor: 2.9 });
  if (['retail', 'commercial'].includes(kind)) Object.assign(t, { p: 0.22, ground: 0.92, colors: [[NEUTRAL, 0.6], [COOL, 0.25], [SOFT, 0.15]], bay: 3.0 });
  if (kind === 'office' && !BUSY[ref]) t.p = 0.18;
  if (['shed', 'garage', 'roof', 'service', 'bridge', 'industrial', 'part'].includes(kind) || (b.height || 0) < 3) t.p = t.ground = 0;
  // floor height from OSM levels when they look plausible
  if (b.levels && b.height) { const fh = b.height / b.levels; if (fh >= 2.6 && fh <= 5.2) t.floor = fh; }
  return t;
}
const LIGHT = new Map(scene.buildings.map((b) => [b.id, lighting(b)]));
const pickColor = (cs, r) => { for (const [c, w] of cs) { if ((r -= w) <= 0) return c; } return cs[0][0]; };

// ---------- pass 2: windows -> emission buffer ----------
const E = new Float32Array(N * 3);
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
const porchLights = []; // lit ground-floor rooms spill a little light onto the pavement outside
let litCells = 0;
for (const w of walls) {
  const L = LIGHT.get(w.b.id);
  if (!L.p && !L.ground) continue;
  const q = wallQuad(w);
  if (!inView(q[0])) continue;
  // wall plane: screen = S0 + u * Su + z * Sz  ->  invert to (u along the wall, z up)
  const S0 = proj(w.x0, w.y0, 0), Su = [(A[0] * (w.x1 - w.x0) + A[1] * (w.y1 - w.y0)) / w.len, (B[0] * (w.x1 - w.x0) + B[1] * (w.y1 - w.y0)) / w.len], Sz = [A[2], B[2]];
  const dt = Su[0] * Sz[1] - Su[1] * Sz[0];
  if (Math.abs(dt) < 1e-6) continue;
  const bays = Math.max(1, Math.round(w.len / L.bay)), bw = w.len / bays;
  const room = 1 + Math.floor(hash(w.b.id, 7) * 3); // rooms span 1-3 bays
  const top = w.b.height - 0.7;
  // soft window edges about a third of a pixel wide
  const eu = 0.6 / pxPerM / bw, ez = 0.6 / pxPerM / L.floor;
  raster(q, wallDepth(w), (i, j, d) => {
    const k = j * W + i;
    if (d < depth[k] - 0.35) return; // something nearer covers this bit of wall
    const sx = i + 0.5 - S0[0], sy = j + 0.5 - S0[1];
    const u = (sx * Sz[1] - sy * Sz[0]) / dt, z = (Su[0] * sy - Su[1] * sx) / dt;
    if (z < 0.4 || z > top) return;
    const fl = Math.floor(z / L.floor), bay = Math.floor(u / bw);
    if (bay < 0 || bay >= bays) return;
    const fu = u / bw - bay, fz = z / L.floor - fl;
    const m = smooth(0.5 - L.ww / 2 - eu, 0.5 - L.ww / 2 + eu, fu) * smooth(0.5 + L.ww / 2 + eu, 0.5 + L.ww / 2 - eu, fu)
      * smooth(L.sill - ez, L.sill + ez, fz) * smooth(L.sill + L.wh + ez, L.sill + L.wh - ez, fz);
    if (m <= 0.01) return;
    const rm = Math.floor(bay / room);
    const p = fl === 0 ? L.ground : L.p;
    // whole floors tend to be on together (corridor lights, a study floor), rooms vary within them
    const floorOn = hash(w.b.id, fl, 3) < 0.25 ? 0.25 : 0;
    if (hash(w.b.id, w.k, fl, rm) >= p + floorOn) return;
    const c = pickColor(L.colors, hash(w.b.id, fl, rm, 11));
    const lr = hash(w.b.id, w.k, fl, rm, 5), lum = (lr < 0.3 ? 0.18 + lr : 0.45 + 0.45 * lr) * m * L.gain; // some rooms behind blinds
    // a lit room is brightest in the middle of the pane and fades toward the frame
    const glow = lum * (0.8 + 0.2 * Math.sin(Math.PI * fu));
    E[k * 3] += c[0] * glow; E[k * 3 + 1] += c[1] * glow; E[k * 3 + 2] += c[2] * glow;
    litCells++;
  });
  if (L.ground > 0.5) for (let bay = 0; bay < bays; bay += 2) {
    if (hash(w.b.id, w.k, 0, Math.floor(bay / room)) >= L.ground) continue;
    const u = (bay + 0.5) * bw, x = w.x0 + ((w.x1 - w.x0) * u) / w.len + w.nx * 2.2, y = w.y0 + ((w.y1 - w.y0) * u) / w.len + w.ny * 2.2;
    porchLights.push({ x, y, r: 5.5, i: 0.45, c: SOFT });
  }
}
console.log(`windows: ${litCells} lit window pixels (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

// ---------- street lights ----------
const lamps = [];
const pip = (x, y, r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
const footprints = scene.buildings.map((b) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of b.outer) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  return { r: b.outer, x0, y0, x1, y1 };
});
const indoors = (x, y) => footprints.some((f) => x > f.x0 - 1 && x < f.x1 + 1 && y > f.y0 - 1 && y < f.y1 + 1 && pip(x, y, f.r));
const B0 = scene.bounds;
const inB = (x, y) => x > B0.minX + 3 && x < B0.maxX - 3 && y > B0.minY + 3 && y < B0.maxY - 3;
// sodium-yellow on the roads, warm LED on the paths and lots (the cool purple night sits around them)
const SODIUM = [1.0, 0.56, 0.17], LED = [1.0, 0.74, 0.42], LOT = [1.0, 0.66, 0.3];
const ROAD_LAMPS = {
  secondary: { gap: 34, h: 9, r: 19, i: 1.0, c: SODIUM, both: true }, tertiary: { gap: 34, h: 8.5, r: 18, i: 1.0, c: SODIUM, both: true },
  unclassified: { gap: 32, h: 8, r: 17, i: 0.95, c: SODIUM }, residential: { gap: 38, h: 7.5, r: 15, i: 0.85, c: SODIUM },
  service: { gap: 48, h: 6.5, r: 13, i: 0.65, c: LED },
  footway: { gap: 38, h: 4.2, r: 7, i: 0.45, c: LED }, path: { gap: 42, h: 4.2, r: 7, i: 0.4, c: LED }, cycleway: { gap: 42, h: 4.2, r: 7, i: 0.4, c: LED },
};
const near = new Map(); // keep lamps from bunching where ways meet
const cell = (x, y) => `${Math.round(x / 13)},${Math.round(y / 13)}`;
function addLamp(l) {
  if (!inB(l.x, l.y) || indoors(l.x, l.y)) return;
  const key = cell(l.x, l.y);
  if (near.has(key)) return;
  near.set(key, 1);
  lamps.push(l);
}
for (const r of scene.roads) {
  const spec = ROAD_LAMPS[r.kind];
  if (!spec || r.bridge) continue;
  let carry = hash(r.pts.length, Math.round(r.pts[0][0])) * spec.gap, side = 1;
  for (let i = 1; i < r.pts.length; i++) {
    const [ax, ay] = r.pts[i - 1], [bx, by] = r.pts[i], len = Math.hypot(bx - ax, by - ay);
    if (!len) continue;
    const hx = (bx - ax) / len, hy = (by - ay) / len;
    for (let s = carry; s < len; s += spec.gap) {
      const off = spec.h > 5 ? (r.width || 6) / 2 + 1 : 0.9;
      const sd = spec.both ? (side = -side) : 1;
      addLamp({ x: ax + hx * s + hy * off * sd, y: ay + hy * s - hx * off * sd, ...spec });
    }
    carry = (carry - len) % spec.gap; if (carry < 0) carry += spec.gap;
  }
}
// parking lots: a loose grid of tall lights
for (const a of scene.areas) {
  if (a.kind !== 'parking' || (a.area || 0) < 400) continue;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of a.outer) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const g = 40;
  for (let x = x0 + ((x1 - x0) % g) / 2; x <= x1; x += g) for (let y = y0 + ((y1 - y0) % g) / 2; y <= y1; y += g) {
    if (pip(x, y, a.outer)) addLamp({ x, y, h: 9, r: 20, i: 0.8, c: LOT });
  }
}
console.log(`lamps: ${lamps.length} street/path/lot lights, ${porchLights.length} spill lights`);

// ground illumination at half resolution (light pools are smooth)
const HW = Math.ceil(W / 2), HH = Math.ceil(H / 2);
const I = new Float32Array(HW * HH * 3);
function pool(l) {
  // the ground disc projects to an ellipse; walk its bounding box
  const [cx, cy] = proj(l.x, l.y, 0), R = l.r * pxPerM * 1.05;
  const i0 = Math.max(0, Math.floor((cx - R) / 2)), i1 = Math.min(HW - 1, Math.ceil((cx + R) / 2));
  const j0 = Math.max(0, Math.floor((cy - R * 0.6) / 2)), j1 = Math.min(HH - 1, Math.ceil((cy + R * 0.6) / 2));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const [gx, gy] = ground(i * 2 + 1, j * 2 + 1);
    const d = Math.hypot(gx - l.x, gy - l.y) / l.r;
    if (d >= 1) continue;
    const f = (1 - d * d) ** 2 * 0.6 + Math.exp(-d * d * 10) * 0.45;
    const k = (j * HW + i) * 3;
    I[k] += l.c[0] * l.i * f; I[k + 1] += l.c[1] * l.i * f; I[k + 2] += l.c[2] * l.i * f;
  }
}
for (const l of lamps) pool(l);
for (const l of porchLights) pool(l);
// lamp posts: thin dark lines from the ground to the head, where nothing nearer hides them
const pole = new Uint8Array(N);
for (const l of lamps) {
  const [ax, ay] = proj(l.x, l.y, 0), [bx, by] = proj(l.x, l.y, l.h), n = Math.ceil(Math.hypot(bx - ax, by - ay));
  for (let t = 0; t <= n; t++) {
    const u = t / Math.max(1, n), i = Math.floor(ax + (bx - ax) * u), j = Math.floor(ay + (by - ay) * u);
    if (i < 0 || j < 0 || i >= W || j >= H) continue;
    if (depth[j * W + i] <= depthOf(l.x, l.y, l.h * u) + 0.3) pole[j * W + i] = 1;
  }
}
// lamp heads: tiny bright points, only where nothing nearer hides them
for (const l of lamps) {
  const [sx, sy] = proj(l.x, l.y, l.h);
  const i = Math.round(sx - 0.5), j = Math.round(sy - 0.5);
  if (i < 1 || j < 1 || i >= W - 1 || j >= H - 1) continue;
  if (depth[j * W + i] > depthOf(l.x, l.y, l.h) + 0.5) continue;
  const rr = l.h > 5 ? 1.6 : 1.1;
  for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
    const k = (j + dj) * W + (i + di);
    if (k < 0 || k >= N) continue;
    const f = Math.exp(-(di * di + dj * dj) / (rr * rr)) * (l.h > 5 ? 1.3 : 0.6);
    E[k * 3] += f * (0.5 + 0.5 * l.c[0]); E[k * 3 + 1] += f * (0.5 + 0.5 * l.c[1]); E[k * 3 + 2] += f * (0.5 + 0.5 * l.c[2]);
  }
}

// ---------- bloom: blur the emission at 1/4 and 1/12 resolution ----------
function downsample(src, w, h, f) {
  const dw = Math.ceil(w / f), dh = Math.ceil(h / f), out = new Float32Array(dw * dh * 3);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const s = (j * w + i) * 3, d = (Math.floor(j / f) * dw + Math.floor(i / f)) * 3;
    out[d] += src[s]; out[d + 1] += src[s + 1]; out[d + 2] += src[s + 2];
  }
  for (let k = 0; k < out.length; k++) out[k] /= f * f;
  return { d: out, w: dw, h: dh };
}
function boxBlur(img, r, passes = 3) {
  const { w, h } = img;
  let a = img.d, b = new Float32Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let j = 0; j < h; j++) for (let c = 0; c < 3; c++) { // horizontal
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += a[(j * w + Math.min(w - 1, Math.max(0, i))) * 3 + c];
      for (let i = 0; i < w; i++) {
        b[(j * w + i) * 3 + c] = acc / (2 * r + 1);
        acc += a[(j * w + Math.min(w - 1, i + r + 1)) * 3 + c] - a[(j * w + Math.max(0, i - r)) * 3 + c];
      }
    }
    for (let i = 0; i < w; i++) for (let c = 0; c < 3; c++) { // vertical
      let acc = 0;
      for (let j = -r; j <= r; j++) acc += b[(Math.min(h - 1, Math.max(0, j)) * w + i) * 3 + c];
      for (let j = 0; j < h; j++) {
        a[(j * w + i) * 3 + c] = acc / (2 * r + 1);
        acc += b[(Math.min(h - 1, j + r + 1) * w + i) * 3 + c] - b[(Math.max(0, j - r) * w + i) * 3 + c];
      }
    }
  }
  return { d: a, w, h };
}
const bloomS = boxBlur(downsample(E, W, H, 4), 2);
const bloomL = boxBlur(downsample(E, W, H, 12), 3);
const sample = (img, f, x, y, c) => { // bilinear
  const fx = Math.min(img.w - 1, Math.max(0, (x + 0.5) / f - 0.5)), fy = Math.min(img.h - 1, Math.max(0, (y + 0.5) / f - 0.5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(img.w - 1, x0 + 1), y1 = Math.min(img.h - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
  const d = img.d;
  return (d[(y0 * img.w + x0) * 3 + c] * (1 - tx) + d[(y0 * img.w + x1) * 3 + c] * tx) * (1 - ty) + (d[(y1 * img.w + x0) * 3 + c] * (1 - tx) + d[(y1 * img.w + x1) * 3 + c] * tx) * ty;
};

// ---------- compose ----------
// moonlight grade: desaturate a little, multiply by a cool violet, lift the blacks toward deep indigo
const MOON = [0.07, 0.062, 0.135], LIFT = [0.006, 0.004, 0.016], SAT = 0.6;
const lin = new Float32Array(256).map((_, v) => (v / 255) ** 2.2);
const out = Buffer.alloc(N * 4);
const hex = (h) => h.match(/\w\w/g).map((x) => parseInt(x, 16));
const BG = hex(meta.background), NIGHT_BG = hex('#1c1930');
const shoulder = (v) => (v < 0.75 ? v : 0.75 + 0.25 * (1 - Math.exp(-(v - 0.75) / 0.25)));
for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
  const k = j * W + i, s = ((j + OY) * day.width + (i + OX)) * 4;
  // the empty page around the map becomes the night sky colour
  if (Math.abs(day.data[s] - BG[0]) + Math.abs(day.data[s + 1] - BG[1]) + Math.abs(day.data[s + 2] - BG[2]) < 6) {
    out[k * 4] = NIGHT_BG[0]; out[k * 4 + 1] = NIGHT_BG[1]; out[k * 4 + 2] = NIGHT_BG[2]; out[k * 4 + 3] = 255;
    continue;
  }
  const r = lin[day.data[s]], g = lin[day.data[s + 1]], b = lin[day.data[s + 2]];
  const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const isGround = owner[k] === 0;
  const hk = (Math.min(HH - 1, j >> 1) * HW + Math.min(HW - 1, i >> 1)) * 3;
  for (let c = 0; c < 3; c++) {
    const base = [r, g, b][c];
    const desat = (y + (base - y) * SAT) ** 1.12; // a touch more contrast in the dark
    let v = desat * MOON[c] + LIFT[c] * (1 - desat);
    if (isGround) v += base * I[hk + c] * 1.5; // the lamp's light on the painted ground
    v += E[k * 3 + c];
    if (pole[k]) v *= 0.4;
    v += sample(bloomS, 4, i, j, c) * 0.4 + sample(bloomL, 12, i, j, c) * 0.35;
    out[k * 4 + c] = Math.round(255 * shoulder(Math.max(0, v)) ** (1 / 2.2));
  }
  out[k * 4 + 3] = 255;
}
const file = `night${season ? '-' + season : ''}${crop ? '-crop' : ''}.png`;
fs.writeFileSync(path.join(ROOT, 'out', file), encodePNG({ width: W, height: H, data: out }, crop ? 6 : 9));
const nightBg = '#' + NIGHT_BG.map((v) => v.toString(16).padStart(2, '0')).join('');
if (!crop && !season) {
  fs.writeFileSync(path.join(ROOT, 'out/night.json'), JSON.stringify({ background: nightBg, lamps: lamps.length, generated: new Date().toISOString() }));
}
console.log(`out/${file} ${W}x${H}, background ${nightBg} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
