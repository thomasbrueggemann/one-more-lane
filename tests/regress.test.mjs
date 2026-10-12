// Regression tests for bugs found in an independent review. Every section reproduces the failing scenario.
import assert from 'node:assert/strict';
import { makeWorld, road, free, accessPoints, run, overlaps } from './simlib.mjs';
import { Game } from '../js/game.js';
import { DT } from '../js/sim.js';
import { REFUND, ROUNDABOUT_BASE_COST } from '../js/roadplan.js';
import { CLASSES, Network } from '../js/network.js';
import { Poly } from '../js/geom.js';
import { buildNodeParts } from '../js/render/roadgeom.js';
import { Rng } from '../js/util.js';
import { THEMES } from '../js/render/theme.js';
import { splitMovement } from '../js/signaledit.js';
import { BuildTool, LaneTool, BulldozeTool, RoadTool } from '../js/tools.js';

const starter = (seed = 3) => new Game({ seed, biome: 'meadow', res: 96, starter: true });

// Each section runs on its own, so one failure does not hide the others; any failure fails the file.
const failures = [];
async function section(name, fn) {
  try {
    await fn();
  } catch (e) {
    failures.push(name);
    console.log(`FAIL ${name}\n  ${String(e.stack || e).split('\n').slice(0, 4).join('\n  ')}`);
  }
}
// ---- 1. lane changes reach every driver (they used to be limited to ids ending in 0 or 5)
await section('1. lane changes reach every driver (they used to be limited to ids ending in 0 or 5)', async () => {
  const w = makeWorld();
  road(w.planner, free(-300, 0), free(300, 0), { cls: 'avenue', lf: 2, lb: 2 });
  road(w.planner, free(0, -250), free(0, 250), { cls: 'avenue', lf: 2, lb: 2 });
  const changes = new Array(10).fill(0);
  const seen = new Map();
  const rng = new Rng(11);
  const pts = accessPoints(w.net);
  let acc = 0;
  for (let i = 0; i < Math.round(300 / DT); i++) {
    acc += 1.2 * DT;
    while (acc >= 1) {
      acc -= 1;
      const from = rng.pick(pts);
      const to = rng.pick(pts);
      if (from !== to) w.sim.spawn({ from, to });
    }
    w.sim.step(DT);
    for (const v of w.sim.vehicles) {
      if (!v.lane) continue;
      const p = seen.get(v.id);
      if (p && p.dir === v.lane.dir && p.j !== v.lane.j) changes[v.id % 10]++;
      seen.set(v.id, { dir: v.lane.dir, j: v.lane.j });
    }
  }
  assert.ok(changes.filter((c) => c > 0).length >= 8, `drivers of every kind change lanes: ${changes.join(' ')}`);
});

// ---- 2. a roundabout can be put over the middle of a straight road piece, and its refund is not paid twice
await section('2. a roundabout can be put over the middle of a straight road piece, and its refund is not paid twice', async () => {
  const w = makeWorld();
  road(w.planner, free(-60, 0), free(60, 0));
  const e = [...w.net.edges.values()][0];
  assert.equal(e.poly.n, 2, 'a straight piece has two vertices');
  assert.deepEqual(w.planner.circleCrossings(e.poly, 0, 0, 20).map(Math.round), [40, 80]);
  assert.deepEqual(w.planner.circleCrossings(e.poly, 0, 45, 20), [], 'a circle clear of the road has no crossings');
  assert.equal(w.planner.circleCrossings(e.poly, 0, 19.99999, 20).length <= 2, true);
  for (const R of [14, 20, 28]) {
    const plan = w.planner.planRoundabout({ x: 0, y: 0, R, lanes: 1, cls: 'street' });
    assert.ok(plan.ok, `R ${R}: ${plan.error}`);
    assert.equal(plan.arms.length, 2, 'both sides of the road become arms');
  }
  // two streets crossing at the centre: paying for the ring must not create money
  const w2 = makeWorld();
  road(w2.planner, free(-100, 0), free(0, 0));
  road(w2.planner, w2.planner.snap(0, 0, 8, {}), free(100, 0));
  let money = 40000;
  const worth = () => money + REFUND * [...w2.net.edges.values()].reduce((s, x) => s + x.value, 0);
  const before = worth();
  const plan = w2.planner.planRoundabout({ x: 0, y: 0, R: 20, lanes: 1, cls: 'street' });
  assert.ok(plan.ok, plan.error);
  const ringCost = ROUNDABOUT_BASE_COST + 2 * Math.PI * 20 * CLASSES.street.laneCost;
  money -= plan.cost;
  w2.planner.applyRoundabout(plan);
  assert.ok(Math.abs(worth() - before + 0.5 * ringCost) < 2, `building a ring only costs half its price in resale value: ${(worth() - before).toFixed(1)}`);
});

