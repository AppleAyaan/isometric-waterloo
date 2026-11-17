// Time-lapse: scrub or play a whole day in Waterloo time. A glass bar at the bottom centre with a 24-hour
// slider (painted with the day's sky, ticks at sunrise and sunset), play/pause, three speeds, a date picker
// (jump to exam season or frosh week) and "Live". Playing moves the map clock (app.setSimTime) and speeds
// traffic up (mapLife.setTimeScale, capped so cars still queue properly; the clock runs much faster than the sim).
// URL: ?date=2026-09-03T10:25 (Waterloo local) jumps there; ?timelapse plays on load (not with reduced motion).
onApp((app) => {
  const TZ = app.TZ, L = window.mapLife;
  const SPEEDS = [
    { label: '30 s', title: 'One day in 30 seconds', rate: 2880, scale: 20 },
    { label: '1 min', title: 'One day in a minute', rate: 1440, scale: 14 },
    { label: '2 min', title: 'One day in 2 minutes', rate: 720, scale: 8 },
  ];

  // ---------- Waterloo local time <-> Date ----------
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', hourCycle: 'h23' });
  function local(t) {
    const p = {};
    for (const x of fmt.formatToParts(t)) p[x.type] = +x.value;
    return { y: p.year, mo: p.month, d: p.day, h: p.hour % 24, mi: p.minute, s: p.second };
  }
  // the instant when Waterloo clocks read y-mo-d h:mi (two passes settle DST)
  function at(y, mo, d, h = 0, mi = 0) {
    const want = Date.UTC(y, mo - 1, d, h, mi);
    let t = want;
    for (let i = 0; i < 2; i++) { const l = local(new Date(t)); t += want - Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi, l.s); }
    return new Date(t);
  }
  const sameDay = (a, b) => a.y === b.y && a.mo === b.mo && a.d === b.d;
  const pad = (n) => String(n).padStart(2, '0');
  const isoDay = (D) => `${D.y}-${pad(D.mo)}-${pad(D.d)}`;
  const fmtTime = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hour12: true });
  const tidy = (s) => s.replace(/\s?([ap])\.?m\.?/i, (_, x) => ' ' + x.toUpperCase() + 'M');

  // ---------- UI ----------
  const css = document.createElement('style');
  css.textContent = `
    #tl { left: 50%; transform: translateX(-50%); bottom: calc(50px + var(--safe-b, 0px)); width: min(680px, calc(100vw - 32px)); z-index: 3;
      padding: 8px 10px; border-radius: 16px; display: none; align-items: center; gap: 10px; }
    #tl.open { display: flex; }
    #tl .tl-play { width: 36px; height: 36px; flex: none; border-radius: 11px; border: 0; background: var(--gold); color: #1f1c17; display: grid; place-items: center; cursor: pointer; }
    #tl .tl-play svg { width: 16px; height: 16px; }
    #tl .tl-play .pause, #tl.playing .tl-play .play { display: none; }
    #tl.playing .tl-play .pause { display: inline; }
    #tl .tl-when { display: flex; flex-direction: column; line-height: 1.15; flex: none; min-width: 74px; }
    #tl .tl-when b { font: 600 14px/1.2 Inter, system-ui, sans-serif; font-variant-numeric: tabular-nums; color: var(--ink); }
    #tl .tl-when input { font: 11px Inter, system-ui, sans-serif; color: var(--muted); background: none; border: 0; padding: 0; margin: 0; width: 100px; cursor: pointer; }
    :root[data-night] #tl .tl-when input { color-scheme: dark; }
    #tl .tl-track { position: relative; flex: 1; min-width: 120px; height: 36px; }
    #tl .tl-sky { position: absolute; left: 0; right: 0; top: 11px; height: 10px; border-radius: 5px; box-shadow: inset 0 0 0 1px rgba(0, 0, 0, .12); }
    #tl .tl-tick { position: absolute; top: 7px; width: 2px; height: 18px; margin-left: -1px; border-radius: 1px; background: var(--gold-deep); opacity: .8; pointer-events: none; }
    #tl .tl-hours { position: absolute; left: 0; right: 0; bottom: -1px; font-size: 9.5px; color: var(--muted); pointer-events: none; }
    #tl .tl-hours span { position: absolute; transform: translateX(-50%); }
    #tl input[type=range] { position: absolute; inset: 0 0 auto; width: 100%; height: 32px; margin: 0; background: none; -webkit-appearance: none; appearance: none; cursor: pointer; }
    #tl input[type=range]::-webkit-slider-runnable-track { height: 32px; background: none; }
    #tl input[type=range]::-moz-range-track { height: 32px; background: none; }
    #tl input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 16px; height: 22px; margin-top: 5px; border-radius: 6px; background: #fffdf6; border: 2px solid #1f1c17; box-shadow: 0 1px 4px rgba(0, 0, 0, .3); }
    #tl input[type=range]::-moz-range-thumb { width: 12px; height: 18px; border-radius: 6px; background: #fffdf6; border: 2px solid #1f1c17; box-shadow: 0 1px 4px rgba(0, 0, 0, .3); }
    #tl .tl-speed { display: flex; flex: none; gap: 2px; padding: 2px; border-radius: 10px; background: rgba(120, 100, 60, .1); }
    :root[data-night] #tl .tl-speed { background: rgba(255, 255, 255, .07); }
    #tl .tl-speed button { border: 0; background: none; color: var(--muted); font: 500 11.5px Inter, system-ui, sans-serif; padding: 5px 7px; border-radius: 8px; cursor: pointer; white-space: nowrap; }
    #tl .tl-speed button[aria-checked=true] { background: var(--gold); color: #1f1c17; }
    #tl .tl-live { flex: none; padding: 6px 10px; font-size: 12px; }
    #tl .tl-live i { display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: #3fbf6a; }
    @media (max-width: 600px) {
      #tl { left: 16px; right: 16px; width: auto; transform: none; flex-wrap: wrap; gap: 8px; padding: 8px; }
      #tl .tl-track { order: 5; flex-basis: 100%; }
      #tl .tl-when { flex: 1; }
    }
  `;
  document.head.appendChild(css);

  const bar = document.createElement('div');
  bar.id = 'tl';
  bar.className = 'chip';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Time-lapse');
  bar.innerHTML = `
    <button class="tl-play" title="Play / pause the day (P)" aria-label="Play the day">
      <svg class="play" viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l12.5-7.5z"/></svg>
      <svg class="pause" viewBox="0 0 24 24" fill="currentColor"><rect x="5.5" y="4.5" width="4.5" height="15" rx="1.2"/><rect x="14" y="4.5" width="4.5" height="15" rx="1.2"/></svg>
    </button>
    <div class="tl-when"><b class="tl-time" aria-live="off">--:--</b><input type="date" class="tl-date" aria-label="Day to show" title="Pick a day (exam season, frosh week…)"></div>
    <div class="tl-track">
      <div class="tl-sky"></div><div class="tl-ticks"></div>
      <div class="tl-hours"><span style="left:25%">6 AM</span><span style="left:50%">Noon</span><span style="left:75%">6 PM</span></div>
      <input type="range" min="0" max="1439" step="1" value="720" aria-label="Time of day in Waterloo">
    </div>
    <div class="tl-speed" role="radiogroup" aria-label="Speed">${SPEEDS.map((s, i) => `<button role="radio" aria-checked="false" data-i="${i}" title="${s.title}">${s.label}</button>`).join('')}</div>
    <button class="btn tl-live" title="Back to live Waterloo time"><i></i>Live</button>`;
  document.body.appendChild(bar);
  const $ = (s) => bar.querySelector(s);
  const playBtn = $('.tl-play'), timeEl = $('.tl-time'), dateEl = $('.tl-date'), range = $('input[type=range]'), sky = $('.tl-sky'), ticks = $('.tl-ticks');
  const speedBtns = [...bar.querySelectorAll('.tl-speed button')];

  const btn = document.createElement('button');
  btn.id = 'timelapse';
  btn.title = 'Time-lapse: play a day on campus (P)';
  btn.setAttribute('aria-label', 'Time-lapse');
  btn.setAttribute('aria-pressed', 'false');
  btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/><path d="M3.5 4.5v4h4" stroke-width="1.9"/></svg>';
  app.addControl(btn);

  // ---------- state ----------
  let open = false, playing = false, speed = Number(app.store.get('tlSpeed')) || 1, day = local(app.now()), dragging = false;
  if (!SPEEDS[speed]) speed = 1;

  // ---------- the day's sky on the slider ----------
  const mix = (a, b, k) => a.map((v, i) => Math.round(v + (b[i] - v) * Math.max(0, Math.min(1, k))));
  const NIGHT = [52, 46, 96], DUSK = [226, 132, 86], DAY = [250, 222, 140], NOON = [253, 240, 196];
  const skyAt = (e) => (e < -8 ? NIGHT : e < 0 ? mix(NIGHT, DUSK, (e + 8) / 8) : e < 8 ? mix(DUSK, DAY, e / 8) : mix(DAY, NOON, (e - 8) / 30));
  let paintedDay = '';
  function paintDay() {
    const id = isoDay(day);
    if (id === paintedDay) return;
    paintedDay = id;
    dateEl.value = id;
    const t0 = at(day.y, day.mo, day.d).getTime(), stops = [], marks = [];
    let prev = null;
    for (let m = 0; m <= 1440; m += 20) {
      const e = app.sunElevation(new Date(t0 + m * 60000));
      stops.push(`rgb(${skyAt(e).join(',')}) ${((m / 1440) * 100).toFixed(1)}%`);
      if (prev != null && (prev < -0.833) !== (e < -0.833)) {
        // narrow the crossing to the minute
        let lo = m - 20, hi = m;
        while (hi - lo > 1) { const mid = (lo + hi) >> 1; if ((app.sunElevation(new Date(t0 + mid * 60000)) < -0.833) === (prev < -0.833)) lo = mid; else hi = mid; }
        marks.push({ m: hi, rise: e > prev });
      }
      prev = e;
    }
    sky.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
    ticks.innerHTML = marks.map((k) => `<i class="tl-tick" style="left:${((k.m / 1440) * 100).toFixed(2)}%" title="${k.rise ? 'Sunrise' : 'Sunset'} ${tidy(fmtTime.format(new Date(t0 + k.m * 60000)))}"></i>`).join('');
  }

  // ---------- drive the clock ----------
  function apply() {
    const s = SPEEDS[speed];
    L?.setTimeScale(playing ? s.scale : 1);
    bar.classList.toggle('playing', playing);
    playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play the day');
    speedBtns.forEach((b, i) => b.setAttribute('aria-checked', String(i === speed)));
  }
  const minuteOfShown = () => { const l = local(app.now()); return sameDay(l, day) ? l.h * 60 + l.mi + l.s / 60 : Number(range.value); };
  function setMinute(m, rate) {
    m = Math.max(0, Math.min(1439.9, m));
    app.setSimTime(new Date(at(day.y, day.mo, day.d).getTime() + m * 60000), rate);
    sync();
  }
  function play(on) {
    playing = on;
    // pick up from wherever the map clock is (if it's on the shown day), else from the top of the day
    const m = minuteOfShown();
    setMinute(m >= 1439 ? 0 : m, playing ? SPEEDS[speed].rate : 1);
    apply();
    if (playing) requestAnimationFrame(frame);
  }
  function sync() {
    const now = app.now(), l = local(now);
    if (playing && !sameDay(l, day)) {
      // loop the day: back to midnight of the shown day, keeping the overshoot
      const over = (now.getTime() - at(day.y, day.mo, day.d).getTime()) % 86400000;
      app.setSimTime(new Date(at(day.y, day.mo, day.d).getTime() + Math.max(0, over)), SPEEDS[speed].rate);
      return;
    }
    if (!playing && !sameDay(l, day)) { day = { y: l.y, mo: l.mo, d: l.d }; }
    paintDay();
    if (!dragging) range.value = String(l.h * 60 + l.mi);
    timeEl.textContent = tidy(fmtTime.format(now));
    range.setAttribute('aria-valuetext', timeEl.textContent);
  }
  function frame() {
    if (!playing || !open) return;
    sync();
    requestAnimationFrame(frame);
  }

  // ---------- open / close ----------
  function setOpen(on) {
    open = on;
    bar.classList.toggle('open', on);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    if (on) { day = local(app.now()); paintedDay = ''; sync(); place(); }
    else if (playing) { playing = false; if (!app.isLive()) app.setSimTime(app.now(), 1); apply(); }
  }
  // keep clear of the building card: if they'd overlap, ride just above it
  const card = document.getElementById('card');
  function place() {
    if (!open) return;
    bar.style.bottom = '';
    if (!card || getComputedStyle(card).display === 'none') return;
    const a = bar.getBoundingClientRect(), c = card.getBoundingClientRect();
    if (c.width && a.right > c.left && a.left < c.right && a.bottom > c.top) bar.style.bottom = `${Math.round(innerHeight - c.top + 10)}px`;
  }
  if (card) new MutationObserver(place).observe(card, { attributes: true, attributeFilter: ['style', 'class'], childList: true, subtree: true });
  addEventListener('resize', place);

  // ---------- wiring ----------
  btn.onclick = () => { app.stopTour?.(); setOpen(!open); };
  playBtn.onclick = () => play(!playing);
  speedBtns.forEach((b) => (b.onclick = () => {
    speed = Number(b.dataset.i); app.store.set('tlSpeed', String(speed));
    if (playing) app.setSimTime(app.now(), SPEEDS[speed].rate);
    apply();
  }));
  range.addEventListener('input', () => { dragging = true; setMinute(Number(range.value), playing ? SPEEDS[speed].rate : 1); });
  range.addEventListener('change', () => { dragging = false; sync(); });
  range.addEventListener('pointerup', () => { dragging = false; });
  dateEl.addEventListener('change', () => {
    const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(dateEl.value);
    if (!m) return;
    const keep = minuteOfShown();
    day = { y: +m[1], mo: +m[2], d: +m[3] };
    setMinute(keep, playing ? SPEEDS[speed].rate : 1);
  });
  $('.tl-live').onclick = () => {
    playing = false; apply();
    app.setSimTime(null);
    app.emit('timechange'); // our own listener closes the bar; the calendar resets too
  };
  // "Follow live" in the clock (or the night button) took the clock back: reset
  app.on('timechange', () => { playing = false; L?.setTimeScale(1); apply(); if (open) setOpen(false); });
  app.onTick(() => { if (open && !playing) sync(); });
  app.keys.p = () => {
    if (!open) { setOpen(true); play(true); }
    else play(!playing);
  };
  apply();

  // ---------- ?date=YYYY-MM-DDTHH:MM and ?timelapse ----------
  const q = new URLSearchParams(location.search);
  const dm = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d?):(\d\d))?/.exec(q.get('date') || '');
  if (dm) {
    const t = at(+dm[1], +dm[2], +dm[3], dm[4] != null ? +dm[4] : 12, dm[5] != null ? +dm[5] : 0);
    if (!isNaN(t)) app.setSimTime(t, 1);
  }
  if (q.has('timelapse')) {
    setOpen(true);
    if (!app.reduceMotion) play(true);
  }

  app.helpSection('Time-lapse', `<p>Press <kbd>P</kbd> (or the clock button) to play a whole day in Waterloo time: rush hours, class changes, dusk and the night lights. Drag the slider to scrub, pick a day to visit exam season or frosh week, and hit <b>Live</b> to come back. Share a moment with <code>?date=2026-09-03T10:25</code>, or add <code>&amp;timelapse</code> to play on open.</p>`);
});
