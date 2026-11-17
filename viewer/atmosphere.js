// atmosphere.js: the sky around and over the map.
//  - a backdrop behind the map (its empty paper is see-through, see index.html): pale sky blue on a clear day,
//    greyer under cloud, deep indigo with twinkling stars at night, kept in lockstep with the night map fade
//  - now and then a flock of birds or a plane (with a contrail by day, blinking lights by night) crosses over
onApp((app) => {
  const { viewer, reduceMotion } = app;
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const sstep = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };
  const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);
  const rgb = (c, a = 1) => `rgba(${c.map(Math.round).join(',')},${a})`;
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---------------------------------------------------------------------------------------------------------
  // layers: the backdrop goes under the map; the cloud canvas over the map and the weather, under the chips
  const css = document.createElement('style');
  css.textContent = `
    #atmo-sky, #atmo-sky div, #atmo-sky canvas, #atmo { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; }
    #atmo-night { opacity: var(--map-night, 0); }
  `;
  document.head.appendChild(css);
  const sky = document.createElement('div'), dayBg = document.createElement('div'), nightBg = document.createElement('div'), stars = document.createElement('canvas');
  sky.id = 'atmo-sky'; dayBg.id = 'atmo-day'; nightBg.id = 'atmo-night';
  for (const e of [sky, stars]) e.setAttribute('aria-hidden', 'true');
  nightBg.append(stars); sky.append(dayBg, nightBg);
  document.body.insertBefore(sky, document.getElementById('map'));
  const cv = document.createElement('canvas');
  cv.id = 'atmo'; cv.setAttribute('aria-hidden', 'true');
  document.body.insertBefore(cv, document.getElementById('vcards'));
  const ctx = cv.getContext('2d'), sctx = stars.getContext('2d');

  const PAPER = hex(app.meta?.background || '#f3eee4'), NIGHT = hex(app.nightInfo?.background || '#1c1930');
  const night = () => app.getNightLevel();
  // how overcast it looks, 0..1
  function overcast() {
    const w = app.weather;
    if (!w) return 0.2;
    if (w.kind === 'storm') return 1;
    if (w.kind === 'rain' || w.kind === 'snow' || w.kind === 'fog') return 0.95;
    return clamp((w.cloudCover ?? 0) / 100);
  }

  // ---------------------------------------------------------------------------------------------------------
  // 1. the backdrop. Day: sky at the top fading into the paper at the bottom. Night: indigo, a faint moon glow.
  function paintBackdrop() {
    const oc = overcast(), storm = app.weather?.kind === 'storm' ? 1 : 0;
    const top = mix(mix([196, 220, 238], [212, 217, 224], oc), [176, 182, 194], storm), mid = mix(mix([228, 236, 238], [230, 231, 228], oc), PAPER, 0.25);
    dayBg.style.background = `linear-gradient(180deg, ${rgb(top)} 0%, ${rgb(mid)} 42%, ${rgb(PAPER)} 78%)`;
    const ntop = mix([10, 9, 28], [24, 23, 38], oc);
    nightBg.style.background = `radial-gradient(ellipse 40% 30% at 84% 6%, rgba(190,190,255,${(0.13 * (1 - oc)).toFixed(3)}), transparent 70%), linear-gradient(180deg, ${rgb(ntop)} 0%, ${rgb(mix(ntop, NIGHT, 0.6))} 45%, ${rgb(NIGHT)} 85%)`;
  }

  // stars: fixed to the screen (they're at infinity), denser toward the top, hidden by heavy cloud
  let starList = [];
  function makeStars() {
    const n = Math.round((W * H) / 5200);
    starList = Array.from({ length: n }, () => {
      const y = Math.pow(Math.random(), 1.6) * H;
      return { x: Math.random() * W, y, r: Math.random() < 0.08 ? 1.6 : Math.random() < 0.4 ? 1.1 : 0.7, a: rand(0.35, 0.95), p: Math.random() * 6.28, f: rand(0.6, 2.2), c: Math.random() < 0.15 ? '255,236,200' : Math.random() < 0.2 ? '200,215,255' : '255,255,255' };
    });
  }
  function drawStars(t) {
    sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    sctx.clearRect(0, 0, W, H);
    const k = (1 - 0.85 * overcast()) * sstep(0.3, 0.9, night());
    if (k < 0.02) return;
    for (const s of starList) {
      const tw = reduceMotion ? 1 : 0.65 + 0.35 * Math.sin(t * 0.001 * s.f + s.p);
      sctx.fillStyle = `rgba(${s.c},${(s.a * tw * k).toFixed(3)})`;
      sctx.fillRect(s.x - s.r / 2, s.y - s.r / 2, s.r, s.r);
    }
  }

  // ---------------------------------------------------------------------------------------------------------
  // 2. scene helpers for the fly-overs
  const PROJ = app.life?.projection || [[1, 0, 0, 0], [0, -1, -1, 0]];
  const [PX, PY] = PROJ;
  const MPX = app.meta?.scale || 3; // image px per metre
  const iw = app.meta?.width || 7168, ih = app.meta?.height || 3584;
  const corners = [[0, 0], [iw, 0], [0, ih], [iw, ih]].map(([x, y]) => app.imageToScene(x, y));
  const GB = app.life?.bounds || { minX: Math.min(...corners.map((c) => c[0])), maxX: Math.max(...corners.map((c) => c[0])), minY: Math.min(...corners.map((c) => c[1])), maxY: Math.max(...corners.map((c) => c[1])) };
  // scene metres -> screen (CSS px), affine, from the projection and the current zoom
  function sceneMatrix() {
    const [ox, oy] = app.imageToScreen(0, 0), [sx] = app.imageToScreen(1000, 0), s = (sx - ox) / 1000;
    return [s * PX[0], s * PY[0], s * PX[1], s * PY[1], ox + s * PX[3], oy + s * PY[3], s * PX[2], s * PY[2], s * MPX];
  }

  // ---------------------------------------------------------------------------------------------------------
  // 3. fly-overs: a V of birds by day, a plane any time. They fly in scene metres, so they pan
  // and zoom with the map; their drawn size grows with the zoom.
  let flock = null, plane = null, nextFlock = performance.now() + rand(6000, 20000), nextPlane = performance.now() + rand(15000, 40000);
  const GCX = (GB.minX + GB.maxX) / 2, GCY = (GB.minY + GB.maxY) / 2, REACH = Math.hypot(GB.maxX - GB.minX, GB.maxY - GB.minY) / 2 + 500;
  function launch(v, alt) {
    // come in from beyond campus on a random heading, passing somewhere over it
    const a = Math.random() * 6.28, hx = Math.cos(a), hy = Math.sin(a), side = rand(-0.5, 0.5) * REACH;
    return { x: GCX - hx * REACH - hy * side, y: GCY - hy * REACH + hx * side, hx, hy, v, alt, gone: 0 };
  }
  // devtools / demo: app.flyover('plane') or app.flyover('birds') sends one over now
  app.flyover = (what = 'plane') => { if (what === 'birds') { flock = null; nextFlock = 0; } else { plane = null; nextPlane = 0; } };
  const fly = (o, dt) => { o.x += o.hx * o.v * dt; o.y += o.hy * o.v * dt; o.gone += o.v * dt; return o.gone > REACH * 2.2; };
  function flyovers(t, dt, M, k) {
    const w = app.weather, n = night();
    const rough = w && (w.kind === 'storm' || ((w.kind === 'rain' || w.kind === 'snow') && w.intensity > 0.6));
    if (!flock && t > nextFlock) {
      nextFlock = t + rand(30000, 75000);
      if (n < 0.4 && !rough) {
        const m = 5 + Math.floor(Math.random() * 5);
        flock = { ...launch(rand(36, 50), 45), birds: Array.from({ length: m }, (_, i) => ({ k: Math.ceil(i / 2) * (i % 2 ? 1 : -1), p: Math.random() * 6.28, j: rand(-5, 5) })) };
      }
    }
    if (!plane && t > nextPlane) {
      nextPlane = t + rand(45000, 110000);
      if (w?.kind !== 'storm') plane = { ...launch(rand(60, 80), 220), trail: [], lastDot: 0 };
    }
    // scene point (h metres up) -> screen, and a heading's direction on screen
    const P = (x, y, h) => [M[0] * x + M[2] * y + M[4] + M[6] * h, M[1] * x + M[3] * y + M[5] + M[7] * h];
    const dir = (o) => { const dx = M[0] * o.hx + M[2] * o.hy, dy = M[1] * o.hx + M[3] * o.hy, l = Math.hypot(dx, dy) || 1; return [dx / l, dy / l]; };
    if (plane) {
      const done = fly(plane, dt);
      if (t - plane.lastDot > 250) { plane.trail.push([plane.x, plane.y, t]); plane.lastDot = t; }
      while (plane.trail.length && t - plane.trail[0][2] > 14000) plane.trail.shift();
      drawPlane(plane, t, n, P, dir(plane), k);
      if (done) plane = null;
    }
    if (flock) {
      const done = fly(flock, dt);
      drawFlock(flock, t, P(flock.x, flock.y, flock.alt), dir(flock), k);
      if (done) flock = null;
    }
  }
  function drawFlock(f, t, [fx, fy], [dx, dy], k) {
    // a loose V: each bird trails behind the leader and off to one side, wings beating out of step
    const bx = -dx, by = -dy, px = -dy, py = dx;
    ctx.lineWidth = 1.4 * Math.sqrt(k); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(46,44,58,.78)';
    ctx.beginPath();
    for (const b of f.birds) {
      const back = Math.abs(b.k) * 14 * k, side = b.k * 13 * k;
      const x = fx + bx * back + px * side + Math.sin(t * 0.0007 + b.p) * 2 * k, y = fy + by * back + py * side + b.j * k;
      const flap = Math.sin(t * 0.012 + b.p) * 3 * k, s = 5.5 * k;
      ctx.moveTo(x - s, y - flap); ctx.quadraticCurveTo(x - s * 0.45, y - 2 * k - flap * 0.4, x, y); ctx.quadraticCurveTo(x + s * 0.45, y - 2 * k - flap * 0.4, x + s, y - flap);
    }
    ctx.stroke();
  }
  function drawPlane(p, t, n, P, [dx, dy], k) {
    // contrail by day: two thin lines spreading and fading behind the plane
    if (n < 0.6 && p.trail.length > 1) {
      const px = -dy, py = dx;
      for (const side of [-1, 1]) {
        for (let i = 1; i < p.trail.length; i++) {
          const [x0, y0, t0] = p.trail[i - 1], [x1, y1] = p.trail[i], age = (t - t0) / 14000, spread = (2 + age * 6) * k;
          const [a0, b0] = P(x0, y0, p.alt), [a1, b1] = P(x1, y1, p.alt);
          ctx.strokeStyle = `rgba(255,255,255,${(0.55 * (1 - age) * (1 - n)).toFixed(3)})`;
          ctx.lineWidth = (1.2 + age * 4) * k;
          ctx.beginPath(); ctx.moveTo(a0 + px * side * spread, b0 + py * side * spread); ctx.lineTo(a1 + px * side * spread, b1 + py * side * spread); ctx.stroke();
        }
      }
    }
    const [x, y] = P(p.x, p.y, p.alt);
    ctx.save();
    ctx.translate(x, y); ctx.rotate(Math.atan2(dy, dx)); ctx.scale(k, k);
    const body = n > 0.5 ? 'rgba(70,72,100,.9)' : '#f4f6fa', edge = n > 0.5 ? 'rgba(20,20,40,.6)' : 'rgba(90,100,120,.7)';
    ctx.fillStyle = body; ctx.strokeStyle = edge; ctx.lineWidth = 0.8;
    ctx.beginPath(); // fuselage, wings, tailplane (pointing +x)
    ctx.moveTo(9, 0); ctx.lineTo(6, -1.2); ctx.lineTo(1.5, -1.2); ctx.lineTo(-2, -8); ctx.lineTo(-4, -8); ctx.lineTo(-2.5, -1.2);
    ctx.lineTo(-7, -1.2); ctx.lineTo(-9, -4); ctx.lineTo(-10, -4); ctx.lineTo(-9.2, 0);
    ctx.lineTo(-10, 4); ctx.lineTo(-9, 4); ctx.lineTo(-7, 1.2); ctx.lineTo(-2.5, 1.2); ctx.lineTo(-4, 8); ctx.lineTo(-2, 8); ctx.lineTo(1.5, 1.2); ctx.lineTo(6, 1.2);
    ctx.closePath(); ctx.fill(); ctx.stroke();
    if (n > 0.3) { // navigation lights: red on the left wingtip, green on the right, a white strobe
      const dot = (x, y, c, r) => { ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fill(); };
      dot(-3, -8, 'rgba(255,70,70,.95)', 1.3); dot(-3, 8, 'rgba(80,255,140,.95)', 1.3);
      if (t % 1300 < 110) { dot(-1, 0, 'rgba(255,255,255,.95)', 2.4); dot(-1, 0, 'rgba(255,255,255,.25)', 6); }
    }
    ctx.restore();
  }

  // ---------------------------------------------------------------------------------------------------------
  // the frame
  let W = 0, H = 0, dpr = 1;
  function size() {
    dpr = Math.min(2, window.devicePixelRatio || 1); W = innerWidth; H = innerHeight;
    for (const c of [cv, stars]) { c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); }
    makeStars(); kick();
  }
  addEventListener('resize', size);

  let raf = 0, last = 0;
  function kick() { if (!raf) raf = requestAnimationFrame(frame); }
  viewer.addHandler('update-viewport', () => { if (reduceMotion) kick(); });
  function frame(t) {
    raf = 0;
    const dt = Math.min(0.1, last ? (t - last) / 1000 : 0.016); last = t;
    drawStars(t);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    const M = sceneMatrix(), n = night();
    if (!reduceMotion) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      flyovers(t, dt, M, viewer.viewport.getZoom(true) / viewer.viewport.getHomeZoom());
      raf = requestAnimationFrame(frame);
    }
  }

  // the backdrop follows the clock and the weather
  const restyle = () => { paintBackdrop(); if (reduceMotion) kick(); };
  app.onTick(restyle);
  app.on('weather', restyle);
  paintBackdrop();
  size();

  app.helpSection('Sky', `<p>The sky around campus follows the time and the weather: pale blue on a clear day, grey under cloud,
    and stars on a clear night. Every so often a flock of birds or a plane passes over.</p>`);
});
