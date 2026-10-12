// The game object: owns terrain, road network, simulation, city and planner, and exposes the player's actions.
// Everything here is DOM-free so it can run headlessly in tests.

import { Terrain } from './terrain.js';
import { Network } from './network.js';
import { RoadPlanner } from './roadplan.js';
import { Sim, DT } from './sim.js';
import { City, DIFFICULTY } from './city.js';
import { Signal } from './signals.js';
import { BUILDING_TYPES } from './buildings.js';
import { Rng } from './util.js';

export const SAVE_VERSION = 1;
const MAX_UNDO = 30;

export class Game {
  /**
   * @param {{seed?:number, biome?:string, difficulty?:string, mode?:string, size?:number, res?:number, starter?:boolean}} opts
   */
  constructor(opts = {}) {
    this.seed = opts.seed ?? Math.floor(Math.random() * 1e6);
    this.biome = opts.biome || 'meadow';
    this.difficulty = DIFFICULTY[opts.difficulty] ? opts.difficulty : 'normal';
    this.mode = opts.mode === 'free' ? 'free' : 'challenge';
    this.terrain = new Terrain({ seed: this.seed, biome: this.biome, size: opts.size || 2400, res: opts.res || 512 });
    this.net = new Network();
    this.sim = new Sim(this.net, this.seed);
    this.world = { net: this.net, terrain: this.terrain, buildings: () => this.city.list };
    this.planner = new RoadPlanner(this.world);
    this.city = new City({ net: this.net, terrain: this.terrain, sim: this.sim, difficulty: this.difficulty, seed: this.seed, free: this.free });
    this.speed = 1;
    this.acc = 0;
    this.simTime = 0;
    this.undoStack = [];
    this.listeners = { rebuild: [], toast: [], buildings: [], money: [] };
    this.net.onRebuild = (info) => {
      this.sim.onNetworkChange(info);
      this.city.onNetworkChange(info);
      for (const f of this.listeners.rebuild) f(info);
    };
    this.city.onLevelUp = (level, batch) => this.emit('toast', { kind: 'level', level, batch });
    if (opts.starter !== false) this.makeStarter();
  }

  /** Free play: building never costs money. */
  get free() {
    return this.mode === 'free';
  }

  on(evt, fn) {
    this.listeners[evt].push(fn);
  }
  emit(evt, data) {
    for (const f of this.listeners[evt] || []) f(data);
  }

  /* ------------------------------------------------------------ starter town */

  makeStarter() {
    const rng = new Rng(this.seed * 5 + 1);
    const ang = rng.range(0, Math.PI);
    const c = Math.cos(ang);
    const s = Math.sin(ang);
    const P = (u, v) => ({ kind: 'free', x: u * c - v * s, y: u * s + v * c, z: 0 });
    const free = (...a) => P(...a);
    const build = (a, b, extra = {}) => {
      const plan = this.planner.planRoad({ a, b, cls: 'street', lf: 1, lb: 1, ...extra });
      if (!plan.ok) return null;
      return this.planner.applyRoad(plan);
    };
    build(free(-150, 0), free(150, 0));
    const jn = this.planner.snap(...(() => { const p = P(0, 0); return [p.x, p.y, 8]; })(), { elev: 0 });
    if (jn) build(jn, P(0, 130));
    const jn2 = this.planner.snap(...(() => { const p = P(0, 0); return [p.x, p.y, 8]; })(), { elev: 0 });
    if (jn2) build(jn2, P(0, -120));
    // buildings along the streets
    const place = (type, x, y) => {
      const pl = this.city.findPlacement(type, x, y, 30);
      if (!pl.ok) return false;
      this.city.addBuilding(pl, { fromTray: false });
      return true;
    };
    const along = [];
    const junctions = [...this.net.nodes.values()].filter((n) => n.edges.length >= 3);
    for (const e of this.net.edges.values()) {
      for (let t = e.setA + 20; t < e.len - e.setB - 16; t += 17) {
        const p = e.poly.pointAt(t);
        // leave room around the junctions so the first roundabout is possible
        if (junctions.some((j) => Math.hypot(j.x - p.x, j.y - p.y) < 46)) continue;
        for (const side of [1, -1]) along.push({ x: p.x + p.ty * side * (e.halfWidth + 7), y: p.y - p.tx * side * (e.halfWidth + 7) });
      }
    }
    // spread the special buildings, fill the rest with houses
    const specials = [['shop', 0.2], ['office', 0.45], ['factory', 0.85]];
    let placed = 0;
    for (const [type, f] of specials) {
      for (let k = 0; k < along.length; k++) {
        const q = along[(Math.floor(f * along.length) + k) % along.length];
        if (place(type, q.x, q.y)) break;
      }
    }
    for (let k = 0; k < along.length && placed < 12; k++) {
      const q = along[(k * 7 + 3) % along.length];
      if (place('house', q.x, q.y)) placed++;
    }
    this.city.tray = { house: 8, shop: 2, office: 1, factory: 0 };
    this.city.recount();
    this.net.rebuild();
  }

  /* ------------------------------------------------------------ time */

  setSpeed(s) {
    this.speed = s;
  }

  /** Advance by dtReal seconds of wall-clock time. Returns the interpolation alpha for rendering. */
  update(dtReal) {
    if (this.speed === 0) return 0;
    this.acc += Math.min(dtReal, 0.1) * this.speed;
    let steps = 0;
    while (this.acc >= DT && steps < 12) {
      this.sim.step(DT);
      this.city.update(DT);
      this.simTime += DT;
      this.acc -= DT;
      steps++;
    }
    if (steps >= 12) this.acc = 0;
    return this.acc / DT;
  }

