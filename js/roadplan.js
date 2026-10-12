// Turns tool input into validated network edits: plan -> validate -> apply.
// Covers roads (with snapping, crossings, ramps), roundabouts, lane edits, signals and bulldozing.

import { Poly, arcPoly, circlePoly, polyIntersections, segTouchesRect, distPointSeg, segIntersect } from './geom.js';
import { CLASSES, LANE_W, LEVEL_H, MIN_LANE_LEN, MAX_EDGE_LEN, RING_FILLET, computeJunction, replacementConn, splitMap } from './network.js';
import { Signal } from './signals.js';
import { clamp, smoothstep, TAU } from './util.js';

export const MIN_STUB = 20; // minimum distance between junction nodes along a road
export const MIN_GAP_ANGLE = 0.36; // ~20 degrees between neighbouring arms
export const MAX_SLOPE = 0.1;
export const MAX_LANES = { street: 2, avenue: 3, highway: 4 };
export const SIGNAL_COST = 1500;
export const ROUNDABOUT_BASE_COST = 600;
export const REFUND = 0.5;
const RING_MIN_LANE = 10; // ring segments shorter than this jam up

export const ERROR_TEXT = {
  too_short: 'Too short',
  too_sharp: 'Curve too sharp',
  water: 'Water in the way',
  rock: 'Rock in the way',
  bounds: 'Outside the map',
  building: 'A building is in the way',
  no_money: 'Not enough money',
  shallow_cross: 'Crossing angle too shallow',
  too_close: 'Too close to a junction',
  too_steep: 'Too steep',
  too_long: 'Too long',
  elevation_conflict: 'Clashes with another road at that height',
  self_overlap: 'The road overlaps itself',
  narrow_angle: 'Roads meet at too narrow an angle',
  ring_node: "Pick a spot between the roundabout's exits",
  same_node: 'Start and end are the same spot',
  complex: 'Too many roads cross here',
  elevated: 'A raised road is in the way',
  max_lanes: 'Already at the maximum number of lanes',
  min_lanes: 'A road needs at least one lane',
  bad_angle: 'Existing roads meet the ring at too shallow an angle',
  no_junction: 'Needs a junction (3 or more roads)',
  nothing: 'Nothing here',
};

const elevMult = (z) => 1 + 1.7 * z;
export const edgeCost = (len, lanes, cls, zAvg = 0) => len * lanes * CLASSES[cls].laneCost * elevMult(zAvg);

function endDesc(poly, atStart, h, tag) {
  const look = Math.min(4, poly.len / 2);
  const p0 = atStart ? poly.pointAt(0) : poly.pointAt(poly.len);
  const q = atStart ? poly.pointAt(look) : poly.pointAt(poly.len - look);
  let dx = q.x - p0.x;
  let dy = q.y - p0.y;
  const l = Math.hypot(dx, dy) || 1;
  dx /= l;
  dy /= l;
  return { dx, dy, ang: Math.atan2(dy, dx), h, tag };
}

function dirDesc(dx, dy, h, tag) {
  return { dx, dy, ang: Math.atan2(dy, dx), h, tag };
}

/** Junction setbacks for a hypothetical set of arms; returns {sb: tag->setback, minGap}. */
function virtualJunction(cx, cy, ends, fillet) {
  const sorted = ends.slice().sort((a, b) => a.ang - b.ang);
  const j = computeJunction(cx, cy, sorted, fillet);
  const sb = {};
  sorted.forEach((e, i) => (sb[e.tag] = j.setbacks[i]));
  let minGap = Infinity;
  if (sorted.length >= 2) {
    for (let i = 0; i < sorted.length; i++) {
      let g = sorted[(i + 1) % sorted.length].ang - sorted[i].ang;
      if (g <= 0) g += TAU;
      if (sorted.length === 2 && g > Math.PI) g = TAU - g;
      minGap = Math.min(minGap, g);
    }
  }
  return { sb, minGap };
}

/** Distance between two segments (0 when they cross). */
function segSegDist(ax, ay, bx, by, cx, cy, dx, dy) {
  if (segIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    distPointSeg(ax, ay, cx, cy, dx, dy),
    distPointSeg(bx, by, cx, cy, dx, dy),
    distPointSeg(cx, cy, ax, ay, bx, by),
    distPointSeg(dx, dy, ax, ay, bx, by),
  );
}

export class RoadPlanner {
  /** @param {{net:import('./network.js').Network, terrain:object, buildings:()=>Iterable<object>}} world */
  constructor(world) {
    this.world = world;
  }
  get net() {
    return this.world.net;
  }

  /* ------------------------------------------------------------ snapping */

