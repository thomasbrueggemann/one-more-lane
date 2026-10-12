// Demolishing streets and areas: street-run selection, rectangle selection, one-step undo, consistency under traffic.
import assert from 'node:assert/strict';
import { Game } from '../js/game.js';
import { checkInvariants } from './invariants.mjs';

const free = (x, y, z = 0) => ({ kind: 'free', x, y, z });

function build(g, a, b, extra = {}) {
  const plan = g.planner.planRoad({ a, b, cls: 'street', lf: 1, lb: 1, ...extra });
  assert.ok(plan.ok, `plan failed: ${plan.error}`);
  const r = g.buildRoad(plan);
  assert.ok(r.ok);
  return r;
}
/** Open, flat ground everywhere (the generated terrain has lakes and rocks) and plenty of money. */
function flat(g) {
  Object.assign(g.terrain, { inside: () => true, blockedAt: () => null, blockedDisc: () => null });
  g.city.money = 1e6;
}
const snapAt = (g, x, y) => g.planner.snap(x, y, 8, { elev: 0 });

/**
 * A main street y=0 (x -200..200) crossed by x=-60 (X junction), a stem at x=80 hanging south from it (T junction),
 * and an avenue continuing the x=-60 street to the north.
 */
function town(seed = 5) {
  const g = new Game({ seed, biome: 'meadow', res: 96, starter: false });
  flat(g);
  build(g, free(-200, 0), free(200, 0));
  build(g, free(-60, -100), free(-60, 100));
  build(g, snapAt(g, 80, 0), free(80, -110));
  build(g, snapAt(g, -60, 100), free(-60, 230), { cls: 'avenue', lf: 2, lb: 2 });
  return g;
}

/** Run the game for `secs` seconds with extra through-traffic between random road ends so edits happen among vehicles. */
let spawnN = 0;
function run(g, secs) {
  for (let k = 0; k < secs * 20; k++) {
    if (k % 5 === 0 && g.sim.vehicles.length < 80) {
      const dirs = [...g.net.edges.values()].flatMap((e) => [e.dirF, e.dirB]).filter((d) => d && d.lanes[0].len > 14);
      if (dirs.length > 1) {
        const da = dirs[(spawnN * 7) % dirs.length];
        const db = dirs[(spawnN * 13 + 3) % dirs.length];
        spawnN++;
        const la = da.lanes[da.lanes.length - 1];
        const lb = db.lanes[db.lanes.length - 1];
        const pa = la.poly.pointAt(la.len * 0.5);
        const pb = lb.poly.pointAt(lb.len * 0.5);
        g.sim.spawn({ from: { dir: da, lane: la, x: pa.x, y: pa.y }, to: { dir: db, x: pb.x, y: pb.y, j: db.lanes.length - 1 } });
      }
    }
    g.update(0.05);
  }
}

const mid = (e) => e.poly.pointAt(e.len / 2);
const nearLine = (e, f) => e.poly.xs.every((x, i) => f(x, e.poly.ys[i]));
const edgeAt = (g, x, y) => g.net.nearestEdge(x, y, 12).edge;
const total = (edges) => edges.reduce((s, e) => s + e.len, 0);

// ---- street runs
{
  const g = town();
  const pl = g.planner;
  const main = pl.streetRun(edgeAt(g, 30, 0));
  assert.ok(main.every((e) => nearLine(e, (x, y) => Math.abs(y) < 0.5)), 'main street run stays on the main street');
  assert.ok(Math.abs(total(main) - 400) < 1, `main street is followed through the X and the T, length ${total(main)}`);

  const cross = pl.streetRun(edgeAt(g, -60, -50));
  assert.ok(cross.every((e) => e.cls === 'street' && nearLine(e, (x) => Math.abs(x + 60) < 0.5)), 'cross street stays straight and on its class');
  assert.ok(Math.abs(total(cross) - 200) < 1, `cross street runs through the main street to the avenue joint, length ${total(cross)}`);
  assert.ok(cross.some((e) => mid(e).y < 0) && cross.some((e) => mid(e).y > 0), 'it passes through the junction with the main street');

  const stem = pl.streetRun(edgeAt(g, 80, -60));
  assert.ok(stem.every((e) => nearLine(e, (x) => Math.abs(x - 80) < 0.5)), 'a T stem does not turn into the main street');
  assert.ok(Math.abs(total(stem) - 110) < 1, `stem length ${total(stem)}`);

  const ave = pl.streetRun(edgeAt(g, -60, 180));
  assert.ok(ave.every((e) => e.cls === 'avenue'), 'class change ends the run');
  assert.ok(Math.abs(total(ave) - 130) < 1, `avenue length ${total(ave)}`);

  // lane count changes also end a run
  const e = edgeAt(g, 150, 0);
  const g2 = town();
  const plan = g2.planner.planLane(edgeAt(g2, 150, 0), 1, 1);
  assert.ok(plan.ok, plan.error);
  g2.changeLane(plan);
  const widened = g2.planner.streetRun(edgeAt(g2, 150, 0));
  assert.ok(widened.length < main.length, 'a different lane count is a different street');
  assert.ok(widened.every((x) => x.lf === 2), 'only the widened piece(s)');
  void e;
}

