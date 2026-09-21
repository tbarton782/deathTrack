/**
 * Property-based test for AI lap-time variation — Property 15.
 *
 * **Property 15**: AI lap time variation is within the specified band. The AI's
 * per-lap throttle jitter is what drives lap-to-lap variation (Req 6.6): each
 * lap draws a multiplier `1 + delta` whose deviation `delta` from 1 has
 * magnitude in `[LAP_JITTER_MIN, LAP_JITTER_MAX]` (the ±2%–±10% band) with a
 * random sign. This test asserts two facets of that guarantee:
 *
 *   1. *Band containment* — for arbitrary seeds and arbitrary sample counts,
 *      every value returned by {@link sampleLapThrottleJitter} deviates from 1
 *      by a magnitude within `[LAP_JITTER_MIN, LAP_JITTER_MAX]`. A deviation
 *      below the floor would make laps effectively identical; one above the
 *      ceiling would exceed the allowed spread.
 *   2. *Two-sided variation* — over many samples the jitter is genuinely
 *      two-sided: both faster-than-nominal (multiplier > 1) and
 *      slower-than-nominal (multiplier < 1) laps occur, so the variation is not
 *      biased to a single direction.
 *
 * All randomness is drawn from the deterministic seeded {@link mkRNG}, so each
 * property run is reproducible from its seed.
 *
 * **Validates: Requirements 6.6**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { mkRNG } from '../../physics/rng.js';
import {
  sampleLapThrottleJitter,
  LAP_JITTER_MIN,
  LAP_JITTER_MAX,
} from '../AIBrain.js';

// Tolerance for floating-point rounding around the band edges.
const EPS = 1e-9;

describe('Property 15: AI lap time variation is within the specified band (Req 6.6)', () => {
  it('every sampled lap throttle jitter deviates from 1 within the ±2%..±10% band', () => {
    fc.assert(
      fc.property(
        // Arbitrary finite seed (integers, negatives, and large values are all
        // folded into the RNG's 64-bit state deterministically).
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        // Arbitrary number of consecutive laps sampled from one RNG stream.
        fc.integer({ min: 1, max: 300 }),
        (seed, laps) => {
          const rng = mkRNG(seed);
          for (let i = 0; i < laps; i++) {
            const multiplier = sampleLapThrottleJitter(rng);
            const magnitude = Math.abs(multiplier - 1);
            expect(magnitude).toBeGreaterThanOrEqual(LAP_JITTER_MIN - EPS);
            expect(magnitude).toBeLessThanOrEqual(LAP_JITTER_MAX + EPS);
          }
        },
      ),
    );
  });

  it('produces both faster (>1) and slower (<1) laps over many samples for any seed', () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), (seed) => {
        const rng = mkRNG(seed);
        let up = 0;
        let down = 0;
        // A large sample makes an all-one-sided run astronomically unlikely for
        // the ~50/50 sign draw, so the variation must be genuinely two-sided.
        for (let i = 0; i < 400; i++) {
          const multiplier = sampleLapThrottleJitter(rng);
          if (multiplier > 1) up += 1;
          else if (multiplier < 1) down += 1;
        }
        expect(up).toBeGreaterThan(0);
        expect(down).toBeGreaterThan(0);
      }),
    );
  });
});
