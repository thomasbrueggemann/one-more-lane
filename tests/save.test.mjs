import assert from 'node:assert/strict';

// tiny in-memory localStorage (with a size cap to provoke quota errors), installed before save.js is used
class MemStorage {
  constructor() {
    this.m = new Map();
    this.cap = Infinity;
    this.broken = false;
  }
  used() {
    let n = 0;
    for (const [k, v] of this.m) n += k.length + v.length;
    return n;
  }
  getItem(k) {
    if (this.broken) throw new Error('SecurityError');
    return this.m.has(k) ? this.m.get(k) : null;
  }
  setItem(k, v) {
    if (this.broken) throw new Error('SecurityError');
    const old = this.m.has(k) ? k.length + this.m.get(k).length : 0;
    if (this.used() - old + k.length + String(v).length > this.cap) throw new DOMException('full', 'QuotaExceededError');
    this.m.set(k, String(v));
  }
  removeItem(k) {
    if (this.broken) throw new Error('SecurityError');
    this.m.delete(k);
  }
}
globalThis.localStorage = new MemStorage();
const ls = globalThis.localStorage;

const store = await import('../js/save.js');
const { Game } = await import('../js/game.js');

const mk = (seed) => new Game({ seed, biome: 'meadow', difficulty: 'normal', res: 128 });
const view = { cx: 12.4, cy: -7.6, ppm: 2.456 };
const edges = (g) => g.net.edges.size;

// ---- fresh storage: nothing saved, list is 1 autosave + SLOT_COUNT empty slots
{
  assert.equal(store.hasSave(), false);
  assert.equal(store.hasAnySave(), false);
  const l = store.listSlots();
  assert.equal(l.length, 1 + store.SLOT_COUNT);
  assert.deepEqual(l.map((s) => s.id), ['auto', 1, 2, 3]);
  assert.ok(l.every((s) => s.state === 'empty'));
  assert.equal(store.loadSlot(1), null);
  assert.equal(store.loadSlot('auto'), null);
}

// ---- slot write / list / load / delete round trip
{
  const g = mk(21);
  assert.equal(store.writeSlot(2, g, view), true);
  const l = store.listSlots();
  assert.equal(l[2].state, 'ok');
  assert.equal(l[1].state, 'empty');
  assert.equal(l[2].label, 'Slot 2');
  assert.equal(l[2].meta.roads, edges(g));
  assert.equal(l[2].meta.buildings, g.city.list.length);
  assert.equal(l[2].meta.difficulty, 'normal');
  assert.match(l[2].info, /^Level 1 · meadow · just now$/);
  assert.equal(store.hasAnySave(), true);
  assert.equal(store.hasSave(), false, 'manual slots are separate from the autosave');

  const data = store.loadSlot(2);
  assert.deepEqual(data.view, { cx: 12, cy: -8, ppm: 2.46 });
  // everything serialize() returns is stored (no hard-coded field list)
  const ser = g.serialize();
  for (const k of Object.keys(ser)) assert.deepEqual(data[k], JSON.parse(JSON.stringify(ser[k])), 'field ' + k);
  const g2 = Game.fromSave(data);
  assert.equal(edges(g2), edges(g));
  assert.equal(g2.city.list.length, g.city.list.length);
  assert.equal(g2.seed, g.seed);

  // overwrite with a different city
  const other = mk(22);
  assert.equal(store.writeSlot(2, other, null), true);
  assert.equal(store.loadSlot(2).seed, 22);
  assert.equal(store.loadSlot(2).view, null);

  store.deleteSlot(2);
  assert.equal(store.listSlots()[2].state, 'empty');
  assert.equal(store.loadSlot(2), null);
  assert.equal(store.hasAnySave(), false);

  // bad slot numbers are rejected, not written
  assert.equal(store.writeSlot(0, g, view), false);
  assert.equal(store.writeSlot(store.SLOT_COUNT + 1, g, view), false);
  assert.equal(store.writeSlot('auto', g, view), false);
  assert.equal(ls.m.size, 0);
}

// ---- a mode field from serialize() (if the game has one) shows up in the slot info
{
  const g = new Game({ seed: 23, biome: 'meadow', difficulty: 'normal', mode: 'free', res: 128 });
  assert.equal(store.writeSlot(1, g, view), true);
  const s = store.listSlots()[1];
  assert.equal(s.meta.mode, 'free');
  assert.match(s.info, /Free play/);
  assert.equal(store.loadSlot(1).mode, 'free');
  assert.equal(Game.fromSave(store.loadSlot(1)).mode, 'free');
  // the normal mode is not spelled out, and a save without any mode field still lists fine
  assert.equal(store.writeSlot(2, mk(23), view), true);
  assert.doesNotMatch(store.listSlots()[2].info, /challenge|Free/);
  const rec = JSON.parse(ls.getItem('one-more-lane-slot-2-v1'));
  delete rec.meta.mode;
  delete rec.data.mode;
  ls.setItem('one-more-lane-slot-2-v1', JSON.stringify(rec));
  assert.equal(store.listSlots()[2].state, 'ok');
  assert.equal(Game.fromSave(store.loadSlot(2)).seed, 23);
  store.deleteSlot(1);
  store.deleteSlot(2);
}

