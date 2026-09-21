/**
 * Property-based test for physics speed bounds — Property 1.
 *
 * **Property 1**: A car's speed always stays within `[0, effectiveTopSpeed]`
 * under any input sequence, where `effectiveTopSpeed` is the car's configured
 * `topSpeed` while on the track and 50% of it while off the track.
 *
 * This exercises the longitudinal speed ramp / clamp in {@link stepPhysics}
 * across arbitrary sequences of `(throttle, brake, steer)` inputs over many
 * ticks, for cars starting both on-track and off-track and — via a stateful
 * {@link TrackSDF} — cars that cross the road boundary partway through a run.
 * On every tick the resulting `speed` must never fall below 0 nor rise above
 * the effective cap that applies for that tick.
 *
 * Because the off-track speed cap is applied *within* the same tick a car goes
 * off-track (the cap uses the freshly-computed `onTrack` flag), the invariant
 * checked each tick uses the cap implied by that tick's own `onTrack` result,
 * with a tiny epsilon to absorb floating-point rounding.
 *
 * **Validates: Requirements 1.2, 1.3** (speed clamped to `[0, topSpeed]`, never
 * below zero) and the off-track cap of Requirement 1.5.
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
import type { Vec2 } from '../../types/primitives.js';

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

/** Off-track speed-cap factor from the spec (Req 1.5). */
const OFF_TRACK_SPEED_CAP_FACTOR = 0.5;

/** Small tolerance for floating-point rounding in the clamp bound checks. */
const EPS = 1e-9;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A single tick's control inputs. Throttle/brake are drawn from a slightly
 * widened range so out-of-range values are exercised too — the step clamps
 * `throttle`/`brake` into `[0, 1]` internally, and the speed invariant must
 * hold regardless of how extreme the raw input is.
 */
const frameArb = fc.record({
  throttle: fc.double({ min: -0.5, max: 1.5, noNaN: true }),
  brake: fc.double({ min: -0.5, max: 1.5, noNaN: true }),
  steer: fc.double({ min: -1.5, max: 1.5, noNaN: true }),
});

/** Positive, finite car stats within the design's stat ranges. */
const statsArb: fc.Arbitrary<PhysicsCarStats> = fc.record({
  topSpeed: fc.double({ min: 1, max: 200, noNaN: true }),
  acceleration: fc.double({ min: 0, max: 200, noNaN: true }),
  brake: fc.double({ min: 0, max: 200, noNaN: true }),
  handling: fc.double({ min: 1, max: 100, noNaN: true }),
});

// ---------------------------------------------------------------------------
// Property 1: speed stays within [0, effectiveTopSpeed]
// ---------------------------------------------------------------------------

describe('Property 1 — speed bounds under arbitrary input sequences', () => {
  it('keeps speed within [0, effectiveTopSpeed] on-track across any input sequence', () => {
    // Validates: Requirements 1.2, 1.3
    fc.assert(
      fc.property(
        statsArb,
        fc.double({ min: 0, max: 200, noNaN: true }), // arbitrary starting speed
        fc.array(frameArb, { minLength: 1, maxLength: 200 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (stats, startSpeed, frames, seed) => {
          // Start speed is clamped so the initial state is itself valid; the
          // property is about the step never *producing* an out-of-bounds speed.
          const initialSpeed = Math.min(startSpeed, stats.topSpeed);
          let car = makeCar({ id: 0, speed: initialSpeed });
          const rng = mkRNG(seed);

          for (const f of frames) {
            const world = makeWorld([car], { carStats: new Map([[0, stats]]) });
            const inputs = new Map<ParticipantId, CarInputs>([
              [0, makeInputs(f)],
            ]);
            car = stepPhysics(world, inputs, FIXED_TIMESTEP, rng).cars[0]!;

            // On-track: effective cap is the configured top speed (Req 1.2).
            expect(car.speed).toBeGreaterThanOrEqual(0); // Req 1.3
            expect(car.speed).toBeLessThanOrEqual(stats.topSpeed + EPS);
          }
        },
      ),
    );
  });

  it('keeps speed within [0, 50% topSpeed] while fully off-track', () => {
    // Validates: Requirements 1.2, 1.3 (with the off-track cap of Req 1.5)
    fc.assert(
      fc.property(
        statsArb,
        fc.double({ min: 0, max: 200, noNaN: true }),
        fc.array(frameArb, { minLength: 1, maxLength: 200 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (stats, startSpeed, frames, seed) => {
          const offCap = stats.topSpeed * OFF_TRACK_SPEED_CAP_FACTOR;
          let car = makeCar({ id: 0, speed: Math.min(startSpeed, offCap), onTrack: false });
          const rng = mkRNG(seed);
          // Constant negative SDF => the car is off the road every tick.
          const alwaysOff: TrackSDF = () => -1;

          for (const f of frames) {
            const world = makeWorld([car], {
              carStats: new Map([[0, stats]]),
              trackSDF: alwaysOff,
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

  it('keeps speed within [0, effectiveTopSpeed-for-this-tick] when crossing the boundary', () => {
    // Validates: Requirements 1.2, 1.3 (effective cap follows the per-tick
    // on/off-track state produced by the SDF, per Req 1.5).
    fc.assert(
      fc.property(
        statsArb,
        fc.double({ min: 0, max: 200, noNaN: true }),
        fc.array(frameArb, { minLength: 1, maxLength: 200 }),
        // Per-tick on/off-track schedule the SDF will follow.
        fc.array(fc.boolean(), { minLength: 1, maxLength: 200 }),
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (stats, startSpeed, frames, onTrackSchedule, seed) => {
          let car = makeCar({ id: 0, speed: Math.min(startSpeed, stats.topSpeed) });
          const rng = mkRNG(seed);

          const len = Math.min(frames.length, onTrackSchedule.length);
          for (let i = 0; i < len; i++) {
            const wantOnTrack = onTrackSchedule[i]!;
            // SDF that is position-independent but driven by the schedule: it
            // returns >= 0 (on-track) or < 0 (off-track) for this tick.
            const sdf: TrackSDF = (_p: Vec2) => (wantOnTrack ? 1 : -1);

            const world = makeWorld([car], {
              carStats: new Map([[0, stats]]),
              trackSDF: sdf,
            });
            const inputs = new Map<ParticipantId, CarInputs>([[0, makeInputs(frames[i]!)]]);
            car = stepPhysics(world, inputs, FIXED_TIMESTEP, rng).cars[0]!;

            // The effective cap for this tick follows the freshly-computed
            // onTrack flag: full top speed on-track, half off-track.
            const effectiveTopSpeed = car.onTrack
              ? stats.topSpeed
              : stats.topSpeed * OFF_TRACK_SPEED_CAP_FACTOR;

            expect(car.onTrack).toBe(wantOnTrack);
            expect(car.speed).toBeGreaterThanOrEqual(0);
            expect(car.speed).toBeLessThanOrEqual(effectiveTopSpeed + EPS);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