// ---- 3. a destination behind the car on the same road means a real trip, not an instant arrival
await section('3. a destination behind the car on the same road means a real trip, not an instant arrival', async () => {
  const w = makeWorld();
  road(w.planner, free(-100, 0), free(100, 0));
  const d = [...w.net.edges.values()][0].dirF;
  const lane = d.lanes[d.lanes.length - 1];
  const at = (s) => {
    const p = lane.poly.pointAt(s);
    return { dir: d, lane, x: p.x, y: p.y };
  };
  let arrived = null;
  w.sim.onArrive = (v, t) => (arrived = { t, metres: v.dist });
  const r = w.sim.spawn({ from: at(60), to: { ...at(20), j: d.lanes.length - 1 } });
  assert.ok(r.vehicle, 'the trip starts: ' + r.fail);
  assert.ok(r.vehicle.route.length > 1, 'it has to come back round');
  for (let i = 0; i < 4; i++) w.sim.step(DT);
  assert.equal(arrived, null, 'it does not arrive after 0.2 s');
  for (let i = 0; i < 20 * 120 && !arrived; i++) w.sim.step(DT);
  assert.ok(arrived && arrived.metres > 150, 'it drives the loop and arrives: ' + JSON.stringify(arrived));
});

// ---- 4. branching a street off a busy road carries its traffic over instead of deleting it
await section('4. branching a street off a busy road carries its traffic over instead of deleting it', async () => {
  const w = makeWorld();
  road(w.planner, free(-300, 0), free(300, 0));
  const east = accessPoints(w.net).filter((p) => p.dir.fwd);
  const west = accessPoints(w.net).filter((p) => !p.dir.fwd);
  run(w, { seconds: 60, rate: 0.5, pairs: [[east[0], east[east.length - 1]], [west[west.length - 1], west[0]]] });
  const busiest = [...w.net.edges.values()].reduce((a, b) => (count(b) > count(a) ? b : a));
  function count(e) {
    let n = 0;
    for (const d of [e.dirF, e.dirB]) if (d) for (const l of d.lanes) n += l.vehicles.length;
    return n;
  }
  assert.ok(w.sim.vehicles.length >= 8, 'the road is busy');
  const mid = busiest.poly.pointAt(busiest.len / 2);
  const plan = w.planner.planRoad({ a: w.planner.snap(mid.x, mid.y, 6, {}), b: free(mid.x, mid.y + 60), cls: 'street', lf: 1, lb: 1 });
  assert.ok(plan.ok, plan.error);
  const alive = w.sim.vehicles.filter((v) => !v.dead);
  const removed0 = w.sim.stats.removed;
  w.planner.applyRoad(plan);
  const killed = w.sim.stats.removed - removed0;
  assert.ok(killed <= Math.max(2, Math.ceil(alive.length * 0.15)), `only cars inside the new junction are lost: ${killed} of ${alive.length}`);
  for (const v of w.sim.vehicles) {
    if (v.dead) continue;
    const c = v.conn || v.lane;
    assert.ok(c.alive && c.vehicles.includes(v), 'every vehicle stands on a live road');
    assert.equal(v.route[v.ri], v.conn ? v.conn.from.dir : v.lane.dir, 'its route follows the pieces it is on');
    assert.equal(v.route[v.route.length - 1], v.dest.dir, 'and still ends at its destination');
    assert.ok(v.dest.dir.alive);
  }
  assert.equal(overlaps(w.sim).length, 0, 'migrating does not stack cars on top of each other');
  const survivors = alive.filter((v) => !v.dead);
  for (let i = 0; i < 20 * 200; i++) w.sim.step(DT);
  assert.ok(survivors.every((v) => v.dead), 'every car that was carried over finishes its trip');
  assert.equal(w.sim.stats.removed - removed0, killed, 'and none of them is removed as stuck');
});

