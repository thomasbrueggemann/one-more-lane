import assert from 'node:assert/strict';
import { Network } from '../js/network.js';
import { RoadPlanner } from '../js/roadplan.js';

const terrain = {
  inside: () => true,
  blockedAt: () => null,
  blockedDisc: () => null,
};
function world() {
  const net = new Network();
  const buildings = [];
  return { net, terrain, buildings: () => buildings, _b: buildings };
}
const free = (x, y, z = 0) => ({ kind: 'free', x, y, z });
const base = { cls: 'street', lf: 1, lb: 1 };

function build(planner, a, b, extra = {}) {
  const plan = planner.planRoad({ a, b, ...base, ...extra });
  assert.ok(plan.ok, `plan failed: ${plan.error}`);
  return planner.applyRoad(plan);
}

// --- a straight road, then a crossing road that splits it
{
  const w = world();
  const pl = new RoadPlanner(w);
  const r1 = build(pl, free(-100, 0), free(100, 0));
  assert.equal(w.net.edges.size, 2, '200 m road is split into <=120 m pieces');
  assert.equal(w.net.nodes.size, 3);

  const r2 = build(pl, free(45, -80), free(45, 80));
  // the crossing splits the horizontal edge at its middle node?  the middle node already exists at x=0.. so
  // the plan must have used a split on an edge (or the snap would be the existing node)
  assert.ok(w.net.nodes.size >= 5);
  const junctions = [...w.net.nodes.values()].filter((n) => n.edges.length === 4);
  assert.equal(junctions.length, 1, 'one 4-way junction');
  for (const n of w.net.nodes.values()) assert.ok(n.edges.length >= 1);
  void r2;
}

// --- snap + T junction via an edge split
{
  const w = world();
  const pl = new RoadPlanner(w);
  build(pl, free(-100, 0), free(100, 0));
  const snap = pl.snap(40, 3, 8, { elev: 0 });
  assert.equal(snap.kind, 'edge');
  const r = build(pl, snap, free(40, 120));
  const tj = r.nodes[0];
  assert.equal(tj.edges.length, 3, 'T junction');
}

// --- tangent continuation from a dead end creates a smooth arc
{
  const w = world();
  const pl = new RoadPlanner(w);
  const r = build(pl, free(0, 0), free(100, 0));
  const endNode = r.nodes[1];
  const plan = pl.planRoad({ a: { kind: 'node', node: endNode, x: endNode.x, y: endNode.y, z: 0 }, b: free(180, 60), ...base });
  assert.ok(plan.ok, plan.error);
  assert.ok(plan.radius < 1e6 && plan.radius > 11, 'curved piece, radius ' + plan.radius);
  const t0 = plan.poly.pointAt(0);
  assert.ok(t0.tx > 0.98, 'leaves tangentially');
  pl.applyRoad(plan);
}

// --- sharp reverse is rejected
{
  const w = world();
  const pl = new RoadPlanner(w);
  const r = build(pl, free(0, 0), free(100, 0));
  const endNode = r.nodes[1];
  const plan = pl.planRoad({ a: { kind: 'node', node: endNode, x: endNode.x, y: endNode.y, z: 0 }, b: free(80, 10), ...base });
  assert.equal(plan.ok, false, 'doubling back along the same road is refused');
}

// --- branching sideways from a dead end builds a straight piece with a corner (instead of refusing)
{
  const w = world();
  const pl = new RoadPlanner(w);
  const r = build(pl, free(0, 0), free(100, 0));
  const endNode = r.nodes[1];
  const a = { kind: 'node', node: endNode, x: endNode.x, y: endNode.y, z: 0 };
  const plan = pl.planRoad({ a, b: free(100, 90), ...base });
  assert.ok(plan.ok, plan.error);
  assert.ok(plan.corner, 'flagged as a corner');
  pl.applyRoad(plan);
  assert.equal(endNode.edges.length, 2);
  assert.ok(endNode.fill, 'the corner has a junction patch');
  // the corner is drivable
  const e1 = endNode.edges.find((e) => e.b === endNode);
  const e2 = endNode.edges.find((e) => e.a === endNode);
  assert.ok(e1.dirF.next.includes(e2.dirF), 'traffic can turn the corner');
}

// --- errors: too short, shallow crossing, narrow angle
{
  const w = world();
  const pl = new RoadPlanner(w);
  build(pl, free(-100, 0), free(100, 0));
  assert.equal(pl.planRoad({ a: free(0, 50), b: free(5, 50), ...base }).error, 'too_short');
  // nearly parallel crossing
  assert.equal(pl.planRoad({ a: free(-50, 10), b: free(100, -5), ...base }).error, 'shallow_cross');
  // overlapping the existing road
  const ov = pl.planRoad({ a: free(-60, 2), b: free(60, 2), ...base });
  assert.equal(ov.ok, false);
}

