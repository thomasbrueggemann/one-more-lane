// Microscopic traffic simulation.
//  - Vehicles follow lanes (polylines) and junction connections, positioned by arc length `s` (front bumper).
//  - Car following: Intelligent Driver Model. Junctions: signals, priority/gap acceptance with time windows,
//    "don't block the box" exit checks, and an in-box safety yield by entry order.
//  - Routes come from the congestion-aware A* in router.js; lane changes are mandatory (to reach the right
//    turn lane) or discretionary (pass slow leaders).

import { splitMap, replacementConn } from './network.js';
import { Router } from './router.js';
import { SIGNAL_AMBER, SIGNAL_RED } from './signals.js';
import { Rng, clamp } from './util.js';

export const DT = 0.05;
const MAX_DETOURS = 5; // fallback exits one driver may take before they count as lost
const STOP_BEYOND = 1.2; // virtual obstacle sits this far past the stop line, so cars halt ~0.8 m before it
const LOOKAHEAD = 70;

export const CAR_COLORS = [
  [0.91, 0.47, 0.6],
  [0.22, 0.7, 0.67],
  [0.94, 0.55, 0.23],
  [0.61, 0.43, 0.88],
  [0.9, 0.77, 0.21],
  [0.36, 0.72, 0.36],
  [0.35, 0.66, 0.9],
  [0.88, 0.34, 0.31],
];
export const TRUCK_COLOR = [0.25, 0.45, 0.88];

/** Time to cover distance d from speed v accelerating at a up to vmax. */
export function timeToDist(d, v, a, vmax) {
  if (d <= 0) return 0;
  vmax = Math.max(vmax, v, 0.5);
  const dAcc = (vmax * vmax - v * v) / (2 * a);
  if (d <= dAcc) return (-v + Math.sqrt(v * v + 2 * a * d)) / a;
  return (vmax - v) / a + (d - dAcc) / vmax;
}

function idm(v, v0, gap, vl) {
  const dv = v.v - vl;
  const sStar = v.s0 + Math.max(0, v.v * v.T + (v.v * dv) / (2 * Math.sqrt(v.aMax * v.b)));
  const r = v.v / Math.max(v0, 0.1);
  const free = 1 - r * r * r * r;
  const g = Math.max(gap, 0.05);
  const a = v.aMax * (free - (sStar * sStar) / (g * g));
  return a < -9 ? -9 : a;
}

function insertSorted(arr, v) {
  let i = arr.length;
  while (i > 0 && arr[i - 1].s > v.s) i--;
  arr.splice(i, 0, v);
}

function removeFrom(arr, v) {
  const i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1);
}

export class Sim {
  constructor(net, seed = 1) {
    this.net = net;
    this.rng = new Rng(seed);
    this.router = new Router();
    this.time = 0;
    this.tick = 0;
    this.vehicles = [];
    this.nextId = 1;
    this.occupied = new Set();
    this.ghosts = [];
    this.maxVehicles = 1600;
    this.onArrive = null;
    this.onRemove = null;
    this.stats = { count: 0, avgRatio: 1, stopped: 0, arrived: 0, removed: 0, failedRoutes: 0 };
    this.statTimer = 0;
    this._arrivals = [];
    this._dead = [];
    this._kq = [];
  }

  /** Remove every vehicle (the network is about to be replaced). */
  reset() {
    this.vehicles = [];
    this.occupied.clear();
    this.ghosts = [];
    this._kq.length = 0;
    this._dead.length = 0;
    this.stats = { count: 0, avgRatio: 1, stopped: 0, arrived: 0, removed: 0, failedRoutes: 0 };
  }

  /* ------------------------------------------------------------ vehicles */

  makeVehicle(kind, color) {
    const car = kind !== 'truck';
    const r = this.rng;
    return {
      id: this.nextId++,
      kind,
      color,
      len: car ? 4.0 : 7.4,
      wid: car ? 1.78 : 2.3,
      lane: null,
      conn: null,
      s: 0,
      v: 0,
      a: 0,
      f: clamp(1 + 0.08 * r.gauss(), 0.82, 1.18) * (car ? 1 : 0.88),
      T: car ? 1.0 + 0.3 * r.next() : 1.5,
      aMax: car ? 1.9 + 0.7 * r.next() : 1.0,
      b: 3.0,
      s0: 2.0,
      vmax: car ? 40 : 24,
      route: null,
      ri: 0,
      dest: null,
      nextConn: null,
      needLane: 0,
      laneMask: 0,
      granted: false,
      wantGo: false,
      stamp: 0,
      stopSince: 0,
      enterT: 0,
      lat: 0,
      fade: 0,
      born: this.time,
      stuck: 0,
      rerouted: 0,
      detours: 0,
      lastChange: -99,
      dead: false,
      payload: null,
      dist: 0,
      ideal: 0,
    };
  }

  place(v, container, s) {
    v.s = s;
    if (container.isConn) {
      v.conn = container;
      v.lane = null;
    } else {
      v.lane = container;
      v.conn = null;
    }
    insertSorted(container.vehicles, v);
    this.occupied.add(container);
  }

  detach(v) {
    const c = v.conn || v.lane;
    if (!c) return;
    removeFrom(c.vehicles, v);
    if (!c.vehicles.length) this.occupied.delete(c);
  }

