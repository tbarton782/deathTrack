/**
 * Property-based test for collision momentum conservation.
 *
 * Feature: deathtrack-multiplayer
 *
 * Property 4: Collision momentum is approximately conserved.
 *
 *   For any pair (or cluster) of car states that collide with relative velocity
 *   greater than 0.5 units/second, the vector sum of linear momentum
 *   (mass * velocity) across all cars immediately after the impulse resolution
 *   is within 1% of the sum immediately before.
 *
 * The collision pass in `stepPhysics` resolves each car-pair contact with an
 * equal-and-opposite impulse `j*n` (subtracted from A, added to B) and a
 * restitution of 0.4. Because restitution never adds net momentum, total linear
 * momentum is conserved exactly by the math; this property guards that
 * invariant across arbitrary overlapping, closing configurations and masses.
 *
 * A momentum-conservation assertion is trivially satisfied when no collision
 * occurs, so the generators below are constructed so cars genuinely overlap and
 * close above the 0.5 u/s threshold — every generated case is asserted to
 * actually produce collision events before the conservation check is trusted.
 *
 * **Validates: Requirements 1.6**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  stepPhysics,
  FIXED_TIMESTEP,
  type PhysicsCarStats,
  type PhysicsWorldState,
} from '../stepPhysics.js';
import { mkRNG } from '../rng.js';
import type { CarPhysicsState } from '../../types/physics.js';
import type { ParticipantId } from '../../types/primitives.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Base collision stats: no acceleration/brake/handling and idle inputs, so the
 * per-car integration pass leaves position/velocity untouched before the
 * collision pass runs. This isolates the impulse resolution under test. `mass`
 * and `collisionRadius` are overridden per car by the generators.
 */
function collideStats(mass: number, radius: number): PhysicsCarStats {
  return {
    topSpeed: 1000,
    acceleration: 0,
    brake: 0,
    handling: 0,
    mass,
    collisionRadius: radius,
  };
}

/** Total linear momentum (mass * velocity) summed over all cars. */
function totalMomentum(
  cars: ReadonlyArray<CarPhysicsState>,
  massById: ReadonlyMap<ParticipantId, number>,
): { x: number; y: number } {
  return cars.reduce(
    (acc, c) => {
      const m = massById.get(c.id)!;
      return { x: acc.x + m * c.velocity.x, y: acc.y + m * c.velocity.y };
    },
    { x: 0, y: 0 },
  );
}

function makeCar(
  id: ParticipantId,
  position: { x: number; y: number },
  velocity: { x: number; y: number },
): CarPhysicsState {
  return {
    id,
    position,
    velocity,
    heading: Math.atan2(velocity.x, velocity.y),
    speed: Math.hypot(velocity.x, velocity.y),
    angularVelocity: 0,
    onTrack: true,
    airborne: false,
    airborneHeight: 0,
    airborneVY: 0,
  };
}

function makeWorld(cars: CarPhysicsState[], carStats: Map<ParticipantId, PhysicsCarStats>): PhysicsWorldState {
  return { cars, tick: 0, trackId: 'chicago', carStats };
}

// The conservation tolerance from Property 4: within 1% of the pre-impact
// magnitude, plus a small absolute epsilon so near-zero total-momentum cases
// (e.g. symmetric head-on impacts) do not fail on floating-point noise.
const REL_TOLERANCE = 0.01;
const ABS_EPSILON = 1e-6;

