// Road geometry generation. Pure data (no three.js): triangle soups with per-vertex RGBA and a kerb "expand" vector.
//
// Every layer is rendered with the same flat shader. For kerb (casing) vertices `expand` holds the outward
// normal scaled by the kerb width; the shader widens the kerb to a minimum pixel width when zoomed out.

import { LANE_W, LEVEL_H } from '../network.js';
import { Poly, triangulate } from '../geom.js';
import { smoothstep, lerp } from '../util.js';

export const KERB_W = 0.4;

export class Buf {
  constructor() {
    this.p = [];
    this.c = [];
    this.e = [];
  }
  get count() {
    return this.p.length / 3;
  }
  v(x, y, col, ex = 0, ey = 0) {
    this.p.push(x, y, 0);
    this.c.push(col[0], col[1], col[2], col[3]);
    this.e.push(ex, ey);
  }
  tri(a, b, c, ca, cb = ca, cc = ca) {
    this.v(a.x, a.y, ca, a.ex, a.ey);
    this.v(b.x, b.y, cb, b.ex, b.ey);
    this.v(c.x, c.y, cc, c.ex, c.ey);
  }
  /** Quad from four points (a,b,c,d in order). */
  quad(a, b, c, d, col) {
    this.tri(a, b, c, col);
    this.tri(a, c, d, col);
  }
  append(o) {
    for (let i = 0; i < o.p.length; i++) this.p.push(o.p[i]);
    for (let i = 0; i < o.c.length; i++) this.c.push(o.c[i]);
    for (let i = 0; i < o.e.length; i++) this.e.push(o.e[i]);
  }
}

const pt = (x, y, ex = 0, ey = 0) => ({ x, y, ex, ey });
const mixCol = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), lerp(a[3], b[3], t)];

/** Triangle strip between two vertex rows. */
function strip(buf, A, B, colA, colB) {
  for (let i = 0; i < A.length - 1; i++) {
    buf.tri(A[i], B[i], B[i + 1], colA[i], colB[i], colB[i + 1]);
    buf.tri(A[i], B[i + 1], A[i + 1], colA[i], colB[i + 1], colA[i + 1]);
  }
}

function casingColor(th, z) {
  return mixCol(th.casing, th.casingElev, Math.min(1, z));
}
function casingAlpha(z, col) {
  return z > 0.001 ? [col[0], col[1], col[2], col[3] * smoothstep(0.02, 0.32, z)] : col;
}

/** Everything one edge contributes to the render layers. */
export function buildEdgeParts(e, th) {
  const parts = { level: e.level, shadow: new Buf(), casing: new Buf(), fill: new Buf(), marks: new Buf() };
  const s0 = e.setA;
  const s1 = e.len - e.setB;
  if (s1 - s0 < 0.4) return parts;
  let tr = e.poly.slice(s0, s1);
  if (e.a.z !== e.b.z) tr = tr.resample(7);
  const m = tr.n;
  const { nx, ny } = tr.miterNormals();
  const zs = new Float64Array(m);
  for (let i = 0; i < m; i++) zs[i] = e.zAt(s0 + tr.cum[i]);
  const h = e.halfWidth;
  const b = KERB_W;

  // fill
  {
    const A = [];
    const B = [];
    const ca = [];
    for (let i = 0; i < m; i++) {
      A.push(pt(tr.xs[i] - nx[i] * h, tr.ys[i] - ny[i] * h));
      B.push(pt(tr.xs[i] + nx[i] * h, tr.ys[i] + ny[i] * h));
      ca.push(th.road);
    }
    strip(parts.fill, A, B, ca, ca);
  }
  // kerbs: right side (+n) and left side (-n); raised roads get a heavier dark outline
  for (const sgn of [1, -1]) {
    const A = [];
    const B = [];
    const ca = [];
    for (let i = 0; i < m; i++) {
      const l = Math.hypot(nx[i], ny[i]) || 1;
      const ux = (nx[i] / l) * sgn;
      const uy = (ny[i] / l) * sgn;
      const bz = b * (1 + 1.3 * Math.min(1, zs[i]));
      A.push(pt(tr.xs[i] + nx[i] * h * sgn, tr.ys[i] + ny[i] * h * sgn));
      B.push(pt(tr.xs[i] + nx[i] * (h + bz) * sgn, tr.ys[i] + ny[i] * (h + bz) * sgn, ux * bz, uy * bz));
      ca.push(casingAlpha(zs[i], casingColor(th, zs[i])));
    }
    strip(parts.casing, A, B, ca, ca);
  }
  // bridge shadow
  if (e.elevated) {
    const A = [];
    const B = [];
    const ca = [];
    const sx = th.sun[0];
    const sy = th.sun[1];
    for (let i = 0; i < m; i++) {
      const off = zs[i] * LEVEL_H * 0.55;
      const hh = h + 0.5;
      A.push(pt(tr.xs[i] - nx[i] * hh + sx * off, tr.ys[i] - ny[i] * hh + sy * off));
      B.push(pt(tr.xs[i] + nx[i] * hh + sx * off, tr.ys[i] + ny[i] * hh + sy * off));
      ca.push([th.shadow[0], th.shadow[1], th.shadow[2], th.shadow[3] * smoothstep(0.05, 0.6, zs[i])]);
    }
    strip(parts.shadow, A, B, ca, ca);
  }

  addMarkings(parts.marks, e, tr, nx, ny, th);
  return parts;
}

