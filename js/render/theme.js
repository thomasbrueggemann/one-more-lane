// Colour themes. Colours are plain sRGB values that reach the screen unchanged (colour management is off).

export const hex = (h, a = 1) => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
};

export const THEMES = {
  light: {
    id: 'light',
    page: '#ebe9e3',
    outside: '#d7d5ce',
    mapEdge: '#b9b6ad',
    road: hex('#ffffff'),
    casing: hex('#8f8f8f'),
    casingElev: hex('#16161a'),
    yellow: hex('#e5c445'),
    dash: hex('#a9a9a9'),
    stop: hex('#b4b4b4'),
    arrow: hex('#c4c4c4'),
    shadow: hex('#23232a', 0.16),
    lot: hex('#ffffff', 0.35),
    driveway: hex('#ffffff'),
    ghostOk: hex('#6fb4e8', 0.55),
    ghostBad: hex('#e0584a', 0.5),
    ghostCasing: hex('#2a2a30', 0.9),
    carOutline: hex('#3a3a44', 0.85),
    sun: [0.7, -0.7],
  },
  dark: {
    id: 'dark',
    page: '#1d2026',
    outside: '#15171b',
    mapEdge: '#3a3e47',
    road: hex('#41454e'),
    casing: hex('#2a2d34'),
    casingElev: hex('#0c0d10'),
    yellow: hex('#d9b64a'),
    dash: hex('#6c717c'),
    stop: hex('#767b86'),
    arrow: hex('#6a6f7a'),
    shadow: hex('#000000', 0.32),
    lot: hex('#ffffff', 0.05),
    driveway: hex('#41454e'),
    ghostOk: hex('#6fb4e8', 0.55),
    ghostBad: hex('#e0584a', 0.55),
    ghostCasing: hex('#e8e8ee', 0.85),
    carOutline: hex('#0e0f12', 0.85),
    sun: [0.7, -0.7],
  },
};

/** Biome ground palettes for the dark theme (derived by darkening/desaturating). */
export function darkBiome(b) {
  const dim = (c, k, tint = [0, 0, 0]) => {
    const n = parseInt(c.slice(1), 16);
    const r = Math.round(((n >> 16) & 255) * k + tint[0]);
    const g = Math.round(((n >> 8) & 255) * k + tint[1]);
    const bl = Math.round((n & 255) * k + tint[2]);
    return '#' + ((1 << 24) | (Math.min(255, r) << 16) | (Math.min(255, g) << 8) | Math.min(255, bl)).toString(16).slice(1);
  };
  return {
    base: dim(b.base, 0.2, [6, 8, 13]),
    grass: dim(b.grass, 0.36, [4, 8, 6]),
    sand: dim(b.sand, 0.34, [6, 6, 4]),
    water: dim(b.water, 0.42, [4, 8, 26]),
    rock: b.rock.map((c, i) => dim(c, 0.62 + i * 0.12)),
  };
}
