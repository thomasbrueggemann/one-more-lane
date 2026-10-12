// Stamps sw.js with the list of files to precache and a content hash used as the cache version.
// Run before deploying (the GitHub Pages workflow does it): `npm run build:sw`.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const INCLUDE_DIRS = ['css', 'js', 'fonts', 'vendor', 'icons'];
const INCLUDE_FILES = ['index.html', 'manifest.webmanifest'];
const SKIP = (p) => /LICENSE/i.test(p) || p.endsWith('.map') || p.endsWith('.DS_Store');

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = [...INCLUDE_FILES.map((f) => join(root, f)), ...INCLUDE_DIRS.flatMap((d) => walk(join(root, d)))]
  .filter((f) => !SKIP(f))
  .map((f) => relative(root, f).split(sep).join('/'))
  .sort();

const hash = createHash('sha256');
for (const f of files) {
  hash.update(f);
  hash.update(readFileSync(join(root, f)));
}
const version = hash.digest('hex').slice(0, 12);
const assets = ['./', ...files.map((f) => './' + f)];

const swPath = join(root, 'sw.js');
let sw = readFileSync(swPath, 'utf8');
const block = `/* BUILD:START */\nconst VERSION = '${version}';\nconst ASSETS = ${JSON.stringify(assets, null, 2)};\n/* BUILD:END */`;
sw = sw.replace(/\/\* BUILD:START \*\/[\s\S]*?\/\* BUILD:END \*\//, block);
writeFileSync(swPath, sw);
console.log(`sw.js stamped: version ${version}, ${assets.length} precached files`);