// ---- 4b. stress: many branches off busy multi-lane roads; nothing breaks and every carried-over car still arrives
await section('4b. repeated branching off busy roads keeps routes, lanes and flow consistent', async () => {
  const w = makeWorld();
  const reasons = {};
  w.sim.onRemove = (v, why) => (reasons[why] = (reasons[why] || 0) + 1);
  road(w.planner, free(-400, -80), free(400, -80), { cls: 'avenue', lf: 2, lb: 2 });
  road(w.planner, free(-400, 120), free(400, 120), { cls: 'avenue', lf: 2, lb: 2 });
  road(w.planner, free(-150, -300), free(-150, 300), { cls: 'street', lf: 1, lb: 1 });
  road(w.planner, free(130, -300), free(130, 300), { cls: 'street', lf: 1, lb: 1 });
  const rng = new Rng(77);
  let splits = 0;
  const consistent = () => {
    for (const v of w.sim.vehicles) {
      if (v.dead) continue;
      const c = v.conn || v.lane;
      assert.ok(c && c.alive && c.vehicles.includes(v), `vehicle ${v.id} stands on a live container`);
      assert.equal(v.route[v.ri], v.conn ? v.conn.from.dir : v.lane.dir, `vehicle ${v.id}: route follows the road it is on`);
      assert.equal(v.route[v.route.length - 1], v.dest.dir, `vehicle ${v.id}: route ends at its destination`);
      assert.ok(v.s >= -0.001 && v.s <= c.len + 1.5, `vehicle ${v.id} is inside its lane`);
    }
    for (const e of w.net.edges.values()) {
      for (const d of [e.dirF, e.dirB]) {
        if (!d) continue;
        for (const l of d.lanes) for (let i = 1; i < l.vehicles.length; i++) assert.ok(l.vehicles[i].s >= l.vehicles[i - 1].s, 'lane arrays stay sorted');
      }
    }
    assert.equal(overlaps(w.sim).length, 0, 'no two cars on top of each other');
  };
  for (let round = 0; round < 28; round++) {
    run(w, { seconds: 12, rate: 1.0, seed: 100 + round });
    const edges = [...w.net.edges.values()].filter((e) => e.len > 70 && e.ring == null && !e.invalid);
    // prefer edges that carry cars right now
    const busy = edges.filter((e) => [e.dirF, e.dirB].some((d) => d && d.lanes.some((l) => l.vehicles.length)));
    const e = rng.pick(busy.length ? busy : edges);
    const m = e.poly.pointAt(e.len * rng.range(0.25, 0.75));
    const sign = rng.chance(0.5) ? 1 : -1;
    const len = rng.range(45, 90);
    const cls = rng.pick(['street', 'avenue']);
    const n = cls === 'street' ? 1 : 2;
    const plan = w.planner.planRoad({ a: w.planner.snap(m.x, m.y, 6, {}), b: free(m.x + m.ty * len * sign, m.y - m.tx * len * sign), cls, lf: n, lb: rng.chance(0.2) ? 0 : n });
    if (!plan.ok) continue;
    w.planner.applyRoad(plan);
    splits++;
    consistent();
  }
  assert.ok(splits >= 12, `enough branches were built to mean something: ${splits}`);
  // stop spawning and let everything finish
  const before = w.sim.vehicles.length;
  const arrived0 = w.sim.stats.arrived;
  for (let i = 0; i < 20 * 400; i++) w.sim.step(DT);
  consistent();
  assert.equal(w.sim.vehicles.length, 0, `every car finishes its trip (${w.sim.vehicles.length} left of ${before})`);
  assert.ok(w.sim.stats.arrived - arrived0 >= before - 2, 'and they arrive rather than being removed');
  for (const why of ['stuck', 'noroute', 'gone', 'noexit']) assert.ok(!reasons[why], `no car is removed as "${why}": ${JSON.stringify(reasons)}`);
  assert.ok((reasons.lost || 0) <= 2, `at most a couple of drivers get lost on the awkward short stretches: ${JSON.stringify(reasons)}`);
  assert.ok((reasons.road_removed || 0) + (reasons.junction_rebuilt || 0) <= splits * 3, `few cars are lost to the edits themselves: ${JSON.stringify(reasons)} over ${splits} branches`);
});

