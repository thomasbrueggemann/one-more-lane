// The city: buildings and where they may be placed, trip demand, economy, levels and the building tray.
// No rendering here; the sim spawns the vehicles.

import { BUILDING_TYPES, BUILDING_ORDER } from './buildings.js';
import { CLASSES } from './network.js';
import { makeRect, rectsOverlap, segTouchesRect, rectCorners, distPointSeg, segIntersect } from './geom.js';
import { Rng, clamp } from './util.js';
import { TRUCK_COLOR } from './sim.js';

export const DIFFICULTY = {
  easy: { name: 'Relaxed', money: 60000, demand: 0.8, xp: 0.8, tax: 1.2 },
  normal: { name: 'Normal', money: 40000, demand: 1, xp: 1, tax: 1 },
  hard: { name: 'Gridlock', money: 22000, demand: 1.3, xp: 1.25, tax: 0.85 },
};

/** Per building type: local x where the driveway leaves the building. */
const FRONT = { house: 3.4, shop: 6.2, factory: 8.2, office: 7.0 };
const SETBACK = 3.2; // metres between the roadway edge and the front of the lot

export function xpNeeded(level) {
  return 32 + 18 * level;
}

/** Buildings granted when reaching `level`. */
export function batchFor(level) {
  return {
    house: 4 + Math.min(10, level),
    shop: 1 + Math.floor(level / 2),
    office: Math.floor((level + 1) / 2),
    factory: Math.floor(level / 3),
  };
}

export class City {
  /**
   * @param {{net:object, terrain:object, sim:object, difficulty?:string, seed?:number}} opts
   */
  constructor({ net, terrain, sim, difficulty = 'normal', seed = 1, free = false }) {
    this.net = net;
    this.terrain = terrain;
    this.sim = sim;
    this.difficulty = DIFFICULTY[difficulty] ? difficulty : 'normal';
    this.diff = DIFFICULTY[this.difficulty];
    this.rng = new Rng(seed * 31 + 7);
    this.buildings = new Map();
    this.list = [];
    this.nextId = 1;
    this.free = !!free; // free play: nothing costs money, so the balance, income and level bonuses are unused
    this.money = this.diff.money;
    this.level = 0;
    this.xp = 0;
    this.tray = { house: 0, shop: 0, office: 0, factory: 0 };
    this.pending = [];
    this.delayed = [];
    this.time = 0;
    this.incomeTimer = 0;
    this.stats = { pop: 0, jobs: 0, income: 0, trips: 0, late: 0, happiness: 1 };
    this.onLevelUp = null;
    this.onBuildingsChanged = null;
    this.onToast = null;
    this.version = 0; // bumps when buildings are added/removed (renderers rebuild)
    this.ratioEma = 1;
    this.addBatch(0);
    sim.onArrive = (v, t) => this.onArrive(v, t);
    sim.onRemove = (v, reason) => this.onVehicleRemoved(v, reason);
  }

  /* ------------------------------------------------------------ placement */

  accessLane(edge, side) {
    // curb lane on the building's side: right-hand lanes for side +1, left-hand (backward) lanes for side -1
    if (side > 0) return edge.dirF ? edge.dirF.lanes[edge.dirF.lanes.length - 1] : edge.dirB ? edge.dirB.lanes[0] : null;
    return edge.dirB ? edge.dirB.lanes[edge.dirB.lanes.length - 1] : edge.dirF ? edge.dirF.lanes[0] : null;
  }

  /**
   * Find where a building of `type` would sit if the pointer is at (x,y).
   * Returns {ok, reason, x, y, rot, edge, side, s, drive, rect}.
   */
  findPlacement(type, x, y, maxD = 45) {
    const spec = BUILDING_TYPES[type];
    const net = this.net;
    const hit = net.nearestEdge(x, y, maxD, (e) => CLASSES[e.cls].access && !e.elevated && e.ring == null && !e.invalid);
    const res = { ok: false, reason: 'no_road', x, y, rot: 0, type };
    if (!hit) return res;
    const e = hit.edge;
    const side = hit.side > 0 ? -1 : 1;
    const half = spec.w / 2;
    // keep lots clear of junctions so roundabouts and wider junctions stay possible
    const margin = half + 10.5;
    const s0 = e.setA + margin;
    const s1 = e.len - e.setB - margin;
    if (s1 < s0) return { ...res, reason: 'too_short', edge: e };
    const s = clamp(hit.s, s0, s1);
    const p = e.poly.pointAt(s);
    const nr = { x: p.ty, y: -p.tx };
    const sn = { x: nr.x * side, y: nr.y * side };
    const hw = e.halfWidth;
    const dist = hw + SETBACK + spec.d / 2;
    const cx = p.x + sn.x * dist;
    const cy = p.y + sn.y * dist;
    const rot = Math.atan2(-sn.y, -sn.x);
    const front = FRONT[type];
    const drive = { x0: cx - sn.x * front, y0: cy - sn.y * front, x1: p.x + sn.x * hw, y1: p.y + sn.y * hw };
    const rect = makeRect(cx, cy, spec.d / 2, spec.w / 2, rot);
    const out = { ok: true, reason: null, x: cx, y: cy, rot, edge: e, side, s, drive, rect, type };
    out.reason = this.checkPlacement(out, spec);
    out.ok = out.reason === null;
    return out;
  }