  /**
   * Resolve a world point to a snap target.
   * opts: {elev, forEnd}. End points only snap to things at the pen's elevation.
   */
  snap(x, y, tol, opts = {}) {
    const { elev = 0, forEnd = false } = opts;
    const net = this.net;
    const okZ = (z) => !forEnd || Math.abs(z - elev) < 0.3;
    const n = net.nearestNode(x, y, tol, (nd) => okZ(nd.z) && (opts.allowRing || nd.ring == null));
    if (n) return { kind: 'node', x: n.x, y: n.y, node: n, z: n.z };
    const hit = net.nearestEdge(x, y, tol, (e) => okZ(e.zAt(0)) && okZ(e.zAt(e.len)) && !(opts.noRing && e.ring != null));
    if (hit) {
      const e = hit.edge;
      if (hit.s < MIN_STUB && !(e.a.ring != null && !opts.allowRing)) return { kind: 'node', x: e.a.x, y: e.a.y, node: e.a, z: e.a.z };
      if (e.len - hit.s < MIN_STUB && !(e.b.ring != null && !opts.allowRing)) return { kind: 'node', x: e.b.x, y: e.b.y, node: e.b, z: e.b.z };
      if (hit.s >= MIN_STUB && e.len - hit.s >= MIN_STUB) {
        return { kind: 'edge', x: hit.x, y: hit.y, edge: e, s: hit.s, z: e.zAt(hit.s) };
      }
    }
    return { kind: 'free', x, y, z: elev };
  }

  /* ------------------------------------------------------------ roads */