/** Thin strip along tr at lateral offset d with the given half width. */
function lineStrip(buf, tr, nx, ny, d, hw, col, i0 = 0, i1 = tr.n - 1) {
  const A = [];
  const B = [];
  const c = [];
  for (let i = i0; i <= i1; i++) {
    A.push(pt(tr.xs[i] + nx[i] * (d - hw), tr.ys[i] + ny[i] * (d - hw)));
    B.push(pt(tr.xs[i] + nx[i] * (d + hw), tr.ys[i] + ny[i] * (d + hw)));
    c.push(col);
  }
  strip(buf, A, B, c, c);
}

/** Dashes along a polyline at lateral offset d; arc-length based so they follow curves. */
function dashed(buf, tr, d, hw, dash, gap, col, start = 0, end = tr.len) {
  const o = {};
  for (let s = start; s < end - 0.2; s += dash + gap) {
    const e = Math.min(end, s + dash);
    const steps = Math.max(1, Math.ceil((e - s) / 1.6));
    let prevL = null;
    let prevR = null;
    for (let k = 0; k <= steps; k++) {
      tr.pointAt(s + ((e - s) * k) / steps, o);
      const nxk = o.ty;
      const nyk = -o.tx;
      const L = pt(o.x + nxk * (d - hw), o.y + nyk * (d - hw));
      const R = pt(o.x + nxk * (d + hw), o.y + nyk * (d + hw));
      if (prevL) buf.quad(prevL, prevR, R, L, col);
      prevL = L;
      prevR = R;
    }
  }
}

function arrowShape(buf, x, y, tx, ty, col, len = 3.2, wid = 1.5) {
  const nx = ty;
  const ny = -tx;
  const tip = pt(x + tx * len * 0.5, y + ty * len * 0.5);
  const hb = len * 0.5 - len * 0.42;
  const base1 = pt(x + tx * hb + nx * wid * 0.5, y + ty * hb + ny * wid * 0.5);
  const base2 = pt(x + tx * hb - nx * wid * 0.5, y + ty * hb - ny * wid * 0.5);
  buf.tri(tip, base2, base1, col);
  const sw = wid * 0.16;
  const back = -len * 0.5;
  buf.quad(
    pt(x + tx * back + nx * sw, y + ty * back + ny * sw),
    pt(x + tx * hb + nx * sw, y + ty * hb + ny * sw),
    pt(x + tx * hb - nx * sw, y + ty * hb - ny * sw),
    pt(x + tx * back - nx * sw, y + ty * back - ny * sw),
    col,
  );
}

