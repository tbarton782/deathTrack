/**
 * Unit and determinism tests for the base physics step {@link stepPhysics}.
 *
 * Covers the behaviours implemented in task 6.2:
 *   - throttle / brake speed ramp clamped to `[0, effectiveTopSpeed]` (Req 1.2, 1.3)
 *   - steering rate proportional to handling and inversely to speed (Req 1.4)
 *   - off-track traction penalty via SDF: halved handling + speed cap (Req 1.5)
 *   - deterministic, ParticipantId-sorted processing (Req 1.9)
 *   - car-pair collision resolution: impulse only above the 0.5 units/s
 *     closing-speed threshold, multi-collision decreasing-velocity ordering,
 *     momentum conservation, determinism (task 6.3; Req 1.6, 1.8)
 *   - jump ramp mechanics: launch on ramp contact, gravity arc across ticks,
 *     landing at surface level, determinism (task 6.4; Req 1.7)
 *   - pit-lane detection: enter/exit events, restoration signalled on enter and
 *     completed before exit, occupancy threading, determinism
 *     (task 6.5; Req 9.3, 9.4)
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { stepPhysics, FIXED_TIMESTEP, type PhysicsCarStats, type PhysicsWorldState } from '../stepPhysics.js';
import { mkRNG } from '../rng.js';
import type { CarInputs, CarPhysicsState } from '../../types/physics.js';
import type { ParticipantId } from '../../types/primitives.js';
import type { JumpRamp, PitLaneData } from '../../types/track.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCar(overrides: Partial<CarPhysicsState> = {}): CarPhysicsState {
  return {
    id: 0,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    heading: 0,
    speed: 0,
    angularVelocity: 0,
    onTrack: true,
    airborne: false,
    airborneHeight: 0,
    airborneVY: 0,
    ...overrides,
  };
}

function makeInputs(overrides: Partial<CarInputs> = {}): CarInputs {
  return {
    throttle: 0,
    brake: 0,
    steer: 0,
    fireForward: false,
    fireRear: false,
    ...overrides,
  };
}

const STATS: PhysicsCarStats = {
  topSpeed: 50,
  acceleration: 30,
  brake: 40,
  handling: 60,
};

function makeWorld(
  cars: CarPhysicsState[],
  extras: Partial<PhysicsWorldState> = {},
): PhysicsWorldState {
  return {
    cars,
    tick: 0,
    trackId: 'chicago',
    ...extras,
  };
}

// ---------------------------------------------------------------------------
// Speed ramp (Req 1.2, 1.3)
// ---------------------------------------------------------------------------

describe('stepPhysics — speed ramp', () => {
  it('accelerates proportionally to acceleration stat under full throttle', () => {
    const car = makeCar({ speed: 0 });
    const world = makeWorld([car], {
      carStats: new Map([[0, STATS]]),
    });
    const inputs = new Map<ParticipantId, CarInputs>([[0, makeInputs({ throttle: 1 })]]);

    const result = stepPhysics(world, inputs, FIXED_TIMESTEP, mkRNG(1));

    // Expected delta = acceleration * dt.
    expect(result.cars[0]!.speed).toBeCloseTo(STATS.acceleration * FIXED_TIMESTEP, 10);
  });

  it('never exceeds the configured top speed', () => {
    const car = makeCar({ speed: STATS.topSpeed - 0.001 });
    const world = makeWorld([car], { carStats: new Map([[0, STATS]]) });
    const inputs = new Map<ParticipantId, CarInputs>([[0, makeInputs({ throttle: 1 })]]);

    const result = stepPhysics(world, inputs, FIXED_TIMESTEP, mkRNG(1));

    expect(result.cars[0]!.speed).toBeLessThanOrEqual(STATS.topSpeed);
    expect(result.cars[0]!.speed).toBeCloseTo(STATS.topSpeed, 10);
  });

  it('never drops below zero under full brake', () => {
    const car = makeCar({ speed: 0.1 });
    const world = makeWorld([car], { carStats: new Map([[0, STATS]]) });
    const inputs = new Map<ParticipantId, CarInputs>([[0, makeInputs({ brake: 1 })]]);

    const result = stepPhysics(world, inputs, FIXED_TIMESTEP, mkRNG(1));

    expect(result.cars[0]!.speed).toBe(0);
  });

  it('brakes proportionally to the brake stat', () => {
    const startSpeed = 20;
    const car = makeCar({ speed: startSpeed });
    const world = makeWorld([car], { carStats: new Map([[0, STATS]]) });
    const inputs = new Map<ParticipantId, CarInputs>([[0, makeInputs({ brake: 1 })]]);

    const result = stepPhysics(world, inputs, FIXED_TIMESTEP, mkRNG(1));

    expect(result.cars[0]!.speed).toBeCloseTo(startSpeed - STATS.brake * FIXED_TIMESTEP, 10);
  });
});

// ---------------------------------------------------------------------------
// Steering (Req 1.4)
// ---------------------------------------------------------------------------

describe('stepPhysics — steering', () => {
  it('turn rate is inversely proportional to speed above 1 unit/s', () => {
    const slow = makeCar({ speed: 4, heading: 0 });
    const fast = makeCar({ speed: 8, heading: 0 });
    const inputs = new Map<ParticipantId, CarInputs>([[0, makeInputs({ steer: 1 })]]);

    const slowRes = stepPhysics(
      makeWorld([slow], { carStats: new Map([[0, STATS]]) }),
      inputs,
      FIXED_TIMESTEP,
      mkRNG(1),
    );
    const fastRes = stepPhysics(
      makeWorld([fast], { carStats: new Map([[0, STATS]]) }),
      inputs,
      FIXED_TIMESTEP,
      mkRNG(1),
    );

    // Doubling speed halves the angular velocity.
    expect(Math.abs(slowRes.cars[0]!.angularVelocity)).toBeCloseTo(
      Math.abs(fastRes.cars[0]!.angularVelocity) * 2,
      10,
    );
  });

  it('treats speeds at or below 1 unit/s as exactly 1 for turn rate', () => {
    const stationary = makeCar({ speed: 0, heading: 0 });
    const atOne = makeCar({ speed: 1, heading: 0 });
    const inputs = new Map<ParticipantId, CarInputs>([[0, makeInputs({ steer: 1 })]]);

    const stationaryRes = stepPhysics(
      makeWorld([stationary], { carStats: new Map([[0, STATS]]) }),
      inputs,
      FIXED_TIMESTEP,
      mkRNG(1),
    );
    const atOneRes = stepPhysics(
      makeWorld([atOne], { carStats: new Map([[0, STATS]]) }),
      inputs,
      FIXED_TIMESTEP,
      mkRNG(1),
    );

    // Both use the same effective steer speed of 1 -> identical angular velocity.
    expect(stationaryRes.cars[0]!.angularVelocity).toBeCloseTo(
      atOneRes.cars[0]!.angularVelocity,
      10,
    );
    // Angular velocity = steer * (handling/100) / 1.
    expect(atOneRes.cars[0]!.angularVelocity).toBeCloseTo(STATS.handling / 100, 10);
  });

  it('negative steer turns the opposite direction from positive steer', () => {
    const inputsLeft = new Map<ParticipantId, CarInputs>([[0, makeInputs({ steer: -1 })]]);
    const inputsRight = new Map<ParticipantId, CarInputs>([[0, makeInputs({ steer: 1 })]]);
    const car = makeCar({ speed: 10, heading: 0 });
    const world = makeWorld([car], { carStats: new Map([[0, STATS]]) });

    const left = stepPhysics(world, inputsLeft, FIXED_TIMESTEP, mkRNG(1));
    const right = stepPhysics(world, inputsRight, FIXED_TIMESTEP, mkRNG(1));

    expect(left.cars[0]!.angularVelocity).toBeCloseTo(-right.cars[0]!.angularVelocity, 10);
  });
});

// ---------------------------------------------------------------------------
// Off-track penalty via SDF (Req 1.5)
// ---------------------------------------------------------------------------

describe('stepPhysics — off-track traction penalty', () => {
  it('detects off-track via SDF and caps speed at 50% of top speed', () => {
    // SDF returns negative -> off the road surface.
    const world = makeWorld([makeCar({ speed: STATS.topSpeed, onTrack: true })], {
      carStats: new Map([[0, STATS]]),
      trackSDF: () => -1,
    });
    const inputs = new Map<ParticipantId, CarInputs>([[0, makeInputs({ throttle: 1 })]]);

    const result = stepPhysics(world, inputs, FIXED_TIMESTEP, mkRNG(1));

    expect(result.cars[0]!.onTrack).toBe(false);
    expect(result.cars[0]!.speed).toBeLessThanOrEqual(STATS.topSpeed * 0.5);
  });

  it('halves effective handling while off-track', () => {
    const car = makeCar({ speed: 10, heading: 0 });
    const inputs = new Map<ParticipantId, CarInputs>([[0, makeInputs({ steer: 1 })]]);

    const onTrackRes = stepPhysics(
      makeWorld([car], { carStats: new Map([[0, STATS]]), trackSDF: () => 1 }),
      inputs,
      FIXED_TIMESTEP,
      mkRNG(1),
    );
    const offTrackRes = stepPhysics(
      makeWorld([car], { carStats: new Map([[0, STATS]]), trackSDF: () => -1 }),
      inputs,
      FIXED_TIMESTEP,
      mkRNG(1),
    );

    expect(Math.abs(offTrackRes.cars[0]!.angularVelocity)).toBeCloseTo(
      Math.abs(onTrackRes.cars[0]!.angularVelocity) * 0.5,
      10,
    );
  });

  it('emits an off_track event on the transition from on to off track', () => {
    const world = makeWorld([makeCar({ onTrack: true })], {
      carStats: new Map([[0, STATS]]),
      trackSDF: () => -1,
    });
    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'off_track', participantId: 0 }),
    );
  });

  it('emits an on_track event when re-joining the road', () => {
    const world = makeWorld([makeCar({ onTrack: false })], {
      carStats: new Map([[0, STATS]]),
      trackSDF: () => 1,
    });
    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    expect(result.events).toContainEqual(
      expect.objectContaining({ type: 'on_track', participantId: 0 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Determinism & purity (Req 1.9)
// ---------------------------------------------------------------------------

describe('stepPhysics — determinism and purity', () => {
  it('processes cars in ParticipantId order regardless of array order', () => {
    const carsShuffled = [
      makeCar({ id: 2, position: { x: 2, y: 0 } }),
      makeCar({ id: 0, position: { x: 0, y: 0 } }),
      makeCar({ id: 1, position: { x: 1, y: 0 } }),
    ];
    const carStats = new Map<ParticipantId, PhysicsCarStats>([
      [0, STATS],
      [1, STATS],
      [2, STATS],
    ]);
    const world = makeWorld(carsShuffled, { carStats });
    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    // Output preserves the input array ordering (by id 2, 0, 1 here).
    expect(result.cars.map((c) => c.id)).toEqual([2, 0, 1]);
  });

  it('does not mutate the input state, cars, or inputs map', () => {
    const car = makeCar({ id: 0, speed: 5 });
    const carSnapshot = structuredClone(car);
    const world = makeWorld([car], { carStats: new Map([[0, STATS]]) });
    const inputs = new Map<ParticipantId, CarInputs>([[0, makeInputs({ throttle: 1 })]]);
    const inputSnapshot = structuredClone(inputs.get(0));

    stepPhysics(world, inputs, FIXED_TIMESTEP, mkRNG(1));

    expect(car).toEqual(carSnapshot);
    expect(inputs.get(0)).toEqual(inputSnapshot);
  });

  it('same state + inputs + seed produces identical results', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 2 ** 31 - 1 }), // seed
        fc.record({
          speed: fc.double({ min: 0, max: 50, noNaN: true }),
          heading: fc.double({ min: 0, max: Math.PI * 2, noNaN: true }),
          throttle: fc.double({ min: 0, max: 1, noNaN: true }),
          brake: fc.double({ min: 0, max: 1, noNaN: true }),
          steer: fc.double({ min: -1, max: 1, noNaN: true }),
        }),
        (seed, r) => {
          const car = makeCar({ id: 0, speed: r.speed, heading: r.heading });
          const world = makeWorld([car], { carStats: new Map([[0, STATS]]) });
          const inputs = new Map<ParticipantId, CarInputs>([
            [0, makeInputs({ throttle: r.throttle, brake: r.brake, steer: r.steer })],
          ]);

          const a = stepPhysics(world, inputs, FIXED_TIMESTEP, mkRNG(seed));
          const b = stepPhysics(world, inputs, FIXED_TIMESTEP, mkRNG(seed));

          expect(a).toEqual(b);
        },
      ),
    );
  });

  it('keeps speed within [0, effectiveTopSpeed] across many random ticks', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            throttle: fc.double({ min: 0, max: 1, noNaN: true }),
            brake: fc.double({ min: 0, max: 1, noNaN: true }),
            steer: fc.double({ min: -1, max: 1, noNaN: true }),
          }),
          { minLength: 1, maxLength: 120 },
        ),
        (frames) => {
          let car = makeCar({ id: 0, speed: 0 });
          const rng = mkRNG(42);
          for (const f of frames) {
            const world = makeWorld([car], { carStats: new Map([[0, STATS]]) });
            const inputs = new Map<ParticipantId, CarInputs>([
              [0, makeInputs({ throttle: f.throttle, brake: f.brake, steer: f.steer })],
            ]);
            car = stepPhysics(world, inputs, FIXED_TIMESTEP, rng).cars[0]!;
            expect(car.speed).toBeGreaterThanOrEqual(0);
            expect(car.speed).toBeLessThanOrEqual(STATS.topSpeed + 1e-9);
          }
        },
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Collision resolution (Req 1.6, 1.8)
// ---------------------------------------------------------------------------

/**
 * Stats with an explicit collision radius/mass so contact geometry is
 * predictable in these tests. Idle inputs everywhere so integration does not
 * move cars before the collision pass (speed 0 => no position change).
 */