function expectMomentumConserved(
  before: { x: number; y: number },
  after: { x: number; y: number },
): void {
  const beforeMag = Math.hypot(before.x, before.y);
  const allowance = beforeMag * REL_TOLERANCE + ABS_EPSILON;
  expect(Math.abs(after.x - before.x)).toBeLessThanOrEqual(allowance);
  expect(Math.abs(after.y - before.y)).toBeLessThanOrEqual(allowance);
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

const arbMass = fc.double({ min: 0.2, max: 10, noNaN: true });
const arbRadius = fc.double({ min: 0.5, max: 3, noNaN: true });
// A shared world drift applied to every car in a scenario. Because it is common
// to all cars it changes total momentum but never the *relative* velocities, so
// it neither creates nor prevents any collision — it just makes the conservation
// check non-trivial (the frame is not the centre-of-momentum frame).
const arbDrift = fc.double({ min: -20, max: 20, noNaN: true });

/**
 * The collision pass in `stepPhysics` runs on the positions *after* the
 * per-car integration step advances each car by `velocity * dt`. Over one
 * 1/60 s tick a car moving at up to ~50 u/s travels under ~0.85 units. The
 * generators below therefore work in terms of a small *relative* closing
 * velocity plus a *shared drift*: the drift is common to both cars so it cannot
 * separate them, and the deep initial overlap guarantees the pair is still
 * overlapping (and still closing) when the collision pass runs. This keeps
 * "a real collision happens" true for every generated case without depending on
 * the integrated geometry.
 */

/**
 * A colliding PAIR. Two cars overlap deeply along the x-axis. Their relative
 * velocity along that axis is a positive closing speed comfortably above the
 * 0.5 u/s threshold; a shared drift (common vx/vy) is layered on so the total
 * momentum is generally non-zero and the conservation assertion is meaningful.
 * The relative velocity — the only thing that governs the impulse and the
 * closing test — is preserved regardless of the drift.
 *
 * The closing speed is expressed as a fraction of `separation / dt` and capped
 * so that over one integration tick the two centres approach by at most ~70% of
 * their initial separation. This keeps the pair clearly separated (never
 * converging onto the same point) after integration, so the contact normal
 * stays well-conditioned along the x-axis and the closing test is unambiguous.
 */
const arbCollidingPair = fc
  .record({
    massA: arbMass,
    massB: arbMass,
    radiusA: arbRadius,
    radiusB: arbRadius,
    // Deep overlap (30%..60% of summed radii) so one integration tick cannot
    // separate the pair before the collision pass runs.
    overlapFrac: fc.double({ min: 0.3, max: 0.6, noNaN: true }),
    // Fraction of the "close completely in one tick" speed to use as the actual
    // closing speed. Kept in [0.2, 0.7] so the centres neither converge onto the
    // same point nor barely move.
    closeFrac: fc.double({ min: 0.2, max: 0.7, noNaN: true }),
    driftX: arbDrift,
    driftY: arbDrift,
  })
  .map((r) => {
    const separation = (r.radiusA + r.radiusB) * r.overlapFrac;
    // Speed that would exactly close the whole separation in one tick.
    const closeSpeedFull = separation / FIXED_TIMESTEP;
    // Actual relative closing speed: a fraction of that, floored above the
    // 0.5 u/s threshold so a collision is always registered.
    const closingSpeed = Math.max(closeSpeedFull * r.closeFrac, 2);
    // Split the relative closing speed symmetrically as inward velocities, then
    // add the shared drift to both cars.
    const half = closingSpeed / 2;
    const a = makeCar(0, { x: 0, y: 0 }, { x: r.driftX + half, y: r.driftY });
    const b = makeCar(1, { x: separation, y: 0 }, { x: r.driftX - half, y: r.driftY });
    const carStats = new Map<ParticipantId, PhysicsCarStats>([
      [0, collideStats(r.massA, r.radiusA)],
      [1, collideStats(r.massB, r.radiusB)],
    ]);
    return { cars: [a, b], carStats };
  });

/**
 * A colliding CLUSTER of N cars strung along the x-axis, each deeply
 * overlapping its neighbour, with alternating inward velocities so several
 * pairs close above the threshold in the same tick. A shared drift is layered
 * on every car. This exercises the multi-collision resolution path
 * (hardest-first) while still requiring total momentum to be conserved across
 * the whole cluster.
 */
const arbCollidingCluster = fc
  .record({
    count: fc.integer({ min: 3, max: 6 }),
    mass: fc.array(arbMass, { minLength: 6, maxLength: 6 }),
    radius: fc.array(arbRadius, { minLength: 6, maxLength: 6 }),
    speed: fc.array(fc.double({ min: 1, max: 10, noNaN: true }), { minLength: 6, maxLength: 6 }),
    driftX: arbDrift,
    driftY: arbDrift,
  })
  .map((r) => {
    const cars: CarPhysicsState[] = [];
    const carStats = new Map<ParticipantId, PhysicsCarStats>();
    let x = 0;
    for (let i = 0; i < r.count; i++) {
      const radius = r.radius[i]!;
      const mass = r.mass[i]!;
      // Alternate the along-axis velocity direction so neighbours close on each
      // other: even-index cars move +x, odd-index cars move -x. Adjacent cars
      // therefore always have a positive combined closing speed >= 2 u/s. The
      // shared drift is added to every car so relative velocities are unchanged.
      const dir = i % 2 === 0 ? 1 : -1;
      const vx = r.driftX + dir * r.speed[i]!;
      cars.push(makeCar(i, { x, y: 0 }, { x: vx, y: r.driftY }));
      carStats.set(i, collideStats(mass, radius));
      // Advance x so the next car deeply overlaps this one (35% of summed
      // radii) — well inside the sum so integration cannot separate neighbours.
      const nextRadius = r.radius[i + 1] ?? radius;
      x += (radius + nextRadius) * 0.35;
    }
    return { cars, carStats };
  });

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('stepPhysics — Property 4: collision momentum conservation (Req 1.6)', () => {
  it('total linear momentum is conserved (within 1%) across an arbitrary colliding pair', () => {
    fc.assert(
      fc.property(arbCollidingPair, ({ cars, carStats }) => {
        const massById = new Map<ParticipantId, number>(
          cars.map((c) => [c.id, carStats.get(c.id)!.mass!] as const),
        );
        const world = makeWorld(cars, carStats);

        const before = totalMomentum(world.cars, massById);
        const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));
        const after = totalMomentum(result.cars, massById);

        // The generator guarantees a real impact; assert it before trusting the
        // conservation check (conservation is trivially true with no collision).
        expect(result.events.filter((e) => e.type === 'collision').length).toBeGreaterThan(0);

        expectMomentumConserved(before, after);
      }),
      { numRuns: 1000 },
    );
  });

  it('total linear momentum is conserved (within 1%) across an arbitrary colliding cluster', () => {
    fc.assert(
      fc.property(arbCollidingCluster, ({ cars, carStats }) => {
        const massById = new Map<ParticipantId, number>(
          cars.map((c) => [c.id, carStats.get(c.id)!.mass!] as const),
        );
        const world = makeWorld(cars, carStats);

        const before = totalMomentum(world.cars, massById);
        const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(1));
        const after = totalMomentum(result.cars, massById);

        // At least one pair in the cluster must actually collide.
        expect(result.events.filter((e) => e.type === 'collision').length).toBeGreaterThan(0);

        expectMomentumConserved(before, after);
      }),
      { numRuns: 500 },
    );
  });
});
