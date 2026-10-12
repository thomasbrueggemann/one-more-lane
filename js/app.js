// Application shell: owns the renderer stack, the current Game, tools, input and UI, and runs the frame loop.

import { Game } from './game.js';
import { View } from './render/view.js';
import { TerrainMesh } from './render/terrainmesh.js';
import { RoadRenderer } from './render/roads.js';
import { BuildingRenderer } from './render/buildingmesh.js';
import { VehicleRenderer } from './render/vehicles.js';
import { SignalRenderer, BadgeRenderer } from './render/markers.js';
import { FlowOverlay } from './render/flow.js';
import { Overlay } from './render/overlay.js';
import { THEMES } from './render/theme.js';
import { UI } from './ui.js';
import { Input } from './input.js';
import { HandTool, RoadTool, RoundaboutTool, LaneTool, SignalTool, BulldozeTool, BuildTool, ROAD_DEFAULT_LANES } from './tools.js';
import { Sfx } from './audio.js';
import * as store from './save.js';
import { DT } from './sim.js';
import { BUILDING_TYPES, BUILDING_ORDER } from './buildings.js';

const WORLD = 2400;
const PHASE_RGB = [[0.48, 0.64, 0.16], [0.18, 0.62, 0.42], [0.16, 0.63, 0.71], [0.85, 0.33, 0.24], [0.54, 0.36, 0.78], [0.85, 0.42, 0.6], [0.88, 0.6, 0.18]];

