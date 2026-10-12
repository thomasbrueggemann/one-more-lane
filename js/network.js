// Road network: nodes, edges, directed lane groups, junction geometry and lane connections.
//
// Conventions
//  - An Edge has a reference polyline a->b that is the CENTRE of the whole roadway.
//  - lf lanes run a->b on the right of the median, lb lanes run b->a on the left. Lane j=0 is next to the median.
//  - The median sits at lateral offset xm=(lb-lf)*W/2 (right-positive) so the roadway stays centred on the reference.
//  - Junction polygons (with rounded corners) trim every edge end by a "setback"; lanes end at the stop line.

import { Poly, cubicPoly, quadPoints } from './geom.js';
import { TAU, angleDiff, clamp } from './util.js';

export const LANE_W = 3.4;
export const LEVEL_H = 6; // metres of height per elevation level (used for shadows / ordering)
export const MIN_LANE_LEN = 6;
export const MAX_EDGE_LEN = 120;
export const FILLET_R = 5.2;
export const RING_FILLET = 3.0;
const FILLET_MAX_TAU = 9;

export const CLASSES = {
  street: { id: 'street', name: 'Street', limit: 11.1, lanes: 1, laneCost: 4, access: true, minR: 11, rank: 1 },
  avenue: { id: 'avenue', name: 'Avenue', limit: 16.7, lanes: 2, laneCost: 5.2, access: true, minR: 24, rank: 2 },
  highway: { id: 'highway', name: 'Highway', limit: 27.8, lanes: 3, laneCost: 7.5, access: false, minR: 70, rank: 3 },
};

/* ------------------------------------------------------------------ model classes */

export class Node {
  constructor(id, x, y, z = 0) {
    this.id = id;
    this.x = x;
    this.y = y;
    this.z = z;
    this.edges = [];
    this.ends = [];
    this.fill = null; // junction polygon {pts:[{x,y}], chains:[[{x,y}]]}
    this.conns = [];
    this.signal = null;
    this.ring = null; // roundabout id when part of a ring
    this.alive = true;
    this.geomVersion = 0;
  }
}

export class Edge {
  constructor(id, a, b, poly, opts) {
    this.id = id;
    this.a = a;
    this.b = b;
    this.poly = poly;
    this.len = poly.len;
    this.lf = opts.lf;
    this.lb = opts.lb;
    this.cls = opts.cls;
    this.ring = opts.ring || null; // roundabout id for ring arcs
    this.limit = this.ring != null ? Math.min(CLASSES[opts.cls].limit, 8.5) : CLASSES[opts.cls].limit;
    this.setA = 0;
    this.setB = 0;
    this.dirF = null;
    this.dirB = null;
    this.alive = true;
    this.bbox = null;
    this.invalid = false;
    this.geomVersion = 0;
    this.value = 0; // money spent on this edge (refunds on bulldozing are a share of it)
  }
  get width() {
    return (this.lf + this.lb) * LANE_W;
  }
  get halfWidth() {
    return this.width / 2;
  }
  /** Lateral offset of the median line from the reference (right-positive). */
  get xm() {
    return ((this.lb - this.lf) * LANE_W) / 2;
  }
  get oneWay() {
    return this.lf === 0 || this.lb === 0;
  }
  other(node) {
    return node === this.a ? this.b : this.a;
  }
  /** Elevation (in levels) at arc length s. */
  zAt(s) {
    const za = this.a.z;
    const zb = this.b.z;
    if (za === zb) return za;
    const t = clamp(s / this.len, 0, 1);
    return za + (zb - za) * t * t * (3 - 2 * t);
  }
  get elevated() {
    return this.a.z > 0.01 || this.b.z > 0.01;
  }
  get level() {
    return Math.ceil(Math.max(this.a.z, this.b.z) - 0.01);
  }
  dirTo(node) {
    return this.a === node ? this.dirB : this.dirF; // the Dir arriving at node
  }
  dirFrom(node) {
    return this.a === node ? this.dirF : this.dirB; // the Dir leaving node
  }
}

export class Dir {
  constructor(id, edge, fwd) {
    this.id = id;
    this.edge = edge;
    this.fwd = fwd;
    this.from = fwd ? edge.a : edge.b;
    this.to = fwd ? edge.b : edge.a;
    this.lanes = [];
    this.next = [];
    this.moves = new Map();
    this.cong = 1; // travel-time multiplier (>=1) maintained by the simulation
    this.alive = true;
  }
  get len() {
    return this.lanes.length ? this.lanes[0].len : 0;
  }
  get limit() {
    return this.edge.limit;
  }
}

