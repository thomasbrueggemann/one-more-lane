import assert from 'node:assert/strict';
import { Game } from '../js/game.js';
import { overlaps } from './simlib.mjs';

// ---- starter town runs and earns money; traffic flows
{
  const g = new Game({ seed: 11, biome: 'meadow', difficulty: 'normal', res: 128 });
  assert.ok(g.net.edges.size >= 3, 'starter roads exist');
  assert.ok(g.city.list.length >= 8, 'starter buildings placed: ' + g.city.list.length);
  const types = new Set(g.city.list.map((b) => b.type));
  for (const t of ['house', 'shop', 'office', 'factory']) assert.ok(types.has(t), 'starter has a ' + t);
  const money0 = g.city.money;
  let overlap = 0;
  for (let i = 0; i < 20 * 400; i++) {
    g.update(0.05);
    if (i % 20 === 0) overlap += overlaps(g.sim).length;
  }
  console.log(
    `starter after 400 s: vehicles ${g.sim.vehicles.length}, arrived ${g.sim.stats.arrived}, trips ${g.city.stats.trips}, money ${Math.round(money0)} -> ${Math.round(g.city.money)}, level ${g.city.level} (xp ${g.city.xp.toFixed(1)}), happiness ${g.city.stats.happiness.toFixed(2)}`,
  );
  assert.equal(overlap, 0, 'no vehicle overlaps');
  assert.ok(g.sim.stats.arrived > 20, 'trips complete');
  assert.ok(g.city.money > money0, 'income exceeds nothing spent');
}

// ---- placement rules
{
  const g = new Game({ seed: 12, biome: 'meadow', res: 128, starter: false });
  const planner = g.planner;
  const plan = planner.planRoad({ a: { kind: 'free', x: -100, y: 0, z: 0 }, b: { kind: 'free', x: 100, y: 0, z: 0 }, cls: 'street', lf: 1, lb: 1 });
  assert.ok(plan.ok);
  const r = g.buildRoad(plan);
  assert.ok(r.ok);
  assert.ok(g.city.money < 40000, 'road costs money');
  const pl = g.city.findPlacement('house', 40, 20);
  assert.ok(pl.ok, pl.reason);
  const placed = g.placeBuilding(pl);
  assert.ok(placed.ok);
  // second house at the same spot overlaps
  const again = g.city.findPlacement('house', 40, 20);
  assert.equal(again.ok, false);
  assert.equal(again.reason, 'overlap');
  // building away from any road
  const far = g.city.findPlacement('house', 0, 400);
  assert.equal(far.ok, false);
  // road can't run through the house
  const through = planner.planRoad({ a: { kind: 'free', x: 40, y: 60, z: 0 }, b: { kind: 'free', x: 40, y: 15, z: 0 }, cls: 'street', lf: 1, lb: 1 });
  assert.equal(through.ok, false);
  // undo restores money, tray and buildings
  const moneyBefore = g.city.money;
  const edgesBefore = g.net.edges.size;
  const p2 = planner.planRoad({ a: { kind: 'free', x: -60, y: 90, z: 0 }, b: { kind: 'free', x: 60, y: 90, z: 0 }, cls: 'street', lf: 1, lb: 1 });
  assert.ok(p2.ok, p2.error);
  g.buildRoad(p2);
  assert.ok(g.net.edges.size > edgesBefore);
  assert.ok(g.undo());
  assert.equal(g.net.edges.size, edgesBefore);
  assert.ok(Math.abs(g.city.money - moneyBefore) < 1e-6);
  assert.equal(g.city.list.length, 1, 'building survives undo of a later action');
  // bulldoze refunds half and returns buildings to the tray when their road is gone? (they stay, but lose access)
  const e = [...g.net.edges.values()][0];
  const m0 = g.city.money;
  const rm = g.bulldozeEdge(e);
  assert.ok(rm.refund > 0);
  assert.ok(g.city.money > m0);
}

// ---- save / load round trip
{
  const g = new Game({ seed: 13, biome: 'desert', res: 128 });
  for (let i = 0; i < 20 * 30; i++) g.update(0.05);
  const data = JSON.parse(JSON.stringify(g.serialize()));
  const g2 = Game.fromSave(data, { res: 128 });
  assert.equal(g2.net.edges.size, g.net.edges.size);
  assert.equal(g2.city.list.length, g.city.list.length);
  assert.equal(Math.round(g2.city.money), Math.round(g.city.money));
  for (let i = 0; i < 20 * 120; i++) g2.update(0.05);
  assert.ok(g2.sim.stats.arrived > 0, 'loaded game keeps running');
}

console.log('game tests passed');
