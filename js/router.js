// Congestion-aware A* over directed edges ("Dirs"). Costs are travel times; `dir.cong` is a multiplier the
// simulation keeps up to date from observed speeds, so cars pick routes based on current traffic.

import { MinHeap } from './util.js';

const VMAX = 30;

export class Router {
  constructor() {
    this.heap = new MinHeap();
    this.expansions = 0;
  }

  junctionPenalty(node, from, to) {
    if (node.signal) return 9;
    if (from.edge.ring != null || to.edge.ring != null) return 1.5;
    if (node.edges.length <= 2) return 0;
    return 2.5;
  }

  /**
   * @param {import('./network.js').Dir} start the Dir the vehicle is on (or about to be on)
   * @param {import('./network.js').Dir} goal the Dir that contains the destination
   * @param {number} seed per-vehicle noise seed (0 = none) so that drivers do not all pick identical routes
   * @returns {import('./network.js').Dir[]|null}
   */
  route(start, goal, seed = 0) {
    if (!start || !goal) return null;
    if (start === goal) return [start];
    const heap = this.heap;
    heap.clear();
    const g = new Map();
    const prev = new Map();
    const closed = new Set();
    g.set(start, 0);
    const gx = goal.from.x;
    const gy = goal.from.y;
    heap.push(start, 0);
    let n = 0;
    while (heap.size) {
      const d = heap.pop();
      if (closed.has(d)) continue;
      if (d === goal) {
        const out = [d];
        let c = d;
        while (prev.has(c)) {
          c = prev.get(c);
          out.push(c);
        }
        out.reverse();
        this.expansions = n;
        return out;
      }
      closed.add(d);
      if (++n > 9000) break;
      const gd = g.get(d);
      for (const nx of d.next) {
        if (closed.has(nx) || !nx.alive) continue;
        const noise = seed ? 1 + 0.14 * (((nx.id * 2654435761 + seed * 40503) >>> 8) % 1000) / 1000 : 1;
        const t = ((nx.len || 1) / Math.max(1, nx.limit)) * nx.cong * noise + this.junctionPenalty(d.to, d, nx);
        const ng = gd + t;
        const old = g.get(nx);
        if (old === undefined || ng < old) {
          g.set(nx, ng);
          prev.set(nx, d);
          const h = Math.hypot(nx.to.x - gx, nx.to.y - gy) / VMAX;
          heap.push(nx, ng + h);
        }
      }
    }
    this.expansions = n;
    return null;
  }

  /** A route that leaves `dir` and comes back to it: for a destination behind the car on the same stretch of road. */
  loop(dir, seed = 0) {
    let best = null;
    let bestCost = Infinity;
    for (const nx of dir.next) {
      if (!nx.alive || nx === dir) continue;
      const r = this.route(nx, dir, seed);
      if (!r) continue;
      let cost = 0;
      for (const d of r) cost += ((d.len || 1) / Math.max(1, d.limit)) * d.cong;
      if (cost < bestCost) {
        bestCost = cost;
        best = r;
      }
    }
    return best ? [dir, ...best] : null;
  }
}