export class Lane {
  constructor(id, dir, j) {
    this.id = id;
    this.dir = dir;
    this.j = j;
    this.poly = null;
    this.len = 0;
    this.vehicles = []; // ascending s
    this.inConns = [];
    this.outConns = [];
    this.alive = true;
    this.isConn = false;
    this.lo = 0; // lateral offset of the lane centre from the road centre, right-of-travel positive
  }
  get n() {
    return this.dir.lanes.length;
  }
  get limit() {
    return this.dir.edge.limit;
  }
}

export class Conn {
  constructor(id, node, from, to, poly, turn) {
    this.id = id;
    this.node = node;
    this.from = from;
    this.to = to;
    this.poly = poly;
    this.len = poly.len;
    this.turn = turn; // 'S' | 'L' | 'R' | 'U'
    this.vehicles = [];
    this.conflicts = [];
    this.speed = 8;
    this.rank = 1;
    this.key = `${from.id}>${to.id}`;
    // edge id + travel direction rather than Dir ids, so a movement keeps its name through save, load and undo
    this.moveKey = `${from.dir.edge.id}${from.dir.fwd ? 'f' : 'b'}>${to.dir.edge.id}${to.dir.fwd ? 'f' : 'b'}`;
    this.alive = true;
    this.isConn = true;
  }
}

/* ------------------------------------------------------------------ junction geometry (pure) */

/**
 * Build the polygon that joins the arms of a junction and the setback (stop-line distance) of every arm.
 * ends: [{dx,dy,h,ang,at?}] sorted by ang ascending (outward unit direction, half width). The optional
 * at(s, o) fills o with the centreline point {x,y} and outward unit direction {dx,dy} at distance s along a
 * curved arm, so the polygon meets the road exactly where the edge is trimmed (without it arms are straight rays).
 * Returns { setbacks, pts, chains } where pts is a CCW polygon and chains are the outer boundary
 * polylines (corner fillets) that need a kerb stroke.
 */
export function computeJunction(cx, cy, ends, fillet = FILLET_R) {
  const k = ends.length;
  const out = { setbacks: new Array(k).fill(0), pts: [], chains: [] };
  if (k === 0) return out;

  if (k === 1) {
    // dead end: turnaround bulb centred on the end of the road
    const r = ends[0].h + 3;
    const pts = [];
    for (let i = 0; i < 28; i++) {
      const a = (i / 28) * TAU;
      pts.push({ x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    }
    out.pts = pts;
    out.chains = [pts.concat([pts[0]])];
    return out;
  }

  const corners = new Array(k);
  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k;
    const ei = ends[i];
    const ej = ends[j];
    let phi = ej.ang - ei.ang;
    if (phi <= 1e-9) phi += TAU;
    // left border of i meets right border of j: di*t + nli*hi = dj*u - nlj*hj
    const nlix = -ei.dy;
    const nliy = ei.dx;
    const nljx = -ej.dy;
    const nljy = ej.dx;
    const rx = -nlix * ei.h - nljx * ej.h;
    const ry = -nliy * ei.h - nljy * ej.h;
    const det = -ei.dx * ej.dy + ej.dx * ei.dy;
    if (Math.abs(det) < 1e-5) {
      corners[i] = { phi, par: true };
      continue;
    }
    const t = (rx * -ej.dy + ej.dx * ry) / det;
    const u = (ei.dx * ry - ei.dy * rx) / det;
    corners[i] = { phi, t, u, x: cx + ei.dx * t + nlix * ei.h, y: cy + ei.dy * t + nliy * ei.h };
  }

  // fillet tangent lengths and resulting setbacks
  for (let i = 0; i < k; i++) {
    const c = corners[i];
    c.convex = !c.par && c.phi < Math.PI - 0.03 && c.t > -1e-6 && c.u > -1e-6;
    if (c.convex) {
      const half = c.phi / 2;
      const rr = Math.min(fillet, FILLET_MAX_TAU * Math.tan(half));
      c.tau = rr / Math.tan(half);
      const j = (i + 1) % k;
      out.setbacks[i] = Math.max(out.setbacks[i], Math.min(c.t, 45) + c.tau);
      out.setbacks[j] = Math.max(out.setbacks[j], Math.min(c.u, 45) + c.tau);
    }
  }
  for (let i = 0; i < k; i++) out.setbacks[i] = Math.min(out.setbacks[i], 60);

  // polygon: R_i, L_i, then the corner chain to R_(i+1)
  const R = [];
  const L = [];
  const D = []; // outward direction of each arm at its mouth
  const o = { x: 0, y: 0, dx: 0, dy: 0 };
  for (let i = 0; i < k; i++) {
    const e = ends[i];
    const s = out.setbacks[i];
    if (e.at) e.at(s, o);
    else {
      o.x = cx + e.dx * s;
      o.y = cy + e.dy * s;
      o.dx = e.dx;
      o.dy = e.dy;
    }
    const nlx = -o.dy;
    const nly = o.dx;
    R.push({ x: o.x - nlx * e.h, y: o.y - nly * e.h });
    L.push({ x: o.x + nlx * e.h, y: o.y + nly * e.h });
    D.push({ x: o.dx, y: o.dy });
  }
  const pts = [];
  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k;
    const c = corners[i];
    pts.push(R[i], L[i]);
    const chain = [L[i]];
    if (c.convex) {
      const q = quadPoints(L[i], filletControl(L[i], D[i], R[j], D[j], c), R[j], 8);
      for (let m = 1; m < q.length - 1; m++) chain.push(q[m]);
      for (let m = 1; m < q.length - 1; m++) pts.push(q[m]);
    } else {
      // no fillet: a curved arm's kerb is followed back to the node, so the patch hugs the inside of the bend
      // instead of cutting a chord across it
      const add = (q) => {
        chain.push(q);
        pts.push(q);
      };
      for (const q of armBorder(ends[i], out.setbacks[i], 1)) add(q);
      if (!c.par && c.phi > Math.PI + 0.03 && c.t < 0 && c.u < 0) {
        const dist = Math.hypot(c.x - cx, c.y - cy);
        const limit = 2.6 * Math.max(ends[i].h, ends[j].h) + 2;
        if (dist < limit) add({ x: c.x, y: c.y });
      }
      for (const q of armBorder(ends[j], out.setbacks[j], -1).reverse()) add(q);
    }
    chain.push(R[j]);
    out.chains.push(chain);
  }
  out.pts = pts;
  return out;
}

