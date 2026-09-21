/**
 * Property-based test for atomic, non-negative career money — Property 11.
 *
 * **Property 11: Career money is non-negative and purchase is atomic.**
 *
 * For an arbitrary career (arbitrary balance) and an arbitrary item price,
 * {@link purchaseItem} exhibits exactly one of two mutually-exclusive
 * behaviours:
 *
 *   (a) It **succeeds** only when `money >= price`. The returned career has
 *       `money === original - price`, and that result is always `>= 0`. Every
 *       other field is carried over unchanged, and the input career is not
 *       mutated.
 *
 *   (b) It **fails** with `insufficient_funds` exactly when `money < price`. The
 *       reported `shortfall` equals `price - money`, and the input career is
 *       returned unchanged. No balance is ever driven negative.
 *
 * The purchase is atomic: either the whole deduction happens (branch a) or
 * nothing changes (branch b) — there is no partial state. We also verify that a
 * *sequence* of arbitrary purchases can never drive the running balance below
 * zero, since each rejected purchase leaves the balance untouched.
 *
 * **Validates: Requirements 5.3, 5.4**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { purchaseItem, newCareer } from '../CareerService.js';
import type { CareerState } from '../../types/career.js';

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** A career with an arbitrary (non-negative) money balance. */
const careerArb: fc.Arbitrary<CareerState> = fc
  .record({
    slot: fc.constantFrom(1, 2, 3) as fc.Arbitrary<1 | 2 | 3>,
    name: fc.string({ minLength: 1, maxLength: 20 }),
    money: fc.nat({ max: 1_000_000 }),
  })
  .map(({ slot, name, money }) => newCareer(slot, name, money));

/** An arbitrary item price in whole currency units (non-negative). */
const priceArb: fc.Arbitrary<number> = fc.nat({ max: 1_000_000 });

// ---------------------------------------------------------------------------
// Property 11 — a single purchase is atomic and non-negative
// ---------------------------------------------------------------------------

describe('Property 11: career money is non-negative and purchase is atomic (Req 5.3, 5.4)', () => {
  it('succeeds iff money >= price, deducting exactly the price and never below zero', () => {
    fc.assert(
      fc.property(careerArb, priceArb, (career, price) => {
        const originalMoney = career.money;
        const result = purchaseItem(career, price);

        if (originalMoney >= price) {
          // Branch (a): success.
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(result.value.money).toBe(originalMoney - price);
            // Never negative.
            expect(result.value.money).toBeGreaterThanOrEqual(0);
            // Only the balance changed; every other field is carried over.
            expect({ ...result.value, money: originalMoney }).toEqual(career);
          }
        } else {
          // Branch (b): rejection with exact shortfall.
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toBe('insufficient_funds');
            expect(result.shortfall).toBe(price - originalMoney);
          }
        }

        // Atomicity: the input career is never mutated in either branch.
        expect(career.money).toBe(originalMoney);
      }),
    );
  });

  it('leaves the input career unchanged whenever the purchase is rejected', () => {
    fc.assert(
      // Constrain to the rejection region: price strictly greater than money.
      fc.property(careerArb, fc.integer({ min: 1, max: 1_000_000 }), (career, extra) => {
        const price = career.money + extra; // guaranteed > money
        const before = { ...career };
        const result = purchaseItem(career, price);

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.shortfall).toBe(price - career.money);
        }
        expect(career).toEqual(before);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 11 — a sequence of purchases never drives money below zero
// ---------------------------------------------------------------------------

describe('Property 11: sequential purchases never drive money below zero (Req 5.3)', () => {
  it('keeps the running balance non-negative across an arbitrary purchase sequence', () => {
    fc.assert(
      fc.property(
        careerArb,
        fc.array(priceArb, { minLength: 0, maxLength: 50 }),
        (initial, prices) => {
          let current = initial;

          for (const price of prices) {
            const result = purchaseItem(current, price);
            if (result.ok) {
              // A successful purchase advances the running state.
              current = result.value;
            }
            // A rejected purchase leaves `current` untouched.

            // Invariant after every step: the balance is never negative.
            expect(current.money).toBeGreaterThanOrEqual(0);
          }

          // The whole sequence preserves non-negativity.
          expect(current.money).toBeGreaterThanOrEqual(0);
        },
      ),
    );
  });
});
