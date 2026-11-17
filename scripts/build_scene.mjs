// Converts data/osm_raw.json (Overpass "out geom") into data/scene.json:
// local metre coordinates (x = east, y = north) around the bbox centre,
// with buildings (footprint, holes, height), flat areas, road ribbons and trees.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/osm_raw.json'), 'utf8'));
const [south, west, north, east] = fs.readFileSync(path.join(ROOT, 'data/bbox.txt'), 'utf8').trim().split(',').map(Number);

const lat0 = (south + north) / 2, lon0 = (west + east) / 2;
const KX = Math.cos((lat0 * Math.PI) / 180) * 111320, KY = 110540;
const proj = (lat, lon) => [+((lon - lon0) * KX).toFixed(2), +((lat - lat0) * KY).toFixed(2)];
const ring = (geom) => geom.map((g) => proj(g.lat, g.lon));

const bounds = { minX: (west - lon0) * KX, maxX: (east - lon0) * KX, minY: (south - lat0) * KY, maxY: (north - lat0) * KY };

// ---------- helpers ----------
function signedArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] - r[i][0]) * (r[j][1] + r[i][1]);
  return a / 2;
}
function pointInRing([x, y], r) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = r[i], [xj, yj] = r[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function closeless(r) {
  if (r.length > 1 && r[0][0] === r.at(-1)[0] && r[0][1] === r.at(-1)[1]) return r.slice(0, -1);
  return r;
}
function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}
// Joins multipolygon member ways into closed rings.
function joinRings(ways) {
  const segs = ways.map((w) => w.slice());
  const rings = [];
  while (segs.length) {
    let cur = segs.shift();
    let guard = 0;
    while ((cur[0][0] !== cur.at(-1)[0] || cur[0][1] !== cur.at(-1)[1]) && guard++ < 1000) {
      const end = cur.at(-1);
      const i = segs.findIndex((s) => (s[0][0] === end[0] && s[0][1] === end[1]) || (s.at(-1)[0] === end[0] && s.at(-1)[1] === end[1]));
      if (i < 0) break;
      const s = segs.splice(i, 1)[0];
      cur = cur.concat(s[0][0] === end[0] && s[0][1] === end[1] ? s.slice(1) : s.reverse().slice(1));
    }
    if (cur.length >= 4) rings.push(closeless(cur));
  }
  return rings;
}
function polygonsOf(el) {
  if (el.type === 'way' && el.geometry) {
    const r = closeless(ring(el.geometry));
    return r.length >= 3 ? [{ outer: r, holes: [] }] : [];
  }
  if (el.type === 'relation' && el.members) {
    const outers = joinRings(el.members.filter((m) => m.role !== 'inner' && m.geometry).map((m) => ring(m.geometry)));
    const inners = joinRings(el.members.filter((m) => m.role === 'inner' && m.geometry).map((m) => ring(m.geometry)));
    const polys = outers.map((o) => ({ outer: o, holes: [] }));
    for (const h of inners) {
      const p = polys.find((p) => pointInRing(h[0], p.outer));
      if (p) p.holes.push(h);
    }
    return polys;
  }
  return [];
}

// ---------- classification ----------
const DEFAULT_HEIGHT = {
  university: 14, college: 14, school: 10, dormitory: 18, apartments: 16, residential: 9,
  part: 9, house: 7, detached: 7, semidetached_house: 7, terrace: 8, retail: 6, commercial: 9,
  office: 12, industrial: 8, chapel: 9, church: 11, sports_centre: 10, shed: 3, garage: 3,
  service: 4, roof: 5, bridge: 7, parking: 9, hospital: 15,
};
function buildingHeight(t) {
  const h = num(t.height) ?? num(t['building:height']);
  const levels = num(t['building:levels']);
  const roofLevels = num(t['roof:levels']) ?? 0;
  let height = h ?? (levels != null ? levels * 3.6 + roofLevels * 2.5 + 1 : DEFAULT_HEIGHT[t.building] ?? 9);
  let minHeight = num(t.min_height) ?? (num(t['building:min_level']) != null ? num(t['building:min_level']) * 3.6 : 0);
  if (t.building === 'roof' && !minHeight) { minHeight = Math.max(0, height - 1); }
  if (minHeight >= height) height = minHeight + 1;
  return { height: +height.toFixed(1), minHeight: +minHeight.toFixed(1) };
}

