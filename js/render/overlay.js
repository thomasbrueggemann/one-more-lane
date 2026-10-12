// Dynamic overlay geometry: tool ghosts, snap markers, guides, selection highlights.
// Rebuilt on demand (pointer moves) from small flat buffers.

import * as THREE from '../../vendor/three.module.js';
import { Buf, ribbon, KERB_W } from './roadgeom.js';
import { flatMaterial, ORDER } from './materials.js';
import { Poly } from '../geom.js';
import { shapeFor, shade } from '../buildings.js';

const P = (x, y, ex = 0, ey = 0) => ({ x, y, ex, ey });

export class Overlay {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.fillMat = flatMaterial();
    this.casingMat = flatMaterial({ minPx: 1.6 });
    this.lineMat = flatMaterial();
    this.fill = this.mk(this.fillMat, ORDER.overlay);
    this.casing = this.mk(this.casingMat, ORDER.overlay + 1);
    this.lines = this.mk(this.lineMat, ORDER.overlay + 2);
    this.reset();
    this.ppm = 1;
  }

  mk(mat, order) {
    const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
    m.frustumCulled = false;
    m.renderOrder = order;
    m.visible = false;
    this.group.add(m);
    return m;
  }

  setPxPerM(ppm) {
    this.ppm = ppm;
    for (const m of [this.fillMat, this.casingMat, this.lineMat]) m.uniforms.uPxPerM.value = ppm;
  }

  reset() {
    this.bFill = new Buf();
    this.bCasing = new Buf();
    this.bLines = new Buf();
  }

  commit() {
    for (const [mesh, buf] of [[this.fill, this.bFill], [this.casing, this.bCasing], [this.lines, this.bLines]]) {
      mesh.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(buf.p), 3));
      g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(buf.c), 4));
      g.setAttribute('expand', new THREE.BufferAttribute(Float32Array.from(buf.e), 2));
      mesh.geometry = g;
      mesh.visible = buf.count > 0;
    }
  }

  clear() {
    this.reset();
    this.commit();
  }

  /* ---- primitives (world units) ---- */

  /** Ribbon of the given half width along poly, with an optional dark outline. */
  road(poly, halfWidth, col, outline = null) {
    if (poly.n < 2) return;
    ribbon(this.bFill, poly, -halfWidth, halfWidth, col);
    if (outline) {
      ribbon(this.bCasing, poly, halfWidth, halfWidth + KERB_W, outline, outline, KERB_W);
      ribbon(this.bCasing, poly, -halfWidth, -halfWidth - KERB_W, outline, outline, KERB_W);
    }
  }

  strip(poly, dA, dB, col) {
    if (poly.n < 2) return;
    ribbon(this.bFill, poly, dA, dB, col);
  }

  disc(x, y, r, col, steps = 20, buf = this.bFill) {
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * Math.PI * 2;
      const a1 = ((i + 1) / steps) * Math.PI * 2;
      buf.tri(P(x, y), P(x + Math.cos(a0) * r, y + Math.sin(a0) * r), P(x + Math.cos(a1) * r, y + Math.sin(a1) * r), col);
    }
  }

  /** Circular ring of centre-line radius r and half width hw. */
  ring(x, y, r, hw, col, buf = this.bFill, steps = 64) {
    for (let i = 0; i < steps; i++) {
      const a0 = (i / steps) * Math.PI * 2;
      const a1 = ((i + 1) / steps) * Math.PI * 2;
      const c0 = Math.cos(a0);
      const s0 = Math.sin(a0);
      const c1 = Math.cos(a1);
      const s1 = Math.sin(a1);
      buf.quad(P(x + c0 * (r - hw), y + s0 * (r - hw)), P(x + c0 * (r + hw), y + s0 * (r + hw)), P(x + c1 * (r + hw), y + s1 * (r + hw)), P(x + c1 * (r - hw), y + s1 * (r - hw)), col);
    }
  }

  /** Thin line of constant world width. */
  line(x0, y0, x1, y1, w, col, buf = this.bLines) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const l = Math.hypot(dx, dy) || 1;
    const nx = (-dy / l) * (w / 2);
    const ny = (dx / l) * (w / 2);
    buf.quad(P(x0 + nx, y0 + ny), P(x1 + nx, y1 + ny), P(x1 - nx, y1 - ny), P(x0 - nx, y0 - ny), col);
  }

  dashed(x0, y0, x1, y1, w, dash, gap, col) {
    const dx = x1 - x0;
    const dy = y1 - y0;
    const l = Math.hypot(dx, dy);
    if (l < 1e-3) return;
    const ux = dx / l;
    const uy = dy / l;
    for (let s = 0; s < l; s += dash + gap) {
      const e = Math.min(l, s + dash);
      this.line(x0 + ux * s, y0 + uy * s, x0 + ux * e, y0 + uy * e, w, col);
    }
  }

  polyLine(poly, w, col) {
    for (let i = 0; i < poly.n - 1; i++) this.line(poly.xs[i], poly.ys[i], poly.xs[i + 1], poly.ys[i + 1], w, col);
  }

  rect(rect, col, buf = this.bFill, grow = 0) {
    const hw = rect.hw + grow;
    const hd = rect.hd + grow;
    const pts = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([lx, ly]) => P(rect.cx + lx * rect.c - ly * rect.s, rect.cy + lx * rect.s + ly * rect.c));
    buf.quad(pts[0], pts[1], pts[2], pts[3], col);
  }

  /** Flat translucent rendering of a building shape (used as a placement ghost). */
  buildingGhost(type, seed, x, y, rot, tint, alpha = 0.78) {
    const shape = shapeFor(type, seed);
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const w = (lx, ly) => P(x + lx * c - ly * s, y + lx * s + ly * c);
    for (const d of shape.decals) {
      const pts = d.pts.map(([lx, ly]) => w(lx, ly));
      for (let i = 1; i < pts.length - 1; i++) this.bFill.tri(pts[0], pts[i], pts[i + 1], [1, 1, 1, d.color[3] * 0.6]);
    }
    const order = shape.polys.slice().sort((a, b) => Math.max(...a.pts.map((p) => p[2])) - Math.max(...b.pts.map((p) => p[2])));
    for (const poly of order) {
      let nx = 0;
      let ny = 0;
      let nz = 0;
      const pts = poly.pts;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const q = pts[(i + 1) % pts.length];
        nx += (a[1] - q[1]) * (a[2] + q[2]);
        ny += (a[2] - q[2]) * (a[0] + q[0]);
        nz += (a[0] - q[0]) * (a[1] + q[1]);
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      const k = shade((nx / l) * c - (ny / l) * s, (nx / l) * s + (ny / l) * c, Math.abs(nz / l));
      const col = [poly.color[0] * k * tint[0], poly.color[1] * k * tint[1], poly.color[2] * k * tint[2], alpha];
      const wp = pts.map((p) => w(p[0], p[1]));
      for (let i = 1; i < wp.length - 1; i++) this.bFill.tri(wp[0], wp[i], wp[i + 1], col);
    }
  }

  dispose() {
    for (const m of [this.fill, this.casing, this.lines]) m.geometry.dispose();
  }
}

export { Poly };