// ---- a bend of the same street is followed, a roundabout is one unit
{
  const g = new Game({ seed: 6, biome: 'meadow', res: 96, starter: false });
  flat(g);
  const r = build(g, free(-150, 0), free(0, 0));
  const end = r.nodes[r.nodes.length - 1];
  build(g, { kind: 'node', node: end, x: end.x, y: end.y, z: 0 }, free(140, 100)); // continues with a smooth bend
  const all = [...g.net.edges.values()];
  assert.equal(g.planner.streetRun(all[0]).length, all.length, 'a curve split into pieces is one street');

  const ring = g.planner.planRoundabout({ x: -75, y: 0, R: 20 });
  assert.ok(ring.ok, ring.error);
  g.buildRoundabout(ring);
  const rg = [...g.net.edges.values()].find((e) => e.ring != null);
  const run = g.planner.streetRun(rg);
  assert.ok(run.length >= 3 && run.every((e) => e.ring === rg.ring), 'roundabout run is the ring');
  const arm = [...g.net.edges.values()].find((e) => e.ring == null && e.a.ring != null);
  assert.ok(g.planner.streetRun(arm).every((e) => e.ring == null), 'a street stops at the roundabout');
}

// ---- whole-street removal: one undo step, refund, consistent network, traffic keeps running
{
  const g = town();
  g.city.diff = { ...g.city.diff, demand: 6 };
  g.city.tray = { house: 20, shop: 4, office: 3, factory: 2 };
  for (let i = 0; i < 6; i++) {
    const pl = g.city.findPlacement('house', -150 + i * 55, 12, 40);
    if (pl.ok) g.placeBuilding(pl);
  }
  run(g, 40);
  assert.ok(g.sim.vehicles.length > 0, 'there is traffic');
  const before = JSON.stringify(g.snapshot());
  const edgesBefore = g.net.edges.size;
  const money0 = g.city.money;
  const undo0 = g.undoStack.length;
  const street = g.planner.streetRun(edgeAt(g, 0, 0));
  const expectRefund = g.planner.refundFor(street);
  const r = g.bulldozeStreet(edgeAt(g, 0, 0));
  assert.ok(r.ok);
  assert.equal(r.roads, street.length);
  assert.ok(Math.abs(r.refund - expectRefund) < 1e-6 && r.refund > 0);
  assert.equal(g.net.edges.size, edgesBefore - street.length);
  assert.ok(Math.abs(g.city.money - (money0 + r.refund)) < 1e-6, 'refund goes through city.money');
  assert.equal(g.undoStack.length, undo0 + 1, 'one undo step');
  checkInvariants(g, 'after street removal');
  run(g, 30);
  checkInvariants(g, 'running after street removal');
  assert.ok(g.undo());
  assert.equal(g.undoStack.length, undo0);
  assert.equal(JSON.stringify(g.snapshot()), before, 'undo restores the network, signals, buildings and money exactly');
  checkInvariants(g, 'after undo');
  run(g, 30);
  checkInvariants(g, 'running after undo');
}