// ---- 5. a stale building (from before an undo) can no longer be "picked up" for a free copy
await section('5. a stale building (from before an undo) can no longer be "picked up" for a free copy', async () => {
  const g = starter();
  const stale = g.city.list[0];
  g.pushUndo();
  g.placeBuilding(g.city.findPlacement('house', 40, 22, 40));
  assert.ok(g.undo());
  assert.equal(g.city.has(stale), false, 'the old object is no longer part of the city');
  const tray = { ...g.city.tray };
  const n = g.city.list.length;
  const depth = g.undoStack.length;
  assert.equal(g.removeBuilding(stale).ok, false);
  assert.deepEqual(g.city.tray, tray, 'nothing is added to the tray');
  assert.equal(g.city.list.length, n);
  assert.equal(g.city.buildings.size, n, 'the building table stays in step with the list');
  assert.equal(g.undoStack.length, depth, 'and no undo step is wasted');
});

// ---- 6. unroutable trips only blame the home end; unroutable-because-behind blames nobody
await section('6. unroutable trips only blame the home end; unroutable-because-behind blames nobody', async () => {
  const g = starter();
  const house = g.city.list.find((b) => b.type === 'house');
  const shop = g.city.list.find((b) => b.type !== 'house' && b.acc);
  g.sim.spawn = () => ({ fail: 'noroute' });
  const out = { from: house, to: shop, ret: false, truck: false, born: 0 };
  assert.equal(g.city.startTrip(out), 'drop');
  assert.equal(house.fails, 1);
  assert.equal(shop.fails, 0, 'the destination is not blamed');
  g.city.startTrip({ from: shop, to: house, ret: true, truck: false, born: 0 });
  assert.equal(house.fails, 2, 'a failed trip home blames the home');
  assert.equal(shop.fails, 0);
  g.sim.spawn = () => ({ fail: 'behind' });
  assert.equal(g.city.startTrip(out), 'drop');
  assert.equal(house.fails, 2, 'no loop available is nobody\'s fault');
});

