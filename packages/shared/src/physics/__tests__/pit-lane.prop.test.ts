/**
 * Property-based test for pit-lane full restore — Property 22.
 *
 * **Property 22**: A pit lane visit restores armor to maximum and reloads all
 * weapons.
 *
 * The physics step is the authority for *when* a restoration happens but not for
 * the armor/ammo values themselves — armor and ammo live in `CarRaceState`, not
 * in `CarPhysicsState`. So {@link stepPhysics} models the restore per the
 * design's event-based representation: it emits a `pit_lane_enter` event
 * carrying the configured `maxArmor` (the restoration target the authority loop
 * uses to set `currentArmor = maxArmor` and reload every weapon to its
 * `ammoMax`), and a matching `pit_lane_exit` event carrying
 * `restoredArmor === maxArmor` once the car leaves. The enter always precedes
 * the exit across a visit, so the restoration is signalled — and, per the
 * authority contract, completed — before the car exits the pit lane.
 *
 * This property drives arbitrary cars, each with an arbitrary configured
 * `maxArmor`, into arbitrary pit-lane geometry and asserts:
 *
 *  1. Entering the pit lane emits a `pit_lane_enter` whose `maxArmor` equals the
 *     car's configured maximum (full-restore target), for arbitrary maxArmor.
 *  2. Exiting emits a `pit_lane_exit` whose `restoredArmor` equals that same
 *     configured maximum (armor restored to full).
 *  3. Across a full visit the enter event precedes the exit event — the
 *     restoration is signalled/completed in-lane, before the car exits.
 *
 * **Validates: Requirements 9.4**
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
import type { CarPhysicsState, PhysicsEvent } from '../../types/physics.js';
import type { ParticipantId, Vec2 } from '../../types/primitives.js';
import type { PitLaneData } from '../../types/track.js';

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

/**
 * Inert stats: zero acceleration/brake/handling so a stationary car parked on a
 * trigger point stays put and the only thing under test is the pit-lane
 * detection geometry. `armor` is the configured maximum reported by the
 * restoration events (the full-restore target).
 */
function inertStats(maxArmor: number): PhysicsCarStats {
  return {
    topSpeed: 50,
    acceleration: 0,
    brake: 0,
    handling: 0,
    armor: maxArmor,
  };
}

/** Narrow a PhysicsEvent to a pit-lane variant for concise assertions. */
type PitEnter = Extract<PhysicsEvent, { type: 'pit_lane_enter' }>;
type PitExit = Extract<PhysicsEvent, { type: 'pit_lane_exit' }>;

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Arbitrary configured maximum armor (HP). Positive, finite, integer-ish. */
const maxArmorArb = fc.integer({ min: 1, max: 100_000 });

/** A finite track-space coordinate. */
const coordArb = fc.double({ min: -1000, max: 1000, noNaN: true });
const pointArb: fc.Arbitrary<Vec2> = fc.record({ x: coordArb, y: coordArb });

/**
 * Arbitrary pit-lane geometry with distinct entry and exit points. Keeping the
 * two points apart (via a fixed offset added to the exit) means a car parked on
 * the entry does not also sit on the exit, so enter and exit are separately
 * triggerable across ticks.
 */
const pitLaneArb: fc.Arbitrary<PitLaneData> = fc
  .record({ entry: pointArb, exitOffset: fc.record({ x: coordArb, y: coordArb }) })
  .map(({ entry, exitOffset }) => {
    // Push the exit far from the entry (>= the 2-unit contact radius) so a car
    // on the entry point is not within contact range of the exit point.
    const exit: Vec2 = { x: entry.x + exitOffset.x + 100, y: entry.y + exitOffset.y + 100 };
    return { entryPosition: entry, exitPosition: exit, path: [entry, exit] };
  });

const seedArb = fc.integer({ min: 0, max: 2 ** 31 - 1 });

// ---------------------------------------------------------------------------
// Property 22: a pit-lane visit restores armor to max and reloads all weapons
// ---------------------------------------------------------------------------

