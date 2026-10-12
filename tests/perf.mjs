// Not part of the pass/fail suite: prints how long a sim step takes in a big busy city.
import { makeWorld, road, free, accessPoints } from './simlib.mjs';
import { Rng } from '../js/util.js';
import { DT } from '../js/sim.js';

const w = makeWorld();
const ys = [-520, -380, -240, -100, 40, 180, 320, 460];
const xs = [-470, -330, -190, -50, 90, 230, 370, 510];
for (const y of ys) { try { road(w.planner, free(-650, y), free(650, y), { cls: y % 280 === 0 ? 'avenue' : 'street', lf: y % 280 === 0 ? 2 : 1, lb: y % 280 === 0 ? 2 : 1 }); } catch (e) {} }
for (const x of xs) { try { road(w.planner, free(x, -650), free(x, 650), { cls: 'street', lf: 1, lb: 1 }); } catch (e) {} }
const jn = [...w.net.nodes.values()].filter((n) => n.edges.length >= 3);
console.log('edges', w.net.edges.size, 'nodes', w.net.nodes.size, 'junctions', jn.length);
let i = 0;
for (const n of jn) if (i++ % 3 === 0) w.planner.toggleSignal(n);
const pts = accessPoints(w.net);
const rng = new Rng(5);
const sim = w.sim;
sim.maxVehicles = 3000;
let tSpawn = 0, steps = 0, tStep = 0, maxStep = 0;
const total = 600 / DT;
for (let k = 0; k < total; k++) {
  if (k % 4 === 0 && sim.vehicles.length < 1100) {
    for (let j = 0; j < 4; j++) {
      const a = rng.pick(pts), b = rng.pick(pts);
      if (a !== b) sim.spawn({ from: a, to: b, kind: rng.chance(0.08) ? 'truck' : 'car' });
    }
  }
  const t0 = performance.now();
  sim.step(DT);
  const dt = performance.now() - t0;
  tStep += dt; steps++; if (dt > maxStep) maxStep = dt;
  if (k % 2400 === 0) console.log(`t=${(k * DT).toFixed(0)}s vehicles ${sim.vehicles.length} avg step ${(tStep / steps).toFixed(2)} ms, max ${maxStep.toFixed(1)} ms, stopped ${sim.stats.stopped}, arrived ${sim.stats.arrived}, removed ${sim.stats.removed}`);
}
console.log(`FINAL vehicles ${sim.vehicles.length} avg step ${(tStep / steps).toFixed(2)} ms (budget 50 ms at 1x, ~12 ms per step at 4x), max ${maxStep.toFixed(1)} ms`);
