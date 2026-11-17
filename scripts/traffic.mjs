// Builds out/traffic.json for the viewer's simulated traffic layer:
//   - a drivable road graph (local metres) that cars random-walk on,
//   - bus routes (GRT + GO), routed through the real OSM stops whose route_ref lists them,
//   - the ION line and its University of Waterloo station,
//   - the affine projection from scene metres (x east, y north, h up) to mosaic pixels.
// Nothing here is live data: the viewer animates plausible vehicles along these paths.
// Route names/colours live in data/transit.json so they can be edited without touching code.
//
// Runs at the end of `npm run export`; `npm run traffic` refreshes it alone.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeProjector } from './outlines.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARGIN = 160;
// The painted imagery and OSM disagree by several metres in places; these shift a pitch so the
// players and goalposts sit on the field as it is painted (measured by overlaying the OSM outline).
const FIELD_NUDGE = { 'Warrior Field': [8.7, 8.7] }; // keep roads this far past the bbox so vehicles drive in/out of frame instead of popping

const CAR_ROADS = { secondary: 1, tertiary: 1, tertiary_link: 1, unclassified: 2, residential: 3, service: 4 };
const WIDTH = { secondary: 12, tertiary: 10, tertiary_link: 8, unclassified: 8, residential: 8, service: 5 };
// routing cost per metre for buses (prefer arterials, avoid parking aisles)
const BUS_COST = { 1: 1, 2: 1.3, 3: 2.5, 4: 5 };