// ---- 7. traffic lights: custom phases survive save/load and nearby road works; new movements get their own phase
await section('7. traffic lights: custom phases survive save/load and nearby road works; new movements get their own phase', async () => {
  const g = starter(5);
  const jn = [...g.net.nodes.values()].find((n) => n.edges.length === 4);
  g.toggleSignal(jn);
  const sig = jn.signal;
  assert.ok(splitMovement(sig, [...sig.phases[0].moves][0]).ok);
  assert.equal(sig.custom, true);
  const groups = (s) => s.phases.map((p) => [...p.moves].sort().join(','));
  const shape = groups(sig);
  const served = (s) => new Set(s.phases.flatMap((p) => [...p.moves]));
  // save and load
  const g2 = Game.fromSave(JSON.parse(JSON.stringify(g.serialize())));
  const sig2 = g2.net.nodes.get(jn.id).signal;
  assert.deepEqual(groups(sig2), shape, 'the grouping survives a save');
  assert.equal(sig2.custom, true);
  // undo
  g.pushUndo();
  sig.phases[0].dur = 33;
  g.undo();
  assert.deepEqual(groups(g.net.nodes.get(jn.id).signal), shape, 'and an undo');
  // building a side street off one of the approaches splits that road: the movements are renamed, not lost
  const g3 = Game.fromSave(JSON.parse(JSON.stringify(g.serialize())));
  const s3 = g3.net.nodes.get(jn.id).signal;
  const sizes = s3.phases.map((p) => p.moves.size);
  const arm = jn.edges.map((e) => g3.net.edges.get(e.id)).find((e) => e && e.len > 80);
  const m = arm.poly.pointAt(arm.len / 2);
  const side = g3.planner.planRoad({ a: g3.planner.snap(m.x, m.y, 6, {}), b: free(m.x + m.ty * 70, m.y - m.tx * 70), cls: 'street', lf: 1, lb: 1 });
  assert.ok(side.ok, side.error);
  g3.buildRoad(side);
  const jn3 = g3.net.nodes.get(jn.id);
  assert.equal(jn3.signal.custom, true);
  assert.deepEqual(jn3.signal.phases.map((p) => p.moves.size), sizes, 'same grouping after the arm was split');
  assert.equal(served(jn3.signal).size, new Set(jn3.conns.map((c) => c.moveKey)).size, 'every movement still gets a green');
  // a road added at the junction itself: its movements share one extra phase
  const g4 = Game.fromSave(JSON.parse(JSON.stringify(g.serialize())));
  const jn4 = g4.net.nodes.get(jn.id);
  const extra = g4.planner.planRoad({ a: { kind: 'node', node: jn4, x: jn4.x, y: jn4.y, z: 0 }, b: free(jn4.x + 90, jn4.y + 90), cls: 'street', lf: 1, lb: 1 });
  if (extra.ok) {
    g4.buildRoad(extra);
    assert.equal(jn4.signal.phases.length, shape.length + 1, 'new movements wait in a phase of their own');
    assert.equal(served(jn4.signal).size, new Set(jn4.conns.map((c) => c.moveKey)).size);
  }
  // protected lefts start again from the defaults
  sig.setProtectedLefts(true);
  assert.equal(sig.custom, false);
});

// ---- 8. tools and input with a stub app (no DOM)
globalThis.document = Object.assign(new EventTarget(), { hidden: false });
const { Input } = await import('../js/input.js');
const noop = () => {};

function fixture() {
  globalThis.window = new EventTarget();
  const state = { tip: false, cleared: 0, zoom: [], paused: 0 };
  const g = starter(9);
  const app = {
    game: g,
    theme: THEMES.light,
    opts: { laneMode: 'add', cls: 'street', lanes: { street: 1, avenue: 2, highway: 3 }, oneWay: false, elev: 0, straight: false, ringSize: 'M' },
    overlay: new Proxy({}, { get: (t, k) => (k === 'clear' ? () => state.cleared++ : noop) }),
    view: { ppm: 2, screenToWorld: (x, y) => ({ x, y }), panPixels: noop, zoomAt: (x, y, k) => state.zoom.push(k) },
    tip: () => (state.tip = true),
    hideTip: () => (state.tip = false),
    beep: noop,
    toast: noop,
    hint: noop,
    ui: { updateTray: noop, updateToolState: noop, openSignalEditor: noop, hideInfoOnMapPress: noop },
    ghostSeed: 5,
    tools: {},
    tool: null,
    pointerType: 'mouse',
    setTool(id) {
      this.tool?.cancel();
      this.tool = this.tools[id] || this.tools.road;
    },
    interactive: () => true,
    audioUnlock: noop,
    cancelFocus: noop,
    togglePause: () => state.paused++,
  };
  app.tools = { build: new BuildTool(app), lane: new LaneTool(app), bulldoze: new BulldozeTool(app), road: new RoadTool(app) };
  const canvas = Object.assign(new EventTarget(), { getBoundingClientRect: () => ({ left: 0, top: 0 }), setPointerCapture: noop, releasePointerCapture: noop });
  const input = new Input(app, canvas);
  const fire = (type, id, kind, x, y, extra = {}) => canvas.dispatchEvent(Object.assign(new Event(type), { pointerId: id, pointerType: kind, clientX: x, clientY: y, button: 0, shiftKey: false, ctrlKey: false, metaKey: false, ...extra }));
  const key = (type, k) => window.dispatchEvent(Object.assign(new Event(type), { key: k, ctrlKey: false, metaKey: false, repeat: false }));
  const freeSpot = () => {
    for (let y = -80; y <= 80; y += 4) for (let x = -120; x <= 120; x += 4) if (g.city.findPlacement('house', x, y).ok) return { x, y };
    throw new Error('no room for a house');
  };
  return { g, app, state, input, fire, key, freeSpot };
}

