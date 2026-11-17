// Renders data/scene.json as an isometric "whitebox" map, tile by tile, into one big mosaic.
// Also renders a building-ID map (for hover/picking) and per-building outlines in mosaic pixels.
//
// URL params: ?scale=2.5 (pixels per metre)  &azimuth=-45 (camera direction, degrees)  &preview=1
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createGoogleLayer } from './google_tiles.js';

const params = new URLSearchParams(location.search);
export const CONFIG = {
  scale: Number(params.get('scale') || 2.5),      // pixels per metre in the final mosaic
  elevation: 30,                                   // camera elevation: 30° = classic 2:1 pixel-art isometric
  azimuth: Number(params.get('azimuth') ?? -45),   // -45 = camera in the south-west, looking north-east
  tile: 512,                                       // mosaic is padded to a multiple of this (Colab works in 512 quadrants)
  idDownsample: 2,                                 // ID map resolution divisor
  background: '#f3eee4',
};

const COLORS = {
  ground: '#b4c493',
  areas: {
    urban: '#cdc6b4', plaza: '#ddd5c4', grass: '#93c26d', scrub: '#a3bd7c', wood: '#7aa65c', pitch: '#6db25a',
    parking: '#a7a6a2', construction: '#c9aa7c', rail_yard: '#aaa194', water: '#5c9fd6',
  },
  roads: {
    motorway: '#5f5f66', trunk: '#5f5f66', primary: '#5f5f66', secondary: '#66666d', tertiary: '#6d6d74',
    unclassified: '#7a7a80', residential: '#7a7a80', service: '#86868b', living_street: '#86868b',
    pedestrian: '#ddd4c2', footway: '#e8dfcd', path: '#d9c9a6', cycleway: '#d7a08c', steps: '#cfc2ab', track: '#bfa982',
    rail: '#5a4a42', waterway: '#5c9fd6',
  },
  roofs: {
    university: '#ebe5d8', college: '#ebe5d8', dormitory: '#d8b597', apartments: '#d3c0a4', residential: '#cfa88a',
    house: '#c58a6b', detached: '#c58a6b', retail: '#d9cba8', commercial: '#d6d0c2', office: '#d5dae0',
    roof: '#c9ccd1', default: '#e2ddd2',
  },
  tree: '#4f8b3d', treeDark: '#3f7432',
};
const AREA_ORDER = ['urban', 'plaza', 'rail_yard', 'construction', 'grass', 'scrub', 'wood', 'pitch', 'parking', 'water'];
const ROAD_ORDER = ['waterway', 'path', 'track', 'footway', 'steps', 'cycleway', 'pedestrian', 'service', 'living_street',
  'residential', 'unclassified', 'tertiary', 'secondary', 'primary', 'trunk', 'motorway', 'rail'];

const SLAB = 14; // metres of earth shown under the map edge
const status = (t) => { document.getElementById('status').textContent = t; };

// ---------- geometry helpers (scene coords: x = east, y = north; world: x = east, y = up, z = south) ----------
function shapeOf(outer, holes) {
  const s = new THREE.Shape(outer.map(([x, y]) => new THREE.Vector2(x, y)));
  for (const h of holes || []) s.holes.push(new THREE.Path(h.map(([x, y]) => new THREE.Vector2(x, y))));
  return s;
}
function flatGeom(outer, holes) {
  const g = new THREE.ShapeGeometry(shapeOf(outer, holes));
  g.rotateX(-Math.PI / 2);
  return g;
}
function extrudeGeom(outer, holes, minH, maxH) {
  const g = new THREE.ExtrudeGeometry(shapeOf(outer, holes), { depth: Math.max(0.5, maxH - minH), bevelEnabled: false });
  g.rotateX(-Math.PI / 2);
  g.translate(0, minH, 0);
  return g;
}
function ribbonGeom(pts, width) {
  const parts = [];
  const hw = width / 2;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const len = Math.hypot(bx - ax, by - ay);
    if (len < 0.01) continue;
    const nx = (-(by - ay) / len) * hw, ny = ((bx - ax) / len) * hw;
    const g = new THREE.BufferGeometry();
    // world: (x, 0, -y)
    const v = [ax + nx, 0, -(ay + ny), bx + nx, 0, -(by + ny), bx - nx, 0, -(by - ny), ax - nx, 0, -(ay - ny)];
    g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
    g.setIndex([0, 2, 1, 0, 3, 2]);
    g.computeVertexNormals();
    parts.push(g);
  }
  for (const [x, y] of pts) {
    if (width < 3) continue; // joints only matter for wide roads
    const c = new THREE.CircleGeometry(hw, 10);
    c.rotateX(-Math.PI / 2);
    c.translate(x, 0, -y);
    c.deleteAttribute('uv');
    parts.push(c);
  }
  return parts;
}
function strip(g) {
  // mergeGeometries needs identical attribute sets
  for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  if (!g.attributes.normal) g.computeVertexNormals();
  return g.index ? g.toNonIndexed() : g;
}
function merged(list) {
  return list.length ? mergeGeometries(list.map(strip)) : null;
}