function areaKind(t) {
  if (t.natural === 'water' || t.landuse === 'reservoir' || t.landuse === 'basin' || t.leisure === 'swimming_pool') return 'water';
  if (t.natural === 'wood' || t.landuse === 'forest') return 'wood';
  if (t.natural === 'scrub') return 'scrub';
  if (t.leisure === 'pitch' || t.leisure === 'track') return 'pitch';
  if (t.amenity === 'parking' || t.landuse === 'garages') return 'parking';
  if (t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'grass' || t.natural === 'grass' ||
      t.landuse === 'recreation_ground' || t.leisure === 'nature_reserve' || t.landuse === 'meadow' ||
      t.landuse === 'village_green' || t.landuse === 'flowerbed') return 'grass';
  if (t.landuse === 'construction') return 'construction';
  if (t.landuse === 'railway') return 'rail_yard';
  if (t.highway === 'pedestrian' && t.area === 'yes') return 'plaza';
  if (t.landuse === 'residential' || t.landuse === 'commercial' || t.landuse === 'retail' || t.landuse === 'education' || t.amenity === 'university') return 'urban';
  return null;
}
const ROAD_WIDTH = {
  motorway: 16, trunk: 14, primary: 13, secondary: 12, tertiary: 10, unclassified: 8, residential: 8,
  service: 5, living_street: 6, pedestrian: 5, footway: 2.4, path: 2.2, cycleway: 2.6, steps: 2.4, track: 3,
};

// ---------- build ----------
const scene = { origin: { lat: lat0, lon: lon0 }, bounds, buildings: [], areas: [], roads: [], trees: [] };
const overridesFile = path.join(ROOT, 'data/overrides.json');
const overrides = fs.existsSync(overridesFile) ? JSON.parse(fs.readFileSync(overridesFile, 'utf8')) : {};
const parts = [];
let bid = 0;
for (const el of raw.elements) {
  const t = el.tags || {};
  if (t['building:part'] && t['building:part'] !== 'no') {
    const { height, minHeight } = buildingHeight({ ...t, building: t['building:part'] === 'yes' ? 'part' : t['building:part'] });
    for (const poly of polygonsOf(el)) {
      if (signedArea(poly.outer) < 0) poly.outer.reverse();
      poly.holes.forEach((h) => { if (signedArea(h) > 0) h.reverse(); });
      parts.push({ height, minHeight, outer: poly.outer, holes: poly.holes });
    }
    continue;
  }
  if (t.building && t.building !== 'no' && !t['disused:building']) {
    const { height, minHeight } = buildingHeight(t);
    const myId = ++bid;
    for (const poly of polygonsOf(el)) {
      if (signedArea(poly.outer) < 0) poly.outer.reverse(); // counter-clockwise outer
      poly.holes.forEach((h) => { if (signedArea(h) > 0) h.reverse(); });
      scene.buildings.push({
        id: myId,
        osm: `${el.type}/${el.id}`,
        name: t.name || t['name:en'] || null,
        ref: t.ref || null,
        kind: t.building,
        levels: num(t['building:levels']),
        address: t['addr:housenumber'] && t['addr:street'] ? `${t['addr:housenumber']} ${t['addr:street']}` : null,
        operator: t.operator || null,
        height, minHeight,
        outer: poly.outer, holes: poly.holes,
        volumes: null, // filled below: list of {outer, holes, height, minHeight} to extrude
      });
    }
    continue;
  }
  const kind = areaKind(t);
  if (kind && (el.type === 'relation' || (el.geometry && el.geometry.length > 3 && el.geometry[0].lat === el.geometry.at(-1).lat && el.geometry[0].lon === el.geometry.at(-1).lon))) {
    for (const poly of polygonsOf(el)) scene.areas.push({ kind, outer: poly.outer, holes: poly.holes, area: Math.abs(signedArea(poly.outer)) });
    continue;
  }
  if (el.type === 'way' && el.geometry) {
    if (t.highway && ROAD_WIDTH[t.highway] && t.area !== 'yes' && !['corridor', 'platform', 'construction', 'proposed'].includes(t.highway) && t.indoor !== 'yes' && !(num(t.layer) < 0) && t.tunnel !== 'yes') {
      scene.roads.push({ kind: t.highway, width: ROAD_WIDTH[t.highway], pts: ring(el.geometry), bridge: t.bridge === 'yes' });
    } else if (t.railway === 'rail' || t.railway === 'light_rail') {
      scene.roads.push({ kind: 'rail', width: 3.2, pts: ring(el.geometry) });
    } else if (t.waterway && ['stream', 'river', 'canal', 'drain', 'ditch'].includes(t.waterway) && t.tunnel !== 'culvert' && t.tunnel !== 'yes') {
      scene.roads.push({ kind: 'waterway', width: t.waterway === 'river' ? 14 : t.waterway === 'stream' ? 4 : 2, pts: ring(el.geometry) });
    } else if (t.natural === 'tree_row') {
      const pts = ring(el.geometry);
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
        const n = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / 7));
        for (let k = 0; k < n; k++) scene.trees.push([+(ax + ((bx - ax) * k) / n).toFixed(1), +(ay + ((by - ay) * k) / n).toFixed(1)]);
      }
    }
  }
  if (el.type === 'node' && t.natural === 'tree') scene.trees.push(proj(el.lat, el.lon));
}