/**
 * Points along one kerb of a curved arm, from just inside its mouth back to the node (side +1 = left, -1 = right).
 * Empty for straight arms, where the mouth and the corner point already describe the kerb.
 */
function armBorder(e, setback, side) {
  const out = [];
  if (!e.at || setback < 1) return out;
  const o = { x: 0, y: 0, dx: 0, dy: 0 };
  e.at(0, o);
  const x0 = o.x;
  const y0 = o.y;
  e.at(setback / 2, o);
  // the centreline's distance from the straight ray tells whether the arm bends
  const off = Math.abs((o.x - x0) * e.dy - (o.y - y0) * e.dx);
  if (!(off > 0.05)) return out;
  const n = Math.max(2, Math.ceil(setback / 1.5));
  for (let m = n - 1; m >= 0; m--) {
    e.at((setback * m) / n, o);
    out.push({ x: o.x - o.dy * e.h * side, y: o.y + o.dx * e.h * side });
  }
  return out;
}

/**
 * Control point of a corner fillet from border point a (arm direction da) to b (direction db): where the two
 * kerb lines meet, so the curve leaves both roads tangentially. Falls back to the straight-arm corner when the
 * arms curved enough that the lines meet behind a mouth.
 */
function filletControl(a, da, b, db, c) {
  // a - da*t = b - db*u
  const det = da.x * db.y - da.y * db.x;
  if (Math.abs(det) > 1e-4) {
    const rx = a.x - b.x;
    const ry = a.y - b.y;
    const t = (rx * db.y - ry * db.x) / det;
    const u = (rx * da.y - ry * da.x) / det;
    if (t > 0 && u > 0) return { x: a.x - da.x * t, y: a.y - da.y * t };
  }
  return { x: c.x, y: c.y };
}

/* ------------------------------------------------------------------ the network */

/** Where each replaced Dir went after edge splits: the pieces in travel order (a to b for dirF, b to a for dirB). */
export function splitMap(info) {
  const map = new Map();
  const splits = info.removed.splits;
  if (!splits || !splits.length) return map;
  const by = new Map(splits.map((sp) => [sp.edge, sp]));
  const expand = (e) => {
    if (e.alive) return [e];
    const sp = by.get(e);
    return sp ? sp.parts.flatMap(expand) : [];
  };
  for (const sp of splits) {
    const parts = sp.parts.flatMap(expand);
    if (sp.dirF) map.set(sp.dirF, parts.map((e) => e.dirF).filter((d) => d && d.alive));
    if (sp.dirB) map.set(sp.dirB, parts.map((e) => e.dirB).filter((d) => d && d.alive).reverse());
  }
  return map;
}

/**
 * The connection that took over from a removed one: the same lane pair, or the same movement between the split pieces
 * next to the junction. Returns {conn, from} (from = index of the approach piece in the replaced Dir's list) or null.
 */
