/**
 * Property-based test for prize money computation — Property 10.
 *
 * **Property 10**: Prize money calculation matches the formula for all
 * placements. For any finishing placement (including placements outside the
 * prize table's range) and any non-negative integer elimination count, the
 * value returned by {@link computePrizeMoney} equals exactly
 * `placementPrize(placement) + eliminationCount × eliminationBonus`, where both
 * `placementPrize` and `eliminationBonus` are taken from the configured prize
 * table and an out-of-range placement contributes a placement prize of 0.
 *
 * The test drives arbitrary prize tables (varying both the placement schedule
 * and the per-elimination bonus), arbitrary placements — deliberately spanning
 * in-range, index-0 (unused), and far out-of-range positions — and arbitrary
 * non-negative elimination counts. Each run compares the service output against
 * an independent reference implementation of the same formula, so the test does
 * not merely re-derive the implementation's arithmetic in the same shape it uses
 * internally.
 *
 * **Validates: Requirements 5.2**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { computePrizeMoney, type PrizeTable } from '../CareerService.js';

// ---------------------------------------------------------------------------
// Independent reference implementation
// ---------------------------------------------------------------------------

/**
 * Reference computation written independently of the service: look up the
 * 1-based placement prize (0 when the placement is not present in the table),
 * then add the per-elimination bonus scaled by the elimination count.
 */
function referencePrizeMoney(
  placement: number,
  eliminationCount: number,
  table: PrizeTable,
): number {
  const hasPrize =
    placement >= 0 &&
    placement < table.placementPrizes.length &&
    table.placementPrizes[placement] !== undefined;
  const placementPrize = hasPrize ? (table.placementPrizes[placement] as number) : 0;
  return placementPrize + eliminationCount * table.eliminationBonus;
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * An arbitrary prize table. `placementPrizes[0]` is unused (placements are
 * 1-based), so index 0 is fixed to 0 to mirror the domain's convention, while
 * the remaining entries carry arbitrary non-negative prizes. The schedule
 * length varies so the boundary between "in range" and "out of range"
 * placements moves between runs.
 */
const prizeTableArb: fc.Arbitrary<PrizeTable> = fc.record({
  placementPrizes: fc
    .array(fc.integer({ min: 0, max: 50_000 }), { minLength: 1, maxLength: 20 })
    .map((prizes) => {
      const copy = [...prizes];
      copy[0] = 0; // index 0 is unused (placement is 1-based)
      return copy as readonly number[];
    }),
  eliminationBonus: fc.integer({ min: 0, max: 5_000 }),
});

/**
 * Arbitrary placements spanning three regimes: valid in-range placements, the
 * unused index 0, and far out-of-range placements (both large and negative) so
 * the "out-of-range yields 0" branch is exercised heavily.
 */
const placementArb: fc.Arbitrary<number> = fc.oneof(
  fc.integer({ min: 0, max: 25 }),
  fc.integer({ min: 100, max: 1_000_000 }),
  fc.integer({ min: -50, max: -1 }),
);

const eliminationCountArb: fc.Arbitrary<number> = fc.nat({ max: 1_000 });

// ---------------------------------------------------------------------------
// Property 10
// ---------------------------------------------------------------------------

describe('Property 10 — prize money matches the formula for all placements', () => {
  it('equals placementPrize(placement) + eliminationCount × eliminationBonus', () => {
    // Validates: Requirements 5.2
    fc.assert(
      fc.property(
        placementArb,
        eliminationCountArb,
        prizeTableArb,
        (placement, eliminationCount, table) => {
          const actual = computePrizeMoney(placement, eliminationCount, table);
          const expected = referencePrizeMoney(placement, eliminationCount, table);
          expect(actual).toBe(expected);
        },
      ),
      { numRuns: 1000 },
    );
  });

  it('awards only the elimination bonus for placements outside the table', () => {
    // Validates: Requirements 5.2
    fc.assert(
      fc.property(
        prizeTableArb,
        eliminationCountArb,
        // A placement guaranteed to be out of range for any generated table
        // (schedules are capped at length 20).
        fc.integer({ min: 1_000, max: 1_000_000 }),
        (table, eliminationCount, placement) => {
          const actual = computePrizeMoney(placement, eliminationCount, table);
          expect(actual).toBe(eliminationCount * table.eliminationBonus);
        },
      ),
      { numRuns: 500 },
    );
  });
});
