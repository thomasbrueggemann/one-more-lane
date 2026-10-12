// Instanced markers: traffic-light heads and building badges (disconnected / unhappy).

import * as THREE from '../../vendor/three.module.js';
import { ORDER } from './materials.js';
import { SIGNAL_GREEN, SIGNAL_AMBER } from '../signals.js';

const DISC_VERT = /* glsl */ `
attribute vec2 iPos;
attribute vec3 iCol;
attribute float iSize;
attribute float iFade;
varying vec2 vUv;
varying vec3 vCol;
varying float vFade;
void main() {
  vUv = position.xy;
  vCol = iCol;
  vFade = iFade;
  vec2 p = iPos + position.xy * iSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}`;
const DISC_FRAG = /* glsl */ `
varying vec2 vUv;
varying vec3 vCol;
varying float vFade;
uniform float uPxPerM;
void main() {
  float d = length(vUv);
  float aa = 1.2 / max(uPxPerM * 0.5, 1.0) ;
  float edge = 1.0 - smoothstep(1.0 - 0.12, 1.0, d);
  if (d > 1.0) discard;
  float rim = smoothstep(0.62, 0.78, d);
  vec3 c = mix(vCol, vec3(0.13, 0.14, 0.17), rim);
  gl_FragColor = vec4(c, edge * vFade);
}`;

export class SignalRenderer {
  constructor(scene, capacity = 800) {
    this.capacity = capacity;
    const quad = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(quad, 3));
    this.pos = new Float32Array(capacity * 2);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.fade = new Float32Array(capacity);
    const mk = (a, n) => {
      const at = new THREE.InstancedBufferAttribute(a, n);
      at.setUsage(THREE.DynamicDrawUsage);
      return at;
    };
    this.attrs = [mk(this.pos, 2), mk(this.col, 3), mk(this.size, 1), mk(this.fade, 1)];
    g.setAttribute('iPos', this.attrs[0]);
    g.setAttribute('iCol', this.attrs[1]);
    g.setAttribute('iSize', this.attrs[2]);
    g.setAttribute('iFade', this.attrs[3]);
    g.instanceCount = 0;
    this.geo = g;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uPxPerM: { value: 1 } },
      vertexShader: DISC_VERT,
      fragmentShader: DISC_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = ORDER.level(0) + 12;
    scene.add(this.mesh);
    this.n = 0;
    this.heads = []; // [{x,y,dir,node}]
  }

  setPxPerM(p) {
    this.material.uniforms.uPxPerM.value = p;
  }

  /** Recompute where the signal heads sit (one per approach of every signalised junction). */
  rebuild(net) {
    this.heads = [];
    for (const n of net.nodes.values()) {
      if (!n.signal) continue;
      const seen = new Set();
      for (const c of n.conns) {
        const dir = c.from.dir;
        if (seen.has(dir)) continue;
        seen.add(dir);
        const lane = dir.lanes[dir.lanes.length - 1];
        const p = lane.poly.pointAt(lane.len);
        const off = 1.9;
        this.heads.push({ x: p.x + p.ty * off - p.tx * 0.5, y: p.y - p.tx * off - p.ty * 0.5, dir, node: n });
      }
    }
  }

  update() {
    let i = 0;
    const move = (node, dir) => {
      let best = 0;
      for (const c of node.conns) {
        if (c.from.dir !== dir) continue;
        const st = node.signal.state(c.moveKey);
        if (st === SIGNAL_GREEN) return 1;
        if (st === SIGNAL_AMBER) best = 2;
      }
      return best;
    };
    for (const h of this.heads) {
      if (i >= this.capacity) break;
      if (!h.node.alive || !h.node.signal || !h.dir.alive) continue;
      const st = move(h.node, h.dir);
      this.pos[i * 2] = h.x;
      this.pos[i * 2 + 1] = h.y;
      const c = st === 1 ? [0.31, 0.78, 0.38] : st === 2 ? [0.96, 0.76, 0.2] : [0.9, 0.3, 0.27];
      this.col[i * 3] = c[0];
      this.col[i * 3 + 1] = c[1];
      this.col[i * 3 + 2] = c[2];
      this.size[i] = 0.95;
      this.fade[i] = 1;
      i++;
    }
    this.n = i;
    this.geo.instanceCount = i;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, a.itemSize * Math.max(1, i));
      a.needsUpdate = true;
    }
    this.mesh.visible = i > 0;
  }
}

