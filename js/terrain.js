// Procedural terrain: four scalar fields (water, rock, grass, sand) on a coarse grid.
// The same data feeds the GPU shader (crisp iso-contours at any zoom) and CPU collision queries.
// Each field is a smooth ramp that crosses 0.5 at the feature outline; thresholds are chosen by quantile so a
// biome always has roughly the requested amount of water / rock / grass / sand whatever the seed.

import { Simplex2, Rng, clamp, smoothstep, lerp } from './util.js';

export const BIOMES = {
  meadow: {
    name: 'Meadow',
    blurb: 'Rolling grassland with a few lakes',
    base: '#ebe9e3',
    grass: '#c8e3a2',
    sand: '#f1e4ab',
    water: '#a5bdf1',
    rock: ['#5e5e5e', '#727272', '#8c8c8c'],
    cover: { water: 0.09, rock: 0.07, grass: 0.32, sand: 0.07, beach: 0.025 },
  },
  desert: {
    name: 'Desert',
    blurb: 'Sand, canyons and the odd oasis',
    base: '#f0e9d6',
    grass: '#d3e0a4',
    sand: '#ead2a0',
    water: '#a0bdea',
    rock: ['#6e5230', '#86653a', '#a07d4b'],
    cover: { water: 0.025, rock: 0.1, grass: 0.04, sand: 0.45, beach: 0.015 },
  },
  highlands: {
    name: 'Highlands',
    blurb: 'Rocky ridges that force clever routing',
    base: '#e7e8e1',
    grass: '#bfd99d',
    sand: '#e9deb4',
    water: '#9eb7ec',
    rock: ['#575757', '#6b6b6b', '#868686'],
    cover: { water: 0.06, rock: 0.2, grass: 0.3, sand: 0.05, beach: 0.015 },
  },
  coast: {
    name: 'Coast',
    blurb: 'A long shoreline and wide beaches',
    base: '#ece9df',
    grass: '#c6e0a0',
    sand: '#f2e5ae',
    water: '#86c8ec',
    rock: ['#606060', '#757575', '#8e8e8e'],
    cover: { water: 0.26, rock: 0.05, grass: 0.3, sand: 0.06, beach: 0.04 },
    sea: true,
  },
};

function quantile(arr, q) {
  const s = Float32Array.from(arr).sort();
  return s[clamp(Math.floor(q * (s.length - 1)), 0, s.length - 1)];
}

export class Terrain {
  /**
   * @param {{seed:number, biome:string, size?:number, res?:number}} opts
   */
  constructor({ seed, biome = 'meadow', size = 2400, res = 512 }) {
    this.seed = seed;
    this.biomeId = BIOMES[biome] ? biome : 'meadow';
    this.biome = BIOMES[this.biomeId];
    this.size = size;
    this.res = res;
    this.half = size / 2;
    const n = res * res;
    this.water = new Float32Array(n);
    this.rock = new Float32Array(n);
    this.grass = new Float32Array(n);
    this.sand = new Float32Array(n);
    this.generate();
  }

