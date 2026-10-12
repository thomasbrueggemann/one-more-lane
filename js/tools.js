// Interaction tools. Every tool speaks in terms of pointer events {x,y (world), sx,sy (screen px), type, button}
// so mouse, touch and pen behave the same:
//   press = start / anchor, drag = adjust, release = commit. A click without dragging sets an anchor and the next
//   click commits (tap-tap), which is how mouse users usually draw.

import { ERROR_TEXT, MIN_STUB, MAX_LANES } from './roadplan.js';
import { LANE_W, CLASSES } from './network.js';
import { angleDiff, clamp, fmtMoney } from './util.js';
import { BUILDING_TYPES } from './buildings.js';
import { pointInRect } from './geom.js';
import { pickMovement } from './signaledit.js';

const DRAG_PX = 9;
const TOUCH_LIFT_PX = 62; // placement ghosts sit above the finger so you can see them

const PLACE_TEXT = {
  no_road: 'Place it next to a street',
  overlap: 'Something is in the way',
  terrain: 'Cannot build on water or rock',
  road: 'Too close to a road',
  too_short: 'Road piece too short here',
  tray_empty: 'None left to place',
};

export const ROAD_DEFAULT_LANES = { street: 1, avenue: 2, highway: 3 };

/** Planner error code -> text for the player; `because` lower-cases it to follow "Cannot create road:". */
const reason = (code) => ERROR_TEXT[code] || code;
const because = (code) => {
  const t = reason(code);
  return t.charAt(0).toLowerCase() + t.slice(1);
};

class Tool {
  constructor(app) {
    this.app = app;
    this.drag = null; // set to 'pan' for tools that let one finger pan
  }
  get game() {
    return this.app.game;
  }
  get planner() {
    return this.app.game.planner;
  }
  activate() {}
  deactivate() {
    this.app.overlay.clear();
    this.app.hideTip();
  }
  cancel() {}
  /** A gesture was interrupted (second finger, cancelled pointer): drop the press without committing. */
  abort() {
    this.lift();
  }
  /** A finger came up and points at nothing any more: drop previews that only make sense under a cursor. */
  lift() {}
  /** The mouse left the map (onto a toolbar, say): hover previews have nothing to point at. */
  deactivateHover() {
    this.lift();
  }
  hover() {}
  down() {}
  move() {}
  up() {}
  refresh() {}
  /** screen px -> metres */
  tol(px) {
    return px / this.app.view.ppm;
  }
}

/* ------------------------------------------------------------------ hand */

export class HandTool extends Tool {
  constructor(app) {
    super(app);
    this.id = 'hand';
    this.drag = 'pan';
  }
  tap(pt) {
    const ui = this.app.ui;
    if (ui.sig && ui.sig.node.signal) {
      // inside the traffic light editor a tap on an arrow moves that movement into the selected phase
      const c = pickMovement(ui.sig.node, pt.x, pt.y, Math.max(2.6, this.tol(18)));
      if (c) {
        ui.editMovement(c.moveKey);
        return;
      }
    }
    for (const b of this.game.city.list) {
      if (pointInRect(pt.x, pt.y, b.rect, 2)) {
        this.app.ui.showBuildingInfo(b);
        return;
      }
    }
    this.app.ui.hideInfo();
  }
}

/* ------------------------------------------------------------------ road */

export class RoadTool extends Tool {
  constructor(app) {
    super(app);
    this.id = 'road';
    this.pen = null;
    this.plan = null;
    this.downAt = null;
    this.moved = false;
    this.justSet = false;
    this.end = null;
    this.guide = null;
  }

  activate() {
    this.cancel();
  }

  cancel() {
    this.pen = null;
    this.plan = null;
    this.end = null;
    this.guide = null;
    this.downAt = null;
    this.app.overlay.clear();
    this.app.hideTip();
    this.app.ui.updateToolState();
  }

  abort() {
    // A pinch starts with one finger landing a moment before the other: if that press had only just set the anchor,
    // take it back so zooming does not leave a stray start point behind.
    if (this.justSet && this.pen) {
      this.pen = null;
      this.plan = null;
      this.end = null;
      this.guide = null;
      this.app.overlay.clear();
      this.app.hideTip();
      this.app.ui.updateToolState();
    }
    this.downAt = null;
    this.justSet = false;
    this.ending = false;
    this.moved = false;
  }

