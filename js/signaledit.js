// Pure helpers for editing a traffic signal's phases at the level of individual movements
// (an arrow in the editor = one movement from an approach to an exit).

/** Nearest movement of the node's junction to a world point (within maxD metres), or null. */
export function pickMovement(node, x, y, maxD = 3.2) {
  let best = null;
  let bd = maxD;
  const seen = new Map();
  for (const c of node.conns) {
    const d = c.poly.closest(x, y).d;
    // all lane connections of one movement share a key: take the closest lane of the movement
    const prev = seen.get(c.moveKey);
    if (prev === undefined || d < prev) seen.set(c.moveKey, d);
    if (d < bd) {
      bd = d;
      best = c;
    }
  }
  return best;
}

/**
 * Give a movement green in phase `idx`: it moves there from whichever phase currently serves it.
 * If it is already in that phase it is taken out again, but only when another phase still serves it
 * (a movement must always get a green somewhere or cars would wait forever).
 * Phases left without any movement are dropped. Returns {ok, reason, idx}.
 */
export function toggleMovement(signal, moveKey, idx) {
  const phases = signal.phases;
  const here = phases[idx];
  if (!here) return { ok: false, reason: 'no_phase', idx };
  if (here.moves.has(moveKey)) {
    const elsewhere = phases.some((p, i) => i !== idx && p.moves.has(moveKey));
    if (!elsewhere) return { ok: false, reason: 'needs_green', idx };
    here.moves.delete(moveKey);
  } else {
    for (const p of phases) p.moves.delete(moveKey);
    here.moves.add(moveKey);
  }
  // drop empty phases, keeping the selection on the same phase when possible
  let sel = idx;
  for (let i = phases.length - 1; i >= 0; i--) {
    if (phases[i].moves.size === 0 && phases.length > 1) {
      phases.splice(i, 1);
      if (i < sel) sel--;
      else if (i === sel) sel = Math.max(0, sel - 1);
    }
  }
  signal.idx = Math.min(signal.idx, phases.length - 1);
  signal.custom = true;
  if (signal.demand) signal.demand = null;
  return { ok: true, idx: Math.min(sel, phases.length - 1) };
}

/** A new phase containing just this movement (taken from its current phase). */
export function splitMovement(signal, moveKey) {
  const phases = signal.phases;
  const from = phases.findIndex((p) => p.moves.has(moveKey));
  if (from >= 0 && phases[from].moves.size === 1) return { ok: false, reason: 'already_alone', idx: from };
  for (const p of phases) p.moves.delete(moveKey);
  phases.push({ dur: 8, moves: new Set([moveKey]) });
  signal.custom = true;
  if (signal.demand) signal.demand = null;
  return { ok: true, idx: phases.length - 1 };
}
