// eggs.js: a few Waterloo legends hidden on the map, plus a couple of secrets.
// Props are drawn as little isometric models through mapLife.addLayer (depth-sorted and hidden behind
// buildings like everything else) and open a glass card when clicked:
//   - the Pink Tie hanging down MC's west face (Faculty of Mathematics)
//   - the Tool, Engineering's giant chrome pipe wrench, on a plinth in the yard between E2 and CPH
//   - a cannon by E5 aimed down the 401 at Toronto (Waterloo has no cannon: that's U of T's; see its card)
// Secrets: type "goose" for a stampede; the Konami code sends every goose on the ground off in V-formations;
// clicking a goose honks. Sizes are a bit bigger than life so they read at map scale.
onApp((app) => {
  const life = window.mapLife;
  if (!life?.api || !life.addLayer) return; // no map life: nothing to hang the eggs on
  const api = life.api, ctx = document.getElementById('veh')?.getContext('2d');
  if (!ctx) return;
  const esc = app.esc || ((s) => s);
  const P3 = (o, u, v, h) => [o[0] + u[0] * v, o[1] + u[1] * v, h]; // point along a horizontal direction
  const fill = (pts, color) => { api.poly(pts.map((p) => api.toScreen(...p))); ctx.fillStyle = color; ctx.fill(); };
  // screen-space box of the points just drawn: what clicks and hovers test against
  const boxOf = (pts, pad = 6) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) { const [sx, sy] = api.toScreen(...p); x0 = Math.min(x0, sx); x1 = Math.max(x1, sx); y0 = Math.min(y0, sy); y1 = Math.max(y1, sy); }
    return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
  };
  const tnow = () => performance.now() / 1000;

  // ---------- the Pink Tie ----------
  // MC's long west wall runs about (208, 28) -> (228, -20) in scene metres (from the footprint in meta.json);
  // it faces the camera, so the tie hangs flat against it from just under the roof (MC is ~26 m tall).
  const TIE_U = [0.385, -0.923], TIE_N = [-0.923, -0.385], TIE_C = [218.2, 3.9];
  const TIE_DROP = 5; // metres below the drawn heights, so the knot sits clear of the roofline
  function drawTie(q, small) {
    const sway = app.reduceMotion ? 0 : Math.sin(tnow() * 0.9) * 0.25;
    const at = (u, h) => { const s = (25 - h) / 20; return [TIE_C[0] + TIE_U[0] * (u + sway * s * s) , TIE_C[1] + TIE_U[1] * (u + sway * s * s), h - TIE_DROP]; };
    const knot = [at(-1.15, 25.3), at(1.15, 25.3), at(0.8, 22.7), at(-0.8, 22.7)];
    const blade = [at(-0.8, 22.7), at(0.8, 22.7), at(2.0, 10.5), at(0, 7.8), at(-2.0, 10.5)];
    // the wall's own shadow under the tie, so it reads as hanging off the building
    fill(blade.map(([x, y, h]) => [x - TIE_N[0] * 0.05 + 0.25, y - TIE_N[1] * 0.05 - 0.25, h - 0.4]), 'rgba(40,20,30,.22)');
    fill(blade, '#ff5fae');
    if (!small) { // diagonal stripes, clipped to the blade
      ctx.save(); api.poly(blade.map((p) => api.toScreen(...p))); ctx.clip();
      for (let h = 21.5; h > 7; h -= 2.6) fill([at(-3, h), at(3, h - 1.6), at(3, h - 2.4), at(-3, h - 0.8)], '#e8479a');
      ctx.restore();
    }
    fill(knot, '#f0509f');
    api.poly(blade.map((p) => api.toScreen(...p))); ctx.strokeStyle = 'rgba(120,30,70,.55)'; ctx.lineWidth = 0.8; ctx.stroke();
    api.poly(knot.map((p) => api.toScreen(...p))); ctx.stroke();
    TIE.box = boxOf([...knot, ...blade], 4);
  }

  // ---------- the Tool ----------
  // A 60-inch chrome pipe wrench, drawn upright on a plinth (~2.7x life) in the plane facing the camera.
  const TOOL_B = [590, -141], TOOL_T = [-api.CAM[1], api.CAM[0]];
  function drawTool(q, small) {
    const P = (u, h) => P3(TOOL_B, TOOL_T, u, h);
    const L = (a, b, color, w) => api.line3(a, b, color, w, 1);
    if (small) { L(P(0, 0), P(0, 4.4), '#c9d1d8', 0.4); TOOL.box = boxOf([P(0, 0), P(0, 5)]); return; }
    api.shadow(TOOL_B[0], TOOL_B[1], TOOL_T[0], TOOL_T[1], 1.7, 1.7, 0.22);
    const plinth = api.prism(TOOL_B[0], TOOL_B[1], TOOL_T[0], TOOL_T[1], 1.6, 1.6, 0, 0.9);
    api.paint(plinth, { side: '#8d9097', top: '#a9acb2', stroke: 'rgba(30,25,20,.3)', details: [{ faces: ['left', 'right'], f0: 0.25, f1: 0.75, z0: 0.35, z1: 0.65, color: '#d9b448' }] });
    // handle (I-beam), with a highlight and the hang hole
    L(P(0, 0.9), P(0, 3.7), '#9fa8b1', 0.32);
    L(P(-0.07, 0.95), P(-0.07, 3.65), '#eef3f7', 0.08);
    api.dot3(P(0, 1.2), 0.07, '#4b5259', 0.8);
    // housing, knurled nut, hook jaw on its shank, heel jaw
    L(P(0, 3.7), P(0.05, 4.35), '#8f99a2', 0.44);
    L(P(0.2, 4.15), P(0.2, 5.0), '#b5bec6', 0.2);
    L(P(0.13, 3.95), P(0.13, 4.25), '#c7cfd6', 0.5);
    for (const h of [3.99, 4.07, 4.15, 4.23]) L(P(-0.12, h), P(0.38, h), '#6e7780', 0.025);
    L(P(0.2, 5.0), P(0.9, 4.96), '#c3cbd2', 0.26);
    L(P(0.9, 4.96), P(0.92, 4.76), '#aab3bb', 0.14);
    L(P(0.05, 4.37), P(0.9, 4.47), '#aab3bb', 0.22);
    L(P(0.25, 4.98), P(0.85, 4.94), '#f4f8fb', 0.05);
    // a glint off the chrome now and then
    const g = app.reduceMotion ? 0.6 : Math.max(0, Math.sin(tnow() * 1.7)) ** 6;
    if (g > 0.05) {
      const [sx, sy] = api.toScreen(...P(0.62, 4.98)), r = Math.max(3, 0.35 * api.pxPerM) * g;
      ctx.strokeStyle = `rgba(255,255,255,${(0.9 * g).toFixed(2)})`; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(sx - r, sy); ctx.lineTo(sx + r, sy); ctx.moveTo(sx, sy - r); ctx.lineTo(sx, sy + r); ctx.stroke();
    }
    TOOL.box = boxOf([P(-0.9, 0), P(0.9, 0), P(1, 5.1), P(-0.5, 5.1)]);
  }

  // ---------- the cannon ----------
  // A field gun on a wooden carriage beside E5, ~1.6x life, pointed east-ish: down the 401 at Toronto.
  const CAN_B = [565, 44], CH = (() => { const a = Math.atan2(-0.17, 0.98); return [Math.cos(a), Math.sin(a)]; })(), CN = [-CH[1], CH[0]];
  function drawCannon(q, small) {
    const [x, y] = CAN_B, S = 1.6;
    const P = (a, b, h) => [x + (CH[0] * a + CN[0] * b) * S, y + (CH[1] * a + CN[1] * b) * S, h * S];
    if (small) { api.dot3(P(0, 0, 0.6), 0.6 * S, '#2b2d31', 1.5); CANNON.box = boxOf([P(-1, 0, 0), P(1.6, 0, 1.6)]); return; }
    api.shadow(x + CH[0] * 0.3, y + CH[1] * 0.3, CH[0], CH[1], 3.4 * S, 1.6 * S, 0.2);
    const near = CN[0] * api.CAM[0] + CN[1] * api.CAM[1] > 0 ? 1 : -1;
    const wheel = (side) => {
      const c = [0.1, 0.55 * side, 0.62], r = 0.62, pts = [];
      for (let i = 0; i < 14; i++) { const a = (i / 14) * Math.PI * 2; pts.push(P(c[0] + Math.cos(a) * r, c[1], c[2] + Math.sin(a) * r)); }
      fill(pts, '#5d3b21');
      const inner = pts.map((p, i) => { const a = (i / 14) * Math.PI * 2; return P(c[0] + Math.cos(a) * r * 0.78, c[1], c[2] + Math.sin(a) * r * 0.78); });
      fill(inner, '#7a4f2c');
      for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI; api.line3(P(c[0] + Math.cos(a) * r * 0.78, c[1], c[2] + Math.sin(a) * r * 0.78), P(c[0] - Math.cos(a) * r * 0.78, c[1], c[2] - Math.sin(a) * r * 0.78), '#4a2f1a', 0.06 * S, 0.6); }
      api.dot3(P(c[0], c[1], c[2]), 0.1 * S, '#2b2d31', 1);
    };
    wheel(-near);
    // trail (carriage) sloping to the ground behind the axle
    const tr = api.prism(x - CH[0] * 0.55 * S, y - CH[1] * 0.55 * S, CH[0], CH[1], 2.2 * S, 0.62 * S, 0.12, 0.6 * S);
    api.paint(tr, { side: '#7a4a28', top: '#8d5a33', stroke: 'rgba(30,20,10,.35)' });
    // barrel: dark iron, tapering to the muzzle, a ring at each end
    api.line3(P(-0.95, 0, 1.0), P(1.65, 0, 1.4), '#26282c', 0.46 * S, 2);
    api.line3(P(0.4, 0, 1.2), P(1.65, 0, 1.4), '#33363b', 0.36 * S, 1.6);
    api.line3(P(-0.8, 0, 1.12), P(1.5, 0, 1.5), 'rgba(255,255,255,.22)', 0.07 * S, 0.6);
    api.dot3(P(1.68, 0, 1.4), 0.2 * S, '#1a1b1e', 1.5);
    api.dot3(P(1.7, 0, 1.4), 0.1 * S, '#000', 1);
    api.dot3(P(-1.12, 0, 0.98), 0.13 * S, '#26282c', 1);
    wheel(near);
    // a little pyramid of cannonballs
    for (const [a, b, h] of [[-0.6, 1.25, 0.12], [-0.35, 1.25, 0.12], [-0.475, 1.25, 0.32]]) api.dot3(P(a, b * near, h), 0.13 * S, '#1f2024', 1);
    CANNON.box = boxOf([P(-1.4, 0, 0), P(1.8, 0, 1.7), P(0.1, 1.3, 0), P(0.1, -1.3, 0), P(0, 0, 1.9)]);
  }

  // ---------- lore ----------
  const TIE = {
    id: 'tie', name: 'The Pink Tie', at: [TIE_C[0] + TIE_N[0] * 3, TIE_C[1] + TIE_N[1] * 3], draw: drawTie, tag: 'MATH',
    html: `<p>When the Mathematics &amp; Computer building opened in 1968, students draped an enormous pink tie down its side as a tribute to Professor Ralph Stanton, a founder of the faculty famous for his loud ties. It has been the symbol of Waterloo Math ever since.</p>
      <p>Ties have gone missing over the years, and engineers have managed to “tie-nap” at least one, so during Orientation Week a student <b>Tie Guard</b> keeps watch. Accounts of its size vary (anywhere from about 40 to 85 feet).</p>
      <p class="egg-note">The real one comes out for orientation and special occasions; here it hangs year-round.</p>`,
  };
  const TOOL = {
    id: 'tool', name: 'The Tool', at: TOOL_B, draw: drawTool, tag: 'ENG',
    html: `<p>The mascot of Waterloo Engineering: a 60-inch, chrome-plated adjustable pipe wrench made by the Ridgid Tool Company. It made its first public appearance at an engineering semi-formal in October 1968.</p>
      <p>It is guarded by the <b>Tool Bearers</b>, and by tradition only someone wearing an Iron Ring may touch it. In January 1982, University of Toronto engineers made off with it (a “liberation”, in their words). A smaller travelling version, “Junior”, handles the road trips.</p>
      <p class="egg-note">In real life it isn't parked outside CPH; it turns up at Engineering Society events.</p>`,
  };
  const CANNON = {
    id: 'cannon', name: 'The cannon?', at: CAN_B, draw: drawCannon, tag: 'ENG',
    html: `<p>Plot twist: Waterloo Engineering doesn't have a cannon. The famous engineering cannon is the <b>Skule Cannon</b>, which belongs to the University of Toronto's engineers, the same crowd who took the Tool in 1982.</p>
      <p>Rival engineering societies have a long habit of “liberating” each other's mascots. This one is pure wishful thinking: aimed east down the 401 toward Toronto, loaded with nothing but school spirit.</p>`,
  };
  const PROPS = [TIE, TOOL, CANNON];

  life.addLayer({
    collect(add) {
      for (const p of PROPS) p.box = null; // a prop that isn't drawn (off screen, behind a building) can't be clicked
      if (api.pxPerM < 0.5) return;
      for (const p of PROPS) add(p.at[0], p.at[1], (q, small) => p.draw(q, small), p, {});
      for (const g of herd) add(g.x, g.y, (q, s) => api.drawGoose?.(g, s), g, {});
    },
    step: stepHerd,
  });

  // ---------- card ----------
  const css = document.createElement('style');
  css.textContent = `
    #eggcard { right: 16px; bottom: calc(40px + var(--safe-b, 0px)); width: 320px; max-width: calc(100vw - 32px); padding: 16px 18px; display: none; z-index: 3; }
    #eggcard.show { display: block; animation: rise .22s ease-out; }
    #eggcard h2 { margin: 6px 28px 6px 0; font-size: 16px; line-height: 1.25; }
    #eggcard p { margin: 0 0 8px; font-size: 13px; line-height: 1.45; color: var(--ink); }
    #eggcard .egg-note { color: var(--muted); font-size: 12px; margin: 0; }
    #eggcard .x { position: absolute; top: 8px; right: 10px; width: 28px; height: 28px; border-radius: 9px; background: none; border: 0; color: var(--muted); font-size: 20px; line-height: 1; cursor: pointer; }
    #eggcard .x:hover { background: rgba(255, 255, 255, .6); color: var(--ink); }
    :root[data-night] #eggcard .x:hover { background: rgba(255, 255, 255, .12); }
    #eggcard .egg-tag { display: inline-block; padding: 0 6px; border-radius: 6px; background: #ff5fae; color: #fff; font: 11px/18px Silkscreen, monospace; }
    #eggcard .egg-tag.eng { background: var(--gold); color: #1f1c17; }
    @media (max-width: 640px) { #eggcard { left: 16px; right: 16px; width: auto; bottom: calc(52px + var(--safe-b, 0px)); } }
  `;
  document.head.appendChild(css);
  const card = document.createElement('div');
  card.id = 'eggcard'; card.className = 'chip'; card.setAttribute('role', 'dialog'); card.setAttribute('aria-live', 'polite');
  card.innerHTML = '<button class="x" aria-label="Close">×</button><div class="egg-body"></div>';
  document.body.appendChild(card);
  const closeCard = () => card.classList.remove('show');
  card.querySelector('.x').onclick = closeCard;
  function openCard(p) {
    app.stopTour?.();
    app.select(null); // one card at a time
    card.querySelector('.egg-body').innerHTML = `<span class="egg-tag ${p.tag === 'ENG' ? 'eng' : ''}">${esc(p.tag)}</span><h2>${esc(p.name)}</h2>${p.html}`;
    card.classList.remove('show'); void card.offsetWidth; card.classList.add('show');
  }
  // a building card opening closes ours
  const bcard = document.getElementById('card');
  if (bcard) new MutationObserver(() => { if (bcard.classList.contains('show')) closeCard(); }).observe(bcard, { attributes: true, attributeFilter: ['class'] });
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closeCard(); });

  // ---------- hit tests ----------
  const propAt = (sx, sy) => PROPS.find((p) => p.box && sx >= p.box[0] && sx <= p.box[2] && sy >= p.box[1] && sy <= p.box[3]) || null;
  function gooseAt(sx, sy) {
    if (api.pxPerM < 1.2) return null;
    const r = Math.max(6, 1.2 * api.pxPerM);
    for (const g of life.geese || []) {
      if (g.flock?.away || g.flock?.gone > 0) continue;
      const [gx, gy] = api.toScreen(g.x, g.y, 0.6);
      if (Math.abs(gx - sx) < r && Math.abs(gy - sy) < r) return g;
    }
    return null;
  }
  const GOOSE_LINES = [
    'HONK.', 'Canada geese mate for life, and both parents guard the nest.', 'Tip: give a nesting goose a wide berth. It will not give you one.',
    'Goslings can swim within a day or so of hatching.', 'Waterloo geese do not yield to pedestrians. Or cyclists. Or the ION.', 'HONK HONK. (It said no.)',
  ];
  let gooseLine = 0;
  app.clickHandlers.push((sx, sy) => {
    const p = propAt(sx, sy);
    if (p) { openCard(p); return true; }
    const g = gooseAt(sx, sy);
    if (g) {
      app.emit?.('honk', { x: g.x, y: g.y, kind: 'click' });
      if (!g.swim && g.state !== 'hiss') { g.state = 'alert'; g.t = 3; }
      app.toast(GOOSE_LINES[gooseLine++ % GOOSE_LINES.length]);
      return true;
    }
    return false;
  });
  // hover: pointer cursor and a label (runs after the building hover, so it wins over the building underneath)
  const tip = document.getElementById('tip');
  app.viewer.canvas.addEventListener('pointermove', (e) => {
    if (e.pointerType !== 'mouse') return;
    const r = app.viewer.canvas.getBoundingClientRect(), p = propAt(e.clientX - r.left, e.clientY - r.top);
    if (!p) return;
    app.viewer.canvas.style.cursor = 'pointer';
    if (tip) {
      tip.textContent = p.name; tip.style.display = 'block';
      tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + 'px';
      tip.style.top = Math.min(e.clientY + 14, innerHeight - tip.offsetHeight - 8) + 'px';
    }
  });

  // ---------- secret: type "goose" for a stampede ----------
  const herd = [];
  const sceneAt = (sx, sy) => app.imageToScene(...app.screenToImage(sx, sy));
  function stampede() {
    if (app.reduceMotion || api.pxPerM < 0.7) { app.toast('HONK HONK HONK'); app.emit?.('honk', { kind: 'stampede' }); return; }
    const n = 22, t0 = tnow();
    for (let i = 0; i < n; i++) {
      const sy = innerHeight * (0.18 + 0.7 * Math.random()), lag = Math.random() * 2.2;
      const a = sceneAt(-60, sy), b = sceneAt(innerWidth + 60, sy), d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      herd.push({
        x: a[0], y: a[1], a, hx: (b[0] - a[0]) / d, hy: (b[1] - a[1]) / d, d, t0: t0 + lag, dur: 3.6 + Math.random() * 1.8,
        size: 3 * (0.9 + Math.random() * 0.2), state: 'hiss', flap: Math.random(), peck: 0, swim: false, v: 2, quiet: true,
      });
    }
    const c = sceneAt(innerWidth / 2, innerHeight / 2);
    app.emit?.('honk', { x: c[0], y: c[1], kind: 'stampede' });
    app.toast('HONK HONK HONK');
  }
  // positions follow real time (not the time-lapse rate): it's a gag, it should play at gag speed
  function stepHerd() {
    if (!herd.length) return;
    const t = tnow();
    for (let i = herd.length - 1; i >= 0; i--) {
      const g = herd[i], u = (t - g.t0) / g.dur;
      if (u > 1) { herd.splice(i, 1); continue; }
      const s = Math.max(0, u) * g.d, hop = Math.sin(t * 9 + g.flap * 6);
      g.x = g.a[0] + g.hx * s - g.hy * hop * 0.15; g.y = g.a[1] + g.hy * s + g.hx * hop * 0.15;
      g.flap = t;
    }
  }

  // ---------- secret: Konami code, every goose takes off ----------
  const KONAMI = ['arrowup', 'arrowup', 'arrowdown', 'arrowdown', 'arrowleft', 'arrowright', 'arrowleft', 'arrowright', 'b', 'a'];
  let keys = [], typed = '';
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    const k = e.key.toLowerCase();
    keys = [...keys, k].slice(-KONAMI.length);
    if (keys.join() === KONAMI.join()) {
      keys = [];
      const n = life.scatterGeese?.() || 0;
      app.toast(n ? `${n} geese have had enough of you. They'll be back.` : 'The geese are already gone.');
    }
    if (k.length === 1) { typed = (typed + k).slice(-5); if (typed === 'goose') { typed = ''; stampede(); } }
  });

  app.helpSection('Secrets', '<p>A few campus legends are hiding on this map, if you know where to look. The geese, as always, know more than they let on.</p>');
});
