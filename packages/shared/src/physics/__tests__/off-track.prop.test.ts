/**
 * Property-based test for the off-track traction penalty — Property 2.
 *
 * **Property 2**: For any car state where `onTrack` is `false`, the effective
 * handling factor applied by {@link stepPhysics} is at most 50% of the car's
 * configured handling value, AND the speed applied to that car is capped at no
 * more than 50% of its configured top speed.
 *
 * The physics step does not expose "effective handling" directly, so we probe
 * it behaviourally: the magnitude of the angular velocity produced for a given
 * steer input is linear in the effective handling (turn rate =
 * `steer * handling/100 / steerSpeed`). By comparing an on-track step against an
 * off-track step at the *same* pre-step speed, heading and steer, the ratio of
 * off-track to on-track angular-velocity magnitude isolates the handling factor.
 * Requirement 1.5 halves handling off-track, so that ratio must be 0.5.
 *
 * For the speed cap we drive a car off-track (via a {@link TrackSDF} that always
 * reports a negative signed distance) under arbitrary throttle over many ticks
 * and assert its speed never exceeds 50% of the configured top speed.
 *
 * **Validates: Requirements 1.5**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  stepPhysics,
  FIXED_TIMESTEP,
  type PhysicsCarStats,
  type PhysicsWorldState,
  type TrackSDF,
} from '../stepPhysics.js';
import { mkRNG } from '../rng.js';
import type { CarInputs, CarPhysicsState } from '../../types/physics.js';
import type { ParticipantId } from '../../types/primitives.js';

// ---------------------------------------------------------------------------
// Fixtures (mirroring stepPhysics.test.ts patterns)
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

/** Off-track factors from the spec (Req 1.5). */
const OFF_TRACK_HANDLING_FACTOR = 0.5;
const OFF_TRACK_SPEED_CAP_FACTOR = 0.5;

/** Small tolerance for floating-point rounding. */
const EPS = 1e-9;

/** A track SDF that always reports off-track (negative signed distance). */
const ALWAYS_OFF: TrackSDF = () => -1;
/** A track SDF that always reports on-track (non-negative signed distance). */
const ALWAYS_ON: TrackSDF = () => 1;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Positive, finite car stats within the design's stat ranges. */
const statsArb: fc.Arbitrary<PhysicsCarStats> = fc.record({
  topSpeed: fc.double({ min: 1, max: 200, noNaN: true }),
  acceleration: fc.double({ min: 0, max: 200, noNaN: true }),
  brake: fc.double({ min: 0, max: 200, noNaN: true }),
  handling: fc.double({ min: 1, max: 100, noNaN: true }),
});

/** A single tick's control inputs (slightly widened; the step clamps). */
const frameArb = fc.record({
  throttle: fc.double({ min: -0.5, max: 1.5, noNaN: true }),
  brake: fc.double({ min: -0.5, max: 1.5, noNaN: true }),
  steer: fc.double({ min: -1.5, max: 1.5, noNaN: true }),
});

// ---------------------------------------------------------------------------
// Property 2: off-track penalty — handling halved AND speed capped at 50%
// ---------------------------------------------------------------------------