  checkPlacement(pl, spec) {
    const rect = pl.rect;
    const corners = rectCorners(rect);
    for (const c of corners.concat([{ x: rect.cx, y: rect.cy }])) {
      if (this.terrain.blockedAt(c.x, c.y)) return 'terrain';
    }
    const mids = [];
    for (let i = 0; i < 4; i++) mids.push({ x: (corners[i].x + corners[(i + 1) % 4].x) / 2, y: (corners[i].y + corners[(i + 1) % 4].y) / 2 });
    for (const m of mids) if (this.terrain.blockedAt(m.x, m.y)) return 'terrain';
    for (const b of this.list) {
      if (Math.abs(b.x - rect.cx) > 40 || Math.abs(b.y - rect.cy) > 40) continue;
      if (rectsOverlap(rect, b.rect, 0.8)) return 'overlap';
      if (b.drive && segTouchesRect(b.drive.x0, b.drive.y0, b.drive.x1, b.drive.y1, rect, 1.6)) return 'overlap';
    }
    for (const e of this.net.edgesInBox(rect.cx - 40, rect.cy - 40, rect.cx + 40, rect.cy + 40)) {
      const poly = e.poly;
      for (let i = 0; i < poly.n - 1; i++) {
        if (segTouchesRect(poly.xs[i], poly.ys[i], poly.xs[i + 1], poly.ys[i + 1], rect, e.halfWidth + 0.6)) return 'road';
      }
    }
    // the driveway must not run into another road
    const d = pl.drive;
    for (const e of this.net.edgesInBox(Math.min(d.x0, d.x1) - 12, Math.min(d.y0, d.y1) - 12, Math.max(d.x0, d.x1) + 12, Math.max(d.y0, d.y1) + 12)) {
      if (e === pl.edge) continue;
      const poly = e.poly;
      for (let i = 0; i < poly.n - 1; i++) {
        if (segIntersect(d.x0, d.y0, d.x1, d.y1, poly.xs[i], poly.ys[i], poly.xs[i + 1], poly.ys[i + 1])) return 'road';
      }
    }
    return null;
  }

  /** Tray count for a type. */
  available(type) {
    return this.tray[type] || 0;
  }

  addBuilding(pl, { fromTray = true } = {}) {
    const type = pl.type;
    if (fromTray) {
      if (this.tray[type] <= 0) return null;
      this.tray[type]--;
    }
    const spec = BUILDING_TYPES[type];
    const b = {
      id: this.nextId++,
      type,
      seed: pl.seed ?? 1 + Math.floor(this.rng.next() * 100000),
      x: pl.x,
      y: pl.y,
      rot: pl.rot,
      rect: pl.rect,
      drive: pl.drive,
      acc: { edge: pl.edge, side: pl.side },
      pop: spec.pop,
      jobs: spec.jobs,
      workers: 0,
      timer: 3 + this.rng.next() * 12,
      sat: 1,
      badge: null,
      fails: 0,
      born: this.time,
      alive: true,
    };
    this.buildings.set(b.id, b);
    this.list.push(b);
    this.version++;
    this.recount();
    return b;
  }

  /** A building handed in by the UI may predate an undo or a load: only the one currently in the city counts. */
  has(b) {
    return !!b && b.alive && this.buildings.get(b.id) === b;
  }

  removeBuilding(b, { toTray = true } = {}) {
    if (!this.has(b)) return false;
    b.alive = false;
    this.buildings.delete(b.id);
    const i = this.list.indexOf(b);
    if (i >= 0) this.list.splice(i, 1);
    if (toTray) this.tray[b.type]++;
    this.version++;
    this.recount();
    return true;
  }

  recount() {
    let pop = 0;
    let jobs = 0;
    for (const b of this.list) {
      pop += b.pop;
      jobs += b.jobs;
    }
    this.stats.pop = pop;
    this.stats.jobs = jobs;
  }

