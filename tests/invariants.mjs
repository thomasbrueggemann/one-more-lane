// Structural invariants of a running game, shared by the fuzz and demolition tests: throws on the first violation.
import assert from 'node:assert/strict';
import { buildEdgeParts, buildNodeParts } from '../js/render/roadgeom.js';
import { THEMES } from '../js/render/theme.js';

export function checkInvariants(g, label) {
  const net = g.net;
  const sim = g.sim;
  for (const e of net.edges.values()) {
    assert.ok(e.alive, `${label}: dead edge in map`);
    assert.ok(e.a.alive && e.b.alive, `${label}: edge ${e.id} has a dead node`);
    assert.ok(e.a.edges.includes(e) && e.b.edges.includes(e), `${label}: node edge list`);
    for (const d of [e.dirF, e.dirB]) {
      if (!d) continue;
      assert.ok(d.alive, `${label}: dead dir`);
      for (const l of d.lanes) assert.ok(l.alive && l.poly && Number.isFinite(l.len), `${label}: lane ${l.id}`);
    }
  }
  for (const n of net.nodes.values()) {
    assert.ok(n.edges.length > 0, `${label}: orphan node ${n.id}`);
    for (const c of n.conns) assert.ok(c.alive && c.from.alive && c.to.alive, `${label}: stale conn at node ${n.id}`);
    if (n.signal) assert.ok(n.edges.length >= 3 && n.ring == null, `${label}: signal on a non-junction`);
  }
  for (const v of sim.vehicles) {
    if (v.dead) continue;
    const c = v.conn || v.lane;
    assert.ok(c && c.alive, `${label}: vehicle ${v.id} on a dead container`);
    assert.ok(c.vehicles.includes(v), `${label}: vehicle ${v.id} missing from its container`);
    assert.ok(Number.isFinite(v.s) && Number.isFinite(v.v) && Number.isFinite(v.a), `${label}: NaN state for vehicle ${v.id}`);
    // the route must agree with where the vehicle actually is (edits that split a road re-point it at the new pieces)
    const here = v.conn ? v.conn.from.dir : v.lane.dir;
    assert.ok(v.route[v.ri] === here, `${label}: vehicle ${v.id} route[${v.ri}] is not the road it is on (edge ${here.edge.id})`);
    assert.ok(v.route[v.route.length - 1] === v.dest.dir, `${label}: vehicle ${v.id} route does not end at its destination`);
    if (!(v.s >= -0.001 && v.s <= c.len + 1.5)) {
      const where = v.conn ? `conn ${c.key} len ${c.len.toFixed(1)}` : `lane ${c.id} (edge ${c.dir.edge.id}, j ${c.j}, ring ${c.dir.edge.ring}) len ${c.len.toFixed(1)} vehicles ${c.vehicles.length} idx ${c.vehicles.indexOf(v)}`;
      throw new Error(`${label}: vehicle ${v.id} s=${v.s.toFixed(2)} outside its container: ${where}; v=${v.v.toFixed(2)} a=${v.a.toFixed(2)} granted=${v.granted} nextConn=${v.nextConn ? v.nextConn.key : '-'} ri=${v.ri}/${v.route.length - 1} lastChange=${v.lastChange.toFixed(1)} t=${sim.time.toFixed(1)}`);
    }
  }
  for (const L of sim.occupied) assert.ok(L.alive, `${label}: occupied set holds a dead container`);
  // render geometry must be finite for every edge and junction
  for (const e of net.edges.values()) {
    const parts = buildEdgeParts(e, THEMES.light);
    for (const k of ['shadow', 'casing', 'fill', 'marks']) {
      for (const v of parts[k].p) if (!Number.isFinite(v)) throw new Error(`${label}: non-finite ${k} geometry on edge ${e.id}`);
    }
  }
  for (const n of net.nodes.values()) {
    const parts = buildNodeParts(n, THEMES.light);
    for (const k of ['casing', 'fill']) for (const v of parts[k].p) if (!Number.isFinite(v)) throw new Error(`${label}: non-finite ${k} junction geometry at node ${n.id}`);
  }
}