  /**
   * Plan a road piece from snap a to snap b.
   * p: {a, b, cls, lf, lb, straight}
   */
  planRoad(p) {
    const { a, b } = p;
    const net = this.net;
    const terrain = this.world.terrain;
    const lf = p.lf;
    const lb = p.lb;
    const h = ((lf + lb) * LANE_W) / 2;
    const cls = CLASSES[p.cls];
    const plan = { ok: false, error: null, cost: 0, poly: null, specs: [], pieces: [], lf, lb, cls: p.cls, a, b };
    const fail = (e) => {
      plan.error = e;
      return plan;
    };

    const chord = Math.hypot(b.x - a.x, b.y - a.y);
    // --- geometry
    let tangent = null;
    if (a.node && !p.straight && a.node.edges.length === 1) {
      const end = net.endsOf(a.node)[0];
      tangent = { tx: -end.dx, ty: -end.dy };
    }
    const straightPoly = () => new Poly([{ x: a.x, y: a.y }, { x: b.x, y: b.y }]);
    let poly;
    let radius = Infinity;
    if (tangent && chord > 1) {
      // continue smoothly from the road end; when the target needs a bend that is too tight (or points sideways or
      // backwards) build a straight piece with a corner at the road end instead of refusing
      const arc = arcPoly(a.x, a.y, tangent.tx, tangent.ty, b.x, b.y, 2.5);
      if (arc && arc.R >= Math.max(cls.minR, h + 6)) {
        poly = arc.poly;
        radius = arc.R;
      } else {
        poly = straightPoly();
        plan.corner = true;
      }
    } else {
      poly = straightPoly();
    }
    plan.poly = poly;
    plan.radius = radius;
    const len = poly.len;
    if (len < 16) return fail('too_short');
    if (a.node && a.node === b.node) return fail('same_node');
    if (radius < Math.max(cls.minR, h + 6)) return fail('too_sharp');

    // --- elevation profile
    const z0 = a.z;
    const z1 = b.z;
    const ramp = Math.abs(z1 - z0) > 0.01;
    if (ramp) {
      if ((Math.abs(z1 - z0) * LEVEL_H) / len > MAX_SLOPE) return fail('too_steep');
      if (len > 320) return fail('too_long');
    }
    const zAt = (s) => (ramp ? z0 + (z1 - z0) * smoothstep(0, 1, s / len) : z0);
    plan.zAt = zAt;

    // --- terrain
    for (let s = 0; s <= len + 0.01; s += 5) {
      const q = poly.pointAt(Math.min(s, len));
      if (zAt(s) < 0.9) {
        const blocked = terrain.blockedDisc(q.x, q.y, Math.min(h * 0.7, 4));
        if (blocked) return fail(blocked);
      } else if (!terrain.inside(q.x, q.y, 6)) return fail('bounds');
    }

    // --- buildings and driveways
    const bb = poly.bbox();
    for (const bd of this.world.buildings()) {
      if (bd.x < bb.x0 - 45 || bd.x > bb.x1 + 45 || bd.y < bb.y0 - 45 || bd.y > bb.y1 + 45) continue;
      for (let i = 0; i < poly.n - 1; i++) {
        const mid = (poly.cum[i] + poly.cum[i + 1]) / 2;
        if (zAt(mid) >= 0.9) continue;
        const ax = poly.xs[i];
        const ay = poly.ys[i];
        const bx = poly.xs[i + 1];
        const by = poly.ys[i + 1];
        if (segTouchesRect(ax, ay, bx, by, bd.rect, h + 1.0)) return fail('building');
        if (bd.drive && segSegDist(ax, ay, bx, by, bd.drive.x0, bd.drive.y0, bd.drive.x1, bd.drive.y1) < h + 1.7) {
          // allowed when this road merely snaps onto the road the driveway belongs to
          const owner = bd.acc && bd.acc.edge;
          const joins = (a.edge && a.edge === owner) || (b.edge && b.edge === owner);
          if (!joins) return fail('building');
        }
      }
    }

    // --- crossings with existing edges
    const crossings = [];
    const exempt = new Map(); // edge -> [{s, r}] places along the new road where being close is expected
    const addExempt = (e, s, r) => {
      if (!exempt.has(e)) exempt.set(e, []);
      exempt.get(e).push({ s, r });
    };
    for (const e of net.edgesInBox(bb.x0 - 4, bb.y0 - 4, bb.x1 + 4, bb.y1 + 4)) {
      const hits = polyIntersections(poly, e.poly);
      for (const hit of hits) {
        if (hit.sP < 0.8 || hit.sP > len - 0.8) continue;
        const zNew = zAt(hit.sP);
        const zOld = e.zAt(hit.sQ);
        const dz = Math.abs(zNew - zOld);
        if (dz >= 0.75) continue; // flyover
        if (dz > 0.25) return fail('elevation_conflict');
        if (Math.abs(hit.cosAngle) > 0.94) return fail('shallow_cross');
        if (hit.sQ < MIN_STUB || e.len - hit.sQ < MIN_STUB) return fail('too_close');
        if (hit.sP < MIN_STUB || len - hit.sP < MIN_STUB) return fail('too_close');
        crossings.push({ s: hit.sP, edge: e, sEdge: hit.sQ, x: hit.x, y: hit.y, z: Math.round(zOld * 1000) / 1000 });
        addExempt(e, hit.sP, 40);
      }
    }
    crossings.sort((p1, p2) => p1.s - p2.s);
    for (let i = 1; i < crossings.length; i++) if (crossings[i].s - crossings[i - 1].s < MIN_STUB) return fail('too_close');

    // --- node specs along the road
    const specs = [];
    const mk = (snap, s, role) => {
      if (snap.kind === 'node') return { s, kind: 'existing', node: snap.node, x: snap.node.x, y: snap.node.y, z: snap.node.z, role };
      if (snap.kind === 'edge') return { s, kind: 'split', edge: snap.edge, sEdge: snap.s, x: snap.x, y: snap.y, z: Math.round(snap.z * 1000) / 1000, role };
      return { s, kind: 'free', x: snap.x, y: snap.y, z: snap.z, role };
    };
    specs.push(mk(a, 0, 'start'));
    for (const c of crossings) specs.push({ s: c.s, kind: 'cross', edge: c.edge, sEdge: c.sEdge, x: c.x, y: c.y, z: c.z, role: 'mid' });
    specs.push(mk(b, len, 'end'));
    // subdivide long flat pieces
    if (!ramp) {
      const out = [specs[0]];
      for (let i = 1; i < specs.length; i++) {
        const gap = specs[i].s - specs[i - 1].s;
        if (gap > MAX_EDGE_LEN) {
          const n = Math.ceil(gap / MAX_EDGE_LEN);
          for (let k = 1; k < n; k++) {
            const s = specs[i - 1].s + (gap * k) / n;
            const q = poly.pointAt(s);
            out.push({ s, kind: 'sub', x: q.x, y: q.y, z: z0, role: 'mid' });
          }
        }
        out.push(specs[i]);
      }
      specs.length = 0;
      specs.push(...out);
    }
    for (let i = 1; i < specs.length; i++) if (specs[i].s - specs[i - 1].s < 14) return fail('too_short');

    // guard rails: do not attach to roundabout nodes, and endpoints must not sit on top of each other
    for (const sp of specs) if (sp.kind === 'existing' && sp.node.ring != null) return fail('ring_node');
    // endpoints near existing edges that are neither crossed nor snapped
    for (const sp of [specs[0], specs[specs.length - 1]]) {
      if (sp.kind === 'free') {
        const near = net.nearestEdge(sp.x, sp.y, 0.1);
        if (near && near.gap < h + 1.5 && Math.abs(near.edge.zAt(near.s) - sp.z) < 0.75) return fail('self_overlap');
      }
    }

    // --- parallel overlap check: sample along the new road
    for (let s = 6; s < len - 4; s += 6) {
      const q = poly.pointAt(s);
      const z = zAt(s);
      const near = net.nearestEdge(q.x, q.y, 0.5);
      if (!near) continue;
      const e = near.edge;
      if (Math.abs(e.zAt(near.s) - z) >= 0.75) continue;
      if (near.gap > h - 0.4) continue; // clear of the other roadway
      const ex = exempt.get(e);
      if (ex && ex.some((r) => Math.abs(r.s - s) < r.r)) continue;
      // near the snapped ends of the incident edges
      const endNodes = [specs[0], specs[specs.length - 1]];
      let ok = false;
      for (const sp of endNodes) {
        const incident = sp.kind === 'existing' ? sp.node.edges.includes(e) : sp.kind === 'split' ? sp.edge === e : false;
        if (incident && Math.abs(sp.s - s) < 42) ok = true;
      }
      if (!ok) return fail('self_overlap');
    }

    // --- junction geometry at every node
    const nodeSb = specs.map(() => ({}));
    const fwd = (s) => {
      const t = poly.pointAt(s);
      return { dx: t.tx, dy: t.ty };
    };
    for (let i = 0; i < specs.length; i++) {
      const sp = specs[i];
      const ends = [];
      const f = fwd(sp.s);
      if (sp.role === 'start') ends.push(dirDesc(f.dx, f.dy, h, 'next'));
      else if (sp.role === 'end') ends.push(dirDesc(-f.dx, -f.dy, h, 'prev'));
      else {
        ends.push(dirDesc(f.dx, f.dy, h, 'next'));
        ends.push(dirDesc(-f.dx, -f.dy, h, 'prev'));
      }
      if (sp.kind === 'existing') {
        for (const e of net.endsOf(sp.node)) ends.push({ dx: e.dx, dy: e.dy, ang: e.ang, h: e.h, tag: 'old:' + e.edge.id });
      } else if (sp.kind === 'split' || sp.kind === 'cross') {
        const t = sp.edge.poly.pointAt(sp.sEdge);
        ends.push(dirDesc(-t.tx, -t.ty, sp.edge.halfWidth, 'halfA'));
        ends.push(dirDesc(t.tx, t.ty, sp.edge.halfWidth, 'halfB'));
      }
      if (sp.kind === 'sub' || (ends.length === 2 && sp.kind !== 'existing' && sp.kind !== 'split')) {
        nodeSb[i] = { next: 0, prev: 0 };
        continue;
      }
      const vj = virtualJunction(sp.x, sp.y, ends);
      if (ends.length >= 2 && vj.minGap < MIN_GAP_ANGLE) return fail('narrow_angle');
      nodeSb[i] = vj.sb;
      // existing edges must still fit
      if (sp.kind === 'existing') {
        for (const e of sp.node.edges) {
          const other = e.a === sp.node ? e.setB : e.setA;
          if (e.len - other - vj.sb['old:' + e.id] < MIN_LANE_LEN) return fail('too_short');
        }
      } else if (sp.kind === 'split' || sp.kind === 'cross') {
        if (sp.sEdge - sp.edge.setA - vj.sb.halfA < MIN_LANE_LEN) return fail('too_close');
        if (sp.edge.len - sp.sEdge - sp.edge.setB - vj.sb.halfB < MIN_LANE_LEN) return fail('too_close');
      }
    }
    // pieces fit between their junction patches
    let cost = 0;
    const pieces = [];
    for (let i = 0; i < specs.length - 1; i++) {
      const L = specs[i + 1].s - specs[i].s;
      const sA = nodeSb[i].next || 0;
      const sB = nodeSb[i + 1].prev || 0;
      if (L - sA - sB < MIN_LANE_LEN) return fail('too_short');
      const zAvg = (zAt(specs[i].s) + zAt(specs[i + 1].s)) / 2;
      const c = edgeCost(L, lf + lb, p.cls, zAvg);
      cost += c;
      pieces.push({ i, s0: specs[i].s, s1: specs[i + 1].s, len: L, cost: c });
    }
    plan.specs = specs;
    plan.pieces = pieces;
    plan.cost = cost;
    plan.ok = true;
    return plan;
  }