  /** Buildings whose road disappeared look for the nearest remaining road at their driveway. */
  onNetworkChange() {
    for (const b of this.list) {
      const a = b.acc;
      if (a && a.edge && a.edge.alive) continue;
      const d = b.drive;
      const hit = this.net.nearestEdge(d.x1, d.y1, 3.2, (e) => !e.invalid);
      if (hit && hit.gap < 2.5) b.acc = { edge: hit.edge, side: hit.side > 0 ? -1 : 1 };
      else b.acc = null;
    }
  }

  accessFor(b) {
    const a = b.acc;
    if (!a || !a.edge.alive || a.edge.invalid) return null;
    const lane = this.accessLane(a.edge, a.side);
    if (!lane || !lane.alive) return null;
    return { dir: lane.dir, lane, x: b.drive.x1, y: b.drive.y1, j: lane.j };
  }

  /* ------------------------------------------------------------ money & progress */

  canAfford(cost) {
    return this.free || this.money >= cost;
  }

  spend(amount) {
    if (!this.free) this.money -= amount;
  }

  addBatch(level) {
    const b = batchFor(level);
    for (const k of BUILDING_ORDER) this.tray[k] += b[k] || 0;
    return b;
  }

  gainXp(v) {
    this.xp += v / this.diff.xp;
    let need = xpNeeded(this.level);
    while (this.xp >= need) {
      this.xp -= need;
      this.level++;
      const batch = this.addBatch(this.level);
      need = xpNeeded(this.level);
      if (!this.free) this.money += 1500 + this.level * 500;
      if (this.onLevelUp) this.onLevelUp(this.level, batch);
    }
  }

  /* ------------------------------------------------------------ trips */

  pickDestination(from, kinds, maxTries = 10) {
    const rng = this.rng;
    const cands = this.list.filter((b) => kinds.includes(b.type) && b !== from && this.accessFor(b));
    if (!cands.length) return null;
    let best = null;
    let bw = -1;
    for (let i = 0; i < Math.min(maxTries, cands.length); i++) {
      const c = rng.pick(cands);
      const d = Math.hypot(c.x - from.x, c.y - from.y);
      const w = rng.next() / (1 + d / 260);
      if (w > bw) {
        bw = w;
        best = c;
      }
    }
    return best;
  }

  newTrip(b) {
    const rng = this.rng;
    if (b.type === 'house') {
      const work = this.list.some((x) => (x.type === 'office' || x.type === 'factory') && this.accessFor(x));
      const kinds = work && rng.chance(0.55) ? ['office', 'factory'] : ['shop', 'office'];
      const dest = this.pickDestination(b, kinds) || this.pickDestination(b, ['shop', 'office', 'factory']);
      if (!dest) return null;
      return { from: b, to: dest, ret: false, truck: false, born: this.time };
    }
    if (b.type === 'factory') {
      const dest = this.pickDestination(b, ['shop']);
      if (!dest) return null;
      return { from: b, to: dest, ret: false, truck: true, born: this.time };
    }
    return null;
  }

  update(dt) {
    this.time += dt;
    this.releaseDelayed();
    const mult = this.diff.demand;
    for (const b of this.list) {
      if (b.type !== 'house' && b.type !== 'factory') continue;
      b.timer -= dt;
      if (b.timer > 0) continue;
      const mean = b.type === 'house' ? 78 / (b.pop / 4) : 45;
      b.timer = (-Math.log(1 - this.rng.next() * 0.999) * mean) / mult;
      if (!this.accessFor(b)) {
        b.badge = 'noroad';
        continue;
      }
      if (this.pending.length > 160) continue;
      const trip = this.newTrip(b);
      if (trip) this.pending.push(trip);
    }
    // try to start waiting trips
    const keep = [];
    let started = 0;
    for (const trip of this.pending) {
      if (started > 12) {
        keep.push(trip);
        continue;
      }
      const res = this.startTrip(trip);
      if (res === 'retry' && this.time - trip.born < 25) keep.push(trip);
      else if (res === 'started') started++;
    }
    this.pending = keep;
    this.incomeTimer += dt;
    if (this.incomeTimer >= 1) {
      const n = Math.floor(this.incomeTimer);
      this.incomeTimer -= n;
      let inc = 0;
      for (const b of this.list) inc += BUILDING_TYPES[b.type].tax * (0.45 + 0.55 * b.sat);
      inc *= this.diff.tax;
      this.stats.income = inc;
      if (!this.free) this.money += inc * n;
      this.updateBadges();
    }
  }

  startTrip(trip) {
    const a = this.accessFor(trip.from);
    const bAcc = this.accessFor(trip.to);
    if (!a || !bAcc || !trip.from.alive || !trip.to.alive) return 'drop';
    const res = this.sim.spawn({
      kind: trip.truck ? 'truck' : 'car',
      color: trip.truck ? TRUCK_COLOR : undefined,
      from: a,
      to: bAcc,
      payload: trip,
    });
    if (res.vehicle) return 'started';
    if (res.fail === 'noroute') {
      // whoever lives or works at the home end is stranded; the destination may be perfectly well connected
      (trip.ret ? trip.to : trip.from).fails++;
      return 'drop';
    }
    if (res.fail === 'cap' || res.fail === 'behind') return 'drop';
    return 'retry';
  }