await section('8a. build tool: the ghost goes with the finger, a mouse keeps hovering, the last building leaves no ghost', async () => {
  const { g, app, state, fire, freeSpot } = fixture();
  app.setTool('build');
  app.tools.build.set('house');
  const houses = g.city.list.length;
  let spot = freeSpot();
  fire('pointerdown', 1, 'touch', spot.x, spot.y - 31); // the ghost floats 31 m (62 px) above the fingertip
  assert.equal(state.tip, true, 'the ghost and its tip show while the finger is down');
  fire('pointerup', 1, 'touch', spot.x, spot.y - 31);
  assert.equal(g.city.list.length, houses + 1, 'the house was placed');
  assert.equal(state.tip, false, 'no stale tip once the finger is lifted');
  assert.equal(app.tools.build.lastPt, null);
  spot = freeSpot();
  fire('pointermove', 7, 'mouse', spot.x, spot.y);
  assert.equal(state.tip, true, 'hovering shows the ghost');
  fire('pointerleave', 7, 'mouse', spot.x, spot.y);
  assert.equal(state.tip, false, 'leaving the map clears it');
  fire('pointermove', 7, 'mouse', spot.x, spot.y);
  fire('pointerdown', 7, 'mouse', spot.x, spot.y);
  fire('pointerup', 7, 'mouse', spot.x, spot.y);
  assert.equal(g.city.list.length, houses + 2);
  assert.equal(state.tip, true, 'a mouse keeps its preview after clicking');
  g.city.tray.house = 1;
  spot = freeSpot();
  fire('pointermove', 7, 'mouse', spot.x, spot.y);
  fire('pointerdown', 7, 'mouse', spot.x, spot.y);
  fire('pointerup', 7, 'mouse', spot.x, spot.y);
  assert.notEqual(app.tool, app.tools.build, 'it hands over to another tool after the last one');
  assert.equal(state.tip, false, 'without a ghost left behind');
});

await section('8b. lane tool: a tap adds a lane and leaves no preview; a second finger drops the preview', async () => {
  const { g, app, state, fire } = fixture();
  app.setTool('lane');
  const e = [...g.net.edges.values()].find((x) => x.len > 60);
  const p = e.poly.pointAt(e.len * 0.5);
  const sideX = p.x - p.ty * 4.2;
  const sideY = p.y + p.tx * 4.2;
  const lanes = () => [e.dirF, e.dirB].reduce((s, d) => s + (d && d.alive ? d.lanes.length : 0), 0);
  const before = lanes();
  fire('pointerdown', 1, 'touch', sideX, sideY);
  assert.equal(state.tip, true);
  fire('pointerup', 1, 'touch', sideX, sideY);
  assert.equal(lanes(), before + 1, 'a lane was added');
  assert.equal(state.tip, false, 'the preview is gone with the finger');
  fire('pointerdown', 1, 'touch', sideX, sideY);
  assert.equal(state.tip, true);
  fire('pointerdown', 2, 'touch', sideX + 100, sideY);
  assert.equal(state.tip, false, 'the preview does not freeze under a pinch');
});