export function replacementConn(conn, map) {
  const node = conn.node;
  if (!node.alive) return null;
  const same = node.conns.find((c) => c.key === conn.key);
  if (same) return { conn: same, from: 0 };
  const fp = map.get(conn.from.dir);
  const tp = map.get(conn.to.dir);
  if (!fp && !tp) return null;
  const fd = fp && fp.length ? fp[fp.length - 1] : conn.from.dir;
  const td = tp && tp.length ? tp[0] : conn.to.dir;
  const fl = fd.lanes[Math.min(conn.from.j, fd.lanes.length - 1)];
  const tl = td.lanes[Math.min(conn.to.j, td.lanes.length - 1)];
  const c = node.conns.find((x) => x.from === fl && x.to === tl);
  return c ? { conn: c, from: fp && fp.length ? fp.length - 1 : 0 } : null;
}

/** What disappeared since the last rebuild; `splits` records which pieces replaced a split edge so traffic can follow. */
function freshRemoved() {
  return { lanes: [], conns: [], dirs: [], edges: [], nodes: [], splits: [] };
}

export class Network {
  constructor() {
    this.nodes = new Map();
    this.edges = new Map();
    this.roundabouts = new Map();
    this.nextNode = 1;
    this.nextEdge = 1;
    this.nextDir = 1;
    this.nextLane = 1;
    this.nextConn = 1;
    this.nextRing = 1;
    this.version = 0;
    this.dirtyNodes = new Set();
    this.dirtyEdges = new Set();
    this.removed = freshRemoved();
    this.onRebuild = null;
  }

  /** Drop everything (used when loading a saved city or undoing). Counters keep growing so ids stay unique. */
  clear() {
    for (const e of this.edges.values()) e.alive = false;
    for (const n of this.nodes.values()) n.alive = false;
    this.nodes.clear();
    this.edges.clear();
    this.roundabouts.clear();
    this.dirtyNodes.clear();
    this.dirtyEdges.clear();
    this.removed = freshRemoved();
    this.version++;
  }

  /* ---------- primitives (derived data is rebuilt in rebuild()) ---------- */

  addNode(x, y, z = 0, id = null) {
    const n = new Node(id ?? this.nextNode++, x, y, z);
    if (id != null) this.nextNode = Math.max(this.nextNode, id + 1);
    this.nodes.set(n.id, n);
    this.dirtyNodes.add(n);
    return n;
  }

  addEdge(a, b, poly, opts, id = null) {
    const e = new Edge(id ?? this.nextEdge++, a, b, poly, opts);
    if (id != null) this.nextEdge = Math.max(this.nextEdge, id + 1);
    this.edges.set(e.id, e);
    a.edges.push(e);
    b.edges.push(e);
    this.dirtyEdges.add(e);
    this.dirtyNodes.add(a);
    this.dirtyNodes.add(b);
    return e;
  }

  removeEdge(e) {
    if (!e.alive) return;
    e.alive = false;
    this.edges.delete(e.id);
    for (const n of [e.a, e.b]) {
      const i = n.edges.indexOf(e);
      if (i >= 0) n.edges.splice(i, 1);
      this.dirtyNodes.add(n);
    }
    this.dirtyEdges.delete(e);
    this.removed.edges.push(e);
    for (const d of [e.dirF, e.dirB]) {
      if (!d) continue;
      d.alive = false;
      this.removed.dirs.push(d);
      for (const l of d.lanes) {
        l.alive = false;
        this.removed.lanes.push(l);
        for (const c of l.inConns.concat(l.outConns)) this.killConn(c);
      }
    }
    e.dirF = e.dirB = null;
  }

  killConn(c) {
    if (!c.alive) return;
    c.alive = false;
    this.removed.conns.push(c);
    const i = c.node.conns.indexOf(c);
    if (i >= 0) c.node.conns.splice(i, 1);
    c.from.outConns = c.from.outConns.filter((x) => x !== c);
    c.to.inConns = c.to.inConns.filter((x) => x !== c);
    // the junction's connection set changed: it must be rebuilt so movements stay consistent
    if (c.node.alive) this.dirtyNodes.add(c.node);
  }

  removeNodeIfOrphan(n) {
    if (n.edges.length === 0 && n.alive) {
      n.alive = false;
      this.nodes.delete(n.id);
      this.dirtyNodes.delete(n);
      this.removed.nodes.push(n);
    }
  }

  /** Replace edge e by two edges meeting in a new node at arc length s. */
  splitEdge(e, s) {
    const z = e.zAt(s);
    const p = e.poly.pointAt(s);
    const m = this.addNode(p.x, p.y, Math.round(z * 1000) / 1000);
    const optsBase = { lf: e.lf, lb: e.lb, cls: e.cls, ring: e.ring };
    const polyA = e.poly.slice(0, s);
    const polyB = e.poly.slice(s, e.len);
    const a = e.a;
    const b = e.b;
    const frac = e.len > 0 ? s / e.len : 0.5;
    const value = e.value;
    if (e.ring != null) m.ring = e.ring;
    const { dirF, dirB } = e;
    this.removeEdge(e);
    const e1 = this.addEdge(a, m, polyA, optsBase);
    const e2 = this.addEdge(m, b, polyB, optsBase);
    e1.value = value * frac;
    e2.value = value * (1 - frac);
    this.removed.splits.push({ edge: e, parts: [e1, e2], dirF, dirB });
    return { node: m, e1, e2 };
  }

