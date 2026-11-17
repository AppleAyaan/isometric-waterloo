// Simulated life on the map: cars wander the road graph, GRT/GO buses run their routes and stop at the
// real stops, ION trains shuttle along the line (gates come down at the level crossings), students play
// on the fields near CIF, and Canada geese graze around campus. None of it is live data.
// Everything is drawn as small isometric shapes in the map's own projection, hidden where a building
// stands in front of it. Buses and trains carry a glass card.
window.startTraffic = function startTraffic({ viewer, data: T, occluded, canvas, cardLayer }) {
  const [PX, PY] = T.projection;
  const az = (T.azimuth * Math.PI) / 180;
  const CAM = [Math.sin(az), -Math.cos(az)]; // horizontal direction towards the camera, scene coords
  const LIGHT = [0.45, -0.55];
  const B = T.bounds;
  const inBounds = (x, y) => x >= B.minX + 2 && x <= B.maxX - 2 && y >= B.minY + 2 && y <= B.maxY - 2;
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const LIV = T.liveries || {};
  // photo textures (see viewer/sprites/CREDITS.md); vehicles fall back to painted liveries until they load
  const sprite = (f) => { const im = new Image(); im.decoding = 'async'; im.src = 'sprites/' + f; return im; };
  const SPR = {
    ionSide: sprite('ion-side.webp'), ionFront: sprite('ion-front.webp'),
    grtSide: sprite('grt-side.webp'), grtFront: sprite('grt-front.webp'),
    goLeft: sprite('go-side-left.webp'), goRight: sprite('go-side-right.webp'), goFront: sprite('go-front.webp'), goRear: sprite('go-rear.webp'),
  };
  // ION module boundaries in ion-side.webp (px), front module first
  const ION_SLICES = [[0, 165], [178, 279], [292, 386], [399, 497], [511, 640]];
  let clock = 0;

  // ---------- polyline helper ----------
  class Path {
    constructor(pts, off) {
      this.pts = pts; this.off = off || null; this.cum = [0];
      for (let i = 1; i < pts.length; i++) this.cum.push(this.cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      this.len = this.cum.at(-1);
    }
    // position + unit heading at distance s, shifted `lat` metres to the right of the direction of travel
    at(s, lat = 0, dir = 1) {
      s = Math.max(0, Math.min(this.len, s));
      let lo = 0, hi = this.cum.length - 1;
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (this.cum[m] <= s) lo = m; else hi = m; }
      const a = this.pts[lo], b = this.pts[hi], L = this.cum[hi] - this.cum[lo] || 1, u = (s - this.cum[lo]) / L;
      const hx = ((b[0] - a[0]) / L) * dir, hy = ((b[1] - a[1]) / L) * dir;
      const o = lat + (this.off ? this.off[lo] : 0);
      return { x: a[0] + (b[0] - a[0]) * u + hy * o, y: a[1] + (b[1] - a[1]) * u - hx * o, hx, hy };
    }
  }

  // ---------- road graph for cars ----------
  const N = T.roads.nodes;
  const adj = N.map(() => []);
  for (const [a, b, cls, fl, w] of T.roads.edges) {
    if (fl & 4) continue; // bus-only / private
    adj[a].push({ to: b, cls, aisle: !!(fl & 2), oneway: !!(fl & 1), w });
    if (!(fl & 1)) adj[b].push({ to: a, cls, aisle: !!(fl & 2), oneway: false, w });
  }
  const inside = (n) => inBounds(N[n][0], N[n][1]);
  const deg = N.map((_, i) => adj[i].length);
  const gates = N.map((_, i) => i).filter((i) => !inside(i) && adj[i].some((e) => e.cls <= 2 && !e.aisle));
  const CLASS_W = { 1: 7, 2: 3.5, 3: 1.2, 4: 0.5 };
  const CLASS_V = { 1: 14, 2: 10, 3: 8.5, 4: 5.5 };
  const allEdges = [];
  for (let a = 0; a < N.length; a++) for (const e of adj[a]) if (inside(a)) allEdges.push([a, e]);
  const edgeWeight = ([a, e]) => Math.hypot(N[e.to][0] - N[a][0], N[e.to][1] - N[a][1]) * CLASS_W[e.cls] * (e.aisle ? 0.15 : 1);
  const totalW = allEdges.reduce((s, x) => s + edgeWeight(x), 0);
  function randomEdge() {
    let r = Math.random() * totalW;
    for (const x of allEdges) if ((r -= edgeWeight(x)) <= 0) return x;
    return allEdges[0];
  }
  function chooseNext(prev, at) {
    const opts = adj[at].filter((e) => e.to !== prev);
    if (!opts.length) return adj[at].find((e) => e.to === prev) || null; // dead end: U-turn
    const hx = N[at][0] - N[prev][0], hy = N[at][1] - N[prev][1], hl = Math.hypot(hx, hy) || 1;
    const ws = opts.map((e) => {
      const dx = N[e.to][0] - N[at][0], dy = N[e.to][1] - N[at][1];
      const straight = (dx * hx + dy * hy) / ((Math.hypot(dx, dy) || 1) * hl);
      return CLASS_W[e.cls] * (e.aisle ? 0.08 : 1) * (straight + 1.25) ** 3;
    });
    let r = Math.random() * ws.reduce((s, w) => s + w, 0);
    for (let i = 0; i < opts.length; i++) if ((r -= ws[i]) <= 0) return opts[i];
    return opts.at(-1);
  }

  const CAR_COLORS = ['#e8e4dc', '#2b2d33', '#b8bcc2', '#c0392b', '#2e5c8a', '#f2f0ea', '#556270', '#8b2f2f', '#d9a441', '#4b6e4a', '#1d1f24', '#9aa3ad'];
  const cars = [];
  function placeCar(car, fromGate) {
    let a, e;
    if (fromGate && gates.length) { a = pick(gates); e = pick(adj[a].filter((x) => x.cls <= 2)) || adj[a][0]; }
    else [a, e] = randomEdge();
    if (!e) [a, e] = randomEdge();
    Object.assign(car, { a, e, t: fromGate ? 0 : rand(0, 1) * Math.hypot(N[e.to][0] - N[a][0], N[e.to][1] - N[a][1]), v: CLASS_V[e.cls] * 0.7 });
  }
  const CAR_COUNT = 140;
  // how many of the cars are on the road (0..1); the time-lapse / rush hour sets it through mapLife.setDensity
  let density = 1;
  const liveCars = () => (density >= 1 ? cars : cars.slice(0, Math.round(cars.length * density)));
  for (let i = 0; i < CAR_COUNT; i++) {
    const r = Math.random();
    const kind = r < 0.08 ? 'van' : r < 0.25 ? 'suv' : 'car';
    const car = { type: 'car', kind, color: pick(CAR_COLORS), L: kind === 'van' ? 5.6 : kind === 'suv' ? 4.9 : 4.4, W: kind === 'van' ? 2.0 : 1.9, H: kind === 'van' ? 2.2 : kind === 'suv' ? 1.7 : 1.45, pace: rand(0.85, 1.1) };
    placeCar(car, false);
    cars.push(car);
  }
  function carPose(c) {
    const A = N[c.a], Bn = N[c.e.to], L = Math.hypot(Bn[0] - A[0], Bn[1] - A[1]) || 1;
    const hx = (Bn[0] - A[0]) / L, hy = (Bn[1] - A[1]) / L, u = c.t / L;
    const o = c.e.oneway ? 0 : c.e.w / 4;
    return { x: A[0] + (Bn[0] - A[0]) * u + hy * o, y: A[1] + (Bn[1] - A[1]) * u - hx * o, hx, hy, L };
  }

  // ---------- buses ----------
  const buses = [];
  for (const r of T.buses) {
    r.paths.forEach((p) => {
      const path = new Path(p.pts, p.off);
      const bus = {
        type: 'bus', route: r, path, stops: p.stops, liv: LIV[r.livery] || LIV.GRT, dd: !!r.doubleDecker,
        L: r.doubleDecker ? 13.7 : 12.2, W: 2.6, H: r.doubleDecker ? 4.3 : 3.2,
        s: rand(0, path.len), v: 8, dwell: 0, wait: 0, next: 0,
      };
      bus.next = bus.stops.findIndex((st) => st.s > bus.s); if (bus.next < 0) bus.next = bus.stops.length;
      buses.push(bus);
    });
  }

  // ---------- ION (Flexity Freedom-style: two cab sections + a short centre section) ----------
  const trains = [];
  const ion = T.ion;
  // northbound trains run on the main ION track, southbound on the second (shared spur) track
  const tracks = (ion.tracks || []).filter((t) => t.pts.length > 1).map((t) => ({ path: new Path(t.pts), station: t.station }));
  const ionPath = tracks[0]?.path || null;
  const trackFor = (dir) => (dir === 1 || tracks.length < 2 ? 0 : 1);
  // five modules (cab, three short bodies, cab), sized from the reference photo
  const ION_SEGS = [6.9, 4.6, 4.4, 4.6, 6.9], ION_GAP = 0.6, ION_LEN = ION_SEGS.reduce((s, l) => s + l, 0) + ION_GAP * 2;
  if (ionPath) {
    for (const dir of [1, -1]) {
      const k = trackFor(dir), path = tracks[k].path;
      trains.push({ type: 'ion', dir, track: k, path, station: tracks[k].station, s: dir === 1 ? rand(0, path.len * 0.4) : rand(path.len * 0.6, path.len), v: 12, dwell: 0, wait: 0, served: false, L: ION_LEN, W: 2.65, H: 3.7, liv: LIV.ION || {} });
    }
  }

  // ---------- level crossings ----------
  const crossings = (T.crossings || []).map((c) => ({ ...c, active: false, arm: Math.PI / 2 - 0.05, flash: 0 }));
  function crossingActive(c) {
    for (const t of trains) {
      if (t.wait > 0) continue;
      const d = (c.s[t.track] - t.s) * t.dir; // distance from the train's nose to the crossing, along its travel
      if (d < -(ION_LEN + 6) || d > 150) continue;
      if (t.dwell > 0 && d > 40) continue; // waiting at the platform: keep the road open
      return true;
    }
    return false;
  }

  // ---------- people on the pedestrian crossings: they wait at the edge while the lights flash ----------
  const walkers = [];
  const WALK_REACH = 24;
  const SKIN_ALL = ['#f1c9a5', '#e0ac85', '#c68863', '#8d5a3b', '#5e3b27', '#f5d6bd'];
  const SHIRTS_ALL = ['#e74c3c', '#3498db', '#f1c40f', '#2ecc71', '#9b59b6', '#ecf0f1', '#e67e22', '#1abc9c', '#34495e', '#fd79a8', '#fed34c'];
  function placeWalker(w, c, anywhere) {
    w.c = c; w.dir = Math.random() < 0.5 ? 1 : -1; w.lat = rand(-1, 1);
    w.u = anywhere ? rand(-WALK_REACH, WALK_REACH) : -w.dir * WALK_REACH;
    w.pace = rand(1.1, 1.6); w.v = w.pace; w.rest = anywhere ? 0 : rand(0, 9);
  }
  for (const c of crossings) if (c.foot) for (let i = 0; i < 5; i++) {
    const w = { type: 'walker', phase: rand(0, 6), H: rand(1.6, 1.85), shirt: pick(SHIRTS_ALL), pants: pick(['#2d3436', '#34495e', '#5d4e37', '#1e3799', '#636e72']), skin: pick(SKIN_ALL) };
    placeWalker(w, c, true);
    walkers.push(w);
  }
  function stepWalkers(dt) {
    for (const w of walkers) {
      if (w.rest > 0) { w.rest -= dt; w.v = 0; continue; }
      const c = w.c, edge = c.span / 2 + 1.4;
      const ahead = -w.u * w.dir; // distance to the crossing centre, along travel
      let target = w.pace;
      if (c.active && ahead > edge - 0.2 && ahead < edge + 6) target = Math.max(0, Math.min(w.pace, (ahead - edge) * 0.8)); // wait at the tactile strip
      w.v += Math.max(-3 * dt, Math.min(2 * dt, target - w.v));
      w.u += w.v * dt * w.dir;
      w.phase += w.v * dt * 5.5;
      if (w.u * w.dir > WALK_REACH) placeWalker(w, c, false);
    }
  }
  const walkerXY = (w) => { const c = w.c; return [c.x + c.rx * w.u - c.ry * w.lat, c.y + c.ry * w.u + c.rx * w.lat]; };

  // ---------- students on the fields ----------
  const SKIN = ['#f1c9a5', '#e0ac85', '#c68863', '#8d5a3b', '#5e3b27', '#f5d6bd'];
  const SHIRTS = ['#e74c3c', '#3498db', '#f1c40f', '#2ecc71', '#9b59b6', '#ecf0f1', '#e67e22', '#1abc9c', '#34495e', '#fd79a8'];
  // people and geese are drawn a bit larger than life so they read at map scale
  const PEOPLE_SCALE = 1.5, GOOSE_SCALE = 3;
  const games = [];
  const fieldByName = (n) => (T.fields || []).find((f) => f.name === n);
  function makeGame(f, kind, teams, perTeam) {
    if (!f) return;
    const vx = -f.uy, vy = f.ux; // across the field
    const g = { f, kind, vx, vy, players: [], ball: { a: 0, b: 0, z: 0.15, holder: null, flight: null }, hold: 0 };
    const half = f.len / 2 - 6, halfW = f.wid / 2 - 5;
    for (let t = 0; t < teams; t++) for (let i = 0; i < perTeam; i++) {
      const home = teams === 2
        ? { a: (t === 0 ? -1 : 1) * rand(0.1, 0.75) * half * 0.8, b: rand(-0.85, 0.85) * halfW }
        : { a: Math.cos((i / perTeam) * Math.PI * 2) * Math.min(14, half * 0.4) + rand(-3, 3), b: Math.sin((i / perTeam) * Math.PI * 2) * Math.min(12, halfW * 0.6) + rand(-3, 3) };
      g.players.push({
        team: t, home, a: home.a + rand(-4, 4), b: home.b + rand(-4, 4), ha: 1, hb: 0, v: 0, phase: rand(0, 6),
        shirt: teams === 2 ? (t === 0 ? '#f2c230' : '#f4f4f4') : pick(SHIRTS), skin: pick(SKIN), pants: pick(['#2d3436', '#1e272e', '#3d4a5c', '#636e72']),
        top: rand(4.3, 6.2), H: rand(1.62, 1.88) * PEOPLE_SCALE,
      });
    }
    g.half = half; g.halfW = halfW; g.teams = teams;
    g.ball.holder = pick(g.players);
    games.push(g);
  }
  makeGame(fieldByName('Warrior Field'), 'football', 2, 8);
  makeGame(fieldByName('Playing Field 7'), 'soccer', 2, 5);
  makeGame(fieldByName('Playing Field 2'), 'frisbee', 1, 6);
  makeGame(fieldByName('Playing Field 4'), 'soccer', 1, 4);
  makeGame(fieldByName('West Field'), 'soccer', 1, 5);
  const fieldXY = (g, a, b) => [g.f.x + g.f.ux * a + g.vx * b, g.f.y + g.f.uy * a + g.vy * b];

  function stepGame(g, dt) {
    const ball = g.ball;
    // ball in flight
    if (ball.flight) {
      const fl = ball.flight;
      fl.t += dt / fl.dur;
      const u = Math.min(1, fl.t);
      ball.a = fl.a0 + (fl.a1 - fl.a0) * u; ball.b = fl.b0 + (fl.b1 - fl.b0) * u;
      ball.z = 0.15 + 4 * fl.peak * u * (1 - u);
      if (u >= 1) { ball.holder = fl.to; ball.flight = null; g.hold = rand(0.8, 2.6); }
    } else if (ball.holder) {
      const h = ball.holder;
      ball.a = h.a + h.ha * 0.5; ball.b = h.b + h.hb * 0.5; ball.z = g.kind === 'soccer' ? 0.12 : 1.1;
      g.hold -= dt;
      if (g.hold <= 0) {
        const mates = g.players.filter((p) => p !== h && (g.teams === 1 || p.team === h.team));
        const foes = g.players.filter((p) => g.teams === 2 && p.team !== h.team);
        const to = foes.length && Math.random() < 0.2 ? pick(foes) : pick(mates);
        if (to) {
          const dist = Math.hypot(to.a - ball.a, to.b - ball.b);
          const speed = g.kind === 'frisbee' ? 9 : g.kind === 'soccer' ? 13 : 15;
          ball.flight = { a0: ball.a, b0: ball.b, a1: to.a, b1: to.b, t: 0, dur: dist / speed + 0.25, to, peak: g.kind === 'soccer' ? dist * 0.03 : g.kind === 'frisbee' ? 0.6 : dist * 0.09 };
          ball.holder = null;
        }
      }
    }
    // players
    const dirA = (t) => (t === 0 ? 1 : -1); // team 0 attacks +a
    for (const p of g.players) {
      let ta, tb, sp = 2;
      if (ball.holder === p) {
        ta = p.a + (g.teams === 2 ? dirA(p.team) * 6 : rand(-2, 2)); tb = p.b + rand(-2, 2); sp = g.teams === 2 ? 5 : 1;
        if (g.teams === 2 && Math.abs(p.a) > g.half - 4 && Math.sign(p.a) === dirA(p.team)) {
          // touchdown / goal: the other team takes over and runs it back the other way
          const other = g.players.filter((q) => q.team !== p.team);
          other.sort((m, n) => Math.hypot(m.a - p.a, m.b - p.b) - Math.hypot(n.a - p.a, n.b - p.b));
          ball.holder = other[0]; g.hold = rand(1.5, 3);
        }
      } else if (ball.flight && ball.flight.to === p) {
        ta = ball.flight.a1; tb = ball.flight.b1; sp = 6;
      } else if (g.teams === 2) {
        const attacking = ball.holder ? ball.holder.team === p.team : true;
        const shift = attacking ? 0.55 : 0.45;
        ta = p.home.a * (1 - shift) + ball.a * shift + (attacking ? dirA(p.team) * 5 : -dirA(p.team) * 3);
        tb = p.home.b * 0.75 + ball.b * 0.25;
        sp = 4.2;
      } else {
        ta = p.home.a + Math.sin(clock * 0.3 + p.phase) * 2; tb = p.home.b + Math.cos(clock * 0.25 + p.phase) * 2; sp = 1.6;
      }
      ta = Math.max(-g.half, Math.min(g.half, ta)); tb = Math.max(-g.halfW, Math.min(g.halfW, tb));
      const da = ta - p.a, db = tb - p.b, d = Math.hypot(da, db);
      const want = d < 0.6 ? 0 : Math.min(sp * (p.top / 5.2), d * 1.5);
      p.v += Math.max(-8 * dt, Math.min(5 * dt, want - p.v));
      if (d > 0.05) {
        const na = da / d, nb = db / d;
        p.ha += (na - p.ha) * Math.min(1, dt * 8); p.hb += (nb - p.hb) * Math.min(1, dt * 8);
        const hl = Math.hypot(p.ha, p.hb) || 1; p.ha /= hl; p.hb /= hl;
      } else { // face the ball while standing
        const fa = ball.a - p.a, fb = ball.b - p.b, fl = Math.hypot(fa, fb) || 1;
        p.ha += (fa / fl - p.ha) * Math.min(1, dt * 4); p.hb += (fb / fl - p.hb) * Math.min(1, dt * 4);
      }
      p.a += p.ha * p.v * dt; p.b += p.hb * p.v * dt;
      p.phase += p.v * dt * 3.2;
    }
  }

  // ---------- Canada geese ----------
  // Waterloo geese: flocks graze the lawns and float on the ponds; a gander hisses at and charges anyone who
  // wanders too close (a couple of flocks graze the touchlines of the busy fields, so it happens in view);
  // goslings trail their parents in single file in May-June; V-formations honk across the sky every minute
  // or two (more of them, and fewer geese on the ground, in Dec-Feb). Honks go out as app 'honk' events.
  const flocks = [], geese = [], goslings = [], flights = [];
  const MONTH_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Toronto', month: 'numeric' });
  const mapMonth = () => { try { return +MONTH_FMT.format(window.app?.now?.() ?? new Date()); } catch { return new Date().getMonth() + 1; } };
  let month = mapMonth(), seasonT = 5;
  const isWinter = () => month === 12 || month <= 2, isSpring = () => month === 5 || month === 6;
  const honk = (x, y, kind) => { try { window.app?.emit?.('honk', { x, y, kind }); } catch { /* sound is optional */ } };
  function addFlock(area, goal, n) {
    const flock = { area, goal: goal.slice(), timer: rand(10, 50), geese: [], migrant: !area.water && !area.edge && Math.random() < 0.55, away: false, gone: 0, brood: null };
    flocks.push(flock);
    for (let i = 0; i < n; i++) {
      const ang = rand(0, Math.PI * 2);
      const g = {
        flock, x: goal[0] + rand(-3, 3), y: goal[1] + rand(-3, 3), hx: Math.cos(ang), hy: Math.sin(ang),
        off: [rand(-3.5, 3.5), rand(-3.5, 3.5)], state: 'graze', t: rand(1, 8), v: 0, peck: rand(0, 6), swim: area.water,
        size: rand(0.9, 1.08) * GOOSE_SCALE, cool: rand(0, 20), flap: 0,
      };
      geese.push(g); flock.geese.push(g);
    }
    // the biggest bird does the hissing
    flock.gander = flock.geese.reduce((a, b) => (b.size > a.size ? b : a), flock.geese[0]);
    return flock;
  }
  const areas = (T.geeseAreas || []).filter((a) => a.pts.length >= 12);
  if (areas.length) {
    const weight = (a) => Math.min(a.area, 30000) * (a.water ? 0.6 : 1);
    const tot = areas.reduce((s, a) => s + weight(a), 0);
    const FLOCKS = 18;
    const ponds = areas.filter((a) => a.water);
    for (let f = 0; f < FLOCKS; f++) {
      let r = Math.random() * tot, area = areas[0];
      for (const a of areas) if ((r -= weight(a)) <= 0) { area = a; break; }
      if (f < 3 && ponds.length) area = pick(ponds); // always a few geese out on the water
      addFlock(area, pick(area.pts), 3 + Math.floor(Math.random() * 6));
    }
  }
  // flocks grazing just inside the touchlines of the busy fields, where players stray close enough to get hissed at
  for (const g of games.slice(0, 3)) {
    const f = g.f, b = (Math.random() < 0.5 ? 1 : -1) * (f.wid / 2 - 4), pts = [];
    for (let a = -f.len / 2 + 6; a <= f.len / 2 - 6; a += 4) pts.push(fieldXY(g, a, b + rand(-1, 1)));
    if (pts.length >= 4) addFlock({ pts, water: false, edge: true }, pick(pts), 3 + Math.floor(Math.random() * 3));
  }
  // spring: a parent leads 3-6 goslings in single file, the other parent brings up the rear
  function setBroods() {
    goslings.length = 0;
    for (const f of flocks) {
      if (f.brood) { f.brood.trail.trail = null; f.brood = null; }
      if (!isSpring() || f.area.water || f.area.edge || f.geese.length < 2 || Math.random() > 0.45) continue;
      const lead = f.geese.find((g) => g !== f.gander) || f.geese[0], trail = f.geese.find((g) => g !== lead && g !== f.gander) || f.geese.find((g) => g !== lead);
      const kids = [];
      const n = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) {
        const k = { x: lead.x - lead.hx * (i + 1) * 0.9, y: lead.y - lead.hy * (i + 1) * 0.9, hx: lead.hx, hy: lead.hy, v: 0, phase: rand(0, 6), size: rand(0.9, 1.1) * GOOSE_SCALE, flock: f };
        k.leader = i ? kids[i - 1] : lead;
        kids.push(k); goslings.push(k);
      }
      f.brood = { lead, trail, kids };
      trail.trail = kids.at(-1);
    }
  }
  const awayNow = () => { for (const f of flocks) f.away = isWinter() && f.migrant; };
  awayNow(); setBroods();

  // Anyone the geese react to. Built in: walkers on the ION crossings and players on the fields. Other modules
  // add theirs with mapLife.api.people.push(src), where src is either a live object with x, y (scene metres;
  // getters are fine) or a function returning an array of such objects. An object may also define
  // flee(dx, dy) (unit vector pointing away from the goose), called when a gander charges it.
  const people = [];
  function eachPerson(fn) {
    for (const w of walkers) if (w.rest <= 0) { const [x, y] = walkerXY(w); fn(x, y, w, null, null); }
    for (const gm of games) for (const p of gm.players) { const [x, y] = fieldXY(gm, p.a, p.b); fn(x, y, p, gm, null); }
    for (const s of people) {
      let list;
      try { list = typeof s === 'function' ? s() : [s]; } catch { continue; }
      for (const p of list || []) if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) fn(p.x, p.y, p, null, p);
    }
  }
  const HISS_R = 6;
  let hissCool = rand(4, 10), lookT = 0;
  const fleeing = [];
  const onLand = (g) => !g.swim && !g.flock.away && !(g.flock.gone > 0);
  function lookForTrouble() {
    let best = null, bd = HISS_R;
    eachPerson((x, y, who, gm, ext) => {
      for (const g of geese) {
        if (Math.abs(g.x - x) > HISS_R || Math.abs(g.y - y) > HISS_R || !onLand(g)) continue;
        const d = Math.hypot(g.x - x, g.y - y);
        if (d < bd) { bd = d; best = { g, x, y, who, gm, ext }; }
      }
    });
    if (!best) return;
    const gd = best.g.flock.gander;
    if (!gd || gd.state === 'hiss' || gd.cool > 0 || gd.trail || Math.hypot(gd.x - best.x, gd.y - best.y) > 14) return;
    const { who, gm, ext } = best;
    gd.chase = who.type === 'walker' ? () => walkerXY(who) : gm ? () => fieldXY(gm, who.a, who.b) : () => [who.x, who.y];
    gd.state = 'hiss'; gd.t = rand(1.2, 2.1); gd.cool = rand(30, 70); gd.flap = 0;
    hissCool = rand(6, 14);
    for (const g of gd.flock.geese) if (g !== gd && g.state === 'graze') { g.state = 'alert'; g.t = rand(2, 5); } // heads up, everyone
    honk(gd.x, gd.y, 'hiss');
    // the person makes a run for it
    const d = Math.hypot(best.x - gd.x, best.y - gd.y) || 1, dx = (best.x - gd.x) / d, dy = (best.y - gd.y) / d;
    if (who.type === 'walker') { who.v = who.pace * 2.4; who.lat = Math.max(-1.4, Math.min(1.4, who.lat + (Math.random() < 0.5 ? -0.8 : 0.8))); }
    else if (gm) fleeing.push({ p: who, gm, dx, dy, t: rand(1, 1.7) });
    else if (ext && typeof ext.flee === 'function') try { ext.flee(dx, dy); } catch { /* their problem */ }
  }

  // ---------- geese overhead: V-formations ----------
  let flightT = rand(15, 40); // the first one comes along fairly soon
  // the ground point under a screen pixel (null before the first frame)
  function sceneAtScreen(sx, sy) {
    if (!view) return null;
    const u = (sx - view.ox) / view.k - PX[3], w = (sy - view.oy) / view.k - PY[3], det = PX[0] * PY[1] - PX[1] * PY[0];
    return [(u * PY[1] - w * PX[1]) / det, (PX[0] * w - PY[0] * u) / det];
  }
  function vFormation(n) { // [back, side] metres from the lead bird
    const out = [[0, 0]];
    for (let i = 1; i < n; i++) { const r = Math.ceil(i / 2); out.push([r * 5.5 + rand(-0.6, 0.6), (i % 2 ? 1 : -1) * r * 5 + rand(-0.5, 0.5)]); }
    return out.map(([b, s]) => ({ b, s, ph: rand(0, 6), bob: rand(0, 6) }));
  }
  // o: {x, y, ang, n, z0, from} - by default a pass straight across whatever is on screen
  function spawnFlight(o = {}) {
    const c = sceneAtScreen(innerWidth / 2, innerHeight / 2) || [0, 0];
    const ang = o.ang ?? rand(0, Math.PI * 2), hx = Math.cos(ang), hy = Math.sin(ang);
    const L = Math.max(160, Math.min(1300, Math.hypot(innerWidth, innerHeight) / 2 / Math.max(0.2, pxPerM) + 90));
    let x, y;
    if (o.x != null) { x = o.x; y = o.y; } else { const side = rand(-0.3, 0.3) * L; x = c[0] - hx * L - hy * side; y = c[1] - hy * L + hx * side; }
    const z1 = rand(40, 60), dist = o.x != null ? L + 300 : 2 * L;
    const fl = { x, y, hx, hy, z: o.z0 ?? z1, z1, v: o.z0 != null ? 5 : 15, t: 0, dist, s: 0, birds: vFormation(o.n ?? 5 + Math.floor(Math.random() * 5)), honked: false };
    flights.push(fl);
    honk(x, y, 'flyover');
    return fl;
  }
  // Konami: every goose on the ground takes off, heading (roughly) south; they drift back a minute or so later
  function scatterGeese() {
    const ang = -Math.PI / 2 + rand(-0.35, 0.35);
    let n = 0;
    for (const f of flocks) {
      if (f.away || f.gone > 0 || !f.geese.length) continue;
      const cx = f.geese.reduce((s, g) => s + g.x, 0) / f.geese.length, cy = f.geese.reduce((s, g) => s + g.y, 0) / f.geese.length;
      const fl = spawnFlight({ x: cx, y: cy, ang: ang + rand(-0.1, 0.1), n: f.geese.length + (f.brood ? f.brood.kids.length : 0), z0: 0.5 });
      f.gone = fl.dist / 15 + rand(25, 50);
      n += f.geese.length;
    }
    return n;
  }
  function stepFlights(dt) {
    flightT -= dt;
    if (flightT <= 0) { flightT = isWinter() ? rand(35, 75) : rand(60, 120); if (pxPerM > 0.35) spawnFlight(); }
    for (let i = flights.length - 1; i >= 0; i--) {
      const f = flights[i];
      f.v += (15 - f.v) * Math.min(1, dt * 0.4);
      f.z += Math.max(0, Math.min(dt * 6, f.z1 - f.z)); // climbing out after a take-off
      f.x += f.hx * f.v * dt; f.y += f.hy * f.v * dt; f.s += f.v * dt; f.t += dt;
      for (const b of f.birds) b.ph += dt * 17;
      if (!f.honked && f.s > f.dist / 2) { f.honked = true; honk(f.x, f.y, 'flyover'); }
      if (f.s > f.dist) flights.splice(i, 1);
    }
  }

  function stepGeese(dt) {
    seasonT -= dt;
    if (seasonT <= 0) { // the map clock can jump (time-lapse): follow the season
      seasonT = 5;
      const m = mapMonth();
      if (m !== month) { const spring = isSpring(); month = m; awayNow(); if (spring !== isSpring()) setBroods(); }
    }
    for (const f of flocks) {
      if (f.gone > 0) {
        f.gone -= dt;
        if (f.gone <= 0) for (const g of [...f.geese, ...(f.brood ? f.brood.kids : [])]) { const o = g.off || [rand(-2, 2), rand(-2, 2)]; g.x = f.goal[0] + o[0]; g.y = f.goal[1] + o[1]; g.state = 'graze'; g.t = rand(2, 8); g.v = 0; }
        continue;
      }
      f.timer -= dt;
      if (f.timer <= 0) {
        // wander to another spot in the same area, usually not far away
        const near = f.area.pts.filter((p) => Math.hypot(p[0] - f.goal[0], p[1] - f.goal[1]) < 45);
        f.goal = (near.length > 1 ? pick(near) : pick(f.area.pts)).slice();
        f.timer = rand(25, 70);
        for (const g of f.geese) if (g.state !== 'hiss') { g.state = 'walk'; g.t = rand(0, 2.5); g.off = [rand(-3.5, 3.5), rand(-3.5, 3.5)]; }
      }
    }
    const turn = (g, dx, dy, d, rate) => {
      g.hx += (dx / d - g.hx) * Math.min(1, dt * rate); g.hy += (dy / d - g.hy) * Math.min(1, dt * rate);
      const hl = Math.hypot(g.hx, g.hy) || 1; g.hx /= hl; g.hy /= hl;
    };
    for (const g of geese) {
      g.cool -= dt;
      if (g.flock.gone > 0 || g.flock.away) continue;
      g.t -= dt;
      if (g.state === 'hiss') { // neck out, wings up, straight at them
        const [px, py] = g.chase(), dx = px - g.x, dy = py - g.y, d = Math.hypot(dx, dy) || 1;
        turn(g, dx, dy, d, 7);
        g.v = d > 1.4 ? Math.min(2.8, g.v + dt * 9) : g.v * Math.max(0, 1 - dt * 6);
        g.x += g.hx * g.v * dt; g.y += g.hy * g.v * dt; g.flap += dt;
        if (g.t <= 0 || d > 16) { g.state = 'walk'; g.t = rand(0.4, 1.2); g.chase = null; }
        continue;
      }
      let tx = g.flock.goal[0] + g.off[0], ty = g.flock.goal[1] + g.off[1];
      if (g.trail) { tx = g.trail.x - g.trail.hx * 1.3; ty = g.trail.y - g.trail.hy * 1.3; } // rear parent: behind the last gosling
      const dx = tx - g.x, dy = ty - g.y, d = Math.hypot(dx, dy);
      if (g.trail) {
        g.v = d > 0.3 ? Math.min(0.9, d * 1.5) : g.v * Math.max(0, 1 - dt * 3);
        if (d > 0.05) turn(g, dx, dy, d, 3);
        g.state = g.v > 0.15 ? 'walk' : 'alert';
      } else if (g.state === 'walk' && g.t <= 0) {
        if (d < 0.4) { g.state = Math.random() < 0.75 ? 'graze' : 'alert'; g.t = rand(3, 12); }
        else {
          const sp = g.swim ? 0.45 : 0.7;
          g.v += (sp - g.v) * Math.min(1, dt * 2);
          turn(g, dx, dy, d, 3);
        }
      } else if (g.state !== 'walk') {
        g.v *= Math.max(0, 1 - dt * 3);
        if (g.t <= 0) {
          // shuffle a step or two, then graze again
          g.off = [g.off[0] + rand(-1.5, 1.5), g.off[1] + rand(-1.5, 1.5)].map((v) => Math.max(-4, Math.min(4, v)));
          g.state = 'walk'; g.t = 0;
        }
      }
      g.x += g.hx * g.v * dt; g.y += g.hy * g.v * dt;
      g.peck += dt * (g.state === 'graze' ? 1 : 0);
    }
    // goslings: each one follows the bird in front of it
    for (const k of goslings) {
      if (k.flock.gone > 0) continue;
      const L = k.leader, tx = L.x - L.hx * 0.95, ty = L.y - L.hy * 0.95, dx = tx - k.x, dy = ty - k.y, d = Math.hypot(dx, dy);
      k.v = d > 0.12 ? Math.min(1.8, d * 2.4) : 0;
      if (d > 0.05) turn(k, dx, dy, d, 6);
      k.x += k.hx * k.v * dt; k.y += k.hy * k.v * dt; k.phase += k.v * dt * 9;
    }
    // players running from a gander (field coords: a along the field, b across)
    for (let i = fleeing.length - 1; i >= 0; i--) {
      const r = fleeing[i], f = r.gm.f, vx = r.gm.vx, vy = r.gm.vy;
      const da = r.dx * f.ux + r.dy * f.uy, db = r.dx * vx + r.dy * vy;
      r.p.a += da * 3.4 * dt; r.p.b += db * 3.4 * dt; r.p.ha = da; r.p.hb = db; r.p.v = Math.max(r.p.v, 3.4);
      if ((r.t -= dt) <= 0) fleeing.splice(i, 1);
    }
    hissCool -= dt; lookT -= dt;
    if (hissCool <= 0 && lookT <= 0) { lookT = 0.4; lookForTrouble(); }
    stepFlights(dt);
  }

  // ---------- simulation ----------
  const poses = new Map();
  function leaderGap(me, p, all) {
    let gap = Infinity;
    for (const o of all) {
      if (o === me) continue;
      const q = poses.get(o);
      if (!q) continue;
      const rx = q.x - p.x, ry = q.y - p.y;
      const lon = rx * p.hx + ry * p.hy;
      if (lon <= 0 || lon > 40) continue;
      const lat = Math.abs(rx * p.hy - ry * p.hx);
      if (lat > 1.9) continue;
      if (q.hx * p.hx + q.hy * p.hy < 0.2) continue;
      gap = Math.min(gap, lon - (me.L + o.L) / 2);
    }
    return gap;
  }
  // distance to the stop line of a closed level crossing ahead (Infinity if none)
  function crossingGap(me, p) {
    let gap = Infinity;
    for (const c of crossings) {
      if (!c.active || c.foot) continue;
      const rx = c.x - p.x, ry = c.y - p.y;
      const lon = rx * p.hx + ry * p.hy;
      if (lon <= 0 || lon > 70) continue;
      if (Math.abs(p.hx * c.rx + p.hy * c.ry) < 0.6) continue; // not travelling along this road
      if (Math.abs(rx * p.hy - ry * p.hx) > c.w / 2 + 2.5) continue;
      const g = lon - c.span / 2 - 2.5 - me.L / 2;
      if (g > -1) gap = Math.min(gap, g);
    }
    return gap;
  }
  const approach = (v, target, dt) => v + Math.max(-7 * dt, Math.min(2.5 * dt, target - v));

  function step(dt) {
    clock += dt;
    for (const c of crossings) {
      c.active = crossingActive(c);
      const target = c.active ? 0 : Math.PI / 2 - 0.05;
      c.arm += Math.max(-dt * 0.55, Math.min(dt * 0.55, target - c.arm));
    }

    poses.clear();
    for (const c of liveCars()) poses.set(c, carPose(c));
    for (const b of buses) if (b.wait <= 0) poses.set(b, b.path.at(b.s));
    const movers = [...liveCars(), ...buses];

    for (const c of liveCars()) {
      const p = poses.get(c);
      let target = CLASS_V[c.e.cls] * c.pace * (c.e.aisle ? 0.45 : 1);
      const remain = p.L - c.t;
      if (remain < 18 && c.e) target = Math.min(target, 5 + remain * 0.5);
      const gap = Math.min(leaderGap(c, p, movers), crossingGap(c, p));
      if (gap < 30) target = Math.min(target, Math.max(0, (gap - 2.5) * 0.9));
      c.v = approach(c.v, target, dt);
      c.t += c.v * dt;
      while (c.t >= p.L) {
        c.t -= p.L;
        const prev = c.a, at = c.e.to;
        if (!inside(at) && deg[at] <= 1) { placeCar(c, Math.random() < 0.7); break; }
        const nx = chooseNext(prev, at);
        if (!nx) { placeCar(c, true); break; }
        c.a = at; c.e = nx;
        p.L = Math.hypot(N[nx.to][0] - N[at][0], N[nx.to][1] - N[at][1]) || 1;
      }
    }

    for (const b of buses) {
      if (b.wait > 0) {
        b.wait -= dt;
        if (b.wait <= 0) { b.s = 0; b.v = 9; b.next = 0; }
        continue;
      }
      if (b.dwell > 0) { b.dwell -= dt; if (b.dwell <= 0) b.next++; continue; }
      const p = poses.get(b);
      let target = 11.5;
      const st = b.stops[b.next];
      if (st) {
        const d = st.s - b.s;
        target = Math.min(target, Math.sqrt(Math.max(0, 2 * 1.6 * d)) + 0.3);
        if (d < 0.6) { b.s = st.s; b.v = 0; b.dwell = rand(7, 14); continue; }
      }
      const gap = Math.min(leaderGap(b, p, movers), crossingGap(b, p));
      if (gap < 30) target = Math.min(target, Math.max(0, (gap - 3) * 0.8));
      b.v = approach(b.v, target, dt);
      b.s += b.v * dt;
      if (b.s >= b.path.len) { b.wait = rand(8, 35); }
    }

    for (const t of trains) {
      if (t.wait > 0) {
        t.wait -= dt;
        if (t.wait <= 0) { // come back the other way on the other track
          t.dir = -t.dir; t.served = false; t.track = trackFor(t.dir);
          t.path = tracks[t.track].path; t.station = tracks[t.track].station;
          t.s = t.dir === 1 ? 0 : t.path.len;
        }
        continue;
      }
      if (t.dwell > 0) { t.dwell -= dt; if (t.dwell <= 0) t.served = true; continue; }
      const end = t.dir === 1 ? t.path.len : 0;
      let target = 16;
      if (t.station != null && !t.served) {
        // stop with the middle of the train at the platform centre: both directions then line up end to end
        const stop = t.station + t.dir * ION_LEN / 2;
        const d = (stop - t.s) * t.dir;
        if (d < 0) t.served = true;
        else {
          target = Math.min(target, Math.sqrt(2 * 1.1 * d) + 0.2);
          if (d < 0.5) { t.s = stop; t.v = 0; t.dwell = rand(18, 28); continue; }
        }
      }
      t.v = approach(t.v, target, dt);
      t.s += t.v * dt * t.dir;
      if ((t.s - end) * t.dir >= 0) { t.s = end; t.v = 0; t.wait = rand(15, 40); }
    }

    for (const g of games) stepGame(g, dt);
    stepGeese(dt);
    stepWalkers(dt);
    for (const L of layers) if (L.step) try { L.step(dt, api); } catch (e) { layerError(L, e); }
  }
  // extra layers added by other modules (viewer/*.js) through mapLife.addLayer({ step(dt, api), collect(add, api), overlay(ctx, api) })
  const layers = [];
  const layerError = (L, e) => { if (!L._err) { L._err = e; console.error('map layer failed', e); } };

  // ---------- drawing primitives ----------
  const ctx = canvas.getContext('2d');
  let view; // image px -> screen px: screen = o + k * img
  let pxPerM = 1;
  const toScreen = (x, y, h) => [view.ox + view.k * (PX[0] * x + PX[1] * y + PX[2] * h + PX[3]), view.oy + view.k * (PY[0] * x + PY[1] * y + PY[2] * h + PY[3])];
  const toImage = (x, y) => [PX[0] * x + PX[1] * y + PX[3], PY[0] * x + PY[1] * y + PY[3]];
  const shadeCache = new Map();
  const shade = (hex, f) => {
    const key = hex + f.toFixed(2);
    let v = shadeCache.get(key);
    if (!v) {
      const n = parseInt(hex.slice(1), 16);
      const c = [n >> 16, (n >> 8) & 255, n & 255].map((x) => Math.round(Math.min(255, Math.max(0, x * f))));
      v = `rgb(${c[0]},${c[1]},${c[2]})`;
      shadeCache.set(key, v);
    }
    return v;
  };
  const poly = (pts) => { ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); };
  const line3 = (a, b, color, widthM, minPx = 0.6) => {
    const p = toScreen(...a), q = toScreen(...b);
    ctx.beginPath(); ctx.moveTo(...p); ctx.lineTo(...q);
    ctx.strokeStyle = color; ctx.lineWidth = Math.max(minPx, widthM * pxPerM); ctx.stroke();
  };
  const dot3 = (p, rM, color, minPx = 0.7) => {
    const s = toScreen(...p);
    ctx.beginPath(); ctx.arc(s[0], s[1], Math.max(minPx, rM * pxPerM), 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
  };

  // An oriented box. Faces: front (+heading), back, left, right. Details are painted onto faces as
  // rectangles given by (f0..f1 along the face, z0..z1 metres above h0). For the long sides f is
  // measured from the front; for the ends f runs left to right as seen from outside.
  const FACE = { front: [0, 1, 1, 0], right: [1, 2, 0, -1], back: [2, 3, -1, 0], left: [3, 0, 0, 1] };
  function prism(x, y, hx, hy, L, W, h0, h1) {
    const nx = -hy, ny = hx;
    const c = [[L / 2, W / 2], [L / 2, -W / 2], [-L / 2, -W / 2], [-L / 2, W / 2]].map(([a, b]) => [x + hx * a + nx * b, y + hy * a + ny * b]);
    const faces = {};
    for (const [name, [i, j, fh, fn]] of Object.entries(FACE)) {
      const fx = hx * fh + nx * fn, fy = hy * fh + ny * fn;
      faces[name] = { i, j, vis: fx * CAM[0] + fy * CAM[1] > 0.02, lit: 0.7 + 0.2 * (fx * LIGHT[0] + fy * LIGHT[1]) };
    }
    return { c, h0, h1, faces, x, y, hx, hy, nx, ny, L, W };
  }
  function faceQuad(P, name, f0, f1, z0, z1) {
    const F = P.faces[name];
    let a = P.c[F.i], b = P.c[F.j];
    if (name === 'left') { f0 = 1 - f0; f1 = 1 - f1; } // left face runs back->front
    const at = (f, z) => toScreen(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, P.h0 + z);
    return [at(f0, z0), at(f1, z0), at(f1, z1), at(f0, z1)];
  }
  // draw: sides (with details), then the top
  // Photo texture on a face. Images are stored with the vehicle's front at the left edge (sides) or as
  // seen from outside (ends). The projection is affine, so each face is a parallelogram and the image
  // maps onto it with a single canvas transform. `rev` mirrors the mapping along the face.
  function texFace(P, name, t) {
    const img = t.img;
    if (!img || !img.complete || !img.naturalWidth) return false;
    const H = P.h1 - P.h0, sw = t.sw ?? img.naturalWidth, sx = t.sx ?? 0, sh = img.naturalHeight;
    const ends = name === 'front' || name === 'back';
    const rev = ends ? !t.rev : !!t.rev; // ends: image left = the vehicle's right as seen from outside
    const q = faceQuad(P, name, rev ? 1 : 0, rev ? 0 : 1, H, 0);
    const X = [q[1][0] - q[0][0], q[1][1] - q[0][1]], Y = [q[3][0] - q[0][0], q[3][1] - q[0][1]];
    ctx.save();
    poly(q); ctx.clip();
    ctx.transform(X[0] / sw, X[1] / sw, Y[0] / sh, Y[1] / sh, q[0][0], q[0][1]);
    ctx.drawImage(img, sx, 0, sw, sh, 0, 0, sw, sh);
    ctx.restore();
    const dark = Math.max(0, Math.min(0.35, (0.86 - P.faces[name].lit) * 1.1));
    if (dark > 0.01) { poly(q); ctx.fillStyle = `rgba(20,24,30,${dark.toFixed(3)})`; ctx.fill(); }
    return true;
  }
  function paint(P, { side, top, details = [], stroke, tex = {} }) {
    const H = P.h1 - P.h0;
    for (const name of ['front', 'right', 'back', 'left']) {
      const F = P.faces[name];
      if (!F.vis) continue;
      if (tex[name] && texFace(P, name, tex[name])) continue;
      poly(faceQuad(P, name, 0, 1, 0, H));
      ctx.fillStyle = shade(typeof side === 'function' ? side(name) : side, F.lit); ctx.fill();
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.7; ctx.stroke(); }
      for (const d of details) {
        if (!d.faces.includes(name)) continue;
        poly(faceQuad(P, name, d.f0, d.f1, d.z0, Math.min(H, d.z1)));
        ctx.fillStyle = d.glow ? d.color : shade(d.color, F.lit + 0.06); ctx.fill();
      }
    }
    poly(P.c.map((q) => toScreen(q[0], q[1], P.h1)));
    ctx.fillStyle = top; ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.7; ctx.stroke(); }
  }
  function shadow(x, y, hx, hy, L, W, alpha = 0.22) {
    const nx = -hy, ny = hx, g = 0.3;
    poly([[L / 2 + g, W / 2 + g], [L / 2 + g, -W / 2 - g], [-L / 2 - g, -W / 2 - g], [-L / 2 - g, W / 2 + g]]
      .map(([a, b]) => toScreen(x + hx * a + nx * b + 0.45, y + hy * a + ny * b - 0.45, 0)));
    ctx.fillStyle = `rgba(40,30,15,${alpha})`; ctx.fill();
  }
  const SIDES = ['left', 'right'], ENDS = ['front', 'back'];
  // evenly spaced window panes along the sides between f0 and f1
  const panes = (f0, f1, n, gap, z0, z1, color, faces = SIDES) => {
    const out = [], w = (f1 - f0) / n;
    for (let i = 0; i < n; i++) out.push({ faces, f0: f0 + i * w + gap / 2, f1: f0 + (i + 1) * w - gap / 2, z0, z1, color });
    return out;
  };

  // ---------- vehicle models ----------
  function drawCar(q, small) {
    const v = q.v, { x, y, hx, hy } = q;
    shadow(x, y, hx, hy, v.L, v.W);
    const body = v.H * 0.55;
    const P = prism(x, y, hx, hy, v.L, v.W, 0.25, body);
    paint(P, {
      side: v.color, top: shade(v.color, 1.05), stroke: small ? null : 'rgba(30,25,20,.35)',
      details: small ? [] : [
        { faces: ['back'], f0: 0.06, f1: 0.22, z0: 0.12, z1: 0.24, color: '#c0221b' }, { faces: ['back'], f0: 0.78, f1: 0.94, z0: 0.12, z1: 0.24, color: '#c0221b' },
        { faces: ['front'], f0: 0.06, f1: 0.2, z0: 0.14, z1: 0.24, color: '#fff8d8' }, { faces: ['front'], f0: 0.8, f1: 0.94, z0: 0.14, z1: 0.24, color: '#fff8d8' },
      ],
    });
    if (small) return;
    const cabL = v.kind === 'van' ? v.L * 0.78 : v.L * 0.52, cx = v.kind === 'van' ? -v.L * 0.08 : -v.L * 0.06;
    const C = prism(x + hx * cx, y + hy * cx, hx, hy, cabL, v.W * 0.86, body, v.H);
    paint(C, { side: '#3c4a58', top: shade(v.color, 1.08), stroke: 'rgba(30,25,20,.35)', details: [{ faces: SIDES, f0: 0.46, f1: 0.54, z0: 0, z1: 1, color: v.color }] });
  }

  function drawBus(q, small) {
    const v = q.v, { x, y, hx, hy } = q, L = v.liv;
    shadow(x, y, hx, hy, v.L, v.W);
    const P = prism(x, y, hx, hy, v.L, v.W, 0.3, v.H);
    const H = v.H - 0.3;
    let details = [];
    if (!small) {
      details.push(
        { faces: [...SIDES, ...ENDS], f0: 0, f1: 1, z0: 0, z1: v.dd ? 0.85 : 0.62, color: L.skirt },
        ...(v.dd ? [] : [{ faces: [...SIDES, ...ENDS], f0: 0, f1: 1, z0: 0.62, z1: 0.72, color: L.stripe }]),
        // wheels
        { faces: SIDES, f0: 0.13, f1: 0.22, z0: -0.3, z1: 0.42, color: '#1b1b1b' },
        { faces: SIDES, f0: v.dd ? 0.62 : 0.68, f1: v.dd ? 0.71 : 0.77, z0: -0.3, z1: 0.42, color: '#1b1b1b' },
        // tail + head lights
        { faces: ['back'], f0: 0.05, f1: 0.16, z0: 0.35, z1: 0.75, color: '#c0221b' }, { faces: ['back'], f0: 0.84, f1: 0.95, z0: 0.35, z1: 0.75, color: '#c0221b' },
        { faces: ['front'], f0: 0.05, f1: 0.17, z0: 0.3, z1: 0.48, color: '#fff8d8' }, { faces: ['front'], f0: 0.83, f1: 0.95, z0: 0.3, z1: 0.48, color: '#fff8d8' },
      );
      if (v.dd) {
        details.push(
          { faces: SIDES, f0: 0.02, f1: 0.1, z0: 0.15, z1: 1.95, color: L.glass }, // front door
          ...panes(0.24, 0.98, 4, 0.02, 0.95, 1.85, L.glass),
          ...panes(0.02, 0.98, 6, 0.015, 2.3, 3.45, L.glass),
          { faces: ['front'], f0: 0.05, f1: 0.95, z0: 0.9, z1: 1.95, color: L.glass },
          { faces: ['front'], f0: 0.08, f1: 0.92, z0: 2.0, z1: 2.22, color: '#ffb21a', glow: true },
          { faces: ['front'], f0: 0.04, f1: 0.96, z0: 2.3, z1: 3.55, color: L.glass },
          { faces: ['back'], f0: 0.2, f1: 0.8, z0: 2.4, z1: 3.3, color: L.glass },
        );
      } else {
        details.push(
          { faces: SIDES, f0: 0.025, f1: 0.1, z0: 0.15, z1: 2.4, color: L.glass }, // front door
          { faces: SIDES, f0: 0.5, f1: 0.57, z0: 0.15, z1: 2.4, color: L.glass }, // rear door
          ...panes(0.11, 0.49, 3, 0.02, 0.95, 2.4, L.glass),
          ...panes(0.58, 0.97, 3, 0.02, 0.95, 2.4, L.glass),
          { faces: ['front'], f0: 0.04, f1: 0.96, z0: 0.75, z1: 2.45, color: L.glass },
          { faces: ['front'], f0: 0.1, f1: 0.9, z0: 2.52, z1: 2.75, color: '#ffb21a', glow: true },
          { faces: ['back'], f0: 0.25, f1: 0.75, z0: 1.5, z1: 2.3, color: L.glass },
        );
      }
    }
    const tex = small ? {} : v.dd
      ? { left: { img: SPR.goLeft }, right: { img: SPR.goRight }, front: { img: SPR.goFront }, back: { img: SPR.goRear } }
      : { left: { img: SPR.grtSide }, right: { img: SPR.grtSide }, front: { img: SPR.grtFront } };
    paint(P, { side: L.body, top: L.roof, details, tex, stroke: small ? null : 'rgba(30,25,20,.35)' });
    if (!small) {
      // roof-mounted HVAC pod toward the rear
      const o = -v.L * 0.28;
      const R = prism(x + hx * o, y + hy * o, hx, hy, v.L * 0.24, v.W * 0.78, v.H, v.H + 0.32);
      paint(R, { side: shade(L.roof, 0.92), top: shade(L.roof, 0.97), stroke: 'rgba(30,25,20,.25)' });
    }
  }

  function drawIonSection(q, small) {
    const v = q.v, { x, y, hx, hy, seg } = q, L = v.liv;
    const len = ION_SEGS[seg], last = ION_SEGS.length - 1;
    shadow(x, y, hx, hy, len, v.W);
    const P = prism(x, y, hx, hy, len, v.W, 0.45, v.H);
    const details = [];
    if (!small) {
      const cabFront = seg === 0, cabBack = seg === last;
      details.push(
        { faces: SIDES, f0: 0, f1: 1, z0: 0, z1: 0.5, color: L.skirt },
        { faces: SIDES, f0: 0, f1: 1, z0: 0.5, z1: 0.6, color: L.stripe },
        { faces: SIDES, f0: 0.02, f1: 0.98, z0: 0.95, z1: 2.45, color: L.glass },
      );
      // doors: double-leaf, slightly lighter than the glass band, one or two per section
      const doors = seg === 0 || seg === last ? [0.55] : [0.5];
      for (const d of doors) details.push({ faces: SIDES, f0: d - 0.06, f1: d + 0.06, z0: 0.08, z1: 2.5, color: '#46525e' }, { faces: SIDES, f0: d - 0.003, f1: d + 0.003, z0: 0.08, z1: 2.5, color: '#9aa4ad' });
      // window pillars
      for (let f = 0.1; f < 0.95; f += 0.115) details.push({ faces: SIDES, f0: f, f1: f + 0.012, z0: 0.95, z1: 2.45, color: L.body });
      const cab = (face) => {
        details.push(
          { faces: [face], f0: 0, f1: 1, z0: 0, z1: 3.25, color: L.nose },
          { faces: [face], f0: 0.06, f1: 0.94, z0: 1.0, z1: 2.55, color: L.glass },
          { faces: [face], f0: 0.15, f1: 0.85, z0: 2.65, z1: 2.95, color: '#ffb21a', glow: true },
          { faces: [face], f0: 0.06, f1: 0.2, z0: 0.35, z1: 0.55, color: face === 'front' ? '#fff8d8' : '#d0261d', glow: true },
          { faces: [face], f0: 0.8, f1: 0.94, z0: 0.35, z1: 0.55, color: face === 'front' ? '#fff8d8' : '#d0261d', glow: true },
          { faces: [face], f0: 0, f1: 1, z0: 0, z1: 0.3, color: L.skirt },
        );
        // dark wrap-around at the cab corner
        const f0 = face === 'front' ? 0 : 0.9, f1 = face === 'front' ? 0.1 : 1;
        details.push({ faces: SIDES, f0, f1, z0: 0.95, z1: 3.25, color: L.nose });
      };
      if (cabFront) cab('front');
      if (cabBack) cab('back');
      if (!cabFront) details.push({ faces: ['front'], f0: 0.1, f1: 0.9, z0: 0.2, z1: 3.1, color: '#3a3f44' });
      if (!cabBack) details.push({ faces: ['back'], f0: 0.1, f1: 0.9, z0: 0.2, z1: 3.1, color: '#3a3f44' });
    }
    let tex = {};
    if (!small) {
      // left side shows the photo as taken; the right side reuses it end-for-end (both ends are cabs)
      const [a, b] = ION_SLICES[seg], [ra, rb] = ION_SLICES[last - seg];
      tex = { left: { img: SPR.ionSide, sx: a, sw: b - a }, right: { img: SPR.ionSide, sx: ra, sw: rb - ra, rev: true } };
      if (seg === 0) tex.front = { img: SPR.ionFront };
      if (seg === last) tex.back = { img: SPR.ionFront };
    }
    paint(P, { side: L.body, top: L.roof, details, tex, stroke: small ? null : 'rgba(30,25,20,.35)' });
    if (small) return;
    // flexible bellows to the next module
    if (seg < last) {
      const o = -(len / 2 + ION_GAP / 2);
      const Bw = prism(x + hx * o, y + hy * o, hx, hy, ION_GAP + 0.15, v.W * 0.9, 0.6, v.H - 0.12);
      paint(Bw, { side: '#24282c', top: '#2e3337' });
    }
    // roof equipment: boxes on the cab modules, pantograph on the middle one
    if (seg === 0 || seg === last) {
      const o = seg === 0 ? -1.2 : 1.2;
      const R = prism(x + hx * o, y + hy * o, hx, hy, 4.2, 2.0, v.H, v.H + 0.45);
      paint(R, { side: '#c9ced3', top: '#d8dde1', stroke: 'rgba(30,25,20,.25)' });
    } else if (seg === 2) {
      const base = [x, y, v.H + 0.15], nx = -hy, ny = hx;
      const R = prism(x, y, hx, hy, 2.2, 1.6, v.H, v.H + 0.18);
      paint(R, { side: '#9aa3ab', top: '#aab2b9' });
      const knee = [x - hx * 0.9, y - hy * 0.9, v.H + 0.75], head = [x + hx * 0.2, y + hy * 0.2, v.H + 1.35];
      line3(base, knee, '#2a3138', 0.08); line3(knee, head, '#2a3138', 0.08);
      line3([head[0] + nx * 0.85, head[1] + ny * 0.85, head[2]], [head[0] - nx * 0.85, head[1] - ny * 0.85, head[2]], '#2a3138', 0.1);
    }
  }

  // ---------- crossings ----------
  // ground markings (drawn under everything that stands up)
  function drawCrossingGround(c) {
    const { x, y, rx, ry, w, span, oneway } = c, nx = -ry, ny = rx;
    const P = (a, b) => toScreen(x + rx * a + nx * b, y + ry * a + ny * b, 0.05);
    const rect = (a0, a1, b0, b1, color) => { poly([P(a0, b0), P(a1, b0), P(a1, b1), P(a0, b1)]); ctx.fillStyle = color; ctx.fill(); };
    if (c.foot) { // concrete walkway over the rails, white edge lines, yellow tactile strips where you wait
      rect(-span / 2, span / 2, -w / 2, w / 2, 'rgba(200,196,186,.9)');
      rect(-span / 2, span / 2, -w / 2, -w / 2 + 0.15, 'rgba(255,255,255,.95)');
      rect(-span / 2, span / 2, w / 2 - 0.15, w / 2, 'rgba(255,255,255,.95)');
      for (const s of [1, -1]) rect(s * (span / 2 + 0.2), s * (span / 2 + 0.9), -w / 2, w / 2, '#f2c418');
      return;
    }
    rect(-span / 2, span / 2, -w / 2, w / 2, 'rgba(62,60,58,.55)'); // rubber crossing panel
    const d = span / 2 + 2.6;
    // stop bars on the approach lanes (right-hand traffic)
    if (oneway) rect(-d - 0.5, -d, -w / 2 + 0.3, w / 2 - 0.3, 'rgba(255,255,255,.92)');
    else {
      rect(-d - 0.5, -d, -w / 2 + 0.3, 0, 'rgba(255,255,255,.92)');
      rect(d, d + 0.5, 0, w / 2 - 0.3, 'rgba(255,255,255,.92)');
    }
    // "X" pavement marking ahead of the stop bar
    const X = (a, b0, b1) => {
      const L0 = 4.5, w0 = 0.35;
      for (const s of [1, -1]) {
        const p = [[a - L0 / 2, s > 0 ? b0 : b1], [a + L0 / 2, s > 0 ? b1 : b0]];
        const dx = p[1][0] - p[0][0], db = p[1][1] - p[0][1], l = Math.hypot(dx, db), ox = (-db / l) * w0 / 2, ob = (dx / l) * w0 / 2;
        poly([P(p[0][0] + ox, p[0][1] + ob), P(p[1][0] + ox, p[1][1] + ob), P(p[1][0] - ox, p[1][1] - ob), P(p[0][0] - ox, p[0][1] - ob)]);
        ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fill();
      }
    };
    if (oneway) X(-d - 9, -w / 4 - 1.2, -w / 4 + 1.2), X(-d - 9, w / 4 - 1.2, w / 4 + 1.2);
    else { X(-d - 9, -w / 4 - 1, -w / 4 + 1); X(d + 9, w / 4 - 1, w / 4 + 1); }
  }
  // signal masts: crossbuck, two flashing lamps and a striped gate arm per approach
  function crossingMasts(c) {
    const { x, y, rx, ry, w, span, oneway } = c;
    const out = [];
    for (const dir of oneway ? [1] : [1, -1]) {
      const ax = rx * dir, ay = ry * dir;           // approach direction of travel
      const sx = ay, sy = -ax;                      // to the right of it
      const back = span / 2 + 1.2;
      out.push({ c, dir, px: x - ax * back + sx * (w / 2 + 0.8), py: y - ay * back + sy * (w / 2 + 0.8), ax, ay, sx, sy, len: oneway ? w - 0.2 : w / 2 + 0.3 });
    }
    return out;
  }
  const masts = crossings.flatMap(crossingMasts);
  function drawMast(m, small) {
    const { px, py, ax, ay, sx, sy, c } = m;
    const on = c.active || c.arm < Math.PI / 2 - 0.12;
    const blink = Math.floor(clock * 2) % 2;
    line3([px, py, 0], [px, py, 4.1], '#d9dcdf', 0.14, 0.8);
    if (small) return;
    // gate arm: pivots on the mast at ~1 m, swings from vertical down across the lanes
    const ca = Math.cos(c.arm), sa = Math.sin(c.arm), piv = [px - sx * 0.35, py - sy * 0.35, 1.05];
    const tip = [piv[0] - sx * m.len * ca, piv[1] - sy * m.len * ca, piv[2] + m.len * sa];
    const n = 9;
    for (let i = 0; i < n; i++) {
      const u0 = i / n, u1 = (i + 1) / n;
      line3([piv[0] + (tip[0] - piv[0]) * u0, piv[1] + (tip[1] - piv[1]) * u0, piv[2] + (tip[2] - piv[2]) * u0],
        [piv[0] + (tip[0] - piv[0]) * u1, piv[1] + (tip[1] - piv[1]) * u1, piv[2] + (tip[2] - piv[2]) * u1], i % 2 ? '#f4f4f0' : '#d0261d', 0.13, 0.8);
    }
    if (on) dot3(tip, 0.1, blink ? '#ff3b2f' : '#5a1d1a');
    // crossbuck (white X with red edge) facing the approaching traffic
    const cb = [px, py, 3.6], d1 = 0.62, d2 = 0.42;
    for (const s of [1, -1]) {
      const a = [cb[0] - sx * d1, cb[1] - sy * d1, cb[2] - s * d2], b = [cb[0] + sx * d1, cb[1] + sy * d1, cb[2] + s * d2];
      line3(a, b, '#c62a22', 0.24, 1); line3(a, b, '#ffffff', 0.15, 0.7);
    }
    // two lamps on a cross-arm, alternating
    const lampZ = 2.55;
    line3([px - sx * 0.55, py - sy * 0.55, lampZ], [px + sx * 0.55, py + sy * 0.55, lampZ], '#2b2f33', 0.08);
    [-0.45, 0.45].forEach((o, i) => {
      const p = [px + sx * o, py + sy * o, lampZ];
      dot3(p, 0.24, '#202326');
      const lit = on && (i === blink);
      dot3(p, 0.15, lit ? '#ff3b2f' : '#4b1c19');
      if (lit) {
        const s = toScreen(...p), r = Math.max(4, 1.1 * pxPerM);
        const g = ctx.createRadialGradient(s[0], s[1], 0, s[0], s[1], r);
        g.addColorStop(0, 'rgba(255,70,50,.55)'); g.addColorStop(1, 'rgba(255,70,50,0)');
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s[0], s[1], r, 0, Math.PI * 2); ctx.fill();
      }
    });
  }

  // ---------- overhead line (catenary) along the ION ----------
  // poles stand between the two tracks (or beside a lone track) with an arm over each
  const poles = [];
  if (ionPath) {
    const other = tracks[1]?.path;
    for (let s = 10; s < ionPath.len; s += 42) {
      const a = ionPath.at(s);
      let b = null, sb = 0;
      if (other) { // nearest point on the other track
        let bd = Infinity;
        for (let u = 0; u <= other.len; u += 2) { const q = other.at(u), d = Math.hypot(q.x - a.x, q.y - a.y); if (d < bd) { bd = d; b = q; sb = u; } }
        if (bd > 10) b = null;
      }
      const x = b ? (a.x + b.x) / 2 : a.x + a.hy * 2.6, y = b ? (a.y + b.y) / 2 : a.y - a.hx * 2.6;
      poles.push({ s, sb: b ? sb : null, x, y, arms: b ? [[a.x, a.y], [b.x, b.y]] : [[a.x, a.y]] });
    }
  }
  function drawPole(p) {
    line3([p.x, p.y, 0], [p.x, p.y, 6.6], '#8d949a', 0.16, 0.7);
    for (const [ax, ay] of p.arms) line3([p.x, p.y, 6.2], [ax + (ax - p.x) * 0.15, ay + (ay - p.y) * 0.15, 6.2], '#8d949a', 0.08, 0.6);
  }
  function drawWires(i) {
    const a = poles[i], b = poles[i + 1];
    ctx.lineWidth = Math.max(0.5, 0.03 * pxPerM);
    ctx.strokeStyle = 'rgba(40,44,48,.55)';
    const run = (path, s0, s1) => {
      if (s0 == null || s1 == null || Math.abs(s1 - s0) > 80) return;
      ctx.beginPath();
      const n = Math.max(1, Math.ceil(Math.abs(s1 - s0) / 7));
      for (let k = 0; k <= n; k++) { const p = path.at(s0 + ((s1 - s0) * k) / n), q = toScreen(p.x, p.y, 5.75); k ? ctx.lineTo(...q) : ctx.moveTo(...q); }
      ctx.stroke();
    };
    run(ionPath, a.s, b.s);
    if (tracks[1]) run(tracks[1].path, a.sb, b.sb);
  }

  // ---------- goalposts (Canadian football: on the goal lines, 110 yd apart) ----------
  const goalposts = [];
  for (const f of T.fields || []) {
    if (f.sport !== 'canadian_football') continue;
    for (const s of [1, -1]) goalposts.push({ f, a: s * 50.3, s });
  }
  function drawGoalpost(gp) {
    const f = gp.f, vx = -f.uy, vy = f.ux;
    const at = (a, b) => [f.x + f.ux * a + vx * b, f.y + f.uy * a + vy * b];
    const Y = '#f2d10a', w = 0.16;
    const base = at(gp.a + gp.s * 1.6, 0), neck = at(gp.a, 0);
    // gooseneck: post set back behind the goal line, curving forward to the crossbar
    line3([...base, 0], [...base, 2.4], Y, w, 1);
    line3([...base, 2.4], [...neck, 3.05], Y, w, 1);
    const l = at(gp.a, -2.82), r = at(gp.a, 2.82);
    line3([...l, 3.05], [...r, 3.05], Y, w, 1);
    line3([...l, 3.05], [...l, 9.1], Y, w * 0.8, 1);
    line3([...r, 3.05], [...r, 9.1], Y, w * 0.8, 1);
  }

  // ---------- people and geese ----------
  function drawPerson(p, g, small) {
    const [x, y] = fieldXY(g, p.a, p.b);
    drawFigure(p, x, y, g.f.ux * p.ha + g.vx * p.hb, g.f.uy * p.ha + g.vy * p.hb, small);
  }
  function drawWalker(w, small) {
    if (w.rest > 0) return;
    const [x, y] = walkerXY(w);
    drawFigure(w, x, y, w.c.rx * w.dir, w.c.ry * w.dir, small);
  }
  function drawFigure(p, x, y, hx, hy, small) {
    if (small) { const s = toScreen(x, y, 1.1); ctx.fillStyle = p.shirt; ctx.fillRect(s[0] - 1, s[1] - 1.5, 2, 3); return; }
    const bob = p.v > 0.5 ? Math.abs(Math.sin(p.phase)) * 0.06 : 0;
    const sw = p.v > 0.5 ? Math.sin(p.phase) * Math.min(0.28, p.v * 0.06) : 0;
    const k = PEOPLE_SCALE;
    shadow(x, y, hx, hy, 0.4 * k, 0.4 * k, 0.2);
    const nx = -hy, ny = hx, legH = p.H * 0.5;
    for (const s of [1, -1]) {
      const o = s * sw * k;
      const P = prism(x + hx * o + nx * s * 0.1 * k, y + hy * o + ny * s * 0.1 * k, hx, hy, 0.16 * k, 0.14 * k, 0, legH + bob);
      paint(P, { side: p.pants, top: p.pants });
    }
    const T = prism(x, y, hx, hy, 0.24 * k, 0.42 * k, legH + bob, p.H * 0.84 + bob);
    paint(T, { side: p.shirt, top: shade(p.shirt, 1.05) });
    dot3([x, y, p.H * 0.93 + bob], 0.12 * k, p.skin, 1);
  }
  function drawBall(g) {
    const b = g.ball, [x, y] = fieldXY(g, b.a, b.b);
    const sh = toScreen(x, y, 0);
    ctx.fillStyle = 'rgba(40,30,15,.25)'; ctx.beginPath(); ctx.ellipse(sh[0], sh[1], Math.max(1, 0.18 * pxPerM), Math.max(0.6, 0.09 * pxPerM), 0, 0, Math.PI * 2); ctx.fill();
    if (g.kind === 'frisbee') {
      const s = toScreen(x, y, b.z * PEOPLE_SCALE);
      ctx.fillStyle = '#ff6b3d'; ctx.beginPath(); ctx.ellipse(s[0], s[1], Math.max(1.4, 0.14 * pxPerM), Math.max(0.7, 0.06 * pxPerM), 0, 0, Math.PI * 2); ctx.fill();
    } else dot3([x, y, b.z * PEOPLE_SCALE], (g.kind === 'football' ? 0.13 : 0.12) * PEOPLE_SCALE, g.kind === 'football' ? '#7a4524' : '#fafafa', 0.9);
  }
  function drawGoose(g, small) {
    const { x, y, hx, hy } = g, k = g.size;
    if (small) { const s = toScreen(x, y, 0.4); ctx.fillStyle = '#6b5d4d'; ctx.fillRect(s[0] - 1, s[1] - 0.6, 2, 1.4); return; }
    const z0 = g.swim ? 0.02 : 0.24;
    if (g.swim) { // ripples
      const s = toScreen(x, y, 0), r = 0.7 * k * pxPerM;
      ctx.strokeStyle = 'rgba(255,255,255,.35)'; ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.ellipse(s[0], s[1], r * 1.2, r * 0.6, 0, 0, Math.PI * 2); ctx.stroke();
    } else {
      shadow(x, y, hx, hy, 0.7 * k, 0.35 * k, 0.18);
      line3([x - hx * 0.05, y - hy * 0.05, 0], [x - hx * 0.05, y - hy * 0.05, z0 + 0.05], '#222', 0.04);
    }
    // hissing: wings half open (two flaps out from the shoulders), the far one behind the body
    const hiss = g.state === 'hiss', nx = -hy, ny = hx;
    const wing = (s) => {
      const fl = Math.sin(g.flap * 16) * 0.07 * k, o = (a, b, h) => toScreen(x + hx * a * k + nx * b * s * k, y + hy * a * k + ny * b * s * k, z0 + h * k);
      poly([o(0.18, 0.12, 0.27), o(-0.24, 0.12, 0.25), o(-0.08, 0.6, 0.5 + fl / k)]);
      ctx.fillStyle = '#685a49'; ctx.fill();
      poly([o(0.1, 0.12, 0.27), o(-0.08, 0.6, 0.5 + fl / k), o(-0.02, 0.4, 0.38)]);
      ctx.fillStyle = '#8f806c'; ctx.fill();
    };
    const nearS = nx * CAM[0] + ny * CAM[1] > 0 ? 1 : -1;
    if (hiss) wing(-nearS);
    // body + white tail patch
    const P = prism(x, y, hx, hy, 0.68 * k, 0.32 * k, z0, z0 + 0.3 * k);
    paint(P, { side: '#7d6e5c', top: '#8f806c', details: [{ faces: ['back', ...SIDES], f0: 0.85, f1: 1, z0: 0, z1: 0.12, color: '#f2efe8' }, { faces: SIDES, f0: 0, f1: 1, z0: 0, z1: 0.07, color: '#d9d2c5' }] });
    if (hiss) wing(nearS);
    // neck + head: up when alert/walking, down to the grass when grazing, stretched out low when hissing
    const grazing = g.state === 'graze' && !g.swim;
    const bob = grazing ? Math.sin(g.peck * 5) * 0.03 : 0;
    const base = [x + hx * 0.28 * k, y + hy * 0.28 * k, z0 + 0.24 * k];
    const head = hiss ? [x + hx * 0.8 * k, y + hy * 0.8 * k, z0 + 0.26 * k + Math.sin(g.flap * 9) * 0.02 * k]
      : grazing ? [x + hx * 0.55 * k, y + hy * 0.55 * k, 0.07 + bob] : [x + hx * 0.36 * k, y + hy * 0.36 * k, z0 + 0.72 * k];
    line3(base, head, '#141414', 0.07 * k, 1);
    dot3(head, 0.065 * k, '#141414', 1);
    dot3([head[0] - hy * 0.03, head[1] + hx * 0.03, head[2] - 0.01], 0.03 * k, '#f2efe8', 0.5);
    if (hiss) {
      dot3([head[0] + hx * 0.07 * k, head[1] + hy * 0.07 * k, head[2]], 0.03 * k, '#e2788a', 0.6); // open beak, pink tongue
      if (pxPerM > 2.5 && !g.quiet) { // a little speech label
        const s = toScreen(x, y, z0 + 1.1 * k);
        ctx.font = '700 10px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.lineWidth = 2.5; ctx.strokeStyle = 'rgba(20,16,10,.75)'; ctx.strokeText('HSSSS!', s[0], s[1]);
        ctx.fillStyle = '#fff'; ctx.fillText('HSSSS!', s[0], s[1]);
      }
    }
  }
  function drawGosling(c, small) {
    const { x, y, hx, hy } = c, k = c.size;
    if (small) return;
    const bob = c.v > 0.1 ? Math.abs(Math.sin(c.phase)) * 0.02 * k : 0;
    shadow(x, y, hx, hy, 0.3 * k, 0.18 * k, 0.15);
    const P = prism(x, y, hx, hy, 0.28 * k, 0.17 * k, 0.05 + bob, 0.05 + bob + 0.16 * k);
    paint(P, { side: '#c9b65e', top: '#dccb78' });
    dot3([x + hx * 0.16 * k, y + hy * 0.16 * k, 0.05 + bob + 0.25 * k], 0.07 * k, '#a8975a', 0.8);
    dot3([x + hx * 0.23 * k, y + hy * 0.23 * k, 0.05 + bob + 0.24 * k], 0.025 * k, '#3a332a', 0.4);
  }
  // a goose in the air, wings beating; drawn above everything (they fly higher than the buildings)
  function drawFlyer(x, y, z, hx, hy, ph, k, small) {
    if (small) { const s = toScreen(x, y, z); ctx.fillStyle = '#3b342c'; ctx.fillRect(s[0] - 1, s[1] - 0.5, 2, 1); return; }
    const nx = -hy, ny = hx, up = Math.sin(ph) * 0.4;
    const P = (a, b, h) => toScreen(x + (hx * a + nx * b) * k, y + (hy * a + ny * b) * k, z + h * k);
    for (const s of [1, -1]) {
      poly([P(0.14, 0.08 * s, 0), P(-0.22, 0.08 * s, 0), P(-0.12, 0.9 * s, up)]); ctx.fillStyle = '#5b4f42'; ctx.fill();
    }
    const tail = P(-0.42, 0, 0), chest = P(0.24, 0, 0.02), headP = P(0.64, 0, 0.06);
    ctx.lineWidth = Math.max(1.5, 0.24 * k * pxPerM); ctx.strokeStyle = '#7d6e5c';
    ctx.beginPath(); ctx.moveTo(...tail); ctx.lineTo(...chest); ctx.stroke();
    ctx.lineWidth = Math.max(0.8, 0.08 * k * pxPerM); ctx.strokeStyle = '#141414';
    ctx.beginPath(); ctx.moveTo(...chest); ctx.lineTo(...headP); ctx.stroke();
    ctx.fillStyle = '#f2efe8'; ctx.fillRect(tail[0] - 0.75, tail[1] - 0.75, 1.5, 1.5);
  }
  function drawFlights(small, hiddenAt) {
    if (!flights.length || pxPerM < 0.35) return;
    const k = GOOSE_SCALE * 0.9, sh = Math.max(1, 0.5 * k * pxPerM);
    const onScr = (s) => s[0] > -40 && s[1] > -40 && s[0] < innerWidth + 40 && s[1] < innerHeight + 40;
    // shadows on the ground first (hidden behind buildings like everything else), then the birds
    ctx.fillStyle = `rgba(40,30,15,${small ? 0.1 : 0.14})`;
    for (const f of flights) for (const b of f.birds) {
      const x = f.x - f.hx * b.b - f.hy * b.s, y = f.y - f.hy * b.b + f.hx * b.s, s = toScreen(x, y, 0);
      if (!onScr(s) || hiddenAt(x, y)) continue;
      ctx.beginPath(); ctx.ellipse(s[0], s[1], sh * 1.4, sh * 0.6, 0, 0, Math.PI * 2); ctx.fill();
    }
    for (const f of flights) for (const b of f.birds) {
      const x = f.x - f.hx * b.b - f.hy * b.s, y = f.y - f.hy * b.b + f.hx * b.s, z = f.z + Math.sin(f.t * 1.3 + b.bob) * 0.4;
      if (!onScr(toScreen(x, y, z))) continue;
      drawFlyer(x, y, z, f.hx, f.hy, b.ph, k, small);
    }
  }

  // ---------- cards (buses + ION) ----------
  const cardOf = new Map();
  function card(v) {
    let el = cardOf.get(v);
    if (!el) {
      el = document.createElement('div');
      el.className = 'vcard chip';
      el.innerHTML = '<img class="lg" alt=""><span class="rb"></span><span class="vt"><b></b><small></small></span>';
      cardLayer.appendChild(el);
      cardOf.set(v, el);
      el._logo = el.querySelector('.lg');
      el._badge = el.querySelector('.rb'); el._title = el.querySelector('b'); el._sub = el.querySelector('small');
    }
    return el;
  }
  const setText = (node, s) => { if (node._t !== s) { node._t = s; node.textContent = s; } };
  function cardInfo(v) {
    if (v.type === 'bus') {
      const r = v.route, st = v.stops[v.next];
      return {
        logo: r.agency === 'GO' ? 'logo-go.png' : 'logo-grt.png', badge: r.id, color: r.color, title: r.name,
        sub: v.dwell > 0 && st ? `At ${st.name}` : st ? `Next · ${st.name}` : 'Leaving the area',
      };
    }
    const north = v.dir === 1;
    const before = v.station != null && !v.served && v.dwell <= 0;
    return {
      logo: 'logo-ion.png', badge: '', color: ion.color, title: `to ${north ? ion.northTerminus : ion.southTerminus}`,
      sub: v.dwell > 0 ? `At ${ion.stationName}` : before ? `Next · ${ion.stationName}` : `Next · ${north ? ion.northNext : ion.southNext}`,
    };
  }

  // ---------- frame ----------
  // keep animating even if one frame throws (log the first error only)
  // paused: nothing moves or draws, and the clock does not jump when it resumes
  let enabled = true;
  let night = 0, nightTarget = 0;
  let timeScale = 1, lastItems = [];
  // A ground-level glow ahead of a vehicle: a soft cone, `reach` metres long.
  function beam(x, y, hx, hy, half, reach, alpha) {
    const nx = -hy, ny = hx, a = toScreen(x, y, 0.05), b = toScreen(x + hx * reach, y + hy * reach, 0.05);
    const g = ctx.createLinearGradient(a[0], a[1], b[0], b[1]);
    g.addColorStop(0, `rgba(255,226,160,${alpha})`); g.addColorStop(1, 'rgba(255,226,160,0)');
    poly([[x + nx * half, y + ny * half], [x - nx * half, y - ny * half],
      [x + hx * reach - nx * half * 2.4, y + hy * reach - ny * half * 2.4], [x + hx * reach + nx * half * 2.4, y + hy * reach + ny * half * 2.4]]
      .map(([px, py]) => toScreen(px, py, 0.05)));
    ctx.fillStyle = g; ctx.fill();
  }
  function glow(p, rPx, rgb, alpha) {
    const s = toScreen(...p), g = ctx.createRadialGradient(s[0], s[1], 0, s[0], s[1], rPx);
    g.addColorStop(0, `rgba(${rgb},${alpha})`); g.addColorStop(0.35, `rgba(${rgb},${alpha * 0.35})`); g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(s[0], s[1], rPx, 0, Math.PI * 2); ctx.fill();
  }
  function drawNight(items, small) {
    const dpr = devicePixelRatio || 1;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-atop'; // only over what is already drawn: the vehicles, people and geese
    ctx.fillStyle = `rgba(18,14,42,${(0.68 * night).toFixed(3)})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = 'lighter';
    const k = night, r = (m, min) => Math.max(min, m * pxPerM);
    for (const q of items) {
      const v = q.v;
      if (q.hidden || !v || !(v.type === 'car' || v.type === 'bus' || v.type === 'ion')) continue;
      const { x, y } = q;
      const { hx, hy } = q; // already the direction of travel (section 0 is the leading cab)
      const L = v.type === 'ion' ? ION_SEGS[q.seg] : v.L, nx = -hy, ny = hx, half = v.W / 2 - 0.25;
      const front = v.type !== 'ion' || q.seg === 0, back = v.type !== 'ion' || q.seg === ION_SEGS.length - 1;
      const fz = v.type === 'car' ? 0.55 : 0.75;
      if (front) {
        if (!small) beam(x + hx * L / 2, y + hy * L / 2, hx, hy, half, v.type === 'car' ? 11 : 14, 0.28 * k);
        for (const sd of [1, -1]) glow([x + hx * (L / 2 + 0.05) + nx * half * sd, y + hy * (L / 2 + 0.05) + ny * half * sd, fz], r(0.9, 2.2), '255,240,200', 0.85 * k);
      }
      if (back) for (const sd of [1, -1]) glow([x - hx * (L / 2 + 0.05) + nx * half * sd, y - hy * (L / 2 + 0.05) + ny * half * sd, fz], r(0.6, 1.6), '255,40,30', 0.7 * k);
      if (v.type !== 'car' && !small) {
        // the cabin: a warm band at window height along whichever side faces us
        const sd = nx * CAM[0] + ny * CAM[1] > 0 ? 1 : -1, z = v.type === 'ion' ? 1.7 : v.dd ? 2.9 : 1.7;
        const o = [x + nx * (v.W / 2) * sd, y + ny * (v.W / 2) * sd];
        for (const zz of v.dd ? [1.4, z] : [z]) {
          ctx.globalAlpha = 0.5 * k;
          line3([o[0] - hx * L * 0.45, o[1] - hy * L * 0.45, zz], [o[0] + hx * L * 0.45, o[1] + hy * L * 0.45, zz], 'rgba(255,214,150,.55)', 0.9, 1);
          ctx.globalAlpha = 1;
        }
      }
    }
    ctx.restore();
  }
  function frame(now) {
    if (enabled) {
      try { drawFrame(now); } catch (e) { if (!frame.err) { frame.err = e; console.error('map life frame failed', e); } }
    } else frame.last = now;
    requestAnimationFrame(frame);
  }
  function setEnabled(on) {
    enabled = !!on;
    cardLayer.style.display = enabled ? '' : 'none';
    if (!enabled) { ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, canvas.width, canvas.height); }
  }
  function drawFrame(now) {
    const dt = Math.min(0.1, (now - (frame.last || now)) / 1000) * timeScale;
    frame.last = now;
    // fast-forward (time-lapse) in small steps so cars still queue and stop properly
    const n = Math.max(1, Math.ceil(dt / 0.1));
    for (let i = 0; i < n; i++) step(dt / n);

    const item = viewer.world.getItemAt(0);
    const dpr = devicePixelRatio || 1;
    if (canvas.width !== innerWidth * dpr || canvas.height !== innerHeight * dpr) { canvas.width = innerWidth * dpr; canvas.height = innerHeight * dpr; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!item) return;
    const p0 = item.imageToViewerElementCoordinates(new OpenSeadragon.Point(0, 0));
    const p1 = item.imageToViewerElementCoordinates(new OpenSeadragon.Point(1000, 0));
    view = { ox: p0.x, oy: p0.y, k: (p1.x - p0.x) / 1000 };
    pxPerM = view.k * Math.hypot(PX[0], PY[0]);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    const small = pxPerM < 1.6;
    const onScreen = (sx, sy, m = 60) => sx > -m && sy > -m && sx < innerWidth + m && sy < innerHeight + m;
    const hiddenAt = (x, y) => { const [ix, iy] = toImage(x, y); return occluded(ix, iy); };

    // ground markings first
    if (pxPerM > 0.9) for (const c of crossings) {
      const [sx, sy] = toScreen(c.x, c.y, 0);
      if (onScreen(sx, sy, 200) && inBounds(c.x, c.y)) drawCrossingGround(c);
    }

    // everything that stands up, depth-sorted on screen y
    const items = [];
    const add = (x, y, draw, v, extra) => {
      if (!inBounds(x, y)) return;
      const [sx, sy] = toScreen(x, y, 0);
      if (!onScreen(sx, sy)) return;
      items.push({ x, y, sx, sy, draw, v, hidden: hiddenAt(x, y), ...extra });
    };
    for (const c of liveCars()) { const p = poses.get(c) || carPose(c); add(p.x, p.y, drawCar, c, { hx: p.hx, hy: p.hy }); }
    for (const b of buses) { if (b.wait > 0) continue; const p = b.path.at(b.s); add(p.x, p.y, drawBus, b, { hx: p.hx, hy: p.hy }); }
    for (const t of trains) {
      if (t.wait > 0) continue;
      let off = 0;
      ION_SEGS.forEach((len, i) => {
        const p = t.path.at(t.s - t.dir * (off + len / 2), 0, t.dir);
        add(p.x, p.y, drawIonSection, t, { hx: p.hx, hy: p.hy, seg: i });
        off += len + ION_GAP;
      });
    }
    if (pxPerM > 0.9) for (const m of masts) add(m.px, m.py, (q, sm) => drawMast(m, sm), m, {});
    if (pxPerM > 1.2 && ionPath) {
      poles.forEach((p, i) => {
        add(p.x, p.y, () => drawPole(p), p, {});
        if (i + 1 < poles.length) {
          const a = poles[i], b = poles[i + 1], m = ionPath.at((a.s + b.s) / 2);
          if (!hiddenAt(a.x, a.y) && !hiddenAt(b.x, b.y)) add(m.x, m.y, () => drawWires(i), null, { wire: true });
        }
      });
    }
    if (pxPerM > 0.7) {
      for (const g of games) {
        for (const p of g.players) { const [x, y] = fieldXY(g, p.a, p.b); add(x, y, (q, s) => drawPerson(p, g, s), p, {}); }
        const [bx, by] = fieldXY(g, g.ball.a, g.ball.b); add(bx, by, () => drawBall(g), null, {});
      }
      for (const g of geese) if (!g.flock.away && !(g.flock.gone > 0)) add(g.x, g.y, (q, s) => drawGoose(g, s), g, {});
      for (const c of goslings) if (!(c.flock.gone > 0)) add(c.x, c.y, (q, s) => drawGosling(c, s), c, {});
      for (const w of walkers) { const [x, y] = walkerXY(w); add(x, y, (q, s) => drawWalker(w, s), w, {}); }
      for (const gp of goalposts) { const f = gp.f; add(f.x + f.ux * gp.a, f.y + f.uy * gp.a, () => drawGoalpost(gp), null, {}); }
    }
    api.small = small;
    for (const L of layers) if (L.collect) try { L.collect(add, api); } catch (e) { layerError(L, e); }
    items.sort((a, b) => (a.wire ? 1 : 0) - (b.wire ? 1 : 0) || a.sy - b.sy);
    lastItems = items;
    const visible = new Set();
    for (const q of items) {
      if (q.v && (q.v.type === 'bus' || q.v.type === 'ion')) visible.add(q.v);
      if (!q.hidden) q.draw(q, small);
    }
    drawFlights(small, hiddenAt); // geese overhead: above every building, still dimmed at night below

    // night: dim everything drawn so far to match the night map, then add headlights, tail lights and lit cabins
    night += (nightTarget - night) * Math.min(1, dt * 2.5);
    if (Math.abs(night - nightTarget) < 0.005) night = nightTarget;
    if (night > 0.01) drawNight(items, small);
    for (const L of layers) if (L.overlay) try { ctx.save(); L.overlay(ctx, api); ctx.restore(); } catch (e) { layerError(L, e); }

    // cards for buses and trains (anchored above the middle box); too zoomed out to read, they would just bury the map
    const compact = pxPerM < 1.1;
    cardLayer.style.visibility = pxPerM < 0.3 ? 'hidden' : '';
    const placed = [];
    for (const v of [...buses, ...trains]) {
      const el = cardOf.get(v);
      const head = items.find((q) => q.v === v && (q.seg == null || q.seg === 2));
      if (!visible.has(v) || !head) { if (el) el.style.display = 'none'; continue; }
      const c = card(v), info = cardInfo(v);
      const [ax, ay] = toScreen(head.x, head.y, v.H + 1.6);
      c.style.display = '';
      c.classList.toggle('compact', compact);
      c.classList.toggle('behind', !!head.hidden);
      c._badge.style.background = info.color;
      c._badge.style.display = info.badge ? '' : 'none';
      if (c._logo._src !== info.logo) { c._logo._src = info.logo; c._logo.src = 'sprites/' + info.logo; c._logo.alt = info.logo.includes('go') ? 'GO' : info.logo.includes('ion') ? 'ION' : 'GRT'; }
      const changed = c._compact !== compact | (c._title._t !== info.title) | (c._sub._t !== info.sub);
      setText(c._badge, info.badge); setText(c._title, info.title); setText(c._sub, info.sub);
      if (changed || !c._w) { c._compact = compact; c._w = c.offsetWidth; c._h = c.offsetHeight; }
      placed.push({ c, ax, ay, top: ay - 7 - c._h, sy: head.sy });
    }
    // stack cards that would overlap: the one nearest the camera keeps its spot, others lift above it
    placed.sort((a, b) => b.ay - a.ay);
    const boxes = [];
    for (const p of placed) {
      const w = p.c._w, h = p.c._h, x0 = p.ax - w / 2, x1 = p.ax + w / 2;
      let top = p.top;
      for (let guard = 0; guard < 12; guard++) {
        const hit = boxes.find((b) => x0 < b.x1 && x1 > b.x0 && top < b.y1 && top + h > b.y0);
        if (!hit) break;
        top = hit.y0 - h - 4;
      }
      boxes.push({ x0, x1, y0: top, y1: top + h });
      p.c.classList.toggle('lifted', top < p.top - 1);
      p.c.style.transform = `translate3d(${Math.round(x0)}px, ${Math.round(top)}px, 0)`;
      p.c.style.zIndex = String(Math.round(p.sy));
    }

  }
  // handy for poking at in devtools; the viewer uses setEnabled / isEnabled for its play-pause button
  // ---------- public API (viewer/index.html and the feature modules use this) ----------
  // scene coords (metres, x east / y north) -> screen px; h = metres above ground
  const poseOf = (v) => {
    if (!v) return null;
    if (v.type === 'car') return poses.get(v) || carPose(v);
    if (v.type === 'bus') return v.wait > 0 ? null : v.path.at(v.s);
    if (v.type === 'ion') return v.wait > 0 ? null : v.path.at(v.s - v.dir * (ION_LEN / 2), 0, v.dir);
    if (v.type === 'walker') { const [x, y] = walkerXY(v); return { x, y, hx: v.c.rx * v.dir, hy: v.c.ry * v.dir }; }
    if (v.x != null) return { x: v.x, y: v.y, hx: v.hx || 1, hy: v.hy || 0 };
    return null;
  };
  // the vehicle (car, bus or ION) drawn nearest a screen point, within `r` px
  function vehicleAt(sx, sy, r = 18) {
    let best = null, bd = r;
    for (const q of lastItems) {
      const v = q.v;
      if (q.hidden || !v || !(v.type === 'car' || v.type === 'bus' || v.type === 'ion')) continue;
      const len = v.type === 'ion' ? ION_SEGS[q.seg] : v.L;
      const a = toScreen(q.x - q.hx * len / 2, q.y - q.hy * len / 2, v.H / 2), b = toScreen(q.x + q.hx * len / 2, q.y + q.hy * len / 2, v.H / 2);
      const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy || 1;
      const u = Math.max(0, Math.min(1, ((sx - a[0]) * dx + (sy - a[1]) * dy) / L2));
      const d = Math.hypot(a[0] + dx * u - sx, a[1] + dy * u - sy) - Math.max(2, v.W * pxPerM * 0.5);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }
  const api = {
    T, PX, PY, CAM, Path, rand, pick, shade, inBounds,
    get pxPerM() { return pxPerM; }, get clock() { return clock; }, get night() { return night; }, small: false,
    toScreen: (x, y, h = 0) => toScreen(x, y, h), toImage, hiddenAt: (x, y) => { const [ix, iy] = toImage(x, y); return occluded(ix, iy); },
    prism, paint, shadow, line3, dot3, glow, poly, drawFigure, beam, drawGoose, drawFlyer,
    cars, buses, trains, crossings, games, geese, flocks, walkers, ion, tracks, ION_LEN,
    // geese: people = registry of extra people geese react to (see "Anyone the geese react to"), goslings, flights (V-formations overhead)
    people, goslings, flights, spawnFlight, scatterGeese,
    PEOPLE_SCALE, SKIN: SKIN_ALL, SHIRTS: SHIRTS_ALL,
  };
  window.mapLife = {
    cars, buses, trains, crossings, games, geese, walkers, api, setEnabled, isEnabled: () => enabled,
    setNight: (on) => { nightTarget = on ? 1 : 0; },
    setNightLevel: (k) => { nightTarget = Math.max(0, Math.min(1, k)); },
    setTimeScale: (k) => { timeScale = Math.max(0, k); }, getTimeScale: () => timeScale,
    setDensity: (k) => { density = Math.max(0.05, Math.min(1, k)); }, getDensity: () => density,
    addLayer: (L) => { layers.push(L); return () => { const i = layers.indexOf(L); if (i >= 0) layers.splice(i, 1); }; },
    poseOf, vehicleAt, cardInfo, scatterGeese, spawnFlight,
  };
  // let things settle a little before the first frame
  for (let i = 0; i < 60; i++) step(0.1);
  requestAnimationFrame(frame);
};