// ---------- scene construction ----------
function buildScenes(data) {
  const scene = new THREE.Scene();
  const idScene = new THREE.Scene();
  let order = 0;
  const flatMat = (color) => new THREE.MeshLambertMaterial({ color, depthWrite: false, side: THREE.DoubleSide });

  // ground plane covering the bbox
  const { minX, maxX, minY, maxY } = data.bounds;
  const ground = new THREE.Mesh(flatGeom([[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]), flatMat(COLORS.ground));
  ground.renderOrder = order++;
  scene.add(ground);
  // diorama base: a slab of earth under the map
  const slab = new THREE.Mesh(new THREE.BoxGeometry(maxX - minX, SLAB, maxY - minY), new THREE.MeshLambertMaterial({ color: '#8b6b4b' }));
  slab.position.set((minX + maxX) / 2, -SLAB / 2 - 0.05, -(minY + maxY) / 2);
  slab.renderOrder = -1; // draw first so the flat ground layers paint over its top face
  scene.add(slab);

  for (const kind of AREA_ORDER) {
    const geoms = data.areas.filter((a) => a.kind === kind).map((a) => flatGeom(a.outer, a.holes));
    const g = merged(geoms);
    if (!g) continue;
    const m = new THREE.Mesh(g, flatMat(COLORS.areas[kind]));
    m.renderOrder = order++;
    scene.add(m);
  }
  for (const kind of ROAD_ORDER) {
    const geoms = data.roads.filter((r) => r.kind === kind).flatMap((r) => ribbonGeom(r.pts, r.width));
    const g = merged(geoms);
    if (!g) continue;
    const m = new THREE.Mesh(g, flatMat(COLORS.roads[kind]));
    m.renderOrder = order++;
    scene.add(m);
  }

  // buildings: one merged mesh per roof colour; outlines; ID meshes
  const byColor = new Map();
  const edges = [];
  const idGeoms = new Map();
  for (const b of data.buildings) {
    const color = COLORS.roofs[b.kind] || COLORS.roofs.default;
    for (const v of b.volumes) {
      let g;
      try { g = extrudeGeom(v.outer, v.holes, v.minHeight, v.height); } catch { continue; }
      if (!byColor.has(color)) byColor.set(color, []);
      byColor.get(color).push(g);
      edges.push(new THREE.EdgesGeometry(g, 30));
      if (!idGeoms.has(b.id)) idGeoms.set(b.id, []);
      idGeoms.get(b.id).push(g.clone());
    }
  }
  for (const [color, list] of byColor) {
    const m = new THREE.Mesh(merged(list), new THREE.MeshLambertMaterial({ color, flatShading: true }));
    m.renderOrder = 10000;
    scene.add(m);
  }
  const edgeGeom = mergeGeometries(edges.map((e) => { for (const k of Object.keys(e.attributes)) if (k !== 'position') e.deleteAttribute(k); return e; }));
  const lines = new THREE.LineSegments(edgeGeom, new THREE.LineBasicMaterial({ color: '#4a4640', transparent: true, opacity: 0.55 }));
  lines.renderOrder = 10001;
  scene.add(lines);

  // trees: low-poly crowns, deterministic size jitter
  let seed = 7;
  const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
  const crown = new THREE.IcosahedronGeometry(1, 0);
  const treeMats = [new THREE.MeshLambertMaterial({ color: COLORS.tree, flatShading: true }), new THREE.MeshLambertMaterial({ color: COLORS.treeDark, flatShading: true })];
  for (const mi of [0, 1]) {
    const pts = data.trees.filter((_, i) => i % 2 === mi);
    const inst = new THREE.InstancedMesh(crown, treeMats[mi], pts.length);
    const m4 = new THREE.Matrix4();
    pts.forEach(([x, y], i) => {
      const r = 2.6 + rand() * 1.8;
      m4.compose(new THREE.Vector3(x, r + 1.5 + rand() * 2, -y), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, rand() * 6.28, 0)), new THREE.Vector3(r, r * 1.15, r));
      inst.setMatrixAt(i, m4);
    });
    inst.renderOrder = 10000;
    scene.add(inst);
  }

  // lighting: soft sky + sun from the upper left of the view
  scene.add(new THREE.HemisphereLight('#ffffff', '#8a8f80', 1.6));
  const sun = new THREE.DirectionalLight('#fff6e6', 2.0);
  sun.position.set(-300, 600, 120);
  scene.add(sun);

  // ID scene: unlit flat colours, id encoded as RGB
  for (const [id, list] of idGeoms) {
    const c = new THREE.Color().setRGB((id & 255) / 255, ((id >> 8) & 255) / 255, 1, THREE.LinearSRGBColorSpace);
    idScene.add(new THREE.Mesh(merged(list), new THREE.MeshBasicMaterial({ color: c })));
  }
  return { scene, idScene };
}

