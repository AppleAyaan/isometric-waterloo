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
| 5. View | `npm run serve` → http://localhost:8080 | |
| 6. Deploy | `npm run site` → upload `site/` to GitHub Pages or Cloudflare Pages | |

Setup: `npm install` (export uses your installed Google Chrome via Playwright).

### Google Photorealistic 3D Tiles (the Tiny Toronto look)
1. In Google Cloud Console, create a project, enable the **Map Tiles API**, and create an API key.
2. Save the key in `.google-maps-key` in the project root (git-ignored).
3. `npm run export -- --source google` renders `out/photo.png` with the same camera as the whitebox, so hover and search still line up.
4. In Colab, choose the **painted** style with `INPUT = photo.png` to turn the photo render into a clean illustrated map.

Google's Map Tiles API terms restrict storing and redistributing its imagery. Check them before publishing a site built from `photo.png` or `map.png`.

### Changing the area
`BBOX="south,west,north,east" npm run fetch && npm run scene && npm run export`

### Fixing building heights
OSM heights are sometimes missing or wrong. Add overrides to `data/overrides.json`, keyed by building code or OSM id:
```json
{ "LIB": { "height": 40 }, "way/123456": { "name": "Better name" } }
```

### Painting in Colab
1. Copy `out/render.png` and `out/meta.json` to Google Drive at `MyDrive/isometric-waterloo/`.
2. Upload `colab/paint_waterloo.ipynb` to Colab (File → Upload notebook) and pick the T4 GPU runtime.
3. Run the cells in order. The **style test** cell paints one window so you can tune the prompt first. The full run takes about
   1 minute per window (~40 windows at the default scale) and resumes from Drive if Colab disconnects.
4. Download `map.png` from Drive into `out/`. The viewer picks it up automatically and gets a painted/whitebox toggle.

The notebook is generated from `colab/make_notebook.py`. Edit that file, then run `npm run notebook`.

## Credits
Map data © OpenStreetMap contributors (ODbL). Approach inspired by Andy Coenen's isometric.nyc write-up.