  /* ------------------------------------------------------------ snapshots / undo / save */

  snapshot() {
    const sig = [];
    for (const n of this.net.nodes.values()) if (n.signal) sig.push([n.id, n.signal.toJSON()]);
    return { v: SAVE_VERSION, net: this.net.toJSON(), sig, city: this.city.toJSON() };
  }

  restore(snap) {
    this.sim.reset();
    this.net.clear();
    this.net.loadJSON(snap.net);
    for (const [id, data] of snap.sig || []) {
      const n = this.net.nodes.get(id);
      if (n) n.signal = Signal.fromJSON(n, data);
    }
    this.city.pending = [];
    this.city.delayed = [];
    this.city.loadJSON(snap.city);
    this.city.onNetworkChange();
    this.emit('buildings');
    this.emit('money');
  }

  pushUndo() {
    this.undoStack.push(JSON.stringify(this.snapshot()));
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  canUndo() {
    return this.undoStack.length > 0;
  }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.restore(JSON.parse(s));
    return true;
  }

  serialize() {
    return { ...this.snapshot(), seed: this.seed, biome: this.biome, difficulty: this.difficulty, mode: this.mode };
  }

  /** Rebuild a game from serialised data. */
  static fromSave(data, opts = {}) {
    const g = new Game({ seed: data.seed, biome: data.biome, difficulty: data.difficulty, mode: data.mode, starter: false, ...opts });
    g.restore(data);
    return g;
  }

  /* ------------------------------------------------------------ player actions */

  afford(cost) {
    return this.free || cost <= 0 || this.city.money >= cost;
  }

  buildRoad(plan) {
    if (!plan.ok) return { ok: false, error: plan.error };
    if (!this.afford(plan.cost)) return { ok: false, error: 'no_money' };
    this.pushUndo();
    this.city.spend(plan.cost);
    const res = this.planner.applyRoad(plan);
    this.emit('money');
    return { ok: true, ...res };
  }

  buildRoundabout(plan) {
    if (!plan.ok) return { ok: false, error: plan.error };
    if (!this.afford(plan.cost)) return { ok: false, error: 'no_money' };
    this.pushUndo();
    this.city.spend(plan.cost);
    const res = this.planner.applyRoundabout(plan);
    this.emit('money');
    return { ok: true, ...res };
  }

  changeLane(plan) {
    if (!plan.ok) return { ok: false, error: plan.error };
    if (!this.afford(plan.cost)) return { ok: false, error: 'no_money' };
    this.pushUndo();
    this.city.spend(plan.cost);
    this.planner.applyLane(plan);
    this.emit('money');
    return { ok: true };
  }

  toggleSignal(node) {
    const probe = node.signal ? { cost: 0 } : { cost: 1500 };
    if (!this.afford(probe.cost)) return { ok: false, error: 'no_money' };
    this.pushUndo();
    const r = this.planner.toggleSignal(node);
    if (!r.ok) {
      this.undoStack.pop();
      return r;
    }
    this.city.spend(r.cost);
    this.emit('money');
    this.emit('rebuild', { nodes: new Set([node]), edges: new Set(), removed: {} });
    return r;
  }

  bulldozeEdge(edge, undo = true) {
    if (undo) this.pushUndo();
    const { refund } = this.planner.removeEdge(edge);
    this.city.money += refund;
    this.emit('money');
    return { ok: true, refund };
  }

  /**
   * Demolish several roads and buildings as ONE undo step with a single network rebuild (the simulation drops the
   * vehicles on the removed roads). Roads refund through the city's money; buildings go back to the tray.
   * `undo` false leaves the undo step to the caller (a sweep that already took one).
   */
  demolish({ edges = [], buildings = [] }, undo = true) {
    const roads = edges.filter((e) => e.alive);
    const homes = buildings.filter((b) => this.city.has(b));
    if (!roads.length && !homes.length) return { ok: false, error: 'nothing' };
    if (undo) this.pushUndo();
    let refund = 0;
    let count = 0;
    if (roads.length) ({ refund, count } = this.planner.removeEdges(roads));
    let picked = 0;
    for (const b of homes) if (this.city.removeBuilding(b)) picked++;
    this.city.money += refund;
    this.emit('money');
    if (picked) this.emit('buildings');
    return { ok: true, refund, roads: count, buildings: picked };
  }

  /** Remove the whole street an edge belongs to (see RoadPlanner.streetRun). */
  bulldozeStreet(edge) {
    return this.demolish({ edges: this.planner.streetRun(edge) });
  }

  /** Remove everything an area selection (RoadPlanner.areaSelection) picked. */
  demolishArea(sel) {
    return this.demolish({ edges: sel.edges, buildings: sel.buildings });
  }

  placeBuilding(pl) {
    if (!pl.ok) return { ok: false, error: pl.reason };
    if (this.city.available(pl.type) <= 0) return { ok: false, error: 'tray_empty' };
    this.pushUndo();
    const b = this.city.addBuilding(pl);
    this.emit('buildings');
    return { ok: true, building: b };
  }

  removeBuilding(b, undo = true) {
    if (!this.city.has(b)) return { ok: false, error: 'gone' };
    if (undo) this.pushUndo();
    this.city.removeBuilding(b);
    this.emit('buildings');
    return { ok: true };
  }

  buildingTypes() {
    return BUILDING_TYPES;
  }
}