  setLanes(e, lf, lb) {
    e.lf = lf;
    e.lb = lb;
    this.dirtyEdges.add(e);
    this.dirtyNodes.add(e.a);
    this.dirtyNodes.add(e.b);
  }

  markEdgeDirty(e) {
    this.dirtyEdges.add(e);
    this.dirtyNodes.add(e.a);
    this.dirtyNodes.add(e.b);
  }

  markNodeDirty(n) {
    this.dirtyNodes.add(n);
  }

  /* ---------- derived data ---------- */

  /** Rebuild junction geometry, lanes and connections for everything marked dirty. Returns what changed. */
  rebuild() {
    const nodes = new Set();
    for (const n of this.dirtyNodes) if (n.alive) nodes.add(n);
    const edges = new Set();
    for (const e of this.dirtyEdges) if (e.alive) edges.add(e);
    for (const n of nodes) for (const e of n.edges) edges.add(e);
    this.dirtyNodes.clear();
    this.dirtyEdges.clear();

    for (const e of edges) {
      this.syncDirs(e);
      const bb = e.poly.bbox();
      const m = e.halfWidth + 6;
      e.bbox = { x0: bb.x0 - m, y0: bb.y0 - m, x1: bb.x1 + m, y1: bb.y1 + m };
    }
    // 1. junction geometry -> setbacks
    for (const n of nodes) this.buildJunction(n);
    // 2. lanes of every touched edge
    for (const e of edges) this.buildEdgeLanes(e);
    // 3. connections at every dirty node
    for (const n of nodes) this.buildConnections(n);
    for (const n of nodes) this.buildConflicts(n);
    for (const e of edges) e.geomVersion++;
    this.version++;
    const info = { nodes, edges, removed: this.removed };
    this.removed = freshRemoved();
    if (this.onRebuild) this.onRebuild(info);
    return info;
  }

  syncDirs(e) {
    const want = [e.lf, e.lb];
    const keys = ['dirF', 'dirB'];
    for (let k = 0; k < 2; k++) {
      let d = e[keys[k]];
      if (want[k] > 0 && !d) {
        d = new Dir(this.nextDir++, e, k === 0);
        e[keys[k]] = d;
      } else if (want[k] === 0 && d) {
        d.alive = false;
        this.removed.dirs.push(d);
        for (const l of d.lanes) {
          l.alive = false;
          this.removed.lanes.push(l);
          for (const c of l.inConns.concat(l.outConns)) this.killConn(c);
        }
        e[keys[k]] = null;
        d = null;
      }
      if (!d) continue;
      while (d.lanes.length < want[k]) d.lanes.push(new Lane(this.nextLane++, d, d.lanes.length));
      while (d.lanes.length > want[k]) {
        const l = d.lanes.pop();
        l.alive = false;
        this.removed.lanes.push(l);
        for (const c of l.inConns.concat(l.outConns)) this.killConn(c);
      }
    }
  }

  endsOf(node) {
    const out = [];
    for (const e of node.edges) {
      const atA = e.a === node;
      const t = atA ? e.poly.pointAt(0) : e.poly.pointAt(e.len);
      // use a short look-along for a stable tangent
      const look = Math.min(4, e.len / 2);
      const q = atA ? e.poly.pointAt(look) : e.poly.pointAt(e.len - look);
      let dx = q.x - node.x;
      let dy = q.y - node.y;
      const l = Math.hypot(dx, dy);
      if (l > 1e-6) {
        dx /= l;
        dy /= l;
      } else {
        dx = atA ? t.tx : -t.tx;
        dy = atA ? t.ty : -t.ty;
      }
      const at = (s, o) => {
        const p = e.poly.pointAt(atA ? s : e.len - s);
        o.x = p.x;
        o.y = p.y;
        o.dx = atA ? p.tx : -p.tx;
        o.dy = atA ? p.ty : -p.ty;
      };
      out.push({ edge: e, atA, dx, dy, ang: Math.atan2(dy, dx), h: e.halfWidth, at });
    }
    out.sort((p, q) => p.ang - q.ang);
    return out;
  }

