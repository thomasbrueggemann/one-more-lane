// Instanced vehicle renderer. Cars/trucks are tiny flat shapes (outline, body, glass) drawn with a custom
// instanced shader: per instance position, heading, colour and fade. One draw call per (type, elevation level).

import * as THREE from '../../vendor/three.module.js';
import { ORDER } from './materials.js';

const VERT = /* glsl */ `
attribute vec2 iPos;
attribute vec2 iRot;
attribute vec3 iCol;
attribute float iFade;
attribute float part;
uniform vec4 uOutline;
varying vec4 vColor;
void main() {
  vec2 p = vec2(position.x * iRot.x - position.y * iRot.y, position.x * iRot.y + position.y * iRot.x) + iPos;
  vec3 c;
  float a = iFade;
  if (part < 0.5) { c = uOutline.rgb; a *= uOutline.a; }
  else if (part < 1.5) { c = iCol; }
  else if (part < 2.5) { c = iCol * 0.26 + vec3(0.02, 0.035, 0.07); }
  else { c = iCol * 0.8 + vec3(0.12); }
  vColor = vec4(c, a);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}`;

const FRAG = /* glsl */ `
varying vec4 vColor;
void main() { gl_FragColor = vColor; }`;

function roundedRect(cx, cy, hx, hy, r, steps = 4) {
  const pts = [];
  const corners = [
    [hx - r, hy - r, 0],
    [-(hx - r), hy - r, Math.PI / 2],
    [-(hx - r), -(hy - r), Math.PI],
    [hx - r, -(hy - r), Math.PI * 1.5],
  ];
  for (const [ox, oy, a0] of corners) {
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (i / steps) * (Math.PI / 2);
      pts.push([cx + ox + Math.cos(a) * r, cy + oy + Math.sin(a) * r]);
    }
  }
  return pts;
}

/** Triangle fan for a convex polygon; appends to arrays with the given part id. */
function fan(pos, parts, poly, part) {
  for (let i = 1; i < poly.length - 1; i++) {
    for (const p of [poly[0], poly[i], poly[i + 1]]) {
      pos.push(p[0], p[1], 0);
      parts.push(part);
    }
  }
}

function carShape(len, wid, kind) {
  const pos = [];
  const parts = [];
  const o = 0.17;
  fan(pos, parts, roundedRect(0, 0, len / 2 + o, wid / 2 + o, 0.62 + o), 0);
  fan(pos, parts, roundedRect(0, 0, len / 2, wid / 2, 0.62), 1);
  if (kind === 'truck') {
    // cab at the front (+x) with a windscreen, cargo box behind
    const cabL = len * 0.26;
    fan(pos, parts, roundedRect(len / 2 - cabL / 2, 0, cabL / 2, wid / 2 - 0.05, 0.45), 1);
    fan(pos, parts, [[len / 2 - cabL * 0.42, -wid / 2 + 0.38], [len / 2 - cabL * 0.42, wid / 2 - 0.38], [len / 2 - 0.2, wid / 2 - 0.5], [len / 2 - 0.2, -wid / 2 + 0.5]], 2);
    // darker seam between cab and box
    fan(pos, parts, [[len / 2 - cabL - 0.14, -wid / 2 + 0.1], [len / 2 - cabL - 0.14, wid / 2 - 0.1], [len / 2 - cabL + 0.1, wid / 2 - 0.1], [len / 2 - cabL + 0.1, -wid / 2 + 0.1]], 2);
    fan(pos, parts, [[-len / 2 + 0.5, -wid / 2 + 0.45], [-len / 2 + 0.5, wid / 2 - 0.45], [len / 2 - cabL - 0.6, wid / 2 - 0.45], [len / 2 - cabL - 0.6, -wid / 2 + 0.45]], 3);
  } else {
    // windscreen (front, +x) and rear window
    const w = wid / 2 - 0.3;
    fan(pos, parts, [[len * 0.12, -w], [len * 0.12, w], [len * 0.33, w - 0.12], [len * 0.33, -w + 0.12]], 2);
    fan(pos, parts, [[-len * 0.3, -w + 0.1], [-len * 0.3, w - 0.1], [-len * 0.2, w - 0.05], [-len * 0.2, -w + 0.05]], 2);
    fan(pos, parts, [[-len * 0.18, -w + 0.05], [-len * 0.18, w - 0.05], [len * 0.1, w - 0.05], [len * 0.1, -w + 0.05]], 3);
  }
  return { pos: Float32Array.from(pos), parts: Float32Array.from(parts) };
}

const SHAPES = {
  car: () => carShape(4.0, 1.78, 'car'),
  truck: () => carShape(7.4, 2.3, 'truck'),
};

class Batch {
  constructor(parent, shape, capacity, order, material) {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(shape.pos, 3));
    g.setAttribute('part', new THREE.BufferAttribute(shape.parts, 1));
    this.pos = new Float32Array(capacity * 2);
    this.rot = new Float32Array(capacity * 2);
    this.col = new Float32Array(capacity * 3);
    this.fade = new Float32Array(capacity);
    const mk = (arr, n) => {
      const a = new THREE.InstancedBufferAttribute(arr, n);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };
    this.attrs = [mk(this.pos, 2), mk(this.rot, 2), mk(this.col, 3), mk(this.fade, 1)];
    g.setAttribute('iPos', this.attrs[0]);
    g.setAttribute('iRot', this.attrs[1]);
    g.setAttribute('iCol', this.attrs[2]);
    g.setAttribute('iFade', this.attrs[3]);
    g.instanceCount = 0;
    this.geo = g;
    this.mesh = new THREE.Mesh(g, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    parent.add(this.mesh);
    this.n = 0;
    this.capacity = capacity;
  }
  reset() {
    this.n = 0;
  }
  add(x, y, c, s, r, g, b, fade) {
    const i = this.n;
    if (i >= this.capacity) return;
    this.pos[i * 2] = x;
    this.pos[i * 2 + 1] = y;
    this.rot[i * 2] = c;
    this.rot[i * 2 + 1] = s;
    this.col[i * 3] = r;
    this.col[i * 3 + 1] = g;
    this.col[i * 3 + 2] = b;
    this.fade[i] = fade;
    this.n++;
  }
  commit() {
    this.geo.instanceCount = this.n;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, a.itemSize * Math.max(1, this.n));
      a.needsUpdate = true;
    }
    this.mesh.visible = this.n > 0;
  }
}

export class VehicleRenderer {
  constructor(scene, theme, capacity = 3000) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uOutline: { value: new THREE.Vector4(...theme.carOutline) } },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.batches = [];
    for (let L = 0; L < 3; L++) {
      const row = {};
      for (const kind of ['car', 'truck']) {
        row[kind] = new Batch(this.group, SHAPES[kind](), kind === 'car' ? capacity : 400, ORDER.level(L) + 10, this.material);
      }
      this.batches.push(row);
    }
  }

  setTheme(theme) {
    this.material.uniforms.uOutline.value.set(...theme.carOutline);
  }

  begin() {
    for (const row of this.batches) {
      row.car.reset();
      row.truck.reset();
    }
  }

  add(level, kind, x, y, hx, hy, color, fade) {
    this.batches[level][kind].add(x, y, hx, hy, color[0], color[1], color[2], fade);
  }

  end() {
    for (const row of this.batches) {
      row.car.commit();
      row.truck.commit();
    }
  }
}
