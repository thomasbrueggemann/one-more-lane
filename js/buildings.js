// Building archetypes: footprint sizes, economy numbers and procedural 3D shapes (no three.js here).
// Local frame: +x points from the building towards the road (its "front"), y runs along the road.

import { Rng } from './util.js';

export const BUILDING_TYPES = {
  house: { id: 'house', name: 'House', w: 14, d: 9, color: '#79b04a', pop: 4, jobs: 0, tax: 0.2, trips: 1 },
  shop: { id: 'shop', name: 'Shop', w: 18, d: 20, color: '#3f72de', pop: 0, jobs: 6, tax: 0.36, trips: 0 },
  factory: { id: 'factory', name: 'Factory', w: 22, d: 17, color: '#e8873b', pop: 0, jobs: 12, tax: 0.46, trips: 0 },
  office: { id: 'office', name: 'Office', w: 15, d: 15, color: '#7048c8', pop: 0, jobs: 14, tax: 0.42, trips: 0 },
};

export const BUILDING_ORDER = ['house', 'shop', 'office', 'factory'];

const GREENS = [
  [0.49, 0.71, 0.3],
  [0.4, 0.63, 0.25],
  [0.55, 0.76, 0.34],
];

const LIGHT = (() => {
  const l = [-0.45, 0.5, 0.75];
  const n = Math.hypot(...l);
  return l.map((v) => v / n);
})();

/** Shade factor for a surface normal given in world space. */
export function shade(nx, ny, nz) {
  const d = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
  return 0.6 + 0.58 * d;
}

class Shape {
  constructor() {
    this.polys = []; // {pts:[[x,y,z]...], color:[r,g,b]}
    this.shadows = []; // {rect:[cx,cy,hw,hd], h}
    this.decals = []; // {pts:[[x,y]...], color:[r,g,b,a]}
  }
  poly(pts, color) {
    // orient so the normal points up
    let nz = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      nz += a[0] * b[1] - b[0] * a[1];
    }
    this.polys.push({ pts: nz < 0 ? pts.slice().reverse() : pts, color });
  }
  box(x0, x1, y0, y1, z, color) {
    this.poly([[x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z]], color);
  }
  /** Gable roof; ridge along y when ridgeY is true. */
  gable(x0, x1, y0, y1, ze, zr, color, ridgeY = true, ov = 0.5) {
    if (ridgeY) {
      const xm = (x0 + x1) / 2;
      this.poly([[x1 + ov, y0 - ov, ze], [x1 + ov, y1 + ov, ze], [xm, y1 + ov, zr], [xm, y0 - ov, zr]], color);
      this.poly([[x0 - ov, y1 + ov, ze], [x0 - ov, y0 - ov, ze], [xm, y0 - ov, zr], [xm, y1 + ov, zr]], color);
    } else {
      const ym = (y0 + y1) / 2;
      this.poly([[x0 - ov, y1 + ov, ze], [x1 + ov, y1 + ov, ze], [x1 + ov, ym, zr], [x0 - ov, ym, zr]], color);
      this.poly([[x1 + ov, y0 - ov, ze], [x0 - ov, y0 - ov, ze], [x0 - ov, ym, zr], [x1 + ov, ym, zr]], color);
    }
  }
  shadow(cx, cy, hw, hd, h) {
    this.shadows.push({ rect: [cx, cy, hw, hd], h });
  }
  decal(pts, color) {
    this.decals.push({ pts, color });
  }
  rectDecal(x0, x1, y0, y1, color) {
    this.decals.push({ pts: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], color });
  }
}

const mul = (c, k) => [Math.min(1, c[0] * k), Math.min(1, c[1] * k), Math.min(1, c[2] * k)];

function houseShape(rng) {
  const s = new Shape();
  const tone = rng.pick(GREENS);
  const flip = rng.chance(0.5) ? 1 : -1;
  const bw = rng.range(8.2, 9.6) / 2; // half width along y
  const bd = rng.range(5.4, 6.4) / 2; // half depth along x
  const ridgeY = rng.chance(0.72);
  s.gable(-bd, bd, -bw, bw, 3.0, 5.0, tone, ridgeY, 0.45);
  // garage wing
  const gw = rng.range(3.4, 4.0);
  const y0 = flip > 0 ? bw + 0.2 : -bw - 0.2 - gw;
  const gTone = mul(tone, 1.12);
  if (rng.chance(0.65)) s.gable(-bd + 0.6, bd - 0.2, y0, y0 + gw, 2.5, 3.6, gTone, false, 0.3);
  else s.box(-bd + 0.5, bd - 0.1, y0, y0 + gw, 2.7, gTone);
  s.shadow(0, 0, bd, bw, 4.4);
  s.shadow(0, y0 + gw / 2, bd - 0.3, gw / 2, 2.8);
  // lot patch (the lighter rounded square under the house)
  s.decal(roundedPoly(-4.6, 4.5, -7.0, 7.0, 1.6), [1, 1, 1, 0.34]);
  return s;
}

