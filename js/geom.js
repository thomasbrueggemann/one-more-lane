// 2D geometry: polylines with arc-length parameterisation, arcs, beziers, intersections, rect tests.
// Coordinates are metres, x right, y up. "Right of travel" for a tangent (tx,ty) is (ty,-tx).

import { TAU } from './util.js';

export class Poly {
  /** @param {Array<{x:number,y:number}>} pts */
  constructor(pts) {
    const xs = [];
    const ys = [];
    for (const p of pts) {
      const x = p.x;
      const y = p.y;
      const n = xs.length;
      if (n && Math.abs(x - xs[n - 1]) + Math.abs(y - ys[n - 1]) < 1e-4) continue;
      xs.push(x);
      ys.push(y);
    }
    this.n = xs.length;
    this.xs = Float64Array.from(xs);
    this.ys = Float64Array.from(ys);
    this.cum = new Float64Array(this.n);
    for (let i = 1; i < this.n; i++) {
      this.cum[i] = this.cum[i - 1] + Math.hypot(this.xs[i] - this.xs[i - 1], this.ys[i] - this.ys[i - 1]);
    }
    this.len = this.n > 1 ? this.cum[this.n - 1] : 0;
  }

  static fromArrays(xs, ys) {
    const pts = [];
    for (let i = 0; i < xs.length; i++) pts.push({ x: xs[i], y: ys[i] });
    return new Poly(pts);
  }

  points() {
    const out = [];
    for (let i = 0; i < this.n; i++) out.push({ x: this.xs[i], y: this.ys[i] });
    return out;
  }

  /** Index i of the segment [i, i+1] containing arc length s. */
  segAt(s) {
    const cum = this.cum;
    let lo = 0;
    let hi = this.n - 2;
    if (hi < 0) return 0;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /** Position and unit tangent at arc length s (clamped). Writes into out. */
  pointAt(s, out = {}) {
    if (this.n < 2) {
      out.x = this.xs[0] || 0;
      out.y = this.ys[0] || 0;
      out.tx = 1;
      out.ty = 0;
      return out;
    }
    if (s < 0) s = 0;
    else if (s > this.len) s = this.len;
    const i = this.segAt(s);
    const x0 = this.xs[i];
    const y0 = this.ys[i];
    const dx = this.xs[i + 1] - x0;
    const dy = this.ys[i + 1] - y0;
    const sl = this.cum[i + 1] - this.cum[i];
    const u = sl > 1e-9 ? (s - this.cum[i]) / sl : 0;
    out.x = x0 + dx * u;
    out.y = y0 + dy * u;
    if (sl > 1e-9) {
      out.tx = dx / sl;
      out.ty = dy / sl;
    } else {
      out.tx = 1;
      out.ty = 0;
    }
    return out;
  }

  startTangent(out = {}) {
    return this.pointAt(0, out);
  }
  endTangent(out = {}) {
    return this.pointAt(this.len, out);
  }

  /** Closest point on the polyline to (px,py). side>0 means the point is left of travel. */
  closest(px, py, out = {}) {
    let best = Infinity;
    let bs = 0;
    let bx = 0;
    let by = 0;
    let bi = 0;
    for (let i = 0; i < this.n - 1; i++) {
      const x0 = this.xs[i];
      const y0 = this.ys[i];
      const dx = this.xs[i + 1] - x0;
      const dy = this.ys[i + 1] - y0;
      const l2 = dx * dx + dy * dy;
      let u = l2 > 1e-12 ? ((px - x0) * dx + (py - y0) * dy) / l2 : 0;
      u = u < 0 ? 0 : u > 1 ? 1 : u;
      const qx = x0 + dx * u;
      const qy = y0 + dy * u;
      const d2 = (px - qx) * (px - qx) + (py - qy) * (py - qy);
      if (d2 < best) {
        best = d2;
        bs = this.cum[i] + Math.sqrt(l2) * u;
        bx = qx;
        by = qy;
        bi = i;
      }
    }
    out.s = bs;
    out.d = Math.sqrt(best);
    out.x = bx;
    out.y = by;
    out.i = bi;
    const dx = this.xs[bi + 1] - this.xs[bi];
    const dy = this.ys[bi + 1] - this.ys[bi];
    out.side = dx * (py - by) - dy * (px - bx) >= 0 ? 1 : -1;
    return out;
  }

  /** Sub-polyline between arc lengths s0 and s1 (s0 < s1). */
  slice(s0, s1) {
    s0 = Math.max(0, s0);
    s1 = Math.min(this.len, s1);
    const pts = [];
    const a = this.pointAt(s0);
    pts.push({ x: a.x, y: a.y });
    for (let i = 0; i < this.n; i++) {
      if (this.cum[i] > s0 + 1e-6 && this.cum[i] < s1 - 1e-6) pts.push({ x: this.xs[i], y: this.ys[i] });
    }
    const b = this.pointAt(s1);
    pts.push({ x: b.x, y: b.y });
    return new Poly(pts);
  }

  reverse() {
    const pts = [];
    for (let i = this.n - 1; i >= 0; i--) pts.push({ x: this.xs[i], y: this.ys[i] });
    return new Poly(pts);
  }

  /**
   * Per-vertex right-hand "mitre normals": offsetting vertex i by d moves it by (nx[i]*d, ny[i]*d).
   * Interior vertices are scaled so the offset curve keeps a constant distance from both segments.
   */
  miterNormals() {
    const n = this.n;
    const nx = new Float64Array(n);
    const ny = new Float64Array(n);
    if (n < 2) return { nx, ny };
    const sx = new Float64Array(n - 1);
    const sy = new Float64Array(n - 1);
    for (let i = 0; i < n - 1; i++) {
      const dx = this.xs[i + 1] - this.xs[i];
      const dy = this.ys[i + 1] - this.ys[i];
      const l = Math.hypot(dx, dy) || 1;
      sx[i] = dy / l;
      sy[i] = -dx / l;
    }
    nx[0] = sx[0];
    ny[0] = sy[0];
    nx[n - 1] = sx[n - 2];
    ny[n - 1] = sy[n - 2];
    for (let i = 1; i < n - 1; i++) {
      const mx = sx[i - 1] + sx[i];
      const my = sy[i - 1] + sy[i];
      const k = 1 + sx[i - 1] * sx[i] + sy[i - 1] * sy[i];
      const f = 1 / Math.max(k, 0.5);
      nx[i] = mx * f;
      ny[i] = my * f;
    }
    return { nx, ny };
  }

  /** Lateral offset by d (positive = right of travel) using mitred joins. */
  offset(d) {
    const n = this.n;
    if (n < 2 || d === 0) return this;
    const { nx, ny } = this.miterNormals();
    const pts = [];
    for (let i = 0; i < n; i++) pts.push({ x: this.xs[i] + nx[i] * d, y: this.ys[i] + ny[i] * d });
    return new Poly(pts);
  }

  /** Insert vertices so that no segment is longer than maxStep. */
  resample(maxStep) {
    const pts = [];
    for (let i = 0; i < this.n - 1; i++) {
      const x0 = this.xs[i];
      const y0 = this.ys[i];
      const dx = this.xs[i + 1] - x0;
      const dy = this.ys[i + 1] - y0;
      const l = Math.hypot(dx, dy);
      const k = Math.max(1, Math.ceil(l / maxStep));
      for (let j = 0; j < k; j++) pts.push({ x: x0 + (dx * j) / k, y: y0 + (dy * j) / k });
    }
    pts.push({ x: this.xs[this.n - 1], y: this.ys[this.n - 1] });
    return new Poly(pts);
  }

  bbox() {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < this.n; i++) {
      if (this.xs[i] < x0) x0 = this.xs[i];
      if (this.xs[i] > x1) x1 = this.xs[i];
      if (this.ys[i] < y0) y0 = this.ys[i];
      if (this.ys[i] > y1) y1 = this.ys[i];
    }
    return { x0, y0, x1, y1 };
  }

