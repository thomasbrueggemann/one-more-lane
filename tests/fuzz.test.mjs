// Random editing while traffic is running: nothing may throw and the model must stay consistent.
import assert from 'node:assert/strict';
import { Game } from '../js/game.js';
import { Rng } from '../js/util.js';
import { LANE_W } from '../js/network.js';
import { buildEdgeParts, buildNodeParts } from '../js/render/roadgeom.js';
import { THEMES } from '../js/render/theme.js';

function checkInvariants(g, label) {
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

function randomPoint(rng, r) {
  return { x: rng.range(-r, r), y: rng.range(-r, r) };
}

function oneRun(seed, steps) {
  const g = new Game({ seed, biome: ['meadow', 'desert', 'highlands', 'coast'][seed % 4], res: 96, starter: true });
  const rng = new Rng(seed * 7 + 1);
  g.city.money = 1e7;
  g.city.diff = { ...g.city.diff, demand: 8 }; // lots of traffic while we edit
  g.city.tray = { house: 30, shop: 8, office: 6, factory: 4 };
  const net = g.net;
  const stats = { build: 0, fail: 0, lane: 0, signal: 0, ring: 0, bulldoze: 0, place: 0, pick: 0, undo: 0, peak: 0, arrived: 0 };
  for (let i = 0; i < steps; i++) {
    const act = rng.next();
    try {
      if (act < 0.34) {
        // build a road between random snaps (often from existing nodes)
        const nodes = [...net.nodes.values()];
        const startNode = nodes.length && rng.chance(0.6) ? rng.pick(nodes) : null;
        const a = startNode ? { kind: 'node', node: startNode, x: startNode.x, y: startNode.y, z: startNode.z } : g.planner.snap(...Object.values(randomPoint(rng, 250)).slice(0, 2), 12, {});
        const p = randomPoint(rng, 300);
        const elev = rng.chance(0.15) ? rng.int(1, 2) : 0;
        const b = g.planner.snap(p.x, p.y, 12, { elev, forEnd: true });
        const cls = rng.pick(['street', 'avenue', 'highway']);
        const n = cls === 'street' ? 1 : cls === 'avenue' ? 2 : 3;
        const plan = g.planner.planRoad({ a, b, cls, lf: n, lb: rng.chance(0.15) ? 0 : n, straight: rng.chance(0.3) });
        if (plan.ok) {
          const r = g.buildRoad(plan);
          assert.ok(r.ok);
          stats.build++;
        } else stats.fail++;
      } else if (act < 0.44) {
        const edges = [...net.edges.values()].filter((e) => !e.invalid);
        if (edges.length) {
          const e = rng.pick(edges);
          const plan = g.planner.planLane(e, rng.chance(0.5) ? 1 : -1, rng.chance(0.7) ? 1 : -1);
          if (plan.ok) {
            g.changeLane(plan);
            stats.lane++;
          }
        }
      } else if (act < 0.52) {
        const js = [...net.nodes.values()].filter((n) => n.edges.length >= 3 && n.ring == null);
        if (js.length) {
          g.toggleSignal(rng.pick(js));
          stats.signal++;
        }
      } else if (act < 0.58) {
        const js = [...net.nodes.values()].filter((n) => n.edges.length >= 3 && n.ring == null && n.z < 0.1);
        const c = js.length && rng.chance(0.7) ? rng.pick(js) : randomPoint(rng, 200);
        const plan = g.planner.planRoundabout({ x: c.x, y: c.y, R: rng.range(16, 30), lanes: rng.chance(0.3) ? 2 : 1 });
        if (plan.ok) {
          g.buildRoundabout(plan);
          stats.ring++;
        }
      } else if (act < 0.68) {
        const edges = [...net.edges.values()];
        if (edges.length > 2) {
          g.bulldozeEdge(rng.pick(edges));
          stats.bulldoze++;
        }
      } else if (act < 0.84) {
        const type = rng.pick(['house', 'house', 'shop', 'office', 'factory']);
        const p = randomPoint(rng, 260);
        const pl = g.city.findPlacement(type, p.x, p.y, 60);
        if (pl.ok) {
          g.placeBuilding(pl);
          stats.place++;
        }
      } else if (act < 0.9) {
        if (g.city.list.length) {
          g.removeBuilding(rng.pick(g.city.list));
          stats.pick++;
        }
      } else if (act < 0.93) {
        if (g.undo()) stats.undo++;
      }
      // let traffic run, with extra random through-traffic so edits happen among many vehicles
      const secs = rng.range(0.5, 4);
      for (let k = 0; k < secs * 20; k++) {
        if (k % 5 === 0 && g.sim.vehicles.length < 120) {
          const aps = [...net.edges.values()].flatMap((e) => [e.dirF, e.dirB]).filter((d) => d && d.lanes[0].len > 14);
          if (aps.length > 1) {
            const da = rng.pick(aps);
            const db = rng.pick(aps);
            const la = da.lanes[da.lanes.length - 1];
            const lb = db.lanes[db.lanes.length - 1];
            const pa = la.poly.pointAt(la.len * rng.range(0.2, 0.8));
            const pb = lb.poly.pointAt(lb.len * rng.range(0.2, 0.8));
            g.sim.spawn({ from: { dir: da, lane: la, x: pa.x, y: pa.y }, to: { dir: db, x: pb.x, y: pb.y, j: db.lanes.length - 1 } });
          }
        }
        g.update(0.05);
        stats.peak = Math.max(stats.peak, g.sim.vehicles.length);
      }
      checkInvariants(g, `seed ${seed} step ${i}`);
    } catch (err) {
      err.message = `seed ${seed} step ${i} (act ${act.toFixed(2)}): ${err.message}`;
      throw err;
    }
  }
  // finally: everything still simulates
  for (let k = 0; k < 20 * 30; k++) g.update(0.05);
  checkInvariants(g, `seed ${seed} final`);
  stats.arrived = g.sim.stats.arrived;
  return stats;
}

const t0 = Date.now();
let total = { build: 0, fail: 0, lane: 0, signal: 0, ring: 0, bulldoze: 0, place: 0, pick: 0, undo: 0, peak: 0, arrived: 0 };
const SEEDS = Number(process.env.FUZZ_SEEDS) || 30; // e.g. FUZZ_SEEDS=300 node tests/fuzz.test.mjs for a long soak
const FIRST = Number(process.env.FUZZ_FIRST) || 1; // FUZZ_FIRST=91 FUZZ_SEEDS=91 reproduces a single seed
for (let seed = FIRST; seed <= SEEDS; seed++) {
  const s = oneRun(seed, 130);
  for (const k of Object.keys(total)) total[k] = k === 'peak' ? Math.max(total[k], s[k]) : total[k] + s[k];
}
console.log('fuzz actions applied:', JSON.stringify(total), `(${((Date.now() - t0) / 1000).toFixed(1)} s)`);
void LANE_W;
console.log('fuzz tests passed');
