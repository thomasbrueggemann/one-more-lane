// Shared materials and draw-order constants. Everything is transparent+depth-test-off so that renderOrder
// alone decides stacking (buildings opt back into depth testing for their own roofs).

import * as THREE from '../../vendor/three.module.js';

export const ORDER = {
  terrain: 0,
  lot: 4,
  driveway: 15, // casing; the white fill is +1 (drawn above the road fill and markings)
  trafficTint: 8,
  level: (L) => 10 + L * 100, // shadow +0, casing +1, fill +2, tint +3, marks +4, vehicles +10
  buildingShadow: 40,
  buildings: 50,
  badges: 60,
  overlay: 900,
  labels: 950,
};

const FLAT_VERT = /* glsl */ `
attribute vec4 color;
attribute vec2 expand;
uniform float uPxPerM;
uniform float uMinPx;
varying vec4 vColor;
void main() {
  vec3 p = position;
  float b = length(expand);
  if (b > 0.0) {
    float minW = uMinPx / uPxPerM;
    p.xy += expand / b * max(0.0, minW - b);
  }
  vColor = color;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
}`;

const FLAT_FRAG = /* glsl */ `
varying vec4 vColor;
uniform float uOpacity;
void main() {
  gl_FragColor = vec4(vColor.rgb, vColor.a * uOpacity);
}`;

/** Flat vertex-coloured material shared by road layers, ghosts and overlays. */
export function flatMaterial({ minPx = 0, stencilRef = 0 } = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms: { uPxPerM: { value: 1 }, uMinPx: { value: minPx }, uOpacity: { value: 1 } },
    vertexShader: FLAT_VERT,
    fragmentShader: FLAT_FRAG,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  if (stencilRef) {
    // draw each stencil value only once: overlapping shadow shapes then merge instead of doubling their alpha
    m.stencilWrite = true;
    m.stencilRef = stencilRef;
    m.stencilFunc = THREE.NotEqualStencilFunc;
    m.stencilFail = THREE.KeepStencilOp;
    m.stencilZFail = THREE.KeepStencilOp;
    m.stencilZPass = THREE.ReplaceStencilOp;
  }
  return m;
}

/** BufferGeometry from a roadgeom Buf. */
export function geometryFromBuf(buf, geo = null) {
  const g = geo || new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(buf.p), 3));
  g.setAttribute('color', new THREE.BufferAttribute(Float32Array.from(buf.c), 4));
  g.setAttribute('expand', new THREE.BufferAttribute(Float32Array.from(buf.e), 2));
  g.setDrawRange(0, buf.count);
  return g;
}
