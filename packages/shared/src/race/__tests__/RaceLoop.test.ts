import { describe, it, expect } from 'vitest';

import { RaceLoop, type RaceLoopConfig } from '../RaceLoop.js';
import { buildStartingGrid } from '../startingGrid.js';
import { AI_DRIVER_PROFILES, AI_CHARACTER_ORDER } from '../aiProfiles.js';
import { WEAPON_CATALOGUE } from '../../catalogue/GameCatalogue.js';
import type { TrackDef } from '../../types/track.js';
import type { WaypointGraph } from '../../types/track.js';
import type { CarInputs } from '../../types/physics.js';
import type { WeaponId } from '../../types/primitives.js';
import type { WeaponDef } from '../../types/weapons.js';
import type { CarRaceState } from '../../types/car.js';
import type { PhysicsCarStats } from '../../physics/stepPhysics.js';

/** A small square waypoint loop for deterministic lap tests. */
function squareGraph(): WaypointGraph {
  const nodes = [
    { id: 0, position: { x: 0, y: 0 }, width: 10 },
    { id: 1, position: { x: 0, y: 100 }, width: 10 },
    { id: 2, position: { x: 100, y: 100 }, width: 10 },
    { id: 3, position: { x: 100, y: 0 }, width: 10 },
  ];
  const edges = nodes.map((_, i) => ({
    from: i,
    to: (i + 1) % nodes.length,
    distance: 100,
  }));
  return { nodes, edges };
}

/** A minimal TrackDef whose roadSegments mirror the square loop. */
function squareTrack(): TrackDef {
  const graph = squareGraph();
  return {
    id: 'bay_area',
    name: 'Test',
    city: 'Test',
    lapCount: 2,
    roadSegments: graph.nodes.map((n, i) => ({
      index: i,
      centre: n.position,
      width: 20,
      normal: { x: 1, y: 0 },
      surface: 'asphalt',
    })),
    jumpRamps: [],
    waypointGraph: graph,
    pitLane: { entryPosition: { x: 0, y: 0 }, exitPosition: { x: 0, y: 0 }, path: [] },
    hazardZones: [],
    scenery: [],
    palette: new Uint8Array(0),
  };
}

const weaponConfigs = new Map<WeaponId, WeaponDef>(WEAPON_CATALOGUE.map((w) => [w.id, w]));

describe('AI_DRIVER_PROFILES', () => {
  it('defines a fixed profile for all nine named drivers', () => {
    expect(AI_CHARACTER_ORDER).toHaveLength(9);
    for (const c of AI_CHARACTER_ORDER) {
      const p = AI_DRIVER_PROFILES[c];
      expect(p.character).toBe(c);
      expect(['novice', 'standard', 'expert']).toContain(p.skillTier);
      expect(p.aggression).toBeGreaterThanOrEqual(1);
      expect(p.aggression).toBeLessThanOrEqual(5);
    }
  });

  it('covers all three skill tiers across the field', () => {
    const tiers = new Set(AI_CHARACTER_ORDER.map((c) => AI_DRIVER_PROFILES[c].skillTier));
    expect(tiers).toEqual(new Set(['novice', 'standard', 'expert']));
  });
});

describe('buildStartingGrid', () => {
  it('builds a 10-car grid (human + nine AI) with stats and controls', () => {
    const grid = buildStartingGrid({
      track: squareTrack(),
      humanLoadout: {
        chassisId: 'hellcat',
        components: { engine: null, brakes: null, transmission: null, tires: null, airfoil: null, armor: null },
        weapons: { forward: 'machine_gun', rear: null, side_spike: null, ram: null },
      },
      humanName: 'Player',
    });
    expect(grid.cars).toHaveLength(10);
    expect(grid.carStats.size).toBe(10);
    expect(grid.participants).toHaveLength(10);
    // Participant 0 is the human; the rest are AI.
    expect(grid.participants[0]!.isAI).toBe(false);
    expect(grid.participants.slice(1).every((p) => p.isAI)).toBe(true);
    // Every car starts on lap 1 with full armor and no elimination.
    for (const car of grid.cars) {
      expect(car.lap).toBe(1);
      expect(car.eliminated).toBe(false);
      expect(car.currentArmor).toBeGreaterThan(0);
    }
    // Cars are spread out (no two share the exact same start position).
    const positions = new Set(grid.cars.map((c) => `${c.physics.position.x},${c.physics.position.y}`));
    expect(positions.size).toBe(10);
  });
});

