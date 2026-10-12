// Renderer, orthographic top-down camera and pan/zoom state.

import * as THREE from '../../vendor/three.module.js';
import { clamp } from '../util.js';

THREE.ColorManagement.enabled = false;

export class View {
  constructor(canvas, worldSize) {
    this.canvas = canvas;
    this.worldHalf = worldSize / 2;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      stencil: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0xd7d5ce, 1);
    this.scene = new THREE.Scene();
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, 4000);
    this.camera.position.set(0, 0, 2000);
    this.cx = 0;
    this.cy = 0;
    this.ppm = 1.2;
    this.w = 1;
    this.h = 1;
    this.dpr = 1;
    this.maxDpr = 2;
    this.onChange = null;

    const amb = new THREE.AmbientLight(0xffffff, 0.66);
    const sun = new THREE.DirectionalLight(0xffffff, 0.52);
    sun.position.set(-50, 55, 90);
    this.scene.add(amb, sun);
    this.lights = { amb, sun };
  }

  get minPpm() {
    return Math.min(this.w, this.h) / (this.worldHalf * 2 * 1.08);
  }
  get maxPpm() {
    return 18;
  }

  resize(w, h, dpr) {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.dpr = Math.min(dpr || 1, this.maxDpr);
    this.renderer.setPixelRatio(this.dpr);
    this.renderer.setSize(this.w, this.h, false);
    this.ppm = clamp(this.ppm, this.minPpm, this.maxPpm);
    this.updateCamera();
  }

  setQuality(maxDpr) {
    this.maxDpr = maxDpr;
    this.resize(this.w, this.h, window.devicePixelRatio || 1);
  }

  updateCamera() {
    const lim = this.worldHalf + 150;
    this.cx = clamp(this.cx, -lim, lim);
    this.cy = clamp(this.cy, -lim, lim);
    const c = this.camera;
    c.left = -this.w / (2 * this.ppm);
    c.right = this.w / (2 * this.ppm);
    c.top = this.h / (2 * this.ppm);
    c.bottom = -this.h / (2 * this.ppm);
    c.position.set(this.cx, this.cy, 2000);
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
    if (this.onChange) this.onChange(this);
  }

  /** Visible world rectangle. */
  bounds() {
    const hw = this.w / (2 * this.ppm);
    const hh = this.h / (2 * this.ppm);
    return { x0: this.cx - hw, x1: this.cx + hw, y0: this.cy - hh, y1: this.cy + hh };
  }

  screenToWorld(px, py, out = {}) {
    out.x = this.cx + (px - this.w / 2) / this.ppm;
    out.y = this.cy - (py - this.h / 2) / this.ppm;
    return out;
  }

  worldToScreen(x, y, out = {}) {
    out.x = this.w / 2 + (x - this.cx) * this.ppm;
    out.y = this.h / 2 - (y - this.cy) * this.ppm;
    return out;
  }

  panPixels(dx, dy) {
    this.cx -= dx / this.ppm;
    this.cy += dy / this.ppm;
    this.updateCamera();
  }

  setView(cx, cy, ppm) {
    this.cx = cx;
    this.cy = cy;
    this.ppm = clamp(ppm, this.minPpm, this.maxPpm);
    this.updateCamera();
  }

  /** Zoom keeping the world point under screen (px,py) fixed. */
  zoomAt(px, py, factor) {
    const before = this.screenToWorld(px, py);
    this.ppm = clamp(this.ppm * factor, this.minPpm, this.maxPpm);
    const after = this.screenToWorld(px, py);
    this.cx += before.x - after.x;
    this.cy += before.y - after.y;
    this.updateCamera();
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
