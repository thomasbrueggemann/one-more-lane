// localStorage persistence (always wrapped: storage can be unavailable in private windows or full).
//
// Two kinds of saves live here:
//  * the autosave: one hidden slot (SAVE + META keys, unchanged since v1) written continuously, and
//  * manual save slots (SLOT_COUNT of them): explicit "Save game" from the menu or Ctrl/Cmd+S.

import { GAME_NAME } from './config.js';

const K = GAME_NAME.storageKey;
const SAVE = `${K}-save-v1`;
const META = `${K}-meta-v1`;
const SETTINGS = `${K}-settings-v1`;

function get(key) {
  try {
    return localStorage.getItem(key);
  } catch (e) {
    return null;
  }
}
function set(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (e) {
    return false; // quota exceeded or storage unavailable; the previous value (if any) is left untouched
  }
}

export const DEFAULT_SETTINGS = { theme: 'auto', quality: 'auto', sound: true };

export function loadSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(get(SETTINGS) || '{}') };
  } catch (e) {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s) {
  set(SETTINGS, JSON.stringify(s));
}

/* ------------------------------------------------------------ slot descriptions */

function agoText(at) {
  const ago = Math.max(0, Math.round((Date.now() - at) / 60000));
  return ago < 1 ? 'just now' : ago < 60 ? `${ago} min ago` : ago < 1440 ? `${Math.round(ago / 60)} h ago` : `${Math.round(ago / 1440)} d ago`;
}

function modeLabel(mode) {
  if (!mode || typeof mode !== 'string' || mode === 'challenge') return '';
  return /free|sandbox/i.test(mode) ? 'Free play' : mode.charAt(0).toUpperCase() + mode.slice(1);
}

/** One-line summary of a slot's metadata, e.g. "Level 3 · meadow · Free play · 5 min ago". Throws on junk. */
function describe(m) {
  if (!m || !Number.isFinite(m.level) || !Number.isFinite(m.at)) throw new Error('bad meta');
  const parts = [`Level ${m.level + 1}`, m.biome];
  const mode = modeLabel(m.mode);
  if (mode) parts.push(mode);
  parts.push(agoText(m.at));
  return parts.join(' · ');
}

function makeMeta(game, data) {
  return {
    level: game.city.level,
    biome: game.biome,
    difficulty: data.difficulty,
    mode: data.mode, // set once games have a mode; undefined (and dropped by JSON) before that
    roads: game.net.edges.size,
    buildings: game.city.list.length,
    at: Date.now(),
  };
}

function withView(game, view) {
  const data = game.serialize();
  data.view = view ? { cx: Math.round(view.cx), cy: Math.round(view.cy), ppm: Math.round(view.ppm * 100) / 100 } : null;
  return data;
}

/* ------------------------------------------------------------ autosave (the original hidden slot) */

export function hasSave() {
  return !!get(META);
}

export function saveInfo() {
  try {
    return describe(JSON.parse(get(META)));
  } catch (e) {
    return '';
  }
}

export function writeSave(game, view) {
  const data = withView(game, view);
  const ok = set(SAVE, JSON.stringify(data));
  if (ok) set(META, JSON.stringify(makeMeta(game, data)));
  return ok;
}

export function loadSave() {
  try {
    const raw = get(SAVE);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

export function clearSave() {
  try {
    localStorage.removeItem(SAVE);
    localStorage.removeItem(META);
  } catch (e) {
    /* ignore */
  }
}

/* ------------------------------------------------------------ manual save slots */

export const SLOT_COUNT = 3;
export const AUTOSAVE = 'auto';
const slotKey = (i) => `${K}-slot-${i}-v1`;

/**
 * Slots hold one record { v, meta, data } under one key, so a write either replaces the whole slot or
 * leaves it exactly as it was (a full storage must never cost the player an older save). Returns false on failure.
 */
export function writeSlot(i, game, view) {
  if (!Number.isInteger(i) || i < 1 || i > SLOT_COUNT) return false;
  const data = withView(game, view);
  return set(slotKey(i), JSON.stringify({ v: 1, meta: makeMeta(game, data), data }));
}

function readRecord(i) {
  try {
    const rec = JSON.parse(get(slotKey(i)));
    return rec && rec.data && rec.meta ? rec : null;
  } catch (e) {
    return null;
  }
}

/**
 * The autosave followed by the manual slots, for the load / save lists. state is 'empty' | 'ok' | 'corrupt';
 * a corrupt slot never throws here and can still be deleted or overwritten.
 */
export function listSlots() {
  const auto = { id: AUTOSAVE, label: 'Autosave', state: 'empty', info: '', meta: null };
  if (get(META) != null || get(SAVE) != null) {
    try {
      auto.meta = JSON.parse(get(META));
      auto.info = describe(auto.meta);
      auto.state = get(SAVE) ? 'ok' : 'corrupt';
    } catch (e) {
      auto.state = 'corrupt';
    }
  }
  const out = [auto];
  for (let i = 1; i <= SLOT_COUNT; i++) {
    const e = { id: i, label: `Slot ${i}`, state: 'empty', info: '', meta: null };
    if (get(slotKey(i)) != null) {
      try {
        const rec = readRecord(i);
        e.info = describe(rec && rec.meta);
        e.meta = rec.meta;
        e.state = 'ok';
      } catch (err) {
        e.state = 'corrupt';
      }
    }
    out.push(e);
  }
  return out;
}

export function hasAnySave() {
  return listSlots().some((s) => s.state !== 'empty');
}

/** The serialised game (plus .view) stored in a slot ('auto' or 1..SLOT_COUNT), or null. */
export function loadSlot(id) {
  if (id === AUTOSAVE) return loadSave();
  const rec = readRecord(id);
  return rec ? rec.data : null;
}

export function deleteSlot(id) {
  if (id === AUTOSAVE) {
    clearSave();
    return;
  }
  try {
    localStorage.removeItem(slotKey(id));
  } catch (e) {
    /* ignore */
  }
}
