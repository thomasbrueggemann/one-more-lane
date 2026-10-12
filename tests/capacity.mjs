// Saturation throughput of a single 4-arm junction under different controls (prints vehicles per hour).
import { makeWorld, road, free } from './simlib.mjs';
import { Rng } from '../js/util.js';
import { DT } from '../js/sim.js';

function bench(control, { lanes = 1, seconds = 900, cls = 'street', main = null } = {}) {
  const w = makeWorld();
  const mk = (a, b, c = cls, n = lanes) => road(w.planner, a, b, { cls: c, lf: n, lb: n });
  mk(free(-300, 0), free(300, 0), main || cls, main ? lanes : lanes);
  mk(free(0, -300), free(0, 300));
  const jn = [...w.net.nodes.values()].find((n) => n.edges.length === 4);
  if (control === 'signals') w.planner.toggleSignal(jn);
  if (control === 'signals+lefts') { w.planner.toggleSignal(jn); jn.signal.protectedLefts = true; jn.signal.rebuildPhases(); }
  if (control === 'roundabout') {
    const plan = w.planner.planRoundabout({ x: 0, y: 0, R: 20, lanes: lanes > 1 ? 2 : 1 });
    if (!plan.ok) return { error: plan.error };
    w.planner.applyRoundabout(plan);
  }
  // arms' far ends: spawn near the far end of each incoming dir, target the far end of another outgoing dir
  const ends = [];
  for (const e of w.net.edges.values()) {
    for (const d of [e.dirF, e.dirB]) {
      if (!d) continue;
      const far = d.from.edges.length === 1; // starts at a dead end
      const near = d.to.edges.length === 1; // ends at a dead end
      if (far) ends.push({ role: 'src', d });
      if (near) ends.push({ role: 'dst', d });
    }
  }
  const src = ends.filter((x) => x.role === 'src');
  const dst = ends.filter((x) => x.role === 'dst');
  const rng = new Rng(11);
  const sim = w.sim;
  sim.maxVehicles = 4000;
  const total = Math.round(seconds / DT);
  let counted = 0;
  const warm = 300;
  sim.onArrive = (v) => { if (sim.time > warm) counted++; };
  for (let i = 0; i < total; i++) {
    if (i % 4 === 0) {
      for (const s of src) {
        const lane = s.d.lanes[s.d.lanes.length - 1];
        // keep each source queue saturated: spawn whenever the first 40 m of the lane is clear enough
        const d = rng.pick(dst.filter((t) => t.d.edge !== s.d.edge));
        const ln = d.d.lanes[d.d.lanes.length - 1];
        const from = lane.poly.pointAt(8);
        const to = ln.poly.pointAt(ln.len - 10);
        sim.spawn({ from: { dir: s.d, lane, x: from.x, y: from.y }, to: { dir: d.d, x: to.x, y: to.y, j: d.d.lanes.length - 1 } });
      }
    }
    sim.step(DT);
  }
  return { vph: Math.round((counted * 3600) / (seconds - warm)), stopped: sim.stats.stopped, active: sim.vehicles.length };
}

const cases = [
  ['none (all-way)', 'none'],
  ['signals', 'signals'],
  ['signals + protected lefts', 'signals+lefts'],
  ['roundabout', 'roundabout'],
];
for (const [name, ctl] of cases) {
  const r = bench(ctl);
  console.log(name.padEnd(28), r.error ? 'plan error ' + r.error : `${r.vph} veh/h total  (active ${r.active}, stopped ${r.stopped})`);
}
console.log('--- avenue 2+2 main road, streets cross');
for (const [name, ctl] of cases) {
  const r = bench(ctl, { lanes: 2, cls: 'avenue' });
  console.log(name.padEnd(28), r.error ? 'plan error ' + r.error : `${r.vph} veh/h total  (active ${r.active}, stopped ${r.stopped})`);
}