const COLLIDE_STATS: PhysicsCarStats = {
  topSpeed: 100,
  acceleration: 0,
  brake: 0,
  handling: 0,
  mass: 1,
  collisionRadius: 1,
};

/** Total linear momentum (mass * velocity) summed over all cars. */
function totalMomentum(
  cars: ReadonlyArray<CarPhysicsState>,
  massById: Map<ParticipantId, number>,
): { x: number; y: number } {
  return cars.reduce(
    (acc, c) => {
      const m = massById.get(c.id)!;
      return { x: acc.x + m * c.velocity.x, y: acc.y + m * c.velocity.y };
    },
    { x: 0, y: 0 },
  );
}

describe('stepPhysics — collision resolution', () => {
  it('applies an impulse to head-on approaching cars overlapping their radii', () => {
    // Two unit-radius cars 1.5 units apart (overlap) closing head-on at 4 u/s.
    const left = makeCar({ id: 0, position: { x: 0, y: 0 }, velocity: { x: 2, y: 0 }, speed: 2, heading: Math.PI / 2 });
    const right = makeCar({ id: 1, position: { x: 1.5, y: 0 }, velocity: { x: -2, y: 0 }, speed: 2, heading: (3 * Math.PI) / 2 });
    const carStats = new Map<ParticipantId, PhysicsCarStats>([
      [0, COLLIDE_STATS],
      [1, COLLIDE_STATS],
    ]);
    const world = makeWorld([left, right], { carStats });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    // Both cars receive a collision event referencing the other.
    const collisions = result.events.filter((e) => e.type === 'collision');
    expect(collisions).toHaveLength(2);

    // Equal-mass head-on impact reverses the sign of the x-velocity component.
    expect(result.cars[0]!.velocity.x).toBeLessThan(0);
    expect(result.cars[1]!.velocity.x).toBeGreaterThan(0);
  });

  it('does NOT apply an impulse when closing speed is at/below 0.5 u/s', () => {
    // Overlapping but barely closing (0.4 u/s combined): below the threshold.
    const left = makeCar({ id: 0, position: { x: 0, y: 0 }, velocity: { x: 0.2, y: 0 }, speed: 0.2, heading: Math.PI / 2 });
    const right = makeCar({ id: 1, position: { x: 1.5, y: 0 }, velocity: { x: -0.2, y: 0 }, speed: 0.2, heading: (3 * Math.PI) / 2 });
    const carStats = new Map<ParticipantId, PhysicsCarStats>([
      [0, COLLIDE_STATS],
      [1, COLLIDE_STATS],
    ]);
    const world = makeWorld([left, right], { carStats });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    expect(result.events.filter((e) => e.type === 'collision')).toHaveLength(0);
    // Velocities are unchanged (no impulse applied).
    expect(result.cars[0]!.velocity.x).toBeCloseTo(0.2, 10);
    expect(result.cars[1]!.velocity.x).toBeCloseTo(-0.2, 10);
  });

  it('applies an impulse just above the 0.5 u/s threshold', () => {
    // Combined closing speed 0.6 u/s (0.3 each) > 0.5 threshold.
    const left = makeCar({ id: 0, position: { x: 0, y: 0 }, velocity: { x: 0.3, y: 0 }, speed: 0.3, heading: Math.PI / 2 });
    const right = makeCar({ id: 1, position: { x: 1.5, y: 0 }, velocity: { x: -0.3, y: 0 }, speed: 0.3, heading: (3 * Math.PI) / 2 });
    const carStats = new Map<ParticipantId, PhysicsCarStats>([
      [0, COLLIDE_STATS],
      [1, COLLIDE_STATS],
    ]);
    const world = makeWorld([left, right], { carStats });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    expect(result.events.filter((e) => e.type === 'collision')).toHaveLength(2);
  });

  it('does not apply an impulse to separating (moving apart) cars', () => {
    // Overlapping but moving apart: closing speed is negative.
    const left = makeCar({ id: 0, position: { x: 0, y: 0 }, velocity: { x: -5, y: 0 }, speed: 5, heading: (3 * Math.PI) / 2 });
    const right = makeCar({ id: 1, position: { x: 1.5, y: 0 }, velocity: { x: 5, y: 0 }, speed: 5, heading: Math.PI / 2 });
    const carStats = new Map<ParticipantId, PhysicsCarStats>([
      [0, COLLIDE_STATS],
      [1, COLLIDE_STATS],
    ]);
    const world = makeWorld([left, right], { carStats });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    expect(result.events.filter((e) => e.type === 'collision')).toHaveLength(0);
  });

  it('does not collide cars whose circles do not overlap', () => {
    const left = makeCar({ id: 0, position: { x: 0, y: 0 }, velocity: { x: 5, y: 0 }, speed: 5, heading: Math.PI / 2 });
    const right = makeCar({ id: 1, position: { x: 10, y: 0 }, velocity: { x: -5, y: 0 }, speed: 5, heading: (3 * Math.PI) / 2 });
    const carStats = new Map<ParticipantId, PhysicsCarStats>([
      [0, COLLIDE_STATS],
      [1, COLLIDE_STATS],
    ]);
    const world = makeWorld([left, right], { carStats });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    expect(result.events.filter((e) => e.type === 'collision')).toHaveLength(0);
  });

  it('conserves total linear momentum across an impact (within 1%)', () => {
    // Unequal masses so the conservation check is non-trivial.
    const heavy: PhysicsCarStats = { ...COLLIDE_STATS, mass: 3 };
    const light: PhysicsCarStats = { ...COLLIDE_STATS, mass: 1 };
    const a = makeCar({ id: 0, position: { x: 0, y: 0 }, velocity: { x: 6, y: 1 }, speed: Math.hypot(6, 1), heading: Math.atan2(6, 1) });
    const b = makeCar({ id: 1, position: { x: 1.5, y: 0 }, velocity: { x: -2, y: -1 }, speed: Math.hypot(2, 1), heading: Math.atan2(-2, -1) });
    const carStats = new Map<ParticipantId, PhysicsCarStats>([
      [0, heavy],
      [1, light],
    ]);
    const massById = new Map<ParticipantId, number>([[0, 3], [1, 1]]);
    const world = makeWorld([a, b], { carStats });

    const before = totalMomentum(world.cars, massById);
    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));
    const after = totalMomentum(result.cars, massById);

    // Momentum should be preserved to within 1% of the pre-impact magnitude.
    const beforeMag = Math.hypot(before.x, before.y);
    expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(beforeMag * 0.01 + 1e-9);
    expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(beforeMag * 0.01 + 1e-9);
    // A collision actually happened.
    expect(result.events.filter((e) => e.type === 'collision')).toHaveLength(2);
  });

  it('resolves multiple collisions on the same car in decreasing relative-velocity order', () => {
    // Middle car (id 1) is struck from the left (slow, 3 u/s) and the right
    // (fast, 9 u/s). The right impact has the higher closing speed and must be
    // resolved first, so it appears earlier in the event list.
    const leftCar = makeCar({ id: 0, position: { x: -1.5, y: 0 }, velocity: { x: 3, y: 0 }, speed: 3, heading: Math.PI / 2 });
    const midCar = makeCar({ id: 1, position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, speed: 0, heading: 0 });
    const rightCar = makeCar({ id: 2, position: { x: 1.5, y: 0 }, velocity: { x: -9, y: 0 }, speed: 9, heading: (3 * Math.PI) / 2 });
    const carStats = new Map<ParticipantId, PhysicsCarStats>([
      [0, COLLIDE_STATS],
      [1, COLLIDE_STATS],
      [2, COLLIDE_STATS],
    ]);
    const world = makeWorld([leftCar, midCar, rightCar], { carStats });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    const collisions = result.events.filter(
      (e): e is Extract<typeof e, { type: 'collision' }> => e.type === 'collision',
    );
    // Two pairs => four mirrored events.
    expect(collisions).toHaveLength(4);

    // The first collision event resolved involves the fast (1<->2) pair, which
    // has the higher relative speed (~9 vs ~3).
    const firstPairIds = [collisions[0]!.participantId, collisions[0]!.otherParticipantId].sort();
    expect(firstPairIds).toEqual([1, 2]);
    // The highest-relative-speed event must come before the lower one.
    expect(collisions[0]!.relativeSpeed).toBeGreaterThan(collisions[2]!.relativeSpeed);
  });

  it('is deterministic: same colliding world + seed yields identical results', () => {
    const a = makeCar({ id: 0, position: { x: 0, y: 0 }, velocity: { x: 4, y: 2 }, speed: Math.hypot(4, 2), heading: Math.atan2(4, 2) });
    const b = makeCar({ id: 1, position: { x: 1.2, y: 0.3 }, velocity: { x: -3, y: 1 }, speed: Math.hypot(3, 1), heading: Math.atan2(-3, 1) });
    const carStats = new Map<ParticipantId, PhysicsCarStats>([
      [0, COLLIDE_STATS],
      [1, COLLIDE_STATS],
    ]);
    const world = makeWorld([a, b], { carStats });

    const r1 = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(7));
    const r2 = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(7));

    expect(r1).toEqual(r2);
  });

  it('collision ordering is independent of the input array order', () => {
    const mkWorld = (cars: CarPhysicsState[]) =>
      makeWorld(cars, {
        carStats: new Map<ParticipantId, PhysicsCarStats>([
          [0, COLLIDE_STATS],
          [1, COLLIDE_STATS],
          [2, COLLIDE_STATS],
        ]),
      });
    const leftCar = makeCar({ id: 0, position: { x: -1.5, y: 0 }, velocity: { x: 3, y: 0 }, speed: 3, heading: Math.PI / 2 });
    const midCar = makeCar({ id: 1, position: { x: 0, y: 0 }, velocity: { x: 0, y: 0 }, speed: 0, heading: 0 });
    const rightCar = makeCar({ id: 2, position: { x: 1.5, y: 0 }, velocity: { x: -9, y: 0 }, speed: 9, heading: (3 * Math.PI) / 2 });

    const inOrder = stepPhysics(mkWorld([leftCar, midCar, rightCar]), new Map(), FIXED_TIMESTEP, mkRNG(1));
    const shuffled = stepPhysics(mkWorld([rightCar, leftCar, midCar]), new Map(), FIXED_TIMESTEP, mkRNG(1));

    const byId = (r: typeof inOrder) =>
      [...r.cars].sort((x, y) => x.id - y.id).map((c) => ({ id: c.id, vx: c.velocity.x, vy: c.velocity.y }));

    expect(byId(inOrder)).toEqual(byId(shuffled));
  });
});