describe('Property 2 — off-track traction penalty', () => {
  it('halves effective handling off-track (angular velocity is half the on-track magnitude)', () => {
    // Validates: Requirements 1.5
    fc.assert(
      fc.property(
        statsArb,
        // Pre-step speed. Kept below the off-track cap so the SAME speed is
        // used to derive the turn rate in both the on- and off-track steps —
        // this isolates the handling factor from the speed cap. A non-zero
        // steer is required for the ratio to be meaningful.
        fc.double({ min: 0, max: 200, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }).filter((s) => Math.abs(s) > 1e-3),
        fc.double({ min: 0, max: Math.PI * 2, noNaN: true }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (stats, rawSpeed, steer, heading, seed) => {
          // Use a speed within the off-track cap so both branches compute the
          // turn rate at the identical steerSpeed (the cap does not shrink the
          // pre-step speed here — the clamp only bounds the *output* speed).
          const speed = Math.min(rawSpeed, stats.topSpeed * OFF_TRACK_SPEED_CAP_FACTOR);

          const car = makeCar({ id: 0, speed, heading });
          const inputs = new Map<ParticipantId, CarInputs>([[0, makeInputs({ steer })]]);

          const onTrack = stepPhysics(
            makeWorld([car], { carStats: new Map([[0, stats]]), trackSDF: ALWAYS_ON }),
            inputs,
            FIXED_TIMESTEP,
            mkRNG(seed),
          ).cars[0]!;

          const offTrack = stepPhysics(
            makeWorld([car], { carStats: new Map([[0, stats]]), trackSDF: ALWAYS_OFF }),
            inputs,
            FIXED_TIMESTEP,
            mkRNG(seed),
          ).cars[0]!;

          expect(onTrack.onTrack).toBe(true);
          expect(offTrack.onTrack).toBe(false);

          const onMag = Math.abs(onTrack.angularVelocity);
          const offMag = Math.abs(offTrack.angularVelocity);

          // Effective handling off-track is exactly half, so the off-track
          // angular-velocity magnitude is half the on-track magnitude for the
          // same steer/speed/heading.
          expect(offMag).toBeLessThanOrEqual(onMag * OFF_TRACK_HANDLING_FACTOR + EPS);
          expect(offMag).toBeCloseTo(onMag * OFF_TRACK_HANDLING_FACTOR, 10);
        },
      ),
    );
  });

  it('caps speed at no more than 50% of top speed while off-track, for any input sequence', () => {
    // Validates: Requirements 1.5
    fc.assert(
      fc.property(
        statsArb,
        fc.double({ min: 0, max: 400, noNaN: true }), // arbitrary starting speed
        fc.array(frameArb, { minLength: 1, maxLength: 200 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (stats, startSpeed, frames, seed) => {
          const offCap = stats.topSpeed * OFF_TRACK_SPEED_CAP_FACTOR;
          // Start at or below the cap so the initial state is itself valid; the
          // property is that the step never *produces* a speed above the cap.
          let car = makeCar({ id: 0, speed: Math.min(startSpeed, offCap), onTrack: false });
          const rng = mkRNG(seed);

          for (const f of frames) {
            const world = makeWorld([car], {
              carStats: new Map([[0, stats]]),
              trackSDF: ALWAYS_OFF,
            });
            const inputs = new Map<ParticipantId, CarInputs>([[0, makeInputs(f)]]);
            car = stepPhysics(world, inputs, FIXED_TIMESTEP, rng).cars[0]!;

            expect(car.onTrack).toBe(false);
            expect(car.speed).toBeGreaterThanOrEqual(0);
            expect(car.speed).toBeLessThanOrEqual(offCap + EPS);
          }
        },
      ),
    );
  });

  it('drags an over-cap car down toward the off-track cap even under full throttle', () => {
    // Validates: Requirements 1.5
    // Sanity companion to the property above: a car that begins ABOVE the
    // off-track cap must be clamped to the cap on the very next off-track tick,
    // never allowed to remain above 50% of top speed.
    fc.assert(
      fc.property(
        statsArb,
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (stats, seed) => {
          const offCap = stats.topSpeed * OFF_TRACK_SPEED_CAP_FACTOR;
          // Start well above the cap (at full top speed).
          const car = makeCar({ id: 0, speed: stats.topSpeed, onTrack: true });
          const world = makeWorld([car], {
            carStats: new Map([[0, stats]]),
            trackSDF: ALWAYS_OFF,
          });
          const inputs = new Map<ParticipantId, CarInputs>([[0, makeInputs({ throttle: 1 })]]);

          const result = stepPhysics(world, inputs, FIXED_TIMESTEP, mkRNG(seed)).cars[0]!;

          expect(result.onTrack).toBe(false);
          expect(result.speed).toBeLessThanOrEqual(offCap + EPS);
        },
      ),
    );
  });
});