  /**
   * The edge that currently carries a point of a split-up edge. Edges created earlier in the same apply have no
   * bounding box yet (that is computed on rebuild), so search by distance instead of through nearestEdge().
   */
  findLive(edge, x, y) {
    if (edge.alive) return edge;
    let best = null;
    let bd = 1.0;
    const tmp = {};
    for (const e of this.net.edges.values()) {
      e.poly.closest(x, y, tmp);
      if (tmp.d < bd) {
        bd = tmp.d;
        best = e;
      }
    }
    return best;
  }

  /** Commit a valid plan. Returns {nodes, edges} that were created/used. */
  applyRoad(plan) {
    const net = this.net;
    const nodes = [];
    for (const sp of plan.specs) {
      let node;
      if (sp.kind === 'existing') node = sp.node;
      else if (sp.kind === 'free' || sp.kind === 'sub') node = net.addNode(sp.x, sp.y, sp.z);
      else {
        const e = this.findLive(sp.edge, sp.x, sp.y);
        if (!e) throw new Error('road plan refers to an edge that no longer exists');
        const s = e.poly.closest(sp.x, sp.y).s;
        node = net.splitEdge(e, s).node;
        node.z = sp.z;
      }
      nodes.push(node);
    }
    const edges = [];
    for (const pc of plan.pieces) {
      const poly = plan.poly.slice(pc.s0, pc.s1);
      const edge = net.addEdge(nodes[pc.i], nodes[pc.i + 1], poly, { lf: plan.lf, lb: plan.lb, cls: plan.cls });
      edge.value = pc.cost;
      edges.push(edge);
    }
    const info = net.rebuild();
    this.fixSignals(info);
    return { nodes, edges, info };
  }

