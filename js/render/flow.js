// "Traffic view": tints every directed road by congestion (green free flow -> red jammed).
// Geometry is built once per network change; only vertex colours are rewritten a couple of times per second.

import * as THREE from '../../vendor/three.module.js';
import { Buf, ribbon } from './roadgeom.js';
import { flatMaterial, ORDER } from './materials.js';
import { LANE_W } from '../network.js';

const FREE = [0.3, 0.76, 0.42];
const SLOW = [0.97, 0.8, 0.2];
const JAM = [0.9, 0.24, 0.2];

function ramp(c) {
  // c: congestion multiplier (1 = free flow)
  if (c <= 1.6) {
    const t = Math.max(0, (c - 1) / 0.6);
    return [FREE[0] + (SLOW[0] - FREE[0]) * t, FREE[1] + (SLOW[1] - FREE[1]) * t, FREE[2] + (SLOW[2] - FREE[2]) * t];
  }
  const t = Math.min(1, (c - 1.6) / 2.4);
  return [SLOW[0] + (JAM[0] - SLOW[0]) * t, SLOW[1] + (JAM[1] - SLOW[1]) * t, SLOW[2] + (JAM[2] - SLOW[2]) * t];
}

export class FlowOverlay {
  constructor(scene) {
    this.group = new THREE.Group();
    scene.add(this.group);
    this.visible = false;
    this.levels = [];
    this.mats = [];
    for (let L = 0; L < 3; L++) {
      const mat = flatMaterial();
      const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = ORDER.level(L) + 3;
      mesh.visible = false;
      this.group.add(mesh);
      this.levels.push({ mesh, ranges: [], attr: null });
      this.mats.push(mat);
    }
    this.group.visible = false;
  }

  setVisible(v) {
    this.visible = v;
    this.group.visible = v;
  }

  setPxPerM(p) {
    for (const m of this.mats) m.uniforms.uPxPerM.value = p;
  }

  rebuild(net) {
    const bufs = [new Buf(), new Buf(), new Buf()];
    const ranges = [[], [], []];
    const tmp = [0, 0, 0, 0.5];
    for (const e of net.edges.values()) {
      if (e.invalid || !e.trimmed) continue;
      const L = Math.min(2, Math.max(0, e.level));
      const buf = bufs[L];
      for (const dir of [e.dirF, e.dirB]) {
        if (!dir) continue;
        const start = buf.count;
        const n = dir.lanes.length;
        if (dir.fwd) ribbon(buf, e.trimmed, e.xm, e.xm + n * LANE_W, tmp);
        else ribbon(buf, e.trimmed, e.xm - n * LANE_W, e.xm, tmp);
        ranges[L].push({ dir, start, end: buf.count });
      }
    }
    for (let L = 0; L < 3; L++) {
      const lv = this.levels[L];
      const b = bufs[L];
      lv.mesh.geometry.dispose();
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(b.p), 3));
      lv.attr = new THREE.BufferAttribute(Float32Array.from(b.c), 4);
      lv.attr.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute('color', lv.attr);
      g.setAttribute('expand', new THREE.BufferAttribute(Float32Array.from(b.e), 2));
      lv.mesh.geometry = g;
      lv.mesh.visible = b.count > 0;
      lv.ranges = ranges[L];
    }
    this.update();
  }

  update() {
    for (const lv of this.levels) {
      if (!lv.attr) continue;
      const arr = lv.attr.array;
      for (const r of lv.ranges) {
        const col = ramp(r.dir.alive ? r.dir.cong : 1);
        const a = r.dir.alive && r.dir.flowN > 0 ? 0.62 : 0.34;
        for (let i = r.start; i < r.end; i++) {
          arr[i * 4] = col[0];
          arr[i * 4 + 1] = col[1];
          arr[i * 4 + 2] = col[2];
          arr[i * 4 + 3] = a;
        }
      }
      lv.attr.needsUpdate = true;
    }
  }
}
