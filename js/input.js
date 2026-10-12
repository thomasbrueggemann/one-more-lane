// Pointer / gesture handling shared by mouse, touch and pen.
//  - one pointer: drives the active tool (or pans in the Move tool, or with right/middle mouse button)
//  - two pointers: pan + pinch zoom (cancels any half-finished tool gesture)
//  - wheel / trackpad pinch: zoom at the cursor; keyboard: pan, zoom and shortcuts

import { TOOL_KEYS } from './ui.js';

const TAP_MS = 450;
const TAP_PX = 10;

export class Input {
  constructor(app, canvas) {
    this.app = app;
    this.canvas = canvas;
    this.ptrs = new Map();
    this.mode = null; // 'tool' | 'pan' | 'pinch'
    this.pinch = null;
    this.keys = new Set();
    this.space = false;
    this.lastMouse = null;
    const c = canvas;
    c.addEventListener('pointerdown', (e) => this.onDown(e));
    c.addEventListener('pointermove', (e) => this.onMove(e));
    c.addEventListener('pointerup', (e) => this.onUp(e));
    c.addEventListener('pointercancel', (e) => this.onCancel(e));
    c.addEventListener('pointerleave', (e) => {
      if (e.pointerType === 'mouse' && !this.ptrs.size) this.app.tool.deactivateHover && this.app.tool.deactivateHover();
    });
    c.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    c.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.reset());
    document.addEventListener('visibilitychange', () => document.hidden && this.reset());
    // stop iOS Safari from zooming the page
    for (const ev of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(ev, (e) => e.preventDefault());
    document.addEventListener('dblclick', (e) => e.preventDefault());
  }

  pt(e) {
    this.app.pointerType = e.pointerType || 'mouse';
    const r = this.canvas.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    const w = this.app.view.screenToWorld(sx, sy);
    return { x: w.x, y: w.y, sx, sy, type: e.pointerType || 'mouse', button: e.button, id: e.pointerId, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey };
  }

  /** The window lost focus: a key or finger released elsewhere would otherwise stay "held" for ever. */
  reset() {
    this.keys.clear();
    this.space = false;
    if (this.mode === 'tool') this.abortTool();
    this.ptrs.clear();
    this.mode = null;
    this.pinch = null;
  }

  /** A second finger arrived or the gesture was cancelled: drop half-finished tool presses without committing. */
  abortTool() {
    const tool = this.app.tool;
    if (tool && tool.abort) tool.abort();
  }

  onDown(e) {
    if (!this.app.interactive()) return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch (err) {
      /* synthetic or already-released pointer: carry on without capture */
    }
    const p = this.pt(e);
    this.ptrs.set(e.pointerId, { sx: p.sx, sy: p.sy, type: p.type, t0: performance.now(), x0: p.sx, y0: p.sy, last: p });
    this.app.audioUnlock();
    if (this.ptrs.size === 2) {
      if (this.mode === 'tool') this.abortTool();
      this.startPinch();
      this.mode = 'pinch';
      return;
    }
    if (this.ptrs.size > 2) return;
    const tool = this.app.tool;
    const mouse = p.type === 'mouse';
    if (mouse && (e.button === 1 || e.button === 2)) {
      if (e.button === 2 && tool.cancel && tool.active) {
        // right click cancels a half-drawn road instead of panning
        tool.cancel();
        this.mode = null;
        return;
      }
      this.mode = 'pan';
    } else if (tool.drag === 'pan' || this.space) this.mode = 'pan';
    else {
      this.mode = 'tool';
      tool.down(p);
    }
    this.panLast = { sx: p.sx, sy: p.sy };
    this.app.ui.hideInfoOnMapPress && this.app.ui.hideInfoOnMapPress();
  }

  onMove(e) {
    const p = this.pt(e);
    const rec = this.ptrs.get(e.pointerId);
    if (!rec) {
      if (p.type === 'mouse' && this.app.interactive()) {
        this.lastMouse = p;
        if (!this.ptrs.size) this.app.tool.hover(p);
      }
      return;
    }
    rec.sx = p.sx;
    rec.sy = p.sy;
    rec.last = p;
    if (this.mode === 'pinch') {
      this.updatePinch();
    } else if (this.mode === 'pan') {
      this.app.view.panPixels(p.sx - this.panLast.sx, p.sy - this.panLast.sy);
      this.panLast = { sx: p.sx, sy: p.sy };
      this.app.cancelFocus();
    } else if (this.mode === 'tool') {
      this.app.tool.move(p);
    }
  }

