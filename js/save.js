// localStorage persistence (always wrapped: storage can be unavailable in private windows or full).

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
    return false;
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

export function hasSave() {
  return !!get(META);
}

export function saveInfo() {
  try {
    const m = JSON.parse(get(META));
    const ago = Math.max(0, Math.round((Date.now() - m.at) / 60000));
    const when = ago < 1 ? 'just now' : ago < 60 ? `${ago} min ago` : ago < 1440 ? `${Math.round(ago / 60)} h ago` : `${Math.round(ago / 1440)} d ago`;
    return `Level ${m.level + 1} · ${m.biome} · ${when}`;
  } catch (e) {
    return '';
  }
}

export function writeSave(game, view) {
  const data = game.serialize();
  data.view = view ? { cx: Math.round(view.cx), cy: Math.round(view.cy), ppm: Math.round(view.ppm * 100) / 100 } : null;
  const ok = set(SAVE, JSON.stringify(data));
  if (ok) set(META, JSON.stringify({ level: game.city.level, biome: game.biome, at: Date.now() }));
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