  /** After a rebuild, keep signal phases in sync with the junctions. */
  fixSignals(info) {
    const map = splitMap(info);
    for (const n of info.nodes) {
      if (!n.alive || !n.signal) continue;
      if (n.edges.length < 3 || n.ring != null) n.signal = null;
      else n.signal.rebuildPhases(this.keyRenames(info, n, map));
    }
  }

  /** Old movement key -> new key, for movements whose road was split into pieces next to this junction. */
  keyRenames(info, node, map) {
    if (!map.size) return null;
    const out = new Map();
    for (const c of info.removed.conns) {
      if (c.node !== node) continue;
      const rep = replacementConn(c, map);
      if (rep && rep.conn.moveKey !== c.moveKey) out.set(c.moveKey, rep.conn.moveKey);
    }
    return out;
  }

  /* ------------------------------------------------------------ lanes */

  /** side: +1 right of a->b (forward lanes), -1 left (backward). delta: +1 add, -1 remove. */
  planLane(edge, side, delta) {
    const plan = { ok: false, error: null, cost: 0, edge, side, delta };
    const fail = (e) => {
      plan.error = e;
      return plan;
    };
    const lf = edge.lf + (side > 0 ? delta : 0);
    const lb = edge.lb + (side < 0 ? delta : 0);
    if (edge.ring != null && (side < 0 || lf > 2)) return fail('max_lanes');
    if (lf < 0 || lb < 0 || lf > MAX_LANES[edge.cls] || lb > MAX_LANES[edge.cls]) return fail(delta > 0 ? 'max_lanes' : 'min_lanes');
    if (lf + lb === 0) return fail('min_lanes');
    plan.lf = lf;
    plan.lb = lb;
    if (delta > 0) {
      const h = ((lf + lb) * LANE_W) / 2;
      const poly = edge.poly;
      for (const bd of this.world.buildings()) {
        if (bd.x < edge.bbox.x0 - 30 || bd.x > edge.bbox.x1 + 30 || bd.y < edge.bbox.y0 - 30 || bd.y > edge.bbox.y1 + 30) continue;
        for (let i = 0; i < poly.n - 1; i++) {
          if (segTouchesRect(poly.xs[i], poly.ys[i], poly.xs[i + 1], poly.ys[i + 1], bd.rect, h + 0.4)) return fail('building');
        }
      }
      for (let s = 0; s <= poly.len; s += 6) {
        const q = poly.pointAt(s);
        if (edge.zAt(s) < 0.9) {
          const blocked = this.world.terrain.blockedDisc(q.x, q.y, h * 0.6);
          if (blocked) return fail(blocked);
        }
      }
    }
    // junction fit at both ends with the new width
    const h2 = ((lf + lb) * LANE_W) / 2;
    for (const node of [edge.a, edge.b]) {
      const ends = this.net.endsOf(node).map((e) => ({ dx: e.dx, dy: e.dy, ang: e.ang, h: e.edge === edge ? h2 : e.h, tag: 'old:' + e.edge.id }));
      const vj = virtualJunction(node.x, node.y, ends);
      for (const e of node.edges) {
        const other = e.a === node ? e.setB : e.setA;
        const own = vj.sb['old:' + e.id];
        // the edge being widened also changes at its far end: approximate with its current setback there
        if (e.len - other - own < MIN_LANE_LEN) return fail('too_short');
      }
    }
    const per = edge.len * CLASSES[edge.cls].laneCost * elevMult((edge.a.z + edge.b.z) / 2);
    plan.cost = delta > 0 ? per : -per * REFUND;
    plan.ok = true;
    return plan;
  }

  applyLane(plan) {
    const e = plan.edge;
    this.net.setLanes(e, plan.lf, plan.lb);
    e.value = Math.max(0, e.value + (plan.delta > 0 ? plan.cost : plan.cost / REFUND));
    const info = this.net.rebuild();
    this.fixSignals(info);
    return info;
  }

