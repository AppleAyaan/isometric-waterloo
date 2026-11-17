// sky.js: live Waterloo weather over the map (rain, snow, fog, storms, drifting cloud shadows) and a smooth
// sunrise / sunset (twilight night level + golden-hour and blue-hour colour grade).
// Everything here sits between the map (and its life canvas) and the UI chips, so the chips never get tinted.
onApp((app) => {
  const { viewer, reduceMotion } = app;
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  // smoothstep from a to b (a > b runs it backwards, handy for "as the sun goes down")
  const sstep = (a, b, x) => { const u = clamp((x - a) / (b - a)); return u * u * (3 - 2 * u); };
  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * k));

  // ---------------------------------------------------------------------------------------------------------
  // layers: colour grade divs (CSS blend modes) + one canvas for weather. Inserted right after the life canvas,
  // before the bus/train tags and the highlight, so those and every chip stay crisp.
  const css = document.createElement('style');
  css.textContent = `
    .skyl { position: fixed; inset: 0; width: 100%; height: 100%; pointer-events: none; opacity: 0; transition: opacity 2.5s linear, background 2.5s linear; }
    .skyl.fast { transition-duration: .3s; }
    #sky-warm { mix-blend-mode: soft-light; }
    #sky-glow { mix-blend-mode: multiply; }
    #sky-cool { mix-blend-mode: multiply; }
    #sky-dim { mix-blend-mode: multiply; }
    #wxc { transition: none; opacity: 1; }
    #clock .meta > #wx:not(.on) { display: none; }
  `;
  document.head.appendChild(css);
  const mk = (tag, id) => { const e = document.createElement(tag); e.id = id; e.className = 'skyl'; e.setAttribute('aria-hidden', 'true'); return e; };
  const dim = mk('div', 'sky-dim'), glow = mk('div', 'sky-glow'), warm = mk('div', 'sky-warm'), cool = mk('div', 'sky-cool'), cv = mk('canvas', 'wxc');
  const anchor = document.getElementById('vcards');
  for (const e of [dim, glow, warm, cool, cv]) document.body.insertBefore(e, anchor);
  const ctx = cv.getContext('2d');

  // ---------------------------------------------------------------------------------------------------------
  // 2. twilight: night level ramps with the sun (0 at +2 deg, half at -3 where the street lights come on, 1 by -8)
  const twilight = (el) => sstep(2, -8, el);
  app.setNightLevelFn((t) => twilight(app.sunElevation(t)));

  // which way the sun is on screen: east in the morning, west in the evening (good enough for a glow direction)
  const [PX, PY] = app.life?.projection || [[1, 0, 0, 0], [0, -1, 0, 0]];
  const east = [PX[0], PY[0]], el0 = Math.hypot(...east) || 1;
  function sunSide(now) {
    const rising = app.sunElevation(new Date(+now + 600000)) > app.sunElevation(now), s = rising ? 1 : -1;
    // CSS gradient angle: 0deg points up, 90deg right; the gradient runs toward the sun
    return Math.round(Math.atan2(s * east[0] / el0, -s * east[1] / el0) * 180 / Math.PI);
  }
  let gradeFast = false;
  function grade(now) {
    const el = app.sunElevation(now), lv = app.getNightLevel();
    // a manual night/day flip pins the map: no sunset grade fighting it
    const ok = Math.abs(lv - twilight(el)) < 0.3 ? 1 : 0;
    const fast = !app.isLive();
    if (fast !== gradeFast) { gradeFast = fast; for (const e of [dim, glow, warm, cool]) e.classList.toggle('fast', fast); }
    const ang = sunSide(now);
    // golden hour: sun 12 deg down to the horizon, peaking low, gone a few degrees after sunset
    const w = ok * sstep(9, 2, el) * sstep(-5, -0.5, el);
    // colour slides from honey-orange (sun up) to coral-pink (sun at / just under the horizon)
    const hue = sstep(5, -1.5, el), c1 = mix([255, 168, 70], [255, 112, 128], hue), c2 = mix([255, 205, 140], [214, 128, 190], hue);
    warm.style.background = `linear-gradient(${ang + 180}deg, rgba(${c2},.55), rgba(${c1},1) 85%)`;
    warm.style.opacity = (w * 0.5).toFixed(3);
    // a soft warm multiply so the light paper-coloured ground actually turns golden (soft-light barely moves pale tones)
    glow.style.background = `linear-gradient(${ang + 180}deg, rgba(${mix([255, 236, 210], [246, 214, 226], hue)},1), rgba(${mix([255, 214, 160], [250, 180, 180], hue)},1))`;
    glow.style.opacity = (w * 0.38).toFixed(3);
    // blue hour: civil twilight, deep blue-violet that hands over to the night map
    const b = ok * sstep(0.5, -3.5, el) * sstep(-11, -6.5, el);
    cool.style.background = `linear-gradient(${ang + 180}deg, rgb(92,96,168), rgb(150,120,190))`;
    cool.style.opacity = (b * 0.42).toFixed(3);
    dimFor(lv);
  }
  // weather dimming: grey skies flatten the light a little (much less at night, the night map is already dark)
  function dimFor(lv) {
    const W = app.weather, k = W ? { clear: 0, cloudy: 0.35 * clamp((W.cloudCover - 50) / 50), fog: 0.35, rain: 0.25 + 0.3 * W.intensity, snow: 0.25, storm: 0.7 }[W.kind] : 0;
    dim.style.background = W?.kind === 'snow' ? 'rgb(206,214,232)' : 'rgb(178,184,198)';
    dim.style.opacity = (k * (1 - 0.7 * lv)).toFixed(3);
  }
  app.onTick(grade);
  grade(app.now());

  // ---------------------------------------------------------------------------------------------------------
  // 1. weather. WMO codes from Open-Meteo -> kind, intensity and a short label
  const WMO = {
    0: ['clear', 0, 'Clear'], 1: ['clear', 0, 'Mostly clear'], 2: ['cloudy', 0.5, 'Partly cloudy'], 3: ['cloudy', 1, 'Overcast'],
    45: ['fog', 0.7, 'Fog'], 48: ['fog', 0.85, 'Freezing fog'],
    51: ['rain', 0.15, 'Light drizzle'], 53: ['rain', 0.25, 'Drizzle'], 55: ['rain', 0.35, 'Heavy drizzle'],
    56: ['rain', 0.2, 'Freezing drizzle'], 57: ['rain', 0.35, 'Freezing drizzle'],
    61: ['rain', 0.35, 'Light rain'], 63: ['rain', 0.6, 'Rain'], 65: ['rain', 0.95, 'Heavy rain'],
    66: ['rain', 0.4, 'Freezing rain'], 67: ['rain', 0.8, 'Freezing rain'],
    71: ['snow', 0.3, 'Light snow'], 73: ['snow', 0.6, 'Snow'], 75: ['snow', 0.95, 'Heavy snow'], 77: ['snow', 0.25, 'Snow grains'],
    80: ['rain', 0.4, 'Showers'], 81: ['rain', 0.65, 'Showers'], 82: ['rain', 1, 'Heavy showers'],
    85: ['snow', 0.45, 'Snow showers'], 86: ['snow', 0.85, 'Snow showers'],
    95: ['storm', 0.85, 'Thunderstorm'], 96: ['storm', 0.95, 'Thunderstorm, hail'], 99: ['storm', 1, 'Thunderstorm, hail'],
  };
  // demo / devtools presets: code, cloud cover
  const PRESET = { clear: [0, 10], cloudy: [2, 65], fog: [45, 100], rain: [63, 100], snow: [73, 100], storm: [95, 100] };
  const ICON = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
    cloud: '<path d="M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.2 11 3.5 3.5 0 0 0 7 18z"/>',
    fog: '<path d="M4 9h16M3 13h18M5 17h14"/>',
    rain: '<path d="M7 14h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.2 7 3.5 3.5 0 0 0 7 14z"/><path d="M8 17l-1 3M12 17l-1 3M16 17l-1 3"/>',
    snow: '<path d="M7 14h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.2 7 3.5 3.5 0 0 0 7 14z"/><path d="M8 18h.01M12 20h.01M16 18h.01M10 22h.01M14 22h.01" stroke-width="2.6"/>',
    storm: '<path d="M7 14h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.2 7 3.5 3.5 0 0 0 7 14z"/><path d="M12.5 14 10 18.5h4L11.5 23"/>',
  };
  const params = new URLSearchParams(location.search);
  let override = PRESET[params.get('weather')] ? params.get('weather') : null, overrideI = null;
  let live = null; // last good Open-Meteo reading
  app.weather = null;

  function compose() {
    const c = live || { temperature_2m: null, weather_code: 0, cloud_cover: 0, wind_speed_10m: 12, wind_direction_10m: 270, precipitation: 0, snowfall: 0 };
    let code = c.weather_code, cover = c.cloud_cover;
    if (override) [code, cover] = PRESET[override];
    const [kind, base, label] = WMO[code] || ['clear', 0, 'Clear'];
    let intensity = base;
    // measured precipitation can push it harder than the code alone says (mm/h rain, cm/h snow)
    if (!override && kind === 'rain') intensity = Math.max(base, clamp(c.precipitation / 6));
    if (!override && kind === 'snow') intensity = Math.max(base, clamp(c.snowfall / 2.5));
    if (overrideI != null) intensity = overrideI;
    if (kind === 'cloudy' || kind === 'clear') intensity = clamp(cover / 100);
    return { code, kind, intensity: +intensity.toFixed(2), temp: c.temperature_2m, wind: c.wind_speed_10m, windDir: c.wind_direction_10m, cloudCover: cover, label, live: !!live && !override };
  }
  function publish() {
    if (!live && !override) return; // nothing known: stay hidden
    const w = compose(), changed = JSON.stringify(w) !== JSON.stringify(app.weather);
    app.weather = w;
    showChip();
    dimFor(app.getNightLevel());
    if (changed) { resetParticles(); kick(); app.emit('weather', w); }
  }
  async function fetchWeather() {
    const ac = new AbortController(), to = setTimeout(() => ac.abort(), 10000);
    try {
      const u = `https://api.open-meteo.com/v1/forecast?latitude=${app.CAMPUS.lat}&longitude=${app.CAMPUS.lon}&current=temperature_2m,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,precipitation,snowfall,is_day&timezone=America%2FToronto`;
      const r = await fetch(u, { signal: ac.signal });
      if (!r.ok) throw new Error(r.status);
      const j = await r.json();
      if (j?.current && typeof j.current.weather_code === 'number') { live = j.current; lastFetch = Date.now(); publish(); }
    } catch (e) { /* fail soft: keep the last reading (or nothing) */ } finally { clearTimeout(to); }
  }
  let lastFetch = 0;
  fetchWeather();
  setInterval(() => { if (!document.hidden) fetchWeather(); }, 12 * 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastFetch > 12 * 60000) fetchWeather(); });
  // devtools / demo: app.setWeather('snow'), app.setWeather('rain', 0.3), app.setWeather(null) = live again
  app.setWeather = (kind, intensity) => {
    if (kind != null && !PRESET[kind]) return Object.keys(PRESET);
    override = kind || null; overrideI = intensity == null ? null : clamp(+intensity);
    if (!override && !live) { app.weather = null; showChip(); resetParticles(); kick(); dimFor(app.getNightLevel()); app.emit('weather', null); return null; }
    publish();
    return app.weather;
  };
  // after every module has registered, so the sound module hears the first state
  setTimeout(publish, 0);

  // the weather bit of the clock chip: icon + temperature (the description is in its tooltip)
  const sub = document.getElementById('clocksub'), wx = document.createElement('span');
  wx.id = 'wx';
  sub?.after(wx);
  function showChip() {
    const w = app.weather;
    wx.classList.toggle('on', !!w);
    if (!w) return;
    const night = app.getNightLevel() > 0.5;
    const ic = w.kind === 'clear' || (w.kind === 'cloudy' && w.cloudCover < 60) ? (night ? 'moon' : 'sun') : w.kind === 'cloudy' ? 'cloud' : w.kind;
    const t = w.temp == null ? w.label : `<b>${Math.round(w.temp) === 0 ? 0 : Math.round(w.temp)}°</b>`;
    wx.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[ic]}</svg>${t}`;
    wx.title = `${w.label}${w.temp == null ? '' : ', ' + Math.round(w.temp) + '°C'}, wind ${Math.round(w.wind)} km/h${override ? ' (demo)' : ' · Open-Meteo'}`;
    wx.setAttribute('aria-label', wx.title);
  }
  // keep the sun/moon icon right as night falls
  app.onTick(() => { if (app.weather) showChip(); });

  // ---------------------------------------------------------------------------------------------------------
  // the weather canvas
  let W = 0, H = 0, dpr = 1;
  function size() {
    dpr = Math.min(2, window.devicePixelRatio || 1); W = innerWidth; H = innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    resetParticles(); kick();
  }
  addEventListener('resize', size);

  // soft cloud sprites drawn once: lumpy blobs of radial gradients (black for shadows, white for fog banks)
  function sprite(rgb, seed) {
    const s = 256, c = document.createElement('canvas'); c.width = c.height = s;
    const g = c.getContext('2d');
    let r = seed;
    const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 9; i++) {
      const a = rnd() * Math.PI * 2, d = rnd() * 52, x = s / 2 + Math.cos(a) * d, y = s / 2 + Math.sin(a) * d * 0.8, rad = 46 + rnd() * 44;
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, `rgba(${rgb},.55)`); gr.addColorStop(0.6, `rgba(${rgb},.3)`); gr.addColorStop(1, `rgba(${rgb},0)`);
      g.fillStyle = gr; g.beginPath(); g.arc(x, y, rad, 0, 7); g.fill();
    }
    return c;
  }
  const SHADOWS = [sprite('20,24,40', 7), sprite('20,24,40', 99), sprite('20,24,40', 4242)];
  const MIST = [sprite('255,255,255', 11), sprite('255,255,255', 777)];

  // clouds live in scene metres and wrap around campus; they drift with the wind
  const meta = app.meta, iw = meta?.width || 7168, ih = meta?.height || 3584;
  const corners = [[0, 0], [iw, 0], [0, ih], [iw, ih]].map(([x, y]) => app.imageToScene(x, y));
  const X0 = Math.min(...corners.map((c) => c[0])) - 800, X1 = Math.max(...corners.map((c) => c[0])) + 800;
  const Y0 = Math.min(...corners.map((c) => c[1])) - 800, Y1 = Math.max(...corners.map((c) => c[1])) + 800;
  let seed = 12345;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const clouds = Array.from({ length: 22 }, () => ({ x: X0 + rnd() * (X1 - X0), y: Y0 + rnd() * (Y1 - Y0), r: 260 + rnd() * 420, s: Math.floor(rnd() * 3), a: 0.6 + rnd() * 0.4, rot: rnd() * 6.28 }));
  const banks = Array.from({ length: 16 }, () => ({ x: X0 + rnd() * (X1 - X0), y: Y0 + rnd() * (Y1 - Y0), r: 350 + rnd() * 500, s: Math.floor(rnd() * 2), a: 0.5 + rnd() * 0.5, rot: rnd() * 6.28 }));

  // scene metres -> screen (CSS px) as an affine matrix, from the map's projection and the current zoom
  function sceneMatrix() {
    const [ox, oy] = app.imageToScreen(0, 0), [sx] = app.imageToScreen(1000, 0), s = (sx - ox) / 1000;
    return [s * PX[0], s * PY[0], s * PX[1], s * PY[1], ox + s * PX[3], oy + s * PY[3]];
  }
  // wind: Open-Meteo gives where it blows FROM (deg); things move the other way. Screen direction of that.
  function windScreen() {
    const w = app.weather, d = ((w?.windDir ?? 270) + 180) * Math.PI / 180, ex = Math.sin(d), ny = Math.cos(d);
    const vx = PX[0] * ex + PX[1] * ny, vy = PY[0] * ex + PY[1] * ny, n = Math.hypot(vx, vy) || 1;
    return { ex, ny, sx: vx / n, sy: vy / n, kmh: w?.wind ?? 10 };
  }

  // precipitation particles live in screen space (it falls between you and the map)
  let drops = [];
  function resetParticles() {
    const w = app.weather;
    drops = [];
    if (!w || !W) return;
    const area = W * H, k = reduceMotion ? 0.45 : 1;
    let n = 0;
    if (w.kind === 'rain' || w.kind === 'storm') n = (area / 2200) * (0.15 + 0.85 * w.intensity);
    if (w.kind === 'snow') n = (area / 3000) * (0.2 + 0.8 * w.intensity);
    n = Math.min(900, Math.round(n * k));
    for (let i = 0; i < n; i++) drops.push({ x: Math.random() * W, y: Math.random() * H, z: Math.random(), p: Math.random() * 6.28 });
  }

  let raf = 0, last = 0, flash = 0, nextBolt = 0, dirty = true;
  viewer.addHandler('update-viewport', () => { dirty = true; if (!raf) kick(); });
  function kick() { if (!raf) raf = requestAnimationFrame(frame); }
  function frame(t) {
    raf = 0;
    const dt = Math.min(0.1, last ? (t - last) / 1000 : 0.016); last = t;
    const w = app.weather;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!w) return;
    const night = app.getNightLevel(), wind = windScreen();
    // clouds drift a bit faster than the ground wind (it's windier up there); a time-lapse speeds them up too
    const speed = (wind.kmh / 3.6) * 3 * clamp(app.isLive() ? 1 : app.getRate() / 60, 1, 40);
    const moving = !reduceMotion;
    const M = sceneMatrix().map((v, i) => v * dpr);

    // cloud shadows: strongest with broken cloud (sun between clouds), faint under full overcast, none at night
    const cover = (w.cloudCover ?? 0) / 100;
    const shadowK = cover < 0.15 ? 0 : (w.kind === 'clear' || w.kind === 'cloudy' ? sstep(0.15, 0.55, cover) * (1 - 0.6 * sstep(0.85, 1, cover)) : 0.25) * (1 - night);
    // (kept to the campus ground: the empty page around the map is sky now, see atmosphere.js)
    if (shadowK > 0.01) {
      ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0);
      if (app.groundPath?.(ctx, dpr)) ctx.clip();
      drawSheet(clouds, SHADOWS, M, wind, speed, dt, moving, 0.42 * shadowK, Math.round(clouds.length * clamp(cover + 0.15)));
      ctx.restore();
    }
    // fog: an even haze plus thicker banks rolling across campus
    if (w.kind === 'fog') {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = night > 0.5 ? `rgba(70,74,104,${0.28 * w.intensity})` : `rgba(236,236,240,${0.34 * w.intensity})`;
      ctx.fillRect(0, 0, cv.width, cv.height);
      drawSheet(banks, MIST, M, wind, speed * 0.25, dt, moving, (night > 0.5 ? 0.22 : 0.55) * w.intensity, banks.length);
    }
    // precipitation
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    if (w.kind === 'rain' || w.kind === 'storm') rain(w, wind, dt, moving, night);
    else if (w.kind === 'snow') snow(w, wind, dt, moving, night);
    // lightning: a quick double flicker every several seconds (never with reduced motion: no flashing)
    if (w.kind === 'storm' && moving) {
      if (t > nextBolt) { flash = 1; nextBolt = t + 3500 + Math.random() * 9000; }
      if (flash > 0) {
        const f = flash > 0.6 ? flash : flash > 0.4 ? 0.15 : flash * 0.9;
        ctx.fillStyle = `rgba(235,238,255,${(0.55 * f).toFixed(3)})`; ctx.fillRect(0, 0, W, H);
        flash = Math.max(0, flash - dt * 2.6);
      }
    }
    dirty = false;
    // keep animating only if something moves; reduced motion redraws only when the map moves
    const busy = moving && (drops.length || w.kind === 'fog' || shadowK > 0.01 || w.kind === 'storm');
    if (busy) raf = requestAnimationFrame(frame);
  }
  function drawSheet(list, sprites, M, wind, speed, dt, moving, alpha, count) {
    const sw = X1 - X0, sh = Y1 - Y0;
    ctx.globalAlpha = 1;
    for (let i = 0; i < count; i++) {
      const c = list[i];
      if (moving) { c.x += wind.ex * speed * dt; c.y += wind.ny * speed * dt; }
      c.x = X0 + ((((c.x - X0) % sw) + sw) % sw); c.y = Y0 + ((((c.y - Y0) % sh) + sh) % sh);
      // draw in scene metres: the projection squashes the round blob onto the isometric ground
      ctx.setTransform(M[0], M[1], M[2], M[3], M[0] * c.x + M[2] * c.y + M[4], M[1] * c.x + M[3] * c.y + M[5]);
      const sx = Math.abs(M[0] * c.r) + Math.abs(M[2] * c.r), sy = Math.abs(M[1] * c.r) + Math.abs(M[3] * c.r);
      const cx = M[0] * c.x + M[2] * c.y + M[4], cy = M[1] * c.x + M[3] * c.y + M[5];
      if (cx + sx < 0 || cy + sy < 0 || cx - sx > cv.width || cy - sy > cv.height) continue;
      ctx.globalAlpha = alpha * c.a;
      ctx.rotate(c.rot);
      ctx.drawImage(sprites[c.s % sprites.length], -c.r, -c.r, c.r * 2, c.r * 2);
    }
    ctx.globalAlpha = 1;
  }
  function rain(w, wind, dt, moving, night) {
    // slant follows the wind's left/right component on screen, more with stronger wind
    const slant = clamp(wind.kmh / 45) * 0.55 * Math.sign(wind.sx || 1) * Math.min(1, Math.abs(wind.sx) + 0.3);
    const len = 9 + 9 * w.intensity, v = 950 + 350 * w.intensity;
    ctx.lineCap = 'butt';
    // two passes: far drops thin and faint, near ones longer and brighter
    for (const [lo, hi, lw, col] of [[0, 0.65, 1, night > 0.5 ? 'rgba(165,180,235,.32)' : 'rgba(105,120,150,.30)'], [0.65, 1, 1.4, night > 0.5 ? 'rgba(200,210,250,.45)' : 'rgba(95,110,140,.42)']]) {
      ctx.beginPath();
      for (const d of drops) {
        if (d.z < lo || d.z >= hi) continue;
        const s = 0.7 + 0.5 * d.z, L = len * s;
        if (moving) {
          d.y += v * s * dt; d.x += v * s * dt * slant;
          if (d.y > H + L) { d.y = -L - Math.random() * 40; d.x = Math.random() * (W + 200) - 100; }
          if (d.x > W + 60) d.x -= W + 120; else if (d.x < -60) d.x += W + 120;
        }
        ctx.moveTo(d.x, d.y); ctx.lineTo(d.x - slant * L, d.y - L);
      }
      ctx.lineWidth = lw; ctx.strokeStyle = col; ctx.stroke();
    }
  }
  function snow(w, wind, dt, moving, night) {
    // little square flakes to match the pixel-art map; they sway and drift downwind
    const drift = clamp(wind.kmh / 40) * 40 * Math.sign(wind.sx || 1);
    ctx.fillStyle = night > 0.5 ? 'rgba(232,236,255,.85)' : 'rgba(255,255,255,.92)';
    ctx.beginPath();
    for (const d of drops) {
      const s = 1.4 + 1.8 * d.z;
      if (moving) {
        d.p += dt * (0.8 + d.z);
        d.y += (26 + 34 * d.z) * dt; d.x += (drift * (0.5 + d.z) + Math.sin(d.p) * 14) * dt;
        if (d.y > H + 4) { d.y = -4; d.x = Math.random() * W; }
        if (d.x > W + 4) d.x -= W + 8; else if (d.x < -4) d.x += W + 8;
      }
      ctx.rect(Math.round(d.x), Math.round(d.y), s, s);
    }
    ctx.fill();
    // a soft outline on day snow so white flakes still read on the pale map
    if (night <= 0.5) { ctx.strokeStyle = 'rgba(120,130,160,.25)'; ctx.lineWidth = 0.6; ctx.stroke(); }
  }
  size();

  app.helpSection('Weather and light', `<p>The sky follows Waterloo too. Live weather from <a href="https://open-meteo.com" target="_blank" rel="noopener">Open-Meteo</a>
    shows up next to the clock and on the map: rain slanting with the wind, snow drifting down, fog banks, thunderstorms, and cloud shadows sliding over campus on a part-cloudy day.
    Sunrise and sunset fade in gently: a golden hour as the sun gets low, a blue hour just after it sets, then the lights come on.
    Try <code>?weather=snow</code>, <code>rain</code>, <code>storm</code>, <code>fog</code> or <code>cloudy</code> in the address.</p>`);
});