  /** Mark a vehicle for removal; it is detached from its lane by flushKills() once no loop is iterating. */
  kill(v, reason) {
    if (v.dead) return;
    v.dead = true;
    v.killReason = reason;
    this._kq.push(v);
    this.stats.removed++;
    if (this.onRemove) this.onRemove(v, reason);
  }

  flushKills() {
    if (!this._kq.length) return;
    for (const v of this._kq) {
      this.detach(v);
      this._dead.push(v);
    }
    this._kq.length = 0;
  }

  /* ------------------------------------------------------------ spawning */

  hasGap(lane, s0, len) {
    // vehicles still inside a junction but heading for this lane count as followers at negative s
    for (const c of lane.inConns) {
      for (const w of c.vehicles) {
        const ws = w.s - c.len;
        if (s0 - len - ws < (w.v * w.v) / (2 * 3.2) + w.v * 0.5 + 4) return false;
      }
      // ...and so do approaching vehicles that already have the green light for this connection
      const fl = c.from.vehicles;
      const front = fl[fl.length - 1];
      if (front && front.nextConn === c && front.granted) {
        const ws = front.s - c.from.len - c.len;
        if (s0 - len - ws < (front.v * front.v) / (2 * 3.2) + front.v * 0.5 + 4) return false;
      }
    }
    const arr = lane.vehicles;
    for (let i = arr.length - 1; i >= 0; i--) {
      const w = arr[i];
      if (w.s > s0) {
        if (w.s - w.len - s0 < 5 + w.v * 0.5) return false;
      } else {
        // the follower must be able to brake for a vehicle that pulls out at standstill
        if (s0 - len - w.s < (w.v * w.v) / (2 * 3.2) + w.v * 0.5 + 2.5) return false;
        break;
      }
    }
    return true;
  }

  /**
   * Try to put a vehicle on the road at an access point and send it to another.
   * from/to: {dir, x, y} (x,y is the driveway end on the road edge).
   * Returns {vehicle} or {fail: 'cap'|'gone'|'noroute'|'behind'|'busy'}.
   */
  spawn({ kind = 'car', color, from, to, payload = null, noise = true }) {
    if (this.vehicles.length >= this.maxVehicles) return { fail: 'cap' };
    const fd = from.dir;
    const td = to.dir;
    if (!fd || !td || !fd.alive || !td.alive || !fd.lanes.length || !td.lanes.length) return { fail: 'gone' };
    const lane = from.lane && from.lane.alive ? from.lane : fd.lanes[fd.lanes.length - 1];
    if (lane.len < 8) return { fail: 'gone' };
    const s0 = clamp(lane.poly.closest(from.x, from.y).s, 3, lane.len - 3);
    const len = kind === 'truck' ? 7.4 : 4.0;
    if (!this.hasGap(lane, s0, len)) return { fail: 'busy' };
    const seed = noise ? (this.nextId * 7919) % 100003 : 0;
    let route;
    const tj = clamp(to.j ?? td.lanes.length - 1, 0, td.lanes.length - 1);
    const tl = td.lanes[tj];
    if (fd === td) {
      const ds = tl.poly.closest(to.x, to.y).s;
      if (ds > s0 + 14) route = [fd];
      else {
        // the destination is behind us on the same stretch of road: drive on and come back round
        route = this.router.loop(fd, seed);
        if (!route) return { fail: 'behind' };
      }
    } else route = this.router.route(fd, td, seed);
    if (!route) {
      this.stats.failedRoutes++;
      return { fail: 'noroute' };
    }
    const v = this.makeVehicle(kind, color || CAR_COLORS[(this.nextId * 5) % CAR_COLORS.length]);
    v.route = route;
    v.ri = 0;
    v.dest = { dir: td, x: to.x, y: to.y, s: 0, j: tj };
    v.payload = payload;
    v.lat = 3.4;
    v.fade = 0;
    v.ideal = this.idealTime(route, s0, tl.poly.closest(to.x, to.y).s);
    this.place(v, lane, s0);
    this.vehicles.push(v);
    this.chooseNext(v);
    return { vehicle: v };
  }

  /**
   * A fair "good trip" time: the distance actually driven (not whole segments) at 90% of the limit, plus a few
   * seconds to pull out and about two to cross each junction on the way. Delay ratios are measured against it.
   */
  idealTime(route, s0 = 0, destS = null) {
    let t = 0;
    for (let i = 0; i < route.length; i++) {
      const d = route[i];
      let len = d.len;
      if (i === route.length - 1 && destS != null) len = destS;
      if (i === 0) len -= s0;
      t += Math.max(0, len) / Math.max(3, d.limit * 0.9);
    }
    return t + 3 + 2 * Math.max(0, route.length - 1);
  }

  /* ------------------------------------------------------------ routing helpers */

