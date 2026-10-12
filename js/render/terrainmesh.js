// Terrain renderer: one quad + a fragment shader that thresholds the smooth field texture,
// giving crisp, anti-aliased contours (water, sand, grass, layered rock with cast shadows) at any zoom.

import * as THREE from '../../vendor/three.module.js';
import { ORDER } from './materials.js';
import { darkBiome } from './theme.js';

const VERT = /* glsl */ `
varying vec2 vWorld;
void main() {
  vWorld = position.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
precision highp float;
varying vec2 vWorld;
uniform sampler2D uField;
uniform float uHalf;
uniform vec3 uBase, uGrass, uSand, uWater, uRock0, uRock1, uRock2, uOutside, uEdge;
uniform vec2 uShadowDir;
uniform float uShadowStrength;

float cover(float f, float thr) {
  float w = fwidth(f) * 0.8 + 1e-4;
  return smoothstep(thr - w, thr + w, f);
}
vec4 field(vec2 p) {
  return texture2D(uField, p / (uHalf * 2.0) + 0.5);
}

void main() {
  vec2 p = vWorld;
  vec4 f = field(p);
  vec3 col = uBase;
  col = mix(col, uSand, cover(f.a, 0.5));
  col = mix(col, uGrass, cover(f.b, 0.5));
  float water = cover(f.r, 0.5);

  // rock tiers
  float r0 = cover(f.g, 0.5);
  float r1 = cover(f.g, 0.64);
  float r2 = cover(f.g, 0.8);

  // cast shadows from rock (and a hint of it on water edges): sample uphill along the sun direction
  float sh = 0.0;
  for (int i = 1; i <= 5; i++) {
    float d = float(i) * 5.0;
    float h = field(p - uShadowDir * d).g;
    sh = max(sh, cover(h, 0.5 + d * 0.011));
  }
  col = mix(col, uWater, water);
  col *= 1.0 - sh * uShadowStrength * (1.0 - r0);

  vec3 rock = mix(uRock0, uRock1, r1);
  rock = mix(rock, uRock2, r2);
  col = mix(col, rock, r0);

  // outside of the map
  vec2 q = abs(p) - uHalf;
  float inside = 1.0 - smoothstep(-0.1, 0.1 + fwidth(q.x) * 0.0, max(q.x, q.y));
  float edge = 1.0 - smoothstep(0.0, 1.6 + fwidth(p.x) * 2.0, abs(max(q.x, q.y)));
  col = mix(uOutside, col, inside);
  col = mix(col, uEdge, edge * 0.8);
  gl_FragColor = vec4(col, 1.0);
}`;

const c3 = (h) => new THREE.Color(h);

export class TerrainMesh {
  constructor(scene, terrain, theme) {
    this.terrain = terrain;
    const tex = new THREE.DataTexture(terrain.textureData(), terrain.res, terrain.res, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    this.texture = tex;
    const size = terrain.size + 4000;
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uField: { value: tex },
        uHalf: { value: terrain.half },
        uBase: { value: c3('#ffffff') },
        uGrass: { value: c3('#ffffff') },
        uSand: { value: c3('#ffffff') },
        uWater: { value: c3('#ffffff') },
        uRock0: { value: c3('#ffffff') },
        uRock1: { value: c3('#ffffff') },
        uRock2: { value: c3('#ffffff') },
        uOutside: { value: c3('#ffffff') },
        uEdge: { value: c3('#ffffff') },
        uShadowDir: { value: new THREE.Vector2(0.7, -0.7) },
        uShadowStrength: { value: 0.2 },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.renderOrder = ORDER.terrain;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.setTheme(theme);
  }

  setTheme(theme) {
    const b = this.terrain.biome;
    const pal = theme.id === 'dark' ? darkBiome(b) : b;
    const u = this.material.uniforms;
    u.uBase.value.set(pal.base);
    u.uGrass.value.set(pal.grass);
    u.uSand.value.set(pal.sand);
    u.uWater.value.set(pal.water);
    u.uRock0.value.set(pal.rock[0]);
    u.uRock1.value.set(pal.rock[1]);
    u.uRock2.value.set(pal.rock[2]);
    u.uOutside.value.set(theme.outside);
    u.uEdge.value.set(theme.mapEdge);
    u.uShadowStrength.value = theme.id === 'dark' ? 0.35 : 0.2;
    u.uShadowDir.value.set(theme.sun[0], theme.sun[1]);
  }

  dispose() {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