  /** Called by the UI "Done" button. */
  finish() {
    this.cancel();
  }

  deactivateHover() {
    // the anchor stays; the next hover over the map draws the preview again
    this.app.overlay.clear();
    this.app.hideTip();
  }

  get active() {
    return !!this.pen;
  }

  lanes() {
    const o = this.app.opts;
    const n = o.lanes[o.cls];
    return o.oneWay ? { lf: n, lb: 0 } : { lf: n, lb: n };
  }

  snapStart(pt) {
    const tol = clamp(this.tol(24), 7, 26);
    return this.planner.snap(pt.x, pt.y, tol, { elev: this.app.opts.elev });
  }

  snapEnd(pt) {
    const tol = clamp(this.tol(24), 7, 26);
    const s = this.planner.snap(pt.x, pt.y, tol, { elev: this.app.opts.elev, forEnd: true });
    this.guide = null;
    if (s.kind !== 'free' || !this.pen) return s;
    return this.guideSnap(s);
  }

  /** Snap the free end to axes / parallel / perpendicular directions relative to the road at the pen. */
  guideSnap(s) {
    const pen = this.pen;
    const dx = s.x - pen.x;
    const dy = s.y - pen.y;
    const d = Math.hypot(dx, dy);
    if (d < 8) return s;
    const ang = Math.atan2(dy, dx);
    const cands = [];
    for (let k = 0; k < 4; k++) cands.push({ ang: (k * Math.PI) / 2, kind: 'Axis', ref: null });
    const refs = [];
    if (pen.node) for (const e of this.game.net.endsOf(pen.node)) refs.push(e.ang);
    if (pen.edge) {
      const t = pen.edge.poly.pointAt(pen.s);
      refs.push(Math.atan2(t.ty, t.tx));
    }
    for (const r of refs) {
      cands.push({ ang: r, kind: 'Parallel', ref: r });
      cands.push({ ang: r + Math.PI, kind: 'Parallel', ref: r });
      cands.push({ ang: r + Math.PI / 2, kind: 'Perpendicular', ref: r });
      cands.push({ ang: r - Math.PI / 2, kind: 'Perpendicular', ref: r });
    }
    let best = null;
    let bd = 0.075; // ~4.3 degrees
    for (const c of cands) {
      const diff = Math.abs(angleDiff(ang, c.ang));
      if (diff < bd) {
        bd = diff;
        best = c;
      }
    }
    // reference angle for the on-screen angle readout
    let ref = refs.length ? refs[0] : 0;
    if (refs.length) {
      let m = 9;
      for (const r of refs) {
        const df = Math.abs(angleDiff(ang, r));
        const df2 = Math.abs(angleDiff(ang, r + Math.PI));
        const dd = Math.min(df, df2);
        if (dd < m) {
          m = dd;
          ref = r;
        }
      }
    }
    if (best) {
      this.guide = { ang: best.ang, kind: best.kind, ref };
      return { ...s, x: pen.x + Math.cos(best.ang) * d, y: pen.y + Math.sin(best.ang) * d };
    }
    this.guide = { ang, kind: null, ref };
    return s;
  }

  makePlan(end) {
    const { lf, lb } = this.lanes();
    return this.planner.planRoad({ a: this.pen, b: end, cls: this.app.opts.cls, lf, lb, straight: this.app.opts.straight });
  }

  refresh() {
    if (this.pen && this.end) this.preview(this.end, this.lastPt);
  }

  hover(pt) {
    this.lastPt = pt;
    if (this.pen) {
      this.end = this.snapEnd(pt);
      this.preview(this.end, pt);
      return;
    }
    // no anchor yet: show what would be snapped
    const s = this.snapStart(pt);
    const o = this.app.overlay;
    o.reset();
    this.drawSnapMarker(s);
    this.drawCrosshair(s);
    o.commit();
    const chips = [];
    if (this.app.opts.elev > 0) chips.push({ t: `Elevation: ${this.app.opts.elev}` });
    if (s.kind === 'node') chips.push({ t: 'Connect' });
    else if (s.kind === 'edge') chips.push({ t: 'Branch off' });
    this.app.tip(chips, pt.sx, pt.sy);
  }

