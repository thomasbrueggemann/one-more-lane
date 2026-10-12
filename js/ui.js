// DOM user interface: HUD, toolbar, option panels, building tray, signal editor, info panel, toasts, menu screens.

import { ICONS, BUILDING_ICONS } from './icons.js';
import { BUILDING_TYPES, BUILDING_ORDER } from './buildings.js';
import { fmtMoney } from './util.js';
import { xpNeeded, DIFFICULTY } from './city.js';
import { BIOMES } from './terrain.js';
import { CLASSES } from './network.js';
import { MAX_LANES } from './roadplan.js';
import { ROAD_DEFAULT_LANES } from './tools.js';
import { GAME_NAME } from './config.js';
import { toggleMovement } from './signaledit.js';

const $ = (id) => document.getElementById(id);

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(k));
  return e;
}

const TOOLS = [
  { id: 'hand', label: 'Move', icon: 'hand', key: '1' },
  { id: 'road', label: 'Road', icon: 'road', key: '2' },
  { id: 'roundabout', label: 'Round', icon: 'roundabout', key: '3' },
  { id: 'lane', label: 'Lanes', icon: 'lane', key: '4' },
  { id: 'signal', label: 'Lights', icon: 'signal', key: '5' },
  { id: 'bulldoze', label: 'Remove', icon: 'bin', key: '6' },
];
export const TOOL_KEYS = Object.fromEntries(TOOLS.map((t) => [t.key, t.id]));

const PHASE_COLORS = ['#7aa22a', '#2e9e6a', '#2aa0b5', '#d9533e', '#8a5cc7', '#d96a9a', '#e09a2e'];

const HOW_TO = [
  ['Draw roads', 'Pick <b>Road</b> and drag on the map (or tap two points). Roads bend smoothly when you continue from a road end. Guides snap to parallel and perpendicular.'],
  ['Place buildings', 'Your city grows in batches. Tap a building in the <b>tray</b> then tap next to a street. Drag along a road to place a whole row.'],
  ['Watch the traffic', 'Residents drive to work, shops and back. Slow, jammed trips make them unhappy (look for the red badges).'],
  ['Fix jams', 'Use <b>Round</b> for roundabouts, <b>Lights</b> for traffic signals (tap again to edit phases), <b>Lanes</b> to widen roads, and raise roads to cross over others.'],
  ['Tear down', 'Press <b>X</b> for <b>Remove</b>. <i>Click</i> takes one road or building, <i>Street</i> a whole street, <i>Area</i> everything in a box you drag. Undo restores it in one step.'],
  ['Level up', 'Smooth trips earn progress. Every level brings more buildings and a bonus. There is no game over, so one more lane is always an option.'],
];

export class UI {
  constructor(app) {
    this.app = app;
    this.lastHud = 0;
    this.sig = null;
    this.toastTimers = [];
    this.menuView = 'main';
    this.newOpts = { biome: 'meadow', mode: 'challenge', difficulty: 'normal', seed: Math.floor(Math.random() * 99999) };
    this.build();
  }