// ---------- projection ----------
function makeCamera() {
  const e = THREE.MathUtils.degToRad(CONFIG.elevation), a = THREE.MathUtils.degToRad(CONFIG.azimuth);
  // azimuth measured from south (+z) towards east (+x); -45 => south-west
  const dir = new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 20000);
  cam.position.copy(dir).multiplyScalar(5000);
  cam.up.set(0, 1, 0);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  return { cam, right, up };
}

function computeLayout(data, right, up) {
  const { minX, maxX, minY, maxY } = data.bounds;
  const pts = [];
  for (const [x, y] of [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]) {
    pts.push(new THREE.Vector3(x, 0, -y), new THREE.Vector3(x, -SLAB, -y));
  }
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  for (const b of data.buildings) for (const [x, y] of b.outer) pts.push(new THREE.Vector3(clamp(x, minX, maxX), b.height, -clamp(y, minY, maxY)));
  let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity;
  for (const p of pts) {
    const r = p.dot(right), u = p.dot(up);
    minR = Math.min(minR, r); maxR = Math.max(maxR, r); minU = Math.min(minU, u); maxU = Math.max(maxU, u);
  }
  const S = CONFIG.scale, T = CONFIG.tile;
  const W = Math.ceil(((maxR - minR) * S + 32) / T) * T;
  const H = Math.ceil(((maxU - minU) * S + 32) / T) * T;
  // centre the content in the padded mosaic
  const padR = (W / S - (maxR - minR)) / 2, padU = (H / S - (maxU - minU)) / 2;
  return { W, H, left: minR - padR, top: maxU + padU };
}