  generate() {
    const { seed, res, size, biome } = this;
    const cv = biome.cover;
    const nW = new Simplex2(seed * 7 + 1);
    const nR = new Simplex2(seed * 13 + 5);
    const nG = new Simplex2(seed * 29 + 11);
    const nS = new Simplex2(seed * 31 + 17);
    const nWarp = new Simplex2(seed * 3 + 23);
    const seaAng = (((seed * 2654435761) >>> 0) % 628) / 100;
    const sx = Math.cos(seaAng);
    const sy = Math.sin(seaAng);
    const cell = size / res;
    const n = res * res;
    const rw = new Float32Array(n);
    const rr = new Float32Array(n);
    const rg = new Float32Array(n);
    const rs = new Float32Array(n);
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = (i + 0.5) * cell - this.half;
        const y = (j + 0.5) * cell - this.half;
        // a gentle domain warp keeps shorelines from looking like plain noise contours
        const wx = x + nWarp.noise(x / 650, y / 650) * 70;
        const wy = y + nWarp.noise(x / 650 + 31, y / 650 + 17) * 70;
        const k = i + j * res;
        let nw = nW.fbm(wx / 900, wy / 900, 3, 2, 0.45);
        if (biome.sea) nw = nw * 0.5 + ((x * sx + y * sy) / (size * 0.5)) * 0.95;
        rw[k] = nw;
        rr[k] = 0.16 * nR.fbm(wx / 120 + 100, wy / 120 + 100, 2, 2, 0.5); // ragged outlines for the hills
        rg[k] = nG.fbm(wx / 520, wy / 520, 3, 2, 0.45);
        rs[k] = nS.fbm(wx / 560 + 400, wy / 560 + 400, 2, 2, 0.5);
      }
    }
    // hills: summed elliptical bumps => chunky blobs with concentric terraces
    {
      const hr = new Rng(seed * 97 + 3);
      const count = Math.round(cv.rock * 420);
      for (let h = 0; h < count; h++) {
        const cx = hr.range(-this.half, this.half);
        const cy = hr.range(-this.half, this.half);
        const r = hr.range(48, 118);
        const a = r * hr.range(0.9, 1.7);
        const ang = hr.range(0, Math.PI);
        const w = hr.range(0.75, 1.15);
        const ca = Math.cos(ang);
        const sa = Math.sin(ang);
        const reach = Math.max(a, r) * 2.4;
        const i0 = Math.max(0, Math.floor((cx - reach + this.half) / cell));
        const i1 = Math.min(res - 1, Math.ceil((cx + reach + this.half) / cell));
        const j0 = Math.max(0, Math.floor((cy - reach + this.half) / cell));
        const j1 = Math.min(res - 1, Math.ceil((cy + reach + this.half) / cell));
        for (let j = j0; j <= j1; j++) {
          for (let i = i0; i <= i1; i++) {
            const dx = (i + 0.5) * cell - this.half - cx;
            const dy = (j + 0.5) * cell - this.half - cy;
            const u = (dx * ca + dy * sa) / a;
            const v = (-dx * sa + dy * ca) / r;
            rr[i + j * res] += w * Math.exp(-(u * u + v * v));
          }
        }
      }
    }
    // sample every few cells for quantiles
    const sample = (arr) => {
      const out = [];
      for (let j = 0; j < res; j += 3) for (let i = 0; i < res; i += 3) out.push(arr[i + j * res]);
      return out;
    };
    const tW = quantile(sample(rw), 1 - cv.water);
    const tB = quantile(sample(rw), 1 - cv.water - cv.beach);
    const tR = quantile(sample(rr), 1 - cv.rock);
    const tG = quantile(sample(rg), 1 - cv.grass);
    const tS = quantile(sample(rs), 1 - cv.sand);
    // field slopes: bigger = crisper shoreline. Rock ramps gently so its tiers form wide terraces.
    const KW = 9;
    const KR = 1.25;
    const KG = 8;
    for (let j = 0; j < res; j++) {
      for (let i = 0; i < res; i++) {
        const x = (i + 0.5) * cell - this.half;
        const y = (j + 0.5) * cell - this.half;
        const k = i + j * res;
        const d = Math.hypot(x, y);
        const keep = smoothstep(150, 330, d); // the start area stays flat and buildable
        const water = 0.5 + (rw[k] - tW) * KW;
        const beach = 0.5 + (rw[k] - tB) * KW;
        const rock = 0.5 + (rr[k] - tR) * KR;
        this.water[k] = clamp(lerp(0, water, keep), 0, 1);
        this.rock[k] = clamp(lerp(0, rock, keep), 0, 1);
        this.grass[k] = clamp(0.5 + (rg[k] - tG) * KG, 0, 1);
        this.sand[k] = clamp(Math.max(beach, 0.5 + (rs[k] - tS) * KG), 0, 1);
      }
    }
  }

  /** RGBA bytes for the GPU texture: R water, G rock, B grass, A sand. */
  textureData() {
    const n = this.res * this.res;
    const out = new Uint8Array(n * 4);
    for (let k = 0; k < n; k++) {
      out[k * 4] = Math.round(this.water[k] * 255);
      out[k * 4 + 1] = Math.round(this.rock[k] * 255);
      out[k * 4 + 2] = Math.round(this.grass[k] * 255);
      out[k * 4 + 3] = Math.round(this.sand[k] * 255);
    }
    return out;
  }

  inside(x, y, margin = 0) {
    return Math.abs(x) <= this.half - margin && Math.abs(y) <= this.half - margin;
  }

  bilinear(arr, x, y) {
    const res = this.res;
    const u = ((x + this.half) / this.size) * res - 0.5;
    const v = ((y + this.half) / this.size) * res - 0.5;
    const i0 = clamp(Math.floor(u), 0, res - 1);
    const j0 = clamp(Math.floor(v), 0, res - 1);
    const i1 = Math.min(i0 + 1, res - 1);
    const j1 = Math.min(j0 + 1, res - 1);
    const fu = clamp(u - i0, 0, 1);
    const fv = clamp(v - j0, 0, 1);
    const a = arr[i0 + j0 * res];
    const b = arr[i1 + j0 * res];
    const c = arr[i0 + j1 * res];
    const d = arr[i1 + j1 * res];
    return (a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv;
  }

  isWater(x, y) {
    return this.bilinear(this.water, x, y) > 0.5;
  }
  isRock(x, y) {
    return this.bilinear(this.rock, x, y) > 0.5;
  }

  /** 'bounds' | 'water' | 'rock' | null for a single point. */
  blockedAt(x, y) {
    if (!this.inside(x, y, 6)) return 'bounds';
    if (this.bilinear(this.water, x, y) > 0.5) return 'water';
    if (this.bilinear(this.rock, x, y) > 0.5) return 'rock';
    return null;
  }

  /** Check a disc: centre plus a ring of probes. */
  blockedDisc(x, y, r) {
    const c = this.blockedAt(x, y);
    if (c) return c;
    if (r <= 0) return null;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const b = this.blockedAt(x + Math.cos(a) * r, y + Math.sin(a) * r);
      if (b) return b;
    }
    return null;
  }

  /** Terrain type for colouring decisions: 'grass' | 'sand' | 'plain'. */
  surfaceAt(x, y) {
    if (this.bilinear(this.sand, x, y) > 0.5) return 'sand';
    if (this.bilinear(this.grass, x, y) > 0.5) return 'grass';
    return 'plain';
  }
}