/* ------------------------------------------------------------------ badges */

const BADGE_VERT = /* glsl */ `
attribute vec3 iPos; // x, y, icon index
attribute float iSize;
varying vec2 vUv;
varying float vIcon;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  vIcon = iPos.z;
  vec2 p = iPos.xy + position.xy * iSize;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 0.0, 1.0);
}`;
const BADGE_FRAG = /* glsl */ `
varying vec2 vUv;
varying float vIcon;
uniform sampler2D uAtlas;
void main() {
  vec2 uv = vec2((vUv.x + vIcon) / 2.0, vUv.y);
  vec4 c = texture2D(uAtlas, uv);
  if (c.a < 0.02) discard;
  gl_FragColor = c;
}`;

function makeAtlas() {
  const cv = document.createElement('canvas');
  cv.width = 256;
  cv.height = 128;
  const g = cv.getContext('2d');
  const icon = (i, bg, draw) => {
    const cx = 64 + i * 128;
    const cy = 64;
    g.save();
    g.translate(cx, cy);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.beginPath();
    g.arc(2, 5, 56, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#fff';
    g.beginPath();
    g.arc(0, 0, 56, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = bg;
    g.beginPath();
    g.arc(0, 0, 46, 0, Math.PI * 2);
    g.fill();
    draw(g);
    g.restore();
  };
  // 0: no road (exclamation)
  icon(0, '#e0584a', (c) => {
    c.fillStyle = '#fff';
    // rounded bar drawn with plain arcs (CanvasRenderingContext2D.roundRect is missing on older iPads)
    c.beginPath();
    c.arc(0, -22, 6, Math.PI, 0);
    c.lineTo(6, 4);
    c.arc(0, 4, 6, 0, Math.PI);
    c.closePath();
    c.fill();
    c.beginPath();
    c.arc(0, 24, 7.5, 0, Math.PI * 2);
    c.fill();
  });
  // 1: unhappy face
  icon(1, '#f0a53a', (c) => {
    c.fillStyle = '#3a2a12';
    c.beginPath();
    c.arc(-16, -12, 6.5, 0, Math.PI * 2);
    c.arc(16, -12, 6.5, 0, Math.PI * 2);
    c.fill();
    c.strokeStyle = '#3a2a12';
    c.lineWidth = 7;
    c.lineCap = 'round';
    c.beginPath();
    c.arc(0, 30, 20, Math.PI * 1.18, Math.PI * 1.82);
    c.stroke();
    c.lineWidth = 6;
    c.beginPath();
    c.moveTo(-26, -26);
    c.lineTo(-8, -20);
    c.moveTo(26, -26);
    c.lineTo(8, -20);
    c.stroke();
  });
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  return tex;
}

export class BadgeRenderer {
  constructor(scene, capacity = 400) {
    this.capacity = capacity;
    const quad = new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, 1, 1, 0, -1, 1, 0]);
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(quad, 3));
    this.pos = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    const mk = (a, n) => {
      const at = new THREE.InstancedBufferAttribute(a, n);
      at.setUsage(THREE.DynamicDrawUsage);
      return at;
    };
    this.attrs = [mk(this.pos, 3), mk(this.size, 1)];
    g.setAttribute('iPos', this.attrs[0]);
    g.setAttribute('iSize', this.attrs[1]);
    g.instanceCount = 0;
    this.geo = g;
    this.material = new THREE.ShaderMaterial({
      uniforms: { uAtlas: { value: makeAtlas() } },
      vertexShader: BADGE_VERT,
      fragmentShader: BADGE_FRAG,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = ORDER.badges;
    scene.add(this.mesh);
    this.ppm = 1;
  }

  /** badges: array of {x,y,icon}. size scales up when zoomed out so they stay legible. */
  update(list, ppm) {
    const s = Math.max(3.2, Math.min(12, 20 / Math.max(ppm, 0.05)));
    let i = 0;
    for (const b of list) {
      if (i >= this.capacity) break;
      this.pos[i * 3] = b.x;
      this.pos[i * 3 + 1] = b.y;
      this.pos[i * 3 + 2] = b.icon;
      this.size[i] = s;
      i++;
    }
    this.geo.instanceCount = i;
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      a.addUpdateRange(0, a.itemSize * Math.max(1, i));
      a.needsUpdate = true;
    }
    this.mesh.visible = i > 0;
  }
}
