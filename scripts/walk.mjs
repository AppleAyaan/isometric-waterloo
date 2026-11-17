// Builds out/walk.json for the viewer's "walking directions" (viewer/route.js):
//   - a pedestrian graph from OSM (footways, paths, steps, indoor corridors, bridges/tunnels, and the
//     roads you would walk along on the sidewalk), in the same scene metres as data/scene.json,
//   - per building, where you can get on that graph: nodes the footprint shares with a path (doors,
//     passages), indoor corridors inside it, and the nearest outdoor path nodes around it.
// Edges carry flags so the viewer can prefer indoor/covered connections ("stay indoors" for winter).
//
//   npm run walk          (needs data/osm_raw.json, data/scene.json and out/meta.json)
//
// Output is compact: coordinates are integers in decimetres, edges are flat [a, b, flags] triples.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARGIN = 40; // keep paths a little past the map edge so routes to edge buildings are not cut short

// walkable highway classes; roads count as their sidewalks (slight penalty in the viewer, flag ROAD)
const WALK = new Set(['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'living_street', 'corridor', 'track', 'bridleway', 'platform',
  'service', 'residential', 'unclassified', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link']);
const ROADS = new Set(['service', 'residential', 'unclassified', 'tertiary', 'tertiary_link', 'secondary', 'secondary_link', 'living_street']);
// edge flags (shared with viewer/route.js)
const F = { INDOOR: 1, COVERED: 2, STEPS: 4, ROAD: 8, LINK: 16 };

export function buildWalk(scene, meta) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/osm_raw.json'), 'utf8'));
  // same projection as build_scene.mjs / traffic.mjs, so the graph lines up with the painted map
  const { lat: lat0, lon: lon0 } = scene.origin;
  const KX = Math.cos((lat0 * Math.PI) / 180) * 111320, KY = 110540;
  const proj = (lat, lon) => [(lon - lon0) * KX, (lat - lat0) * KY];
  const B = scene.bounds;
  const inside = ([x, y], m = 0) => x >= B.minX - m && x <= B.maxX + m && y >= B.minY - m && y <= B.maxY + m;

  // ---------- raw graph: one node per OSM node, one edge per way segment ----------
  const pts = [], ix = new Map(), osmOf = [];
  const nodeOf = (id, p) => { if (!ix.has(id)) { ix.set(id, pts.length); pts.push(p); osmOf.push(id); } return ix.get(id); };
  const edges = new Map(); // "a,b" (a<b) -> flags; parallel ways collapse, keeping the friendlier flags
  const flagsOf = (t) => {
    let f = 0;
    if (t.indoor === 'yes' || t.highway === 'corridor' || t.tunnel === 'yes' || t.tunnel === 'building_passage' || t.tunnel === 'covered') f |= F.INDOOR;
    else if (t.covered === 'yes' || t.covered === 'arcade' || t.covered === 'colonnade') f |= F.COVERED;
    if (t.highway === 'steps') f |= F.STEPS;
    if (ROADS.has(t.highway) && !/\bpath\b/i.test(t.name || '')) f |= F.ROAD; // UW names its service lanes "Ring Road path" etc.
    return f;
  };
  let ways = 0;
  for (const el of raw.elements) {
    const t = el.tags || {};
    if (el.type !== 'way' || !el.geometry || !WALK.has(t.highway)) continue;
    if (t.area === 'yes' && t.highway !== 'pedestrian') continue; // platforms/squares drawn as areas: their rim is not a path
    if (t.foot === 'no' || t.access === 'no' && !['yes', 'designated', 'permissive'].includes(t.foot)) continue;
    if (t.access === 'private' && !['yes', 'designated', 'permissive'].includes(t.foot)) continue;
    if (t.highway === 'platform' && !t.foot) continue; // bus/ION platforms are not through routes
    const f = flagsOf(t);
    const g = el.geometry.map((q) => proj(q.lat, q.lon));
    let used = false;
    for (let i = 1; i < g.length; i++) {
      if (!inside(g[i - 1], MARGIN) && !inside(g[i], MARGIN)) continue;
      const a = nodeOf(el.nodes[i - 1], g[i - 1]), b = nodeOf(el.nodes[i], g[i]);
      if (a === b) continue;
      const k = a < b ? a + ',' + b : b + ',' + a;
      edges.set(k, edges.has(k) ? edges.get(k) & f : f);
      used = true;
    }
    if (used) ways++;
  }
  const adj = pts.map(() => new Set());
  const edgeList = [...edges].map(([k, f]) => { const [a, b] = k.split(',').map(Number); adj[a].add(b); adj[b].add(a); return [a, b, f]; });

  // ---------- stitch: dead ends that stop just short of another network (common at building doors) ----------
  const comp = new Int32Array(pts.length).fill(-1);
  let nComp = 0;
  for (let s = 0; s < pts.length; s++) {
    if (comp[s] >= 0) continue;
    const st = [s]; comp[s] = nComp;
    while (st.length) { const u = st.pop(); for (const v of adj[u]) if (comp[v] < 0) { comp[v] = nComp; st.push(v); } }
    nComp++;
  }
  const GRID = 10, grid = new Map();
  const cell = (x, y) => Math.floor(x / GRID) + ':' + Math.floor(y / GRID);
  pts.forEach((p, i) => { const k = cell(p[0], p[1]); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i); });
  const near = (p, r) => {
    const out = [], cx = Math.floor(p[0] / GRID), cy = Math.floor(p[1] / GRID), n = Math.ceil(r / GRID);
    for (let dx = -n; dx <= n; dx++) for (let dy = -n; dy <= n; dy++) for (const i of grid.get(cx + dx + ':' + (cy + dy)) || []) {
      const d = Math.hypot(pts[i][0] - p[0], pts[i][1] - p[1]);
      if (d <= r) out.push([i, d]);
    }
    return out.sort((a, b) => a[1] - b[1]);
  };
  let links = 0;
  for (let i = 0; i < pts.length; i++) {
    if (adj[i].size !== 1) continue;
    const hit = near(pts[i], 8).find(([j]) => comp[j] !== comp[i]);
    if (!hit) continue;
    const j = hit[0];
    edgeList.push([i, j, F.LINK]); adj[i].add(j); adj[j].add(i); links++;
    const from = comp[j], to = comp[i];
    for (let k = 0; k < pts.length; k++) if (comp[k] === from) comp[k] = to; // merge (few links, fine)
  }

  // ---------- building entrances ----------
  const pip = ([x, y], r) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
    }
    return c;
  };
  const segDist = ([px, py], [ax, ay], [bx, by]) => {
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / L)) : 0;
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  };
  const ringDist = (p, r) => { let d = Infinity; for (let i = 0, j = r.length - 1; i < r.length; j = i++) d = Math.min(d, segDist(p, r[j], r[i])); return d; };
  const rawById = new Map(raw.elements.filter((e) => e.type === 'way' && e.tags?.building).map((e) => ['way/' + e.id, e]));
  const sceneById = new Map(scene.buildings.map((b) => [b.id, b]));
  // the main network: entrances on tiny islands (an isolated indoor corridor) would make routes fail
  const compSize = new Map();
  for (let i = 0; i < pts.length; i++) if (adj[i].size) compSize.set(comp[i], (compSize.get(comp[i]) || 0) + 1);
  const mainComp = [...compSize].sort((a, b) => b[1] - a[1])[0][0];
  const keep = new Set();
  const entrances = {};
  let shared = 0, indoorE = 0, missing = 0;
  for (const mb of meta.buildings) {
    const sb = sceneById.get(mb.id);
    if (!sb?.outer?.length) { missing++; continue; }
    const ring = sb.outer, list = new Map(); // node -> metres from the building edge
    // 1) nodes the footprint shares with a path: mapped doors and passages
    const w = rawById.get(sb.osm);
    for (const id of w?.nodes || []) { const i = ix.get(id); if (i != null && adj[i].size && comp[i] === mainComp) { list.set(i, 0); shared++; } }
    // 2) indoor corridors inside the footprint (you are already in the building)
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of ring) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, R = Math.hypot(x1 - x0, y1 - y0) / 2;
    const around = near([cx, cy], R + 35).filter(([i]) => adj[i].size && comp[i] === mainComp);
    const insideIx = around.filter(([i]) => pip(pts[i], ring) && [...adj[i]].some((j) => edges.get(i < j ? i + ',' + j : j + ',' + i) & F.INDOOR));
    // spread: one per ~15 m cell so a long corridor doesn't bloat the file
    const seenCell = new Set();
    for (const [i] of insideIx) { const k = Math.round(pts[i][0] / 15) + ':' + Math.round(pts[i][1] / 15); if (seenCell.has(k)) continue; seenCell.add(k); if (!list.has(i)) { list.set(i, 0); indoorE++; } }
    // 3) the nearest outdoor path node in each of 8 directions around the building (implicit doors)
    const best = new Map();
    for (const [i] of around) {
      if (list.has(i) || pip(pts[i], ring)) continue;
      const d = ringDist(pts[i], ring);
      if (d > 30) continue;
      const s = Math.round(((Math.atan2(pts[i][1] - cy, pts[i][0] - cx) / (2 * Math.PI)) * 8 + 8)) % 8;
      if (!best.has(s) || best.get(s)[1] > d) best.set(s, [i, d]);
    }
    for (const [i, d] of best.values()) list.set(i, d);
    if (!list.size) { // nothing close: the nearest node on the main network
      const n = near([cx, cy], 250).find(([i]) => adj[i].size && comp[i] === mainComp);
      if (n) list.set(n[0], ringDist(pts[n[0]], ring));
    }
    for (const i of list.keys()) keep.add(i);
    entrances[mb.id] = [...list];
  }

  // ---------- simplify: drop near-collinear degree-2 nodes along chains of same-flag edges ----------
  const eFlag = new Map(edgeList.map(([a, b, f]) => [a < b ? a + ',' + b : b + ',' + a, f]));
  const fl = (a, b) => eFlag.get(a < b ? a + ',' + b : b + ',' + a);
  const isJunction = (i) => adj[i].size !== 2 || keep.has(i) || (() => { const [a, b] = adj[i]; return fl(i, a) !== fl(i, b); })();
  const outEdges = [], done = new Set(), used = new Set();
  const dp = (chain, tol) => { // Douglas-Peucker over node indices
    if (chain.length <= 2) return chain;
    let md = 0, mi = 0;
    for (let k = 1; k < chain.length - 1; k++) { const d = segDist(pts[chain[k]], pts[chain[0]], pts[chain.at(-1)]); if (d > md) { md = d; mi = k; } }
    return md <= tol ? [chain[0], chain.at(-1)] : [...dp(chain.slice(0, mi + 1), tol).slice(0, -1), ...dp(chain.slice(mi), tol)];
  };
  const walkChain = (start, next) => {
    const chain = [start, next];
    let prev = start, cur = next;
    while (!isJunction(cur) && cur !== start) { const n = [...adj[cur]].find((v) => v !== prev); prev = cur; cur = n; chain.push(cur); }
    return chain;
  };
  for (let s = 0; s < pts.length; s++) {
    if (!adj[s].size || !isJunction(s)) continue;
    for (const n of adj[s]) {
      const k = s < n ? s + ',' + n : n + ',' + s;
      if (done.has(k)) continue;
      const chain = walkChain(s, n);
      for (let q = 1; q < chain.length; q++) { const a = chain[q - 1], b = chain[q]; done.add(a < b ? a + ',' + b : b + ',' + a); }
      const f = fl(s, n), simp = dp(chain, 0.6);
      for (let q = 1; q < simp.length; q++) { outEdges.push([simp[q - 1], simp[q], f]); used.add(simp[q - 1]); used.add(simp[q]); }
    }
  }
  // (pure loops without any junction are rare footpath rings; they can't be reached from a building anyway)

  // ---------- renumber + quantize ----------
  const newIx = new Map(), nodesOut = [];
  for (const i of [...used].sort((a, b) => a - b)) { newIx.set(i, newIx.size); nodesOut.push(Math.round(pts[i][0] * 10), Math.round(pts[i][1] * 10)); }
  const edgesOut = [];
  for (const [a, b, f] of outEdges) if (a !== b) edgesOut.push(newIx.get(a), newIx.get(b), f);
  const b = {};
  for (const [id, list] of Object.entries(entrances)) {
    const flat = [];
    for (const [i, d] of list) if (newIx.has(i)) flat.push(newIx.get(i), Math.round(d * 10));
    if (flat.length) b[id] = flat;
  }
  return {
    v: 1, q: 10, flags: F, speed: 1.3,
    nodes: nodesOut, edges: edgesOut, b,
    stats: { ways, rawNodes: pts.length, links, shared, indoorE, missing, components: nComp },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const scene = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/scene.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/meta.json'), 'utf8'));
  const w = buildWalk(scene, meta);
  const { stats } = w; delete w.stats;
  const json = JSON.stringify(w);
  fs.writeFileSync(path.join(ROOT, 'out/walk.json'), json);
  const indoorEdges = w.edges.filter((_, k) => k % 3 === 2 && w.edges[k] & F.INDOOR).length;
  console.log(`walk: ${stats.ways} ways -> ${w.nodes.length / 2} nodes / ${w.edges.length / 3} edges (${indoorEdges} indoor), ` +
    `${stats.links} stitched dead ends, entrances for ${Object.keys(w.b).length}/${meta.buildings.length} buildings ` +
    `(${stats.shared} shared nodes, ${stats.indoorE} indoor), ${(json.length / 1024).toFixed(0)} KB`);
}
