// Merged building meshes: roofs with baked lighting (depth-tested), unified soft shadows (stencil), lot/parking decals
// and driveways. Rebuilt when the set of buildings changes; per-building geometry is cached on the building object.

import * as THREE from '../../vendor/three.module.js';
import { shapeFor, shade } from '../buildings.js';
import { Buf } from './roadgeom.js';
import { flatMaterial, ORDER } from './materials.js';
import { convexHull } from '../geom.js';

const BODY_VERT = /* glsl */ `
attribute vec3 color;
varying vec3 vColor;
void main() {
  vColor = color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const BODY_FRAG = /* glsl */ `
varying vec3 vColor;
void main() { gl_FragColor = vec4(vColor, 1.0); }`;

const P = (x, y) => ({ x, y, ex: 0, ey: 0 });

export class BuildingRenderer {
  constructor(scene, theme) {
    this.theme = theme;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.lotMat = flatMaterial();
    this.driveCasingMat = flatMaterial();
    this.driveFillMat = flatMaterial();
    this.shadowMat = flatMaterial({ stencilRef: 1 });
    this.bodyMat = new THREE.ShaderMaterial({
      vertexShader: BODY_VERT,
      fragmentShader: BODY_FRAG,
      transparent: true,
      depthTest: true,
      depthWrite: true,
    });
    const mk = (mat, order) => {
      const m = new THREE.Mesh(new THREE.BufferGeometry(), mat);
      m.frustumCulled = false;
      m.renderOrder = order;
      m.visible = false;
      this.group.add(m);
      return m;
    };
    this.lot = mk(this.lotMat, ORDER.lot);
    this.driveCasing = mk(this.driveCasingMat, ORDER.driveway);
    this.driveFill = mk(this.driveFillMat, ORDER.driveway + 1);
    this.shadow = mk(this.shadowMat, ORDER.buildingShadow);
    this.body = mk(this.bodyMat, ORDER.buildings);
  }

  setTheme(theme) {
    this.theme = theme;
  }

  /** Cached world-space geometry for one building. */
  geoFor(b) {
    const key = `${b.type}:${b.seed}:${b.x.toFixed(2)}:${b.y.toFixed(2)}:${b.rot.toFixed(3)}:${b.drive ? b.drive.x1.toFixed(1) + b.drive.y1.toFixed(1) : ''}:${this.theme.id}`;
    if (b._bg && b._bg.key === key) return b._bg;
    const th = this.theme;
    const shape = shapeFor(b.type, b.seed);
    const c = Math.cos(b.rot);
    const s = Math.sin(b.rot);
    const wx = (lx, ly) => b.x + lx * c - ly * s;
    const wy = (lx, ly) => b.y + lx * s + ly * c;

    const body = [];
    for (const poly of shape.polys) {
      const pts = poly.pts;
      // Newell normal
      let nx = 0;
      let ny = 0;
      let nz = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i];
        const q = pts[(i + 1) % pts.length];
        nx += (a[1] - q[1]) * (a[2] + q[2]);
        ny += (a[2] - q[2]) * (a[0] + q[0]);
        nz += (a[0] - q[0]) * (a[1] + q[1]);
      }
      const l = Math.hypot(nx, ny, nz) || 1;
      nx /= l;
      ny /= l;
      nz /= l;
      const rx = nx * c - ny * s;
      const ry = nx * s + ny * c;
      let k = shade(rx, ry, Math.abs(nz));
      if (th.id === 'dark') k *= 0.9;
      const col = [Math.min(1, poly.color[0] * k), Math.min(1, poly.color[1] * k), Math.min(1, poly.color[2] * k)];
      for (let i = 1; i < pts.length - 1; i++) {
        for (const q of [pts[0], pts[i], pts[i + 1]]) body.push(wx(q[0], q[1]), wy(q[0], q[1]), q[2], col[0], col[1], col[2]);
      }
    }

    const shadow = new Buf();
    const sun = th.sun;
    for (const sh of shape.shadows) {
      const [cx, cy, hw, hd] = sh.rect;
      const pts = [];
      for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const lx = cx + sx * hd;
        const ly = cy + sy * hw;
        const x = wx(lx, ly);
        const y = wy(lx, ly);
        pts.push({ x, y }, { x: x + sun[0] * sh.h * 0.9, y: y + sun[1] * sh.h * 0.9 });
      }
      const hull = convexHull(pts);
      for (let i = 1; i < hull.length - 1; i++) shadow.tri(P(hull[0].x, hull[0].y), P(hull[i].x, hull[i].y), P(hull[i + 1].x, hull[i + 1].y), th.shadow);
    }

    const lot = new Buf();
    for (const d of shape.decals) {
      const w = d.pts.map(([lx, ly]) => P(wx(lx, ly), wy(lx, ly)));
      const col = th.id === 'dark' ? [d.color[0] * 0.3, d.color[1] * 0.3, d.color[2] * 0.3, d.color[3] * 0.5] : d.color;
      for (let i = 1; i < w.length - 1; i++) lot.tri(w[0], w[i], w[i + 1], col);
    }

    const dCase = new Buf();
    const dFill = new Buf();
    if (b.drive) {
      const { x0, y0, x1, y1 } = b.drive;
      const dx = x1 - x0;
      const dy = y1 - y0;
      const l = Math.hypot(dx, dy) || 1;
      const tx = dx / l;
      const ty = dy / l;
      const nx = -ty;
      const ny = tx;
      const hw = 1.5;
      const cb = 0.3;
      const edge = th.casing;
      dCase.quad(P(x0 + nx * (hw + cb), y0 + ny * (hw + cb)), P(x1 + nx * (hw + cb), y1 + ny * (hw + cb)), P(x1 - nx * (hw + cb), y1 - ny * (hw + cb)), P(x0 - nx * (hw + cb), y0 - ny * (hw + cb)), edge);
      const ov = 0.7;
      dFill.quad(P(x0 + nx * hw, y0 + ny * hw), P(x1 + tx * ov + nx * hw, y1 + ty * ov + ny * hw), P(x1 + tx * ov - nx * hw, y1 + ty * ov - ny * hw), P(x0 - nx * hw, y0 - ny * hw), th.driveway);
    }
    b._bg = { key, body: Float32Array.from(body), shadow, lot, dCase, dFill };
    return b._bg;
  }

  rebuild(buildings) {
    const bodies = [];
    const shadow = new Buf();
    const lot = new Buf();
    const dCase = new Buf();
    const dFill = new Buf();
    let nBody = 0;
    for (const b of buildings) {
      const g = this.geoFor(b);
      bodies.push(g.body);
      nBody += g.body.length;
      shadow.append(g.shadow);
      lot.append(g.lot);
      dCase.append(g.dCase);
      dFill.append(g.dFill);
    }
    const flat = (mesh, buf) => {
      mesh.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(buf.p), 3));
      g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(buf.c), 4));
      g.setAttribute('expand', new THREE.BufferAttribute(Float32Array.from(buf.e), 2));
      mesh.geometry = g;
      mesh.visible = buf.count > 0;
    };
    flat(this.lot, lot);
    flat(this.driveCasing, dCase);
    flat(this.driveFill, dFill);
    flat(this.shadow, shadow);
    const all = new Float32Array(nBody);
    let o = 0;
    for (const a of bodies) {
      all.set(a, o);
      o += a.length;
    }
    const pos = new Float32Array((nBody / 6) * 3);
    const col = new Float32Array((nBody / 6) * 3);
    for (let i = 0; i < nBody / 6; i++) {
      pos[i * 3] = all[i * 6];
      pos[i * 3 + 1] = all[i * 6 + 1];
      pos[i * 3 + 2] = all[i * 6 + 2];
      col[i * 3] = all[i * 6 + 3];
      col[i * 3 + 1] = all[i * 6 + 4];
      col[i * 3 + 2] = all[i * 6 + 5];
    }
    this.body.geometry.dispose();
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    this.body.geometry = g;
    this.body.visible = nBody > 0;
  }
}