  drawSnapMarker(s) {
    const th = this.app.theme;
    const o = this.app.overlay;
    const r = Math.max(1.6, 7 / this.app.view.ppm);
    if (s.kind === 'node') o.ring(s.x, s.y, r * 1.3, r * 0.25, th.ghostCasing);
    else if (s.kind === 'edge') o.disc(s.x, s.y, r * 0.8, th.ghostCasing);
    else o.disc(s.x, s.y, r * 0.55, th.ghostCasing);
  }

  drawCrosshair(s) {
    const o = this.app.overlay;
    const w = 1.3 / this.app.view.ppm;
    const L = 46 / this.app.view.ppm;
    const col = [0.45, 0.45, 0.5, 0.55];
    const d = 7 / this.app.view.ppm;
    o.dashed(s.x - L, s.y, s.x + L, s.y, w, d, d, col);
    o.dashed(s.x, s.y - L, s.x, s.y + L, w, d, d, col);
  }

  preview(end, pt) {
    const th = this.app.theme;
    const o = this.app.overlay;
    const plan = this.makePlan(end);
    this.plan = plan;
    o.reset();
    const { lf, lb } = this.lanes();
    const hw = ((lf + lb) * LANE_W) / 2;
    if (plan.poly) {
      o.road(plan.poly, hw, plan.ok ? th.ghostOk : th.ghostBad, th.ghostCasing);
      if (plan.specs) for (const sp of plan.specs) o.disc(sp.x, sp.y, Math.max(1.1, 3.4 / this.app.view.ppm), th.ghostCasing);
    }
    // anchors
    const r = Math.max(1.5, 5 / this.app.view.ppm);
    this.drawSnapMarker(this.pen);
    o.disc(this.pen.x, this.pen.y, r, th.ghostCasing);
    this.drawSnapMarker(end);
    if (this.guide && this.guide.kind) {
      const w = 1.3 / this.app.view.ppm;
      const L = 400;
      const dx = Math.cos(this.guide.ang);
      const dy = Math.sin(this.guide.ang);
      o.dashed(this.pen.x - dx * L, this.pen.y - dy * L, this.pen.x + dx * L, this.pen.y + dy * L, w, 7 / this.app.view.ppm, 7 / this.app.view.ppm, [0.45, 0.45, 0.5, 0.5]);
    } else if (end.kind === 'free') this.drawCrosshair(end);
    o.commit();

    const chips = [];
    if (!plan.ok) chips.push({ t: `Cannot create road: ${because(plan.error)}`, kind: 'error' });
    if (plan.cost > 0) chips.push({ t: fmtMoney(plan.cost), kind: plan.ok && !this.game.afford(plan.cost) ? 'error' : 'cost' });
    if (plan.ok && !this.game.afford(plan.cost)) chips.push({ t: 'Not enough money', kind: 'error' });
    if (this.app.opts.elev > 0 || Math.abs((this.pen.z ?? 0) - (end.z ?? 0)) > 0.01) chips.push({ t: `Elevation: ${end.z ?? this.app.opts.elev}` });
    if (this.guide) {
      const rel = Math.abs(angleDiff(this.guide.ang, this.guide.ref)) * (180 / Math.PI);
      const a = rel > 90 ? 180 - rel : rel;
      chips.push({ t: `${a.toFixed(1)}°`, kind: 'angle' });
      if (this.guide.kind) chips.push({ t: this.guide.kind });
    }
    if (plan.radius && plan.radius < 1e5 && plan.ok) chips.push({ t: `R ${Math.round(plan.radius)} m` });
    this.app.tip(chips, pt.sx, pt.sy, plan.ok ? '' : 'bad');
  }

  down(pt) {
    this.lastPt = pt;
    this.downAt = { sx: pt.sx, sy: pt.sy };
    this.moved = false;
    if (!this.pen) {
      this.pen = this.snapStart(pt);
      this.justSet = true;
      this.end = null;
      this.app.ui.updateToolState();
      this.hover(pt);
    } else {
      this.justSet = false;
      // pressing on the anchor again ends the chain
      if (Math.hypot(pt.x - this.pen.x, pt.y - this.pen.y) < this.tol(14) && this.pen.kind !== 'free') {
        this.ending = true;
        return;
      }
      this.ending = false;
      this.end = this.snapEnd(pt);
      this.preview(this.end, pt);
    }
  }