// ---- area removal
{
  const g = town();
  const pl = g.planner;
  const rect = { x0: -120, y0: -60, x1: 120, y1: 60 };
  const sel = pl.areaSelection(rect);
  const expect = [...g.net.edges.values()].filter((e) => {
    // fully inside, or mostly inside; this layout has no borderline pieces
    const a = e.poly.pointAt(0);
    const b = e.poly.pointAt(e.len);
    const mx = mid(e);
    const inside = (p) => p.x >= rect.x0 && p.x <= rect.x1 && p.y >= rect.y0 && p.y <= rect.y1;
    return inside(mx) && (inside(a) || inside(b) || e.len < 130);
  });
  assert.ok(sel.edges.length > 0);
  assert.equal(new Set(sel.edges).size, sel.edges.length, 'no duplicates');
  for (const e of sel.edges) assert.ok(expect.includes(e), `edge ${e.id} selected but not inside`);
  for (const e of g.net.edges.values()) {
    const m = mid(e);
    const clearlyIn = Math.abs(m.x) < 110 && Math.abs(m.y) < 50 && e.len < 100;
    if (clearlyIn) assert.ok(sel.edges.includes(e), `edge ${e.id} is inside but was not selected`);
    if (Math.abs(m.y) > 70 || Math.abs(m.x) > 130) assert.ok(!sel.edges.includes(e), `edge ${e.id} is outside but was selected`);
  }
  assert.ok(sel.streets >= 2 && sel.streets <= sel.edges.length);
  assert.ok(sel.refund > 0 && sel.buildings.length === 0);

  // a road poking only slightly into the box is left alone, one mostly inside goes
  const none = pl.areaSelection({ x0: 190, y0: -5, x1: 230, y1: 5 });
  assert.equal(none.edges.length, 0, 'the last 10 m of a 120 m piece do not select it');
  const empty = pl.areaSelection({ x0: 1000, y0: 1000, x1: 1100, y1: 1100 });
  assert.equal(empty.edges.length + empty.buildings.length, 0);
  // corners may be dragged in any direction
  const flipped = pl.areaSelection({ x0: 120, y0: 60, x1: -120, y1: -60 });
  assert.equal(flipped.edges.length, sel.edges.length);
  const steps = g.undoStack.length;
  assert.equal(g.demolishArea(empty).ok, false, 'nothing selected: nothing happens and no undo step is taken');
  assert.equal(g.undoStack.length, steps);

  // buildings: only when asked for, and only those whose centre is inside
  g.city.tray = { house: 20, shop: 4, office: 3, factory: 2 };
  for (const x of [-100, -20, 40, 150]) {
    const p = g.city.findPlacement('house', x, 14, 30);
    if (p.ok) g.placeBuilding(p);
  }
  const nb = g.city.list.length;
  assert.ok(nb >= 3);
  g.undoStack.length = 0;
  assert.equal(pl.areaSelection(rect, false).buildings.length, 0);
  const withB = pl.areaSelection(rect, true);
  assert.ok(withB.buildings.length > 0 && withB.buildings.length < nb, `buildings inside: ${withB.buildings.length}/${nb}`);
  for (const b of withB.buildings) assert.ok(b.x >= rect.x0 && b.x <= rect.x1 && b.y >= rect.y0 && b.y <= rect.y1);

  run(g, 30);
  const before = JSON.stringify(g.snapshot());
  const tray0 = g.city.available('house');
  const money0 = g.city.money;
  const edges0 = g.net.edges.size;
  let rebuilds = 0;
  g.on('rebuild', () => rebuilds++);
  const res = g.demolishArea(withB);
  assert.ok(res.ok);
  assert.equal(rebuilds, 1, 'the whole removal is one rebuild');
  assert.equal(res.roads, sel.edges.length);
  assert.equal(res.buildings, withB.buildings.length);
  assert.equal(g.net.edges.size, edges0 - sel.edges.length);
  assert.equal(g.city.list.length, nb - withB.buildings.length);
  assert.equal(g.city.available('house'), tray0 + withB.buildings.filter((b) => b.type === 'house').length, 'buildings return to the tray');
  assert.ok(Math.abs(g.city.money - money0 - sel.refund) < 1e-6);
  assert.equal(g.undoStack.length, 1, 'a single undo step');
  checkInvariants(g, 'after area removal');
  run(g, 60);
  checkInvariants(g, 'running after area removal');
  assert.ok(g.undo());
  assert.equal(g.undoStack.length, 0);
  assert.equal(JSON.stringify(g.snapshot()), before, 'one undo restores every road and building');
  checkInvariants(g, 'after area undo');
  run(g, 30);
  checkInvariants(g, 'running after area undo');
}

// ---- removing everything, and a roundabout inside an area
{
  const g = town(9);
  const ring = g.planner.planRoundabout({ x: 140, y: 0, R: 20 });
  assert.ok(ring.ok, ring.error);
  g.buildRoundabout(ring);
  // a box over the left half of the ring (more than half is needed)
  const half = g.planner.areaSelection({ x0: 100, y0: -40, x1: 140, y1: 40 });
  const rings = half.edges.filter((e) => e.ring != null);
  assert.ok(rings.length >= 3, 'half a ring selects the whole ring: ' + rings.length);
  assert.equal(rings.length, [...g.net.edges.values()].filter((e) => e.ring != null).length);
  const thin = g.planner.areaSelection({ x0: 100, y0: -40, x1: 125, y1: 40 });
  assert.equal(thin.edges.filter((e) => e.ring != null).length, 0, 'a sliver of the ring does not');
  run(g, 20);
  const all = g.planner.areaSelection({ x0: -1000, y0: -1000, x1: 1000, y1: 1000 }, true);
  assert.equal(all.edges.length, g.net.edges.size);
  assert.ok(g.demolishArea(all).ok);
  assert.equal(g.net.edges.size, 0);
  assert.equal(g.net.nodes.size, 0, 'no orphan junctions remain');
  checkInvariants(g, 'empty map');
  run(g, 10);
  assert.ok(g.undo());
  assert.ok(g.net.edges.size > 0);
  checkInvariants(g, 'restored map');
  run(g, 20);
  checkInvariants(g, 'running after restore');
}

console.log('demolish tests passed');
