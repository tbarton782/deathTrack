/**
 * Deterministic seeded pseudo-random number generator for the Deathtrack
 * Multiplayer Recreation.
 *
 * Implements a seeded xorshift64 generator satisfying the {@link RNG} interface.
 * This RNG is the single source of randomness for the physics step and AI
 * decisions; **no `Math.random()` is ever used**. Because the algorithm is a
 * pure function of its internal 64-bit state, the same seed always yields the
 * same sequence, which underpins physics determinism and lockstep network
 * reconciliation.
 *
 * Requirements: 1.9
 */

import type { RNG } from '../types/physics.js';

/**
 * 64-bit unsigned mask used to keep the xorshift state within 64 bits.
 */
const MASK64 = (1n << 64n) - 1n;

/**
 * Number of representable values in a 53-bit mantissa, used to derive a float
 * in [0, 1) from the top 53 bits of the 64-bit state.
 */
const TWO_POW_53 = 9007199254740992n; // 2^53

/**
 * Normalises an arbitrary numeric seed into a non-zero 64-bit BigInt state.
 *
 * xorshift64 has a fixed point at zero (a zero state produces only zeros), so a
 * seed of 0 (or any value that reduces to 0 mod 2^64) is remapped to a fixed
 * non-zero constant. Fractional and negative seeds are folded into the 64-bit
 * space deterministically so that callers may pass any finite number.
 */
function seedToState(seed: number): bigint {
  if (!Number.isFinite(seed)) {
    throw new RangeError(`RNG seed must be a finite number, received: ${seed}`);
  }
  // Fold the seed to an integer, then into the unsigned 64-bit space.
  const asInt = BigInt(Math.trunc(seed));
  let state = ((asInt % (1n << 64n)) + (1n << 64n)) & MASK64;
  if (state === 0n) {
    // Golden-ratio-derived non-zero constant to avoid the all-zero fixed point.
    state = 0x9e3779b97f4a7c15n;
  }
  return state;
}

/**
 * Advances a xorshift64 state by one step and returns the new state.
 *
 * Uses the canonical xorshift64 shift triple (13, 7, 17) by Marsaglia.
 */
function xorshift64(state: bigint): bigint {
  let x = state;
  x ^= (x << 13n) & MASK64;
  x ^= x >> 7n;
  x ^= (x << 17n) & MASK64;
  return x & MASK64;
}

/**
 * Creates a seeded xorshift64 {@link RNG}.
 *
 * The returned generator is stateful: successive `next()` / `nextInt()` calls
 * advance the internal state. Two generators created with the same seed produce
 * identical sequences.
 *
 * @param seed Any finite number. Non-integer and negative seeds are folded into
 *   the 64-bit state deterministically. A seed that reduces to zero is remapped
 *   to a fixed non-zero constant to avoid the all-zero fixed point.
 * @returns An {@link RNG} whose `seed` property reflects the original argument.
 *
 * Requirements: 1.9
 */
export function mkRNG(seed: number): RNG {
  let state = seedToState(seed);

  /** Advances the state and returns the raw 64-bit value as a BigInt. */
  const nextRaw = (): bigint => {
    state = xorshift64(state);
    return state;
  };

  const next = (): number => {
    // Use the top 53 bits so the result maps uniformly into [0, 1) at double
    // precision without bias from the low bits.
    const bits53 = nextRaw() >> 11n;
    return Number(bits53) / Number(TWO_POW_53);
  };

  const nextInt = (min: number, max: number): number => {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new RangeError(
        `nextInt bounds must be integers, received min=${min}, max=${max}`,
      );
    }
    if (min > max) {
      throw new RangeError(`nextInt requires min <= max, received min=${min}, max=${max}`);
    }
    // Inclusive range size. Rejection sampling keeps the distribution uniform
    // and free of modulo bias across the full 64-bit output.
    const range = BigInt(max) - BigInt(min) + 1n;
    if (range === 1n) {
      // Still advance the state so the sequence stays consistent with next().
      nextRaw();
      return min;
    }
    const limit = MASK64 - (MASK64 % range);
    let sample = nextRaw();
    while (sample > limit) {
      sample = nextRaw();
    }
    return min + Number(sample % range);
  };

  return {
    seed,
    next,
    nextInt,
  };
}