await section('8c. pinch: lifting one of three fingers re-bases the gesture instead of jumping the zoom', async () => {
  const { app, state, input, fire } = fixture();
  app.setTool('road');
  fire('pointerdown', 1, 'touch', 100, 300);
  fire('pointerdown', 2, 'touch', 200, 300);
  fire('pointerdown', 3, 'touch', 400, 300);
  fire('pointerup', 1, 'touch', 100, 300);
  state.zoom.length = 0;
  fire('pointermove', 3, 'touch', 401, 300);
  assert.ok(state.zoom.length === 1 && Math.abs(state.zoom[0] - 1) < 0.1, `no zoom jump when the tracked pair changes: ${state.zoom}`);
  fire('pointerup', 2, 'touch', 200, 300);
  fire('pointerup', 3, 'touch', 401, 300);
  assert.equal(input.mode, null);
});

await section('8d. a held Space does not stay held after the window loses focus', async () => {
  const { input, key } = fixture();
  key('keydown', ' ');
  assert.equal(input.space, true);
  window.dispatchEvent(new Event('blur'));
  assert.equal(input.space, false);
});

await section('8e. remove tool with the mouse: pressing on nothing takes no undo step, a real removal takes one', async () => {
  const { g, app, fire } = fixture();
  app.setTool('bulldoze');
  const depth = g.undoStack.length;
  fire('pointerdown', 7, 'mouse', 5000, 5000);
  fire('pointerup', 7, 'mouse', 5000, 5000);
  assert.equal(g.undoStack.length, depth, 'empty clicks leave the undo history alone');
  const b = g.city.list[0];
  const n = g.city.list.length;
  fire('pointerdown', 7, 'mouse', b.x, b.y);
  fire('pointermove', 7, 'mouse', b.x + 1, b.y);
  fire('pointerup', 7, 'mouse', b.x + 1, b.y);
  assert.equal(g.city.list.length, n - 1, 'the building was removed');
  assert.equal(g.undoStack.length, depth + 1, 'as one undo step');
});

await section('8f. the road tool keeps its anchor when the mouse leaves the map', async () => {
  const { app, state, fire } = fixture();
  app.setTool('road');
  fire('pointerdown', 7, 'mouse', 10, 10);
  fire('pointerup', 7, 'mouse', 10, 10);
  assert.ok(app.tools.road.pen, 'a click sets the anchor');
  fire('pointermove', 7, 'mouse', 60, 10);
  assert.equal(state.tip, true);
  fire('pointerleave', 7, 'mouse', 60, 10);
  assert.equal(state.tip, false, 'the preview goes');
  assert.ok(app.tools.road.pen, 'the anchor stays');
});

