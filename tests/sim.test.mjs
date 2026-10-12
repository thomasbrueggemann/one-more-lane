import assert from 'node:assert/strict';
import { makeWorld, road, free, accessPoints, run } from './simlib.mjs';

function report(name, m) {
  console.log(
    `${name.padEnd(28)} spawned ${String(m.spawned).padStart(4)} arrived ${String(m.arrived).padStart(4)} active ${String(m.active).padStart(3)} ` +
      `removed ${m.removed} overlaps ${m.overlapEvents} delay(med/p90) ${m.medianDelay.toFixed(2)}/${m.p90Delay.toFixed(2)} noroute ${m.noroute} busy ${m.busy} stopped ${m.stopped}`,
  );
  if (m.worst.length) console.log('   worst overlaps:', JSON.stringify(m.worst.slice(0, 3)));
}

// ---- A: straight road, vehicles travelling one way
{
  const w = makeWorld();
  road(w.planner, free(0, 0), free(500, 0));
  const aps = accessPoints(w.net);
  const eastbound = aps.filter((p) => p.dir.fwd);
  const from = eastbound[0];
  const to = eastbound[eastbound.length - 1];
  const m = run(w, { seconds: 240, rate: 0.25, pairs: [[from, to]] });
  report('A straight road', m);
  assert.equal(m.overlapEvents, 0, 'no overlapping vehicles');
  assert.ok(m.arrived >= m.spawned - 12, 'nearly everything arrives');
  assert.ok(m.medianDelay < 1.35, 'free flow delay ' + m.medianDelay);
}

// ---- B: 4-way unsignalised street crossing, random trips
{
  const w = makeWorld();
  road(w.planner, free(-250, 0), free(250, 0));
  road(w.planner, free(0, -250), free(0, 250));
  const m = run(w, { seconds: 400, rate: 0.5 });
  report('B 4-way, priority/FIFO', m);
  assert.equal(m.overlapEvents, 0, 'no overlapping vehicles');
  assert.ok(m.arrived > m.spawned * 0.7, 'most vehicles arrive');
}

// ---- C: same crossing with a traffic light
{
  const w = makeWorld();
  road(w.planner, free(-250, 0), free(250, 0));
  road(w.planner, free(0, -250), free(0, 250));
  const jn = [...w.net.nodes.values()].find((n) => n.edges.length === 4);
  w.planner.toggleSignal(jn);
  const m = run(w, { seconds: 400, rate: 0.5 });
  report('C 4-way, signals', m);
  assert.equal(m.overlapEvents, 0, 'no overlapping vehicles');
  assert.ok(m.arrived > m.spawned * 0.7, 'most vehicles arrive');
}

// ---- D: roundabout
{
  const w = makeWorld();
  road(w.planner, free(-250, 0), free(250, 0));
  road(w.planner, free(0, -250), free(0, 250));
  const jn = [...w.net.nodes.values()].find((n) => n.edges.length === 4);
  const plan = w.planner.planRoundabout({ x: jn.x, y: jn.y, R: 16 });
  assert.ok(plan.ok, plan.error);
  w.planner.applyRoundabout(plan);
  const m = run(w, { seconds: 400, rate: 0.6 });
  report('D roundabout', m);
  assert.equal(m.overlapEvents, 0, 'no overlapping vehicles');
  assert.ok(m.arrived > m.spawned * 0.7, 'most vehicles arrive');
}

console.log('sim tests passed');

// ---- E/F: grid with avenues (2+2 lanes, lane changes) and streets, heavy random demand
function grid(signals, seconds, rate, seed) {
  const w = makeWorld();
  const ys = [-250, -90, 70, 230];
  const xs = [-230, -70, 90, 250];
  for (const y of ys) road(w.planner, free(-420, y), free(420, y), { cls: 'avenue', lf: 2, lb: 2 });
  for (const x of xs) {
    try {
      road(w.planner, free(x, -420), free(x, 420), { cls: 'street', lf: 1, lb: 1 });
    } catch (e) {
      /* a crossing that lands too close to a node is simply skipped */
    }
  }
  const junctions = [...w.net.nodes.values()].filter((n) => n.edges.length >= 3);
  if (signals) for (const n of junctions) w.planner.toggleSignal(n);
  const m = run(w, { seconds, rate, trucks: 0.1, seed });
  return { w, m, junctions: junctions.length };
}
for (const signals of [false, true]) {
  for (const seed of [3, 4, 5]) {
    const { m } = grid(signals, 500, 1.2, seed);
    report(`grid ${signals ? 'signals' : 'no signals'} s${seed}`, m);
    assert.equal(m.overlapEvents, 0, 'no overlapping vehicles');
    assert.ok(m.arrived > m.spawned * 0.55, 'grid keeps flowing');
    assert.ok(m.removed < m.spawned * 0.05, 'few vehicles removed as stuck');
  }
}
console.log('grid tests passed');