  /* ------------------------------------------------------------ signals */

  toggleSignal(node) {
    if (node.ring != null || node.edges.length < 3) return { ok: false, error: 'no_junction' };
    if (node.signal) {
      node.signal = null;
      return { ok: true, removed: true, cost: -SIGNAL_COST * REFUND };
    }
    node.signal = new Signal(node);
    return { ok: true, removed: false, cost: SIGNAL_COST };
  }

  /* ------------------------------------------------------------ bulldozing */

  /** Remove an edge (or the whole roundabout when it is a ring arc). Returns refund and info. */
  removeEdge(edge) {
    const net = this.net;
    const list = [];
    if (edge.ring != null) {
      for (const e of net.edges.values()) if (e.ring === edge.ring) list.push(e);
      net.roundabouts.delete(edge.ring);
    } else list.push(edge);
    let refund = 0;
    const nodes = new Set();
    for (const e of list) {
      refund += e.value * REFUND;
      nodes.add(e.a);
      nodes.add(e.b);
      net.removeEdge(e);
    }
    for (const n of nodes) {
      if (n.ring != null && !net.roundabouts.has(n.ring)) n.ring = null;
      net.removeNodeIfOrphan(n);
    }
    const info = net.rebuild();
    this.fixSignals(info);
    return { refund, info };
  }

  /* ------------------------------------------------------------ roundabouts */

