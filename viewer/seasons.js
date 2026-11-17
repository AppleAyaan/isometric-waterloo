// seasons.js: see campus in summer or winter. The painted map is summer imagery; winter is a per-pixel recolour
// of the day map's tiles (app.setTileFilter), so nothing new is downloaded by day: snow on the grass, roofs, lots
// and fields, bare grey-brown branches, frozen lakes; roads stay ploughed. At night the viewer swaps in a baked
// winter night map (out/night-winter.png, `npm run night -- --season winter`), made from this same recolour.
// (Spring and fall need a repaint of the map rather than a recolour, so they aren't offered yet.)
// "Auto" follows the date on the map clock (so the time-lapse and ?date= links change season too).
// Trees and lakes are the same blue-green in the imagery, so lakes come from OpenStreetMap: water.json holds
// the larger water areas, projected to map pixels (from data/scene.json with out/traffic.json's projection).

// The recolour itself, shared with scripts/night.mjs (which runs this file in a vm to get it).
// winterRecolour(rgba, w, h, { x0, y0, s, wm }): pixels of a w x h tile whose top-left is (x0, y0) in full-size
// map pixels at s map pixels per tile pixel; wm is an optional RGBA mask (alpha = water) of the same size.
(function (root) {
  const clamp = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
  // a cheap integer hash -> [0, 1) for a cell, so trees change in clumps rather than speckle
  const hash = (x, y, k) => { let h = (x * 374761393 + y * 668265263 + k * 1442695041) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); return ((h ^ (h >>> 16)) >>> 0) / 4294967296; };
  // smooth value noise in [0, 1): a hash per grid corner, blended across the cell
  function vnoise(x, y, cell, k) {
    const gx = x / cell, gy = y / cell, ix = Math.floor(gx), iy = Math.floor(gy);
    let fx = gx - ix, fy = gy - iy; fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = hash(ix, iy, k), b = hash(ix + 1, iy, k), c = hash(ix, iy + 1, k), e = hash(ix + 1, iy + 1, k);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + e) * fx * fy;
  }
  root.winterRecolour = function (d, w, h, { x0, y0, s, wm }) {
    for (let j = 0; j < h; j++) {
      const Y = y0 + j * s;
      for (let i = 0; i < w; i++) {
        const o = (j * w + i) * 4;
        if (d[o + 3] === 0) continue;
        const r = d[o], g = d[o + 1], b = d[o + 2];
        const lum = (0.3 * r + 0.59 * g + 0.11 * b) / 255;
        const mx = Math.max(r, g, b), sat = mx ? (mx - Math.min(r, g, b)) / mx : 0;
        const wet = wm ? wm[o + 3] / 255 : 0;
        // vegetation: green well above red. Trees are the darker, bluer canopy; grass is lighter and yellower.
        // Shaded walls and glass are blue-grey with g - r just as high, but their green sits midway between red
        // and blue, so green must also stand above the red/blue average.
        const veg = clamp((g - r - 10) / 12) * clamp((g - (r + b) / 2 - 5) / 4) * (1 - wet);
        let R = r, G = g, B = b;
        const mixTo = (c, k) => { R += (c[0] - R) * k; G += (c[1] - G) * k; B += (c[2] - B) * k; };
        const sn = 214 + 36 * lum, SNOW = [sn - 6, sn - 1, sn + 7];
        if (wet > 0) mixTo([198 + 32 * lum, 214 + 26 * lum, 228 + 22 * lum], wet * 0.9);
        if (veg > 0) {
          const tree = clamp((b - g + 14) / 14) * 0.5 + clamp((0.48 - lum) / 0.12) * 0.5;
          // bare (or evergreen, in broad stands) canopy in grey-brown / dark green, with snow on its lit tops
          const ever = clamp((0.3 - vnoise(x0 + i * s, Y, 120, 3)) / 0.12), L = lum * 255;
          mixTo(ever ? [L * 0.62, L * 0.82, L * 0.74] : [L * 0.95 + 8, L * 0.88 + 6, L * 0.84 + 6], veg * tree * 0.85);
          mixTo(SNOW, veg * tree * clamp((lum - 0.3) / 0.14) * 0.85);
          mixTo(SNOW, veg * (1 - tree) * 0.92); // snow on the grass
        }
        // pale flat surfaces (roofs, lots, plazas) and bare earth under snow; mid-grey roads stay ploughed
        const pale = sat < 0.18 && lum > 0.6 ? clamp((lum - 0.6) / 0.1) * 0.75 : 0;
        const earth = r > g && g >= b && sat > 0.1 && lum > 0.42 ? 0.55 : 0;
        if ((pale || earth) && !wet) mixTo(SNOW, Math.max(pale, earth) * (1 - veg));
        d[o] = R; d[o + 1] = G; d[o + 2] = B;
      }
    }
  };
})(typeof self !== 'undefined' ? self : globalThis);