  /** Smallest turning radius along the polyline, estimated from vertex deflection. */
  minRadius() {
    let best = Infinity;
    for (let i = 1; i < this.n - 1; i++) {
      const ax = this.xs[i] - this.xs[i - 1];
      const ay = this.ys[i] - this.ys[i - 1];
      const bx = this.xs[i + 1] - this.xs[i];
      const by = this.ys[i + 1] - this.ys[i];
      const la = Math.hypot(ax, ay);
      const lb = Math.hypot(bx, by);
      if (la < 1e-6 || lb < 1e-6) continue;
      const ang = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by));
      if (ang < 1e-4) continue;
      const r = (la + lb) / 2 / ang;
      if (r < best) best = r;
    }
    return best;
  }
}

/**
 * Circular arc leaving S along unit tangent T and passing through E.
 * Returns { poly, kind, R, sweep, endTx, endTy } or null when E lies too far behind S (arc > maxSweep).
 */
export function arcPoly(sx, sy, tx, ty, ex, ey, maxStep = 2.5, maxSweep = Math.PI * 0.8) {
  const dx = ex - sx;
  const dy = ey - sy;
  const chord = Math.hypot(dx, dy);
  const lat = tx * dy - ty * dx; // >0: E is left of T
  const fwd = tx * dx + ty * dy;
  if (chord < 1e-6) return null;
  if (Math.abs(lat) < 1e-3 * chord && fwd > 0) {
    return { poly: new Poly([{ x: sx, y: sy }, { x: ex, y: ey }]), kind: 'line', R: Infinity, sweep: 0, endTx: tx, endTy: ty };
  }
  const R = (chord * chord) / (2 * Math.abs(lat));
  const half = Math.asin(Math.min(1, chord / (2 * R)));
  let sweep = 2 * half;
  if (fwd < 0) sweep = TAU - sweep;
  if (sweep > maxSweep) return null;
  const sg = lat > 0 ? 1 : -1;
  // the centre sits on the side E curves towards: S + leftNormal * sg * R, with leftNormal = (-ty, tx)
  const ccx = sx - ty * sg * R;
  const ccy = sy + tx * sg * R;
  const a0 = Math.atan2(sy - ccy, sx - ccx);
  const steps = Math.max(2, Math.ceil((R * sweep) / maxStep));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = a0 + sg * sweep * (i / steps);
    pts.push({ x: ccx + Math.cos(a) * R, y: ccy + Math.sin(a) * R });
  }
  pts[pts.length - 1] = { x: ex, y: ey };
  pts[0] = { x: sx, y: sy };
  const aEnd = a0 + sg * sweep;
  // tangent at end: derivative of centre + R(cos a, sin a) in direction sg
  const endTx = -Math.sin(aEnd) * sg;
  const endTy = Math.cos(aEnd) * sg;
  return { poly: new Poly(pts), kind: 'arc', R, sweep, endTx, endTy };
}