  build() {
    const app = this.app;
    this.el = {
      hud: $('hud'),
      money: $('money-val'),
      income: $('income-val'),
      level: $('level-val'),
      pop: $('pop-val'),
      xp: $('xp-bar'),
      undo: $('btn-undo'),
      speed: $('speed'),
      flow: $('btn-flow'),
      menuBtn: $('btn-menu'),
      tray: $('tray'),
      options: $('options'),
      toolbar: $('toolbar'),
      sigPanel: $('signal-panel'),
      info: $('info-panel'),
      tip: $('tip'),
      hint: $('hint'),
      toasts: $('toasts'),
      menu: $('menu'),
      card: $('menu-card'),
    };
    const e = this.el;
    e.undo.innerHTML = ICONS.undo;
    e.undo.addEventListener('click', () => app.undo());
    e.flow.innerHTML = ICONS.flow;
    e.flow.addEventListener('click', () => app.toggleFlow());
    e.menuBtn.innerHTML = ICONS.menu;
    e.menuBtn.addEventListener('click', () => this.showMenu('main'));

    // speed
    const sp = [
      { s: 0, html: ICONS.pause, label: 'Pause' },
      { s: 1, html: '1×', label: 'Normal speed' },
      { s: 2, html: '2×', label: 'Fast' },
      { s: 4, html: '4×', label: 'Very fast' },
    ];
    this.speedBtns = sp.map((o) => {
      const b = h('button', { 'aria-label': o.label, html: o.html, onclick: () => app.setSpeed(o.s) });
      e.speed.append(b);
      return { b, s: o.s };
    });

    // toolbar
    this.toolBtns = {};
    for (const t of TOOLS) {
      const b = h('button', { class: 'tool-btn', 'data-tool': t.id, title: `${t.label} (${t.key})`, html: ICONS[t.icon] }, h('span', {}, t.label));
      b.addEventListener('click', () => app.setTool(t.id));
      e.toolbar.append(b);
      this.toolBtns[t.id] = b;
    }

    // tray
    e.tray.append(h('div', { class: 'tray-head' }, 'Build'));
    this.trayBtns = {};
    for (const type of BUILDING_ORDER) {
      const b = h('button', { class: 'tray-btn', title: BUILDING_TYPES[type].name, html: BUILDING_ICONS[type] }, h('span', { class: 'count' }, '0'));
      b.addEventListener('click', () => {
        if (app.game.city.available(type) <= 0) {
          this.toast('Level up to receive more buildings', 'info');
          return;
        }
        app.setTool('build', type);
      });
      e.tray.append(b);
      this.trayBtns[type] = b;
    }
    this.updateSpeed();
    this.updateToolState();
  }

  /* ------------------------------------------------------------ HUD */

  showHud(on) {
    this.el.hud.hidden = !on;
  }

  updateHud(force = false) {
    const now = performance.now();
    if (!force && now - this.lastHud < 180) return;
    this.lastHud = now;
    const g = this.app.game;
    if (!g) return;
    const c = g.city;
    this.el.money.textContent = c.free ? '\u221e' : fmtMoney(c.money);
    this.el.income.textContent = c.free ? 'Free play' : `+${fmtMoney(c.stats.income * 60)}/min`;
    this.el.level.textContent = `Level ${c.level + 1}`;
    this.el.pop.textContent = `${c.stats.pop} residents`;
    this.el.xp.style.width = `${Math.min(100, (c.xp / xpNeeded(c.level)) * 100).toFixed(1)}%`;
    this.el.undo.disabled = !g.canUndo();
    this.updateTray();
  }

  updateSpeed() {
    const s = this.app.game ? this.app.game.speed : 1;
    for (const { b, s: v } of this.speedBtns) b.classList.toggle('on', v === s);
  }

  updateTray() {
    const g = this.app.game;
    if (!g) return;
    const tool = this.app.tool;
    for (const type of BUILDING_ORDER) {
      const n = g.city.available(type);
      const b = this.trayBtns[type];
      const c = b.querySelector('.count');
      if (c.textContent !== String(n)) c.textContent = n;
      b.classList.toggle('empty', n === 0);
      b.classList.toggle('on', tool && tool.id === 'build' && tool.type === type);
    }
    const pulse = BUILDING_ORDER.some((t) => g.city.available(t) > 0) && this.app.tool && this.app.tool.id !== 'build' && g.city.list.length < 40;
    for (const type of BUILDING_ORDER) this.trayBtns[type].classList.toggle('pulse', pulse && g.city.available(type) > 0 && !this.app.placedOnce);
  }

  updateToolState() {
    const tool = this.app.tool;
    if (!tool) return;
    for (const [id, b] of Object.entries(this.toolBtns)) b.classList.toggle('on', tool.id === id);
    this.renderOptions();
    this.updateTray();
  }

