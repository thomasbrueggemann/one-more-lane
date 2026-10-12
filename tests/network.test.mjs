import assert from 'node:assert/strict';
import { Poly } from '../js/geom.js';
import { Network, LANE_W } from '../js/network.js';

const line = (x0, y0, x1, y1) => new Poly([{ x: x0, y: y0 }, { x: x1, y: y1 }]);
const close = (a, b, eps, msg) => assert.ok(Math.abs(a - b) < eps, `${msg} expected ${b}, got ${a}`);

/** A 4-way crossing of two 1+1 streets, 200 m each. */
function cross() {
  const net = new Network();
  const c = net.addNode(0, 0);
  const n = net.addNode(0, 100);
  const s = net.addNode(0, -100);
  const e = net.addNode(100, 0);
  const w = net.addNode(-100, 0);
  const opts = { lf: 1, lb: 1, cls: 'street' };
  net.addEdge(c, n, line(0, 0, 0, 100), opts);
  net.addEdge(s, c, line(0, -100, 0, 0), opts);
  net.addEdge(c, e, line(0, 0, 100, 0), opts);
  net.addEdge(w, c, line(-100, 0, 0, 0), opts);
  net.rebuild();
  return { net, c, n, s, e, w };
}

// --- 4-way crossing
{
  const { net, c } = cross();
  assert.equal(c.edges.length, 4);
  assert.equal(c.ends.length, 4);
  // setbacks: half width (3.4) + fillet tangent (5.2) for perpendicular equal roads
  for (const e of c.edges) {
    const sb = e.a === c ? e.setA : e.setB;
    close(sb, 3.4 + 5.2, 0.05, 'setback');
  }
  // polygon should be closed, CCW and non-degenerate
  assert.ok(c.fill && c.fill.pts.length >= 8, 'fill polygon exists');
  let area = 0;
  const p = c.fill.pts;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    area += p[i].x * q.y - q.x * p[i].y;
  }
  assert.ok(area > 0, 'polygon is CCW');
  // plus-shaped union (2*17.2*6.8 - 6.8^2 = 187.7) plus four fillet patches (~5.8 each)
  assert.ok(area / 2 > 195 && area / 2 < 225, `polygon area plausible (${area / 2})`);

  // each arriving dir has 1 lane and 3 movements (L,S,R), no u-turns
  let ins = 0;
  for (const e of c.edges) {
    const d = e.dirTo(c);
    assert.ok(d, 'arriving dir exists');
    ins++;
    assert.equal(d.moves.size, 3, 'three movements per approach');
    assert.equal(d.lanes[0].outConns.length, 3);
    const types = d.lanes[0].outConns.map((cn) => cn.turn).sort().join('');
    assert.equal(types, 'LRS');
  }
  assert.equal(ins, 4);
  assert.equal(c.conns.length, 12);

  // lane geometry: lane 0 of the forward dir of the north edge is right of the median -> x>0 heading +y
  const north = [...c.edges].find((e) => e.b.y === 100);
  const lf = north.dirF.lanes[0];
  const st = lf.poly.pointAt(0);
  close(st.x, LANE_W / 2, 1e-6, 'forward lane is right of centre');
  close(st.y, north.setA, 1e-6, 'lane trimmed at setback');
  assert.ok(st.ty > 0.99);
  const lb = north.dirB.lanes[0];
  const sb = lb.poly.pointAt(0);
  close(sb.x, -LANE_W / 2, 1e-6, 'backward lane is left of centre');
  assert.ok(sb.ty < -0.99, 'backward lane heads south');

  // conflicts: a left turn conflicts with the opposing straight and with perpendicular movements
  const left = c.conns.find((cn) => cn.turn === 'L');
  assert.ok(left.conflicts.length >= 4, 'left turn has conflicts');
  const opposing = left.conflicts.filter((k) => k.other.turn === 'S' && k.rel === 1);
  assert.ok(opposing.length >= 1, 'left yields to opposing straight');
}

// --- T junction with a wider main road: setbacks differ
{
  const net = new Network();
  const c = net.addNode(0, 0);
  const a = net.addNode(-100, 0);
  const b = net.addNode(100, 0);
  const d = net.addNode(0, 100);
  net.addEdge(a, c, line(-100, 0, 0, 0), { lf: 2, lb: 2, cls: 'avenue' });
  net.addEdge(c, b, line(0, 0, 100, 0), { lf: 2, lb: 2, cls: 'avenue' });
  net.addEdge(c, d, line(0, 0, 0, 100), { lf: 1, lb: 1, cls: 'street' });
  net.rebuild();
  const stem = c.edges.find((e) => e.b === d);
  const main = c.edges.find((e) => e.b === b);
  close(stem.setA, 6.8 + 5.2, 0.1, 'stem setback = main half width + fillet');
  close(main.setA, 3.4 + 5.2, 0.1, 'main arm setback = stem half width + fillet');
  // the avenue has 2 lanes per direction -> straight keeps both lanes
  const west = c.edges.find((e) => e.a.x === -100);
  const din = west.dirTo(c);
  const straight = din.lanes.flatMap((l) => l.outConns).filter((cn) => cn.turn === 'S');
  assert.equal(straight.length, 2);
}

// --- dead end gets a u-turn
{
  const net = new Network();
  const a = net.addNode(0, 0);
  const b = net.addNode(80, 0);
  net.addEdge(a, b, line(0, 0, 80, 0), { lf: 1, lb: 1, cls: 'street' });
  net.rebuild();
  assert.equal(b.conns.length, 1);
  assert.equal(b.conns[0].turn, 'U');
  assert.ok(b.fill, 'bulb polygon at dead end');
}

// --- splitting an edge keeps lanes and connects through
{
  const net = new Network();
  const a = net.addNode(0, 0);
  const b = net.addNode(100, 0);
  const e = net.addEdge(a, b, line(0, 0, 100, 0), { lf: 2, lb: 1, cls: 'avenue' });
  net.rebuild();
  const { node } = net.splitEdge(e, 40);
  net.rebuild();
  assert.equal(node.edges.length, 2);
  assert.equal(net.edges.size, 2);
  // straight continuation: no setback, connections for forward (2 lanes) and backward (1 lane)
  assert.equal(node.conns.length, 3);
  const e1 = node.edges.find((x) => x.b === node);
  close(e1.setB, 0, 0.5, 'straight pass-through has ~no setback');
}

// --- serialise round trip
{
  const { net } = cross();
  const json = JSON.parse(JSON.stringify(net.toJSON()));
  const net2 = new Network();
  net2.loadJSON(json);
  assert.equal(net2.nodes.size, net.nodes.size);
  assert.equal(net2.edges.size, net.edges.size);
  const total = [...net2.nodes.values()].reduce((s, n) => s + n.conns.length, 0);
  const total1 = [...net.nodes.values()].reduce((s, n) => s + n.conns.length, 0);
  assert.equal(total, total1);
}

console.log('network tests passed');