function addMarkings(buf, e, tr, nx, ny, th) {
  const xm = e.xm;
  const W = LANE_W;
  if (e.lf > 0 && e.lb > 0) lineStrip(buf, tr, nx, ny, xm, 0.13, th.yellow);
  if (tr.len > 6) {
    const pad = 2.5;
    for (let j = 1; j < e.lf; j++) dashed(buf, tr, xm + j * W, 0.1, 3, 6.5, th.dash, pad, tr.len - pad);
    for (let j = 1; j < e.lb; j++) dashed(buf, tr, xm - j * W, 0.1, 3, 6.5, th.dash, pad, tr.len - pad);
  }
  // one-way arrows
  if (e.oneWay && !e.ring && tr.len > 20) {
    const o = {};
    const dirSign = e.lf > 0 ? 1 : -1;
    const lanes = e.lf > 0 ? e.lf : e.lb;
    for (let s = Math.min(14, tr.len / 2); s < tr.len - 8; s += 60) {
      tr.pointAt(s, o);
      for (let j = 0; j < lanes; j++) {
        const off = e.lf > 0 ? xm + (j + 0.5) * W : xm - (j + 0.5) * W;
        arrowShape(buf, o.x + o.ty * off, o.y - o.tx * off, o.tx * dirSign, o.ty * dirSign, th.arrow);
      }
    }
  }
  // stop lines at junction approaches
  for (const atA of [true, false]) {
    const node = atA ? e.a : e.b;
    if (node.edges.length < 3) continue;
    const dir = atA ? e.dirB : e.dirF; // dir arriving at this node
    if (!dir) continue;
    const idx = atA ? 0 : tr.n - 1;
    const o = {};
    tr.pointAt(atA ? 0.45 : tr.len - 0.45, o);
    const n0 = o.ty;
    const n1 = -o.tx;
    // lanes of dir span from the median outwards
    const lanes = dir.lanes.length;
    const a = atA ? xm - lanes * W : xm;
    const bb = atA ? xm : xm + lanes * W;
    void idx;
    const step = 1.1;
    for (let d = a + 0.15; d < bb - 0.2; d += step * 2) {
      const d1 = Math.min(bb - 0.15, d + step);
      const t = 0.22;
      buf.quad(
        pt(o.x + n0 * d - o.tx * t, o.y + n1 * d - o.ty * t),
        pt(o.x + n0 * d1 - o.tx * t, o.y + n1 * d1 - o.ty * t),
        pt(o.x + n0 * d1 + o.tx * t, o.y + n1 * d1 + o.ty * t),
        pt(o.x + n0 * d + o.tx * t, o.y + n1 * d + o.ty * t),
        th.stop,
      );
    }
  }
}

/** Junction patch: white fan + kerb strokes along the rounded corners. */
export function buildNodeParts(n, th) {
  const parts = { level: Math.ceil(n.z - 0.01), casing: new Buf(), fill: new Buf() };
  if (!n.fill) return parts;
  const P = n.fill.pts;
  const tris = triangulate(P);
  if (tris) {
    for (const [a, b, c] of tris) parts.fill.tri(pt(P[a].x, P[a].y), pt(P[b].x, P[b].y), pt(P[c].x, P[c].y), th.road);
  } else {
    // not a simple polygon (overlapping arms): a fan from the centre still covers it
    const c = { x: n.x, y: n.y, ex: 0, ey: 0 };
    for (let i = 0; i < P.length; i++) {
      const a = P[i];
      const b = P[(i + 1) % P.length];
      parts.fill.tri(c, pt(a.x, a.y), pt(b.x, b.y), th.road);
    }
  }
  const col = casingAlpha(n.z, casingColor(th, n.z));
  for (const chain of n.fill.chains) {
    const poly = new Poly(chain);
    if (poly.n < 2 || poly.len < 0.05) continue;
    const { nx, ny } = poly.miterNormals();
    const A = [];
    const B = [];
    const cs = [];
    for (let i = 0; i < poly.n; i++) {
      const l = Math.hypot(nx[i], ny[i]) || 1;
      A.push(pt(poly.xs[i], poly.ys[i]));
      B.push(pt(poly.xs[i] + nx[i] * KERB_W, poly.ys[i] + ny[i] * KERB_W, (nx[i] / l) * KERB_W, (ny[i] / l) * KERB_W));
      cs.push(col);
    }
    strip(parts.casing, A, B, cs, cs);
  }
  return parts;
}

/** A flat ribbon along a polyline between two lateral offsets (used for ghosts and overlays). */
export function ribbon(buf, poly, dA, dB, colA, colB = colA, expandB = 0) {
  const { nx, ny } = poly.miterNormals();
  const A = [];
  const B = [];
  const ca = [];
  const cb = [];
  for (let i = 0; i < poly.n; i++) {
    const l = Math.hypot(nx[i], ny[i]) || 1;
    const sg = dB >= dA ? 1 : -1;
    A.push(pt(poly.xs[i] + nx[i] * dA, poly.ys[i] + ny[i] * dA));
    B.push(pt(poly.xs[i] + nx[i] * dB, poly.ys[i] + ny[i] * dB, expandB ? (nx[i] / l) * expandB * sg : 0, expandB ? (ny[i] / l) * expandB * sg : 0));
    ca.push(colA);
    cb.push(colB);
  }
  strip(buf, A, B, ca, cb);
}