/** Build a tiny 2-car RaceLoop config with controllable stats. */
function twoCarConfig(overrides?: {
  car0Stats?: Partial<PhysicsCarStats>;
  lapCount?: number;
}): RaceLoopConfig {
  const graph = squareGraph();
  const mkCar = (id: number, x: number, y: number): CarRaceState => ({
    participantId: id,
    physics: {
      id,
      position: { x, y },
      velocity: { x: 0, y: 0 },
      heading: 0,
      speed: 0,
      angularVelocity: 0,
      onTrack: true,
      airborne: false,
      airborneHeight: 0,
      airborneVY: 0,
    },
    currentArmor: id === 1 ? 1 : 200, // car 1 is fragile for elimination tests
    ammo: new Map<WeaponId, number>([['machine_gun', 300]]),
    eliminated: false,
    lap: 1,
    placement: id + 1,
    waypointIndex: 0,
  });
  const carStats = new Map<number, PhysicsCarStats>([
    [0, { topSpeed: 80, acceleration: 60, brake: 40, handling: 60, mass: 1000, armor: 200, ...overrides?.car0Stats }],
    [1, { topSpeed: 80, acceleration: 60, brake: 40, handling: 60, mass: 1000, armor: 1 }],
  ]);
  // Car 1 sits directly ahead of car 0 (heading 0 = +Y) at the exact point a
  // machine-gun projectile lands one tick after spawning: muzzleOffset (1) +
  // projectileSpeed (400) * dt (1/60). This makes the forward-fire contact
  // deterministic for the elimination test.
  const car1Y = 1 + 400 * (1 / 60);
  return {
    cars: [mkCar(0, 0, 0), mkCar(1, 0, car1Y)],
    carStats,
    participants: [
      { participantId: 0, displayName: 'P0', isAI: false, forwardWeaponId: 'machine_gun', rearWeaponId: null, forwardWeaponRange: 300 },
      { participantId: 1, displayName: 'P1', isAI: false, forwardWeaponId: null, rearWeaponId: null, forwardWeaponRange: null },
    ],
    waypointGraph: graph,
    weaponConfigs,
    lapCount: overrides?.lapCount ?? 2,
    seed: 12345,
  };
}

const ACCEL: CarInputs = { throttle: 1, brake: 0, steer: 0, fireForward: false, fireRear: false };
const IDLE: CarInputs = { throttle: 0, brake: 0, steer: 0, fireForward: false, fireRear: false };

/**
 * A two-AI config on a small loop: both cars navigate the waypoint graph so
 * they actually complete laps, letting the race finish on lap count. Neither
 * carries a weapon, so no elimination occurs — the race resolves by laps.
 */