  onUp(e) {
    const rec = this.ptrs.get(e.pointerId);
    if (!rec) return;
    const p = this.pt(e);
    this.ptrs.delete(e.pointerId);
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* already released */
    }
    if (this.mode === 'pinch') {
      if (this.ptrs.size < 2) {
        this.mode = null;
        this.pinch = null;
      } else this.startPinch(); // a different pair of fingers is now tracked: measure from here, do not jump
      return;
    }
    if (this.mode === 'tool') {
      this.app.tool.up(p);
      // a lifted finger points at nothing any more; only a mouse keeps hovering over the map
      if (p.type !== 'mouse') this.app.tool.lift();
    } else if (this.mode === 'pan') {
      const tool = this.app.tool;
      if (tool.tap && performance.now() - rec.t0 < TAP_MS && Math.hypot(p.sx - rec.x0, p.sy - rec.y0) < TAP_PX && e.button === 0) tool.tap(p);
    }
    this.mode = null;
  }

  onCancel(e) {
    if (!this.ptrs.has(e.pointerId)) return;
    this.ptrs.delete(e.pointerId);
    if (this.mode === 'tool') this.abortTool();
    if (!this.ptrs.size) {
      this.mode = null;
      this.pinch = null;
    } else if (this.mode === 'pinch') {
      if (this.ptrs.size >= 2) this.startPinch();
      else {
        this.mode = null;
        this.pinch = null;
      }
    }
  }

  startPinch() {
    const [a, b] = [...this.ptrs.values()];
    this.pinch = { d: Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1, cx: (a.sx + b.sx) / 2, cy: (a.sy + b.sy) / 2 };
  }

  updatePinch() {
    if (this.ptrs.size < 2 || !this.pinch) return;
    const [a, b] = [...this.ptrs.values()];
    const d = Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1;
    const cx = (a.sx + b.sx) / 2;
    const cy = (a.sy + b.sy) / 2;
    const v = this.app.view;
    v.panPixels(cx - this.pinch.cx, cy - this.pinch.cy);
    v.zoomAt(cx, cy, d / this.pinch.d);
    this.pinch = { d, cx, cy };
    this.app.cancelFocus();
  }

  onWheel(e) {
    e.preventDefault();
    if (!this.app.interactive()) return;
    const r = this.canvas.getBoundingClientRect();
    let dy = e.deltaY;
    if (e.deltaMode === 1) dy *= 32;
    else if (e.deltaMode === 2) dy *= 400;
    const k = e.ctrlKey ? 0.012 : 0.0016;
    this.app.view.zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-dy * k));
    this.app.cancelFocus();
    if (this.lastMouse && !this.ptrs.size) {
      const p = this.pt(e);
      this.app.tool.hover(p);
    }
  }

  onKey(e, down) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    const k = e.key;
    if (down) {
      if (k === ' ') {
        this.space = true;
        e.preventDefault();
        if (!e.repeat) this.app.togglePause();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (k === 'z' || k === 'Z')) {
        e.preventDefault();
        this.app.undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && (k === 's' || k === 'S')) {
        e.preventDefault(); // not the browser's "save page"
        if (!e.repeat) this.app.quickSave();
        return;
      }
      if (k === 'Escape') {
        this.app.escape();
        return;
      }
      if (TOOL_KEYS[k] && !e.ctrlKey && !e.metaKey) {
        this.app.setTool(TOOL_KEYS[k]);
        return;
      }
      if (k === 't' || k === 'T') this.app.toggleFlow();
      if (k === 'Enter' && this.app.tool.finish) this.app.tool.finish();
      if (k === '+' || k === '=') this.app.view.zoomAt(this.app.view.w / 2, this.app.view.h / 2, 1.25);
      if (k === '-' || k === '_') this.app.view.zoomAt(this.app.view.w / 2, this.app.view.h / 2, 1 / 1.25);
      this.keys.add(k.toLowerCase());
    } else {
      if (k === ' ') this.space = false;
      this.keys.delete(k.toLowerCase());
    }
  }

  /** Called every frame: keyboard panning. */
  update(dt) {
    if (!this.keys.size) return;
    let dx = 0;
    let dy = 0;
    if (this.keys.has('arrowleft') || this.keys.has('a')) dx += 1;
    if (this.keys.has('arrowright') || this.keys.has('d')) dx -= 1;
    if (this.keys.has('arrowup') || this.keys.has('w')) dy += 1;
    if (this.keys.has('arrowdown') || this.keys.has('s')) dy -= 1;
    if (dx || dy) {
      const sp = 700 * dt;
      this.app.view.panPixels(dx * sp, dy * sp);
      this.app.cancelFocus();
    }
  }
}