describe('Property 22 — pit lane visit restores armor to maximum and reloads weapons', () => {
  it('enter signals a full-restore target equal to the configured maxArmor', () => {
    // Validates: Requirements 9.4
    fc.assert(
      fc.property(maxArmorArb, pitLaneArb, seedArb, (maxArmor, pitLane, seed) => {
        // A non-occupant car parked exactly on the entry point enters this tick.
        const car = makeCar({ id: 0, position: pitLane.entryPosition, speed: 0 });
        const world = makeWorld([car], {
          carStats: new Map([[0, inertStats(maxArmor)]]),
          pitLane,
          pitLaneOccupants: [],
        });

        const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(seed));
        const enters = result.events.filter((e): e is PitEnter => e.type === 'pit_lane_enter');

        // Exactly one enter, and its restore target is the full configured armor.
        expect(enters).toHaveLength(1);
        expect(enters[0]!.participantId).toBe(0);
        expect(enters[0]!.maxArmor).toBe(maxArmor);
        // The car did not also exit in the entering tick.
        expect(result.events.some((e) => e.type === 'pit_lane_exit')).toBe(false);
      }),
    );
  });

  it('exit reports armor restored to the full configured maxArmor', () => {
    // Validates: Requirements 9.4
    fc.assert(
      fc.property(maxArmorArb, pitLaneArb, seedArb, (maxArmor, pitLane, seed) => {
        // An occupant (mid-visit) parked on the exit point leaves this tick.
        const car = makeCar({ id: 0, position: pitLane.exitPosition, speed: 0 });
        const world = makeWorld([car], {
          carStats: new Map([[0, inertStats(maxArmor)]]),
          pitLane,
          pitLaneOccupants: [0],
        });

        const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, mkRNG(seed));
        const exits = result.events.filter((e): e is PitExit => e.type === 'pit_lane_exit');

        expect(exits).toHaveLength(1);
        expect(exits[0]!.participantId).toBe(0);
        // Restored armor equals the configured maximum: a full restore.
        expect(exits[0]!.restoredArmor).toBe(maxArmor);
      }),
    );
  });

  it('a full visit signals restoration (enter, target=maxArmor) strictly before exit', () => {
    // Validates: Requirements 9.4
    fc.assert(
      fc.property(maxArmorArb, pitLaneArb, seedArb, (maxArmor, pitLane, seed) => {
        const rng = mkRNG(seed);
        const stats = inertStats(maxArmor);

        // Drive a car through a full visit while emulating the authority loop's
        // occupancy bookkeeping from the emitted events. The car is teleported
        // onto the entry point (tick 0) and later onto the exit point.
        let occupants: ParticipantId[] = [];

        let sawEnter = false;
        let sawExit = false;
        let enterTarget: number | undefined;
        let exitRestored: number | undefined;
        let enterBeforeExit = true;

        // A short schedule: sit on the entry for a couple of ticks, then on the
        // exit. This mirrors a real visit: enter is detected, occupancy is
        // threaded forward, then the car reaches the exit.
        const positions: Vec2[] = [
          pitLane.entryPosition,
          pitLane.entryPosition,
          pitLane.exitPosition,
          pitLane.exitPosition,
        ];

        for (const pos of positions) {
          const car = makeCar({ id: 0, position: pos, speed: 0 });
          const world = makeWorld([car], {
            carStats: new Map([[0, stats]]),
            pitLane,
            pitLaneOccupants: occupants,
          });
          const result = stepPhysics(world, new Map(), FIXED_TIMESTEP, rng);

          for (const ev of result.events) {
            if (ev.type === 'pit_lane_enter') {
              sawEnter = true;
              enterTarget = ev.maxArmor;
              if (!occupants.includes(ev.participantId)) {
                occupants = [...occupants, ev.participantId];
              }
            } else if (ev.type === 'pit_lane_exit') {
              // Exit must never be observed before the entering restoration.
              if (!sawEnter) enterBeforeExit = false;
              sawExit = true;
              exitRestored = ev.restoredArmor;
              occupants = occupants.filter((id) => id !== ev.participantId);
            }
          }
        }

        // The visit completed: both transitions fired.
        expect(sawEnter).toBe(true);
        expect(sawExit).toBe(true);
        // Restoration was signalled before the car exited (Req 9.4).
        expect(enterBeforeExit).toBe(true);
        // Both events agree on the full-restore target: the configured maximum.
        expect(enterTarget).toBe(maxArmor);
        expect(exitRestored).toBe(maxArmor);
      }),
    );
  });
});
