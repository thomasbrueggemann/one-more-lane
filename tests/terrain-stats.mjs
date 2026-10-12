import { Terrain, BIOMES } from '../js/terrain.js';
const seeds = [1, 2, 3, 4, 5, 6];
for (const b of Object.keys(BIOMES)) {
  const acc = { w: 0, r: 0, g: 0, s: 0 };
  for (const seed of seeds) {
    const t = new Terrain({ seed, biome: b, res: 256 });
    const n = t.res * t.res;
    for (let k = 0; k < n; k++) {
      if (t.water[k] > 0.5) acc.w++;
      if (t.rock[k] > 0.5) acc.r++;
      if (t.grass[k] > 0.5) acc.g++;
      if (t.sand[k] > 0.5) acc.s++;
    }
  }
  const tot = seeds.length * 256 * 256;
  console.log(b.padEnd(10), 'water', (100 * acc.w / tot).toFixed(1) + '%', 'rock', (100 * acc.r / tot).toFixed(1) + '%', 'grass', (100 * acc.g / tot).toFixed(1) + '%', 'sand', (100 * acc.s / tot).toFixed(1) + '%');
}
