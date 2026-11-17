// sound.js: ambient campus sound, off by default (speaker button / M).
// Everything is synthesized with Web Audio (no files): a wind bed, rain hiss or snowy hush, thunder in storms,
// the ION crossing bells, geese honks, a traffic hum from the cars on screen, whooshes from passing buses and
// trains, and birds at dawn. What you hear follows what you see: details get louder as you zoom in and are
// panned left/right by where they are on screen. The AudioContext starts only from a click (autoplay policy)
// and is suspended while the tab is hidden.
onApp((app) => {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  const L = window.mapLife;
  const MASTER = 0.3;
  const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const rand = (a, b) => a + Math.random() * (b - a);

  // ---- control button ----
  const btn = document.createElement('button');
  btn.id = 'sound';
  btn.title = 'Ambient sound (M)';
  btn.setAttribute('aria-label', 'Ambient sound');
  btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z"/><g class="on"><path d="M15.5 9a4.2 4.2 0 0 1 0 6"/><path d="M18.2 6.5a8 8 0 0 1 0 11"/></g><g class="off"><path d="M16 9.5l5 5M21 9.5l-5 5"/></g></svg>`;
  document.head.insertAdjacentHTML('beforeend', '<style>#sound:not(.on) svg .on, #sound.on svg .off { display: none; }</style>');
  app.addControl(btn);

  let on = app.store.get('sound') === '1';
  let ctx = null, g = null; // g: the graph's nodes
  const show = () => { btn.classList.toggle('on', on); btn.setAttribute('aria-pressed', String(on)); btn.setAttribute('aria-label', on ? 'Mute ambient sound' : 'Ambient sound'); };
  show();

  function setOn(v) {
    on = v;
    app.store.set('sound', on ? '1' : '0');
    show();
    if (on) { ensure(); if (ctx && !document.hidden) ctx.resume(); }
    if (ctx) g.master.gain.setTargetAtTime(on ? MASTER : 0, ctx.currentTime, 0.4);
    if (ctx && !on) setTimeout(() => { if (!on && ctx.state === 'running') ctx.suspend(); }, 1500);
  }
  btn.onclick = () => setOn(!on);
  app.keys.m = () => setOn(!on);
  // remembered "on" from a previous visit: wait for the first gesture to actually start the audio
  if (on) {
    const arm = () => { removeEventListener('pointerdown', arm, true); removeEventListener('keydown', arm, true); if (on) { ensure(); ctx?.resume(); } };
    addEventListener('pointerdown', arm, true); addEventListener('keydown', arm, true);
  }
  document.addEventListener('visibilitychange', () => {
    if (!ctx) return;
    if (document.hidden) ctx.suspend(); else if (on) ctx.resume();
  });

  // ---- graph ----
  function noiseBuffer(kind) {
    const n = ctx.sampleRate * 3, buf = ctx.createBuffer(1, n, ctx.sampleRate), d = buf.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, last = 0;
    for (let i = 0; i < n; i++) {
      const w = Math.random() * 2 - 1;
      if (kind === 'pink') { // Paul Kellet's filter
        b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759; b2 = 0.969 * b2 + w * 0.153852;
        b3 = 0.8665 * b3 + w * 0.3104856; b4 = 0.55 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.016898;
        d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11; b6 = w * 0.115926;
      } else if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
      else d[i] = w;
    }
    // crossfade the loop seam
    const f = Math.floor(ctx.sampleRate * 0.05);
    for (let i = 0; i < f; i++) { const k = i / f; d[n - f + i] = d[n - f + i] * (1 - k) + d[i] * k; }
    return buf;
  }
  const loop = (buf, dest, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = buf; s.loop = true; s.playbackRate.value = rate; s.connect(dest); s.start(0, rand(0, 2.5)); return s; };
  const filt = (type, freq, Q = 0.7) => { const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = Q; return f; };
  const gain = (v = 0) => { const n = ctx.createGain(); n.gain.value = v; return n; };
  const chain = (...ns) => { for (let i = 0; i + 1 < ns.length; i++) ns[i].connect(ns[i + 1]); return ns[ns.length - 1]; };

  function ensure() {
    if (ctx) return;
    try { ctx = new AC(); } catch { return; }
    g = {};
    g.master = gain(0);
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.ratio.value = 3;
    chain(g.master, comp, ctx.destination);
    g.white = noiseBuffer('white'); g.pink = noiseBuffer('pink'); g.brown = noiseBuffer('brown');
    g.details = gain(0.5); g.details.connect(g.master); // one-shots: scaled by zoom

    // wind: brown + white noise through a slowly wandering low-pass
    g.wind = gain(0);
    g.windLP = filt('lowpass', 500, 0.9);
    loop(g.brown, g.windLP); loop(g.white, chain(gain(0.08), g.windLP));
    chain(g.windLP, g.wind, g.master);
    const lfo = ctx.createOscillator(), lfoAmt = gain(220);
    lfo.frequency.value = 0.07; chain(lfo, lfoAmt, g.windLP.frequency); lfo.start();
    const lfo2 = ctx.createOscillator(), lfo2Amt = gain(0.25);
    lfo2.frequency.value = 0.13; chain(lfo2, lfo2Amt, g.wind.gain); lfo2.start(); // gusts (wind.gain also gets a base value)
    g.gusts = lfo2Amt;

    // rain: pink hiss, band-limited; snow: a soft, very muffled hush
    g.rain = gain(0);
    loop(g.pink, chain(filt('highpass', 900), filt('lowpass', 7000), g.rain)); g.rain.connect(g.master);
    g.snow = gain(0);
    loop(g.pink, chain(filt('lowpass', 320), g.snow), 0.7); g.snow.connect(g.master);

    // traffic hum: low brown rumble with a hint of tyre noise
    g.traffic = gain(0);
    loop(g.brown, chain(filt('lowpass', 160), g.traffic), 0.8);
    loop(g.pink, chain(gain(0.15), filt('bandpass', 900, 0.6), g.traffic));
    g.traffic.connect(g.master);
  }

  // a stereo-panned one-shot output, positioned by screen x
  function out(sx, level) {
    const p = ctx.createStereoPanner ? ctx.createStereoPanner() : null, v = gain(level);
    if (p) { p.pan.value = clamp(((sx ?? innerWidth / 2) / innerWidth) * 2 - 1, -1, 1) * 0.7; chain(v, p, g.details); } else v.connect(g.details);
    setTimeout(() => { try { v.disconnect(); p?.disconnect(); } catch {} }, 8000);
    return v;
  }
  const env = (param, t, peak, attack, decay) => { param.setValueAtTime(0.0001, t); param.exponentialRampToValueAtTime(peak, t + attack); param.exponentialRampToValueAtTime(0.0001, t + attack + decay); };

  // ---- one-shot voices ----
  // crossing bell: a struck bell (inharmonic partials), "ding ding" for a few seconds
  function bells(sx, level, secs = 4) {
    const o = out(sx, level), t0 = ctx.currentTime + 0.05;
    for (let t = 0; t < secs; t += 0.5) {
      const t1 = t0 + t;
      [[1180, 1], [1180 * 2.76, 0.35], [1180 * 5.4, 0.12]].forEach(([f, a]) => {
        const osc = ctx.createOscillator(), v = gain(0);
        osc.type = 'sine'; osc.frequency.value = f;
        env(v.gain, t1, 0.22 * a, 0.004, 0.42);
        chain(osc, v, o); osc.start(t1); osc.stop(t1 + 0.5);
      });
    }
  }
  // Canada goose: nasal sawtooth through two formants, pitch falling, usually two calls
  function honk(sx, level) {
    const o = out(sx, level), t0 = ctx.currentTime + 0.02, n = Math.random() < 0.6 ? 2 : 1, base = rand(330, 420);
    for (let i = 0; i < n; i++) {
      const t = t0 + i * rand(0.2, 0.28), osc = ctx.createOscillator(), v = gain(0);
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(base * 1.12, t); osc.frequency.exponentialRampToValueAtTime(base * 0.78, t + 0.17);
      const f1 = filt('bandpass', 950, 5), f2 = filt('bandpass', 2300, 7), lp = filt('lowpass', 3200);
      const mix = gain(1);
      osc.connect(f1); osc.connect(f2); f1.connect(mix); chain(f2, gain(0.5), mix);
      env(v.gain, t, 0.5, 0.015, 0.17);
      chain(mix, lp, v, o); osc.start(t); osc.stop(t + 0.22);
    }
  }
  // thunder: a long low rumble with a crackly start
  function thunder(level) {
    const o = out(rand(0.2, 0.8) * innerWidth, level), t = ctx.currentTime + 0.05;
    const s = ctx.createBufferSource(); s.buffer = g.brown; s.playbackRate.value = 0.5;
    const lp = filt('lowpass', 900), v = gain(0);
    lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(90, t + 3);
    v.gain.setValueAtTime(0.0001, t); v.gain.exponentialRampToValueAtTime(1, t + 0.15);
    v.gain.setTargetAtTime(0.45, t + 0.4, 0.5); v.gain.exponentialRampToValueAtTime(0.0001, t + rand(4, 6.5));
    chain(s, lp, v, o); s.start(t, rand(0, 2)); s.stop(t + 7);
  }
  // a bus or train passing close: filtered noise swelling and sweeping
  function whoosh(sx, level) {
    const o = out(sx, level), t = ctx.currentTime + 0.02;
    const s = ctx.createBufferSource(); s.buffer = g.pink;
    const bp = filt('bandpass', 300, 0.9), v = gain(0);
    bp.frequency.setValueAtTime(260, t); bp.frequency.exponentialRampToValueAtTime(900, t + 0.8); bp.frequency.exponentialRampToValueAtTime(220, t + 1.8);
    v.gain.setValueAtTime(0.0001, t); v.gain.exponentialRampToValueAtTime(0.5, t + 0.8); v.gain.exponentialRampToValueAtTime(0.0001, t + 2);
    chain(s, bp, v, o); s.start(t, rand(0, 2)); s.stop(t + 2.1);
  }
  // dawn bird: a few quick sine chirps
  function birds(level) {
    const o = out(rand(0.1, 0.9) * innerWidth, level), t0 = ctx.currentTime + 0.05, n = Math.floor(rand(2, 6)), f0 = rand(2600, 3800);
    for (let i = 0; i < n; i++) {
      const t = t0 + i * rand(0.09, 0.16), osc = ctx.createOscillator(), v = gain(0);
      osc.frequency.setValueAtTime(f0 * rand(0.9, 1.05), t); osc.frequency.exponentialRampToValueAtTime(f0 * rand(1.2, 1.5), t + 0.06);
      env(v.gain, t, 0.12, 0.008, 0.07);
      chain(osc, v, o); osc.start(t); osc.stop(t + 0.1);
    }
  }

  // ---- what's on screen ----
  const weather = () => app.weather || {};
  const kindOf = () => String(weather().kind || '').toLowerCase();
  const toScreen = (x, y) => L?.api?.toScreen(x, y, 0);
  const onScreen = (s, m = 0) => s && s[0] > -m && s[1] > -m && s[0] < innerWidth + m && s[1] < innerHeight + m;
  // 0 at the centre of the screen, 1 at the far corner
  const offCentre = (s) => clamp(Math.hypot(s[0] - innerWidth / 2, s[1] - innerHeight / 2) / Math.hypot(innerWidth / 2, innerHeight / 2));

  app.on('honk', (e) => {
    if (!on || !ctx || ctx.state !== 'running') return;
    const s = e && e.x != null ? toScreen(e.x, e.y) : null;
    honk(s?.[0], s ? 0.55 * (1 - 0.6 * offCentre(s)) : 0.4);
  });

  const wasActive = new Map(), whooshAt = new Map();
  let nextThunder = 0, nextGoose = 0, nextBird = 0;
  setInterval(() => {
    if (!on || !ctx || ctx.state !== 'running' || document.hidden) return;
    const now = ctx.currentTime, k = L?.api?.pxPerM || 0.5;
    const detail = clamp((k - 0.5) / 3.5); // 0 = whole campus, 1 = street level
    const night = app.getNightLevel?.() || 0, w = weather(), kind = kindOf();
    const raining = /rain|drizzle|shower|storm|thunder/.test(kind), snowing = /snow|sleet|flurr/.test(kind), storm = /storm|thunder/.test(kind);
    const wind = clamp((+w.wind || 8) / 45); // km/h; a calm day still has a breath of air
    const T = 0.8;

    // beds
    const bed = (0.1 + 0.5 * wind) * (1 - 0.35 * night) * (snowing ? 0.7 : 1);
    g.wind.gain.setTargetAtTime(bed, now, T);
    g.gusts.gain.setTargetAtTime(bed * (0.25 + 0.4 * wind), now, T); // swing stays below the base: never inverts
    g.windLP.frequency.setTargetAtTime(350 + 700 * wind, now, T);
    g.rain.gain.setTargetAtTime(raining ? (storm ? 0.55 : 0.32) * (0.75 + 0.25 * detail) : 0, now, 1.5);
    g.snow.gain.setTargetAtTime(snowing ? 0.18 : 0, now, 1.5);
    g.details.gain.setTargetAtTime(0.25 + 0.75 * detail, now, 0.3);

    // traffic hum from the cars on screen (density-limited cars beyond the live count are parked off-sim)
    let cars = 0;
    if (L && k > 0.25) {
      const live = Math.round(L.cars.length * (L.getDensity?.() ?? 1));
      for (let i = 0; i < live; i++) { const p = L.poseOf(L.cars[i]); if (p && onScreen(toScreen(p.x, p.y), 40)) cars++; }
    }
    g.traffic.gain.setTargetAtTime(clamp(cars / 25) * (0.08 + 0.3 * detail) * (1 - 0.3 * night), now, T);

    if (!L || !L.isEnabled?.()) return;
    // ION crossing bells: on the rising edge of a road crossing that is on screen
    for (const c of L.api.crossings) {
      const was = wasActive.get(c); wasActive.set(c, c.active);
      if (!c.active || was || c.foot) continue;
      const s = toScreen(c.x, c.y);
      if (k > 0.6 && onScreen(s, 80)) bells(s[0], 0.5 * (1 - 0.7 * offCentre(s)) * (0.3 + 0.7 * detail), 4);
    }
    // a bus or train going past the middle of the screen, close up
    if (k > 2.2) for (const v of [...L.buses, ...L.trains]) {
      const p = L.poseOf(v); if (!p || (v.v || 0) < 3) continue;
      const s = toScreen(p.x, p.y);
      if (Math.hypot(s[0] - innerWidth / 2, s[1] - innerHeight / 2) > Math.min(innerWidth, innerHeight) * 0.22) continue;
      if (now - (whooshAt.get(v) || -99) < 10) continue;
      whooshAt.set(v, now); whoosh(s[0], 0.35 * detail);
    }
    // geese on screen at high zoom honk now and then
    if (k > 1.8 && now > nextGoose) {
      const vis = L.api.geese.filter((q) => onScreen(toScreen(q.x, q.y)));
      if (vis.length) { const q = vis[Math.floor(Math.random() * vis.length)], s = toScreen(q.x, q.y); honk(s[0], 0.4 * (1 - 0.5 * offCentre(s))); }
      nextGoose = now + rand(6, 18);
    }
    // birds around dawn
    const sun = app.sunElevation?.(app.now());
    if (sun > -5 && sun < 10 && !raining && !snowing && now > nextBird) {
      birds(0.3 * (0.4 + 0.6 * detail));
      nextBird = now + rand(2.5, 9);
    }
    if (storm && now > nextThunder) {
      if (nextThunder) thunder(rand(0.5, 0.9));
      nextThunder = now + rand(14, 40);
    }
  }, 250);

  app.helpSection('Sound', '<p>The speaker button (<kbd>M</kbd>) turns on ambient sound, all synthesized in your browser: wind, rain and snow from the live weather, the ION crossing bells, geese, traffic, and birds at dawn. Zoom in to hear more of the street.</p>');
  window.ambientSound = { setOn, isOn: () => on, ctx: () => ctx };
});
