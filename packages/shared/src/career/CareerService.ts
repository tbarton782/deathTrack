/**
 * Career progression service for the Deathtrack Multiplayer Recreation.
 *
 * This module owns the pure business rules governing single-player career
 * progression:
 *
 *   - prize money awarded after a race is exactly the placement prize plus a
 *     fixed elimination bonus per elimination (Req 5.2);
 *   - shop purchases deduct atomically, are rejected with an exact shortfall
 *     when funds are insufficient, and never drive the balance below zero
 *     (Req 5.3, 5.4);
 *   - advancing the circuit steps through the fixed ten-track sequence, wrapping
 *     to a new circuit after track 10 (Req 5.1, 5.6);
 *   - the high-score table keeps the top ten results ranked by descending total
 *     earnings (Req 5.9);
 *   - a new career starts with a fixed money balance, empty owned lists, and the
 *     circuit at track 1 (Req 5.10).
 *
 * Every function here is pure: inputs are never mutated, and each mutating
 * operation returns fresh state. This keeps the service safe to use on both
 * client and server and trivially testable.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5.9, 5.10
 */

import type { CareerState, HighScoreEntry } from '../types/career.js';
import { emptyLoadout } from '../loadout/LoadoutService.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * A minimal success/failure result used by career operations that can be
 * rejected (a purchase with insufficient funds). Mirrors the shape of the
 * loadout service's `Result` for consistency, but carries a career-specific
 * error code so the two domains stay decoupled.
 *
 * `ok: true` carries the produced `value`; `ok: false` carries a machine
 * readable `error` code plus a human-readable `message` suitable for display.
 */
export type CareerResult<T, E = CareerError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E; readonly message: string; readonly shortfall: number };

/** Machine-readable rejection codes for career operations. */
export type CareerError =
  /** The player's balance is less than the item price. Requirements: 5.4 */
  | 'insufficient_funds';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of tracks in a single circuit. The circuit wraps after track 10. */
export const CIRCUIT_TRACK_COUNT = 10;

// ---------------------------------------------------------------------------
// Prize table
// ---------------------------------------------------------------------------

/**
 * The configured prize schedule used to compute post-race winnings.
 *
 * - `placementPrizes` maps a 1-based finishing placement to its prize; index 0
 *   is unused so that `placementPrizes[placement]` reads naturally. A placement
 *   outside the table's range yields a prize of 0.
 * - `eliminationBonus` is the fixed amount awarded per elimination the player
 *   caused during the race.
 *
 * Requirements: 5.2
 */
export interface PrizeTable {
  /** 1-based placement → prize amount. Index 0 is unused (placement is 1-based). */
  readonly placementPrizes: readonly number[];
  /** Fixed bonus awarded per elimination. */
  readonly eliminationBonus: number;
}

/**
 * Look up the placement prize for a 1-based finishing position, returning 0 for
 * any placement not present in the table.
 *
 * Requirements: 5.2
 */
function placementPrize(table: PrizeTable, placement: number): number {
  const prize = table.placementPrizes[placement];
  return prize ?? 0;
}

/**
 * Compute the prize money awarded for a race as exactly
 * `placementPrize(placement) + eliminationCount × eliminationBonus`.
 *
 * Both the placement prize and elimination bonus are drawn from the supplied
 * prize table. Placements outside the table contribute a placement prize of 0.
 *
 * Requirements: 5.2
 */
export function computePrizeMoney(
  placement: number,
  eliminationCount: number,
  prizeTable: PrizeTable,
): number {
  return placementPrize(prizeTable, placement) + eliminationCount * prizeTable.eliminationBonus;
}

// ---------------------------------------------------------------------------
// Shop purchase
// ---------------------------------------------------------------------------

/**
 * Attempt to deduct an item price from the career balance.
 *
 * When `career.money < price` the purchase is rejected with an
 * `insufficient_funds` error carrying the exact shortfall (`price − money`) in
 * whole currency units, and the input career is returned unchanged (via a
 * copy). When `career.money >= price` the purchase succeeds and the returned
 * career has `money` reduced by exactly `price` — never below zero.
 *
 * The input career is never mutated; success returns a fresh `CareerState`.
 *
 * Requirements: 5.3, 5.4
 */
export function purchaseItem(
  career: CareerState,
  itemPrice: number,
): CareerResult<CareerState> {
  if (career.money < itemPrice) {
    const shortfall = itemPrice - career.money;
    return {
      ok: false,
      error: 'insufficient_funds',
      message: `Insufficient funds: need ${shortfall} more to purchase this item.`,
      shortfall,
    };
  }

  return {
    ok: true,
    value: { ...career, money: career.money - itemPrice },
  };
}

// ---------------------------------------------------------------------------
// Circuit advancement
// ---------------------------------------------------------------------------

/**
 * Advance the career to the next race in the circuit.
 *
 * Increments `currentCircuitIndex`. When the index would reach
 * `CIRCUIT_TRACK_COUNT` (all ten tracks completed) it wraps back to 0 and
 * `circuitNumber` increments, representing the start of a fresh circuit at a
 * higher difficulty.
 *
 * The input career is never mutated; a fresh `CareerState` is returned.
 *
 * Requirements: 5.1, 5.6
 */
export function advanceCircuit(career: CareerState): CareerState {
  const nextIndex = career.currentCircuitIndex + 1;
  if (nextIndex >= CIRCUIT_TRACK_COUNT) {
    return {
      ...career,
      currentCircuitIndex: 0,
      circuitNumber: career.circuitNumber + 1,
    };
  }
  return { ...career, currentCircuitIndex: nextIndex };
}

// ---------------------------------------------------------------------------
// High-score table
// ---------------------------------------------------------------------------

/** Maximum number of entries retained in the high-score table. */
export const HIGH_SCORE_CAPACITY = 10;

/**
 * Insert a new entry into the high-score table, re-sort in descending order of
 * `totalEarnings`, cap the table at the top {@link HIGH_SCORE_CAPACITY} entries,
 * and re-number `rank` 1-based to match the final order.
 *
 * The input table and entry are never mutated; a fresh array is returned.
 *
 * Requirements: 5.9
 */
export function addHighScore(
  table: readonly HighScoreEntry[],
  entry: HighScoreEntry,
): HighScoreEntry[] {
  const merged = [...table, entry];
  merged.sort((a, b) => b.totalEarnings - a.totalEarnings);
  const capped = merged.slice(0, HIGH_SCORE_CAPACITY);
  return capped.map((e, i) => ({ ...e, rank: i + 1 }));
}

// ---------------------------------------------------------------------------
// New career
// ---------------------------------------------------------------------------

/**
 * Create a fresh career for the given save slot.
 *
 * Starts with the supplied initial money balance, empty owned-component and
 * owned-weapon lists, an empty default loadout on the `hellcat` chassis, and
 * the circuit positioned at track 1 (`currentCircuitIndex: 0`,
 * `circuitNumber: 1`). Cumulative counters start at zero.
 *
 * Requirements: 5.10
 */
export function newCareer(
  slot: 1 | 2 | 3,
  playerName: string,
  initialMoney: number,
): CareerState {
  return {
    saveSlot: slot,
    playerName,
    money: initialMoney,
    ownedComponents: [],
    ownedWeapons: [],
    currentCircuitIndex: 0,
    circuitNumber: 1,
    currentLoadout: emptyLoadout('hellcat'),
    totalEarnings: 0,
    eliminationCount: 0,
  };
}