// Attach building:part volumes to the building that contains them. A building with parts
// is drawn from its parts only (the outline is kept for hover/picking).
const centroid = (r) => [r.reduce((a, p) => a + p[0], 0) / r.length, r.reduce((a, p) => a + p[1], 0) / r.length];
for (const part of parts) {
  const c = centroid(part.outer);
  const owner = scene.buildings.find((b) => pointInRing(c, b.outer) && !b.holes.some((h) => pointInRing(c, h)));
  if (owner) (owner.volumes ||= []).push(part);
  else scene.buildings.push({ id: ++bid, osm: null, name: null, ref: null, kind: 'part', levels: null, address: null, operator: null, height: part.height, minHeight: part.minHeight, outer: part.outer, holes: part.holes, volumes: null });
}
for (const b of scene.buildings) {
  const o = overrides[b.ref] || overrides[b.osm];
  if (o) {
    if (o.height) { b.height = o.height; b.volumes = null; }
    if (o.name) b.name = o.name;
    if (o.ref) b.ref = o.ref;
  }
  if (b.volumes) {
    // Parts may not cover the whole footprint: keep a base volume at the outline's own height.
    b.volumes.unshift({ outer: b.outer, holes: b.holes, height: Math.min(b.height, Math.max(...b.volumes.map((v) => v.height))), minHeight: b.minHeight });
    b.height = Math.max(b.height, ...b.volumes.map((v) => v.height));
  } else {
    b.volumes = [{ outer: b.outer, holes: b.holes, height: b.height, minHeight: b.minHeight }];
  }
}

// Scatter trees in woods (deterministic jittered grid), skipping building footprints.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
for (const a of scene.areas.filter((a) => a.kind === 'wood' || a.kind === 'scrub')) {
  const step = a.kind === 'wood' ? 7 : 11;
  const xs = a.outer.map((p) => p[0]), ys = a.outer.map((p) => p[1]);
  for (let x = Math.min(...xs); x < Math.max(...xs); x += step) {
    for (let y = Math.min(...ys); y < Math.max(...ys); y += step) {
      const p = [x + (rand() - 0.5) * step * 0.8, y + (rand() - 0.5) * step * 0.8];
      if (pointInRing(p, a.outer) && !a.holes.some((h) => pointInRing(p, h))) scene.trees.push([+p[0].toFixed(1), +p[1].toFixed(1)]);
    }
  }
}
// Larger areas first so small ones draw on top.
scene.areas.sort((a, b) => b.area - a.area);

fs.writeFileSync(path.join(ROOT, 'data/scene.json'), JSON.stringify(scene));
const named = scene.buildings.filter((b) => b.name).length;
console.log(`scene: ${scene.buildings.length} buildings (${named} named), ${scene.areas.length} areas, ${scene.roads.length} lines, ${scene.trees.length} trees`);
console.log(`bounds: ${(bounds.maxX - bounds.minX).toFixed(0)} m x ${(bounds.maxY - bounds.minY).toFixed(0)} m`);