function shopShape(rng) {
  const s = new Shape();
  const blue = rng.chance(0.5) ? [0.25, 0.45, 0.88] : [0.22, 0.4, 0.8];
  const hx = 5.4;
  const hy = rng.range(6.8, 8.2);
  s.box(-hx, hx, -hy, hy, 4.2, blue);
  // roof ribs across the width
  const rib = mul(blue, 0.78);
  for (let x = -hx + 0.9; x < hx - 0.5; x += 1.25) s.box(x, x + 0.34, -hy + 0.4, hy - 0.4, 4.35, rib);
  // front canopy and entrance
  s.box(hx - 0.1, hx + 1.6, -2.4, 2.4, 2.8, mul(blue, 1.18));
  s.shadow(0, 0, hx, hy, 4.2);
  s.shadow(hx + 0.75, 0, 0.85, 2.4, 2.8);
  // parking apron in front with stalls
  s.rectDecal(hx + 0.2, hx + 10.2, -hy - 0.8, hy + 0.8, [0.86, 0.86, 0.85, 0.9]);
  for (let y = -hy + 0.4; y <= hy - 0.2; y += 2.7) s.rectDecal(hx + 2.4, hx + 7.9, y - 0.07, y + 0.07, [1, 1, 1, 0.95]);
  return s;
}

function factoryShape(rng) {
  const s = new Shape();
  const grey = [0.45, 0.47, 0.5];
  const orange = [0.92, 0.55, 0.23];
  const hx = 6.5;
  const hy = rng.range(8.8, 10.2);
  s.box(-hx, hx, -hy, hy, 4.0, grey);
  // saw-tooth roofs: each slab has a lit and a shaded slope
  const n = 4;
  const slab = (2 * hy - 1.6) / n;
  for (let i = 0; i < n; i++) {
    const y0 = -hy + 0.8 + i * slab;
    const y1 = y0 + slab - 0.55;
    s.poly([[-hx + 0.8, y0, 4.1], [hx - 2.0, y0, 4.1], [hx - 2.0, y1, 5.6], [-hx + 0.8, y1, 5.6]], orange);
    s.poly([[-hx + 0.8, y1, 5.6], [hx - 2.0, y1, 5.6], [hx - 2.0, y1 + 0.55, 4.1], [-hx + 0.8, y1 + 0.55, 4.1]], mul(orange, 0.85));
  }
  // annex and chimney
  s.box(hx - 1.7, hx + 1.9, -hy * 0.45, hy * 0.45, 3.0, mul(grey, 1.18));
  const cy = hy - 2.2;
  const chim = [];
  for (let k = 0; k < 14; k++) chim.push([-hx + 1.9 + Math.cos((k / 14) * 6.2832) * 1.1, cy + Math.sin((k / 14) * 6.2832) * 1.1, 9.5]);
  s.poly(chim, [0.33, 0.34, 0.37]);
  s.shadow(0, 0, hx, hy, 5.2);
  s.shadow(-hx + 1.9, cy, 1.1, 1.1, 9.5);
  s.shadow(hx + 0.1, 0, 1.8, hy * 0.45, 3.0);
  s.rectDecal(hx + 1.9, hx + 8.2, -hy - 0.5, hy + 0.5, [0.8, 0.8, 0.78, 0.85]);
  return s;
}

function officeShape(rng) {
  const s = new Shape();
  const purple = rng.chance(0.5) ? [0.45, 0.29, 0.79] : [0.4, 0.26, 0.72];
  const hx = 5.8;
  const hy = 6.2;
  s.box(-hx, hx, -hy, hy, 7.0, purple);
  s.box(-hx + 1.5, hx - 2.2, -hy + 1.6, hy - 1.6, 11.5, mul(purple, 0.82));
  // rooftop plant
  s.box(-1.2, 1.2, -1.3, 1.3, 11.9, mul(purple, 1.25));
  s.box(hx - 1.6, hx - 0.6, hy - 2.0, hy - 0.8, 7.2, mul(purple, 1.2));
  s.shadow(0, 0, hx, hy, 7.0);
  s.shadow(-0.35, 0, hx - 1.85, hy - 1.6, 11.5);
  s.rectDecal(hx + 0.2, hx + 6.2, -hy, hy, [0.86, 0.86, 0.85, 0.9]);
  for (let y = -hy + 1.0; y <= hy - 0.5; y += 2.6) s.rectDecal(hx + 1.5, hx + 5.4, y - 0.07, y + 0.07, [1, 1, 1, 0.95]);
  return s;
}

function roundedPoly(x0, x1, y0, y1, r, steps = 4) {
  const pts = [];
  const cs = [
    [x1 - r, y1 - r, 0],
    [x0 + r, y1 - r, Math.PI / 2],
    [x0 + r, y0 + r, Math.PI],
    [x1 - r, y0 + r, Math.PI * 1.5],
  ];
  for (const [cx, cy, a0] of cs) {
    for (let i = 0; i <= steps; i++) {
      const a = a0 + (i / steps) * (Math.PI / 2);
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
  }
  return pts;
}

const SHAPES = { house: houseShape, shop: shopShape, factory: factoryShape, office: officeShape };

const shapeCache = new Map();
/** Deterministic local-space shape for a building (cached by type+seed). */
export function shapeFor(type, seed) {
  const key = `${type}:${seed}`;
  let s = shapeCache.get(key);
  if (!s) {
    s = SHAPES[type](new Rng(seed * 7919 + 13));
    shapeCache.set(key, s);
  }
  return s;
}