  move(pt) {
    this.lastPt = pt;
    if (!this.pen) return;
    if (this.downAt && Math.hypot(pt.sx - this.downAt.sx, pt.sy - this.downAt.sy) > DRAG_PX) this.moved = true;
    if (this.ending) return;
    if (this.justSet && !this.moved) return;
    this.end = this.snapEnd(pt);
    this.preview(this.end, pt);
  }

  up(pt) {
    if (!this.pen) return;
    if (this.ending) {
      this.ending = false;
      this.cancel();
      return;
    }
    if (this.justSet && !this.moved) {
      // anchor placed by a plain click/tap: wait for the next click
      this.justSet = false;
      this.app.hint('Tap where the road should end');
      return;
    }
    this.justSet = false;
    this.end = this.snapEnd(pt);
    this.preview(this.end, pt);
    const plan = this.plan;
    if (!plan || !plan.poly) return;
    if (!plan.ok || !this.game.afford(plan.cost)) {
      this.app.beep('error');
      if (plan.ok) this.app.toast('Not enough money', 'error');
      else this.app.toast(`Cannot create road: ${because(plan.error)}`, 'error');
      // a dragged-out failed attempt cancels, a failed tap keeps the anchor
      if (this.moved) this.cancel();
      return;
    }
    const res = this.game.buildRoad(plan);
    if (!res.ok) {
      this.app.toast(reason(res.error), 'error');
      return;
    }
    this.app.beep('build');
    const endNode = res.nodes[res.nodes.length - 1];
    this.pen = { kind: 'node', x: endNode.x, y: endNode.y, node: endNode, z: endNode.z };
    this.plan = null;
    this.end = null;
    this.guide = null;
    this.app.overlay.clear();
    this.app.hideTip();
    this.app.ui.updateToolState();
  }
}

/* ------------------------------------------------------------------ roundabout */

const RING_R = { S: 16, M: 20, L: 28 };