export function buildTraffic(scene, meta) {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/osm_raw.json'), 'utf8'));
  const transit = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/transit.json'), 'utf8'));
  const { lat: lat0, lon: lon0 } = scene.origin;
  const KX = Math.cos((lat0 * Math.PI) / 180) * 111320, KY = 110540;
  const proj = (lat, lon) => [+((lon - lon0) * KX).toFixed(1), +((lat - lat0) * KY).toFixed(1)];
  const B = scene.bounds;
  const inside = ([x, y], m = 0) => x >= B.minX - m && x <= B.maxX + m && y >= B.minY - m && y <= B.maxY + m;

  // ---------- road graph ----------
  const nodes = [], nodeIx = new Map(), edges = [];
  const nodeOf = (id, p) => {
    if (!nodeIx.has(id)) { nodeIx.set(id, nodes.length); nodes.push(p); }
    return nodeIx.get(id);
  };
  for (const el of raw.elements) {
    const t = el.tags || {};
    if (el.type !== 'way' || !el.geometry || !CAR_ROADS[t.highway]) continue;
    if (t.tunnel || t.indoor === 'yes' || t.area === 'yes' || Number(t.layer) < 0) continue;
    if (['driveway', 'drive-through', 'emergency_access'].includes(t.service)) continue;
    const isBusOnly = /transit/i.test(t.name || '');
    if (t.highway === 'service' && /\bpath\b/i.test(t.name || '') && !isBusOnly) continue;
    let cls = CAR_ROADS[t.highway];
    const aisle = t.service === 'parking_aisle';
    const noCars = ['no', 'private'].includes(t.access) || isBusOnly;
    const oneway = t.oneway === 'yes' || t.oneway === '1' || t.junction === 'roundabout' ? 1 : t.oneway === '-1' ? -1 : 0;
    const pts = el.geometry.map((g) => proj(g.lat, g.lon));
    for (let i = 1; i < pts.length; i++) {
      if (!inside(pts[i - 1], MARGIN) && !inside(pts[i], MARGIN)) continue;
      let a = nodeOf(el.nodes[i - 1], pts[i - 1]), b = nodeOf(el.nodes[i], pts[i]);
      if (oneway === -1) [a, b] = [b, a];
      // flags: 1 = one-way, 2 = parking aisle, 4 = no general traffic
      edges.push([a, b, cls, (oneway ? 1 : 0) | (aisle ? 2 : 0) | (noCars ? 4 : 0), WIDTH[t.highway]]);
    }
  }

  // adjacency for routing
  const out = nodes.map(() => []);
  const len = (a, b) => Math.hypot(nodes[a][0] - nodes[b][0], nodes[a][1] - nodes[b][1]);
  for (const [a, b, cls, fl] of edges) {
    const c = len(a, b) * (fl & 2 ? 40 : BUS_COST[cls]);
    out[a].push([b, c]);
    if (!(fl & 1)) out[b].push([a, c]);
  }
  function dijkstra(src) {
    const dist = new Float64Array(nodes.length).fill(Infinity), prev = new Int32Array(nodes.length).fill(-1);
    dist[src] = 0;
    const heap = [[0, src]];
    const push = (it) => { heap.push(it); let i = heap.length - 1; while (i) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; } } return top; };
    while (heap.length) {
      const [d, u] = pop();
      if (d > dist[u]) continue;
      for (const [v, c] of out[u]) if (d + c < dist[v]) { dist[v] = d + c; prev[v] = u; push([dist[v], v]); }
    }
    return { dist, prev };
  }
  const edgeAt = new Map();
  for (const e of edges) { edgeAt.set(e[0] * nodes.length + e[1], e); if (!(e[3] & 1)) edgeAt.set(e[1] * nodes.length + e[0], e); }
  const pathTo = (prev, src, dst) => { const p = []; for (let v = dst; v !== -1; v = prev[v]) { p.push(v); if (v === src) break; } return p.reverse(); };

  // ---------- bus stops ----------
  const majorNode = new Set();
  const busNode = new Set();
  for (const [a, b, cls, fl] of edges) {
    if (cls <= 2 && !(fl & 2)) { majorNode.add(a); majorNode.add(b); }
    if (!(fl & 2)) { busNode.add(a); busNode.add(b); }
  }
  const nearestNode = (p, pool) => {
    let best = -1, bd = Infinity;
    for (const i of pool) { const d = Math.hypot(nodes[i][0] - p[0], nodes[i][1] - p[1]); if (d < bd) { bd = d; best = i; } }
    return bd < 60 ? best : -1;
  };
  const centroid = (g) => proj(g.reduce((s, q) => s + q.lat, 0) / g.length, g.reduce((s, q) => s + q.lon, 0) / g.length);
  const stops = [];
  for (const el of raw.elements) {
    const t = el.tags || {};
    if (t.highway !== 'platform' || !el.geometry) continue;
    const p = centroid(el.geometry);
    stops.push({ name: t.name || (t.local_ref || t.ref ? `Transit Plaza · Bay ${t.local_ref || t.ref}` : null), p, refs: (t.route_ref || '').split(';').map((s) => s.trim()).filter(Boolean), network: t.network || '' });
  }
  // entry/exit points: major-road nodes just outside the bbox
  const deg = nodes.map(() => 0);
  for (const [a, b] of edges) { deg[a]++; deg[b]++; }
  const gates = [...majorNode].filter((i) => deg[i] === 1 && !inside(nodes[i]));

  const routes = [];
  for (const r of transit.routes) {
    let rs = stops.filter((s) => (r.match.ref && s.refs.includes(r.match.ref)) || (r.match.network && s.network === r.match.network));
    // one stop per name (opposite-side twins share it), keep the stop's road node
    const seen = new Set();
    rs = rs.filter((s) => { const k = s.name || s.p.join(); if (seen.has(k)) return false; seen.add(k); return true; })
      .map((s) => {
        // stop on an arterial if one is close, otherwise any non-parking road (e.g. Transit Plaza Road)
        const m = nearestNode(s.p, majorNode);
        return { ...s, node: m >= 0 && Math.hypot(nodes[m][0] - s.p[0], nodes[m][1] - s.p[1]) < 30 ? m : nearestNode(s.p, busNode) };
      })
      .filter((s) => s.node >= 0);
    if (!rs.length) { console.warn(`traffic: route ${r.id} has no stops in the map, skipped`); continue; }
    // pairwise costs between gates and stops, then brute-force the cheapest gate -> stops -> gate order
    const keys = [...gates, ...rs.map((s) => s.node)];
    const sp = new Map(keys.map((k) => [k, dijkstra(k)]));
    const cost = (a, b) => sp.get(a).dist[b];
    let best = null;
    const perms = (arr) => arr.length <= 1 ? [arr] : arr.flatMap((x, i) => perms([...arr.slice(0, i), ...arr.slice(i + 1)]).map((p) => [x, ...p]));
    const orders = rs.length <= 6 ? perms(rs.map((_, i) => i)) : [rs.map((_, i) => i)];
    for (const g0 of gates) for (const g1 of gates) {
      if (g0 === g1) continue;
      for (const o of orders) {
        let c = cost(g0, rs[o[0]].node) + cost(rs[o.at(-1)].node, g1);
        for (let k = 1; k < o.length && c < (best?.c ?? Infinity); k++) c += cost(rs[o[k - 1]].node, rs[o[k]].node);
        if (c < (best?.c ?? Infinity)) best = { c, g0, g1, o };
      }
    }
    if (!best || !Number.isFinite(best.c)) { console.warn(`traffic: route ${r.id} could not be routed, skipped`); continue; }
    const stopSeq = best.o.map((i) => rs[i]);
    const build = (g0, list, g1) => {
      const seq = [g0, ...list.map((st) => st.node), g1];
      for (let k = 1; k < seq.length; k++) if (!Number.isFinite(cost(seq[k - 1], seq[k]))) return null;
      let nodePath = [seq[0]];
      for (let k = 1; k < seq.length; k++) nodePath = nodePath.concat(pathTo(sp.get(seq[k - 1]).prev, seq[k - 1], seq[k]).slice(1));
      const pts = nodePath.map((i) => nodes[i]);
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      // lane offset (to the right of travel) for each segment: half a lane on two-way roads, ~centred on one-way carriageways
      const off = nodePath.slice(1).map((b, i) => { const e = edgeAt.get(nodePath[i] * nodes.length + b); return e ? +(e[3] & 1 ? e[4] * 0.12 : e[4] / 4).toFixed(2) : 2; });
      let from = 0;
      const st = list.map((x) => { const i = nodePath.indexOf(x.node, from); from = Math.max(from, i); return { name: x.name, s: +cum[i].toFixed(1) }; });
      return { pts, off, stops: st };
    };
    // the return trip: same stops backwards, with its own entry/exit (divided roads are one-way)
    const reverse = (list) => {
      let rb = null;
      for (const g0 of gates) for (const g1 of gates) {
        if (g0 === g1) continue;
        let c = cost(g0, list[0].node) + cost(list.at(-1).node, g1);
        for (let k = 1; k < list.length; k++) c += cost(list[k - 1].node, list[k].node);
        // start where the outbound trip ended and end where it started
        c += 3 * (len(g0, best.g1) + len(g1, best.g0));
        if (c < (rb?.c ?? Infinity)) rb = { c, g0, g1 };
      }
      return rb && Number.isFinite(rb.c) ? build(rb.g0, list, rb.g1) : null;
    };
    routes.push({ ...r, match: undefined, paths: [build(best.g0, stopSeq, best.g1), reverse(stopSeq.slice().reverse())].filter(Boolean) });
  }

  // ---------- ION: two tracks (northbound on the main ION line, southbound on the shared spur track) ----------
  function chainWays(ways) {
    ways = ways.slice().sort((a, b) => b.nodes.length - a.nodes.length);
    if (!ways.length) return { pts: [], ids: new Set() };
    let chain = ways[0].geometry.map((g) => [g.lat, g.lon]), cn = ways[0].nodes.slice();
    const used = new Set([ways[0].id]);
    for (let grew = true; grew;) {
      grew = false;
      for (const w of ways) {
        if (used.has(w.id)) continue;
        const g = w.geometry.map((q) => [q.lat, q.lon]), n = w.nodes;
        if (n[0] === cn.at(-1)) { chain = chain.concat(g.slice(1)); cn = cn.concat(n.slice(1)); }
        else if (n.at(-1) === cn[0]) { chain = g.slice(0, -1).concat(chain); cn = n.slice(0, -1).concat(cn); }
        else if (n.at(-1) === cn.at(-1)) { chain = chain.concat(g.reverse().slice(1)); cn = cn.concat(n.slice().reverse().slice(1)); }
        else if (n[0] === cn[0]) { chain = g.reverse().slice(0, -1).concat(chain); cn = n.slice().reverse().slice(0, -1).concat(cn); }
        else continue;
        used.add(w.id); grew = true;
      }
    }
    let pts = chain.map(([la, lo]) => proj(la, lo));
    const keep = pts.map((p) => inside(p, MARGIN));
    const first = keep.indexOf(true), last = keep.lastIndexOf(true);
    pts = first < 0 ? [] : pts.slice(Math.max(0, first - 1), last + 2);
    if (pts.length && pts[0][1] > pts.at(-1)[1]) pts.reverse(); // index 0 = south end
    return { pts, ids: used };
  }
  // nearest point on a polyline: distance, arc length s and tangent
  function onLine(pts, c) {
    let best = { d: Infinity, s: 0, tx: 1, ty: 0 }, acc = 0;
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i], L = Math.hypot(bx - ax, by - ay) || 1;
      const u = Math.max(0, Math.min(1, ((c[0] - ax) * (bx - ax) + (c[1] - ay) * (by - ay)) / (L * L)));
      const d = Math.hypot(ax + u * (bx - ax) - c[0], ay + u * (by - ay) - c[1]);
      if (d < best.d) best = { d, s: acc + u * L, tx: (bx - ax) / L, ty: (by - ay) / L };
      acc += L;
    }
    return best;
  }
  const railWays = raw.elements.filter((e) => e.type === 'way' && e.geometry && e.nodes);
  const trackA = chainWays(railWays.filter((e) => e.tags?.railway === 'light_rail'));
  const trackB = chainWays(railWays.filter((e) => !trackA.ids.has(e.id) && (e.tags?.railway === 'light_rail' || (e.tags?.railway === 'rail' && /\bion\b/i.test(e.tags.name || '')))));
  const tracks = [trackA.pts, trackB.pts].filter((p) => p.length > 1);
  const ionPts = tracks[0] || [];
  const plats = raw.elements.filter((e) => e.tags?.railway === 'platform' && e.geometry).map((e) => centroid(e.geometry));
  const platC = plats.length ? [plats.reduce((s, p) => s + p[0], 0) / plats.length, plats.reduce((s, p) => s + p[1], 0) / plats.length] : null;

  // ---------- level crossings: where drivable roads cross the ION / shared rail tracks ----------
  const trackLines = raw.elements.filter((e) => e.type === 'way' && e.geometry && (e.tags?.railway === 'light_rail' || (e.tags?.railway === 'rail' && /ion/i.test(e.tags.name || ''))))
    .map((e) => e.geometry.map((g) => proj(g.lat, g.lon)));
  const segX = (p, q, a, b) => {
    const r = [q[0] - p[0], q[1] - p[1]], d = [b[0] - a[0], b[1] - a[1]], den = r[0] * d[1] - r[1] * d[0];
    if (Math.abs(den) < 1e-9) return null;
    const t = ((a[0] - p[0]) * d[1] - (a[1] - p[1]) * d[0]) / den, u = ((a[0] - p[0]) * r[1] - (a[1] - p[1]) * r[0]) / den;
    return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? [p[0] + r[0] * t, p[1] + r[1] * t] : null;
  };
  const crossings = [];
  for (const [a, b, cls, fl, w] of edges) {
    if (fl & 2) continue;
    const p = nodes[a], q = nodes[b];
    if (!inside(p) && !inside(q)) continue;
    const hits = [];
    for (const line of trackLines) for (let i = 1; i < line.length; i++) { const x = segX(p, q, line[i - 1], line[i]); if (x) hits.push(x); }
    if (!hits.length) continue;
    const L = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1, rx = (q[0] - p[0]) / L, ry = (q[1] - p[1]) / L;
    const along = hits.map((h) => (h[0] - p[0]) * rx + (h[1] - p[1]) * ry);
    const lo = Math.min(...along), hi = Math.max(...along), mid = (lo + hi) / 2;
    const c = [p[0] + rx * mid, p[1] + ry * mid];
    const on = tracks.map((t) => onLine(t, c));
    if (!on.length || on[0].d > 15) continue;
    crossings.push({ x: +c[0].toFixed(2), y: +c[1].toFixed(2), rx: +rx.toFixed(4), ry: +ry.toFixed(4), w, oneway: !!(fl & 1), span: +(hi - lo + 4.5).toFixed(2), s: on.map((o) => +o.s.toFixed(1)) });
  }

  // a road crossing the tracks is split into several OSM segments at the rail nodes: merge them
  const merged = [];
  for (const c of crossings.sort((a, b) => b.span - a.span)) {
    const m = merged.find((o) => Math.hypot(o.x - c.x, o.y - c.y) < 7 && o.rx * c.rx + o.ry * c.ry > 0.85);
    if (!m) merged.push(c);
  }
  crossings.length = 0;
  crossings.push(...merged);

  // ---------- areas for people and geese ----------
  const ringOf = (e) => e.geometry.map((g) => proj(g.lat, g.lon));
  const areaOf = (r) => { let a = 0; for (let i = 0; i < r.length; i++) { const q = r[(i + 1) % r.length]; a += r[i][0] * q[1] - q[0] * r[i][1]; } return Math.abs(a / 2); };
  const pip = ([x, y], r) => { let ins = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins; } return ins; };
  // oriented bounding rectangle of a pitch (the smallest one aligned with one of its edges)
  function orientedRect(r) {
    let best = null;
    for (let i = 0; i < r.length; i++) {
      const q = r[(i + 1) % r.length], L = Math.hypot(q[0] - r[i][0], q[1] - r[i][1]);
      if (L < 1) continue;
      const ux = (q[0] - r[i][0]) / L, uy = (q[1] - r[i][1]) / L;
      let a0 = Infinity, a1 = -Infinity, b0 = Infinity, b1 = -Infinity;
      for (const [x, y] of r) { const a = x * ux + y * uy, b = -x * uy + y * ux; a0 = Math.min(a0, a); a1 = Math.max(a1, a); b0 = Math.min(b0, b); b1 = Math.max(b1, b); }
      const ar = (a1 - a0) * (b1 - b0);
      if (!best || ar < best.ar) best = { ar, ux, uy, a0, a1, b0, b1 };
    }
    let { ux, uy, a0, a1, b0, b1 } = best;
    if (a1 - a0 < b1 - b0) { [ux, uy] = [-uy, ux]; [a0, a1, b0, b1] = [-b1, -b0, a0, a1]; }
    const ca = (a0 + a1) / 2, cb = (b0 + b1) / 2;
    return { x: +(ca * ux - cb * uy).toFixed(1), y: +(ca * uy + cb * ux).toFixed(1), ux: +ux.toFixed(4), uy: +uy.toFixed(4), len: +(a1 - a0).toFixed(1), wid: +(b1 - b0).toFixed(1) };
  }
  const fields = [];
  for (const e of raw.elements) {
    const t = e.tags || {};
    if (e.type !== 'way' || !e.geometry || t.leisure !== 'pitch') continue;
    if (!['soccer', 'canadian_football', 'rugby_union', 'american_football', 'multi'].includes(t.sport)) continue;
    const r = ringOf(e);
    if (areaOf(r) < 2500 || !r.every((p) => inside(p))) continue;
    const f = { name: t.name || null, sport: t.sport, ...orientedRect(r) };
    const n = FIELD_NUDGE[f.name];
    if (n) { f.x = +(f.x + n[0]).toFixed(1); f.y = +(f.y + n[1]).toFixed(1); f.nudged = true; }
    fields.push(f);
  }
  // grass and water for geese: a bag of random interior points per area
  const geeseAreas = [];
  for (const e of raw.elements) {
    const t = e.tags || {};
    if (e.type !== 'way' || !e.geometry) continue;
    const water = t.natural === 'water';
    if (!(water || t.leisure === 'park' || t.landuse === 'grass' || t.natural === 'grass' || t.landuse === 'meadow' || t.landuse === 'recreation_ground')) continue;
    const r = ringOf(e), A = areaOf(r);
    if (A < (water ? 2000 : 3500)) continue;
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    for (const [x, y] of r) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    const pts = [];
    for (let k = 0; k < 4000 && pts.length < 48; k++) {
      const p = [x0 + ((k * 0.618034) % 1) * (x1 - x0), y0 + ((k * 0.754877) % 1) * (y1 - y0)];
      if (inside(p, -30) && pip(p, r)) pts.push(p.map((v) => +v.toFixed(1)));
    }
    if (pts.length >= 12) geeseAreas.push({ water, area: Math.round(A), pts });
  }

  // ---------- named parking lots ----------
  const parking = [];
  for (const e of raw.elements) {
    const t = e.tags || {};
    if (e.type !== 'way' || !e.geometry || t.amenity !== 'parking' || !(t.name || t.ref)) continue;
    const r = ringOf(e);
    const c = r.reduce((s, p) => [s[0] + p[0] / r.length, s[1] + p[1] / r.length], [0, 0]);
    if (!inside(c, -10)) continue;
    const name = String(t.name || t.ref).replace(/^University of Waterloo:\s*/i, '');
    const access = { permit: 'Permit', permissive: 'Open', customers: 'Customers', yes: 'Public', private: 'Private' }[t.access] || null;
    parking.push({ name, access, x: +c[0].toFixed(1), y: +c[1].toFixed(1), area: Math.round(areaOf(r)), ring: r });
  }

  // ---------- projection: px = a*x + b*y + c*h + d ----------
  const P = makeProjector(scene, meta);
  // parking outlines in mosaic pixels, so the viewer can hover/highlight them like buildings
  for (const l of parking) { l.outline = l.ring.map(([x, y]) => P(x, y, 0.2).map((v) => +v.toFixed(1))); delete l.ring; }
  const o = P(0, 0, 0), ex = P(1, 0, 0), ey = P(0, 1, 0), eh = P(0, 0, 1);
  const projection = [0, 1].map((k) => [ex[k] - o[k], ey[k] - o[k], eh[k] - o[k], o[k]].map((v) => +v.toFixed(6)));

  return {
    projection, azimuth: meta.azimuth, bounds: B,
    roads: { nodes, edges },
    buses: routes,
    ion: { ...transit.ion, tracks: tracks.map((pts) => ({ pts, station: platC ? +onLine(pts, platC).s.toFixed(1) : null })) },
    crossings, fields, geeseAreas, parking,
    liveries: transit.liveries,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const scene = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/scene.json'), 'utf8'));
  const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'out/meta.json'), 'utf8'));
  const t = buildTraffic(scene, meta);
  fs.writeFileSync(path.join(ROOT, 'out/traffic.json'), JSON.stringify(t));
  console.log(`traffic: ${t.roads.edges.length} road segments, ${t.buses.length} bus routes (${t.buses.map((b) => `${b.id}:${b.paths[0].stops.length} stops/${Math.round(b.paths[0].pts.length)} pts`).join(', ')}), ION ${t.ion.tracks.length} tracks (stations at ${t.ion.tracks.map((k) => k.station).join(' / ')} m), ${t.crossings.length} level crossings, ${t.fields.length} fields, ${t.geeseAreas.length} goose areas, ${t.parking.length} parking lots`);
}