onApp((app) => {
  const SEASONS = ['auto', 'summer', 'winter'];

  // lakes and ponds, as polygons in full-resolution map pixels
  let water = [];
  fetch('water.json').then((r) => (r.ok ? r.json() : [])).then((w) => {
    water = w.map(({ o, h }) => {
      const xs = o.filter((_, i) => i % 2 === 0), ys = o.filter((_, i) => i % 2 === 1);
      return { o, h, box: [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)] };
    });
    applied = null; apply();
  }).catch(() => {});
  // which pixels of a tile are water: the polygons drawn into a small mask canvas
  function waterMask(w, h, x0, y0, s) {
    const x1 = x0 + w * s, y1 = y0 + h * s, hit = water.filter(({ box: b }) => b[0] < x1 && b[2] > x0 && b[1] < y1 && b[3] > y0);
    if (!hit.length) return null;
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.setTransform(1 / s, 0, 0, 1 / s, -x0 / s, -y0 / s);
    g.beginPath();
    for (const { o, h: holes } of hit) for (const ring of [o, ...holes]) { g.moveTo(ring[0], ring[1]); for (let i = 2; i < ring.length; i += 2) g.lineTo(ring[i], ring[i + 1]); g.closePath(); }
    g.fill('evenodd');
    return g.getImageData(0, 0, w, h).data;
  }

  // (night tiles come from the baked winter night map instead, so they're left as they are)
  const filterFor = (season) => (season === 'winter'
    ? (d, w, h, { night, x0, y0, s }) => (night ? false : winterRecolour(d, w, h, { x0, y0, s, wm: waterMask(w, h, x0, y0, s) }))
    : null);

  // ---- the setting
  const params = new URLSearchParams(location.search);
  let choice = SEASONS.includes(params.get('season')) ? params.get('season') : app.store.get('season') || 'auto';
  if (!SEASONS.includes(choice)) choice = 'auto';
  // Waterloo seasons by date: snow Dec to mid-March, the summer map the rest of the year
  function bySeason(t) {
    const L = app.campus?.local?.(t), m = L ? L.mo * 100 + L.d : (t.getMonth() + 1) * 100 + t.getDate();
    return m >= 1201 || m < 316 ? 'winter' : 'summer';
  }
  const current = () => (choice === 'auto' ? bySeason(app.now()) : choice);
  let applied = null;
  function apply() {
    const s = current();
    if (s === applied) return;
    applied = s;
    app.setTileFilter(filterFor(s));
    app.setNightVariant?.(s === 'winter' && app.nightInfo?.variants?.includes('winter') ? 'winter' : null);
    document.documentElement.dataset.season = s;
    btn.dataset.season = s;
    paintMenu();
  }

  // control: a button in the right-hand bar that opens a small glass picker beside it
  const ICON = {
    auto: '<path d="M3 12a9 9 0 1 0 9-9"/><path d="M3 4v5h5"/><path d="M12 8v4l3 2"/>',
    summer: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    winter: '<path d="M12 2v20M3.3 7l17.4 10M3.3 17 20.7 7"/><path d="m9 4 3 2 3-2M9 20l3-2 3 2"/>',
  };
  const svg = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[k]}</svg>`;
  const NAME = { auto: 'Auto', summer: 'Summer', winter: 'Winter' };
  const css = document.createElement('style');
  css.textContent = `
    #season .ic { display: none; } ${SEASONS.filter((k) => k !== 'auto').map((k) => `#season[data-season=${k}] .ic-${k}`).join(', ')} { display: block; }
    #seasonmenu { z-index: 4; display: none; gap: 2px; padding: 5px; }
    #seasonmenu.open { display: flex; animation: rise .18s ease-out; }
    #seasonmenu button { display: flex; flex-direction: column; align-items: center; gap: 3px; min-width: 54px; padding: 7px 6px 6px; border: 0; border-radius: var(--r-ctl); background: none; color: var(--ink); font-size: var(--fs-meta); font-weight: 500; cursor: pointer; transition: background .15s; }
    #seasonmenu button:hover { background: var(--hover); }
    #seasonmenu button svg { width: 18px; height: 18px; color: var(--gold-deep); }
    #seasonmenu button[aria-checked=true] { background: var(--gold); color: #1f1c17; }
    #seasonmenu button[aria-checked=true] svg { color: #1f1c17; }
    #seasonmenu small { font-size: 10px; color: var(--muted); margin-top: -2px; }
    #seasonmenu button[aria-checked=true] small { color: #5b4a10; }
  `;
  document.head.appendChild(css);
  const btn = document.createElement('button');
  btn.id = 'season'; btn.title = 'Season'; btn.setAttribute('aria-label', 'Season'); btn.setAttribute('aria-haspopup', 'true');
  btn.innerHTML = SEASONS.filter((k) => k !== 'auto').map((k) => svg(k).replace('<svg', `<svg class="ic ic-${k}"`)).join('');
  app.addControl(btn);
  const menu = document.createElement('div');
  menu.id = 'seasonmenu'; menu.className = 'chip'; menu.setAttribute('role', 'radiogroup'); menu.setAttribute('aria-label', 'Season');
  menu.innerHTML = SEASONS.map((k) => `<button role="radio" data-s="${k}">${svg(k)}<span>${NAME[k]}</span>${k === 'auto' ? '<small></small>' : ''}</button>`).join('');
  document.body.appendChild(menu);
  function paintMenu() {
    for (const b of menu.querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.s === choice));
    menu.querySelector('small').textContent = NAME[bySeason(app.now())];
    btn.title = `Season: ${NAME[current()]}${choice === 'auto' ? ' (follows the date)' : ''}`;
  }
  function place() {
    const r = btn.getBoundingClientRect(), m = menu.getBoundingClientRect();
    menu.style.top = Math.round(Math.max(8, r.top + r.height / 2 - m.height / 2)) + 'px';
    menu.style.left = Math.round(Math.max(8, r.left - m.width - 10)) + 'px';
  }
  const open = (on) => { menu.classList.toggle('open', on); btn.classList.toggle('on', on); btn.setAttribute('aria-expanded', String(on)); if (on) { place(); paintMenu(); } };
  btn.onclick = (e) => { e.stopPropagation(); open(!menu.classList.contains('open')); };
  menu.onclick = (e) => {
    const b = e.target.closest('button[data-s]');
    if (!b) return;
    choice = b.dataset.s; app.store.set('season', choice);
    apply(); paintMenu();
    app.toast(choice === 'auto' ? `Season follows the date: ${NAME[current()].toLowerCase()}` : `${NAME[choice]} on campus`);
  };
  document.addEventListener('pointerdown', (e) => { if (menu.classList.contains('open') && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) open(false); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') open(false); });
  addEventListener('resize', () => menu.classList.contains('open') && place());

  app.onTick(() => { if (choice === 'auto') apply(); });
  app.on('timechange', () => { if (choice === 'auto') apply(); });
  apply();

  app.helpSection('Seasons', `<p>The season button on the right picks summer or a snowy winter with frozen lakes.
    <b>Auto</b> follows the date on the map clock, so the time-lapse and links like <code>?date=2027-01-15T12:00</code> change it too. Or add <code>?season=winter</code> to a link.</p>`);
});
