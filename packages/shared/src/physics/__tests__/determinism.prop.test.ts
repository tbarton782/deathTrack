/**
 * Property-based determinism test for the physics step {@link stepPhysics}.
 *
 * Property 3 — Physics determinism:
 *   The physics simulation is fully deterministic. Given identical
 *   `(state, inputs, dt, seed)`, two independent single-tick runs produce
 *   byte-identical car states and events; and a multi-tick run replayed from
 *   the same starting world with the same input sequence and seed reproduces
 *   the exact same trajectory of states and events. Furthermore, the result is
 *   independent of the order cars appear in the input array — the per-id
 *   outcome is identical however the array is shuffled.
 *
 * This is the property backing lockstep client/server reconciliation and replay
 * (Req 1.9): identical initial states, input sequences and random seeds must
 * yield identical outputs across all car stat configurations.
 *
 * **Validates: Requirements 1.9**
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
import type { CarInputs, CarPhysicsState } from '../../types/physics.js';
import type { ParticipantId } from '../../types/primitives.js';

// ---------------------------------------------------------------------------
// Generators
//
// Smart generators constrained to the physics input space: finite, non-NaN
// numbers within the design's stat/input ranges. Each generated world assigns
// distinct ParticipantIds (0..n-1) so the per-id keying is unambiguous, and
// pairs each car with its own stats so "all car stat configurations" (Req 1.9)
// is actually exercised.
// ---------------------------------------------------------------------------

/** A finite, non-NaN double in [min, max]. */
const num = (min: number, max: number) => fc.double({ min, max, noNaN: true });

/** Arbitrary per-car physics stats spanning the design's stat ranges. */
const statsArb: fc.Arbitrary<PhysicsCarStats> = fc.record({
  topSpeed: num(1, 120),
  acceleration: num(0, 80),
  brake: num(0, 80),
  handling: num(1, 100),
  mass: num(0.5, 5),
  collisionRadius: num(0.5, 3),
  armor: num(1, 200),
});

/** Arbitrary control inputs within the normalised input ranges. */
const inputsArb: fc.Arbitrary<CarInputs> = fc.record({
  throttle: num(0, 1),
  brake: num(0, 1),
  steer: num(-1, 1),
  fireForward: fc.boolean(),
  fireRear: fc.boolean(),
});

/**
 * A single car with arbitrary kinematic state. The `id` is assigned by the
 * world generator so ids stay distinct; here it is a placeholder.
 */
const carArb: fc.Arbitrary<Omit<CarPhysicsState, 'id'>> = fc
  .record({
    x: num(-50, 50),
    y: num(-50, 50),
    heading: num(0, Math.PI * 2),
    speed: num(0, 100),
    onTrack: fc.boolean(),
    airborne: fc.boolean(),
    airborneHeight: num(0, 20),
    airborneVY: num(-20, 20),
  })
  .map((r) => ({
    position: { x: r.x, y: r.y },
    // Velocity kept consistent with heading/speed as the step would produce.
    velocity: { x: r.speed * Math.sin(r.heading), y: r.speed * Math.cos(r.heading) },
    heading: r.heading,
    speed: r.speed,
    angularVelocity: 0,
    onTrack: r.onTrack,
    airborne: r.airborne,
    airborneHeight: r.airborne ? r.airborneHeight : 0,
    airborneVY: r.airborne ? r.airborneVY : 0,
  }));

interface GeneratedWorld {
  readonly cars: CarPhysicsState[];
  readonly carStats: Map<ParticipantId, PhysicsCarStats>;
  readonly seed: number;
  /** One input map per tick of the multi-tick run. */
  readonly inputFrames: Array<Map<ParticipantId, CarInputs>>;
}

/**
 * A full simulation scenario: 1..5 cars with distinct ids, per-car stats, a
 * seed, and a sequence of 1..8 input frames (one per tick).
 */
const worldArb: fc.Arbitrary<GeneratedWorld> = fc
  .integer({ min: 1, max: 5 })
  .chain((carCount) =>
    fc.record({
      cars: fc.tuple(...Array.from({ length: carCount }, () => carArb)),
      stats: fc.tuple(...Array.from({ length: carCount }, () => statsArb)),
      seed: fc.integer({ min: 0, max: 2 ** 31 - 1 }),
      frames: fc.array(
        fc.tuple(...Array.from({ length: carCount }, () => inputsArb)),
        { minLength: 1, maxLength: 8 },
      ),
    }),
  )
  .map(({ cars, stats, seed, frames }) => {
    const withIds: CarPhysicsState[] = cars.map((c, i) => ({ ...c, id: i as ParticipantId }));
    const carStats = new Map<ParticipantId, PhysicsCarStats>(
      stats.map((s, i) => [i as ParticipantId, s]),
    );
    const inputFrames = frames.map(
      (frame) => new Map<ParticipantId, CarInputs>(frame.map((inp, i) => [i as ParticipantId, inp])),
    );
    return { cars: withIds, carStats, seed, inputFrames };
  });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeWorld(cars: CarPhysicsState[], carStats: Map<ParticipantId, PhysicsCarStats>): PhysicsWorldState {
  return { cars, tick: 0, trackId: 'chicago', carStats };
}