// ---- autosave stays its own slot and legacy keys keep working
{
  const g = mk(24);
  assert.equal(store.writeSave(g, view), true);
  assert.ok(ls.getItem('one-more-lane-save-v1') && ls.getItem('one-more-lane-meta-v1'), 'legacy key names unchanged');
  assert.equal(store.hasSave(), true);
  const auto = store.listSlots()[0];
  assert.equal(auto.id, 'auto');
  assert.equal(auto.label, 'Autosave');
  assert.equal(auto.state, 'ok');
  assert.equal(store.loadSlot('auto').seed, 24);
  assert.equal(store.loadSave().seed, 24);
  store.writeSlot(1, mk(25), view);
  assert.equal(store.loadSlot('auto').seed, 24, 'a manual save leaves the autosave alone');
  store.writeSave(mk(26), view);
  assert.equal(store.loadSlot(1).seed, 25, 'autosaving leaves manual slots alone');
  store.deleteSlot('auto');
  assert.equal(store.hasSave(), false);
  assert.equal(store.loadSlot(1).seed, 25, 'deleting the autosave leaves manual slots alone');
  store.deleteSlot(1);
}

// ---- a save written by the first release (old meta, no roads/mode/difficulty) still lists and loads
{
  const g = mk(27);
  const old = g.serialize();
  old.view = { cx: 1, cy: 2, ppm: 3 };
  delete old.mode;
  ls.setItem('one-more-lane-save-v1', JSON.stringify(old));
  ls.setItem('one-more-lane-meta-v1', JSON.stringify({ level: 2, biome: 'coast', at: Date.now() - 5 * 60000 }));
  assert.equal(store.hasSave(), true);
  assert.equal(store.saveInfo(), 'Level 3 · coast · 5 min ago');
  const auto = store.listSlots()[0];
  assert.equal(auto.state, 'ok');
  assert.equal(auto.info, 'Level 3 · coast · 5 min ago');
  const data = store.loadSlot('auto');
  assert.equal(Game.fromSave(data).seed, 27);
  store.clearSave();
  assert.equal(store.hasSave(), false);
  assert.equal(ls.m.size, 0);
}

// ---- corrupt slots do not crash the list, and can be deleted or overwritten
{
  ls.setItem('one-more-lane-slot-1-v1', '{not json');
  ls.setItem('one-more-lane-slot-2-v1', 'null');
  ls.setItem('one-more-lane-slot-3-v1', JSON.stringify({ v: 1, meta: { level: 'x' }, data: {} }));
  ls.setItem('one-more-lane-meta-v1', '%%%');
  ls.setItem('one-more-lane-save-v1', '{"broken');
  const l = store.listSlots();
  assert.deepEqual(l.map((s) => s.state), ['corrupt', 'corrupt', 'corrupt', 'corrupt']);
  assert.equal(store.saveInfo(), '');
  assert.equal(store.loadSlot(1), null);
  assert.equal(store.loadSlot(2), null);
  assert.equal(store.loadSave(), null);
  assert.equal(store.writeSlot(1, mk(28), view), true, 'overwriting a corrupt slot works');
  assert.equal(store.listSlots()[1].state, 'ok');
  store.deleteSlot(2);
  assert.equal(store.listSlots()[2].state, 'empty');
  store.deleteSlot(3);
  store.deleteSlot(1);
  store.deleteSlot('auto');
  assert.equal(ls.m.size, 0);
}

// ---- quota exceeded: the write reports failure and an existing slot is left intact
{
  const g = mk(29);
  assert.equal(store.writeSlot(1, g, view), true);
  const before = ls.getItem('one-more-lane-slot-1-v1');
  ls.cap = ls.used() - 10; // storage "full": nothing new fits, not even a replacement
  assert.equal(store.writeSlot(1, mk(30), view), false, 'overwrite that does not fit');
  assert.equal(ls.getItem('one-more-lane-slot-1-v1'), before, 'old save survives a failed overwrite');
  assert.equal(store.loadSlot(1).seed, 29);
  assert.equal(store.writeSlot(2, mk(31), view), false, 'new slot that does not fit');
  assert.equal(store.listSlots()[2].state, 'empty', 'no half-written slot');
  assert.equal(store.writeSave(mk(32), view), false, 'autosave failure is reported, not thrown');
  assert.equal(store.hasSave(), false);
  ls.cap = Infinity;
  store.deleteSlot(1);
}

// ---- storage unavailable altogether: nothing throws
{
  ls.broken = true;
  assert.equal(store.writeSlot(1, mk(33), view), false);
  assert.equal(store.writeSave(mk(34), view), false);
  assert.equal(store.hasSave(), false);
  assert.equal(store.hasAnySave(), false);
  assert.equal(store.loadSlot(1), null);
  assert.equal(store.listSlots().length, 1 + store.SLOT_COUNT);
  store.deleteSlot(1);
  store.deleteSlot('auto');
  assert.equal(store.loadSettings().theme, 'auto');
  ls.broken = false;
}

// ---- how big is a saved city? (informational; slots and autosave must fit in the usual 5 MB quota many times over)
{
  const g = mk(35);
  const bytes = JSON.stringify(g.serialize()).length;
  console.log(`save size: starter city ${bytes} bytes`);
  assert.ok(bytes < 200000);
}

console.log('save ok');