export class RoundaboutTool extends Tool {
  constructor(app) {
    super(app);
    this.id = 'roundabout';
    this.center = null;
    this.R = 20;
    this.plan = null;
    this.downAt = null;
  }
  cancel() {
    this.center = null;
    this.plan = null;
    this.downAt = null;
    this.app.overlay.clear();
    this.app.hideTip();
  }
  refresh() {
    if (this.lastPt) this.hover(this.lastPt);
  }
  abort() {
    this.center = null;
    this.downAt = null;
    this.lift();
  }
  lift() {
    this.lastPt = null;
    this.plan = null;
    this.app.overlay.clear();
    this.app.hideTip();
  }
  get baseR() {
    return RING_R[this.app.opts.ringSize] || 20;
  }
  lanesFor(c, R) {
    let lanes = 1;
    for (const e of this.game.net.edgesInBox(c.x - R - 14, c.y - R - 14, c.x + R + 14, c.y + R + 14)) {
      if (e.poly.closest(c.x, c.y).d >= R + 14) continue;
      // the ring grows with the biggest road that meets it
      lanes = Math.max(lanes, e.cls === 'highway' ? 3 : e.cls === 'avenue' ? 2 : 1);
    }
    return lanes;
  }
  makePlan(c, R) {
    const lanes = this.lanesFor(c, R);
    return this.planner.planRoundabout({ x: c.x, y: c.y, R, lanes, cls: lanes > 1 ? 'avenue' : 'street' });
  }
  draw(c, R, plan, pt) {
    const th = this.app.theme;
    const o = this.app.overlay;
    o.reset();
    const lanes = plan.lanes || 1;
    o.ring(plan.cx ?? c.x, plan.cy ?? c.y, R, (lanes * LANE_W) / 2, plan.ok ? th.ghostOk : th.ghostBad);
    const rr = Math.max(0.35, 1.6 / this.app.view.ppm);
    o.ring(plan.cx ?? c.x, plan.cy ?? c.y, R + (lanes * LANE_W) / 2, rr / 2, th.ghostCasing, o.bFill, 72);
    o.ring(plan.cx ?? c.x, plan.cy ?? c.y, R - (lanes * LANE_W) / 2, rr / 2, th.ghostCasing, o.bFill, 72);
    o.commit();
    const chips = [];
    if (!plan.ok) chips.push({ t: `Cannot create roundabout: ${because(plan.error)}`, kind: 'error' });
    if (plan.ok) chips.push({ t: plan.cost >= 0 ? fmtMoney(plan.cost) : `+${fmtMoney(-plan.cost)}`, kind: this.game.afford(plan.cost) ? 'cost' : 'error' });
    if (plan.ok && !this.game.afford(plan.cost)) chips.push({ t: 'Not enough money', kind: 'error' });
    chips.push({ t: `R ${Math.round(R)} m` });
    this.app.tip(chips, pt.sx, pt.sy, plan.ok ? '' : 'bad');
  }
  hover(pt) {
    this.lastPt = pt;
    const c = this.game.net.nearestNode(pt.x, pt.y, clamp(this.tol(22), 6, 18), (n) => n.ring == null && n.z < 0.1) || pt;
    const R = this.baseR;
    this.plan = this.makePlan({ x: c.x, y: c.y }, R);
    this.draw(c, R, this.plan, pt);
  }
  down(pt) {
    this.lastPt = pt;
    const n = this.game.net.nearestNode(pt.x, pt.y, clamp(this.tol(22), 6, 18), (q) => q.ring == null && q.z < 0.1);
    this.center = n ? { x: n.x, y: n.y } : { x: pt.x, y: pt.y };
    this.R = this.baseR;
    this.downAt = { sx: pt.sx, sy: pt.sy };
    this.plan = this.makePlan(this.center, this.R);
    this.draw(this.center, this.R, this.plan, pt);
  }
  move(pt) {
    this.lastPt = pt;
    if (!this.center) return;
    if (Math.hypot(pt.sx - this.downAt.sx, pt.sy - this.downAt.sy) > DRAG_PX * 2) {
      this.R = clamp(Math.hypot(pt.x - this.center.x, pt.y - this.center.y), 11, 42);
    }
    this.plan = this.makePlan(this.center, this.R);
    this.draw(this.center, this.R, this.plan, pt);
  }
  up(pt) {
    if (!this.center) return;
    const plan = this.plan;
    const c = this.center;
    this.center = null;
    if (!plan) return;
    if (!plan.ok) {
      this.app.beep('error');
      this.app.toast(`Cannot create roundabout: ${because(plan.error)}`, 'error');
      return;
    }
    const res = this.game.buildRoundabout(plan);
    if (!res.ok) {
      this.app.beep('error');
      this.app.toast(reason(res.error), 'error');
      return;
    }
    this.app.beep('build');
    void c;
    this.app.overlay.clear();
    this.app.hideTip();
  }
}

/* ------------------------------------------------------------------ lanes */