/**
 * Runs a full multi-tick simulation from `startCars`, feeding one input frame
 * per tick and threading each tick's output cars into the next tick. Returns
 * the ordered list of per-tick results (cars + events) so two runs can be
 * compared for byte-identity.
 */
function runSimulation(
  startCars: CarPhysicsState[],
  carStats: Map<ParticipantId, PhysicsCarStats>,
  inputFrames: Array<Map<ParticipantId, CarInputs>>,
  seed: number,
) {
  const rng = mkRNG(seed);
  let cars = startCars;
  const timeline: Array<{ cars: readonly CarPhysicsState[]; events: unknown }> = [];
  for (const inputs of inputFrames) {
    const result = stepPhysics(makeWorld(cars, carStats), inputs, FIXED_TIMESTEP, rng);
    timeline.push({ cars: result.cars, events: result.events });
    cars = [...result.cars];
  }
  return timeline;
}

/** Deterministic Fisher–Yates shuffle keyed by an RNG so cases are reproducible. */
function shuffle<T>(items: readonly T[], seed: number): T[] {
  const rng = mkRNG(seed ^ 0x5f3759df);
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.nextInt(0, i);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Re-key a timeline's cars by ParticipantId so array-order differences wash out. */
function timelineById(timeline: ReturnType<typeof runSimulation>) {
  return timeline.map((tick) => ({
    cars: [...tick.cars].sort((a, b) => a.id - b.id),
    events: tick.events,
  }));
}

const RUNS = 300;

// ---------------------------------------------------------------------------
// Property 3 — Physics determinism (Req 1.9)
// ---------------------------------------------------------------------------

describe('Property 3 — physics determinism (Req 1.9)', () => {
  it('two independent runs of the same multi-tick simulation are byte-identical', () => {
    // Validates: Requirements 1.9
    fc.assert(
      fc.property(worldArb, (w) => {
        const a = runSimulation(w.cars, w.carStats, w.inputFrames, w.seed);
        const b = runSimulation(w.cars, w.carStats, w.inputFrames, w.seed);
        expect(a).toEqual(b);
      }),
      { numRuns: RUNS },
    );
  });

  it('a single tick is deterministic for arbitrary worlds, inputs and seeds', () => {
    // Validates: Requirements 1.9
    fc.assert(
      fc.property(worldArb, (w) => {
        const inputs = w.inputFrames[0]!;
        const a = stepPhysics(makeWorld(w.cars, w.carStats), inputs, FIXED_TIMESTEP, mkRNG(w.seed));
        const b = stepPhysics(makeWorld(w.cars, w.carStats), inputs, FIXED_TIMESTEP, mkRNG(w.seed));
        expect(a).toEqual(b);
      }),
      { numRuns: RUNS },
    );
  });

  it('the per-id result is independent of the input car array order', () => {
    // Validates: Requirements 1.9
    fc.assert(
      fc.property(worldArb, (w) => {
        const straight = runSimulation(w.cars, w.carStats, w.inputFrames, w.seed);
        // Shuffle only the starting car array; ids, stats, inputs and seed are
        // unchanged. Determinism must key the outcome on id, not array index.
        const shuffledCars = shuffle(w.cars, w.seed);
        const shuffled = runSimulation(shuffledCars, w.carStats, w.inputFrames, w.seed);
        expect(timelineById(shuffled)).toEqual(timelineById(straight));
      }),
      { numRuns: RUNS },
    );
  });

  it('differing seeds still produce internally-consistent, replayable runs', () => {
    // Validates: Requirements 1.9
    // Replaying the same run twice under a fresh seed reproduces it exactly,
    // for any seed — the base step is a pure function of (state, inputs, seed).
    fc.assert(
      fc.property(
        worldArb,
        fc.integer({ min: 0, max: 2 ** 31 - 1 }),
        (w, altSeed) => {
          const a = runSimulation(w.cars, w.carStats, w.inputFrames, altSeed);
          const b = runSimulation(w.cars, w.carStats, w.inputFrames, altSeed);
          expect(a).toEqual(b);
        },
      ),
      { numRuns: RUNS },
    );
  });
});