  chooseNext(v) {
    const lane = v.lane;
    const dir = lane.dir;
    v.nextConn = null;
    v.laneMask = 0;
    if (v.ri >= v.route.length - 1) {
      // destination edge: head for the driveway in the kerb lane
      const curb = clamp(v.dest.j, 0, dir.lanes.length - 1);
      v.needLane = curb;
      v.laneMask = 1 << curb;
      if (v.dest.dir === dir) {
        const cl = dir.lanes[curb];
        v.dest.s = clamp(cl.poly.closest(v.dest.x, v.dest.y).s, 2, cl.len - 1);
      }
      return;
    }
    const nextDir = v.route[v.ri + 1];
    const conns = nextDir.alive ? dir.moves.get(nextDir) : null;
    if (!conns || !conns.length) {
      this.reroute(v);
      return;
    }
    let mine = null;
    let bestD = 99;
    let bestJ = lane.j;
    for (const c of conns) {
      v.laneMask |= 1 << c.from.j;
      if (c.from === lane) {
        // among equivalent exits prefer the emptier receiving lane
        if (!mine || c.to.vehicles.length < mine.to.vehicles.length) mine = c;
      }
      const d = Math.abs(c.from.j - lane.j);
      if (d < bestD) {
        bestD = d;
        bestJ = c.from.j;
      }
    }
    v.nextConn = mine;
    v.needLane = mine ? lane.j : bestJ;
  }

  /** Recompute the route from where the vehicle is; kills it if the destination is unreachable. */
  reroute(v) {
    let start;
    let prefix = null;
    if (v.conn) {
      start = v.conn.to.dir;
      prefix = v.conn.from.dir;
    } else start = v.lane.dir;
    const dest = v.dest.dir;
    if (!dest.alive) {
      this.kill(v, 'gone');
      return false;
    }
    let r;
    if (start === dest) r = [start];
    else r = this.router.route(start, dest, (v.id * 31) % 9973);
    if (!r) {
      this.kill(v, 'noroute');
      this.stats.failedRoutes++;
      return false;
    }
    v.rerouted++;
    if (prefix) {
      v.route = [prefix].concat(r);
      v.ri = 0;
    } else {
      v.route = r;
      v.ri = 0;
    }
    if (v.lane) this.chooseNext(v);
    return true;
  }

  /* ------------------------------------------------------------ step */

  step(dt = DT) {
    this.time += dt;
    this.tick++;
    for (const n of this.net.nodes.values()) if (n.signal) n.signal.update(dt);
    this.computeAccels();
    this.flushKills();
    this.advance(dt);
    this.flushKills();
    this.laneChanges();
    this.flushKills();
    for (const v of this.vehicles) {
      if (v.lat !== 0) {
        const m = 2.6 * dt;
        v.lat = Math.abs(v.lat) <= m ? 0 : v.lat - Math.sign(v.lat) * m;
      }
      if (v.fade < 1) v.fade = Math.min(1, v.fade + dt * 2.5);
    }
    for (let i = this.ghosts.length - 1; i >= 0; i--) {
      const g = this.ghosts[i];
      g.t += dt;
      if (g.t > 0.5) this.ghosts.splice(i, 1);
    }
    if (this._dead.length) {
      const dead = new Set(this._dead);
      this.vehicles = this.vehicles.filter((v) => !dead.has(v));
      this._dead.length = 0;
    }
    this.signalTimer = (this.signalTimer || 0) + dt;
    if (this.signalTimer >= 0.5) {
      this.signalTimer -= 0.5;
      this.updateSignalDemand();
    }
    this.statTimer += dt;
    if (this.statTimer >= 1) {
      this.statTimer -= 1;
      this.updateStats();
      this.flushKills();
    }
  }

  /** Tell every actuated signal which of its phases currently has vehicles waiting or arriving. */
  updateSignalDemand() {
    for (const n of this.net.nodes.values()) {
      const sig = n.signal;
      if (!sig) continue;
      if (!sig.demand || sig.demand.length !== sig.phases.length) sig.demand = new Array(sig.phases.length).fill(true);
      for (let i = 0; i < sig.phases.length; i++) {
        let any = false;
        const moves = sig.phases[i].moves;
        for (const c of n.conns) {
          if (!moves.has(c.moveKey)) continue;
          if (c.vehicles.length) {
            any = true;
            break;
          }
          const arr = c.from.vehicles;
          if (arr.length && c.from.len - arr[arr.length - 1].s < 55) {
            any = true;
            break;
          }
        }
        sig.demand[i] = any;
      }
    }
  }

  /* ------------------------------------------------------------ accelerations */

  computeAccels() {
    for (const L of this.occupied) {
      const arr = L.vehicles;
      if (!arr.length) continue;
      if (L.isConn) this.accelConn(L, arr);
      else this.accelLane(L, arr);
    }
  }

