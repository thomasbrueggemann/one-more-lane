// Helpers shared by the headless simulation tests.
import { Network } from '../js/network.js';
import { RoadPlanner } from '../js/roadplan.js';
import { Sim, DT } from '../js/sim.js';
import { Rng } from '../js/util.js';

export const terrain = { inside: () => true, blockedAt: () => null, blockedDisc: () => null };

export function makeWorld() {
  const net = new Network();
  const buildings = [];
  const world = { net, terrain, buildings: () => buildings };
  const planner = new RoadPlanner(world);
  const sim = new Sim(net, 7);
  net.onRebuild = (info) => sim.onNetworkChange(info);
  return { net, planner, sim, world };
}

export const free = (x, y, z = 0) => ({ kind: 'free', x, y, z });

export function road(planner, a, b, opts = {}) {
  const plan = planner.planRoad({ a, b, cls: 'street', lf: 1, lb: 1, ...opts });
  if (!plan.ok) throw new Error(`road ${JSON.stringify([a.x, a.y, b.x, b.y])} failed: ${plan.error}`);
  return planner.applyRoad(plan);
}

/** All access targets: every Dir's curb lane midpoint. */
export function accessPoints(net, filter = () => true) {
  const out = [];
  for (const e of net.edges.values()) {
    if (e.invalid || !filter(e)) continue;
    for (const d of [e.dirF, e.dirB]) {
      if (!d) continue;
      const lane = d.lanes[d.lanes.length - 1];
      if (lane.len < 14) continue;
      for (const f of [0.35, 0.65]) {
        const p = lane.poly.pointAt(lane.len * f);
        out.push({ dir: d, x: p.x, y: p.y });
      }
    }
  }
  return out;
}

export function overlaps(sim, minDist = 2.1) {
  const poses = sim.vehicles
    .filter((v) => !v.dead)
    .map((v) => {
      const o = {};
      sim.pose(v, 0, o);
      return { v, x: o.x, y: o.y };
    });
  const bad = [];
  for (let i = 0; i < poses.length; i++) {
    for (let j = i + 1; j < poses.length; j++) {
      const a = poses[i];
      const b = poses[j];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (d < minDist) bad.push([a.v, b.v, d]);
    }
  }
  return bad;
}

/**
 * Run the sim for `seconds`, spawning `rate` vehicles per second between random access points.
 * Returns metrics. `pairs` optionally restricts origin/destination choices.
 */
export function run({ net, sim }, { seconds = 300, rate = 0.5, seed = 3, points = null, pairs = null, checkEvery = 10, trucks = 0 }) {
  const rng = new Rng(seed);
  const pts = points || accessPoints(net);
  let spawned = 0;
  let busy = 0;
  let noroute = 0;
  let maxOverlap = 0;
  let overlapEvents = 0;
  const worst = [];
  const steps = Math.round(seconds / DT);
  let acc = 0;
  const times = [];
  sim.onArrive = (v, t) => times.push([t, v.ideal]);
  for (let i = 0; i < steps; i++) {
    acc += rate * DT;
    while (acc >= 1) {
      acc -= 1;
      let from;
      let to;
      if (pairs) {
        const pr = rng.pick(pairs);
        from = pr[0];
        to = pr[1];
      } else {
        from = rng.pick(pts);
        to = rng.pick(pts);
        if (to === from) continue;
      }
      const r = sim.spawn({ from, to, kind: rng.chance(trucks) ? 'truck' : 'car' });
      if (r.vehicle) spawned++;
      else if (r.fail === 'busy') busy++;
      else if (r.fail === 'noroute') noroute++;
    }
    sim.step(DT);
    if (i % checkEvery === 0) {
      const bad = overlaps(sim);
      if (bad.length) {
        overlapEvents += bad.length;
        for (const b of bad) {
          maxOverlap = Math.max(maxOverlap, 2.1 - b[2]);
          if (worst.length < 5) worst.push({ t: sim.time.toFixed(1), a: describe(b[0]), b: describe(b[1]), d: b[2].toFixed(2) });
        }
      }
    }
  }
  const delays = times.map(([t, ideal]) => t / Math.max(ideal, 1));
  delays.sort((a, b) => a - b);
  return {
    spawned,
    busy,
    noroute,
    arrived: sim.stats.arrived,
    active: sim.vehicles.length,
    removed: sim.stats.removed,
    overlapEvents,
    maxOverlap,
    worst,
    medianDelay: delays.length ? delays[Math.floor(delays.length / 2)] : 0,
    p90Delay: delays.length ? delays[Math.floor(delays.length * 0.9)] : 0,
    stopped: sim.stats.stopped,
  };
}

function describe(v) {
  const where = v.conn ? `conn ${v.conn.key} s=${v.s.toFixed(1)}/${v.conn.len.toFixed(1)}` : `lane ${v.lane.id} (edge ${v.lane.dir.edge.id}) s=${v.s.toFixed(1)}/${v.lane.len.toFixed(1)}`;
  return `${v.id}@${where} v=${v.v.toFixed(1)}`;
}