export class LaneTool extends Tool {
  constructor(app) {
    super(app);
    this.id = 'lane';
    this.target = null;
    this.downAt = null;
  }
  cancel() {
    this.target = null;
    this.app.overlay.clear();
    this.app.hideTip();
  }
  refresh() {
    if (this.lastPt) this.hover(this.lastPt);
  }
  abort() {
    this.downAt = null;
    this.lift();
  }
  lift() {
    this.lastPt = null;
    this.cancel();
  }
  find(pt) {
    const hit = this.game.net.nearestEdge(pt.x, pt.y, clamp(this.tol(26), 6, 30), (e) => !e.invalid);
    if (!hit) return null;
    const side = hit.side > 0 ? -1 : 1; // left of a->b carries the b->a lanes
    const delta = this.app.opts.laneMode === 'remove' ? -1 : 1;
    return { edge: hit.edge, side, delta, plan: this.planner.planLane(hit.edge, side, delta) };
  }
  hover(pt) {
    this.lastPt = pt;
    const t = this.find(pt);
    this.target = t;
    const th = this.app.theme;
    const o = this.app.overlay;
    o.reset();
    if (!t) {
      o.commit();
      this.app.hideTip();
      return;
    }
    const e = t.edge;
    const hw = e.halfWidth;
    const ok = t.plan.ok;
    const col = ok ? th.ghostOk : th.ghostBad;
    if (t.delta > 0) {
      if (t.side > 0) o.strip(e.poly, hw, hw + LANE_W, col);
      else o.strip(e.poly, -hw, -hw - LANE_W, col);
    } else if (t.side > 0) o.strip(e.poly, hw - LANE_W, hw, th.ghostBad);
    else o.strip(e.poly, -hw + LANE_W, -hw, th.ghostBad);
    o.commit();
    const chips = [];
    chips.push({ t: t.delta > 0 ? 'Add lane' : 'Remove lane' });
    if (!ok) chips.push({ t: reason(t.plan.error), kind: 'error' });
    else chips.push({ t: t.plan.cost >= 0 ? fmtMoney(t.plan.cost) : `+${fmtMoney(-t.plan.cost)}`, kind: this.game.afford(t.plan.cost) ? 'cost' : 'error' });
    this.app.tip(chips, pt.sx, pt.sy, ok ? '' : 'bad');
  }
  down(pt) {
    this.downAt = { sx: pt.sx, sy: pt.sy };
    this.hover(pt);
  }
  move(pt) {
    this.hover(pt);
  }
  up(pt) {
    if (!this.downAt) return;
    this.downAt = null;
    const t = this.find(pt);
    if (!t) return;
    if (!t.plan.ok) {
      this.app.beep('error');
      this.app.toast(reason(t.plan.error), 'error');
      return;
    }
    const res = this.game.changeLane(t.plan);
    if (!res.ok) {
      this.app.beep('error');
      this.app.toast(reason(res.error), 'error');
      return;
    }
    this.app.beep('build');
    this.hover(pt);
  }
}

/* ------------------------------------------------------------------ signals */

export class SignalTool extends Tool {
  constructor(app) {
    super(app);
    this.id = 'signal';
    this.target = null;
  }
  cancel() {
    this.target = null;
    this.app.overlay.clear();
    this.app.hideTip();
  }
  lift() {
    this.cancel();
  }
  find(pt) {
    return this.game.net.nearestNode(pt.x, pt.y, clamp(this.tol(30), 8, 26), (n) => n.edges.length >= 3 && n.ring == null);
  }
  hover(pt) {
    const n = this.find(pt);
    this.target = n;
    const o = this.app.overlay;
    o.reset();
    if (!n) {
      o.commit();
      this.app.hideTip();
      return;
    }
    const th = this.app.theme;
    o.ring(n.x, n.y, 9, 0.9, th.ghostOk);
    o.commit();
    this.app.tip(n.signal ? [{ t: 'Configure traffic lights' }] : [{ t: 'Install traffic lights' }, { t: fmtMoney(1500), kind: 'cost' }], pt.sx, pt.sy);
  }
  down(pt) {
    this.hover(pt);
  }
  move(pt) {
    this.hover(pt);
  }
  up(pt) {
    const n = this.find(pt);
    if (!n) {
      this.app.hint('Tap a junction (3 or more roads meet)');
      return;
    }
    if (n.signal) {
      this.app.ui.openSignalEditor(n);
      return;
    }
    const r = this.game.toggleSignal(n);
    if (!r.ok) {
      this.app.beep('error');
      this.app.toast(r.error === 'no_money' ? 'Not enough money' : 'Needs a junction', 'error');
      return;
    }
    this.app.beep('build');
    this.app.toast('Traffic lights installed – tap them again to configure', 'info');
    this.app.ui.openSignalEditor(n);
  }
}

/* ------------------------------------------------------------------ bulldoze */