  accelLane(L, arr) {
    const limit = L.limit;
    for (let i = arr.length - 1; i >= 0; i--) {
      const v = arr[i];
      if (v.dead) continue;
      let v0 = Math.min(limit * v.f, v.vmax);
      let gap = Infinity;
      let vl = 0;
      const dEnd = L.len - v.s;
      if (i + 1 < arr.length) {
        const w = arr[i + 1];
        gap = w.s - w.len - v.s;
        vl = w.v;
        v.wantGo = false;
      } else if (v.ri >= v.route.length - 1) {
        // approaching the driveway: ease off
        const dd = v.dest.s - v.s;
        if (dd < 22) v0 = Math.min(v0, 3.5 + dd * 0.35);
        v.wantGo = false;
      } else {
        if (v.nextConn && !v.nextConn.alive) this.chooseNext(v);
        if (v.dead) continue;
        const conn = v.nextConn;
        if (conn) {
          if (conn.speed < v0) v0 = Math.min(v0, Math.sqrt(conn.speed * conn.speed + 2 * 1.9 * Math.max(0, dEnd - 1)));
          if (dEnd < 25 && v.stamp === 0) v.stamp = this.time;
          // unsignalised junction with other traffic about: approach like a stop/yield sign
          if (dEnd < 45 && !conn.node.signal && this.crossTraffic(conn)) {
            v0 = Math.min(v0, Math.sqrt(1.4 * 1.4 + 2 * 1.9 * Math.max(0, dEnd - 1)));
          }
          let go = true;
          if (dEnd < LOOKAHEAD) go = this.junctionGo(v, conn, dEnd);
          else v.wantGo = false;
          if (!go) {
            gap = dEnd + STOP_BEYOND;
            vl = 0;
          }
          let g2 = Infinity;
          let w = null;
          if (conn.vehicles.length) {
            w = conn.vehicles[0];
            g2 = dEnd + (w.s - w.len);
          } else if (conn.to.vehicles.length) {
            w = conn.to.vehicles[0];
            g2 = dEnd + conn.len + (w.s - w.len);
          }
          if (w && g2 < gap) {
            gap = g2;
            vl = w.v;
          }
          // vehicles that left this lane on a diverging movement are still beside our path for a few metres
          const sib = L.outConns;
          for (let k = 0; k < sib.length; k++) {
            const c = sib[k];
            if (c === conn || !c.vehicles.length) continue;
            const x = c.vehicles[0];
            if (x.s < 12 + x.len) {
              const g3 = dEnd + (x.s - x.len);
              if (g3 < gap) {
                gap = g3;
                vl = x.v;
              }
            }
          }
        } else {
          // waiting for a gap to reach the right lane: do not run past the end of the lane
          gap = dEnd + STOP_BEYOND;
          vl = 0;
          v.wantGo = false;
        }
      }
      v.a = idm(v, v0, gap, vl);
    }
  }

  accelConn(C, arr) {
    for (let i = arr.length - 1; i >= 0; i--) {
      const v = arr[i];
      if (v.dead) continue;
      const v0 = Math.min(C.speed * v.f, v.vmax);
      let gap = Infinity;
      let vl = 0;
      if (i + 1 < arr.length) {
        const w = arr[i + 1];
        gap = w.s - w.len - v.s;
        vl = w.v;
      } else if (C.to.vehicles.length) {
        const w = C.to.vehicles[0];
        gap = C.len - v.s + (w.s - w.len);
        vl = w.v;
      }
      if (v.s < 12) {
        const sib = C.from.outConns;
        for (let k = 0; k < sib.length; k++) {
          const c = sib[k];
          if (c === C) continue;
          for (let q = 0; q < c.vehicles.length; q++) {
            const x = c.vehicles[q];
            if (x.s > v.s && x.s < 12 + x.len) {
              const g3 = x.s - x.len - v.s;
              if (g3 < gap) {
                gap = g3;
                vl = x.v;
              }
            }
          }
        }
      }
      // safety yield to vehicles that entered the box earlier and are crossing/merging ahead
      const d = this.boxObstacle(v, C);
      if (d + STOP_BEYOND < gap) {
        gap = d + STOP_BEYOND;
        vl = 0;
      }
      v.a = idm(v, v0, gap, vl);
    }
  }

  boxObstacle(v, C) {
    let best = Infinity;
    for (const cf of C.conflicts) {
      const c2 = cf.other;
      if (!c2.vehicles.length) continue;
      if (v.s >= cf.a0) continue; // already in the zone: carry on, the other one yields
      for (const w of c2.vehicles) {
        if (w.s - w.len > cf.b1) continue; // already cleared the conflict
        const wIn = w.s >= cf.b0;
        const wFirst = wIn || w.enterT < v.enterT || (w.enterT === v.enterT && w.id < v.id);
        if (!wFirst) continue;
        const d = cf.a0 - v.s;
        if (d < best) best = d;
      }
    }
    return best;
  }

  /* ------------------------------------------------------------ junction control */

  junctionGo(v, conn, dEnd) {
    const stopD = (v.v * v.v) / (2 * 6);
    const committed = v.granted && dEnd <= stopD + 0.6;
    let ok = true;
    const sig = conn.node.signal;
    if (sig) {
      const st = sig.state(conn.moveKey);
      if (st === SIGNAL_RED) ok = false;
      else if (st === SIGNAL_AMBER) {
        const sd = (v.v * v.v) / (2 * 3.2);
        if (dEnd > sd + 1.5) ok = false;
      }
    }
    // stop sign: with other traffic about, a car must come to a halt and wait a moment before it may go
    if (ok && !sig && !committed && conn.node.ring == null && dEnd < 7) {
      if (this.crossTraffic(conn)) {
        if (v.v < 0.35) {
          if (v.stopSince === 0) v.stopSince = this.time;
        } else if (v.v > 1.6) v.stopSince = 0;
        if (v.stopSince === 0 || this.time - v.stopSince < 1.7) ok = false;
      }
    }
    if (committed) ok = !this.boxOccupied(conn);
    else {
      if (ok && !this.exitRoom(conn, v)) ok = false;
      if (ok && !this.gapOK(v, conn, dEnd)) {
        // permissive left turn at the end of the green: the first waiting car may "sneak" through once the box is empty
        const sneak = sig && conn.turn === 'L' && dEnd < 4 && v.v < 3 && sig.timeLeft(conn.moveKey) < 5.5 && !this.boxOccupied(conn);
        if (!sneak) ok = false;
      }
    }
    v.granted = ok;
    v.wantGo = ok;
    return ok;
  }

