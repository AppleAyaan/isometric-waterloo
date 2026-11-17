// route.js: "My route", walking directions between two buildings (or lots) on campus.
// Pick a start from the building card ("Walk from here"), then any other building: the shortest walk
// (out/walk.json, built by scripts/walk.mjs from OSM footways, steps, indoor corridors and sidewalks)
// is drawn on the ground as a marching gold line with a little walker, and a chip shows distance/time.
// "Indoors where possible" leans on UW's tunnels, bridges and corridors (Waterloo winters).
// Shareable: #route/DC/SLC (append /indoors for the indoor preference). Esc clears.
(() => {
  // index.html's onReady wipes hashes it doesn't know, and its hashchange handler runs after ours only if
  // we register first: so read the hash now, at script load, and listen before it does.
  const ROUTE_RE = /^#route\/([^/]+)\/([^/]+)(\/indoors)?$/;
  let linked = ROUTE_RE.exec(location.hash);
  let onHash = null;
  addEventListener('hashchange', () => { const m = ROUTE_RE.exec(location.hash); if (m) { if (onHash) setTimeout(() => onHash(m)); else linked = m; } }); // after index.html's own handler

  onApp(async (app) => {
    let W;
    try { const r = await fetch(app.OUT + 'walk.json'); if (!r.ok) throw 0; W = await r.json(); } catch { return; } // no data: no feature
    if (!W?.nodes?.length || !app.life?.projection) return;

    // ---------- graph (CSR adjacency, metres) ----------
    const F = W.flags || { INDOOR: 1, COVERED: 2, STEPS: 4, ROAD: 8, LINK: 16 };
    const SPEED = W.speed || 1.3, q = W.q || 10;
    const N = W.nodes.length / 2, X = new Float32Array(N), Y = new Float32Array(N);
    for (let i = 0; i < N; i++) { X[i] = W.nodes[2 * i] / q; Y[i] = W.nodes[2 * i + 1] / q; }
    const E = W.edges.length / 3, deg = new Int32Array(N + 1);
    for (let k = 0; k < E; k++) { deg[W.edges[3 * k] + 1]++; deg[W.edges[3 * k + 1] + 1]++; }
    for (let i = 0; i < N; i++) deg[i + 1] += deg[i];
    const to = new Int32Array(2 * E), len = new Float32Array(2 * E), flg = new Uint8Array(2 * E), fill = deg.slice(0, N);
    for (let k = 0; k < E; k++) {
      const a = W.edges[3 * k], b = W.edges[3 * k + 1], f = W.edges[3 * k + 2], L = Math.hypot(X[a] - X[b], Y[a] - Y[b]);
      to[fill[a]] = b; len[fill[a]] = L; flg[fill[a]++] = f;
      to[fill[b]] = a; len[fill[b]] = L; flg[fill[b]++] = f;
    }
    // cost per metre: sidewalks and steps a touch worse than paths; "indoors" makes open-air legs 3x as long
    const cost = (f, L, indoor) => L * (f & F.ROAD ? 1.15 : 1) * (f & F.STEPS ? 1.2 : 1) * (indoor && !(f & (F.INDOOR | F.COVERED)) ? 3 : 1);

    const nearest = (x, y, k = 4, r = 120) => {
      const out = [];
      for (let i = 0; i < N; i++) { if (deg[i + 1] === deg[i]) continue; const d = Math.hypot(X[i] - x, Y[i] - y); if (d < r) out.push([i, d]); }
      out.sort((a, b) => a[1] - b[1]);
      return out.slice(0, k);
    };
    // where you can join the graph from a building (all its parts) or a lot: [[node, metres to the door], ...]
    function entrances(b) {
      if (b.kind === 'parking') return b.x != null ? nearest(b.x, b.y, 6, 80).map(([i, d]) => [i, Math.max(0, d - Math.sqrt(b.area || 0) / 2)]) : [];
      const out = [];
      for (const p of app.group(b)) { const f = W.b?.[p.id]; if (f) for (let k = 0; k < f.length; k += 2) out.push([f[k], f[k + 1] / q]); }
      if (!out.length) { const r = app.center(b), [x, y] = app.imageToScene((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2); return nearest(x, y); }
      return out;
    }

    // multi-source Dijkstra (binary heap on typed arrays): any door of A -> any door of B
    const dist = new Float64Array(N), prev = new Int32Array(N), heapN = new Int32Array(2 * E + N + 8), heapD = new Float64Array(2 * E + N + 8);
    function shortest(A, B, indoor) {
      const src = entrances(A), dst = new Map();
      for (const [n, d] of entrances(B)) if (!dst.has(n) || dst.get(n) > d) dst.set(n, d);
      if (!src.length || !dst.size) return null;
      dist.fill(Infinity); prev.fill(-1);
      let hn = 0;
      const push = (n, d) => { let i = hn++; while (i) { const p = (i - 1) >> 1; if (heapD[p] <= d) break; heapN[i] = heapN[p]; heapD[i] = heapD[p]; i = p; } heapN[i] = n; heapD[i] = d; };
      const pop = () => {
        const n = heapN[0], ln = heapN[--hn], ld = heapD[hn];
        let i = 0;
        for (;;) { let c = 2 * i + 1; if (c >= hn) break; if (c + 1 < hn && heapD[c + 1] < heapD[c]) c++; if (heapD[c] >= ld) break; heapN[i] = heapN[c]; heapD[i] = heapD[c]; i = c; }
        heapN[i] = ln; heapD[i] = ld;
        return n;
      };
      for (const [n, d] of src) if (d < dist[n]) { dist[n] = d; push(n, d); }
      let best = Infinity, end = -1;
      while (hn) {
        const d0 = heapD[0], u = pop();
        if (d0 > dist[u]) continue;
        if (d0 >= best) break;
        if (dst.has(u) && d0 + dst.get(u) < best) { best = d0 + dst.get(u); end = u; }
        for (let e = deg[u]; e < deg[u + 1]; e++) {
          const v = to[e], nd = d0 + cost(flg[e], len[e], indoor);
          if (nd < dist[v]) { dist[v] = nd; prev[v] = u; push(v, nd); }
        }
      }
      if (end < 0) return null;
      const nodes = [];
      for (let v = end; v !== -1; v = prev[v]) nodes.push(v);
      nodes.reverse();
      // segments with their flags + real lengths (door legs included in the total)
      const segFlag = (a, b) => { for (let e = deg[a]; e < deg[a + 1]; e++) if (to[e] === b) return flg[e]; return 0; };
      const pts = nodes.map((n) => [X[n], Y[n]]), flags = [];
      let metres = (src.find(([n]) => n === nodes[0])?.[1] || 0) + dst.get(end), indoorM = 0;
      for (let k = 1; k < nodes.length; k++) {
        const f = segFlag(nodes[k - 1], nodes[k]), L = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        flags.push(f); metres += L; if (f & (F.INDOOR | F.COVERED)) indoorM += L;
      }
      return { pts, flags, metres, indoorM };
    }

    // ---------- state ----------
    let start = null, dest = null, indoor = app.store.get('walkIndoors') === '1', route = null, pending = false;
    const same = (a, b) => !!a && !!b && (a === b || (!!a.ref && a.ref === b.ref));
    const keyOf = (b) => (b.kind === 'parking' ? 'lot/' + b.name : b.ref || b.osm);
    const fromKey = (k) => {
      if (k.startsWith('lot/')) return app.lots.find((l) => l.name === k.slice(4)) || null;
      return app.byRef.get(k)?.[0] || app.byRef.get(k.toUpperCase())?.[0] || app.meta.buildings.find((b) => b.osm === k) || null;
    };
    const short = (b) => b.ref || b.name || app.prettyKind(b.kind);
    const codeOf = (b) => (b.ref ? `<span class="code">${app.esc(b.ref)}</span>` : `<b>${app.esc(b.name || app.prettyKind(b.kind))}</b>`);
    const hashOf = () => `#route/${encodeURIComponent(keyOf(start))}/${encodeURIComponent(keyOf(dest))}${indoor ? '/indoors' : ''}`;

    // ---------- styles + chip ----------
    const css = document.createElement('style');
    css.textContent = `
      #walk { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; }
      #walkchip { left: 16px; bottom: calc(56px + var(--safe-b, 0px)); z-index: 3; padding: 12px 12px 12px 14px; border-radius: var(--r-panel); display: none;
        max-width: min(380px, calc(100vw - 32px)); }
      #walkchip.show { display: block; animation: rise .22s ease-out; }
      #walkchip .row { display: flex; align-items: center; gap: 8px; }
      #walkchip .ic { width: 20px; height: 20px; flex: none; color: var(--gold-deep); }
      #walkchip .ttl { font-weight: 600; font-size: var(--fs-title); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 1; min-width: 0; }
      #walkchip .ttl .code { margin-right: 0; }
      #walkchip .arrow { color: var(--muted); margin: 0 5px; }
      #walkchip .sub { color: var(--muted); font-size: var(--fs-meta); margin: 3px 0 0 28px; }
      #walkchip .sub b { color: var(--ink); font-weight: 600; }
      #walkchip .acts { display: flex; gap: 6px; margin: 8px 0 0 28px; }
      #walkchip .acts .btn { padding: 5px 9px; font-size: var(--fs-meta); }
      #walkchip .x { position: static; flex: none; }
      #card .walkacts { margin-top: 6px; }
      @media (max-width: 600px) {
        #walkchip { right: 16px; bottom: calc(52px + var(--safe-b, 0px)); max-width: none; }
        body.walking #card { bottom: calc(var(--walkchip-h, 96px) + 60px + var(--safe-b, 0px)); }
      }`;
    document.head.appendChild(css);
    const walkIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13" cy="4.5" r="2"/><path d="m9 21 2.5-6.5L14 17v4M7 11.5l2.5-3.5 4.5.5 2.5 3.5 2.5 1M11.5 14.5l1-6"/></svg>';
    const shareIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 14a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1"/><path d="M14 10a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1"/></svg>';
    const roofIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11 12 4l9 7"/><path d="M6 9.5V20h12V9.5"/><path d="M10 20v-5h4v5"/></svg>';
    const chip = document.createElement('div');
    chip.id = 'walkchip'; chip.className = 'chip'; chip.setAttribute('role', 'status'); chip.setAttribute('aria-live', 'polite');
    document.body.appendChild(chip);
    const cv = document.createElement('canvas');
    cv.id = 'walk'; cv.setAttribute('aria-hidden', 'true');
    document.body.insertBefore(cv, document.getElementById('title'));
    const ctx = cv.getContext('2d');

    function renderChip() {
      document.body.classList.toggle('walking', !!(pending || route));
      if (!start) { chip.classList.remove('show'); return; }
      const x = '<button class="x" data-a="close" aria-label="Clear route" title="Clear route (Esc)">×</button>';
      if (pending) {
        chip.innerHTML = `<div class="row">${walkIcon.replace('<svg', '<svg class="ic"')}<div class="ttl">Walking from ${codeOf(start)}</div>${x}</div>` +
          `<div class="sub">Now pick a destination: tap a building or search for it</div>`;
      } else {
        const r = route, mins = r ? Math.max(1, Math.round(r.metres / SPEED / 60)) : 0;
        const m = r ? (r.metres >= 1000 ? (r.metres / 1000).toFixed(1) + ' km' : Math.round(r.metres / 10) * 10 + ' m') : '';
        const pctIn = r && r.metres ? Math.round((100 * r.indoorM) / r.metres) : 0;
        chip.innerHTML = `<div class="row">${walkIcon.replace('<svg', '<svg class="ic"')}<div class="ttl">${codeOf(start)}<span class="arrow">→</span>${codeOf(dest)}</div>${x}</div>` +
          (r ? `<div class="sub"><b>${m}</b> · ~${mins} min walk${pctIn >= 5 ? ` · ${pctIn}% indoors or covered` : ''}</div>` : `<div class="sub">No walking route found between these two</div>`) +
          `<div class="acts"><button class="btn${indoor ? ' on' : ''}" data-a="indoor" aria-pressed="${indoor}" title="Prefer tunnels, bridges and corridors">${roofIcon}Indoors where possible</button>` +
          `<button class="btn" data-a="share" title="Copy a link to this route">${shareIcon}Share</button></div>`;
      }
      chip.classList.add('show');
      document.documentElement.style.setProperty('--walkchip-h', chip.offsetHeight + 'px');
    }
    chip.addEventListener('click', async (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'close') clear();
      if (a === 'indoor') { indoor = !indoor; app.store.set('walkIndoors', indoor ? '1' : '0'); go(false); }
      if (a === 'share') {
        history.replaceState(null, '', hashOf());
        try { await navigator.clipboard.writeText(location.href); app.toast('Route link copied'); } catch { prompt('Copy this link', location.href); }
      }
    });

    // ---------- actions ----------
    function clear() {
      start = dest = route = null; pending = false;
      if (ROUTE_RE.test(location.hash)) history.replaceState(null, '', location.pathname + location.search);
      renderChip(); decorateCard(); stopLoop(); ctx.clearRect(0, 0, cv.width, cv.height);
    }
    function beginFrom(b) { start = b; dest = null; route = null; pending = true; stopLoop(); ctx.clearRect(0, 0, cv.width, cv.height); renderChip(); decorateCard(); }
    function go(fit = true) {
      if (!start || !dest) return;
      pending = false;
      const r = shortest(start, dest, indoor);
      route = r && {
        ...r,
        img: r.pts.map(([x, y]) => app.sceneToImage(x, y, 0)),
      };
      if (route) { // cumulative image-space length, for dashes and the walker
        route.cum = [0];
        for (let k = 1; k < route.img.length; k++) route.cum.push(route.cum[k - 1] + Math.hypot(route.img[k][0] - route.img[k - 1][0], route.img[k][1] - route.img[k - 1][1]));
        t0 = performance.now();
      }
      renderChip(); decorateCard();
      if (ROUTE_RE.test(location.hash) || fit) history.replaceState(null, '', hashOf());
      if (route && fit) fitRoute();
      startLoop();
    }
    function routeTo(b) { if (!start || same(start, b)) return; dest = b; go(true); }
    function fitRoute() {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of route.img) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      for (const b of [start, dest]) for (const p of app.group(b)) { const r = app.center(p); x0 = Math.min(x0, r.x0); x1 = Math.max(x1, r.x1); y0 = Math.min(y0, r.y0); y1 = Math.max(y1, r.y1); }
      const pad = Math.max(160, 0.25 * Math.max(x1 - x0, y1 - y0));
      app.stopTour();
      // a little extra room at the bottom for the card and chip
      app.viewer.viewport.fitBounds(app.viewer.world.getItemAt(0).imageToViewportRectangle(x0 - pad, y0 - pad, x1 - x0 + 2 * pad, y1 - y0 + 2.6 * pad), app.reduceMotion);
    }

    // the selected-building card: add "Walk from here" / "Walk here"; a pending start takes the next selection as its destination
    const body = document.getElementById('cardBody');
    let lastSel = null;
    function decorateCard() {
      body.querySelector('.walkacts')?.remove();
      const sel = app.getSelected();
      if (!sel || !document.getElementById('card').classList.contains('show')) return;
      const btns = [];
      if (start && !same(start, sel) && !(dest && same(dest, sel))) btns.push(`<button class="btn" data-w="to">${walkIcon}Walk here from ${app.esc(short(start))}</button>`);
      if (!same(start, sel)) btns.push(`<button class="btn" data-w="from">${walkIcon}Walk from here</button>`);
      if (!btns.length) return;
      const div = document.createElement('div');
      div.className = 'actions walkacts'; div.innerHTML = btns.join('');
      div.addEventListener('click', (e) => {
        const w = e.target.closest('[data-w]')?.dataset.w, b = app.getSelected();
        if (!b) return;
        if (w === 'from') beginFrom(b);
        if (w === 'to') routeTo(b);
      });
      body.appendChild(div);
    }
    new MutationObserver(() => {
      if (body.querySelector('.walkacts')) return; // our own insertion
      const sel = app.getSelected();
      if (sel && pending && !same(sel, start) && sel !== lastSel) { lastSel = sel; routeTo(sel); return; }
      lastSel = sel;
      decorateCard();
    }).observe(body, { childList: true });

    addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !(start || route)) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.getElementById('help')?.open) return;
      clear();
    });

    // ---------- drawing: own canvas + rAF only while a route is up (works with map life paused) ----------
    let raf = 0, t0 = 0, dpr = 1;
    const startLoop = () => { if (!raf && route) raf = requestAnimationFrame(frame); };
    const stopLoop = () => { cancelAnimationFrame(raf); raf = 0; };
    const [PX, PY] = app.life.projection;
    const imgPerM = Math.hypot(PX[0], PY[0]), upImg = [PX[2], PY[2]]; // image px per ground metre, and per metre up
    function frame(now) {
      raf = 0;
      if (!route) return;
      dpr = Math.min(devicePixelRatio || 1, 2);
      const vw = innerWidth, vh = innerHeight;
      if (cv.width !== Math.round(vw * dpr) || cv.height !== Math.round(vh * dpr)) { cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr); }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, vw, vh);
      // OpenSeadragon is a pure scale + translate: three points give the image -> screen affine for this frame
      const o = app.imageToScreen(0, 0), ex = app.imageToScreen(1000, 0), ey = app.imageToScreen(0, 1000);
      const sx = (ex[0] - o[0]) / 1000, sy = (ey[1] - o[1]) / 1000;
      const S = (p) => [o[0] + p[0] * sx, o[1] + p[1] * sy];
      const pxPerM = imgPerM * sx, night = app.getNightLevel?.() || 0;
      const w = Math.max(2.5, Math.min(7, pxPerM * 1.4));
      const t = (now - t0) / 1000, march = app.reduceMotion ? 0 : t * w * 6;
      const sp = route.img.map(S);
      ctx.lineJoin = ctx.lineCap = 'round';
      // halo under the whole route so it reads on grass, roofs and the night map alike
      ctx.beginPath(); sp.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.setLineDash([]); ctx.strokeStyle = night > 0.5 ? 'rgba(10, 8, 30, .55)' : 'rgba(31, 28, 23, .45)'; ctx.lineWidth = w + 3.5; ctx.stroke();
      if (night > 0.3) { ctx.shadowColor = 'rgba(254, 211, 76, .8)'; ctx.shadowBlur = 8 * night; }
      // runs of outdoor (dashes) and indoor/covered (dots) legs
      let k = 0, cumS = 0;
      const segLen = (a) => Math.hypot(sp[a + 1][0] - sp[a][0], sp[a + 1][1] - sp[a][1]);
      while (k < route.flags.length) {
        const inside = !!(route.flags[k] & (F.INDOOR | F.COVERED)), runStart = cumS;
        ctx.beginPath(); ctx.moveTo(sp[k][0], sp[k][1]);
        while (k < route.flags.length && !!(route.flags[k] & (F.INDOOR | F.COVERED)) === inside) { cumS += segLen(k); k++; ctx.lineTo(sp[k][0], sp[k][1]); }
        if (inside) { ctx.setLineDash([0.01, w * 2]); ctx.strokeStyle = '#fff4c8'; ctx.lineWidth = w * 1.05; }
        else { ctx.setLineDash([w * 2.4, w * 1.6]); ctx.strokeStyle = '#fed34c'; ctx.lineWidth = w; }
        ctx.lineDashOffset = runStart - march;
        ctx.stroke();
      }
      ctx.setLineDash([]); ctx.shadowBlur = 0;
      // ends: a ring at the start, a pin-dot at the destination
      const dot = ([x, y], r, fillC, ring) => { ctx.beginPath(); ctx.arc(x, y, r, 0, 7); ctx.fillStyle = fillC; ctx.fill(); ctx.lineWidth = ring; ctx.strokeStyle = '#1f1c17'; ctx.stroke(); };
      dot(sp[0], w * 1.3 + 2, '#fffaf0', 2);
      dot(sp.at(-1), w * 1.5 + 3, '#fed34c', 2.2);
      ctx.beginPath(); ctx.arc(sp.at(-1)[0], sp.at(-1)[1], w * 0.5 + 1, 0, 7); ctx.fillStyle = '#1f1c17'; ctx.fill();
      // the walker: loops start -> end at a brisk "map pace" (real time would be minutes)
      const total = route.cum.at(-1);
      if (total > 0) {
        const dur = Math.max(4, Math.min(14, route.metres / 45)), cyc = dur + 0.8;
        const f = app.reduceMotion ? 0.5 : Math.min(1, (t % cyc) / dur), s = f * total;
        let j = 1; while (j < route.cum.length - 1 && route.cum[j] < s) j++;
        const a = route.img[j - 1], b = route.img[j], u = (s - route.cum[j - 1]) / ((route.cum[j] - route.cum[j - 1]) || 1);
        const [px, py] = S([a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u]);
        const hPx = Math.max(13, Math.min(42, -upImg[1] * sy * 1.75)), dir = Math.sign(b[0] - a[0]) || 1;
        drawWalker(px, py, hPx, app.reduceMotion ? 0 : t * 9, dir);
      }
      raf = requestAnimationFrame(frame);
    }
    // a chunky pixel-ish person: shadow, swinging legs, gold shirt, head
    function drawWalker(x, y, h, ph, dir) {
      const u = h / 10, sw = Math.sin(ph) * u * 1.4, bob = Math.abs(Math.cos(ph)) * u * 0.35;
      ctx.save();
      ctx.fillStyle = 'rgba(20, 16, 10, .3)'; ctx.beginPath(); ctx.ellipse(x, y, u * 2.2, u * 0.9, 0, 0, 7); ctx.fill();
      ctx.lineCap = 'round'; ctx.strokeStyle = '#2b2a3a'; ctx.lineWidth = u * 1.3;
      ctx.beginPath(); ctx.moveTo(x, y - u * 4.6 - bob); ctx.lineTo(x + sw, y - u * 0.4); ctx.moveTo(x, y - u * 4.6 - bob); ctx.lineTo(x - sw, y - u * 0.4); ctx.stroke();
      ctx.strokeStyle = '#1f1c17'; ctx.lineWidth = u * 2.6 + 1.6; // outline, then shirt
      ctx.beginPath(); ctx.moveTo(x, y - u * 4.4 - bob); ctx.lineTo(x, y - u * 7.4 - bob); ctx.stroke();
      ctx.strokeStyle = '#fed34c'; ctx.lineWidth = u * 2.6;
      ctx.beginPath(); ctx.moveTo(x, y - u * 4.4 - bob); ctx.lineTo(x, y - u * 7.4 - bob); ctx.stroke();
      ctx.strokeStyle = '#c99a06'; ctx.lineWidth = u * 0.9; // arm swinging opposite the front leg
      ctx.beginPath(); ctx.moveTo(x, y - u * 7 - bob); ctx.lineTo(x - sw * 0.8 * dir, y - u * 5 - bob); ctx.stroke();
      ctx.fillStyle = '#e8b48a'; ctx.strokeStyle = '#1f1c17'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x + dir * u * 0.2, y - u * 8.9 - bob, u * 1.25, 0, 7); ctx.fill(); ctx.stroke();
      ctx.restore();
    }

    // ---------- shared links ----------
    function openLinked(m) {
      const a = fromKey(decodeURIComponent(m[1])), b = fromKey(decodeURIComponent(m[2]));
      if (!a || !b) { app.toast("Couldn't find one of those buildings"); return; }
      if (m[3]) indoor = true;
      start = a; dest = b; lastSel = b;
      app.select(b, false); // the card for the destination (this rewrites the hash; go() puts the route back)
      go(true);
    }
    onHash = openLinked;
    if (linked) {
      // wait for index.html's onReady (loader gone), which would otherwise clear the hash after us
      const m = linked; linked = null;
      const wait = () => (document.querySelector('#loader:not(.done)') ? setTimeout(wait, 120) : setTimeout(() => openLinked(m), 50));
      wait();
    }

    app.helpSection('Walking directions',
      '<p>Select a building and press <b>Walk from here</b>, then pick where you are going. The gold line is the shortest walk on campus paths ' +
      '(dots are indoor or covered stretches); <b>Indoors where possible</b> favours the tunnels, bridges and corridors. Share it as a link like <b>#route/DC/SLC</b>.</p>');
  });
})();
