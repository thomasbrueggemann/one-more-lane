// Traffic signal controller. A signal owns a list of phases; each phase lists the movements (in-dir > out-dir)
// that are green. A phase runs: green (dur) -> amber -> all-red clearance.

import { angleDiff } from './util.js';

export const SIGNAL_RED = 0;
export const SIGNAL_GREEN = 1;
export const SIGNAL_AMBER = 2;

export class Signal {
  constructor(node) {
    this.node = node;
    this.phases = [];
    this.idx = 0;
    this.t = 0;
    this.amber = 3;
    this.clear = 1.0;
    this.minGreen = 6; // an actuated phase never ends sooner than this
    this.protectedLefts = false;
    this.custom = false; // the player has regrouped movements into phases, so rebuilds must not throw that away
    this.demand = null; // per phase: is anyone waiting? (set by the simulation a couple of times per second)
    this.rebuildPhases();
    this.t = (node.id * 7.3) % Math.max(1, this.phases[0]?.dur || 1); // desynchronise neighbouring signals
  }

  get phase() {
    return this.phases[this.idx];
  }

  get cycle() {
    let c = 0;
    for (const p of this.phases) c += p.dur + this.amber + this.clear;
    return c;
  }

  /**
   * Bring the phases in line with the node's current movements, keeping custom durations when the count matches.
   * A customised signal keeps the player's grouping instead (see mergePhases); `rename` maps old movement keys to the
   * keys they got when a road next to the junction was split.
   */
  rebuildPhases(rename = null) {
    if (this.custom && this.phases.length) this.mergePhases(rename);
    else {
      const keep = this.phases.map((p) => p.dur);
      this.phases = Signal.defaultPhases(this.node, this.protectedLefts);
      if (keep.length === this.phases.length) this.phases.forEach((p, i) => (p.dur = keep[i]));
    }
    this.demand = null;
    this.idx = Math.min(this.idx, Math.max(0, this.phases.length - 1));
  }

  /**
   * Keep the player's phases through a change to the junction: movements that are gone drop out, and movements that
   * are new share one extra phase until the player places them. `saved` = [[dur, [moveKey...]]...] (e.g. from a save).
   */
  mergePhases(rename = null, saved = null) {
    const valid = new Set(this.node.conns.map((c) => c.moveKey));
    const src = saved || this.phases.map((p) => [p.dur, [...p.moves]]);
    const phases = [];
    const placed = new Set();
    for (const [dur, moves] of src) {
      const keep = new Set();
      for (const k of moves) {
        const key = (rename && rename.get(k)) || k;
        if (valid.has(key)) {
          keep.add(key);
          placed.add(key);
        }
      }
      if (keep.size) phases.push({ dur, moves: keep });
    }
    const fresh = [...valid].filter((k) => !placed.has(k));
    if (fresh.length) phases.push({ dur: 12, moves: new Set(fresh) });
    if (phases.length) this.phases = phases;
    else {
      this.custom = false;
      this.phases = Signal.defaultPhases(this.node, this.protectedLefts);
    }
  }

  /** Switch protected left turns on or off: this starts again from the default phases. */
  setProtectedLefts(on) {
    this.protectedLefts = on;
    this.custom = false;
    this.rebuildPhases();
    this.idx = 0;
  }

  /** Group the approaches into opposed axes and make one phase per axis (optionally with protected lefts). */
  static defaultPhases(node, protectedLefts) {
    const byDir = new Map();
    for (const c of node.conns) {
      if (!byDir.has(c.from.dir)) {
        const t = c.from.poly.pointAt(c.from.len);
        byDir.set(c.from.dir, { dir: c.from.dir, ang: Math.atan2(t.ty, t.tx), conns: [] });
      }
      byDir.get(c.from.dir).conns.push(c);
    }
    const apps = [...byDir.values()].sort((a, b) => a.ang - b.ang);
    const used = new Set();
    const axes = [];
    for (const a of apps) {
      if (used.has(a)) continue;
      used.add(a);
      let best = null;
      let bd = 0.62; // within ~35 degrees of exactly opposite
      for (const b of apps) {
        if (used.has(b)) continue;
        const d = Math.abs(angleDiff(a.ang + Math.PI, b.ang));
        if (d < bd) {
          bd = d;
          best = b;
        }
      }
      if (best) used.add(best);
      axes.push(best ? [a, best] : [a]);
    }
    const phases = [];
    for (const axis of axes) {
      const green = new Set();
      const lefts = new Set();
      for (const a of axis) {
        for (const c of a.conns) {
          if (protectedLefts && c.turn === 'L' && axes.length > 1) lefts.add(c.moveKey);
          else green.add(c.moveKey);
        }
      }
      const main = axis.some((a) => a.dir.edge.cls !== 'street');
      if (green.size) phases.push({ dur: main ? 26 : 20, moves: green });
      if (lefts.size) phases.push({ dur: 9, moves: lefts });
    }
    if (!phases.length) phases.push({ dur: 10, moves: new Set(node.conns.map((c) => c.moveKey)) });
    return phases;
  }

  /**
   * Advance the controller. Phases are actuated: a green ends early once nobody is left to serve (after the minimum
   * green) while another phase has demand, and phases with no demand are skipped. `dur` is therefore the maximum green.
   */
  update(dt) {
    const n = this.phases.length;
    if (!n) return;
    this.t += dt;
    const d = this.demand;
    let p = this.phases[this.idx];
    if (d && n > 1 && this.t >= this.minGreen && this.t < p.dur) {
      const here = d[this.idx];
      let other = false;
      for (let i = 0; i < n; i++) if (i !== this.idx && d[i]) other = true;
      if (!here && other) this.t = p.dur; // gap-out: start the amber now
    }
    const total = p.dur + this.amber + this.clear;
    if (this.t >= total) {
      this.t = 0;
      let next = (this.idx + 1) % n;
      if (d && n > 1) {
        for (let k = 0; k < n; k++) {
          const cand = (this.idx + 1 + k) % n;
          if (d[cand]) {
            next = cand;
            break;
          }
        }
      }
      this.idx = next;
      p = this.phases[this.idx];
    }
  }

  /** SIGNAL_RED / GREEN / AMBER for a movement key. */
  state(moveKey) {
    const p = this.phases[this.idx];
    if (!p || !p.moves.has(moveKey)) return SIGNAL_RED;
    if (this.t < p.dur) return SIGNAL_GREEN;
    if (this.t < p.dur + this.amber) return SIGNAL_AMBER;
    return SIGNAL_RED;
  }

  /** Seconds of green/amber left for a movement (0 when red). */
  timeLeft(moveKey) {
    const p = this.phases[this.idx];
    if (!p || !p.moves.has(moveKey)) return 0;
    return Math.max(0, p.dur + this.amber - this.t);
  }

  toJSON() {
    return { phases: this.phases.map((p) => [p.dur, [...p.moves]]), idx: this.idx, t: this.t, pl: this.protectedLefts, c: this.custom ? 1 : 0 };
  }

  static fromJSON(node, data) {
    const s = new Signal(node);
    s.protectedLefts = !!data.pl;
    s.rebuildPhases();
    if (data.c && data.phases && data.phases.length) {
      s.custom = true;
      s.mergePhases(null, data.phases);
      s.idx = Math.min(data.idx || 0, s.phases.length - 1);
    } else if (data.phases && data.phases.length === s.phases.length) {
      data.phases.forEach(([dur], i) => (s.phases[i].dur = dur));
    }
    return s;
  }
}