  /** Is there room beyond the junction for this vehicle, so it does not block the box? */
  exitRoom(conn, v) {
    const out = conn.to;
    let pend = 0;
    for (const c of out.inConns) for (const w of c.vehicles) pend += w.len + 1.2;
    const first = out.vehicles[0];
    const free = (first ? first.s - first.len : out.len) - pend;
    // inside a roundabout the ring keeps rotating like a conveyor, so only a car-length slot is needed there
    const ringToRing = conn.from.dir.edge.ring != null && out.dir.edge.ring != null;
    return free >= (ringToRing ? 1.0 : v.len + 1.5);
  }

  /** Is anything that could conflict with this movement inside the junction or close to its stop line? */
  crossTraffic(conn) {
    const cfs = conn.conflicts;
    for (let k = 0; k < cfs.length; k++) {
      const cf = cfs[k];
      if (cf.rel < 0) continue; // we have priority: no need to slow down for them
      const c2 = cf.other;
      if (c2.vehicles.length) return true;
      const arr = c2.from.vehicles;
      if (arr.length && c2.from.len - arr[arr.length - 1].s < 32) return true;
    }
    return false;
  }

  /** A vehicle inside the junction is still on (or has not cleared) a conflict point of this movement. */
  boxOccupied(conn) {
    const cfs = conn.conflicts;
    for (let k = 0; k < cfs.length; k++) {
      const cf = cfs[k];
      const inside = cf.other.vehicles;
      for (let i = 0; i < inside.length; i++) {
        if (inside[i].s - inside[i].len <= cf.b1) return true;
      }
    }
    return false;
  }

  gapOK(v, conn, dEnd) {
    const cfs = conn.conflicts;
    if (this.boxOccupied(conn)) return false;
    for (let k = 0; k < cfs.length; k++) {
      const cf = cfs[k];
      const c2 = cf.other;
      if (cf.rel < 0) continue; // we have priority over that movement
      // 2. approaching vehicles
      const lane2 = c2.from;
      const arr = lane2.vehicles;
      for (let i = arr.length - 1, n = 0; i >= 0 && n < 4; i--, n++) {
        const w = arr[i];
        const dW = lane2.len - w.s;
        if (dW > 55) break;
        if (n === 0 ? !w.wantGo : w.v < 2) continue;
        if (w === v) continue;
        const wsp = c2.speed * w.f;
        const tW0 = timeToDist(dW + cf.b0, w.v, w.aMax, wsp);
        const tW1 = timeToDist(dW + cf.b1 + w.len, w.v, w.aMax, wsp);
        const vsp = conn.speed * v.f;
        const tV0 = timeToDist(dEnd + cf.a0, v.v, v.aMax, vsp);
        const tV1 = timeToDist(dEnd + cf.a1 + v.len, v.v, v.aMax, vsp);
        if (tW0 < tV1 + 0.7 && tV0 < tW1 + 0.7) {
          if (cf.rel > 0) return false;
          if (w.stamp !== 0 && (v.stamp === 0 || w.stamp < v.stamp || (w.stamp === v.stamp && w.id < v.id))) return false;
        }
      }
    }
    return true;
  }

  /* ------------------------------------------------------------ motion */