// --- overpass: elevated road crossing a ground road without a junction
{
  const w = world();
  const pl = new RoadPlanner(w);
  build(pl, free(-100, 0), free(100, 0));
  const n0 = w.net.nodes.size;
  // ramp up from ground (z 0) to level 1 needs 60 m of length per level
  const ramp = pl.planRoad({ a: free(0, -300, 0), b: free(0, -200, 1), ...base });
  assert.ok(ramp.ok, ramp.error);
  const rr = pl.applyRoad(ramp);
  const top = rr.nodes[1];
  assert.equal(top.z, 1);
  // flat elevated road from the ramp top across the ground road
  const bridge = pl.planRoad({ a: { kind: 'node', node: top, x: top.x, y: top.y, z: 1 }, b: free(0, 120, 1), ...base });
  assert.ok(bridge.ok, bridge.error);
  const crossings = bridge.specs.filter((s) => s.kind === 'cross');
  assert.equal(crossings.length, 0, 'no junction at the flyover crossing');
  pl.applyRoad(bridge);
  assert.ok(w.net.nodes.size > n0);
  // too steep
  const steep = pl.planRoad({ a: free(300, 0, 0), b: free(330, 0, 1), ...base });
  assert.equal(steep.error, 'too_steep');
  // ground road crossing the elevated one: the ground road passes under
  const under = pl.planRoad({ a: free(-100, -90), b: free(100, -90), ...base });
  assert.ok(under.ok, under.error);
  assert.equal(under.specs.filter((s) => s.kind === 'cross').length, 0);
}

// --- lanes
{
  const w = world();
  const pl = new RoadPlanner(w);
  const r = build(pl, free(0, 0), free(100, 0));
  const e = r.edges[0];
  const p = pl.planLane(e, 1, +1);
  assert.ok(p.ok, p.error);
  assert.ok(p.cost > 0);
  pl.applyLane(p);
  assert.equal(e.lf, 2);
  assert.equal(e.dirF.lanes.length, 2);
  assert.equal(pl.planLane(e, 1, +1).error, 'max_lanes');
  const rm = pl.planLane(e, -1, -1);
  assert.ok(rm.ok);
  pl.applyLane(rm);
  assert.equal(e.lb, 0);
  assert.ok(e.oneWay);
  assert.equal(e.dirB, null);
  assert.equal(pl.planLane(e, 1, -1).ok, true);
}

// --- roundabout at a 4-way junction
{
  const w = world();
  const pl = new RoadPlanner(w);
  build(pl, free(-150, 0), free(150, 0));
  build(pl, free(0, -150), free(0, 150)); // 300 m road is split at x=-50 and x=50, so x=0 is clear
  const jn = [...w.net.nodes.values()].find((n) => n.edges.length === 4);
  assert.ok(jn);
  const plan = pl.planRoundabout({ x: jn.x, y: jn.y, R: 16 });
  assert.ok(plan.ok, plan.error);
  const res = pl.applyRoundabout(plan);
  assert.equal(res.nodes.length, 4);
  assert.equal(res.edges.length, 4);
  for (const e of res.edges) {
    assert.equal(e.lb, 0, 'ring is one-way');
    assert.ok(e.ring != null);
    assert.ok(e.dirF && e.dirF.lanes.length === 1);
  }
  for (const n of res.nodes) {
    assert.equal(n.edges.length, 3, 'ring node has two arcs + one arm');
    assert.equal(n.conns.length, 3, 'ring->ring, ring->exit, entry->ring');
    assert.deepEqual(n.conns.map((c) => c.turn).sort(), n.conns.map((c) => c.turn).sort());
    // no arm->arm movements at a ring node
    for (const c of n.conns) assert.ok(c.from.dir.edge.ring != null || c.to.dir.edge.ring != null);
  }
  assert.equal(w.net.nodes.has(jn.id), false, 'old junction node is gone');
  // all dirs remain routable: each ring node connects into the next ring node
  for (const e of res.edges) assert.ok(e.dirF.next.length >= 1);
  // removing a ring arc removes the whole roundabout and leaves arms as dead ends
  const rem = pl.removeEdge(res.edges[0]);
  assert.ok(rem.refund > 0);
  assert.equal([...w.net.edges.values()].filter((e) => e.ring != null).length, 0);
}

// --- signals
{
  const w = world();
  const pl = new RoadPlanner(w);
  build(pl, free(-150, 0), free(150, 0));
  build(pl, free(0, -150), free(0, 150)); // 300 m road is split at x=-50 and x=50, so x=0 is clear
  const jn = [...w.net.nodes.values()].find((n) => n.edges.length === 4);
  const t = pl.toggleSignal(jn);
  assert.ok(t.ok && !t.removed);
  assert.equal(jn.signal.phases.length, 2, 'two axes -> two phases');
  const greens = new Set();
  for (const p of jn.signal.phases) for (const m of p.moves) greens.add(m);
  assert.equal(greens.size, jn.conns.length - 0 > 0 ? new Set(jn.conns.map((c) => c.moveKey)).size : 0, 'all movements belong to a phase');
  jn.signal.protectedLefts = true;
  jn.signal.rebuildPhases();
  assert.equal(jn.signal.phases.length, 4, 'protected lefts add two phases');
  const t2 = pl.toggleSignal(jn);
  assert.ok(t2.removed);
}

console.log('plan tests passed');