  /* ------------------------------------------------------------ options panel */

  renderOptions() {
    const app = this.app;
    const tool = app.tool;
    const el = this.el.options;
    el.replaceChildren();
    const o = app.opts;
    const pill = (label, on, fn, extra = {}) => h('button', { class: 'pill' + (on ? ' on' : '') + (extra.cls ? ' ' + extra.cls : ''), onclick: fn, html: extra.icon ? ICONS[extra.icon] : false }, label);
    const group = (name, ...kids) => h('div', { class: 'opt-group' }, name ? h('span', { class: 'opt-label' }, name) : null, ...kids);
    let show = true;
    if (!tool || tool.id === 'hand') show = false;
    else if (tool.id === 'road') {
      const refresh = () => {
        this.renderOptions();
        tool.refresh();
      };
      el.append(
        group('Type', ...Object.values(CLASSES).map((c) => pill(h('span', {}, c.name, this.app.game.free ? null : h('small', {}, ` $${(c.laneCost * 2).toFixed(0)}/m`)), o.cls === c.id, () => {
          o.cls = c.id;
          o.lanes[c.id] = Math.min(o.lanes[c.id] || ROAD_DEFAULT_LANES[c.id], MAX_LANES[c.id]);
          refresh();
        }))),
        group('Lanes', ...Array.from({ length: MAX_LANES[o.cls] }, (_, i) => pill(String(i + 1), o.lanes[o.cls] === i + 1, () => {
          o.lanes[o.cls] = i + 1;
          refresh();
        }))),
        group('', pill('One-way', o.oneWay, () => {
          o.oneWay = !o.oneWay;
          refresh();
        }, { icon: 'oneway' }), pill('Straight', o.straight, () => {
          o.straight = !o.straight;
          refresh();
        }, { icon: 'straight' })),
        group('Height', ...[['Ground', 0], ['Raised 1', 1], ['Raised 2', 2]].map(([n, v]) => pill(n, o.elev === v, () => {
          o.elev = v;
          refresh();
        }))),
      );
      if (tool.active) el.append(group('', pill('Done', false, () => tool.finish(), { cls: 'primary', icon: 'check' })));
      else if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) el.append(h('span', { class: 'hint-text' }, 'Drag to draw \u00b7 two fingers to pan and zoom'));
    } else if (tool.id === 'roundabout') {
      el.append(
        group('Size', ...[['Small', 'S'], ['Medium', 'M'], ['Large', 'L']].map(([n, v]) => pill(n, o.ringSize === v, () => {
          o.ringSize = v;
          this.renderOptions();
          tool.refresh();
        }))),
        h('span', { class: 'hint-text' }, 'Tap a junction or open ground. Drag to resize.'),
      );
    } else if (tool.id === 'lane') {
      el.append(
        group('', pill('Add lane', o.laneMode !== 'remove', () => {
          o.laneMode = 'add';
          this.renderOptions();
          tool.refresh();
        }, { icon: 'plus' }), pill('Remove lane', o.laneMode === 'remove', () => {
          o.laneMode = 'remove';
          this.renderOptions();
          tool.refresh();
        }, { icon: 'minus' })),
        h('span', { class: 'hint-text' }, 'Point at the side of a road'),
      );
    } else if (tool.id === 'signal') {
      el.append(h('span', { class: 'hint-text' }, `Tap a junction to install lights${this.app.game.free ? '' : ` (${fmtMoney(1500)})`}. Tap lights again to configure.`));
    } else if (tool.id === 'bulldoze') {
      const hints = {
        click: 'Tap or drag over single roads and buildings. Hold Shift for a whole street.',
        street: 'Tap a road to remove its whole street, straight through junctions.',
        area: 'Drag a box: roads mostly inside go. One Undo brings everything back.',
      };
      el.append(
        group('', ...[['click', 'Click'], ['street', 'Street'], ['area', 'Area']].map(([m, n]) => pill(n, tool.mode === m, () => tool.setMode(m)))),
        ...(tool.mode === 'area' ? [group('', pill('Buildings too', tool.withBuildings, () => tool.setWithBuildings(!tool.withBuildings)))] : []),
        h('span', { class: 'hint-text' }, `${hints[tool.mode]}${app.game.free ? '' : ' Half the cost is refunded.'} Key: X.`),
      );
    } else if (tool.id === 'build') {
      const spec = BUILDING_TYPES[tool.type];
      el.append(
        h('span', { class: 'hint-text' }, `${spec.name}: tap next to a street. Drag along a road to place a row.`),
        group('', pill('Done', false, () => app.setTool('hand'), { cls: 'primary', icon: 'check' })),
      );
    }
    el.hidden = !show;
  }

  /* ------------------------------------------------------------ tip / toasts / hint */

  tip(chips, sx, sy, cls = '') {
    const t = this.el.tip;
    if (!chips || !chips.length) {
      t.hidden = true;
      return;
    }
    t.replaceChildren(...chips.map((c) => h('span', { class: c.kind || '' }, c.t)));
    t.hidden = false;
    t.className = 'tip ' + cls;
    const w = t.offsetWidth;
    const hgt = t.offsetHeight;
    let x;
    let y;
    if (this.app.pointerType && this.app.pointerType !== 'mouse') {
      // under a fingertip the label would be hidden by the hand: float it above instead
      x = sx - w / 2;
      y = sy - hgt - 74;
    } else {
      x = sx + 18;
      y = sy + 20;
      if (x + w > innerWidth - 8) x = sx - w - 14;
      if (y + hgt > innerHeight - 8) y = sy - hgt - 14;
    }
    x = Math.min(Math.max(6, x), innerWidth - w - 6);
    y = Math.min(Math.max(6, y), innerHeight - hgt - 6);
    t.style.transform = `translate(${x}px, ${y}px)`;
  }

  hideTip() {
    this.el.tip.hidden = true;
  }

  toast(text, kind = 'info', ms = 2600) {
    const t = h('div', { class: 'toast ' + kind }, text);
    this.el.toasts.append(t);
    while (this.el.toasts.children.length > 3) this.el.toasts.firstChild.remove();
    setTimeout(() => {
      t.classList.add('out');
      setTimeout(() => t.remove(), 320);
    }, ms);
  }

  hint(text, ms = 2600) {
    const el = this.el.hint;
    el.textContent = text;
    el.hidden = false;
    clearTimeout(this._hintT);
    this._hintT = setTimeout(() => (el.hidden = true), ms);
  }

  /* ------------------------------------------------------------ building info */

  showBuildingInfo(b) {
    const el = this.el.info;
    const spec = BUILDING_TYPES[b.type];
    const kids = [
      h('h3', {}, spec.name),
      b.type === 'house' ? h('div', { class: 'stat' }, 'Residents', h('b', {}, String(b.pop))) : h('div', { class: 'stat' }, 'Jobs', h('b', {}, String(b.jobs))),
      b.type === 'house' ? h('div', { class: 'stat' }, 'Happiness', h('b', {}, `${Math.round(b.sat * 100)}%`)) : null,
      b.badge === 'noroad' ? h('p', {}, 'This building is not connected to a working road.') : null,
      b.badge === 'angry' ? h('p', {}, 'Residents are stuck in traffic. Add lanes, roundabouts or lights nearby.') : null,
      h('div', { class: 'row' }, h('button', { class: 'pill', onclick: () => this.hideInfo() }, 'Close'), h('button', { class: 'pill danger', onclick: () => {
        this.app.game.removeBuilding(b);
        this.hideInfo();
        this.updateTray();
      } }, 'Pick up')),
    ];
    // replaceChildren() would turn null entries into the text "null"
    el.replaceChildren(...kids.filter(Boolean));
    el.hidden = false;
  }

  hideInfo() {
    this.el.info.hidden = true;
  }

  /* ------------------------------------------------------------ signal editor */

  openSignalEditor(node) {
    this.hideInfo();
    this.sig = { node, idx: node.signal ? node.signal.idx : 0 };
    this.app.setTool('hand', null, { keepSignal: true });
    this.renderSignal();
    this.el.sigPanel.hidden = false;
    this.app.focusOn(node.x, node.y, 6);
  }

  /** Tap on an arrow while the editor is open: give that movement green in the selected phase. */
  editMovement(moveKey) {
    const s = this.sig;
    if (!s || !s.node.signal) return;
    const r = toggleMovement(s.node.signal, moveKey, s.idx);
    if (!r.ok) {
      this.toast(r.reason === 'needs_green' ? 'Every movement needs a green in some phase' : 'Cannot change that', 'error', 2200);
      this.app.beep('error');
      return;
    }
    s.idx = r.idx;
    this.app.beep('place');
    this.renderSignal();
  }

  closeSignalEditor() {
    this.sig = null;
    this.el.sigPanel.hidden = true;
    this.app.overlay.clear();
  }

  renderSignal() {
    const s = this.sig;
    if (!s) return;
    const sig = s.node.signal;
    const el = this.el.sigPanel;
    if (!sig) {
      this.closeSignalEditor();
      return;
    }
    const rows = sig.phases.map((p, i) => {
      const color = PHASE_COLORS[i % PHASE_COLORS.length];
      const row = h('div', { class: 'phase' + (i === s.idx ? ' on' : ''), onclick: () => {
        s.idx = i;
        this.renderSignal();
      } },
      h('span', { class: 'dot', style: `background:${color}` }),
      h('span', { class: 'name' }, `Phase ${i + 1}`),
      h('button', { class: 'step', 'aria-label': 'Shorter', onclick: (ev) => {
        ev.stopPropagation();
        p.dur = Math.max(5, p.dur - 2);
        this.renderSignal();
      } }, '−'),
      h('span', { class: 'dur' }, `${p.dur}s`),
      h('button', { class: 'step', 'aria-label': 'Longer', onclick: (ev) => {
        ev.stopPropagation();
        p.dur = Math.min(60, p.dur + 2);
        this.renderSignal();
      } }, '+'));
      return row;
    });
    el.replaceChildren(
      h('h3', {}, 'Traffic lights'),
      h('p', {}, 'Each phase gives green to its highlighted arrows. Tap an arrow on the map to move it into the selected phase; use the +/\u2212 buttons to change how long a phase lasts at most (lights switch early when nobody is waiting).'),
      ...rows,
      h('div', { class: 'row' },
        h('button', { class: 'pill' + (sig.protectedLefts ? ' on' : ''), onclick: () => {
          sig.setProtectedLefts(!sig.protectedLefts);
          s.idx = 0;
          this.renderSignal();
        } }, 'Protected left turns')),
      h('div', { class: 'row' },
        h('button', { class: 'pill danger', onclick: () => {
          this.app.game.pushUndo();
          this.app.game.planner.toggleSignal(s.node);
          this.app.game.city.money += 750;
          this.closeSignalEditor();
          this.app.signalsDirty = true;
        } }, 'Remove lights'),
        h('button', { class: 'pill primary', onclick: () => this.closeSignalEditor() }, 'Done')),
    );
  }

  /* ------------------------------------------------------------ menu */

  showMenu(view = 'main') {
    this.menuView = view;
    this.shownView = null;
    this.confirmNew = false;
    this.slotConfirm = null;
    this.app.autosave(); // whatever the menu does next, the city as it is right now is on disk
    this.app.setPaused(true);
    this.renderMenu();
    this.el.menu.hidden = false;
  }

  openMenuView(view) {
    this.menuView = view;
    this.slotConfirm = null;
    this.renderMenu();
  }

  /** The save / load slot lists. Destructive buttons need a second tap (this.slotConfirm = which one is armed). */
  renderSlots(card, view, back) {
    const app = this.app;
    const saving = view === 'save';
    const running = app.game && app.started;
    const armed = (id, action) => this.slotConfirm && this.slotConfirm.id === id && this.slotConfirm.action === action;
    // the first tap arms the button (it turns red and asks again), the second does it
    const act = (id, action, label, sure, cls, fn) => h('button', { class: 'pill ' + (armed(id, action) ? 'sure' : cls), onclick: () => {
      if (!armed(id, action)) {
        this.slotConfirm = { id, action };
        this.renderMenu();
        return;
      }
      this.slotConfirm = null;
      fn();
    } }, armed(id, action) ? sure : label);
    const rows = app.listSlots().filter((s) => !saving || s.id !== 'auto').map((s) => {
      const m = s.meta || {};
      const detail = [];
      if (Number.isFinite(m.roads)) detail.push(`${m.roads} road${m.roads === 1 ? '' : 's'}`);
      if (Number.isFinite(m.buildings)) detail.push(`${m.buildings} building${m.buildings === 1 ? '' : 's'}`);
      if (DIFFICULTY[m.difficulty]) detail.push(DIFFICULTY[m.difficulty].name);
      const text = s.state === 'ok' ? s.info : s.state === 'corrupt' ? 'Damaged save – cannot be loaded' : 'Empty';
      const btns = [];
      if (saving) {
        const write = () => app.saveToSlot(s.id); // re-renders this list when it worked
        btns.push(s.state === 'empty' ? h('button', { class: 'pill primary', onclick: write }, 'Save') : act(s.id, 'overwrite', 'Overwrite', 'Tap again to overwrite', '', write));
      } else {
        if (s.state === 'ok') {
          const load = () => app.loadFrom(s.id);
          btns.push(running ? act(s.id, 'load', 'Load', 'Replace current city?', 'primary', load) : h('button', { class: 'pill primary', onclick: load }, 'Load'));
        }
        if (s.state !== 'empty') btns.push(act(s.id, 'delete', 'Delete', 'Tap again to delete', 'danger', () => {
          app.deleteSlot(s.id);
          this.renderMenu();
        }));
      }
      return h('div', { class: 'slot' + (s.state === 'empty' ? ' empty' : '') },
        h('div', { class: 'meta' }, h('b', {}, s.label), h('small', {}, text), detail.length && s.state === 'ok' ? h('small', {}, detail.join(' · ')) : null),
        h('div', { class: 'acts' }, ...btns));
    });
    card.append(back(), h('h2', { class: 'wordmark', style: 'font-size:30px' }, saving ? 'Save game' : 'Load game'), h('div', { class: 'road-line' }),
      h('p', { class: 'tagline', style: 'font-size:13px;margin:0 0 6px' }, saving
        ? 'Pick a slot. Your city is also autosaved as you play, but a slot only ever changes when you save to it. Ctrl+S saves to the same slot again.'
        : running ? 'Loading replaces the city you are playing. The autosave follows whatever you play, so save to a slot first if you want to keep this one.' : 'Pick a saved city. The autosave is your city as you last left it.'),
      ...rows);
  }

  hideMenu() {
    this.el.menu.hidden = true;
    this.app.setPaused(false);
  }

  renderMenu() {
    const app = this.app;
    const card = this.el.card;
    card.replaceChildren();
    if (this.shownView !== this.menuView) {
      // the card slides in when a view opens, not every time one of its options is toggled
      card.style.animation = 'none';
      void card.offsetWidth;
      card.style.animation = '';
    }
    this.shownView = this.menuView;
    const view = this.menuView;
    const back = () => h('button', { class: 'back', onclick: () => {
      this.menuView = 'main';
      this.confirmNew = false;
      this.slotConfirm = null;
      this.renderMenu();
    }, html: ICONS.back }, 'Back');
    const title = () => [h('h1', { class: 'wordmark', html: GAME_NAME.html }), h('div', { class: 'road-line' })];

    if (view === 'main') {
      const btns = [];
      const running = app.game && app.started;
      if (running) btns.push(h('button', { class: 'big-btn primary', onclick: () => this.hideMenu() }, 'Resume'));
      else if (app.hasSave()) btns.push(h('button', { class: 'big-btn primary', onclick: () => app.continueGame() }, 'Continue', h('small', {}, `Autosave · ${app.saveInfo()}`)));
      if (running) btns.push(h('button', { class: 'big-btn', onclick: () => this.openMenuView('save') }, 'Save game'));
      if (app.hasAnySave()) btns.push(h('button', { class: 'big-btn', onclick: () => this.openMenuView('load') }, 'Load game'));
      btns.push(h('button', { class: 'big-btn' + (!running && !app.hasSave() ? ' primary' : ''), onclick: () => {
        this.menuView = 'new';
        this.confirmNew = false;
        this.renderMenu();
      } }, 'New city'));
      btns.push(h('button', { class: 'big-btn', html: ICONS.help, onclick: () => {
        this.menuView = 'help';
        this.renderMenu();
      } }, 'How to play'));
      btns.push(h('button', { class: 'big-btn', html: ICONS.settings, onclick: () => {
        this.menuView = 'settings';
        this.renderMenu();
      } }, 'Settings'));
      if (app.canInstall()) btns.push(h('button', { class: 'big-btn', html: ICONS.download, onclick: () => app.install() }, 'Install app'));
      card.append(...title(), h('p', { class: 'tagline' }, 'Draw gridless roads, tame the traffic with roundabouts, signals and interchanges – and keep your city moving.'), h('div', { class: 'menu-btns' }, ...btns));
      if (app.iosHint()) card.append(h('p', { class: 'tagline', style: 'margin-top:16px;font-size:13px' }, 'Tip: to install on iPad or iPhone, tap Share and then “Add to Home Screen”.'));
    } else if (view === 'new') {
      const o = this.newOpts;
      const replaces = app.hasSave();
      const biomeCards = Object.entries(BIOMES).map(([id, b]) => {
        const sw = h('div', { class: 'swatch', style: `background:${b.base}` },
          h('i', { style: `background:${b.water};width:44%;height:70%;left:-8%;top:-12%` }),
          h('i', { style: `background:${b.grass};width:46%;height:58%;right:-6%;bottom:-14%` }),
          h('i', { style: `background:${b.sand};width:24%;height:40%;left:40%;top:6%` }),
          h('i', { style: `background:${b.rock[0]};width:22%;height:44%;right:10%;top:-6%` }));
        return h('button', { class: 'card' + (o.biome === id ? ' on' : ''), onclick: () => {
          o.biome = id;
          this.renderMenu();
        } }, sw, h('b', {}, b.name), h('small', {}, b.blurb));
      });
      const diffCards = Object.entries(DIFFICULTY).map(([id, d]) => h('button', { class: 'card' + (o.difficulty === id ? ' on' : ''), onclick: () => {
        o.difficulty = id;
        this.renderMenu();
      } }, h('b', {}, d.name), h('small', {}, o.mode === 'free' ? `Traffic \u00d7${d.demand}` : `${fmtMoney(d.money)} to start`)));
      const modeCards = [['challenge', 'Challenge', 'Earn money to build'], ['free', 'Free play', 'Unlimited money']].map(([id, name, blurb]) => h('button', { class: 'card' + (o.mode === id ? ' on' : ''), onclick: () => {
        o.mode = id;
        this.renderMenu();
      } }, h('b', {}, name), h('small', {}, blurb)));
      const input = h('input', { type: 'text', inputmode: 'numeric', value: String(o.seed), 'aria-label': 'Map seed' });
      input.addEventListener('input', () => {
        const n = parseInt(input.value.replace(/\D/g, ''), 10);
        if (!Number.isNaN(n)) o.seed = n % 1000000;
      });
      card.append(back(), h('h2', { class: 'wordmark', style: 'font-size:30px' }, 'New city'), h('div', { class: 'road-line' }),
        h('div', { class: 'field' }, h('h4', {}, 'Map'), h('div', { class: 'cards' }, ...biomeCards)),
        h('div', { class: 'field' }, h('h4', {}, 'Mode'), h('div', { class: 'cards' }, ...modeCards)),
        h('div', { class: 'field' }, h('h4', {}, 'Difficulty'), h('div', { class: 'cards' }, ...diffCards)),
        h('div', { class: 'field' }, h('h4', {}, 'Seed'), h('div', { class: 'seed-row' }, input, h('button', { class: 'icon-btn', 'aria-label': 'Random seed', html: ICONS.dice, onclick: () => {
          o.seed = Math.floor(Math.random() * 999999);
          input.value = String(o.seed);
        } }))),
        replaces ? h('p', { class: 'tagline', style: 'font-size:13px;margin:0 0 10px' }, `A new city replaces your autosave (${app.saveInfo()}). Cities saved to a slot stay put.`) : '',
        h('button', { class: 'big-btn ' + (replaces && this.confirmNew ? 'danger' : 'primary'), style: 'width:100%', onclick: () => {
          if (replaces && !this.confirmNew) {
            this.confirmNew = true;
            this.renderMenu();
            return;
          }
          this.confirmNew = false;
          app.startNewGame({ ...o });
        } }, replaces && this.confirmNew ? 'Tap again to replace it' : 'Start'));
    } else if (view === 'save' || view === 'load') {
      this.renderSlots(card, view, back);
    } else if (view === 'help') {
      card.append(back(), h('h2', { class: 'wordmark', style: 'font-size:30px' }, 'How to play'), h('div', { class: 'road-line' }),
        h('ol', { class: 'steps' }, ...HOW_TO.map(([t, d], i) => h('li', {}, h('span', { class: 'n' }, String(i + 1)), h('div', { html: `<b>${t}.</b> ${d}` })))),
        h('p', { class: 'tagline', style: 'font-size:13px' }, 'Mouse: left-drag to use a tool, right/middle-drag to pan, wheel to zoom. Touch: use a tool with one finger, pan and pinch with two. Keys: 1–6 tools, Space pause, Ctrl+Z undo, Ctrl+S save, T traffic view.'));
    } else if (view === 'settings') {
      const st = app.settings;
      const seg = (opts, cur, fn) => h('div', { class: 'seg', style: 'box-shadow:none;background:var(--line)' }, ...opts.map(([v, l]) => h('button', { class: cur === v ? 'on' : '', onclick: () => {
        fn(v);
        this.renderMenu();
      } }, l)));
      card.append(back(), h('h2', { class: 'wordmark', style: 'font-size:30px' }, 'Settings'), h('div', { class: 'road-line' }),
        h('div', { class: 'toggle-row' }, 'Theme', seg([['light', 'Light'], ['dark', 'Dark'], ['auto', 'Auto']], st.theme, (v) => app.setTheme(v))),
        h('div', { class: 'toggle-row' }, 'Graphics', seg([['auto', 'Auto'], ['low', 'Fast'], ['high', 'Sharp']], st.quality, (v) => app.setQuality(v))),
        h('div', { class: 'toggle-row' }, 'Sound', seg([[true, 'On'], [false, 'Off']], st.sound, (v) => app.setSound(v))),
        h('div', { class: 'toggle-row' }, 'Autosave', h('button', { class: 'pill danger', onclick: () => {
          app.clearSave();
          this.renderMenu();
        } }, 'Delete autosave')));
    }
  }
}