/** Full or partial circle centred at (cx,cy). angle0/angle1 in radians, direction +1 = CCW. */
export function circlePoly(cx, cy, r, angle0, angle1, maxStep = 2) {
  const sweep = angle1 - angle0;
  const steps = Math.max(3, Math.ceil((r * Math.abs(sweep)) / maxStep));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const a = angle0 + sweep * (i / steps);
    pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  }
  return new Poly(pts);
}

export function cubicPoly(p0, p1, p2, p3, maxStep = 1.5) {
  const approx = Math.hypot(p1.x - p0.x, p1.y - p0.y) + Math.hypot(p2.x - p1.x, p2.y - p1.y) + Math.hypot(p3.x - p2.x, p3.y - p2.y);
  const steps = Math.max(3, Math.ceil(approx / maxStep));
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    pts.push({ x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y });
  }
  return new Poly(pts);
}

export function quadPoints(p0, c, p1, steps) {
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    pts.push({ x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y });
  }
  return pts;
}

/** Segment AB vs CD. Returns {t,u} in [0,1] or null. */
export function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-12) return null;
  const qx = cx - ax;
  const qy = cy - ay;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

/** All crossings between polylines P and Q: [{sP, sQ, x, y, cosAngle}] sorted by sP. */
export function polyIntersections(P, Q) {
  const out = [];
  const pb = P.bbox();
  const qb = Q.bbox();
  if (pb.x1 < qb.x0 || pb.x0 > qb.x1 || pb.y1 < qb.y0 || pb.y0 > qb.y1) return out;
  for (let i = 0; i < P.n - 1; i++) {
    const ax = P.xs[i];
    const ay = P.ys[i];
    const bx = P.xs[i + 1];
    const by = P.ys[i + 1];
    const minx = Math.min(ax, bx);
    const maxx = Math.max(ax, bx);
    const miny = Math.min(ay, by);
    const maxy = Math.max(ay, by);
    for (let j = 0; j < Q.n - 1; j++) {
      const cx = Q.xs[j];
      const cy = Q.ys[j];
      const dx = Q.xs[j + 1];
      const dy = Q.ys[j + 1];
      if (Math.max(cx, dx) < minx || Math.min(cx, dx) > maxx || Math.max(cy, dy) < miny || Math.min(cy, dy) > maxy) continue;
      const hit = segIntersect(ax, ay, bx, by, cx, cy, dx, dy);
      if (!hit) continue;
      const sP = P.cum[i] + hit.t * (P.cum[i + 1] - P.cum[i]);
      const sQ = Q.cum[j] + hit.u * (Q.cum[j + 1] - Q.cum[j]);
      const l1 = Math.hypot(bx - ax, by - ay) || 1;
      const l2 = Math.hypot(dx - cx, dy - cy) || 1;
      const cosA = ((bx - ax) * (dx - cx) + (by - ay) * (dy - cy)) / (l1 * l2);
      const prev = out[out.length - 1];
      if (prev && Math.abs(prev.sP - sP) < 0.05 && Math.abs(prev.sQ - sQ) < 0.05) continue;
      out.push({ sP, sQ, x: ax + (bx - ax) * hit.t, y: ay + (by - ay) * hit.t, cosAngle: cosA });
    }
  }
  out.sort((a, b) => a.sP - b.sP);
  return out;
}

export function distPointSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let u = l2 > 1e-12 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  return Math.hypot(px - (ax + dx * u), py - (ay + dy * u));
}

/* ---------- oriented rectangles (buildings) ---------- */

