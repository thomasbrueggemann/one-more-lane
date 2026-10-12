import assert from 'node:assert/strict';
import { Poly, arcPoly, polyIntersections, makeRect, rectsOverlap, segTouchesRect, cubicPoly } from '../js/geom.js';

const close = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) < eps, `${msg} expected ${b}, got ${a}`);

// --- Poly basics
const p = new Poly([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]);
close(p.len, 20, 1e-9, 'len');
let o = p.pointAt(5);
close(o.x, 5); close(o.y, 0); close(o.tx, 1); close(o.ty, 0);
o = p.pointAt(15);
close(o.x, 10); close(o.y, 5); close(o.tx, 0); close(o.ty, 1);

// closest + side
const c = p.closest(5, 3);
close(c.s, 5); close(c.d, 3); assert.equal(c.side, 1, 'point above a +x line is on the left');
assert.equal(p.closest(5, -3).side, -1);

// slice
const sl = p.slice(5, 15);
close(sl.len, 10); close(sl.xs[0], 5); close(sl.xs[sl.n - 1], 10); close(sl.ys[sl.n - 1], 5);

// offset: right of +x travel is -y
const off = new Poly([{ x: 0, y: 0 }, { x: 10, y: 0 }]).offset(2);
close(off.ys[0], -2); close(off.ys[1], -2);
// a left bend: the right side is the outside, so the mitred corner moves to (11,-1)
const bend = new Poly([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }]).offset(1);
close(bend.xs[1], 11); close(bend.ys[1], -1);

// reverse
const rv = p.reverse();
close(rv.xs[0], 10); close(rv.ys[0], 10); close(rv.len, 20);

// --- arc: leaves along T and ends exactly at E
const a = arcPoly(0, 0, 1, 0, 20, 10);
assert.equal(a.kind, 'arc');
const end = a.poly.pointAt(a.poly.len);
close(end.x, 20, 1e-6); close(end.y, 10, 1e-6);
const st = a.poly.pointAt(0);
assert.ok(st.tx > 0.99, 'starts along tangent');
// constant radius check
const cx = 0 - 0 * 1; // centre for left turn: (0, R)
const R = a.R;
for (let i = 0; i < a.poly.n; i++) close(Math.hypot(a.poly.xs[i] - 0, a.poly.ys[i] - R), R, 1e-6, 'radius');
// end tangent is perpendicular to radius
close(a.endTx * (a.poly.xs[a.poly.n - 1]) + a.endTy * (a.poly.ys[a.poly.n - 1] - R), 0, 1e-6, 'end tangent');
// right turn
const b = arcPoly(0, 0, 1, 0, 20, -10);
const bs = b.poly.pointAt(b.poly.len);
close(bs.y, -10);
assert.ok(b.endTy < 0, 'right turn heads down');
// straight
assert.equal(arcPoly(0, 0, 1, 0, 30, 0).kind, 'line');
// target behind -> null if too sharp
assert.equal(arcPoly(0, 0, 1, 0, -20, 1), null);

// --- intersections
const A = new Poly([{ x: 0, y: 0 }, { x: 20, y: 0 }]);
const B = new Poly([{ x: 10, y: -5 }, { x: 10, y: 5 }]);
const hits = polyIntersections(A, B);
assert.equal(hits.length, 1);
close(hits[0].sP, 10); close(hits[0].sQ, 5); close(hits[0].cosAngle, 0);

// --- rects
const r1 = makeRect(0, 0, 5, 3, 0);
const r2 = makeRect(9.5, 0, 4, 3, 0);
assert.equal(rectsOverlap(r1, r2, 0), false);
assert.equal(rectsOverlap(r1, r2, 1.5), true);
assert.equal(rectsOverlap(r1, makeRect(8, 0, 4, 3, 0.3), 0), true);
assert.equal(segTouchesRect(-10, 4, 10, 4, r1, 0), false);
assert.equal(segTouchesRect(-10, 4, 10, 4, r1, 1.5), true);

// cubic
const cb = cubicPoly({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 5 }, { x: 10, y: 10 });
close(cb.xs[0], 0); close(cb.xs[cb.n - 1], 10); close(cb.ys[cb.n - 1], 10);

console.log('geom tests passed');