// ---------- main export ----------
async function run() {
  status('loading scene…');
  const data = await (await fetch('/data/scene.json')).json();
  status('building geometry…');
  let { scene, idScene } = buildScenes(data);
  // ?source=google&key=... or ?source=ion&ion=... uses Google Photorealistic 3D Tiles for colour; OSM still drives the ID map.
  const source = params.get('source');
  const google = source === 'google' || source === 'ion'
    ? await createGoogleLayer({ apiKey: params.get('key'), ionToken: source === 'ion' ? params.get('ion') : null, origin: data.origin, errorTarget: Number(params.get('error') || 3), status })
    : null;
  if (google) scene = google.scene;
  const { cam, right, up } = makeCamera();
  const L = computeLayout(data, right, up);
  const S = CONFIG.scale, T = CONFIG.tile;

  const toPx = (x, y, h) => {
    const p = new THREE.Vector3(x, h, -y);
    return [+((p.dot(right) - L.left) * S).toFixed(1), +((L.top - p.dot(up)) * S).toFixed(1)];
  };

  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(T, T);
  renderer.setClearColor(CONFIG.background);
  const idRenderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
  idRenderer.setPixelRatio(1);
  idRenderer.setSize(T, T);
  idRenderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  idRenderer.setClearColor(0x000000);
  // clip everything to the bbox so the map reads as a neat diorama block
  const { minX, maxX, minY, maxY } = data.bounds;
  const planes = [
    new THREE.Plane(new THREE.Vector3(1, 0, 0), -minX), new THREE.Plane(new THREE.Vector3(-1, 0, 0), maxX),
    new THREE.Plane(new THREE.Vector3(0, 0, -1), -minY), new THREE.Plane(new THREE.Vector3(0, 0, 1), maxY),
  ].map((pl) => { pl.constant += 0.001; return pl; });
  renderer.clippingPlanes = planes;
  idRenderer.clippingPlanes = planes;

  const mosaic = document.createElement('canvas');
  mosaic.width = L.W; mosaic.height = L.H;
  const mctx = mosaic.getContext('2d');
  const D = CONFIG.idDownsample;
  const idCanvas = document.createElement('canvas');
  idCanvas.width = L.W / D; idCanvas.height = L.H / D;
  const ictx = idCanvas.getContext('2d');
  ictx.imageSmoothingEnabled = false;

  if (google) {
    const half = T / 2 / S;
    Object.assign(cam, { left: -half, right: half, top: half, bottom: -half });
    cam.updateProjectionMatrix();
    const g = await google.calibrateGround(renderer, cam, T);
    console.log(`ground at ${g.toFixed(1)} m above the ellipsoid`);
  }
  const cols = L.W / T, rows = L.H / T;
  for (let ty = 0; ty < rows; ty++) {
    for (let tx = 0; tx < cols; tx++) {
      cam.left = L.left + (tx * T) / S;
      cam.right = L.left + ((tx + 1) * T) / S;
      cam.top = L.top - (ty * T) / S;
      cam.bottom = L.top - ((ty + 1) * T) / S;
      cam.updateProjectionMatrix();
      if (google) await google.renderLoaded(renderer, cam, T);
      else renderer.render(scene, cam);
      mctx.drawImage(renderer.domElement, tx * T, ty * T);
      idRenderer.render(idScene, cam);
      ictx.drawImage(idRenderer.domElement, 0, 0, T, T, (tx * T) / D, (ty * T) / D, T / D, T / D);
      status(`tile ${ty * cols + tx + 1}/${cols * rows}`);
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  // building metadata + screen-space outline (convex hull of the extruded prism)
  const hull = (pts) => {
    pts = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], hi = [];
    for (const p of pts) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), p) <= 0) lo.pop(); lo.push(p); }
    for (const p of pts.reverse()) { while (hi.length >= 2 && cross(hi.at(-2), hi.at(-1), p) <= 0) hi.pop(); hi.push(p); }
    return lo.slice(0, -1).concat(hi.slice(0, -1));
  };
  const info = new Map();
  const inside = ([x, y]) => x >= minX && x <= maxX && y >= minY && y <= maxY;
  for (const b of data.buildings) {
    if (!b.outer.some(inside)) continue;
    const pts = [];
    for (const v of b.volumes) for (const [x, y] of v.outer) { pts.push(toPx(x, y, v.minHeight)); pts.push(toPx(x, y, v.height)); }
    const e = info.get(b.id) || { id: b.id, osm: b.osm, name: b.name, ref: b.ref, kind: b.kind, levels: b.levels, height: b.height, address: b.address, operator: b.operator, outlines: [] };
    e.height = Math.max(e.height, b.height);
    e.outlines.push(hull(pts));
    info.set(b.id, e);
  }
  const meta = {
    width: L.W, height: L.H, tile: T, scale: S, idDownsample: D, background: CONFIG.background,
    elevation: CONFIG.elevation, azimuth: CONFIG.azimuth, origin: data.origin, generated: new Date().toISOString(),
    buildings: [...info.values()],
  };

  if (params.get('preview')) {
    const pv = document.getElementById('preview');
    pv.width = L.W; pv.height = L.H;
    pv.getContext('2d').drawImage(mosaic, 0, 0);
  }
  status(`done: ${L.W}×${L.H}px, ${cols * rows} tiles`);
  return { render: mosaic.toDataURL('image/png'), idmap: idCanvas.toDataURL('image/png'), meta };
}

window.exportMap = run;
if (params.get('preview')) run();
else status('ready: call exportMap()');