// ---------------------------------------------------------------------------
// Jump ramp mechanics (Req 1.7)
// ---------------------------------------------------------------------------

/**
 * Stats with no acceleration/brake and no handling so a jumping car's ground
 * speed and heading are stable across ticks — this isolates the vertical
 * (airborne) integration under test.
 */
const JUMP_STATS: PhysicsCarStats = {
  topSpeed: 100,
  acceleration: 0,
  brake: 0,
  handling: 0,
};

/** A ramp at the origin with a 45° launch angle and unit multiplier. */
const RAMP_AT_ORIGIN: JumpRamp = {
  position: { x: 0, y: 0 },
  angle: 45,
  launchMultiplier: 1,
};

/** Extract only jump events for concise assertions. */
function jumpEvents(events: ReadonlyArray<{ type: string }>) {
  return events.filter((e) => e.type === 'jump_launch' || e.type === 'jump_land');
}

describe('stepPhysics — jump ramp mechanics', () => {
  it('launches a grounded car airborne on ramp contact', () => {
    // Car sitting on the ramp, moving north at 20 u/s.
    const car = makeCar({ id: 0, position: { x: 0, y: 0 }, speed: 20, heading: 0 });
    const world = makeWorld([car], {
      carStats: new Map([[0, JUMP_STATS]]),
      jumpRamps: [RAMP_AT_ORIGIN],
    });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    expect(result.cars[0]!.airborne).toBe(true);
    expect(result.cars[0]!.airborneVY).toBeGreaterThan(0);
    // launchVY = speed * sin(45°) * multiplier = 20 * (√2/2) * 1.
    expect(result.cars[0]!.airborneVY).toBeCloseTo(20 * Math.sin(Math.PI / 4), 10);

    const launches = result.events.filter((e) => e.type === 'jump_launch');
    expect(launches).toHaveLength(1);
    expect(launches[0]).toMatchObject({ participantId: 0 });
  });

  it('does not launch a car nowhere near a ramp', () => {
    const car = makeCar({ id: 0, position: { x: 500, y: 500 }, speed: 20, heading: 0 });
    const world = makeWorld([car], {
      carStats: new Map([[0, JUMP_STATS]]),
      jumpRamps: [RAMP_AT_ORIGIN],
    });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    expect(result.cars[0]!.airborne).toBe(false);
    expect(jumpEvents(result.events)).toHaveLength(0);
  });

  it('does not launch a stationary car even on a ramp', () => {
    const car = makeCar({ id: 0, position: { x: 0, y: 0 }, speed: 0, heading: 0 });
    const world = makeWorld([car], {
      carStats: new Map([[0, JUMP_STATS]]),
      jumpRamps: [RAMP_AT_ORIGIN],
    });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    expect(result.cars[0]!.airborne).toBe(false);
    expect(jumpEvents(result.events)).toHaveLength(0);
  });

  it('applies gravity each tick: height rises then falls to a landing', () => {
    // Launch, then step with no ramp present and idle inputs until landing.
    let car = makeCar({ id: 0, position: { x: 0, y: 0 }, speed: 20, heading: 0 });
    const rng = mkRNG(1);

    // Tick 1: launch on the ramp.
    let res = stepPhysics(
      makeWorld([car], { carStats: new Map([[0, JUMP_STATS]]), jumpRamps: [RAMP_AT_ORIGIN] }),
      new Map(),
      FIXED_TIMESTEP,
      rng,
    );
    car = res.cars[0]!;
    expect(car.airborne).toBe(true);

    const heights: number[] = [];
    const velocities: number[] = [];
    let landed = false;
    let landingSpeed = -1;

    // Continue the arc without any ramp so it cannot re-launch.
    for (let i = 0; i < 200 && !landed; i++) {
      res = stepPhysics(
        makeWorld([car], { carStats: new Map([[0, JUMP_STATS]]) }),
        new Map(),
        FIXED_TIMESTEP,
        rng,
      );
      car = res.cars[0]!;
      const land = res.events.find((e) => e.type === 'jump_land');
      if (land) {
        landed = true;
        landingSpeed = (land as { landingSpeed: number }).landingSpeed;
      } else {
        heights.push(car.airborneHeight);
        velocities.push(car.airborneVY);
      }
    }

    // The car eventually lands and clears its airborne state.
    expect(landed).toBe(true);
    expect(car.airborne).toBe(false);
    expect(car.airborneHeight).toBe(0);
    expect(car.airborneVY).toBe(0);
    // Landing speed equals the (unchanged) ground speed.
    expect(landingSpeed).toBeCloseTo(20, 10);

    // Height rose above 0 at some point (the car actually went up).
    expect(Math.max(...heights)).toBeGreaterThan(0);
    // Vertical velocity strictly decreases under constant gravity.
    for (let i = 1; i < velocities.length; i++) {
      expect(velocities[i]!).toBeLessThan(velocities[i - 1]!);
    }
  });

  it('does not re-launch a car that is already airborne over a ramp', () => {
    // A car mid-jump sitting over the ramp must not be re-triggered.
    const car = makeCar({
      id: 0,
      position: { x: 0, y: 0 },
      speed: 20,
      heading: 0,
      airborne: true,
      airborneHeight: 5,
      airborneVY: 10,
    });
    const world = makeWorld([car], {
      carStats: new Map([[0, JUMP_STATS]]),
      jumpRamps: [RAMP_AT_ORIGIN],
    });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    // Still airborne, but no new launch event; vy decreased by gravity.
    expect(result.cars[0]!.airborne).toBe(true);
    expect(result.events.filter((e) => e.type === 'jump_launch')).toHaveLength(0);
    expect(result.cars[0]!.airborneVY).toBeLessThan(10);
  });

  it('is deterministic across a full jump arc for the same seed', () => {
    const car = makeCar({ id: 0, position: { x: 0, y: 0 }, speed: 25, heading: 0 });
    const ramps = [RAMP_AT_ORIGIN];

    const runArc = (seed: number) => {
      let c = car;
      const rng = mkRNG(seed);
      const snapshots: CarPhysicsState[] = [];
      // First tick launches; subsequent ticks have no ramp.
      let r = stepPhysics(
        makeWorld([c], { carStats: new Map([[0, JUMP_STATS]]), jumpRamps: ramps }),
        new Map(),
        FIXED_TIMESTEP,
        rng,
      );
      c = r.cars[0]!;
      snapshots.push(c);
      for (let i = 0; i < 60; i++) {
        r = stepPhysics(
          makeWorld([c], { carStats: new Map([[0, JUMP_STATS]]) }),
          new Map(),
          FIXED_TIMESTEP,
          rng,
        );
        c = r.cars[0]!;
        snapshots.push(c);
      }
      return snapshots;
    };

    expect(runArc(99)).toEqual(runArc(99));
  });

  it('leaves airborne fields untouched when no ramps are supplied', () => {
    const car = makeCar({ id: 0, position: { x: 0, y: 0 }, speed: 20, heading: 0 });
    const world = makeWorld([car], { carStats: new Map([[0, JUMP_STATS]]) });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    expect(result.cars[0]!.airborne).toBe(false);
    expect(result.cars[0]!.airborneHeight).toBe(0);
    expect(jumpEvents(result.events)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Pit-lane detection & restoration signalling (Req 9.3, 9.4)
// ---------------------------------------------------------------------------

/**
 * Stats with no acceleration/brake/handling so a car's position only changes
 * from its own velocity — this keeps pit-lane trigger geometry predictable.
 * `armor` is the configured maximum reported by the restoration events.
 */
const PIT_STATS: PhysicsCarStats = {
  topSpeed: 100,
  acceleration: 0,
  brake: 0,
  handling: 0,
  armor: 150,
};

/** A pit lane with entry at the origin and exit 10 units north. */
const PIT_LANE: PitLaneData = {
  entryPosition: { x: 0, y: 0 },
  exitPosition: { x: 0, y: 10 },
  path: [
    { x: 0, y: 0 },
    { x: 0, y: 5 },
    { x: 0, y: 10 },
  ],
};

/** Narrow a PhysicsEvent to a pit-lane variant for concise assertions. */
type PitEnter = Extract<
  ReturnType<typeof stepPhysics>['events'][number],
  { type: 'pit_lane_enter' }
>;
type PitExit = Extract<
  ReturnType<typeof stepPhysics>['events'][number],
  { type: 'pit_lane_exit' }
>;

describe('stepPhysics — pit-lane detection', () => {
  it('emits pit_lane_enter carrying maxArmor when a car reaches the entry point', () => {
    // Stationary car sitting on the entry point, not yet an occupant.
    const car = makeCar({ id: 0, position: { x: 0, y: 0 }, speed: 0 });
    const world = makeWorld([car], {
      carStats: new Map([[0, PIT_STATS]]),
      pitLane: PIT_LANE,
      pitLaneOccupants: [],
    });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    const enters = result.events.filter((e): e is PitEnter => e.type === 'pit_lane_enter');
    expect(enters).toHaveLength(1);
    expect(enters[0]).toMatchObject({ participantId: 0, maxArmor: 150 });
    // No exit in the same tick.
    expect(result.events.filter((e) => e.type === 'pit_lane_exit')).toHaveLength(0);
  });

  it('does not emit any pit-lane event with no pit lane geometry supplied', () => {
    const car = makeCar({ id: 0, position: { x: 0, y: 0 }, speed: 0 });
    const world = makeWorld([car], { carStats: new Map([[0, PIT_STATS]]) });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    expect(
      result.events.filter((e) => e.type === 'pit_lane_enter' || e.type === 'pit_lane_exit'),
    ).toHaveLength(0);
  });

  it('does not emit an enter event for a car far from the entry point', () => {
    const car = makeCar({ id: 0, position: { x: 500, y: 500 }, speed: 0 });
    const world = makeWorld([car], {
      carStats: new Map([[0, PIT_STATS]]),
      pitLane: PIT_LANE,
      pitLaneOccupants: [],
    });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    expect(result.events.filter((e) => e.type === 'pit_lane_enter')).toHaveLength(0);
  });

  it('does not re-emit enter while a car is already an occupant near the entry', () => {
    // Car is already inside the pit lane and still near the entry point.
    const car = makeCar({ id: 0, position: { x: 0, y: 0.5 }, speed: 0 });
    const world = makeWorld([car], {
      carStats: new Map([[0, PIT_STATS]]),
      pitLane: PIT_LANE,
      pitLaneOccupants: [0],
    });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    expect(result.events.filter((e) => e.type === 'pit_lane_enter')).toHaveLength(0);
  });

  it('emits pit_lane_exit carrying restoredArmor == maxArmor when an occupant reaches the exit', () => {
    // An occupant sitting on the exit point.
    const car = makeCar({ id: 0, position: { x: 0, y: 10 }, speed: 0 });
    const world = makeWorld([car], {
      carStats: new Map([[0, PIT_STATS]]),
      pitLane: PIT_LANE,
      pitLaneOccupants: [0],
    });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    const exits = result.events.filter((e): e is PitExit => e.type === 'pit_lane_exit');
    expect(exits).toHaveLength(1);
    expect(exits[0]).toMatchObject({ participantId: 0, restoredArmor: 150 });
  });

  it('does not emit exit for a non-occupant sitting on the exit point', () => {
    // A car that never entered cannot exit, even if it is on the exit point.
    const car = makeCar({ id: 0, position: { x: 0, y: 10 }, speed: 0 });
    const world = makeWorld([car], {
      carStats: new Map([[0, PIT_STATS]]),
      pitLane: PIT_LANE,
      pitLaneOccupants: [],
    });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    expect(result.events.filter((e) => e.type === 'pit_lane_exit')).toHaveLength(0);
  });

  it('a car cannot enter and exit in the same tick (restoration precedes exit)', () => {
    // Degenerate pit lane where entry and exit coincide: a fresh (non-occupant)
    // car reaching that point enters this tick but must NOT also exit — exit is
    // only considered for cars that were occupants at the start of the tick.
    const coincident: PitLaneData = {
      entryPosition: { x: 0, y: 0 },
      exitPosition: { x: 0, y: 0 },
      path: [{ x: 0, y: 0 }],
    };
    const car = makeCar({ id: 0, position: { x: 0, y: 0 }, speed: 0 });
    const world = makeWorld([car], {
      carStats: new Map([[0, PIT_STATS]]),
      pitLane: coincident,
      pitLaneOccupants: [],
    });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    expect(result.events.filter((e) => e.type === 'pit_lane_enter')).toHaveLength(1);
    expect(result.events.filter((e) => e.type === 'pit_lane_exit')).toHaveLength(0);
  });

  it('full visit across ticks: enter fires once, exit fires only after re-entering occupancy', () => {
    // The authority loop threads occupancy: on seeing pit_lane_enter it adds
    // the car to pitLaneOccupants for the next tick (and applies armor/ammo
    // restoration). Here we drive a car north through entry -> exit and assert
    // enter precedes exit, exit never precedes restoration.
    let car = makeCar({ id: 0, position: { x: 0, y: -0.5 }, velocity: { x: 0, y: 60 }, speed: 60, heading: 0 });
    const rng = mkRNG(1);
    let occupants: ParticipantId[] = [];
    let sawEnter = false;
    let sawExit = false;
    let enterBeforeExit = true;

    for (let i = 0; i < 60 && !sawExit; i++) {
      const world = makeWorld([car], {
        carStats: new Map([[0, PIT_STATS]]),
        pitLane: PIT_LANE,
        pitLaneOccupants: occupants,
      });
      const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, rng);
      car = result.cars[0]!;

      // Emulate the authority loop's occupancy bookkeeping from the events.
      for (const ev of result.events) {
        if (ev.type === 'pit_lane_enter') {
          sawEnter = true;
          if (!occupants.includes(ev.participantId)) occupants = [...occupants, ev.participantId];
        } else if (ev.type === 'pit_lane_exit') {
          if (!sawEnter) enterBeforeExit = false;
          sawExit = true;
          occupants = occupants.filter((id) => id !== ev.participantId);
        }
      }
    }

    expect(sawEnter).toBe(true);
    expect(sawExit).toBe(true);
    expect(enterBeforeExit).toBe(true);
    // After exiting, occupancy is cleared.
    expect(occupants).toEqual([]);
  });

  it('reports restoredArmor equal to configured maxArmor regardless of prior armor (Req 9.4 intent)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 200 }), (maxArmor) => {
        const stats: PhysicsCarStats = { ...PIT_STATS, armor: maxArmor };
        const car = makeCar({ id: 0, position: { x: 0, y: 10 }, speed: 0 });
        const world = makeWorld([car], {
          carStats: new Map([[0, stats]]),
          pitLane: PIT_LANE,
          pitLaneOccupants: [0],
        });

        const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));
        const exit = result.events.find((e): e is PitExit => e.type === 'pit_lane_exit');

        expect(exit).toBeDefined();
        // Restored armor equals the configured maximum, independent of any
        // prior armor value (which the physics step does not even carry).
        expect(exit!.restoredArmor).toBe(maxArmor);
      }),
    );
  });

  it('falls back to a default maxArmor when stats omit armor', () => {
    const statsNoArmor: PhysicsCarStats = { topSpeed: 100, acceleration: 0, brake: 0, handling: 0 };
    const car = makeCar({ id: 0, position: { x: 0, y: 0 }, speed: 0 });
    const world = makeWorld([car], {
      carStats: new Map([[0, statsNoArmor]]),
      pitLane: PIT_LANE,
      pitLaneOccupants: [],
    });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));
    const enter = result.events.find((e): e is PitEnter => e.type === 'pit_lane_enter');

    expect(enter).toBeDefined();
    expect(enter!.maxArmor).toBe(100);
  });

  it('processes pit-lane transitions in ParticipantId order for multiple cars', () => {
    const carsShuffled = [
      makeCar({ id: 2, position: { x: 0, y: 0 }, speed: 0 }),
      makeCar({ id: 0, position: { x: 0, y: 0 }, speed: 0 }),
      makeCar({ id: 1, position: { x: 0, y: 0 }, speed: 0 }),
    ];
    const carStats = new Map<ParticipantId, PhysicsCarStats>([
      [0, PIT_STATS],
      [1, PIT_STATS],
      [2, PIT_STATS],
    ]);
    const world = makeWorld(carsShuffled, {
      carStats,
      pitLane: PIT_LANE,
      pitLaneOccupants: [],
    });

    const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    const enterIds = result.events
      .filter((e): e is PitEnter => e.type === 'pit_lane_enter')
      .map((e) => e.participantId);
    expect(enterIds).toEqual([0, 1, 2]);
  });

  it('is deterministic: same world + seed yields identical pit-lane events', () => {
    const car = makeCar({ id: 0, position: { x: 0, y: 10 }, speed: 0 });
    const mk = () =>
      makeWorld([car], {
        carStats: new Map([[0, PIT_STATS]]),
        pitLane: PIT_LANE,
        pitLaneOccupants: [0],
      });

    const r1 = stepPhysics(mk(), new Map(), FIXED_TIMESTEP, mkRNG(7));
    const r2 = stepPhysics(mk(), new Map(), FIXED_TIMESTEP, mkRNG(7));

    expect(r1).toEqual(r2);
  });

  it('does not mutate the incoming pitLaneOccupants array', () => {
    const car = makeCar({ id: 0, position: { x: 0, y: 10 }, speed: 0 });
    const occupants: ParticipantId[] = [0];
    const snapshot = [...occupants];
    const world = makeWorld([car], {
      carStats: new Map([[0, PIT_STATS]]),
      pitLane: PIT_LANE,
      pitLaneOccupants: occupants,
    });

    stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));

    expect(occupants).toEqual(snapshot);
  });
});