export class BulldozeTool extends Tool {
  constructor(app) {
    super(app);
    this.id = 'bulldoze';
    this.sweeping = false;
    this.undoTaken = false;
    this.target = null;
    this.touch = false;
  }
  cancel() {
    this.sweeping = false;
    this.target = null;
    this.app.overlay.clear();
    this.app.hideTip();
  }
  abort() {
    this.sweeping = false;
    this.app.overlay.clear();
    this.app.hideTip();
  }
  deactivateHover() {
    if (this.sweeping) return;
    this.target = null;
    this.app.overlay.clear();
    this.app.hideTip();
  }
  find(pt) {
    for (const b of this.game.city.list) if (pointInRect(pt.x, pt.y, b.rect, 1.5)) return { kind: 'building', b };
    const hit = this.game.net.nearestEdge(pt.x, pt.y, clamp(this.tol(18), 3, 14), null);
    if (hit && hit.gap < Math.max(2, this.tol(14))) return { kind: 'edge', edge: hit.edge };
    return null;
  }
  show(t, pt) {
    const th = this.app.theme;
    const o = this.app.overlay;
    o.reset();
    this.target = t;
    if (!t) {
      o.commit();
      this.app.hideTip();
      return;
    }
    const red = [0.88, 0.33, 0.29, 0.6];
    if (t.kind === 'building') {
      o.rect(t.b.rect, red);
      this.app.tip([{ t: `Pick up ${BUILDING_TYPES[t.b.type].name.toLowerCase()}` }], pt.sx, pt.sy);
    } else {
      const list = t.edge.ring != null ? [...this.game.net.edges.values()].filter((e) => e.ring === t.edge.ring) : [t.edge];
      let refund = 0;
      for (const e of list) {
        o.road(e.poly, e.halfWidth + 0.3, red);
        refund += e.value * 0.5;
      }
      this.app.tip([{ t: t.edge.ring != null ? 'Remove roundabout' : 'Remove road' }, { t: `+${fmtMoney(refund)}`, kind: 'cost' }], pt.sx, pt.sy);
    }
    o.commit();
    void th;
  }
  apply(t, quiet = false) {
    if (!t || !(t.kind === 'building' ? t.b.alive : t.edge.alive)) return;
    // a sweep over several things is a single undo step, taken just before the first removal
    if (quiet && !this.undoTaken) {
      this.game.pushUndo();
      this.undoTaken = true;
    }
    if (t.kind === 'building') this.game.removeBuilding(t.b, !quiet);
    else this.game.bulldozeEdge(t.edge, !quiet);
    this.app.beep('remove');
  }
  hover(pt) {
    this.show(this.find(pt), pt);
  }
  down(pt) {
    this.touch = pt.type !== 'mouse';
    const t = this.find(pt);
    this.show(t, pt);
    if (!this.touch) {
      this.undoTaken = false;
      this.sweeping = true;
      this.apply(t, true);
      this.show(null, pt);
    }
  }
  move(pt) {
    const t = this.find(pt);
    if (this.sweeping) {
      this.apply(t, true);
      this.show(null, pt);
    } else this.show(t, pt);
  }
  up(pt) {
    if (this.sweeping) {
      this.sweeping = false;
      this.app.overlay.clear();
      return;
    }
    if (this.touch) {
      const t = this.find(pt) || this.target;
      this.apply(t, false);
      this.show(null, pt);
      this.app.hideTip();
    }
  }
}

/* ------------------------------------------------------------------ building placement */