  /**
   * Plan a roundabout of centre-line radius R around (x,y). Existing roads that enter the circle are trimmed
   * to it and joined to the ring; a node (junction) near the centre is absorbed.
   */
  planRoundabout({ x, y, R, lanes = 1, cls = 'street' }) {
    const net = this.net;
    const terrain = this.world.terrain;
    const plan = { ok: false, error: null, cost: 0, cx: x, cy: y, R, lanes, cls, arms: [], ringNodes: [], drops: [], refund: 0 };
    const fail = (e, detail) => {
      plan.error = e;
      plan.detail = detail;
      return plan;
    };
    const near = net.nearestNode(x, y, 6, (n) => n.ring == null && n.z < 0.1);
    if (near) {
      plan.cx = x = near.x;
      plan.cy = y = near.y;
    }
    const ringH = (lanes * LANE_W) / 2;
    if (R < 11) return fail('too_short');
    // affected edges
    const drops = new Set();
    const arms = []; // {edge, keepFrom:'a'|'b', sCut, ...}
    const hits = [];
    for (const e of net.edgesInBox(x - R - 12, y - R - 12, x + R + 12, y + R + 12)) {
      const cl = e.poly.closest(x, y);
      if (cl.d >= R - 0.3) continue;
      if (e.elevated) {
        if (e.a.z > 0.9 && e.b.z > 0.9) continue; // a flyover passes above
        return fail('elevated');
      }
      if (e.ring != null) return fail('complex');
      const da = Math.hypot(e.a.x - x, e.a.y - y);
      const db = Math.hypot(e.b.x - x, e.b.y - y);
      const aIn = da < R - 0.3;
      const bIn = db < R - 0.3;
      const crossings = this.circleCrossings(e.poly, x, y, R);
      if (aIn && bIn) {
        drops.add(e);
      } else if (aIn && !bIn) {
        if (crossings.length !== 1) return fail('complex');
        arms.push({ edge: e, side: 'b', sCut: crossings[0] });
        drops.add(e);
      } else if (!aIn && bIn) {
        if (crossings.length !== 1) return fail('complex');
        arms.push({ edge: e, side: 'a', sCut: crossings[0] });
        drops.add(e);
      } else {
        if (crossings.length !== 2) return fail('complex');
        arms.push({ edge: e, side: 'a', sCut: crossings[0] });
        arms.push({ edge: e, side: 'b', sCut: crossings[1] });
        drops.add(e);
      }
    }
    // nodes inside the circle must only touch dropped edges
    const innerNodes = new Set();
    for (const n of net.nodes.values()) {
      if (Math.hypot(n.x - x, n.y - y) < R - 0.3) {
        if (n.ring != null) return fail('complex');
        innerNodes.add(n);
      }
    }
    for (const n of innerNodes) for (const e of n.edges) if (!drops.has(e)) return fail('complex');

    // terrain / buildings under the ring band
    for (let a = 0; a < TAU; a += 0.09) {
      const px = x + Math.cos(a) * R;
      const py = y + Math.sin(a) * R;
      const blocked = terrain.blockedDisc(px, py, ringH);
      if (blocked) return fail(blocked);
    }
    for (const bd of this.world.buildings()) {
      if (Math.hypot(bd.x - x, bd.y - y) > R + 40) continue;
      let prev = null;
      for (let a = 0; a <= TAU + 0.01; a += 0.12) {
        const px = x + Math.cos(a) * R;
        const py = y + Math.sin(a) * R;
        if (prev && segTouchesRect(prev[0], prev[1], px, py, bd.rect, ringH + 1.0)) return fail('building', `${bd.type} #${bd.id} at ${bd.x.toFixed(0)},${bd.y.toFixed(0)}`);
        prev = [px, py];
      }
    }

    // ring nodes (angle, position) from arm cuts
    const ringNodes = arms.map((arm) => {
      const poly = arm.edge.poly;
      const q = poly.pointAt(arm.sCut);
      const ang = Math.atan2(q.y - y, q.x - x);
      arm.ang = ang;
      return { ang, x: x + Math.cos(ang) * R, y: y + Math.sin(ang) * R, arm };
    });
    ringNodes.sort((p, q) => p.ang - q.ang);
    // fill so there are at least 3 nodes and no gap above 130 degrees
    const maxGap = (130 * Math.PI) / 180;
    const gapAfter = (list, i) => {
      const nx = list[(i + 1) % list.length];
      let g = nx.ang - list[i].ang;
      if (g <= 0) g += TAU;
      return list.length === 1 ? TAU : g;
    };
    if (ringNodes.length === 0) {
      for (let k = 0; k < 4; k++) ringNodes.push({ ang: -Math.PI + (k * TAU) / 4 + Math.PI / 4, x: 0, y: 0, arm: null });
    }
    for (let guard = 0; guard < 12; guard++) {
      let worst = -1;
      let wg = 0;
      for (let i = 0; i < ringNodes.length; i++) {
        const g = gapAfter(ringNodes, i);
        if (g > wg) {
          wg = g;
          worst = i;
        }
      }
      if (ringNodes.length >= 3 && wg <= maxGap) break;
      const a = ringNodes[worst].ang + wg / 2;
      ringNodes.splice(worst + 1, 0, { ang: a, x: 0, y: 0, arm: null });
    }
    for (const rn of ringNodes) {
      rn.x = x + Math.cos(rn.ang) * R;
      rn.y = y + Math.sin(rn.ang) * R;
    }
    // arm geometry (outward from the ring)
    const armEdges = [];
    for (const arm of arms) {
      const e = arm.edge;
      const poly = arm.side === 'a' ? e.poly.slice(0, arm.sCut) : e.poly.slice(arm.sCut, e.len);
      if (poly.len < MIN_STUB * 0.7) return fail('too_close', `arm ${arm.edge.id} only ${poly.len.toFixed(1)} m long after trimming`);
      // arms keep their original orientation; the ring end is the cut
      const armHalf = e.halfWidth;
      // direction check (radial)
      const atRingEnd = arm.side === 'a'; // for the 'a' piece the cut is at its end
      const tdesc = endDesc(poly, !atRingEnd, armHalf, 'arm');
      const radial = Math.atan2(Math.sin(arm.ang), Math.cos(arm.ang));
      const cosRad = tdesc.dx * Math.cos(radial) + tdesc.dy * Math.sin(radial);
      if (cosRad < 0.55) return fail('bad_angle');
      arm.poly = poly;
      arm.half = armHalf;
      arm.outward = tdesc;
      armEdges.push(arm);
    }
    // junction fit at ring nodes
    const k = ringNodes.length;
    const arcLens = [];
    for (let i = 0; i < k; i++) {
      let g = ringNodes[(i + 1) % k].ang - ringNodes[i].ang;
      if (g <= 0) g += TAU;
      arcLens.push(g * R);
    }
    const sbs = [];
    for (let i = 0; i < k; i++) {
      const rn = ringNodes[i];
      const tang = { dx: -Math.sin(rn.ang), dy: Math.cos(rn.ang) }; // CCW tangent
      const ends = [dirDesc(tang.dx, tang.dy, ringH, 'out'), dirDesc(-tang.dx, -tang.dy, ringH, 'in')];
      if (rn.arm) ends.push({ ...rn.arm.outward, tag: 'arm' });
      const vj = virtualJunction(rn.x, rn.y, ends, RING_FILLET);
      if (vj.minGap < MIN_GAP_ANGLE) return fail('narrow_angle');
      sbs.push(vj.sb);
      if (rn.arm) {
        const e = rn.arm.edge;
        const other = rn.arm.side === 'a' ? e.setA : e.setB; // far end of the kept piece
        if (rn.arm.poly.len - other - vj.sb.arm < MIN_LANE_LEN) return fail('too_close', `arm ${e.id}: len ${rn.arm.poly.len.toFixed(1)} - far setback ${other.toFixed(1)} - ring setback ${vj.sb.arm.toFixed(1)}`);
      }
    }
    for (let i = 0; i < k; i++) {
      if (arcLens[i] - sbs[i].out - sbs[(i + 1) % k].in < RING_MIN_LANE) return fail('too_short');
    }

    // cost
    // only the stretch of road inside the circle goes away (half refunded); the trimmed arms carry on with their share of the value
    const ringCost = ROUNDABOUT_BASE_COST + TAU * R * lanes * CLASSES[cls].laneCost;
    const kept = new Map();
    for (const arm of armEdges) kept.set(arm.edge, (kept.get(arm.edge) || 0) + arm.edge.value * (arm.poly.len / arm.edge.len));
    let refund = 0;
    for (const e of drops) refund += Math.max(0, e.value - (kept.get(e) || 0)) * REFUND;
    plan.arms = armEdges;
    plan.drops = [...drops];
    plan.innerNodes = [...innerNodes];
    plan.ringNodes = ringNodes;
    plan.cost = ringCost - refund;
    plan.refund = refund;
    plan.ok = true;
    return plan;
  }