// ---- 9. a junction on a curved road (a ring) meets the trimmed road exactly and does not pave the inside of the bend
await section('9. a junction on a curved road meets the trimmed road and does not pave the inside of the bend', async () => {
  const arc = (a0, a1) => new Poly(Array.from({ length: 41 }, (_, i) => ({ x: -40 + Math.cos(a0 + ((a1 - a0) * i) / 40) * 40, y: Math.sin(a0 + ((a1 - a0) * i) / 40) * 40 })));
  const opts = { lf: 1, lb: 1, cls: 'street' };
  for (const deg of [8, 20, 45]) {
    const net = new Network();
    const c = net.addNode(0, 0);
    const up = net.addNode(-40 + Math.cos(2) * 40, Math.sin(2) * 40);
    const dn = net.addNode(-40 + Math.cos(-2) * 40, Math.sin(-2) * 40);
    net.addEdge(c, up, arc(0, 2), opts);
    net.addEdge(dn, c, arc(-2, 0), opts);
    // a side road leaving at a shallow angle to the ring forces a long setback on the curved arm
    const a = Math.PI / 2 - (deg * Math.PI) / 180;
    const far = net.addNode(Math.cos(a) * 100, Math.sin(a) * 100);
    net.addEdge(c, far, new Poly([{ x: 0, y: 0 }, { x: far.x, y: far.y }]), opts);
    net.rebuild();
    const P = c.fill.pts;
    for (const e of c.edges) {
      const p = e.poly.pointAt(e.a === c ? e.setA : e.len - e.setB);
      for (const sg of [1, -1]) {
        const q = { x: p.x + p.ty * e.halfWidth * sg, y: p.y - p.tx * e.halfWidth * sg };
        const d = Math.min(...P.map((v) => Math.hypot(v.x - q.x, v.y - q.y)));
        assert.ok(d < 0.01, `${deg}°: the junction patch reaches the kerb of edge ${e.id} where it is trimmed (${d.toFixed(2)} m off)`);
      }
    }
    // a point inside the bend, well clear of the ring's inner kerb, must stay grass
    const g = { x: -12, y: 0 };
    const tri = buildNodeParts(c, THEMES.light).fill.p;
    const side = (ax, ay, bx, by) => (bx - ax) * (g.y - ay) - (by - ay) * (g.x - ax);
    for (let i = 0; i < tri.length; i += 9) {
      const [ax, ay, , bx, by, , cx, cy] = tri.slice(i, i + 9);
      const s1 = side(ax, ay, bx, by);
      const s2 = side(bx, by, cx, cy);
      const s3 = side(cx, cy, ax, ay);
      assert.ok(!((s1 > 0 && s2 > 0 && s3 > 0) || (s1 < 0 && s2 < 0 && s3 < 0)), `${deg}°: the junction patch paves the inside of the ring`);
    }
  }
});

await section('9b. a branch that leaves a straight road almost parallel and bends away hard stays attached', async () => {
  const opts = { lf: 1, lb: 1, cls: 'street' };
  for (const [deg, R] of [[15, 30], [25, 20]]) {
    const net = new Network();
    const m = (40 * Math.PI) / 180;
    const c = net.addNode(0, 0);
    const ur = net.addNode(Math.cos(m) * 70, Math.sin(m) * 70);
    const ll = net.addNode(-Math.cos(m) * 70, -Math.sin(m) * 70);
    net.addEdge(c, ur, new Poly([{ x: 0, y: 0 }, { x: ur.x, y: ur.y }]), opts);
    net.addEdge(ll, c, new Poly([{ x: ll.x, y: ll.y }, { x: 0, y: 0 }]), opts);
    // the branch starts deg below the main road and turns clockwise through 150 degrees
    const h0 = m - (deg * Math.PI) / 180;
    const ox = Math.cos(h0 - Math.PI / 2) * R;
    const oy = Math.sin(h0 - Math.PI / 2) * R;
    const pts = Array.from({ length: 61 }, (_, i) => {
      const a = h0 + Math.PI / 2 - (i / 60) * ((150 * Math.PI) / 180);
      return { x: ox + Math.cos(a) * R, y: oy + Math.sin(a) * R };
    });
    const end = net.addNode(pts[60].x, pts[60].y);
    const br = net.addEdge(c, end, new Poly(pts), opts);
    net.rebuild();
    assert.ok(br.setA > 15, `${deg}°: the branch gets a long setback (${br.setA.toFixed(1)} m)`);
    const p = br.poly.pointAt(br.setA);
    for (const sg of [1, -1]) {
      const q = { x: p.x + p.ty * br.halfWidth * sg, y: p.y - p.tx * br.halfWidth * sg };
      const d = Math.min(...c.fill.pts.map((v) => Math.hypot(v.x - q.x, v.y - q.y)));
      assert.ok(d < 0.01, `${deg}°: the junction patch reaches the branch's kerb where it is trimmed (${d.toFixed(2)} m off)`);
    }
  }
});

if (failures.length) throw new Error(`regression tests failed: ${failures.join('; ')}`);
console.log('regression tests passed');