  buildJunction(node) {
    const ends = this.endsOf(node);
    node.ends = ends;
    const j = computeJunction(node.x, node.y, ends, node.ring != null ? RING_FILLET : FILLET_R);
    node.geomVersion++;
    node.fill = j.pts.length ? { pts: j.pts, chains: j.chains } : null;
    for (let i = 0; i < ends.length; i++) {
      const e = ends[i].edge;
      if (ends[i].atA) e.setA = j.setbacks[i];
      else e.setB = j.setbacks[i];
    }
    if (ends.length === 2 && j.setbacks[0] < 0.01 && j.setbacks[1] < 0.01) {
      // straight continuation: no visible junction patch needed unless the widths differ
      if (ends[0].h === ends[1].h) node.fill = null;
    }
  }

  buildEdgeLanes(e) {
    const s0 = e.setA;
    const s1 = e.len - e.setB;
    e.invalid = s1 - s0 < MIN_LANE_LEN;
    const a = e.invalid ? Math.max(0, e.len / 2 - 3) : s0;
    const b = e.invalid ? Math.min(e.len, e.len / 2 + 3) : s1;
    const trimmed = e.poly.slice(a, b);
    e.trimmed = trimmed;
    const xm = e.xm;
    if (e.dirF) {
      for (const l of e.dirF.lanes) {
        const off = xm + (l.j + 0.5) * LANE_W;
        l.poly = trimmed.offset(off);
        l.len = l.poly.len;
        l.lo = off;
      }
    }
    if (e.dirB) {
      for (const l of e.dirB.lanes) {
        const off = xm - (l.j + 0.5) * LANE_W;
        l.poly = trimmed.offset(off).reverse();
        l.len = l.poly.len;
        l.lo = -off;
      }
    }
  }

  buildConnections(node) {
    for (const c of node.conns.slice()) {
      c.alive = false;
      this.removed.conns.push(c);
      if (c.from.outConns) c.from.outConns = c.from.outConns.filter((x) => x !== c);
      if (c.to.inConns) c.to.inConns = c.to.inConns.filter((x) => x !== c);
    }
    node.conns = [];
    const ins = [];
    const outs = [];
    for (const e of node.edges) {
      if (e.dirF) (e.b === node ? ins : outs).push(e.dirF);
      if (e.dirB) (e.a === node ? ins : outs).push(e.dirB);
    }
    for (const d of ins) {
      d.moves = new Map();
      d.next = [];
    }
    const deadEnd = node.edges.length === 1;
    const isRing = node.ring != null;

    for (const din of ins) {
      if (din.edge.invalid) continue;
      const tin = din.lanes[0].poly.pointAt(din.lanes[0].len);
      const angIn = Math.atan2(tin.ty, tin.tx);
      // classify every movement first so lane reservations can depend on what exists
      const moves = [];
      for (const dout of outs) {
        if (dout.edge.invalid) continue;
        if (din.edge === dout.edge && !deadEnd) continue;
        if (isRing && !din.edge.ring && !dout.edge.ring) continue;
        const tout = dout.lanes[0].poly.pointAt(0);
        const turn = angleDiff(angIn, Math.atan2(tout.ty, tout.tx));
        let type;
        if (din.edge === dout.edge) type = 'U';
        else if (isRing && din.edge.ring != null && dout.edge.ring != null) type = 'S'; // following the ring is "straight on"
        else if (Math.abs(turn) > 2.62) continue; // sharper than ~150 deg: not drivable
        else if (Math.abs(turn) <= 0.49) type = 'S';
        else type = turn > 0 ? 'L' : 'R';
        moves.push({ dout, type, turn });
      }
      const hasL = moves.some((m) => m.type === 'L');
      const hasR = moves.some((m) => m.type === 'R');
      const ni = din.lanes.length;
      for (const mv of moves) {
        const no = mv.dout.lanes.length;
        const pairs = [];
        const ringEntry = isRing && !din.edge.ring && mv.dout.edge.ring;
        const ringExit = isRing && din.edge.ring && !mv.dout.edge.ring;
        if (ringEntry) {
          for (let j = 0; j < ni; j++) pairs.push([j, Math.min(j + (no - ni > 0 ? no - ni : 0), no - 1)]);
        } else if (ringExit) {
          pairs.push([ni - 1, no - 1]);
          if (ni > 1) pairs.push([0, 0]);
        } else if (mv.type === 'S') {
          for (let j = 0; j < ni; j++) {
            if (ni >= 3 && j === 0 && hasL) continue;
            if (ni >= 3 && j === ni - 1 && hasR) continue;
            pairs.push([j, Math.min(j, no - 1)]);
          }
        } else if (mv.type === 'L') {
          pairs.push([0, 0]);
        } else if (mv.type === 'R') {
          pairs.push([ni - 1, no - 1]);
        } else {
          for (let j = 0; j < ni; j++) pairs.push([j, Math.min(j, no - 1)]);
        }
        for (const [a, b] of pairs) this.addConn(node, din.lanes[a], mv.dout.lanes[b], mv.type, din, mv.dout);
      }
      // every lane needs a way out
      for (let j = 0; j < ni; j++) {
        const lane = din.lanes[j];
        if (lane.outConns.length === 0 && moves.length) {
          const mv = moves.find((m) => m.type === 'S') || moves[0];
          this.addConn(node, lane, mv.dout.lanes[Math.min(j, mv.dout.lanes.length - 1)], mv.type, din, mv.dout);
        }
      }
    }
    for (const din of ins) din.next = [...din.moves.keys()];
  }