  onArrive(v, travel) {
    const trip = v.payload;
    if (!trip) return;
    const ratio = travel / Math.max(v.ideal, 6);
    this.ratioEma += (ratio - this.ratioEma) * 0.08;
    let pts;
    if (ratio <= 1.7) pts = 1;
    else if (ratio <= 2.6) pts = 0.6;
    else if (ratio <= 4) pts = 0.25;
    else pts = 0.05;
    this.gainXp(pts);
    this.stats.trips++;
    if (ratio > 3) this.stats.late++;
    const home = trip.ret ? trip.to : trip.from;
    if (home.alive) {
      home.fails = 0;
      if (home.type === 'house') home.sat += (clamp(1.9 / ratio, 0, 1) - home.sat) * 0.25;
    }
    if (!trip.ret && trip.from.alive && trip.to.alive) {
      const dwell = trip.truck ? 5 + this.rng.next() * 5 : trip.to.type === 'shop' ? 10 + this.rng.next() * 12 : 24 + this.rng.next() * 20;
      this.later(dwell, { from: trip.to, to: trip.from, ret: true, truck: trip.truck, born: this.time + dwell });
    }
  }

  later(delay, trip) {
    this.delayed.push({ at: this.time + delay, trip });
  }

  releaseDelayed() {
    if (!this.delayed.length) return;
    const rest = [];
    for (const d of this.delayed) {
      if (d.at <= this.time) {
        if (d.trip.from.alive && d.trip.to.alive) {
          d.trip.born = this.time;
          this.pending.push(d.trip);
        }
      } else rest.push(d);
    }
    this.delayed = rest;
  }

  onVehicleRemoved(v, reason) {
    const trip = v.payload;
    if (!trip || trip.ret) return;
    // a road the player just rebuilt or removed is not the resident's complaint
    if (reason === 'road_removed' || reason === 'junction_rebuilt' || reason === 'gone') return;
    // a trip that never completed: bring the person home, otherwise they vanish from the count of trips
    if (trip.from.alive) trip.from.sat = Math.max(0, trip.from.sat - 0.05);
  }

  updateBadges() {
    let sum = 0;
    let n = 0;
    for (const b of this.list) {
      const acc = this.accessFor(b);
      if (!acc || b.fails > 2) b.badge = 'noroad';
      else if (b.type === 'house' && b.sat < 0.42) b.badge = 'angry';
      else b.badge = null;
      if (b.type === 'house') {
        sum += b.sat;
        n++;
      }
    }
    this.stats.happiness = n ? sum / n : 1;
  }

  /* ------------------------------------------------------------ persistence */

  toJSON() {
    return {
      money: this.money,
      level: this.level,
      xp: this.xp,
      tray: this.tray,
      difficulty: this.difficulty,
      time: this.time,
      nextId: this.nextId,
      buildings: this.list.map((b) => [b.id, b.type, b.seed, Math.round(b.x * 100) / 100, Math.round(b.y * 100) / 100, Math.round(b.rot * 1000) / 1000, b.drive, b.sat]),
    };
  }

  loadJSON(data) {
    this.money = data.money;
    this.level = data.level;
    this.xp = data.xp;
    this.tray = { house: 0, shop: 0, office: 0, factory: 0, ...data.tray };
    this.time = data.time || 0;
    this.nextId = data.nextId || 1;
    for (const b of this.list) b.alive = false; // anything still holding the old objects (info panel, trips) must not act on them
    this.buildings.clear();
    this.list.length = 0;
    for (const [id, type, seed, x, y, rot, drive, sat] of data.buildings) {
      const spec = BUILDING_TYPES[type];
      const hit = this.net.nearestEdge(drive.x1, drive.y1, 3.2, (e) => !e.invalid);
      const b = {
        id,
        type,
        seed,
        x,
        y,
        rot,
        rect: makeRect(x, y, spec.d / 2, spec.w / 2, rot),
        drive,
        acc: hit && hit.gap < 2.5 ? { edge: hit.edge, side: hit.side > 0 ? -1 : 1 } : null,
        pop: spec.pop,
        jobs: spec.jobs,
        workers: 0,
        timer: 3 + this.rng.next() * 20,
        sat: sat ?? 1,
        badge: null,
        fails: 0,
        born: this.time,
        alive: true,
      };
      this.buildings.set(id, b);
      this.list.push(b);
    }
    this.version++;
    this.recount();
  }
}

export { distPointSeg };