  /** Arc lengths (sorted) where poly crosses the circle of radius R around (cx,cy). */
  circleCrossings(poly, cx, cy, R) {
    const out = [];
    for (let i = 1; i < poly.n; i++) {
      // solve |P0 + t*D - C|^2 = R^2 on each segment, so a long straight piece with both ends outside is still caught
      const x0 = poly.xs[i - 1] - cx;
      const y0 = poly.ys[i - 1] - cy;
      const dx = poly.xs[i] - poly.xs[i - 1];
      const dy = poly.ys[i] - poly.ys[i - 1];
      const a = dx * dx + dy * dy;
      if (a < 1e-12) continue;
      const b = x0 * dx + y0 * dy;
      const disc = b * b - a * (x0 * x0 + y0 * y0 - R * R);
      if (disc <= 1e-9) continue; // misses the circle, or only grazes it
      const root = Math.sqrt(disc);
      const last = i === poly.n - 1;
      for (const t of [(-b - root) / a, (-b + root) / a]) {
        // [0,1): a vertex lying exactly on the circle belongs to the segment that starts there
        if (t >= 0 && (t < 1 || (last && t <= 1))) out.push(poly.cum[i - 1] + t * (poly.cum[i] - poly.cum[i - 1]));
      }
    }
    return out;
  }

  applyRoundabout(plan) {
    const net = this.net;
    const { cx, cy, R, lanes } = plan;
    const id = net.nextRing++;
    // collect the data we need from edges that are about to disappear
    const armInfo = plan.arms.map((arm) => ({
      poly: arm.poly,
      side: arm.side,
      // the kept piece [0,cut] still starts at edge.a, the kept piece [cut,len] still ends at edge.b
      other: arm.side === 'a' ? arm.edge.a : arm.edge.b,
      opts: { lf: arm.edge.lf, lb: arm.edge.lb, cls: arm.edge.cls },
      value: arm.edge.value * (arm.poly.len / arm.edge.len),
      ang: arm.ang,
      ref: arm,
    }));
    const touched = new Set();
    for (const e of plan.drops) {
      touched.add(e.a);
      touched.add(e.b);
      net.removeEdge(e);
    }
    // ring nodes
    const rn = plan.ringNodes.map((r) => {
      const n = net.addNode(r.x, r.y, 0);
      n.ring = id;
      return n;
    });
    const k = rn.length;
    const cls = lanes > 1 ? 'avenue' : 'street';
    const ringEdges = [];
    for (let i = 0; i < k; i++) {
      let a0 = plan.ringNodes[i].ang;
      let a1 = plan.ringNodes[(i + 1) % k].ang;
      if (a1 <= a0) a1 += TAU;
      const poly = circlePoly(cx, cy, R, a0, a1, 2);
      const e = net.addEdge(rn[i], rn[(i + 1) % k], poly, { lf: lanes, lb: 0, cls, ring: id });
      e.value = (poly.len * lanes * CLASSES[cls].laneCost) + ROUNDABOUT_BASE_COST / k;
      ringEdges.push(e);
    }
    // arms
    for (const a of armInfo) {
      const idx = plan.ringNodes.findIndex((r) => r.arm === a.ref);
      const ringNode = rn[idx];
      // the cut end of the kept piece attaches to the ring node
      const poly = a.poly;
      if (a.side === 'a') {
        const e = net.addEdge(a.other, ringNode, poly, a.opts);
        e.value = a.value;
      } else {
        const e = net.addEdge(ringNode, a.other, poly, a.opts);
        e.value = a.value;
      }
    }
    net.roundabouts.set(id, { id, cx, cy, R });
    // nodes that lost every edge (the old junction inside the circle) can go now that the arms are re-attached
    for (const n of touched) net.removeNodeIfOrphan(n);
    const info = net.rebuild();
    this.fixSignals(info);
    return { id, nodes: rn, edges: ringEdges, info };
  }
}