/** Rectangle: centre, half extents along the local x (hw) and y (hd) axes, rotation ang. */
export function makeRect(cx, cy, hw, hd, ang) {
  const c = Math.cos(ang);
  const s = Math.sin(ang);
  return { cx, cy, hw, hd, ang, c, s };
}

export function rectCorners(r) {
  const out = [];
  for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
    const lx = sx * r.hw;
    const ly = sy * r.hd;
    out.push({ x: r.cx + lx * r.c - ly * r.s, y: r.cy + lx * r.s + ly * r.c });
  }
  return out;
}

/** SAT overlap of two oriented rects, with an extra margin applied to both. */
export function rectsOverlap(a, b, margin = 0) {
  const axes = [
    [a.c, a.s],
    [-a.s, a.c],
    [b.c, b.s],
    [-b.s, b.c],
  ];
  const dx = b.cx - a.cx;
  const dy = b.cy - a.cy;
  for (const [ax, ay] of axes) {
    const ra = a.hw * Math.abs(a.c * ax + a.s * ay) + a.hd * Math.abs(-a.s * ax + a.c * ay);
    const rb = b.hw * Math.abs(b.c * ax + b.s * ay) + b.hd * Math.abs(-b.s * ax + b.c * ay);
    if (Math.abs(dx * ax + dy * ay) > ra + rb + margin) return false;
  }
  return true;
}

/** Does the segment (ax,ay)-(bx,by), thickened by r, touch rect? */
export function segTouchesRect(ax, ay, bx, by, rect, r = 0) {
  // to local frame
  const l = (x, y) => {
    const px = x - rect.cx;
    const py = y - rect.cy;
    return [px * rect.c + py * rect.s, -px * rect.s + py * rect.c];
  };
  const [x0, y0] = l(ax, ay);
  const [x1, y1] = l(bx, by);
  const hw = rect.hw + r;
  const hd = rect.hd + r;
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const clip = (p, q) => {
    if (Math.abs(p) < 1e-12) return q >= 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  return clip(-dx, x0 + hw) && clip(dx, hw - x0) && clip(-dy, y0 + hd) && clip(dy, hd - y0);
}

export function pointInRect(px, py, rect, margin = 0) {
  const dx = px - rect.cx;
  const dy = py - rect.cy;
  const lx = dx * rect.c + dy * rect.s;
  const ly = -dx * rect.s + dy * rect.c;
  return Math.abs(lx) <= rect.hw + margin && Math.abs(ly) <= rect.hd + margin;
}

/** Convex hull (Andrew monotone chain) of {x,y} points, CCW. */
export function convexHull(points) {
  const p = points.slice().sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length < 3) return p;
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop();
    upper.push(q);
  }
  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

/**
 * Ear-clipping triangulation of a simple CCW polygon of {x,y} points. Returns index triples, or null when the
 * polygon is not simple enough to clip completely.
 */
export function triangulate(P) {
  const n = P.length;
  if (n < 3) return [];
  const cross = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const idx = [];
  // drop repeated points, which have no ear of their own
  for (let i = 0; i < n; i++) {
    const q = P[(i + n - 1) % n];
    if (Math.hypot(P[i].x - q.x, P[i].y - q.y) > 1e-6) idx.push(i);
  }
  const tris = [];
  let guard = idx.length * idx.length + 10;
  while (idx.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < idx.length; k++) {
      const ia = idx[(k + idx.length - 1) % idx.length];
      const ib = idx[k];
      const ic = idx[(k + 1) % idx.length];
      const a = P[ia];
      const b = P[ib];
      const c = P[ic];
      const cr = cross(a, b, c);
      if (cr < -1e-9) continue; // reflex
      if (cr <= 1e-9) {
        // collinear: drop the middle point
        idx.splice(k, 1);
        clipped = true;
        break;
      }
      let inside = false;
      for (const im of idx) {
        if (im === ia || im === ib || im === ic) continue;
        const m = P[im];
        if (cross(a, b, m) >= 0 && cross(b, c, m) >= 0 && cross(c, a, m) >= 0) {
          inside = true;
          break;
        }
      }
      if (inside) continue;
      tris.push([ia, ib, ic]);
      idx.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) return null;
  }
  if (idx.length === 3) tris.push([idx[0], idx[1], idx[2]]);
  // a self-intersecting outline can still clip, but then the triangles don't add up to its area
  let area = 0;
  for (let i = 0; i < n; i++) {
    const q = P[(i + 1) % n];
    area += P[i].x * q.y - q.x * P[i].y;
  }
  let sum = 0;
  for (const [a, b, c] of tris) sum += Math.abs(cross(P[a], P[b], P[c]));
  if (Math.abs(sum - area) > 0.5 + 0.01 * Math.abs(area)) return null;
  return tris;
}