export class App {
  constructor() {
    this.canvas = document.getElementById('gl');
    this.settings = store.loadSettings();
    this.theme = THEMES.light;
    this.opts = { cls: 'street', lanes: { ...ROAD_DEFAULT_LANES }, oneWay: false, straight: false, elev: 0, ringSize: 'M', laneMode: 'add' };
    this.started = false;
    this.paused = false;
    this.game = null;
    this.flowOn = false;
    this.roadsDirty = true;
    this.buildingsVersion = -1;
    this.signalsDirty = true;
    this.focus = null;
    this.ghostSeed = 7;
    this.placedOnce = false;
    this.installEvent = null;
    this.lastTs = 0;
    this.time = 0;
    this.sfx = new Sfx();
    this.sfx.enabled = this.settings.sound;
    this.perfAcc = { ema: 16, slow: 0, fast: 0 };

    this.view = new View(this.canvas, WORLD);
    this.overlay = new Overlay(this.view.scene);
    this.roads = new RoadRenderer(this.view.scene, this.theme);
    this.buildings = new BuildingRenderer(this.view.scene, this.theme);
    this.flow = new FlowOverlay(this.view.scene);
    this.vehicles = new VehicleRenderer(this.view.scene, this.theme);
    this.signals = new SignalRenderer(this.view.scene);
    this.badges = new BadgeRenderer(this.view.scene);
    this.terrainMesh = null;

    this.tools = {
      hand: new HandTool(this),
      road: new RoadTool(this),
      roundabout: new RoundaboutTool(this),
      lane: new LaneTool(this),
      signal: new SignalTool(this),
      bulldoze: new BulldozeTool(this),
      build: new BuildTool(this),
    };
    this.tool = this.tools.hand;
    this.ui = new UI(this);
    this.input = new Input(this, this.canvas);

    this.view.onChange = (v) => {
      this.roads.setPxPerM(v.ppm);
      this.overlay.setPxPerM(v.ppm);
      this.flow.setPxPerM(v.ppm);
      this.signals.setPxPerM(v.ppm);
    };
    window.addEventListener('resize', () => this.resize());
    window.addEventListener('orientationchange', () => setTimeout(() => this.resize(), 250));
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this.autosave();
    });
    window.addEventListener('pagehide', () => this.autosave());
    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.installEvent = e;
      if (this.ui && !this.ui.el.menu.hidden && this.ui.menuView === 'main') this.ui.renderMenu();
    });
    window.addEventListener('appinstalled', () => {
      this.installEvent = null;
    });
    const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
    if (mq && mq.addEventListener) mq.addEventListener('change', () => this.settings.theme === 'auto' && this.applyTheme());

    this.applyQuality();
    this.applyTheme(false);
    this.resize();
    this.view.setView(0, 0, 2.1);
    this.startDemo();
    requestAnimationFrame((t) => this.frame(t));
  }

  /* ------------------------------------------------------------ lifecycle */

  startDemo() {
    const g = new Game({ seed: Math.floor(Math.random() * 99999), biome: ['meadow', 'desert', 'coast', 'highlands'][Math.floor(Math.random() * 4)] });
    g.setSpeed(2);
    this.attachGame(g);
    this.started = false;
    this.ui.showHud(false);
    this.ui.showMenu('main');
  }

  attachGame(game) {
    if (this.terrainMesh) {
      this.view.scene.remove(this.terrainMesh.mesh);
      this.terrainMesh.dispose();
    }
    this.game = game;
    this.currentSlot = null; // the manual slot this city was last saved to / loaded from (Ctrl+S target)
    this.terrainMesh = new TerrainMesh(this.view.scene, game.terrain, this.theme);
    game.on('rebuild', () => {
      this.roadsDirty = true;
    });
    game.on('toast', (t) => {
      if (t.kind === 'level') {
        const parts = BUILDING_ORDER.filter((k) => t.batch[k] > 0).map((k) => `${t.batch[k]} ${BUILDING_TYPES[k].name.toLowerCase()}${t.batch[k] > 1 ? 's' : ''}`);
        this.ui.toast(`Level ${t.level + 1}!  +${parts.join(', ')}`, 'level', 4200);
        this.beep('level');
      }
    });
    this.roadsDirty = true;
    this.buildingsVersion = -1;
    this.signalsDirty = true;
    this.overlay.clear();
    this.setTool('hand');
    this.ui.closeSignalEditor();
    this.ui.hideInfo();
    this.ui.updateSpeed();
    this.ui.updateHud(true);
    this.view.setView(0, 0, 2.1);
  }

  startNewGame(o) {
    const g = new Game({ seed: o.seed, biome: o.biome, difficulty: o.difficulty, mode: o.mode });
    this.attachGame(g);
    this.started = true;
    this.paused = false;
    this.ui.showHud(true);
    this.ui.hideMenu();
    this.ui.updateSpeed();
    this.autosave();
    this.ui.toast('Tap a building in the tray, then tap next to a street – or pick Road to start drawing.', 'info', 5200);
  }

  continueGame() {
    this.loadFrom(store.AUTOSAVE);
  }

  /** Replace the running game with a stored one (the autosave, or a manual slot number). */
  loadFrom(id) {
    const data = store.loadSlot(id);
    if (!data) {
      this.ui.toast('That save could not be loaded', 'error');
      return false;
    }
    try {
      const g = Game.fromSave(data);
      this.attachGame(g);
      if (data.view) this.view.setView(data.view.cx, data.view.cy, data.view.ppm);
      this.started = true;
      this.paused = false;
      this.currentSlot = id === store.AUTOSAVE ? null : id;
      this.ui.showHud(true);
      this.ui.hideMenu();
      this.ui.updateSpeed();
      this.placedOnce = true;
      if (id !== store.AUTOSAVE) this.ui.toast(`Loaded slot ${id}`, 'info');
      return true;
    } catch (err) {
      console.error('could not load save', err);
      this.ui.toast('That save could not be loaded', 'error');
      return false;
    }
  }

  /** Write the running game into a manual slot and tell the player how it went. */
  saveToSlot(i) {
    if (!this.started || !this.game) return false;
    const ok = store.writeSlot(i, this.game, this.view);
    if (ok) {
      this.currentSlot = i;
      this.ui.toast(`Game saved · slot ${i}`, 'info');
      if (!this.ui.el.menu.hidden) this.ui.renderMenu(); // the open save list shows the new slot
    } else this.ui.toast('Could not save – storage is full or unavailable', 'error', 4200);
    return ok;
  }

  /** Ctrl/Cmd+S: save into the slot this city was last saved to / loaded from, else the first free one. */
  quickSave() {
    if (!this.started || !this.game) return;
    let slot = this.currentSlot;
    if (!slot) {
      const free = store.listSlots().find((s) => s.id !== store.AUTOSAVE && s.state === 'empty');
      slot = free && free.id;
    }
    if (slot) this.saveToSlot(slot);
    else {
      this.ui.toast('All save slots are full – pick one to overwrite', 'info');
      this.ui.showMenu('save');
    }
  }

  hasSave() {
    return store.hasSave();
  }
  hasAnySave() {
    return store.hasAnySave();
  }
  listSlots() {
    return store.listSlots();
  }
  deleteSlot(id) {
    store.deleteSlot(id);
  }
  saveInfo() {
    return store.saveInfo();
  }
  clearSave() {
    store.clearSave();
  }
  autosave() {
    if (this.started && this.game) store.writeSave(this.game, this.view);
  }

  interactive() {
    return this.started && this.ui.el.menu.hidden;
  }

  setPaused(p) {
    this.paused = p && this.started;
  }
  togglePause() {
    if (!this.started) return;
    this.game.setSpeed(this.game.speed === 0 ? this.lastSpeed || 1 : 0);
    if (this.game.speed === 0) this.lastSpeed = this.lastSpeed || 1;
    this.ui.updateSpeed();
  }
  setSpeed(s) {
    if (s > 0) this.lastSpeed = s;
    this.game.setSpeed(s);
    this.ui.updateSpeed();
  }

  /* ------------------------------------------------------------ tools */

  setTool(id, type = null, flags = {}) {
    const tool = this.tools[id];
    if (!tool) return;
    if (this.tool) {
      this.tool.cancel();
      this.tool.deactivate();
    }
    if (id === 'build') tool.set(type || tool.type);
    this.tool = tool;
    tool.activate();
    if (!flags.keepSignal) this.ui.closeSignalEditor();
    this.ui.hideInfo();
    this.ui.updateToolState();
  }

  escape() {
    if (!this.ui.el.menu.hidden) return;
    if (this.tool.active) {
      this.tool.cancel();
      return;
    }
    if (this.ui.sig) {
      this.ui.closeSignalEditor();
      return;
    }
    if (this.tool.id !== 'hand') this.setTool('hand');
    else this.ui.showMenu('main');
  }

  undo() {
    if (!this.started) return;
    if (this.game.undo()) {
      this.tool.cancel();
      this.ui.closeSignalEditor();
      this.ui.hideInfo(); // it may show a building that no longer exists
      this.beep('remove');
      this.ui.toast('Undone', 'info', 1200);
    }
  }

  toggleFlow() {
    this.flowOn = !this.flowOn;
    this.flow.setVisible(this.flowOn);
    this.ui.el.flow.classList.toggle('on', this.flowOn);
    if (this.flowOn) this.flow.rebuild(this.game.net);
  }

  tip(chips, sx, sy, cls) {
    this.ui.tip(chips, sx, sy, cls);
  }
  hideTip() {
    this.ui.hideTip();
  }
  toast(text, kind) {
    this.ui.toast(text, kind);
  }
  hint(text) {
    this.ui.hint(text);
  }
  beep(kind) {
    this.sfx.play(kind);
  }
  audioUnlock() {
    this.sfx.unlock();
  }
  setSound(v) {
    this.settings.sound = v;
    this.sfx.enabled = v;
    store.saveSettings(this.settings);
  }

  focusOn(x, y, ppm) {
    this.focus = { x, y, ppm };
  }
  cancelFocus() {
    this.focus = null;
  }

  /* ------------------------------------------------------------ settings */

  setTheme(v) {
    this.settings.theme = v;
    store.saveSettings(this.settings);
    this.applyTheme();
  }

  applyTheme(rebuild = true) {
    let name = this.settings.theme;
    if (name === 'auto') name = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    this.theme = THEMES[name];
    document.documentElement.dataset.theme = name;
    const meta = document.querySelector('meta[name=theme-color]');
    if (meta) meta.setAttribute('content', this.theme.page);
    this.view.renderer.setClearColor(this.theme.outside);
    this.roads.setTheme(this.theme);
    this.buildings.setTheme(this.theme);
    this.vehicles.setTheme(this.theme);
    if (this.terrainMesh) this.terrainMesh.setTheme(this.theme);
    if (rebuild) {
      this.roadsDirty = true;
      this.buildingsVersion = -1;
    }
  }

  setQuality(v) {
    this.settings.quality = v;
    store.saveSettings(this.settings);
    this.applyQuality();
  }

  applyQuality() {
    const q = this.settings.quality;
    const native = window.devicePixelRatio || 1;
    this.maxDpr = q === 'low' ? 1 : q === 'high' ? Math.min(2.5, native) : Math.min(2, native);
    this.view.maxDpr = this.maxDpr;
    if (this.view.w > 1) this.resize();
  }

  resize() {
    this.view.resize(window.innerWidth, window.innerHeight, window.devicePixelRatio || 1);
    this.roads.setPxPerM(this.view.ppm);
    this.overlay.setPxPerM(this.view.ppm);
    this.flow.setPxPerM(this.view.ppm);
    this.signals.setPxPerM(this.view.ppm);
  }

  /* ------------------------------------------------------------ install */

  canInstall() {
    return !!this.installEvent && !this.isStandalone();
  }
  isStandalone() {
    return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
  }
  iosHint() {
    const ua = navigator.userAgent || '';
    const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    return ios && !this.isStandalone();
  }
  async install() {
    const e = this.installEvent;
    if (!e) return;
    e.prompt();
    try {
      await e.userChoice;
    } catch (err) {
      /* dismissed */
    }
    this.installEvent = null;
    this.ui.renderMenu();
  }

  /* ------------------------------------------------------------ frame */

  frame(ts) {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min(0.1, this.lastTs ? (ts - this.lastTs) / 1000 : 0.016);
    this.lastTs = ts;
    this.time += dt;
    this.input.update(dt);
    this.updateFocus(dt);
    const game = this.game;
    if (!game) return;
    let alpha = 0;
    if (!this.paused) alpha = game.update(dt);
    if (!this.started) this.demoCamera(dt);
    this.updateRender(alpha, dt);
    this.view.render();
    this.adaptQuality(dt);
  }

  updateFocus(dt) {
    const f = this.focus;
    if (!f) return;
    const v = this.view;
    const k = Math.min(1, dt * 7);
    v.cx += (f.x - v.cx) * k;
    v.cy += (f.y - v.cy) * k;
    v.ppm *= Math.pow(f.ppm / v.ppm, k);
    v.updateCamera();
    if (Math.abs(f.x - v.cx) < 0.3 && Math.abs(f.y - v.cy) < 0.3 && Math.abs(Math.log(f.ppm / v.ppm)) < 0.01) this.focus = null;
  }

  demoCamera(dt) {
    const v = this.view;
    const t = this.time;
    v.cx = Math.sin(t * 0.045) * 70;
    v.cy = Math.cos(t * 0.037) * 40;
    v.updateCamera();
    void dt;
  }

  updateRender(alpha, dt) {
    const game = this.game;
    const net = game.net;
    if (this.roadsDirty) {
      this.roadsDirty = false;
      this.roads.rebuild(net);
      this.signals.rebuild(net);
      if (this.flowOn) this.flow.rebuild(net);
      if (this.ui.sig) this.ui.renderSignal();
    }
    if (this.buildingsVersion !== game.city.version) {
      this.buildingsVersion = game.city.version;
      this.buildings.rebuild(game.city.list);
    }
    // vehicles
    const sim = game.sim;
    const vr = this.vehicles;
    vr.begin();
    const o = {};
    const a = this.paused || game.speed === 0 ? 0 : alpha;
    for (const v of sim.vehicles) {
      if (v.dead) continue;
      sim.pose(v, a, o);
      vr.add(o.level, v.kind, o.x, o.y, o.tx, o.ty, v.color, v.fade);
    }
    for (const g of sim.ghosts) {
      const t = g.t / 0.5;
      const off = g.lat + g.slide * t;
      vr.add(g.level, g.kind, g.x + g.ty * off, g.y - g.tx * off, g.tx, g.ty, g.color, 1 - t);
    }
    vr.end();
    this.signals.update();
    // badges (cheap, twice a second)
    this.badgeTimer = (this.badgeTimer || 0) - dt;
    if (this.badgeTimer <= 0) {
      this.badgeTimer = 0.4;
      const list = [];
      for (const b of game.city.list) if (b.badge) list.push({ x: b.x, y: b.y, icon: b.badge === 'noroad' ? 0 : 1 });
      this.badgeList = list;
    }
    this.badges.update(this.badgeList || [], this.view.ppm);
    // traffic view colours
    if (this.flowOn) {
      this.flowTimer = (this.flowTimer || 0) - dt;
      if (this.flowTimer <= 0) {
        this.flowTimer = 0.5;
        this.flow.update();
      }
    }
    if (this.ui.sig) this.drawSignalEditor();
    this.ui.updateHud();
    this.autosaveTimer = (this.autosaveTimer || 0) + dt;
    if (this.autosaveTimer > 20) {
      this.autosaveTimer = 0;
      this.autosave();
    }
  }

  drawSignalEditor() {
    const s = this.ui.sig;
    const node = s.node;
    const sig = node.signal;
    if (!sig || !node.alive) {
      this.ui.closeSignalEditor();
      return;
    }
    const o = this.overlay;
    o.reset();
    const phase = sig.phases[Math.min(s.idx, sig.phases.length - 1)];
    const col = PHASE_RGB[s.idx % PHASE_RGB.length];
    o.ring(node.x, node.y, 11, 0.7, [col[0], col[1], col[2], 0.55]);
    for (const c of node.conns) {
      if (phase.moves.has(c.moveKey)) continue;
      o.strip(c.poly, -0.35, 0.35, [0.5, 0.5, 0.56, 0.3]);
    }
    for (const c of node.conns) {
      if (!phase.moves.has(c.moveKey)) continue;
      o.strip(c.poly, -0.55, 0.55, [col[0], col[1], col[2], 0.9]);
      // arrow head
      const e = c.poly.pointAt(c.len);
      const nx = e.ty;
      const ny = -e.tx;
      const P = (x, y) => ({ x, y, ex: 0, ey: 0 });
      o.bFill.tri(P(e.x + e.tx * 1.6, e.y + e.ty * 1.6), P(e.x - e.tx * 0.9 + nx * 1.5, e.y - e.ty * 0.9 + ny * 1.5), P(e.x - e.tx * 0.9 - nx * 1.5, e.y - e.ty * 0.9 - ny * 1.5), [col[0], col[1], col[2], 0.95]);
    }
    // coloured dot per approach: the first phase that serves it
    const seen = new Set();
    for (const c of node.conns) {
      const dir = c.from.dir;
      if (seen.has(dir)) continue;
      seen.add(dir);
      let idx = sig.phases.findIndex((p) => [...p.moves].some((m) => m.startsWith(dir.id + '>')));
      if (idx < 0) idx = 0;
      const pc = PHASE_RGB[idx % PHASE_RGB.length];
      const lane = dir.lanes[dir.lanes.length - 1];
      const p = lane.poly.pointAt(lane.len);
      o.disc(p.x + p.ty * 2.1, p.y - p.tx * 2.1, 1.25, [pc[0], pc[1], pc[2], 1]);
    }
    o.commit();
  }

  adaptQuality(dt) {
    if (this.settings.quality !== 'auto') return;
    const p = this.perfAcc;
    p.ema += (dt * 1000 - p.ema) * 0.05;
    const native = window.devicePixelRatio || 1;
    if (p.ema > 30 && this.view.maxDpr > 1) {
      p.slow += dt;
      if (p.slow > 3) {
        p.slow = 0;
        this.view.maxDpr = Math.max(1, this.view.maxDpr - 0.5);
        this.resize();
      }
    } else p.slow = 0;
    if (p.ema < 15 && this.view.maxDpr < Math.min(this.maxDpr, native)) {
      p.fast += dt;
      if (p.fast > 8) {
        p.fast = 0;
        this.view.maxDpr = Math.min(this.maxDpr, this.view.maxDpr + 0.5);
        this.resize();
      }
    } else p.fast = 0;
  }
}
