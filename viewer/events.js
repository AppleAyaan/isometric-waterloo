// Campus calendar + daily rhythm. Everything runs off the map clock (app.now(), Waterloo time), so the
// time-lapse sweeps through rush hours, class changes, frosh week, exams and convocation.
// - traffic density follows the hour, the weekday and the term (mapLife.setDensity)
// - students pour out between buildings at UW class changes (MWF classes end at :20, TTh at 9:50, 11:20…)
// - events: orientation week (stage near the SLC, gold & black crowds), homecoming at Warrior Field,
//   convocation outside the PAC (gowns + mortarboards), exam season (libraries lit late, 2 am walkers),
//   reading weeks and winter break (quiet)
// - a "today on campus" line in the clock chip when something is on
// The dates are rules (nth weekday of a month, fixed windows), so they work every year. Approximate, not official.
onApp((app) => {
  const L = window.mapLife;
  const TZ = app.TZ;

  // ---------- Waterloo local time ----------
  const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short', hourCycle: 'h23' });
  const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  function local(t) {
    const p = {};
    for (const x of fmt.formatToParts(t)) p[x.type] = x.value;
    const h = +p.hour % 24, mi = +p.minute;
    return { y: +p.year, mo: +p.month, d: +p.day, h, mi, wd: WD[p.weekday], mins: h * 60 + mi, key: +p.month * 100 + +p.day };
  }
  // day of the month of the nth (1-based; -1 = last) weekday wd in month mo
  const dow = (y, mo, d) => new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
  const daysIn = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();
  function nthWd(y, mo, wd, n) {
    if (n > 0) return 1 + ((wd - dow(y, mo, 1) + 7) % 7) + (n - 1) * 7;
    const last = daysIn(y, mo);
    return last - ((dow(y, mo, last) - wd + 7) % 7);
  }

  // ---------- the calendar (rules-based, approximate UW dates) ----------
  // phase: classes | exams | study | reading | break | holiday | off. Events carry what the pill says.
  const calCache = new Map();
  function calendar(y, mo, d) {
    const id = y * 10000 + mo * 100 + d;
    if (calCache.has(id)) return calCache.get(id);
    const k = mo * 100 + d, wd = dow(y, mo, d), events = [];
    const season = mo <= 4 ? 'winter' : mo <= 8 ? 'spring' : 'fall';
    let phase = 'off';
    if (k >= 1223 || k <= 104) phase = 'break';
    else if (k <= 407) phase = 'classes';
    else if (k <= 409) phase = 'study';
    else if (k <= 426) phase = 'exams';
    else if (k <= 504) phase = 'off';
    else if (k <= 728) phase = 'classes';
    else if (k <= 802) phase = 'study';
    else if (k <= 817) phase = 'exams';
    else if (k <= 902) phase = 'off';
    else if (k <= 1204) phase = 'classes';
    else if (k <= 1207) phase = 'study';
    else phase = 'exams';
    // reading weeks: Family Day week (Feb) and Thanksgiving week (Oct), Monday to Friday
    const fam = nthWd(y, 2, 1, 3), thx = nthWd(y, 10, 1, 2);
    if ((mo === 2 && d >= fam && d <= fam + 4) || (mo === 10 && d >= thx && d <= thx + 4)) phase = 'reading';
    // statutory holidays: campus closed, weekend rhythm
    const vic = nthWd(y, 5, 1, -1) - (nthWd(y, 5, 1, -1) >= 25 ? 7 : 0); // Monday before May 25
    const hol = (mo === 1 && d === 1) || (mo === 5 && d === vic) || (mo === 7 && d === 1) || (mo === 8 && d === nthWd(y, 8, 1, 1)) ||
      (mo === 9 && d === nthWd(y, 9, 1, 1)) || (mo === 10 && d === thx) || (mo === 2 && d === fam);
    if (hol && phase !== 'break') phase = 'holiday';
    // events
    if (mo === 9 && d <= 7) events.push({ id: 'frosh', label: 'Orientation week', sub: 'Welcome, first-years!' });
    const hc = nthWd(y, 9, 6, -1); // homecoming: last Saturday of September
    if (mo === 9 && d === hc) events.push({ id: 'homecoming', label: 'Homecoming', sub: 'Warriors football at Warrior Field' });
    const jc = nthWd(y, 6, 3, 2); // spring convocation: 2nd Wednesday of June to that Saturday
    const oc = nthWd(y, 10, 5, 4); // fall convocation: 4th Friday of October + Saturday
    if ((mo === 6 && d >= jc && d <= jc + 3) || (mo === 10 && (d === oc || d === oc + 1))) events.push({ id: 'convocation', label: 'Convocation', sub: 'Gowns outside the PAC' });
    if (phase === 'exams') events.push({ id: 'exams', label: 'Exam season', sub: 'DC and DP open late' });
    if (phase === 'reading') events.push({ id: 'reading', label: 'Reading week', sub: 'Campus is quiet' });
    if (phase === 'break') events.push({ id: 'break', label: 'Winter break', sub: 'Campus is nearly empty' });
    const cal = { season, phase, events, weekend: wd === 0 || wd === 6, wd, term: phase === 'classes' && wd >= 1 && wd <= 5 };
    if (calCache.size > 400) calCache.clear();
    calCache.set(id, cal);
    return cal;
  }

  // ---------- daily rhythm: what fraction of the cars are on the road ----------
  const WEEKDAY = [[0, 0.15], [1, 0.1], [2, 0.08], [5, 0.09], [6, 0.25], [7, 0.6], [8, 1], [9.5, 0.95], [10.5, 0.6], [12, 0.8], [13, 0.75], [14, 0.6], [16, 0.72], [16.5, 0.95], [18, 0.95], [19, 0.6], [21, 0.4], [23, 0.22], [24, 0.15]];
  const WEEKEND = [[0, 0.18], [2, 0.12], [3, 0.08], [7, 0.1], [9, 0.28], [11, 0.48], [13, 0.58], [16, 0.55], [18, 0.48], [20, 0.38], [22, 0.28], [24, 0.18]];
  const curve = (C, h) => { for (let i = 1; i < C.length; i++) if (h <= C[i][0]) { const [h0, v0] = C[i - 1], [h1, v1] = C[i]; return v0 + ((v1 - v0) * (h - h0)) / (h1 - h0); } return C[0][1]; };
  function densityFor(t, cal) {
    const h = t.mins / 60, quiet = cal.weekend || cal.phase === 'holiday';
    let k = curve(quiet ? WEEKEND : WEEKDAY, h);
    if (cal.phase === 'break') k *= 0.45;
    else if (cal.phase === 'holiday') k *= 0.85;
    else if (cal.phase === 'reading' || cal.phase === 'off') k *= 0.8;
    else if (cal.phase === 'exams' && h < 5) k += 0.06; // students heading home after the library closes
    const ev = new Set(cal.events.map((e) => e.id));
    if (ev.has('homecoming') && h > 10 && h < 18) k = Math.max(k, 0.85);
    if (ev.has('convocation') && h > 8.5 && h < 17) k = Math.min(1, k + 0.15);
    if (ev.has('frosh') && h > 8 && h < 22) k = Math.min(1, k + 0.1);
    return Math.max(0.08, Math.min(1, k));
  }

  // ---------- UW class changes ----------
  // MWF classes run :30 to :20; TTh are 80 minutes (8:30-9:50, 10:00-11:20 … 7:00-8:20 pm). The crowd builds
  // over 2 minutes after a class ends and thins out by the next start, 10 minutes later.
  const MWF_ENDS = []; for (let h = 9; h <= 21; h++) MWF_ENDS.push(h * 60 + 20);
  const TTH_ENDS = [9 * 60 + 50, 11 * 60 + 20, 12 * 60 + 50, 14 * 60 + 20, 15 * 60 + 50, 17 * 60 + 20, 18 * 60 + 50, 20 * 60 + 20, 21 * 60 + 50];
  function classChange(t, cal) {
    if (!cal.term) return 0;
    const ends = t.wd === 2 || t.wd === 4 ? TTH_ENDS : MWF_ENDS, m = t.mins;
    for (const e of ends) { const u = m - e; if (u >= 0 && u < 10) return u < 2 ? 0.3 + u * 0.35 : u < 7 ? 1 : (10 - u) / 3; }
    if (m >= 8 * 60 + 5 && m < 8 * 60 + 30) return 0.75; // morning arrivals for the 8:30s
    return 0;
  }

  // ---------- buildings on the ground ----------
  const ACAD = { MC: 3, DC: 3, STC: 3, RCH: 2.5, AL: 2.5, QNC: 2, SLC: 2.5, LIB: 2, EIT: 1.5, PHY: 1.5, B1: 1, B2: 1, ESC: 1.5, C2: 1, M3: 2, E2: 1.5, E3: 1.5, E5: 2, E6: 1, PSE: 1, CPH: 1.5, DWE: 1, HH: 2, ML: 1.5, EV1: 1.5, EV3: 1, PAS: 1.5, TC: 1, NH: 0.5, AHS: 1, BMH: 1, LHI: 1, PAC: 1 };
  const HOMES = { V1: 3, REV: 3, MKV: 2, STJ: 1, REN: 1, CGR: 1 };
  const [PX, PY] = app.life?.projection || [[0, 0, 0, 0], [0, 0, 0, 0]];
  // an image point h metres up, back down to the ground, in scene metres
  const ground = (ix, iy, h) => app.imageToScene(ix - PX[2] * h, iy - PY[2] * h);
  function place(ref) {
    const bs = app.byRef.get(ref);
    if (!bs || !app.life) return null;
    let sx = 0, sy = 0, n = 0, r = 0;
    for (const b of bs) {
      // outlines are the visible silhouette: invert at mid-height for a fair centre (as latLon does)
      const c = app.center(b), h = (b.height || 8) / 2;
      const [x, y] = ground((c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2, h);
      sx += x; sy += y; n++;
      r = Math.max(r, ((c.x1 - c.x0) / Math.hypot(PX[0], PX[1])) * 0.35);
    }
    return { ref, x: sx / n, y: sy / n, r: Math.min(30, Math.max(6, r)) };
  }
  const acad = Object.entries(ACAD).map(([ref, w]) => ({ ...place(ref), w })).filter((p) => p.ref && p.x != null);
  const homes = Object.entries(HOMES).map(([ref, w]) => ({ ...place(ref), w })).filter((p) => p.ref && p.x != null);
  const byRef = Object.fromEntries([...acad, ...homes].map((p) => [p.ref, p]));
  const pickW = (arr) => { let s = 0; for (const a of arr) s += a.w; let r = Math.random() * s; for (const a of arr) if ((r -= a.w) <= 0) return a; return arr[0]; };
  const field = (name) => app.life?.fields?.find((f) => f.name === name);

  // ---------- people ----------
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const SKIN = L?.api.SKIN || ['#f1c9a5', '#e0ac85', '#c68863', '#8d5a3b', '#5e3b27', '#f5d6bd'];
  const SHIRTS = L?.api.SHIRTS || ['#e74c3c', '#3498db', '#f1c40f', '#2ecc71', '#9b59b6', '#ecf0f1'];
  const PANTS = ['#2d3436', '#34495e', '#5d4e37', '#1e3799', '#636e72'];
  const K = L?.api.PEOPLE_SCALE || 1.5;
  const MAX = 150;
  const people = [];
  const shared = () => (Array.isArray(L?.api.people) ? L.api.people : null);
  function person(group, look = {}) {
    const p = { type: 'student', group, H: rand(1.6, 1.85) * K, shirt: pick(SHIRTS), pants: pick(PANTS), skin: pick(SKIN), v: 0, phase: rand(0, 6), hx: 1, hy: 0, x: 0, y: 0, ...look };
    people.push(p);
    shared()?.push(p);
    return p;
  }
  function drop(p) {
    const i = people.indexOf(p); if (i >= 0) people.splice(i, 1);
    const s = shared(), j = s ? s.indexOf(p) : -1; if (j >= 0) s.splice(j, 1);
  }
  // walk from a to b with a gentle bend, spread sideways so a crowd doesn't move in single file
  function route(p, a, b, u0 = 0) {
    const ax = a.x + rand(-1, 1) * a.r * 0.5, ay = a.y + rand(-1, 1) * a.r * 0.5, bx = b.x + rand(-1, 1) * b.r * 0.5, by = b.y + rand(-1, 1) * b.r * 0.5;
    const dx = bx - ax, dy = by - ay, d = Math.hypot(dx, dy) || 1, bend = rand(-0.18, 0.18) * d;
    const mx = (ax + bx) / 2 - (dy / d) * bend, my = (ay + by) / 2 + (dx / d) * bend;
    const l1 = Math.hypot(mx - ax, my - ay), l2 = Math.hypot(bx - mx, by - my);
    Object.assign(p, { mode: 'walk', pts: [ax, ay, mx, my, bx, by], l1, len: l1 + l2, s: u0 * (l1 + l2), pace: rand(1.15, 1.6), leaving: false });
    posOnRoute(p);
  }
  function posOnRoute(p) {
    const [ax, ay, mx, my, bx, by] = p.pts;
    let x0, y0, x1, y1, u;
    if (p.s < p.l1) { x0 = ax; y0 = ay; x1 = mx; y1 = my; u = p.s / (p.l1 || 1); }
    else { x0 = mx; y0 = my; x1 = bx; y1 = by; u = (p.s - p.l1) / (p.len - p.l1 || 1); }
    const L2 = Math.hypot(x1 - x0, y1 - y0) || 1;
    p.hx = (x1 - x0) / L2; p.hy = (y1 - y0) / L2;
    p.x = x0 + (x1 - x0) * u; p.y = y0 + (y1 - y0) * u;
  }
  // milling around a spot (an event crowd): short strolls, long pauses, facing `face` when idle
  function mill(p, spot, scatter) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * spot.r;
    Object.assign(p, { mode: 'mill', spot, tx: spot.x + Math.cos(a) * r, ty: spot.y + Math.sin(a) * r, wait: rand(2, 10), pace: rand(0.5, 0.9), leaving: false });
    if (scatter || p.x === 0) { p.x = p.tx; p.y = p.ty; p.wait = rand(0, 8); }
    if (spot.face && p.wait > 0) { const dx = spot.face[0] - p.x, dy = spot.face[1] - p.y, d = Math.hypot(dx, dy) || 1; p.hx = dx / d; p.hy = dy / d; }
  }

  // ---------- event spots (scene metres) ----------
  // frosh stage: on the green between the SLC and Village 1 (the grassy "Village green" in traffic.json)
  const slc = byRef.SLC, v1 = byRef.V1, pac = byRef.PAC;
  const green = (() => {
    const gs = (app.life?.geeseAreas || []).filter((a) => !a.water && slc);
    let best = null, bd = Infinity;
    for (const a of gs) { const [x, y] = a.pts[0]; const d = Math.hypot(x - slc.x, y - slc.y); if (d < bd && d > 25) { bd = d; best = [x, y]; } }
    return best && bd < 220 ? best : slc ? [slc.x - 70, slc.y - 60] : null;
  })();
  const stage = green && { x: green[0], y: green[1], hx: 0.8, hy: -0.6 };
  const wf = field('Warrior Field');
  const SPOTS = {
    frosh: stage && { x: stage.x + stage.hx * 14, y: stage.y + stage.hy * 14, r: 14, face: [stage.x, stage.y] },
    // homecoming: crowds along the sideline of Warrior Field
    homecoming: wf && { x: wf.x - wf.uy * (wf.wid / 2 + 7), y: wf.y + wf.ux * (wf.wid / 2 + 7), r: 18, face: [wf.x, wf.y] },
    convocation: pac && { x: pac.x - 35, y: pac.y - 12, r: 16, face: null },
  };
  const LOOKS = {
    frosh: () => (Math.random() < 0.12 ? { shirt: '#6c3fa0', pants: '#2d3436' } : { shirt: pick(['#fed34c', '#fed34c', '#f2c230', '#1f1c17', '#26221c']), pants: pick(['#1f1c17', '#2d3436', '#34495e']) }),
    homecoming: () => ({ shirt: pick(['#fed34c', '#f2c230', '#1f1c17', '#fed34c', ...SHIRTS]) }),
    convocation: () => (Math.random() < 0.6 ? { shirt: '#1d1b22', pants: '#1d1b22', gown: true, cap: Math.random() < 0.6 } : {}),
  };

  // ---------- what campus wants right now ----------
  const state = { cal: null, t: null, targets: {}, examNight: false, density: 1, ev: null };
  function wants(t, cal) {
    const h = t.mins / 60, day = h >= 7.5 && h < 19, eve = h >= 19 && h < 23;
    const ev = new Set(cal.events.map((e) => e.id)), T = {};
    let amb = cal.phase === 'break' ? (day ? 3 : 0) : cal.weekend || cal.phase === 'holiday' ? (day ? 9 : eve ? 4 : 1)
      : cal.phase === 'classes' ? (day ? 20 : eve ? 9 : 2) : day ? 12 : eve ? 5 : 1;
    if (cal.phase === 'reading') amb = Math.round(amb * 0.5);
    if (cal.phase === 'exams' && (h >= 22 || h < 4)) amb += h >= 1.5 && h < 3.5 ? 6 : 4; // the 2 am library run
    if (h >= 11.75 && h < 13.25 && cal.phase === 'classes' && !cal.weekend) amb += 12; // lunch at the SLC
    T.walk = amb + Math.round(classChange(t, cal) * 110);
    if (ev.has('frosh') && SPOTS.frosh && h >= 9.5 && h < 23) T.frosh = h >= 19 ? 70 : 50;
    if (ev.has('homecoming') && SPOTS.homecoming && h >= 10.5 && h < 17.5) T.homecoming = 55;
    if (ev.has('convocation') && SPOTS.convocation && h >= 9 && h < 17 && !(h >= 12.5 && h < 13.5)) T.convocation = 45;
    // stay under the cap: event crowds first, walkers get what's left
    const fixed = (T.frosh || 0) + (T.homecoming || 0) + (T.convocation || 0);
    T.walk = Math.min(T.walk, MAX - fixed);
    return T;
  }

  // ---------- population: spawn towards targets, let extras finish their walk ----------
  let lastT = 0;
  function populate() {
    const now = app.now(), ms = now.getTime(), rate = app.isLive() ? 1 : app.getRate();
    const jumped = lastT && Math.abs(ms - lastT) > 15 * 60000 * Math.max(1, rate / 60);
    const fast = rate > 30 || jumped;
    lastT = ms;
    if (jumped) for (const p of [...people]) drop(p);
    const T = state.targets;
    const count = {};
    for (const p of people) if (!p.leaving) count[p.group] = (count[p.group] || 0) + 1;
    for (const g of ['walk', 'frosh', 'homecoming', 'convocation']) {
      const want = T[g] || 0, have = count[g] || 0;
      if (have < want && people.length < MAX && acad.length > 1) {
        // a live class change floods out a few at a time; the time-lapse fills in at once
        const n = Math.min(want - have, MAX - people.length, fast ? 999 : g === 'walk' ? 8 : 3);
        for (let i = 0; i < n; i++) spawn(g, fast);
      } else if (have > want) {
        let extra = have - want;
        for (const p of people) {
          if (!extra) break;
          if (p.group !== g || p.leaving) continue;
          extra--;
          if (fast || p.mode !== 'mill') { if (fast) drop(p); else p.leaving = true; continue; }
          // event crowd heads off to a nearby building
          route(p, { x: p.x, y: p.y, r: 0 }, pickW(acad)); p.leaving = true;
        }
      }
    }
  }
  function spawn(g, fast) {
    if (g !== 'walk') { const p = person(g, LOOKS[g]()); mill(p, SPOTS[g], true); return; }
    const t = state.t, cal = state.cal, h = t.mins / 60;
    let a = pickW(acad), b;
    // mornings: from residences to class; late afternoon / night: back home; lunch: towards the SLC
    if (homes.length && (h < 9 || (cal.phase === 'exams' && h < 5))) { a = pickW(homes); b = pickW(acad); if (h < 5) [a, b] = [byRef[pick(['LIB', 'DC'])] || a, pickW(homes)]; }
    else if (homes.length && h >= 17 && Math.random() < 0.6) b = pickW(homes);
    else if (h >= 11.75 && h < 13.25 && slc && Math.random() < 0.5) b = slc;
    for (let i = 0; i < 8 && (!b || b === a || Math.hypot(b.x - a.x, b.y - a.y) < 50 || Math.hypot(b.x - a.x, b.y - a.y) > 420); i++) b = pickW(acad);
    if (!b || b === a) b = acad.find((c) => c !== a);
    const p = person('walk');
    route(p, a, b, fast ? Math.random() : 0);
  }

  // ---------- library glows during exam nights ----------
  // Warm windows on the camera-facing walls of Dana Porter and the Davis Centre (plus MC and QNC's study
  // spaces), picked once so they don't flicker. Outlines are the building's whole silhouette in image px and
  // the vertical is pure image-y, so the lowest silhouette point in a column is the foot of the near wall:
  // a window z metres up sits PY[2]*z above it.
  const windows = [];
  for (const ref of ['LIB', 'DC', 'MC', 'QNC']) {
    for (const b of app.byRef.get(ref) || []) {
      if (!app.life || !b.outlines) continue;
      const c = app.center(b), h = b.height || 8, lit = ref === 'LIB' || ref === 'DC' ? 0.45 : 0.25;
      for (let ix = c.x0 + 6; ix < c.x1 - 6; ix += 12) {
        let foot = -Infinity;
        for (const o of b.outlines) for (let i = 0; i < o.length; i++) {
          const [x0, y0] = o[i], [x1, y1] = o[(i + 1) % o.length];
          if ((x0 <= ix) === (x1 <= ix)) continue;
          foot = Math.max(foot, y0 + ((y1 - y0) * (ix - x0)) / (x1 - x0));
        }
        if (foot === -Infinity) continue;
        const [x, y] = app.imageToScene(ix, foot - 2); // just inside the wall
        for (let z = 2.2; z < h - 1; z += 3.6) if (Math.random() < lit) windows.push({ x, y, z, a: rand(0.5, 1) });
      }
    }
  }
  windows.splice(160);

  // ---------- the map layer ----------
  let acc = 0;
  if (L) L.addLayer({
    step(dt) {
      acc += dt;
      for (const p of people) {
        if (p.mode === 'walk') {
          p.v = p.pace; p.s += p.pace * dt; p.phase += p.pace * dt * 5.5;
          if (p.s >= p.len) {
            if (p.leaving || p.group === 'walk') { drop(p); continue; }
            mill(p, SPOTS[p.group] || { x: p.x, y: p.y, r: 4 });
          } else posOnRoute(p);
        } else if (p.mode === 'mill') {
          if (p.wait > 0) { p.wait -= dt; p.v = 0; if (p.spot.face && p.wait <= 0 && Math.random() < 0.3) p.wait = rand(2, 6); continue; }
          const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy);
          if (d < 0.3) { mill(p, p.spot); continue; }
          p.hx = dx / d; p.hy = dy / d; p.v = p.pace;
          const m = Math.min(d, p.pace * dt); p.x += p.hx * m; p.y += p.hy * m; p.phase += p.pace * dt * 5.5;
        }
      }
    },
    collect(add, api) {
      if (api.pxPerM < 0.7) return;
      for (const p of people) add(p.x, p.y, (q, small) => drawPerson(p, api, small), p, {});
      if (state.ev?.has('frosh') && stage) add(stage.x, stage.y, () => drawStage(api), null, {});
    },
    overlay(ctx, api) {
      if (!state.examNight || api.night < 0.3 || api.pxPerM < 0.35 || !windows.length) return;
      ctx.globalCompositeOperation = 'lighter';
      const r = Math.max(2, api.pxPerM * 1.7), k = api.night * (api.small ? 0.5 : 0.75);
      for (const w of windows) api.glow([w.x, w.y, w.z], r, '255,196,110', w.a * k);
    },
  });
  function drawPerson(p, api, small) {
    api.drawFigure(p, p.x, p.y, p.hx, p.hy, small);
    if (small || !p.cap) return;
    // a mortarboard: a flat black square on the head, turned 45 degrees to the gown
    const P = api.prism(p.x, p.y, (p.hx - p.hy) * 0.707, (p.hy + p.hx) * 0.707, 0.42 * K, 0.42 * K, p.H * 1.0, p.H * 1.0 + 0.05 * K);
    api.paint(P, { side: '#111', top: '#1d1b22' });
  }
  // the orientation stage: a dark deck under a white tent with a gold roof band, two speaker stacks
  function drawStage(api) {
    const { x, y, hx, hy } = stage, nx = -hy, ny = hx;
    api.shadow(x, y, hx, hy, 9, 12, 0.25);
    api.paint(api.prism(x, y, hx, hy, 7, 10, 0, 1.0), { side: '#2b2622', top: '#3a332c' });
    for (const s of [1, -1]) {
      const px = x + nx * 5.4 * s, py = y + ny * 5.4 * s;
      api.paint(api.prism(px, py, hx, hy, 0.25, 0.25, 0, 4.2), { side: '#e8e4dc', top: '#f4f1ea' });
      api.paint(api.prism(px + hx * 2.6, py + hy * 2.6, hx, hy, 0.25, 0.25, 0, 4.2), { side: '#e8e4dc', top: '#f4f1ea' });
      api.paint(api.prism(x + hx * 3.8 + nx * 4.6 * s, y + hy * 3.8 + ny * 4.6 * s, hx, hy, 0.9, 0.9, 0, 1.9), { side: '#141414', top: '#222' });
    }
    api.paint(api.prism(x - hx * 1.2, y - hy * 1.2, hx, hy, 3.6, 10.8, 4.2, 4.7), { side: '#fed34c', top: '#fdf8ec' });
    api.paint(api.prism(x - hx * 1.2, y - hy * 1.2, hx, hy, 3.0, 9.6, 4.7, 5.3), { side: '#f4f1ea', top: '#fdf8ec' });
  }

  // ---------- "today on campus" line in the clock chip ----------
  const css = document.createElement('style');
  css.textContent = `
    #clock .campus-ev { display: none; align-items: center; gap: 5px; margin-top: 2px; font-size: 11px; font-weight: 600; color: var(--ink); max-width: 230px; overflow: hidden; text-overflow: ellipsis; }
    #clock .campus-ev.on { display: flex; }
    #clock .campus-ev i { flex: none; width: 6px; height: 6px; border-radius: 2px; background: var(--gold); box-shadow: 0 0 0 1px var(--gold-deep) inset; transform: rotate(45deg); }
    #clock .campus-ev span { overflow: hidden; text-overflow: ellipsis; }
    #clock .campus-ev em { font-style: normal; font-weight: 400; color: var(--muted); }
  `;
  document.head.appendChild(css);
  const tx = document.querySelector('#clock .tx');
  const pill = document.createElement('small');
  pill.className = 'campus-ev';
  pill.innerHTML = '<i></i><span></span>';
  tx?.appendChild(pill);
  let pillText = '';
  function showPill(cal, t) {
    // most interesting event first; exam season only says "open late" when it's late
    const order = ['frosh', 'homecoming', 'convocation', 'exams', 'reading', 'break'];
    const e = [...cal.events].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))[0];
    let text = '';
    if (e) text = `${app.esc(e.label)} <em>· ${app.esc(e.id === 'exams' && !(t.h >= 20 || t.h < 5) ? 'study spaces packed' : e.sub)}</em>`;
    else if (classChange(t, cal) > 0.5 && t.mins > 8 * 60 + 40) text = 'Class change <em>· students between buildings</em>';
    if (text === pillText) return;
    pillText = text;
    pill.querySelector('span').innerHTML = text;
    pill.classList.toggle('on', !!text);
    pill.title = text.replace(/<[^>]+>/g, '');
  }

  // ---------- tick: calendar, density, targets ----------
  let first = true;
  function tick() {
    const now = app.now(), t = local(now), cal = calendar(t.y, t.mo, t.d);
    state.t = t; state.cal = cal; state.ev = new Set(cal.events.map((e) => e.id));
    state.examNight = cal.phase === 'exams' && (t.h >= 21 || t.h < 5) || (cal.phase === 'study' && (t.h >= 22 || t.h < 3));
    state.targets = wants(t, cal);
    const target = densityFor(t, cal);
    // ease towards the target: a minute or so live, about a second in the time-lapse
    state.density = first ? target : state.density + (target - state.density) * (app.isLive() ? 0.25 : 0.2);
    first = false;
    L?.setDensity(state.density);
    app.campus.density = state.density; app.campus.season = cal.season; app.campus.phase = cal.phase;
    app.campus.events = cal.events.map((e) => e.label); app.campus.people = people.length; app.campus.classChange = classChange(t, cal);
    showPill(cal, t);
    if (L) populate();
  }
  app.campus = { density: 1, season: '', phase: '', events: [], people: 0, calendar, local, classChange };
  app.onTick(tick);
  // live ticks are 15 s apart: refill crowds a little more often so a class change floods out smoothly
  setInterval(() => { if (app.isLive() && state.t) { const t = local(app.now()); if (t.mi !== state.t.mi) tick(); else if (L) populate(); } }, 2000);
  app.on('timechange', tick);
  tick();

  app.helpSection('Campus calendar', '<p>The map follows the UW calendar in Waterloo time: rush hours, students pouring out at class changes (MWF :20, TTh 9:50, 11:20…), orientation week, homecoming, convocation, exam-season late nights and a quiet winter break. Dates are approximate. Try the time-lapse (<kbd>P</kbd>) or a link like <code>?date=2026-09-03T10:25</code>.</p>');
});
