// follow.js: click a bus, ION train or car and the camera rides along with it.
// A glass card (bottom-right, where the building card lives) shows the route, next stop and speed;
// a soft gold ring pulses on the ground under the vehicle. Esc, drag, scroll or clicking elsewhere lets go.
onApp((app) => {
  const L = window.mapLife;
  if (!L?.poseOf || !L.vehicleAt) return;
  const { viewer } = app, vp = viewer.viewport;

  document.head.insertAdjacentHTML('beforeend', `<style>
    #follow { right: 16px; bottom: calc(40px + var(--safe-b)); width: 300px; max-width: calc(100vw - 32px); padding: var(--sp-4); border-radius: var(--r-panel); z-index: 3; display: none; }
    #follow.show { display: block; animation: rise .22s ease-out; }
    #follow .kick i { width: 7px; height: 7px; border-radius: 50%; background: var(--gold); box-shadow: 0 0 0 0 rgba(254, 211, 76, .7); animation: fpulse 1.6s infinite; }
    @keyframes fpulse { 70% { box-shadow: 0 0 0 6px rgba(254, 211, 76, 0); } 100% { box-shadow: 0 0 0 0 rgba(254, 211, 76, 0); } }
    #follow .hd { display: flex; align-items: center; gap: 8px; margin: 7px 28px 0 0; }
    #follow .hd img { height: 20px; width: auto; flex: none; }
    #follow .hd .rb { flex: none; min-width: 30px; padding: 0 6px; border-radius: var(--r-tag); color: #fff; text-align: center; font: 11px/22px Silkscreen, monospace; box-shadow: inset 0 1px 0 rgba(255, 255, 255, .35); }
    #follow .hd .car { flex: none; width: 30px; height: 20px; }
    #follow h2 { margin: 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #follow .st { margin: 6px 0 0; font-size: var(--fs-body); }
    #follow dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 10px 0 0; font-size: var(--fs-meta); }
    #follow dt { color: var(--muted); }
    #follow dd { margin: 0; font-variant-numeric: tabular-nums; }
    @media (max-width: 600px) { #follow { left: 16px; right: 16px; width: auto; bottom: calc(52px + var(--safe-b)); } }
  </style>`);
  const card = document.createElement('div');
  card.id = 'follow'; card.className = 'chip';
  card.setAttribute('role', 'region'); card.setAttribute('aria-live', 'polite'); card.setAttribute('aria-label', 'Following a vehicle');
  card.innerHTML = `<button class="x" aria-label="Stop following" title="Stop following (Esc)">×</button>
    <div class="kick"><i></i><span>Following</span></div>
    <div class="hd"></div><p class="st"></p>
    <dl><dt>Speed</dt><dd class="sp"></dd><dt>Heading</dt><dd class="hg"></dd></dl>`;
  document.body.appendChild(card);
  const $c = (s) => card.querySelector(s);
  const hd = $c('.hd'), st = $c('.st'), sp = $c('.sp'), hg = $c('.hg');
  $c('.x').onclick = () => stop();
  const setText = (n, s) => { if (n._t !== s) { n._t = s; n.textContent = s; } };

  // compass from a heading vector (scene x east, y north)
  const DIRS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
  const compass = (hx, hy) => DIRS[Math.round(((Math.atan2(hx, hy) * 180) / Math.PI + 360) % 360 / 45) % 8];
  // road class (traffic.json edge cls) -> a friendly name; there are no street names in the road graph
  const ROAD = { 1: 'the main road', 2: 'a city street', 3: 'a campus road', 4: 'a lane' };
  const KIND = { car: 'Car', suv: 'SUV', van: 'Van' };
  const name = (v) => v.type === 'car' ? KIND[v.kind] || 'Car' : v.type === 'ion' ? 'The ION' : `Route ${v.route?.id || ''}`.trim();
  const carSvg = (c) => `<svg class="car" viewBox="0 0 30 20" aria-hidden="true"><path d="M4 13V9.5l3-4.5h14l4 4.5H27V13z" fill="${c}" stroke="rgba(0,0,0,.35)" stroke-width="1"/><path d="M9 6.3h5.5v3.2H7z M16 6.3h4.4l2.6 3.2H16z" fill="rgba(170,200,230,.85)"/><circle cx="9" cy="14" r="2.6" fill="#222"/><circle cx="22" cy="14" r="2.6" fill="#222"/></svg>`;

  let cur = null, raf = 0, last = 0, lastPose = null, off = null, zoomGoal = null, headKey = '';
  const pxPerM = () => L.api?.pxPerM || 1;

  function renderHead(v) {
    let key, html;
    if (v.type === 'car') {
      key = 'car' + v.color + v.kind;
      html = `${carSvg(v.color)}<h2>${app.esc(name(v))}</h2>`;
    } else {
      const i = L.cardInfo(v);
      key = i.logo + i.badge + i.title;
      html = `<img src="sprites/${i.logo}" alt="${i.logo.includes('go') ? 'GO' : i.logo.includes('ion') ? 'ION' : 'GRT'}">` +
        (i.badge ? `<span class="rb" style="background:${i.color}">${app.esc(i.badge)}</span>` : '') + `<h2>${app.esc(i.title)}</h2>`;
    }
    if (key !== headKey) { headKey = key; hd.innerHTML = html; }
  }
  function renderStatus(v, p) {
    const kmh = Math.round(Math.max(0, v.v || 0) * 3.6);
    const dir = compass(p.hx, p.hy);
    if (v.type === 'car') {
      const where = v.e?.aisle ? 'a parking lot' : ROAD[v.e?.cls] || 'the road';
      setText(st, kmh < 2 ? `Waiting on ${where}` : `Heading ${dir} on ${where}`);
    } else setText(st, L.cardInfo(v).sub);
    setText(sp, `${kmh} km/h` + (L.getTimeScale?.() > 1.5 ? ` · time-lapse ×${Math.round(L.getTimeScale())}` : ''));
    setText(hg, dir[0].toUpperCase() + dir.slice(1));
  }

  // where the camera should look: the vehicle's middle, half its height up
  const targetOf = (v, p) => { const [ix, iy] = app.sceneToImage(p.x, p.y, (v.H || 1.5) / 2); return vp.imageToViewportCoordinates(ix, iy); };

  function start(v) {
    const p = v && L.poseOf(v);
    if (!p) return false;
    app.stopTour?.();
    app.select(null);
    cur = v; lastPose = p; headKey = '';
    // camera offset from the vehicle, eased to zero; following the target directly means fast vehicles never drift off
    const t = targetOf(v, p), c = vp.getCenter(true);
    off = { x: c.x - t.x, y: c.y - t.y };
    const k = pxPerM();
    zoomGoal = k < 2.4 ? vp.getZoom(true) * (2.8 / k) : null; // too far out to see a car: move in
    renderHead(v); renderStatus(v, p);
    card.classList.add('show');
    last = performance.now();
    cancelAnimationFrame(raf); raf = requestAnimationFrame(tick);
    return true;
  }
  function stop(msg) {
    if (!cur) return;
    cur = null; lastPose = null; zoomGoal = null;
    cancelAnimationFrame(raf);
    card.classList.remove('show');
    if (msg) app.toast(msg);
  }

  let lastText = 0;
  function tick(now) {
    if (!cur) return;
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    const v = cur, p = L.poseOf(v);
    // off the map: a bus or train that finished its run, or a car that was respawned at a gate (a jump)
    if (!p) return stop(`${name(v)} left the map`);
    if (lastPose && Math.hypot(p.x - lastPose.x, p.y - lastPose.y) > 60 * Math.max(1, L.getTimeScale?.() || 1) * Math.max(dt, 1 / 60) + 40) return stop(`${name(v)} drove off the map`);
    if (app.getSelected?.()) return stop(); // a building got picked (search, tour, link): its card wins
    lastPose = p;
    const ease = app.reduceMotion ? 1 : 1 - Math.exp(-dt * 3.2);
    if (zoomGoal) {
      const z = vp.getZoom(true), nz = Math.exp(Math.log(z) + (Math.log(zoomGoal) - Math.log(z)) * ease);
      vp.zoomTo(nz, null, true);
      if (Math.abs(nz / zoomGoal - 1) < 0.01) zoomGoal = null;
    }
    off.x *= 1 - ease; off.y *= 1 - ease;
    const t = targetOf(v, p);
    vp.panTo(new OpenSeadragon.Point(t.x + off.x, t.y + off.y), true);
    if (now - lastText > 250) { lastText = now; renderHead(v); renderStatus(v, p); }
  }

  // ---- the ring on the ground: depth-sorted just behind the vehicle so it draws underneath it ----
  L.addLayer({
    collect(add, api) {
      const v = cur, p = v && L.poseOf(v);
      if (!p) return;
      const len = v.type === 'ion' ? api.ION_LEN : v.L || 4.5;
      // nudge the sort point away from the camera (up the screen) so the ring sorts before the vehicle itself
      const a = api.toScreen(p.x, p.y, 0), bx = api.toScreen(p.x + 1, p.y, 0), by = api.toScreen(p.x, p.y + 1, 0);
      const gx = bx[1] - a[1], gy = by[1] - a[1], gl = Math.hypot(gx, gy) || 1, back = len / 2 + 2;
      add(p.x - (gx / gl) * back, p.y - (gy / gl) * back, () => ring(api, v, p, len), null, {});
    },
  });
  let vehCtx = null;
  function ring(api, v, p, len) {
    const ctx = vehCtx || (vehCtx = document.getElementById('veh')?.getContext('2d')); // the life canvas: same context api.poly draws into
    if (!ctx) return;
    const t = performance.now() / 1000, pulse = app.reduceMotion ? 0.5 : (Math.sin(t * 3.4) + 1) / 2;
    const night = api.night || 0;
    const nx = -p.hy, ny = p.hx;
    const ellipse = (grow) => {
      const A = len / 2 + 1.6 + grow, B = (v.W || 1.9) / 2 + 1.6 + grow;
      const pts = [];
      for (let i = 0; i < 28; i++) {
        const th = (i / 28) * Math.PI * 2, c = Math.cos(th) * A, s = Math.sin(th) * B;
        pts.push(api.toScreen(p.x + p.hx * c + nx * s, p.y + p.hy * c + ny * s, 0.06));
      }
      api.poly(pts);
    };
    ctx.save();
    ellipse(0.4 + pulse * 0.8);
    ctx.fillStyle = `rgba(254,211,76,${(0.16 + 0.12 * (1 - pulse) + 0.1 * night).toFixed(3)})`;
    ctx.fill();
    ctx.lineWidth = Math.max(1.2, 0.35 * api.pxPerM);
    ctx.strokeStyle = `rgba(254,211,76,${(0.55 + 0.35 * (1 - pulse)).toFixed(3)})`;
    ctx.stroke();
    ellipse(1.6 + pulse * 2.2); // the expanding echo
    ctx.lineWidth = Math.max(1, 0.25 * api.pxPerM);
    ctx.strokeStyle = `rgba(254,211,76,${(0.45 * (1 - pulse)).toFixed(3)})`;
    ctx.stroke();
    ctx.restore();
  }

  // ---- clicks: a vehicle starts (or switches) following; anywhere else lets go ----
  app.clickHandlers.push((sx, sy) => {
    const v = L.isEnabled?.() !== false && L.vehicleAt(sx, sy);
    if (v && (v.type === 'bus' || v.type === 'ion' || v.type === 'car')) { if (v !== cur) start(v); return true; }
    if (cur) stop();
    return false; // let the click select a building as usual
  });
  viewer.addHandler('canvas-drag', () => stop());
  viewer.addHandler('canvas-scroll', () => stop());
  viewer.addHandler('canvas-pinch', () => stop());
  addEventListener('keydown', (e) => { if (e.key === 'Escape' && cur) stop(); });

  // ---- hover: a pointer (and a hint) over vehicles; buildings keep the tooltip otherwise ----
  const tip = document.getElementById('tip');
  let hoverQueued = false, hx = 0, hy = 0, cx = 0, cy = 0;
  viewer.canvas.addEventListener('mousemove', (e) => {
    const r = viewer.canvas.getBoundingClientRect();
    hx = e.clientX - r.left; hy = e.clientY - r.top; cx = e.clientX; cy = e.clientY;
    if (hoverQueued) return;
    hoverQueued = true;
    // run after OpenSeadragon's own move handler has set the building cursor and tooltip
    requestAnimationFrame(() => {
      hoverQueued = false;
      const v = L.isEnabled?.() !== false && L.vehicleAt(hx, hy);
      if (!v) return;
      viewer.canvas.style.cursor = 'pointer';
      if (tip) {
        tip.innerHTML = `${app.esc(v === cur ? 'Following' : v.type === 'car' ? name(v) : v.type === 'ion' ? 'ION' : name(v))} · <span style="color:var(--muted)">${v === cur ? 'Esc to stop' : 'click to follow'}</span>`;
        tip.style.display = 'block';
        tip.style.left = Math.min(cx + 14, innerWidth - tip.offsetWidth - 8) + 'px';
        tip.style.top = Math.min(cy + 14, innerHeight - tip.offsetHeight - 8) + 'px';
      }
    });
  });

  app.helpSection('Follow a vehicle', '<p>Click a bus, the ION or any car to ride along with it: the camera keeps it centred and the card shows its next stop and speed. Drag, scroll, press <kbd>Esc</kbd> or click elsewhere to let go.</p>');
  window.follow = { start, stop: () => stop(), current: () => cur };
});