  advance(dt) {
    const arrivals = this._arrivals;
    arrivals.length = 0;
    for (const L of this.occupied) {
      const arr = L.vehicles;
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v.dead) continue;
        let nv = v.v + v.a * dt;
        let ds;
        if (nv < 0) {
          ds = v.a < 0 ? (v.v * v.v) / (2 * -v.a) : 0;
          nv = 0;
        } else ds = ((v.v + nv) / 2) * dt;
        v.v = nv;
        v.s += ds;
        v.dist += ds;
        if (L.isConn) continue;
        if (v.ri >= v.route.length - 1 && v.s >= v.dest.s) arrivals.push(v);
      }
    }
    for (const v of arrivals) this.arrive(v);
    // container transitions: only vehicles at the very front of an array can have run off the end
    const containers = [...this.occupied];
    for (const L of containers) {
      const arr = L.vehicles;
      // after an edit a follower can briefly slip past its leader: keep the array ordered by position
      for (let i = 1; i < arr.length; i++) {
        if (arr[i].s < arr[i - 1].s) {
          let j = i;
          const x = arr[i];
          while (j > 0 && arr[j - 1].s > x.s) {
            arr[j] = arr[j - 1];
            j--;
          }
          arr[j] = x;
        }
      }
      let guard = 0;
      while (arr.length && arr[arr.length - 1].s >= L.len && guard++ < 6) {
        const v = arr[arr.length - 1];
        if (v.dead) break;
        if (L.isConn) this.leaveConn(v, L);
        else if (!this.leaveLane(v, L)) {
          // held at the stop line: anything else that ran past the end is pinned there too
          for (let i = arr.length - 2; i >= 0 && arr[i].s >= L.len; i--) {
            arr[i].s = L.len - 0.02;
            arr[i].v = 0;
          }
          break;
        }
      }
    }
  }

  leaveLane(v, lane) {
    const conn = v.nextConn;
    if (!conn || !conn.alive || !v.granted) {
      // hold at the stop line
      v.s = lane.len - 0.02;
      v.v = 0;
      return false;
    }
    const over = v.s - lane.len;
    removeFrom(lane.vehicles, v);
    if (!lane.vehicles.length) this.occupied.delete(lane);
    v.lane = null;
    v.conn = conn;
    v.s = over;
    v.enterT = this.time;
    v.granted = false;
    v.wantGo = false;
    insertSorted(conn.vehicles, v);
    this.occupied.add(conn);
    return true;
  }

  leaveConn(v, conn) {
    const lane = conn.to;
    const over = v.s - conn.len;
    removeFrom(conn.vehicles, v);
    if (!conn.vehicles.length) this.occupied.delete(conn);
    v.conn = null;
    v.lane = lane;
    v.s = over;
    v.granted = false;
    v.wantGo = false;
    v.stamp = 0;
    v.stopSince = 0;
    insertSorted(lane.vehicles, v);
    this.occupied.add(lane);
    // advance along the route
    if (v.route[v.ri + 1] === lane.dir) v.ri++;
    else {
      const k = v.route.indexOf(lane.dir, v.ri);
      if (k >= 0) v.ri = k;
      else if (!this.reroute(v)) return;
    }
    this.chooseNext(v);
  }

  arrive(v) {
    const lane = v.lane;
    const p = lane.poly.pointAt(Math.min(v.s, lane.len));
    this.ghosts.push({ x: p.x, y: p.y, tx: p.tx, ty: p.ty, color: v.color, kind: v.kind, lat: v.lat, t: 0, slide: 3.6, level: this.levelOf(lane, v.s) });
    this.detach(v);
    v.dead = true;
    this._dead.push(v);
    this.stats.arrived++;
    if (this.onArrive) this.onArrive(v, this.time - v.born);
  }

  /* ------------------------------------------------------------ lane changes */

  laneChanges() {
    const time = this.time;
    for (const v of this.vehicles) {
      // every driver looks at the neighbouring lanes four times a second, staggered by id
      if ((v.id + this.tick) % 5 !== 0) continue;
      const lane = v.lane;
      if (!lane || v.dead) continue;
      const dir = lane.dir;
      const n = dir.lanes.length;
      if (n < 2) continue;
      const dEnd = lane.len - v.s;
      let target = -1;
      let mandatory = false;
      if (v.needLane !== lane.j) {
        target = lane.j + Math.sign(v.needLane - lane.j);
        mandatory = true;
      } else if (time - v.lastChange > 6 && dEnd > 70 && v.v < lane.limit * v.f * 0.72) {
        // blocked by a slow leader? look for a quicker neighbouring lane
        const arr = lane.vehicles;
        const i = arr.indexOf(v);
        const lead = arr[i + 1];
        if (lead && lead.s - lead.len - v.s < 24 && lead.v < v.v * 0.9 + 1) {
          const options = [lane.j - 1, lane.j + 1].filter((j) => j >= 0 && j < n && (v.laneMask & (1 << j)) !== 0);
          for (const j of options) {
            const l2 = dir.lanes[j];
            const nb = this.neighbours(l2, v.s * (l2.len / lane.len));
            const ahead = nb.lead ? nb.lead.s - nb.lead.len - v.s * (l2.len / lane.len) : 99;
            if (ahead > lead.s - lead.len - v.s + 14) {
              target = j;
              break;
            }
          }
        }
      }
      if (target < 0 || target >= n) continue;
      const l2 = dir.lanes[target];
      const s2 = v.s * (l2.len / lane.len);
      if (v.s < 9 || dEnd < 3) continue;
      const nb = this.neighbours(l2, s2);
      const urgent = mandatory && dEnd < 40;
      if (!this.joinClear(l2, s2, v, urgent)) continue;
      const minF = urgent ? 1.6 : Math.max(2.4, 0.5 * v.v);
      if (nb.lead) {
        const gf = nb.lead.s - nb.lead.len - s2;
        if (gf < minF + Math.max(0, (v.v - nb.lead.v) * 0.8)) continue;
      }
      if (nb.foll && !this.roomBehind(s2 - v.len - nb.foll.s, nb.foll, v, urgent)) continue;
      // go
      removeFrom(lane.vehicles, v);
      if (!lane.vehicles.length) this.occupied.delete(lane);
      v.lat += lane.lo - l2.lo;
      v.lane = l2;
      v.s = s2;
      v.lastChange = time;
      insertSorted(l2.vehicles, v);
      this.occupied.add(l2);
      this.chooseNext(v);
    }
  }

  /**
   * Can v pull into `lane` at s without cutting up a vehicle that is already committed to it? Cars still inside a
   * junction, and cars that have the green and are about to enter, arrive from behind at their own speed.
   */
  joinClear(lane, s, v, urgent) {
    for (const c of lane.inConns) {
      for (const w of c.vehicles) if (!this.roomBehind(s - v.len - (w.s - c.len), w, v, urgent)) return false;
      const fl = c.from.vehicles;
      const front = fl[fl.length - 1];
      if (front && front.nextConn === c && front.granted && !this.roomBehind(s - v.len - (front.s - c.from.len - c.len), front, v, urgent)) return false;
    }
    return true;
  }

  /** Is a gap of `gb` metres enough for follower f behind v (v pulling out in front of it)? */
  roomBehind(gb, f, v, urgent) {
    const dv = Math.max(0, f.v - v.v);
    return gb >= (urgent ? 1.2 : 2.2) + f.v * (urgent ? 0.45 : 0.8) + (dv * dv) / 8;
  }

  /** The vehicles just ahead of and behind position s in a lane. */
  neighbours(lane, s) {
    const arr = lane.vehicles;
    let lead = null;
    let foll = null;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].s > s) lead = arr[i];
      else {
        foll = arr[i];
        break;
      }
    }
    return { lead, foll };
  }

  /* ------------------------------------------------------------ statistics, maintenance */

  updateStats() {
    const dirs = new Map();
    let count = 0;
    let stopped = 0;
    let ratioSum = 0;
    for (const L of this.occupied) {
      if (L.isConn) continue;
      const d = L.dir;
      let rec = dirs.get(d);
      if (!rec) dirs.set(d, (rec = { sum: 0, n: 0 }));
      for (const v of L.vehicles) {
        rec.sum += Math.min(v.v, d.limit);
        rec.n++;
        count++;
        if (v.v < 0.5) stopped++;
        ratioSum += Math.min(1, v.v / Math.max(1, d.limit));
      }
    }
    for (const e of this.net.edges.values()) {
      for (const d of [e.dirF, e.dirB]) {
        if (!d) continue;
        const rec = dirs.get(d);
        if (rec && rec.n > 0) {
          const mean = rec.sum / rec.n;
          const target = clamp(d.limit / Math.max(mean, 0.9), 1, 9);
          d.cong += (target - d.cong) * 0.4;
        } else d.cong += (1 - d.cong) * 0.15;
        d.flowN = rec ? rec.n : 0;
      }
    }
    this.stats.count = this.vehicles.length;
    this.stats.stopped = stopped;
    this.stats.avgRatio = count ? ratioSum / count : 1;
    // stuck handling
    for (const v of this.vehicles) {
      if (v.dead) continue;
      if (v.v < 0.3) v.stuck++;
      else v.stuck = 0;
      if (v.stuck === 30 && v.lane && v.rerouted < 3) this.reroute(v);
      else if (v.stuck > 12 && v.lane && !v.nextConn && v.ri < v.route.length - 1 && v.needLane !== v.lane.j) this.takeAnyExit(v);
      else if (v.stuck > 150) this.kill(v, 'stuck');
    }
  }

  /** A vehicle that cannot reach the right lane takes any available exit and re-plans from there. */
  takeAnyExit(v) {
    const lane = v.lane;
    let best = null;
    let bc = Infinity;
    for (const c of lane.outConns) {
      if (!c.alive) continue;
      const r = c.to.dir === v.dest.dir ? [c.to.dir] : this.router.route(c.to.dir, v.dest.dir, 0);
      if (!r) continue;
      let cost = 0;
      for (const d of r) cost += d.len / Math.max(3, d.limit);
      if (cost < bc) {
        bc = cost;
        best = { c, r };
      }
    }
    if (!best) {
      if (v.stuck > 60) this.kill(v, 'noexit');
      return;
    }
    // a driver who keeps missing the lane for the turn (short stretches, awkward layouts) and circles round again
    // and again is lost: take them off the map rather than let them clog the roads for ever
    if (++v.detours > MAX_DETOURS) {
      this.kill(v, 'lost');
      return;
    }
    v.route = [lane.dir].concat(best.r);
    v.ri = 0;
    v.nextConn = best.c;
    v.needLane = lane.j;
    v.laneMask = 1 << lane.j;
  }

  /** Called after Network.rebuild(): drop or remap vehicles standing on geometry that disappeared. */
  /** The piece (and lane position) closest to a world point, in lane j of each piece; null if none lies within tol metres. */
  locate(pieces, j, x, y, tol) {
    let best = null;
    let bd = tol;
    for (let k = 0; k < pieces.length; k++) {
      const lane = pieces[k].lanes[Math.min(j, pieces[k].lanes.length - 1)];
      if (!lane || !lane.poly) continue;
      const c = lane.poly.closest(x, y);
      if (c.d < bd) {
        bd = c.d;
        best = { k, lane, s: c.s };
      }
    }
    return best;
  }

  /** Carry a vehicle from a lane that a split replaced onto the matching piece. Returns the piece index, or -1. */
  migrate(v, old, map) {
    const pieces = v.dead ? null : map.get(old.dir);
    if (!pieces || !pieces.length) return -1;
    const p = old.poly.pointAt(clamp(v.s, 0, old.len));
    const at = this.locate(pieces, old.j, p.x, p.y, 1.5); // nothing within reach: it was inside the new junction
    if (!at) return -1;
    const nb = this.neighbours(at.lane, at.s);
    if ((nb.lead && nb.lead.s - nb.lead.len - at.s < 0.3) || (nb.foll && at.s - v.len - nb.foll.s < 0.3)) return -1;
    v.lane = at.lane;
    v.s = at.s;
    v.granted = false;
    v.wantGo = false;
    insertSorted(at.lane.vehicles, v);
    this.occupied.add(at.lane);
    return at.k;
  }

  /** Point a vehicle's route and destination at the pieces that replaced a split edge. `here` is the piece it stands on. */
  patchTrip(v, map, here) {
    const r = v.route;
    const last = r.length - 1;
    const oldDest = v.dest.dir;
    let kd = -1;
    const dp = map.get(oldDest);
    if (dp && dp.length) {
      const at = this.locate(dp, v.dest.j, v.dest.x, v.dest.y, Infinity);
      kd = at ? at.k : dp.length - 1;
      if (v.ri === last && r[last] === oldDest) kd = Math.max(kd, here); // already past the driveway: it ends on this piece
      v.dest.dir = dp[kd];
      v.dest.j = clamp(v.dest.j, 0, dp[kd].lanes.length - 1);
    }
    if (kd < 0 && !r.some((d) => map.has(d))) return;
    const out = [];
    let ri = v.ri;
    for (let i = 0; i <= last; i++) {
      const pieces = map.get(r[i]);
      if (!pieces || !pieces.length) {
        out.push(r[i]);
        continue;
      }
      const take = i === last && kd >= 0 && r[i] === oldDest ? pieces.slice(0, kd + 1) : pieces;
      if (i < v.ri) ri += take.length - 1;
      else if (i === v.ri) ri = out.length + Math.min(here, take.length - 1);
      for (const d of take) out.push(d);
    }
    v.route = out;
    v.ri = ri;
  }

  onNetworkChange(info) {
    const removed = info.removed;
    const map = splitMap(info);
    const here = new Map(); // vehicle -> index of the split piece it now stands on
    for (const lane of removed.lanes) {
      for (const v of lane.vehicles.slice()) {
        const k = this.migrate(v, lane, map);
        if (k < 0) this.kill(v, 'road_removed');
        else here.set(v, k);
      }
      lane.vehicles.length = 0;
      this.occupied.delete(lane);
    }
    for (const conn of removed.conns) {
      if (!conn.vehicles.length) {
        this.occupied.delete(conn);
        continue;
      }
      const rep = replacementConn(conn, map);
      const repl = rep && rep.conn;
      const from = rep ? rep.from : 0;
      for (const v of conn.vehicles.slice()) {
        if (repl && repl.alive) {
          removeFrom(conn.vehicles, v);
          v.conn = repl;
          v.s = Math.min(v.s * (repl.len / Math.max(conn.len, 0.1)), repl.len - 0.01);
          v.granted = false;
          insertSorted(repl.vehicles, v);
          this.occupied.add(repl);
          here.set(v, from);
        } else this.kill(v, 'junction_rebuilt');
      }
      conn.vehicles.length = 0;
      this.occupied.delete(conn);
    }
    if (map.size) {
      for (const v of this.vehicles) {
        if (v.dead) continue;
        this.patchTrip(v, map, here.get(v) || 0);
        if (v.lane && here.has(v)) this.chooseNext(v);
      }
    }
    // vehicles on surviving lanes whose geometry shrank
    for (const e of info.edges) {
      for (const d of [e.dirF, e.dirB]) {
        if (!d) continue;
        for (const l of d.lanes) for (const v of l.vehicles) if (v.s > l.len) v.s = l.len - 0.02;
      }
    }
    for (const v of this.vehicles) {
      if (v.dead) continue;
      if (v.nextConn && !v.nextConn.alive && v.lane) this.chooseNext(v);
    }
    this.flushKills();
    if (this._dead.length) {
      const dead = new Set(this._dead);
      this.vehicles = this.vehicles.filter((v) => !dead.has(v));
      this._dead.length = 0;
    }
    for (const L of [...this.occupied]) if (!L.alive) this.occupied.delete(L);
  }

  /* ------------------------------------------------------------ rendering support */

  levelOf(lane, s) {
    const e = lane.dir.edge;
    if (!e.elevated) return 0;
    const z = e.zAt((s / Math.max(lane.len, 0.1)) * e.len);
    return Math.max(0, Math.min(2, Math.ceil(z - 0.01)));
  }

  /** World pose of a vehicle, extrapolated by alpha*dt along its path. */
  pose(v, alpha, out) {
    const c = v.conn || v.lane;
    let s = v.s + v.v * alpha * DT;
    if (s > c.len) s = c.len;
    const p = c.poly.pointAt(s, out);
    out.level = v.conn ? v.conn.from.dir.edge.elevated || v.conn.to.dir.edge.elevated ? Math.max(this.levelOf(v.conn.from, v.conn.from.len), this.levelOf(v.conn.to, 0)) : 0 : this.levelOf(v.lane, s);
    if (v.lat !== 0) {
      out.x += p.ty * v.lat;
      out.y -= p.tx * v.lat;
    }
    return out;
  }
}