  addConn(node, from, to, type, din, dout) {
    const p0 = from.poly.pointAt(from.len);
    const p1 = to.poly.pointAt(0);
    const chord = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    let k;
    let poly;
    if (type === 'U') {
      k = 6.5;
      poly = cubicPoly(
        { x: p0.x, y: p0.y },
        { x: p0.x + p0.tx * k, y: p0.y + p0.ty * k },
        { x: p1.x - p1.tx * k, y: p1.y - p1.ty * k },
        { x: p1.x, y: p1.y },
        1.2,
      );
    } else if (chord < 0.05) {
      poly = new Poly([{ x: p0.x, y: p0.y }, { x: p0.x + p0.tx * 0.1, y: p0.y + p0.ty * 0.1 }]);
    } else {
      k = clamp(chord * 0.42, 1.2, 16);
      poly = cubicPoly(
        { x: p0.x, y: p0.y },
        { x: p0.x + p0.tx * k, y: p0.y + p0.ty * k },
        { x: p1.x - p1.tx * k, y: p1.y - p1.ty * k },
        { x: p1.x, y: p1.y },
        1.4,
      );
    }
    const c = new Conn(this.nextConn++, node, from, to, poly, type);
    const r = poly.minRadius();
    const vmax = Math.min(from.limit, to.limit);
    c.speed = type === 'U' ? 4.5 : Math.min(vmax, Math.max(4.5, Math.sqrt(3.2 * r)));
    c.rank = din.edge.ring ? 100 : CLASSES[din.edge.cls].rank * 10 + din.lanes.length;
    c.dinId = din.id;
    c.doutId = dout.id;
    from.outConns.push(c);
    to.inConns.push(c);
    node.conns.push(c);
    let list = din.moves.get(dout);
    if (!list) din.moves.set(dout, (list = []));
    list.push(c);
    return c;
  }

