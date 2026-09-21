/**
 * Property-based test for the high-score table invariant — Property 12.
 *
 * **Property 12**: The high-score table is always sorted and capped at 10
 * entries. Concretely, starting from an arbitrary (possibly already-capped)
 * initial table and inserting an arbitrary sequence of entries via repeated
 * {@link addHighScore}, the resulting table always satisfies:
 *
 *   - (a) it is sorted in descending order of `totalEarnings`;
 *   - (b) its length never exceeds {@link HIGH_SCORE_CAPACITY} (10);
 *   - (c) its `rank` fields are the contiguous run 1..n matching the final
 *         order (rank 1 = highest earner); and
 *   - (d) the retained entries are exactly the top-N earners drawn from the
 *         union of the initial table and every inserted entry — no lower
 *         earner is ever kept in preference to a higher one.
 *
 * `addHighScore` is the only mutation exercised. Each step merges one entry,
 * re-sorts descending by `totalEarnings`, caps at the capacity, and renumbers
 * ranks. The invariant must hold after *every* insertion regardless of how the
 * random earnings interleave.
 *
 * **Validates: Requirements 5.9**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { addHighScore, HIGH_SCORE_CAPACITY } from '../CareerService.js';
import type { HighScoreEntry } from '../../types/career.js';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A single high-score entry. `rank` is deliberately arbitrary (including
 * bogus values) so the test proves `addHighScore` renumbers rather than
 * trusting the caller-supplied rank. Earnings are non-negative whole currency
 * units; names are short display strings (1–12 chars, per HighScoreEntry).
 */
const entryArb: fc.Arbitrary<HighScoreEntry> = fc.record({
  rank: fc.integer({ min: -5, max: 999 }),
  playerName: fc.string({ minLength: 1, maxLength: 12 }),
  totalEarnings: fc.integer({ min: 0, max: 1_000_000 }),
});

/**
 * An arbitrary *initial* table: any list of entries, possibly already at or
 * beyond capacity, so we exercise the case where insertion happens into a full
 * table.
 */
const initialTableArb: fc.Arbitrary<HighScoreEntry[]> = fc.array(entryArb, {
  minLength: 0,
  maxLength: 15,
});

/** A sequence of entries to insert one at a time. */
const insertsArb: fc.Arbitrary<HighScoreEntry[]> = fc.array(entryArb, {
  minLength: 0,
  maxLength: 20,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** True when `earnings` is non-increasing across the whole table. */
function isSortedDescending(table: readonly HighScoreEntry[]): boolean {
  for (let i = 1; i < table.length; i++) {
    if (table[i - 1]!.totalEarnings < table[i]!.totalEarnings) return false;
  }
  return true;
}

/**
 * The expected multiset of retained earnings: sort all candidate earnings
 * descending and take the top {@link HIGH_SCORE_CAPACITY}. Comparing the
 * multiset of earnings (rather than identity) sidesteps tie-break ambiguity
 * while still proving no lower earner displaces a higher one.
 */
function expectedTopEarnings(all: readonly HighScoreEntry[]): number[] {
  return all
    .map((e) => e.totalEarnings)
    .sort((a, b) => b - a)
    .slice(0, HIGH_SCORE_CAPACITY);
}

// ---------------------------------------------------------------------------
// Property 12
// ---------------------------------------------------------------------------

describe('CareerService high-score table — Property 12', () => {
  it('is always sorted, capped at 10, contiguously ranked, and keeps the top earners (Req 5.9)', () => {
    fc.assert(
      fc.property(initialTableArb, insertsArb, (initial, inserts) => {
        // The full population of candidate entries seen across all insertions.
        const seen: HighScoreEntry[] = [...initial];

        let table: HighScoreEntry[] = [...initial];

        // Apply every insertion, checking the invariant after each step.
        for (const entry of inserts) {
          table = addHighScore(table, entry);
          seen.push(entry);

          // (b) capped at capacity.
          expect(table.length).toBeLessThanOrEqual(HIGH_SCORE_CAPACITY);

          // (a) sorted descending by earnings.
          expect(isSortedDescending(table)).toBe(true);

          // (c) ranks are the contiguous run 1..n matching order.
          expect(table.map((e) => e.rank)).toEqual(
            table.map((_, i) => i + 1),
          );

          // (d) retained entries are exactly the top-N earners of everything
          // inserted so far (plus the initial table). Note `seen` may contain
          // more than the initial+inserted-so-far entries that were themselves
          // already capped away, but earnings-wise the top-N of the full
          // population equals the top-N of any capped intermediate table,
          // because capping only ever drops the smallest earners.
          const retained = table
            .map((e) => e.totalEarnings)
            .sort((a, b) => b - a);
          expect(retained).toEqual(expectedTopEarnings(seen));
        }

        // With no insertions the table must still be capped and re-ranked from
        // the arbitrary initial state (which addHighScore only normalises on
        // insertion) — so only assert the empty-inserts baseline via a single
        // no-op insertion is unnecessary; the loop already covers >=1 inserts.
      }),
      { numRuns: 300 },
    );
  });

  it('caps and re-ranks even when the initial table already exceeds capacity (Req 5.9)', () => {
    fc.assert(
      fc.property(
        fc.array(entryArb, { minLength: HIGH_SCORE_CAPACITY + 1, maxLength: 25 }),
        entryArb,
        (oversizedInitial, entry) => {
          const table = addHighScore(oversizedInitial, entry);

          expect(table.length).toBe(HIGH_SCORE_CAPACITY);
          expect(isSortedDescending(table)).toBe(true);
          expect(table.map((e) => e.rank)).toEqual(
            table.map((_, i) => i + 1),
          );

          const all = [...oversizedInitial, entry];
          const retained = table
            .map((e) => e.totalEarnings)
            .sort((a, b) => b - a);
          expect(retained).toEqual(expectedTopEarnings(all));
        },
      ),
      { numRuns: 200 },
    );
  });
});
