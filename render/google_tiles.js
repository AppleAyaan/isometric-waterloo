// Google Photorealistic 3D Tiles as the colour source for the isometric render.
// The tiles are re-oriented so they share the OSM scene's frame: origin at the bbox centre,
// x = east, y = up, z = south, ground at y = 0.
import * as THREE from 'three';
import { TilesRenderer } from '3d-tiles-renderer';
import { GoogleCloudAuthPlugin, GLTFExtensionsPlugin, ReorientationPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function createGoogleLayer({ apiKey, origin, errorTarget = 3, status = () => {} }) {
  const scene = new THREE.Scene();
  const tiles = new TilesRenderer();
  tiles.registerPlugin(new GoogleCloudAuthPlugin({ apiToken: apiKey, autoRefreshToken: true }));
  const draco = new DRACOLoader().setDecoderPath('/node_modules/three/examples/jsm/libs/draco/gltf/');
  tiles.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: draco }));
  tiles.registerPlugin(new ReorientationPlugin({
    lat: THREE.MathUtils.degToRad(origin.lat), lon: THREE.MathUtils.degToRad(origin.lon), height: 0, recenter: true,
  }));
  tiles.errorTarget = errorTarget;
  tiles.parseQueue.maxJobs = 8;
  tiles.downloadQueue.maxJobs = 24;
  let failed = null;
  tiles.addEventListener('load-error', (e) => { failed = e.error || e; });

  // The plugin's frame has x = west, z = north; turn it 180° so x = east, z = south.
  const frame = new THREE.Group();
  frame.rotation.y = Math.PI;
  frame.add(tiles.group);
  scene.add(frame);

  async function renderLoaded(renderer, cam, size, timeoutMs = 120000) {
    tiles.setCamera(cam);
    tiles.setResolution(cam, size, size);
    const t0 = performance.now();
    let stable = 0;
    while (performance.now() - t0 < timeoutMs) {
      cam.updateMatrixWorld();
      tiles.update();
      renderer.render(scene, cam);
      if (failed) throw new Error(`Google 3D Tiles failed to load: ${failed.message || failed}`);
      const s = tiles.stats;
      const busy = s.queued + s.downloading + s.parsing;
      stable = busy === 0 && tiles.root ? stable + 1 : 0;
      if (stable >= 4) return;
      await sleep(40);
    }
    console.warn('tile load timed out; rendering what is loaded');
  }

  // Ellipsoid height 0 is not the ground: find it by ray-casting down at a few points near the centre.
  async function calibrateGround(renderer, cam, size) {
    status('locating ground level…');
    await renderLoaded(renderer, cam, size);
    const ray = new THREE.Raycaster();
    const hits = [];
    for (const [x, z] of [[0, 0], [60, 0], [-60, 0], [0, 60], [0, -60], [40, 40], [-40, -40]]) {
      ray.set(new THREE.Vector3(x, 3000, z), new THREE.Vector3(0, -1, 0));
      const h = ray.intersectObject(scene, true)[0];
      if (h) hits.push(h.point.y);
    }
    if (!hits.length) throw new Error('could not find the ground in Google 3D Tiles (check coverage / API key)');
    hits.sort((a, b) => a - b);
    const ground = hits[Math.floor(hits.length / 2)];
    frame.position.y -= ground;
    frame.updateMatrixWorld(true);
    return ground;
  }

  return { scene, tiles, renderLoaded, calibrateGround };
}
