# Isometric Waterloo

A giant isometric map of the University of Waterloo campus. Every building is real: point at one to see what it is.
It follows the isometric.nyc approach, using only free and open tools.

```
OpenStreetMap ──► scene.json ──► three.js isometric render ──► Colab (SDXL + ControlNet + pixel-art LoRA, infill) ──► map.png ──► viewer
                                     └─► idmap.png + meta.json (hover / search) ───────────────────────────────────────────────┘
```

## Pipeline

| Step | Command | Output |
|---|---|---|
| 1. Download map data | `npm run fetch` (optional; data is committed) | `data/osm_raw.json` |
| 2. Build the 3D scene | `npm run scene` | `data/scene.json` |
| 3a. Render the whitebox | `npm run export` (`-- --scale 3` for more detail) | `out/render.png`, `out/idmap.png`, `out/meta.json` |
| 3b. Render real 3D imagery | `npm run export -- --source google` (needs `.google-maps-key`) | `out/photo.png` (+ ID map/meta) |
| 4. Paint it (free GPU) | open `colab/paint_waterloo.ipynb` in Google Colab | `map.png` → put in `out/` |
| 4b. Bake the night map | `npm run night` (after `map.png` changes) | `out/night.png`, `out/night.json` |
| 5. View | `npm run serve` → http://localhost:8080 | |
| 6. Deploy | `npm run site` (check it with `npm run preview`) → push to `main`, or upload `site/` anywhere static | `site/` |

Setup: `npm install` (export uses your installed Google Chrome via Playwright).

### Deploying
`npm run site` builds a static `site/` folder:
- the map is cut into a Deep Zoom tile pyramid (`out/map.dzi` + `map_files/`), so visitors stream only the tiles on screen instead of a 25-megapixel PNG. The tiler is pure Node (`scripts/tiles.mjs`, `scripts/png.mjs`), so the build needs no `npm install`;
- `photo.png` (raw Google imagery) and `render.png` are never published;
- it adds a social preview image (`og.png`), favicon/app icons, `site.webmanifest`, `robots.txt`, `sitemap.xml`, `404.html`, `.nojekyll` and a `_headers` file (cache rules for Cloudflare Pages / Netlify).

Link previews need the public URL: `SITE_URL=https://your.domain/ npm run site` (defaults to the GitHub Pages URL).

**GitHub Pages:** `.github/workflows/deploy.yml` rebuilds and publishes on every push to `main` that touches the viewer or `out/`. Turn it on once under *Settings → Pages → Source: GitHub Actions*.
**Cloudflare Pages / Netlify:** build command `node scripts/build_site.mjs`, output directory `site`.

### Viewer features
Search by code or name (with keyboard navigation and popular picks), shareable links that open on a building (`#DC`, `#lot/Lot C`), *Surprise me*, a self-running campus tour, directions in Google Maps, pause/play for the simulated traffic (off by default with reduced motion), full screen, a north arrow, and keyboard shortcuts (press `?` on the map).

### Google 3D Tiles via Cesium ion (no Google Cloud account)
1. Sign up at https://ion.cesium.com, open **Asset Depot**, and add **Google Photorealistic 3D Tiles** to My Assets.
2. Under **Access Tokens**, copy the default token (or create one that can read that asset) into `.cesium-ion-token` (git-ignored).
3. `npm run export -- --source ion` renders `out/photo.png`, same as the Google source below.

The Cesium ion free plan is for personal, non-commercial use.

### Google Photorealistic 3D Tiles (the Tiny Toronto look)
1. In Google Cloud Console, create a project, enable the **Map Tiles API**, and create an API key.
2. Save the key in `.google-maps-key` in the project root (git-ignored).
3. `npm run export -- --source google` renders `out/photo.png` with the same camera as the whitebox, so hover and search still line up.
4. In Colab, choose the **painted** style with `INPUT = photo.png` to turn the photo render into a clean illustrated map.

Google's Map Tiles API terms restrict storing and redistributing its imagery. Check them before publishing a site built from `photo.png` or `map.png`.

### Changing the area
`BBOX="south,west,north,east" npm run fetch && npm run scene && npm run export`

### Map life (simulated)
The viewer animates cars, GRT/GO buses, ION trains, students on the fields by CIF and Canada geese, and labels the named parking lots. None of it is live: cars wander the OSM road graph, buses are routed through the real OSM stops whose `route_ref` lists them, the ION shuttles along the line (gates come down at the level crossings) and stops at the UW station. `npm run export` writes `out/traffic.json`; after changing `data/transit.json` (route names, colours, liveries) or the scene, refresh it alone with `npm run traffic`.

Buses and trains are textured with perspective-corrected photos from Wikimedia Commons in `viewer/sprites/` (sources and licences in `viewer/sprites/CREDITS.md`); a vehicle falls back to its painted livery if an image is missing.

### Night on campus
The moon button (or `N`) cross-fades to `out/night.png`, a pre-lit copy of the painted map baked by `npm run night` (pure Node, ~25 s):
- the paint is graded to moonlight (darker, cooler, a little desaturated, violet shadows);
- every camera-facing wall gets a window grid from its OSM height and levels, and a hash per room decides which are lit and how warm. A depth buffer of the extruded buildings keeps windows only where the wall is actually in front. Dana Porter, DC, MC, SLC and the residences stay busier than offices and houses (`BUSY` in `scripts/night.mjs`);
- sodium-yellow lights along the roads, warm LEDs along paths and in parking lots throw pools that multiply the painted ground, with posts and soft bloom.

The viewer only downloads the night map the first time someone turns it on. Vehicles get headlight beams, tail lights and lit cabins. `?night` in the URL opens straight into night mode. Re-run `npm run night` whenever `map.png`, the scene or heights change.

### Fixing building heights
OSM heights and codes are sometimes missing or wrong. Add overrides to `data/overrides.json`, keyed by building code or OSM id, then run `npm run scene && npm run outlines` (no re-render needed unless heights changed):
```json
{ "LIB": { "height": 40 }, "way/123456": { "name": "Better name", "ref": "XYZ" } }
```

### Painting in Colab
1. Copy `out/render.png` and `out/meta.json` to Google Drive at `MyDrive/isometric-waterloo/`.
2. Upload `colab/paint_waterloo.ipynb` to Colab (File → Upload notebook) and pick the T4 GPU runtime.
3. Run the cells in order. The **style test** cell paints one window so you can tune the prompt first. The full run takes about
   1 minute per window (~40 windows at the default scale) and resumes from Drive if Colab disconnects.
4. Download `map.png` from Drive into `out/`. The viewer shows it automatically (it falls back to the whitebox when `map.png` is missing).

The notebook is generated from `colab/make_notebook.py`. Edit that file, then run `npm run notebook`.

## Credits
Map data © OpenStreetMap contributors (ODbL). Approach inspired by Andy Coenen's isometric.nyc write-up.
