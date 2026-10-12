import assert from 'node:assert/strict';
import { makeWorld, road, free } from './simlib.mjs';
import { Signal, SIGNAL_GREEN, SIGNAL_RED, SIGNAL_AMBER } from '../js/signals.js';
import { pickMovement, toggleMovement, splitMovement } from '../js/signaledit.js';

function crossing() {
  const w = makeWorld();
  road(w.planner, free(-150, 0), free(150, 0)); // 300 m: split at x=-50 and 50, so x=0 is clear
  road(w.planner, free(0, -150), free(0, 150));
  const jn = [...w.net.nodes.values()].find((n) => n.edges.length === 4);
  w.planner.toggleSignal(jn);
  return { w, jn };
}

// --- phase timing: green, amber, all-red, then the next phase
{
  const { jn } = crossing();
  const s = jn.signal;
  const key = [...s.phases[0].moves][0];
  s.idx = 0;
  s.t = 0;
  s.demand = null; // pure timing, no actuation
  assert.equal(s.state(key), SIGNAL_GREEN);
  s.t = s.phases[0].dur + 0.5;
  assert.equal(s.state(key), SIGNAL_AMBER);
  s.t = s.phases[0].dur + s.amber + 0.2;
  assert.equal(s.state(key), SIGNAL_RED);
  s.update(2);
  assert.equal(s.idx, 1, 'moves on to the next phase after the clearance interval');
  assert.equal(s.state(key), SIGNAL_RED, 'the first phase is red now');
}

// --- actuation: an empty phase is skipped, a green with nobody left gaps out early
{
  const { jn } = crossing();
  const s = jn.signal;
  s.idx = 0;
  s.t = 0;
  s.demand = [false, true];
  for (let i = 0; i < 20 * 8; i++) s.update(0.05);
  assert.equal(s.idx, 0, 'still in phase 0 before the minimum green is over?');
  // run on until the controller leaves phase 0: must happen right after the min green + amber + clear, not at 20 s
  let t = 8;
  while (s.idx === 0 && t < 40) {
    s.update(0.05);
    t += 0.05;
  }
  assert.ok(t < 8 + s.amber + s.clear + 1.2, `gapped out early (left phase 0 after ${t.toFixed(1)} s)`);
  assert.equal(s.idx, 1);
  // when only the current phase has demand the next phase is skipped
  s.t = 0;
  s.demand = [true, false];
  s.idx = 1;
  s.t = s.phases[1].dur + s.amber + s.clear - 0.01;
  s.update(0.05);
  assert.equal(s.idx, 0, 'phase 1 has nobody: jump back to phase 0');
}

// --- editing movements
{
  const { jn } = crossing();
  const s = jn.signal;
  assert.equal(s.phases.length, 2);
  const [p0, p1] = s.phases;
  const keyA = [...p0.moves][0];
  const total = new Set([...p0.moves, ...p1.moves]).size;
  // moving a movement into the other phase
  let r = toggleMovement(s, keyA, 1);
  assert.ok(r.ok);
  assert.ok(!p0.moves.has(keyA) && p1.moves.has(keyA));
  // it must never be removed from the only phase serving it
  r = toggleMovement(s, keyA, 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'needs_green');
  assert.equal(new Set([...s.phases.flatMap((p) => [...p.moves])]).size, total, 'every movement still has a green');
  // emptying a phase drops it
  for (const k of [...p0.moves]) toggleMovement(s, k, 1);
  assert.equal(s.phases.length, 1);
  // a movement can get a phase of its own
  const k2 = [...s.phases[0].moves][0];
  const sp = splitMovement(s, k2);
  assert.ok(sp.ok);
  assert.equal(s.phases.length, 2);
  assert.ok(s.phases[sp.idx].moves.has(k2) && s.phases[sp.idx].moves.size === 1);
}

// --- picking a movement by tapping its arrow
{
  const { jn } = crossing();
  const c = jn.conns.find((k) => k.turn === 'S');
  const mid = c.poly.pointAt(c.len / 2);
  const picked = pickMovement(jn, mid.x, mid.y);
  assert.ok(picked && picked.moveKey === c.moveKey);
  assert.equal(pickMovement(jn, mid.x + 80, mid.y + 80), null, 'nothing far away');
}

// --- rebuildPhases keeps durations but restores sane defaults when the topology changes
{
  const { jn } = crossing();
  const s = jn.signal;
  s.phases[0].dur = 33;
  s.rebuildPhases();
  assert.equal(s.phases[0].dur, 33);
}

console.log('signal tests passed');
void Signal;