function twoAiConfig(lapCount: number): RaceLoopConfig {
  const graph = squareGraph();
  const mkCar = (id: number, x: number, y: number): CarRaceState => ({
    participantId: id,
    physics: {
      id,
      position: { x, y },
      velocity: { x: 0, y: 0 },
      heading: 0,
      speed: 0,
      angularVelocity: 0,
      onTrack: true,
      airborne: false,
      airborneHeight: 0,
      airborneVY: 0,
    },
    currentArmor: 200,
    ammo: new Map<WeaponId, number>(),
    eliminated: false,
    lap: 1,
    placement: id + 1,
    waypointIndex: 0,
  });
  // Low top speed + high handling gives a turn radius that fits the 100-unit
  // square (turn radius ~= speed^2 * 100 / handling), so the AI can corner and
  // actually complete the loop within the step cap.
  const carStats = new Map<number, PhysicsCarStats>([
    [0, { topSpeed: 12, acceleration: 40, brake: 80, handling: 400, mass: 1000, armor: 200 }],
    [1, { topSpeed: 11, acceleration: 40, brake: 80, handling: 400, mass: 1000, armor: 200 }],
  ]);
  return {
    cars: [mkCar(0, 0, 0), mkCar(1, 10, 0)],
    carStats,
    participants: [
      {
        participantId: 0,
        displayName: 'A0',
        isAI: true,
        aiConfig: { character: 'sly', skillTier: 'expert', aggression: 3 },
        forwardWeaponId: null,
        rearWeaponId: null,
        forwardWeaponRange: null,
      },
      {
        participantId: 1,
        displayName: 'A1',
        isAI: true,
        aiConfig: { character: 'angel', skillTier: 'novice', aggression: 3 },
        forwardWeaponId: null,
        rearWeaponId: null,
        forwardWeaponRange: null,
      },
    ],
    waypointGraph: graph,
    weaponConfigs,
    lapCount,
    seed: 999,
  };
}

describe('RaceLoop', () => {
  it('is deterministic for a fixed seed', () => {
    const run = (): number[] => {
      const loop = new RaceLoop(twoCarConfig());
      for (let i = 0; i < 60; i++) {
        loop.step(new Map([[0, ACCEL], [1, IDLE]]));
      }
      const c = loop.getCar(0)!;
      return [c.physics.position.x, c.physics.position.y, c.physics.speed];
    };
    expect(run()).toEqual(run());
  });

  it('advances the accelerating car and increments the tick', () => {
    const loop = new RaceLoop(twoCarConfig());
    const startY = loop.getCar(0)!.physics.position.y;
    for (let i = 0; i < 120; i++) loop.step(new Map([[0, ACCEL], [1, IDLE]]));
    expect(loop.tick).toBe(120);
    // The car accelerated forward (heading 0 = +Y), so it moved.
    const movedDist = Math.hypot(
      loop.getCar(0)!.physics.position.x - 0,
      loop.getCar(0)!.physics.position.y - startY,
    );
    expect(movedDist).toBeGreaterThan(0);
  });

  it('finishes the race and produces one outcome per car, placements 1..N', () => {
    // Two AI cars navigate the square loop and complete their laps; the race
    // resolves by lap count (no weapons, so no elimination).
    const loop = new RaceLoop(twoAiConfig(1));
    let steps = 0;
    while (!loop.finished && steps < 6000) {
      loop.step(new Map());
      steps++;
    }
    expect(loop.finished).toBe(true);
    const outcomes = loop.outcomes();
    expect(outcomes).toHaveLength(2);
    expect(outcomes.map((o) => o.placement).sort()).toEqual([1, 2]);
    // Every car appears exactly once.
    expect(new Set(outcomes.map((o) => o.id)).size).toBe(2);
  });

  it('eliminated cars stay eliminated and the survivor wins', () => {
    // Car 0 fires at the fragile car 1 (armor 1) which sits within range ahead.
    const loop = new RaceLoop(twoCarConfig({ lapCount: 5 }));
    const FIRE: CarInputs = { throttle: 0, brake: 1, steer: 0, fireForward: true, fireRear: false };
    let steps = 0;
    while (!loop.finished && steps < 2000) {
      loop.step(new Map([[0, FIRE], [1, IDLE]]));
      steps++;
    }
    // The race ends once only one car remains (car 1 eliminated).
    expect(loop.finished).toBe(true);
    const car1 = loop.getCar(1)!;
    expect(car1.eliminated).toBe(true);
    const outcomes = loop.outcomes();
    const winner = outcomes.find((o) => o.placement === 1)!;
    expect(winner.id).toBe(0);
  });
});
