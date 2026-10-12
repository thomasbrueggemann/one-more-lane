// Generates the app icons (PNG) with a tiny dependency-free rasteriser: `npm run icons`.
// Motif: a white roundabout with four roads on a warm-grey map, a green island and three little cars.

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(out, { recursive: true });

/* ---------- PNG encoder ---------- */
const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}
function png(w, h, rgba) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------- the picture, in a unit square ---------- */
const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
const GROUND = hex('#ebe9e3');
const KERB = hex('#8d8d8d');
const WHITE = [255, 255, 255];
const GRASS = hex('#c8e3a2');
const YELLOW = hex('#e5c445');
const CARS = [
  { c: hex('#e8789b'), a: -0.9, r: 0.255 },
  { c: hex('#3f72de'), a: 2.45, r: 0.255 },
  { c: hex('#f08c3a'), a: 0.55, r: 0.255 },
];

const R = 0.255; // ring centre-line radius
const RW = 0.075; // ring half width
const RD = 0.07; // road half width
const KB = 0.011; // kerb thickness

/** Is point (x,y) in the road network (ring + four arms), grown by g? */
function road(x, y, g) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const d = Math.hypot(dx, dy);
  if (Math.abs(d - R) <= RW + g) return true;
  if (d >= R - 0.02 && (Math.abs(dx) <= RD + g || Math.abs(dy) <= RD + g)) return d >= R - RW;
  return false;
}

function shade(x, y) {
  const dx = x - 0.5;
  const dy = y - 0.5;
  const d = Math.hypot(dx, dy);
  // cars
  for (const car of CARS) {
    const cx = 0.5 + Math.cos(car.a) * car.r;
    const cy = 0.5 + Math.sin(car.a) * car.r;
    const tx = -Math.sin(car.a);
    const ty = Math.cos(car.a);
    const px = x - cx;
    const py = y - cy;
    const along = px * tx + py * ty;
    const across = -px * ty + py * tx;
    if (Math.abs(along) < 0.052 && Math.abs(across) < 0.026) {
      if (Math.abs(along) < 0.052 - 0.007 && Math.abs(across) < 0.026 - 0.006) return Math.abs(along - 0.012) < 0.016 && Math.abs(across) < 0.02 ? [38, 40, 52] : car.c;
      return [58, 58, 70];
    }
  }
  // island
  if (d < R - RW - KB * 0.2) return d < R - RW - KB ? GRASS : KERB;
  // roads
  if (road(x, y, 0)) {
    // yellow dashes on the arms
    if (d > R + RW + 0.01) {
      if (Math.abs(dy) < 0.006 || Math.abs(dx) < 0.006) {
        const t = Math.floor(d * 24);
        if (t % 2 === 0) return YELLOW;
      }
    }
    return WHITE;
  }
  if (road(x, y, KB)) return KERB;
  return GROUND;
}

function render(size, { rounded, bleed }) {
  const ss = 3;
  const rgba = Buffer.alloc(size * size * 4);
  const cr = 0.22; // corner radius for the rounded version
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          let x = (px + (sx + 0.5) / ss) / size;
          let y = (py + (sy + 0.5) / ss) / size;
          let cover = 1;
          if (rounded) {
            const ex = Math.max(Math.abs(x - 0.5) - (0.5 - cr), 0);
            const ey = Math.max(Math.abs(y - 0.5) - (0.5 - cr), 0);
            if (Math.hypot(ex, ey) > cr) cover = 0;
          }
          if (cover) {
            if (bleed) {
              // maskable: shrink the artwork into the safe zone, extend ground colour around it
              x = 0.5 + (x - 0.5) / 0.74;
              y = 0.5 + (y - 0.5) / 0.74;
              if (x < 0 || x > 1 || y < 0 || y > 1) {
                // extend the edge pixels outwards so the roads (kerbs and all) run off the icon
                const c = shade(Math.min(1, Math.max(0, x)), Math.min(1, Math.max(0, y)));
                r += c[0];
                g += c[1];
                b += c[2];
                a += 255;
                continue;
              }
            }
            const c = shade(x, y);
            r += c[0];
            g += c[1];
            b += c[2];
            a += 255;
          }
        }
      }
      const n = ss * ss;
      const i = (py * size + px) * 4;
      const cov = a / (255 * n);
      rgba[i] = cov ? Math.round(r / (cov * n)) : 0;
      rgba[i + 1] = cov ? Math.round(g / (cov * n)) : 0;
      rgba[i + 2] = cov ? Math.round(b / (cov * n)) : 0;
      rgba[i + 3] = Math.round(cov * 255);
    }
  }
  return png(size, size, rgba);
}

const jobs = [
  ['icon-192.png', 192, { rounded: true }],
  ['icon-512.png', 512, { rounded: true }],
  ['icon-maskable-512.png', 512, { bleed: true }],
  ['apple-touch-icon.png', 180, {}],
  ['favicon-32.png', 32, { rounded: true }],
];
for (const [name, size, opt] of jobs) {
  writeFileSync(join(out, name), render(size, opt));
  console.log('wrote icons/' + name);
}

// Vector version used as the favicon and "any" icon: same geometry as the raster.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="113" fill="#ebe9e3"/>
  <g stroke="#8d8d8d" stroke-width="10" stroke-linejoin="round" fill="none">
    <circle cx="256" cy="256" r="131" stroke-width="${(RW * 2 + KB * 2) * 512}"/>
    <path d="M256 0V125M256 387V512M0 256H125M387 256H512" stroke-width="${(RD * 2 + KB * 2) * 512}" stroke-linecap="butt"/>
  </g>
  <g stroke="#fff" fill="none">
    <circle cx="256" cy="256" r="131" stroke-width="${RW * 2 * 512}"/>
    <path d="M256 0V125M256 387V512M0 256H125M387 256H512" stroke-width="${RD * 2 * 512}"/>
  </g>
  <circle cx="256" cy="256" r="${(R - RW - KB) * 512}" fill="#c8e3a2"/>
  <g fill="none" stroke="#e5c445" stroke-width="5" stroke-dasharray="14 14">
    <path d="M256 12V118M256 394V500M12 256H118M394 256H500"/>
  </g>
  <rect x="${(0.5 + Math.cos(-0.9) * R) * 512 - 26}" y="${(0.5 + Math.sin(-0.9) * R) * 512 - 13}" width="52" height="26" rx="9" fill="#e8789b" transform="rotate(${(-0.9 + Math.PI / 2) * 57.2958 - 90} ${(0.5 + Math.cos(-0.9) * R) * 512} ${(0.5 + Math.sin(-0.9) * R) * 512})"/>
  <rect x="${(0.5 + Math.cos(2.45) * R) * 512 - 26}" y="${(0.5 + Math.sin(2.45) * R) * 512 - 13}" width="52" height="26" rx="9" fill="#3f72de" transform="rotate(${(2.45 + Math.PI / 2) * 57.2958 - 90} ${(0.5 + Math.cos(2.45) * R) * 512} ${(0.5 + Math.sin(2.45) * R) * 512})"/>
  <rect x="${(0.5 + Math.cos(0.55) * R) * 512 - 26}" y="${(0.5 + Math.sin(0.55) * R) * 512 - 13}" width="52" height="26" rx="9" fill="#f08c3a" transform="rotate(${(0.55 + Math.PI / 2) * 57.2958 - 90} ${(0.5 + Math.cos(0.55) * R) * 512} ${(0.5 + Math.sin(0.55) * R) * 512})"/>
</svg>
`;
writeFileSync(join(out, 'icon.svg'), svg);
console.log('wrote icons/icon.svg');