export class BuildTool extends Tool {
  constructor(app) {
    super(app);
    this.id = 'build';
    this.type = 'house';
    this.stroke = null;
    this.lastPlaced = null;
    this.pl = null;
  }
  set(type) {
    this.type = type;
    this.cancel();
  }
  abort() {
    this.stroke = null;
    this.lift();
  }
  cancel() {
    this.stroke = null;
    this.pl = null;
    this.lastPlaced = null;
    this.app.overlay.clear();
    this.app.hideTip();
  }
  lift() {
    // the ghost floats above the fingertip, so once the finger is gone (or turned into a pinch) it has nothing to follow
    this.lastPt = null;
    this.pl = null;
    this.app.overlay.clear();
    this.app.hideTip();
  }
  refresh() {
    if (this.lastPt) this.hover(this.lastPt);
  }
  lookup(pt) {
    const lift = pt.type === 'mouse' ? 0 : TOUCH_LIFT_PX / this.app.view.ppm;
    return { x: pt.x, y: pt.y + lift, sx: pt.sx, sy: pt.sy - (pt.type === 'mouse' ? 0 : TOUCH_LIFT_PX) };
  }
  hover(pt) {
    this.lastPt = pt;
    const p = this.lookup(pt);
    const city = this.game.city;
    const pl = city.findPlacement(this.type, p.x, p.y);
    pl.seed = this.ghostSeed();
    this.pl = pl;
    this.drawGhost(pl, p);
  }
  drawGhost(pl, p) {
    const th = this.app.theme;
    const o = this.app.overlay;
    o.reset();
    const spec = BUILDING_TYPES[this.type];
    if (pl.rect) {
      const tint = pl.ok ? [1, 1, 1] : [1.25, 0.55, 0.5];
      o.buildingGhost(this.type, this.ghostSeed(), pl.x, pl.y, pl.rot, tint);
      if (pl.drive) {
        o.line(pl.drive.x0, pl.drive.y0, pl.drive.x1, pl.drive.y1, 2.2, pl.ok ? th.ghostOk : th.ghostBad, o.bFill);
      }
      const fp = pl.ok ? [0.3, 0.7, 0.4, 0.25] : [0.88, 0.33, 0.29, 0.25];
      o.rect(pl.rect, fp);
    } else {
      // nothing nearby: a faint disc where the pointer is
      o.disc(p.x, p.y, 3, [0.88, 0.33, 0.29, 0.5]);
    }
    o.commit();
    const chips = [{ t: spec.name }];
    if (!pl.ok) chips.push({ t: PLACE_TEXT[pl.reason] || pl.reason, kind: 'error' });
    this.app.tip(chips, p.sx, p.sy - 24, pl.ok ? '' : 'bad');
  }
  ghostSeed() {
    return this.app.ghostSeed || 7;
  }
  down(pt) {
    this.stroke = { sx: pt.sx, sy: pt.sy, placed: 0, last: null };
    this.hover(pt);
  }
  move(pt) {
    this.hover(pt);
    const s = this.stroke;
    if (!s) return;
    const far = Math.hypot(pt.sx - s.sx, pt.sy - s.sy) > 26;
    if (!far) return;
    // paint a row along the road once the pointer has travelled, filling every slot between the last one and the pointer
    const pl = this.pl;
    const city = this.game.city;
    if (pl && pl.ok && city.available(this.type) > 0) {
      const step = BUILDING_TYPES[this.type].w + 1.2; // a hair more than the overlap margin used by placement checks
      const last = s.last;
      if (!last) this.place(pl);
      else {
        const dx = pl.x - last.x;
        const dy = pl.y - last.y;
        const dist = Math.hypot(dx, dy);
        const n = Math.floor(dist / step);
        for (let k = 1; k <= n && this.stroke && city.available(this.type) > 0; k++) {
          const t = (k * step) / dist;
          const f = city.findPlacement(this.type, last.x + dx * t, last.y + dy * t);
          f.seed = this.ghostSeed();
          if (f.ok) this.place(f);
        }
      }
    }
  }
  place(pl) {
    const res = this.game.placeBuilding(pl);
    if (!res.ok) {
      this.app.beep('error');
      return false;
    }
    this.app.beep('place');
    this.stroke.last = { x: pl.x, y: pl.y };
    this.stroke.placed++;
    this.app.ghostSeed = 1 + Math.floor(Math.random() * 9999);
    this.app.ui.updateTray();
    if (this.game.city.available(this.type) <= 0) {
      this.app.toast('Placed the last one – more arrive as your city levels up', 'info');
      this.app.setTool('hand');
    }
    return true;
  }
  up(pt) {
    const s = this.stroke;
    this.stroke = null;
    if (!s) return;
    this.hover(pt);
    if (s.placed === 0) this.tap();
    // a mouse keeps hovering, unless placing the last one already handed over to the Move tool
    if (pt.type === 'mouse' && this.app.tool === this) this.hover(pt);
  }
  // a press and release without painting a row places one building
  tap() {
    const pl = this.pl;
    if (!pl || !pl.ok) {
      this.app.beep('error');
      this.app.toast(PLACE_TEXT[pl && pl.reason] || 'Cannot place here', 'error');
      return;
    }
    if (this.game.city.available(this.type) <= 0) {
      this.app.toast('None left to place', 'error');
      return;
    }
    this.stroke = { last: null, placed: 0 };
    this.place(pl);
    this.stroke = null;
  }
}

export { MIN_STUB, MAX_LANES, CLASSES };
