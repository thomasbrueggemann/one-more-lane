// Merges per-edge / per-junction geometry (cached on the model objects) into one mesh per layer and level.

import * as THREE from '../../vendor/three.module.js';
import { buildEdgeParts, buildNodeParts } from './roadgeom.js';
import { flatMaterial, ORDER } from './materials.js';
import { smoothstep } from '../util.js';

const LAYERS = ['shadow', 'casing', 'fill', 'marks'];
const OFFSET = { shadow: 0, casing: 1, fill: 2, marks: 4 };

function freeze(buf) {
  return { p: Float32Array.from(buf.p), c: Float32Array.from(buf.c), e: Float32Array.from(buf.e), n: buf.count };
}

function merge(list) {
  let n = 0;
  for (const f of list) n += f.n;
  const p = new Float32Array(n * 3);
  const c = new Float32Array(n * 4);
  const e = new Float32Array(n * 2);
  let o = 0;
  for (const f of list) {
    p.set(f.p, o * 3);
    c.set(f.c, o * 4);
    e.set(f.e, o * 2);
    o += f.n;
  }
  return { p, c, e, n };
}

export class RoadRenderer {
  constructor(scene, theme) {
    this.theme = theme;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.levels = [];
    this.materials = [];
    for (let L = 0; L < 3; L++) {
      const lv = {};
      for (const layer of LAYERS) {
        const mat = flatMaterial({ minPx: layer === 'casing' ? 1.5 : 0, stencilRef: layer === 'shadow' ? 10 + L : 0 });
        const mesh = new THREE.Mesh(new THREE.BufferGeometry(), mat);
        mesh.frustumCulled = false;
        mesh.renderOrder = ORDER.level(L) + OFFSET[layer];
        mesh.visible = false;
        this.group.add(mesh);
        lv[layer] = mesh;
        this.materials.push({ mat, layer });
      }
      this.levels.push(lv);
    }
  }

  setTheme(theme) {
    this.theme = theme;
  }

  setPxPerM(ppm) {
    for (const { mat, layer } of this.materials) {
      mat.uniforms.uPxPerM.value = ppm;
      if (layer === 'marks') mat.uniforms.uOpacity.value = smoothstep(1.1, 2.6, ppm);
    }
  }

  rebuild(network) {
    const th = this.theme;
    const acc = [0, 1, 2].map(() => ({ shadow: [], casing: [], fill: [], marks: [] }));
    for (const e of network.edges.values()) {
      let cache = e._rp;
      if (!cache || cache.v !== e.geomVersion || cache.th !== th.id) {
        const parts = buildEdgeParts(e, th);
        cache = e._rp = {
          v: e.geomVersion,
          th: th.id,
          level: Math.min(2, Math.max(0, parts.level)),
          layers: LAYERS.map((l) => freeze(parts[l])),
        };
      }
      LAYERS.forEach((l, i) => {
        if (cache.layers[i].n) acc[cache.level][l].push(cache.layers[i]);
      });
    }
    for (const n of network.nodes.values()) {
      let cache = n._rp;
      if (!cache || cache.v !== n.geomVersion || cache.th !== th.id || cache.z !== n.z) {
        const parts = buildNodeParts(n, th);
        cache = n._rp = {
          v: n.geomVersion,
          th: th.id,
          z: n.z,
          level: Math.min(2, Math.max(0, parts.level)),
          casing: freeze(parts.casing),
          fill: freeze(parts.fill),
        };
      }
      if (cache.casing.n) acc[cache.level].casing.push(cache.casing);
      if (cache.fill.n) acc[cache.level].fill.push(cache.fill);
    }
    for (let L = 0; L < 3; L++) {
      for (const layer of LAYERS) {
        const mesh = this.levels[L][layer];
        const m = merge(acc[L][layer]);
        mesh.geometry.dispose();
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(m.p, 3));
        g.setAttribute('color', new THREE.BufferAttribute(m.c, 4));
        g.setAttribute('expand', new THREE.BufferAttribute(m.e, 2));
        mesh.geometry = g;
        mesh.visible = m.n > 0;
      }
    }
  }
}