  /**
   * Pairwise conflicts (crossings and merges) between connections of one node.
   * Each entry describes the stretch [a0,a1] of my path and [b0,b1] of the other path where vehicles can collide.
   */
  buildConflicts(node) {
    const cs = node.conns;
    for (const c of cs) c.conflicts = [];
    for (let i = 0; i < cs.length; i++) {
      for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i];
        const b = cs[j];
        if (a.from === b.from) continue; // diverging from one lane: handled as followers
        let z;
        if (a.to === b.to) z = mergeZone(a, b);
        else {
          const hits = crossPolys(a.poly, b.poly);
          if (!hits) continue;
          const m = (0.95 + 0.5) / Math.max(hits.sin, 0.3);
          z = { a0: hits.sa - m, a1: hits.sa + m, b0: hits.sb - m, b1: hits.sb + m };
        }
        const rel = relation(a, b);
        a.conflicts.push({ other: b, a0: z.a0, a1: z.a1, b0: z.b0, b1: z.b1, rel });
        b.conflicts.push({ other: a, a0: z.b0, a1: z.b1, b0: z.a0, b1: z.a1, rel: -rel });
      }
    }
  }

  /* ---------- queries ---------- */

  /** Bounding box of an edge's roadway (computed lazily: new edges only get one on rebuild). */
  bboxOf(e) {
    if (!e.bbox) {
      const bb = e.poly.bbox();
      const m = e.halfWidth + 6;
      e.bbox = { x0: bb.x0 - m, y0: bb.y0 - m, x1: bb.x1 + m, y1: bb.y1 + m };
    }
    return e.bbox;
  }

  nearestEdge(x, y, maxD = 30, filter = null) {
    let best = null;
    let bd = maxD;
    const tmp = {};
    for (const e of this.edges.values()) {
      const bb = this.bboxOf(e);
      if (x < bb.x0 - maxD || x > bb.x1 + maxD || y < bb.y0 - maxD || y > bb.y1 + maxD) continue;
      if (filter && !filter(e)) continue;
      e.poly.closest(x, y, tmp);
      const d = tmp.d - e.halfWidth;
      if (d < bd) {
        bd = d;
        best = { edge: e, s: tmp.s, d: tmp.d, x: tmp.x, y: tmp.y, side: tmp.side, gap: d };
      }
    }
    return best;
  }

  nearestNode(x, y, maxD = 12, filter = null) {
    let best = null;
    let bd = maxD;
    for (const n of this.nodes.values()) {
      if (filter && !filter(n)) continue;
      const d = Math.hypot(n.x - x, n.y - y);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  /** Edges whose bbox overlaps the given box. */
  edgesInBox(x0, y0, x1, y1) {
    const out = [];
    for (const e of this.edges.values()) {
      const bb = this.bboxOf(e);
      if (bb.x1 < x0 || bb.x0 > x1 || bb.y1 < y0 || bb.y0 > y1) continue;
      out.push(e);
    }
    return out;
  }

  /* ---------- serialisation ---------- */

  toJSON() {
    const r2 = (v) => Math.round(v * 100) / 100;
    return {
      nodes: [...this.nodes.values()].map((n) => [n.id, r2(n.x), r2(n.y), n.z, n.ring]),
      edges: [...this.edges.values()].map((e) => [
        e.id,
        e.a.id,
        e.b.id,
        e.cls,
        e.lf,
        e.lb,
        e.ring,
        e.poly.points().map((p) => [r2(p.x), r2(p.y)]),
        Math.round(e.value),
      ]),
      roundabouts: [...this.roundabouts.entries()].map(([id, r]) => [id, r2(r.cx), r2(r.cy), r2(r.R)]),
      nextRing: this.nextRing,
    };
  }

  loadJSON(data) {
    for (const [id, x, y, z, ring] of data.nodes) {
      const n = this.addNode(x, y, z, id);
      n.ring = ring;
    }
    for (const [id, a, b, cls, lf, lb, ring, pts, value] of data.edges) {
      const poly = new Poly(pts.map(([x, y]) => ({ x, y })));
      const e = this.addEdge(this.nodes.get(a), this.nodes.get(b), poly, { cls, lf, lb, ring }, id);
      e.value = value || 0;
    }
    for (const [id, cx, cy, R] of data.roundabouts || []) this.roundabouts.set(id, { id, cx, cy, R });
    this.nextRing = data.nextRing || this.nextRing;
    return this.rebuild();
  }
}

/* ------------------------------------------------------------------ helpers */

function crossPolys(pa, pb) {
  for (let i = 0; i < pa.n - 1; i++) {
    for (let j = 0; j < pb.n - 1; j++) {
      const ax = pa.xs[i];
      const ay = pa.ys[i];
      const bx = pa.xs[i + 1];
      const by = pa.ys[i + 1];
      const cx = pb.xs[j];
      const cy = pb.ys[j];
      const dx = pb.xs[j + 1];
      const dy = pb.ys[j + 1];
      const rx = bx - ax;
      const ry = by - ay;
      const sx = dx - cx;
      const sy = dy - cy;
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
      const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
      if (t < 0 || t > 1 || u < 0 || u > 1) continue;
      const la = Math.hypot(rx, ry) || 1;
      const lb = Math.hypot(sx, sy) || 1;
      return {
        sa: pa.cum[i] + t * (pa.cum[i + 1] - pa.cum[i]),
        sb: pb.cum[j] + u * (pb.cum[j + 1] - pb.cum[j]),
        sin: Math.abs(rx * sy - ry * sx) / (la * lb),
      };
    }
  }
  return null;
}

/** Where two connections into the same lane are closer than a vehicle width, measured back from the merge point. */
function mergeZone(a, b) {
  const max = Math.min(a.len, b.len);
  let k = 0;
  const pa = {};
  const pb = {};
  for (; k < max; k += 0.5) {
    a.poly.pointAt(a.len - k, pa);
    b.poly.pointAt(b.len - k, pb);
    if (Math.hypot(pa.x - pb.x, pa.y - pb.y) > 2.7) break;
  }
  k = Math.max(k, 2);
  return { a0: a.len - k, a1: a.len, b0: b.len - k, b1: b.len };
}

const MOVE_RANK = { S: 3, R: 3, U: 1, L: 1 };

/** +1: a must yield to b, -1: b must yield to a, 0: first come first served. */
function relation(a, b) {
  if (a.rank !== b.rank) return a.rank < b.rank ? 1 : -1;
  const ma = MOVE_RANK[a.turn];
  const mb = MOVE_RANK[b.turn];
  if (a.to === b.to) {
    // merge: through traffic beats turning traffic, otherwise first come first served
    return ma === mb ? 0 : ma < mb ? 1 : -1;
  }
  if (ma !== mb) {
    // a left turn yields to opposing through traffic (approach roughly opposite)
    const ta = a.from.poly.pointAt(a.from.len);
    const tb = b.from.poly.pointAt(b.from.len);
    const dot = ta.tx * tb.tx + ta.ty * tb.ty;
    if (dot < -0.7) return ma < mb ? 1 : -1;
  }
  return 0;
}
