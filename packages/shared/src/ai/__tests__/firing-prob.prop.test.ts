/**
 * Property-based test for AI forward-fire probability — Property 14.
 *
 * **Property 14**: AI firing probability converges to the configured tier
 * value. For any AI skill tier and any scenario with an opponent car
 * continuously within the forward weapon's configured maximum range, the
 * empirical firing rate over a large number of independent fire-decision
 * evaluations is within ±5% of the configured tier probability
 * (Novice 30%, Standard 60%, Expert 90%).
 *
 * The test drives {@link decideForwardFire} directly — the pure, RNG-gated
 * fire decision that {@link computeAIInputs} delegates to — with an opponent
 * fixed inside the forward-weapon range and the driver never evasive, so the
 * only thing gating a fire is a fresh draw from the seeded {@link mkRNG}
 * against `FIRE_PROBABILITY_BY_TIER[tier]`. fast-check supplies arbitrary
 * seeds and each of the three tiers; for every case the empirical fire rate
 * over {@link TRIALS} draws must land within {@link TOLERANCE} of the tier
 * probability.
 *
 * Trial count and tolerance are chosen so the check is robust across seeds
 * rather than flaky: with the tightest-variance tier (standard, p = 0.6) the
 * standard deviation of the empirical rate over {@link TRIALS} draws is about
 * sqrt(0.6 · 0.4 / 2000) ≈ 0.011, so a ±0.05 band is well beyond 4σ and
 * essentially never trips by chance while still failing hard if the decision
 * ever stopped tracking the configured probability.
 *
 * **Validates: Requirements 6.2**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import type { CarPhysicsState } from '../../types/physics.js';
import type { SkillTier } from '../../types/ai.js';
import { mkRNG } from '../../physics/rng.js';
import { decideForwardFire, FIRE_PROBABILITY_BY_TIER } from '../AIBrain.js';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/**
 * Fire decisions evaluated per case. The design's Property 14 specifies 1000;
 * doubling it shrinks the sampling noise (≈0.011 stddev at the worst tier) so
 * the ±5% band is comfortably robust across arbitrary seeds.
 */
const TRIALS = 2000;

/** Convergence band around the configured tier probability (±5%). */
const TOLERANCE = 0.05;

/** All configured skill tiers. */
const TIERS: readonly SkillTier[] = ['novice', 'standard', 'expert'];

/** Forward-weapon range used for the in-range opponent scenario. */
const RANGE = 50;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal opponent car parked well inside {@link RANGE} of the origin. */
function opponentInRange(): CarPhysicsState {
  return {
    id: 1,
    position: { x: 0, y: 10 }, // distance 10 < RANGE 50
    velocity: { x: 0, y: 0 },
    heading: 0,
    speed: 0,
    angularVelocity: 0,
    onTrack: true,
    airborne: false,
    airborneHeight: 0,
    airborneVY: 0,
  };
}

/**
 * Run {@link TRIALS} fire decisions from a single seeded RNG (an opponent in
 * range, never evasive) and return the empirical fire rate.
 */
function empiricalFireRate(seed: number, tier: SkillTier): number {
  const rng = mkRNG(seed);
  const self = { x: 0, y: 0 };
  const opponents = [opponentInRange()];
  let fires = 0;
  for (let i = 0; i < TRIALS; i++) {
    if (decideForwardFire(self, opponents, RANGE, tier, false, rng)) {
      fires += 1;
    }
  }
  return fires / TRIALS;
}

// ---------------------------------------------------------------------------
// Property 14
// ---------------------------------------------------------------------------

describe('Property 14: AI firing probability converges to the configured tier value (Req 6.2)', () => {
  it('empirical fire rate is within ±5% of the tier probability for arbitrary seeds and all tiers', () => {
    fc.assert(
      fc.property(
        // Integer seeds spanning the full 32-bit-ish range, incl. 0 / negatives.
        fc.integer({ min: -1_000_000, max: 1_000_000 }),
        fc.constantFrom(...TIERS),
        (seed, tier) => {
          const expected = FIRE_PROBABILITY_BY_TIER[tier];
          const observed = empiricalFireRate(seed, tier);
          expect(Math.abs(observed - expected)).toBeLessThanOrEqual(TOLERANCE);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('converges for each tier at a representative seed (explicit sanity check)', () => {
    for (const tier of TIERS) {
      const expected = FIRE_PROBABILITY_BY_TIER[tier];
      const observed = empiricalFireRate(12345, tier);
      expect(observed).toBeGreaterThanOrEqual(expected - TOLERANCE);
      expect(observed).toBeLessThanOrEqual(expected + TOLERANCE);
    }
  });
});
