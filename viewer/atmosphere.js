// atmosphere.js: the sky around and over the map.
//  - a backdrop behind the map (its empty paper is see-through, see index.html): pale sky blue on a clear day,
//    greyer under cloud, deep indigo with twinkling stars at night, kept in lockstep with the night map fade
//  - puffy clouds drifting over campus with the live wind, more and greyer as the weather turns, tinted by
//    golden hour and moonlight, each casting a soft shadow on the ground; they thin out as you zoom in
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
  // golden hour, as sky.js grades the map (the clouds sit above that grade, so they tint themselves)
  const golden = (el) => sstep(9, 2, el) * sstep(-5, -0.5, el);
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
  // 2. clouds. Each is a little stack of puffs with a flat base, pre-drawn per colour scheme into a sprite.
  const SW = 360, SH = 180, BASE = 0.7; // sprite size (px) and where the flat base sits (fraction of height)
  let seed = 4242;
  const srnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const SHAPES = Array.from({ length: 6 }, () => {
    const puffs = [], n = 4 + Math.floor(srnd() * 3);
    for (let i = 0; i < n; i++) puffs.push([0.16 + (0.68 * i) / (n - 1) + (srnd() - 0.5) * 0.04, BASE - 0.1 - srnd() * 0.06, 0.1 + srnd() * 0.05]);
    const tops = 1 + Math.floor(srnd() * 3);
    for (let i = 0; i < tops; i++) puffs.push([0.3 + srnd() * 0.4, BASE - 0.28 - srnd() * 0.1, 0.15 + srnd() * 0.07]);
    return puffs;
  });
  const shapePath = (g, puffs, grow = 0, dy = 0, scale = 1) => {
    g.beginPath();
    for (const [x, y, r] of puffs) { g.moveTo(x * SW + (r * SW * scale + grow), y * SH + dy); g.arc(x * SW, y * SH + dy, r * SW * scale + grow, 0, 7); }
  };
  function cloudSprite(puffs, P) {
    const c = document.createElement('canvas'), q = 2; c.width = SW * q; c.height = SH * q;
    const g = c.getContext('2d'); g.scale(q, q);
    const base = BASE * SH;
    // outline, then the shaded body, cut flat at the base
    g.save(); g.beginPath(); g.rect(0, 0, SW, base + 2.5); g.clip();
    shapePath(g, puffs, 2.5); g.fillStyle = P.line; g.fill();
    g.restore();
    g.save(); g.beginPath(); g.rect(0, 0, SW, base); g.clip();
    shapePath(g, puffs); g.fillStyle = P.shade; g.fill();
    // lit tops (the same puffs nudged up, kept inside the body) and a soft highlight
    g.globalCompositeOperation = 'source-atop';
    shapePath(g, puffs, 0, -SH * 0.07, 0.94); g.fillStyle = P.body; g.fill();
    shapePath(g, puffs, 0, -SH * 0.12, 0.62); g.fillStyle = P.hi; g.fill();
    g.fillStyle = P.belly; g.fillRect(0, base - SH * 0.05, SW, SH * 0.05);
    g.restore();
    return c;
  }
  // the shadow on the ground: soft dark blobs in the same arrangement
  function shadowSprite(puffs) {
    const c = document.createElement('canvas'); c.width = SW; c.height = SW / 2;
    const g = c.getContext('2d');
    for (const [x, , r] of puffs) {
      const cx = x * SW, cy = SW / 4, rr = r * SW * 1.35;
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
      gr.addColorStop(0, 'rgba(20,24,44,.5)'); gr.addColorStop(0.55, 'rgba(20,24,44,.3)'); gr.addColorStop(1, 'rgba(20,24,44,0)');
      g.fillStyle = gr; g.beginPath(); g.arc(cx, cy, rr, 0, 7); g.fill();
    }
    return c;
  }
  const SHADOWS = SHAPES.map(shadowSprite);

  // colour scheme from the weather, the sun and the night level; sprites are redrawn only when it changes
  let sprites = [], paletteKey = '';
  function palette() {
    const oc = overcast(), storm = app.weather?.kind === 'storm' ? 1 : 0, n = night(), gold = golden(app.sunElevation(app.now())) * (1 - n);
    let body = mix([255, 255, 255], [212, 216, 224], oc), shade = mix([214, 224, 238], [156, 164, 180], oc);
    body = mix(body, [196, 200, 210], storm); shade = mix(shade, [128, 134, 150], storm);
    body = mix(body, [255, 214, 186], gold * 0.8); shade = mix(shade, [214, 160, 184], gold * 0.75);
    body = mix(body, [104, 104, 146], n); shade = mix(shade, [58, 56, 94], n);
    const hi = mix(body, [255, 255, 255], 0.45 * (1 - n)), belly = mix(shade, [90, 96, 120], 0.25), line = mix(shade, [40, 44, 70], 0.55);
    const q = (c) => c.map((v) => Math.round(v / 6) * 6);
    return { body: rgb(q(body)), shade: rgb(q(shade)), hi: rgb(q(hi), 0.7), belly: rgb(q(belly), 0.5), line: rgb(q(line), 0.55) };
  }
  function refreshSprites() {
    const P = palette(), key = JSON.stringify(P);
    if (key === paletteKey) return;
    paletteKey = key;
    sprites = SHAPES.map((s) => cloudSprite(s, P));
  }

  // clouds live in scene metres at altitude and wrap around campus, drifting with the wind
  const PROJ = app.life?.projection || [[1, 0, 0, 0], [0, -1, -1, 0]];
  const [PX, PY] = PROJ;
  const MPX = app.meta?.scale || 3; // image px per metre
  const iw = app.meta?.width || 7168, ih = app.meta?.height || 3584;
  const corners = [[0, 0], [iw, 0], [0, ih], [iw, ih]].map(([x, y]) => app.imageToScene(x, y));
  const GB = app.life?.bounds || { minX: Math.min(...corners.map((c) => c[0])), maxX: Math.max(...corners.map((c) => c[0])), minY: Math.min(...corners.map((c) => c[1])), maxY: Math.max(...corners.map((c) => c[1])) };
  const X0 = GB.minX - 450, X1 = GB.maxX + 450, Y0 = GB.minY - 450, Y1 = GB.maxY + 450;
  const CLOUDS = Array.from({ length: 18 }, (_, i) => ({ x: X0 + srnd() * (X1 - X0), y: Y0 + srnd() * (Y1 - Y0), alt: 80 + srnd() * 60, r: 110 + srnd() * 110, s: i % SHAPES.length, flip: srnd() < 0.5, vis: 0 }));
  function cloudCount() {
    const w = app.weather;
    if (!w) return 5;
    if (w.kind === 'storm') return 18;
    if (w.kind === 'rain' || w.kind === 'snow') return 15;
    if (w.kind === 'fog') return 4;
    const c = clamp((w.cloudCover ?? 0) / 100);
    return c < 0.15 ? 3 : Math.round(3 + 9 * c);
  }
  // scene metres -> screen (CSS px), affine, from the projection and the current zoom
  function sceneMatrix() {
    const [ox, oy] = app.imageToScreen(0, 0), [sx] = app.imageToScreen(1000, 0), s = (sx - ox) / 1000;
    return [s * PX[0], s * PY[0], s * PX[1], s * PY[1], ox + s * PX[3], oy + s * PY[3], s * PX[2], s * PY[2], s * MPX];
  }
  function wind() {
    const w = app.weather, d = (((w?.windDir ?? 250) + 180) * Math.PI) / 180;
    return { ex: Math.sin(d), ny: Math.cos(d), kmh: w?.wind ?? 12 };
  }

  // ---------------------------------------------------------------------------------------------------------
  // 3. fly-overs, in screen space: a V of birds by day, a plane any time
  let flock = null, plane = null, nextFlock = performance.now() + rand(6000, 20000), nextPlane = performance.now() + rand(15000, 40000);
  function launch(speed) {
    // enter from a random side, heading roughly across the screen
    const a = rand(-0.45, 0.45) + (Math.random() < 0.5 ? 0 : Math.PI), dx = Math.cos(a), dy = Math.sin(a);
    const x = dx > 0 ? -60 : W + 60, y = rand(0.15, 0.8) * H;
    return { x, y, dx, dy, v: speed };
  }
  function flyovers(t, dt) {
    const w = app.weather, n = night();
    const rough = w && (w.kind === 'storm' || ((w.kind === 'rain' || w.kind === 'snow') && w.intensity > 0.6));
    if (!flock && t > nextFlock) {
      nextFlock = t + rand(30000, 75000);
      if (n < 0.4 && !rough) {
        const m = 5 + Math.floor(Math.random() * 5);
        flock = { ...launch(rand(55, 80)), birds: Array.from({ length: m }, (_, i) => ({ k: Math.ceil(i / 2) * (i % 2 ? 1 : -1), p: Math.random() * 6.28, j: rand(-3, 3) })) };
      }
    }
    if (!plane && t > nextPlane) {
      nextPlane = t + rand(45000, 110000);
      if (w?.kind !== 'storm') plane = { ...launch(rand(28, 38)), trail: [], lastDot: 0 };
    }
    const out = (o) => o.x < -200 || o.x > W + 200 || o.y < -200 || o.y > H + 200;
    if (plane) {
      plane.x += plane.dx * plane.v * dt; plane.y += plane.dy * plane.v * dt;
      if (t - plane.lastDot > 250) { plane.trail.push([plane.x, plane.y, t]); plane.lastDot = t; }
      while (plane.trail.length && t - plane.trail[0][2] > 14000) plane.trail.shift();
      drawPlane(plane, t, n);
      if (out(plane) && !plane.trail.some(([x, y]) => x > -50 && x < W + 50 && y > -50 && y < H + 50)) plane = null;
    }
    if (flock) {
      flock.x += flock.dx * flock.v * dt; flock.y += flock.dy * flock.v * dt;
      drawFlock(flock, t);
      if (out(flock)) flock = null;
    }
  }
  function drawFlock(f, t) {
    // a loose V: each bird trails behind the leader and off to one side, wings beating out of step
    const bx = -f.dx, by = -f.dy, px = -f.dy, py = f.dx;
    ctx.lineWidth = 1.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(46,44,58,.78)';
    ctx.beginPath();
    for (const b of f.birds) {
      const back = Math.abs(b.k) * 14, side = b.k * 13;
      const x = f.x + bx * back + px * side + Math.sin(t * 0.0007 + b.p) * 2, y = f.y + by * back + py * side + b.j;
      const flap = Math.sin(t * 0.012 + b.p) * 3, s = 5.5;
      ctx.moveTo(x - s, y - flap); ctx.quadraticCurveTo(x - s * 0.45, y - 2 - flap * 0.4, x, y); ctx.quadraticCurveTo(x + s * 0.45, y - 2 - flap * 0.4, x + s, y - flap);
    }
    ctx.stroke();
  }
  function drawPlane(p, t, n) {
    // contrail by day: two thin lines spreading and fading behind the plane
    if (n < 0.6 && p.trail.length > 1) {
      const px = -p.dy, py = p.dx;
      for (const side of [-1, 1]) {
        for (let i = 1; i < p.trail.length; i++) {
          const [x0, y0, t0] = p.trail[i - 1], [x1, y1] = p.trail[i], age = (t - t0) / 14000, spread = 2 + age * 6;
          ctx.strokeStyle = `rgba(255,255,255,${(0.55 * (1 - age) * (1 - n)).toFixed(3)})`;
          ctx.lineWidth = 1.2 + age * 4;
          ctx.beginPath(); ctx.moveTo(x0 + px * side * spread, y0 + py * side * spread); ctx.lineTo(x1 + px * side * spread, y1 + py * side * spread); ctx.stroke();
        }
      }
    }
    ctx.save();
    ctx.translate(p.x, p.y); ctx.rotate(Math.atan2(p.dy, p.dx));
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
    // clouds are high up: past ~2x the home zoom you're below them, so they thin out and go
    const zoomK = 1 - sstep(1.7, 3.6, viewer.viewport.getZoom(true) / viewer.viewport.getHomeZoom());
    const count = cloudCount(), wd = wind();
    const speed = Math.max(1.5, (wd.kmh / 3.6) * 2.2) * clamp(app.isLive() ? 1 : app.getRate() / 60, 1, 40);
    const sw = X1 - X0, sh = Y1 - Y0, oc = overcast();
    const shadowA = 0.2 * (1 - n) * (1 - 0.65 * sstep(0.7, 1, oc));
    const cloudA = (0.9 - 0.2 * n) * zoomK;
    if (zoomK > 0.01 || !reduceMotion) {
      for (let i = 0; i < CLOUDS.length; i++) {
        const c = CLOUDS[i];
        c.vis = reduceMotion ? (i < count ? 1 : 0) : clamp(c.vis + (i < count ? dt : -dt) / 4);
        if (!reduceMotion) { c.x += wd.ex * speed * dt; c.y += wd.ny * speed * dt; }
        c.x = X0 + ((((c.x - X0) % sw) + sw) % sw); c.y = Y0 + ((((c.y - Y0) % sh) + sh) % sh);
      }
    }
    if (zoomK > 0.01) {
      refreshSprites();
      const live = CLOUDS.filter((c) => c.vis > 0.01);
      // shadows first, squashed onto the ground in the map's projection, nudged away from the sun
      // (kept to the campus ground: a shadow on the empty sky around the map would just be a smudge)
      ctx.save();
      if (shadowA > 0.01 && app.groundPath(ctx, dpr)) ctx.clip();
      if (shadowA > 0.01) for (const c of live) {
        const gx = c.x + 60, gy = c.y - 40;
        const sx = (M[0] * gx + M[2] * gy + M[4]) * dpr, sy = (M[1] * gx + M[3] * gy + M[5]) * dpr, rr = c.r * M[8] * dpr * 1.5;
        if (sx + rr < 0 || sy + rr < 0 || sx - rr > cv.width || sy - rr > cv.height) continue;
        ctx.setTransform(M[0] * dpr, M[1] * dpr, M[2] * dpr, M[3] * dpr, sx, sy);
        ctx.globalAlpha = shadowA * c.vis * zoomK;
        ctx.drawImage(SHADOWS[c.s], -c.r * 1.1, -c.r * 0.55, c.r * 2.2, c.r * 1.1);
      }
      ctx.restore();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      // then the clouds themselves, up at their altitude, far ones (higher on screen) first
      const placed = live.map((c) => {
        const x = (M[0] * c.x + M[2] * c.y + M[4] + M[6] * c.alt) * dpr, y = (M[1] * c.x + M[3] * c.y + M[5] + M[7] * c.alt) * dpr;
        return { c, x, y, w: c.r * 2 * M[8] * dpr };
      }).sort((a, b) => a.y - b.y);
      for (const { c, x, y, w } of placed) {
        const h = w / 2;
        if (x + w / 2 < 0 || x - w / 2 > cv.width || y - h < 0 - h || y - h > cv.height) continue;
        ctx.globalAlpha = cloudA * c.vis;
        if (c.flip) { ctx.setTransform(-1, 0, 0, 1, x, 0); ctx.drawImage(sprites[c.s], -w / 2, y - h * BASE, w, h); ctx.setTransform(1, 0, 0, 1, 0, 0); }
        else ctx.drawImage(sprites[c.s], x - w / 2, y - h * BASE, w, h);
      }
      ctx.globalAlpha = 1;
    }
    if (!reduceMotion) {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      flyovers(t, dt);
      raf = requestAnimationFrame(frame);
    }
  }

  // the backdrop and cloud colours follow the clock and the weather
  const restyle = () => { paintBackdrop(); if (reduceMotion) kick(); };
  app.onTick(restyle);
  app.on('weather', restyle);
  paintBackdrop();
  size();

  app.helpSection('Sky', `<p>Clouds drift over campus with the real wind, casting soft shadows as they go: just a few on a clear day,
    a crowd of grey ones when it rains, tinted gold at sunset and moonlit at night. Zoom in and you drop below them.
    Clear nights fill with stars, and every so often a flock of birds or a plane passes over.</p>`);
});
