/**
 * Behavioural unit tests for the CareerService.
 *
 * Covers each public function: prize money computation, atomic shop purchases
 * with exact shortfall reporting, circuit advancement with wrap-around,
 * high-score insertion/sort/cap, and new-career construction.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5.9, 5.10
 */

import { describe, it, expect } from 'vitest';

import type { CareerState, HighScoreEntry } from '../../types/career.js';
import {
  computePrizeMoney,
  purchaseItem,
  advanceCircuit,
  addHighScore,
  newCareer,
  CIRCUIT_TRACK_COUNT,
  HIGH_SCORE_CAPACITY,
  type PrizeTable,
} from '../CareerService.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const prizeTable: PrizeTable = {
  // index 0 unused; placements 1..8
  placementPrizes: [0, 10000, 6000, 4000, 2500, 1500, 1000, 500, 250],
  eliminationBonus: 750,
};

function makeCareer(overrides: Partial<CareerState> = {}): CareerState {
  return {
    ...newCareer(1, 'Racer', 5000),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computePrizeMoney
// ---------------------------------------------------------------------------

describe('computePrizeMoney', () => {
  it('sums the placement prize and per-elimination bonus (Req 5.2)', () => {
    // 1st place (10000) + 3 eliminations × 750 = 12250
    expect(computePrizeMoney(1, 3, prizeTable)).toBe(12250);
  });

  it('awards only the placement prize when there are no eliminations', () => {
    expect(computePrizeMoney(4, 0, prizeTable)).toBe(2500);
  });

  it('awards only the elimination bonus when placement is outside the table', () => {
    // placement 99 has no prize → 0 + 2 × 750
    expect(computePrizeMoney(99, 2, prizeTable)).toBe(1500);
  });

  it('returns zero for last-place finish with no eliminations', () => {
    expect(computePrizeMoney(99, 0, prizeTable)).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// purchaseItem
// ---------------------------------------------------------------------------

describe('purchaseItem', () => {
  it('deducts the price atomically when funds are sufficient (Req 5.3)', () => {
    const career = makeCareer({ money: 5000 });
    const result = purchaseItem(career, 3000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.money).toBe(2000);
    }
    // input unchanged
    expect(career.money).toBe(5000);
  });

  it('permits spending the entire balance without going below zero', () => {
    const career = makeCareer({ money: 3000 });
    const result = purchaseItem(career, 3000);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.money).toBe(0);
    }
  });

  it('rejects with the exact shortfall when funds are insufficient (Req 5.4)', () => {
    const career = makeCareer({ money: 1200 });
    const result = purchaseItem(career, 2000);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('insufficient_funds');
      expect(result.shortfall).toBe(800);
      expect(result.message).toContain('800');
    }
    // input unchanged
    expect(career.money).toBe(1200);
  });
});

// ---------------------------------------------------------------------------
// advanceCircuit
// ---------------------------------------------------------------------------

describe('advanceCircuit', () => {
  it('increments the track index within a circuit (Req 5.1)', () => {
    const career = makeCareer({ currentCircuitIndex: 0, circuitNumber: 1 });
    const next = advanceCircuit(career);
    expect(next.currentCircuitIndex).toBe(1);
    expect(next.circuitNumber).toBe(1);
  });

  it('wraps to track 1 and increments the circuit number after track 10 (Req 5.6)', () => {
    const career = makeCareer({
      currentCircuitIndex: CIRCUIT_TRACK_COUNT - 1,
      circuitNumber: 1,
    });
    const next = advanceCircuit(career);
    expect(next.currentCircuitIndex).toBe(0);
    expect(next.circuitNumber).toBe(2);
  });

  it('does not mutate the input career', () => {
    const career = makeCareer({ currentCircuitIndex: 2, circuitNumber: 1 });
    advanceCircuit(career);
    expect(career.currentCircuitIndex).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// addHighScore
// ---------------------------------------------------------------------------

describe('addHighScore', () => {
  function entry(name: string, earnings: number): HighScoreEntry {
    return { rank: 0, playerName: name, totalEarnings: earnings };
  }

  it('inserts and sorts entries in descending order of earnings (Req 5.9)', () => {
    const table = addHighScore([entry('A', 100)], entry('B', 300));
    expect(table.map((e) => e.playerName)).toEqual(['B', 'A']);
    expect(table.map((e) => e.totalEarnings)).toEqual([300, 100]);
  });

  it('renumbers ranks 1-based to match final order', () => {
    const table = addHighScore(
      [entry('A', 100), entry('C', 500)],
      entry('B', 300),
    );
    expect(table.map((e) => e.rank)).toEqual([1, 2, 3]);
    expect(table[0]!.playerName).toBe('C');
  });

  it('caps the table at the top 10 entries (Req 5.9)', () => {
    let table: HighScoreEntry[] = [];
    for (let i = 0; i < 15; i++) {
      table = addHighScore(table, entry(`P${i}`, i * 100));
    }
    expect(table).toHaveLength(HIGH_SCORE_CAPACITY);
    // the lowest earners were dropped; top entry is the highest
    expect(table[0]!.totalEarnings).toBe(1400);
    expect(table[HIGH_SCORE_CAPACITY - 1]!.totalEarnings).toBe(500);
  });

  it('does not mutate the input table', () => {
    const original = [entry('A', 100)];
    addHighScore(original, entry('B', 300));
    expect(original).toHaveLength(1);
    expect(original[0]!.rank).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// newCareer
// ---------------------------------------------------------------------------

describe('newCareer', () => {
  it('starts with the initial money, empty owned lists, and circuit at track 1 (Req 5.10)', () => {
    const career = newCareer(2, 'Ada', 8000);
    expect(career.saveSlot).toBe(2);
    expect(career.playerName).toBe('Ada');
    expect(career.money).toBe(8000);
    expect(career.ownedComponents).toEqual([]);
    expect(career.ownedWeapons).toEqual([]);
    expect(career.currentCircuitIndex).toBe(0);
    expect(career.circuitNumber).toBe(1);
    expect(career.totalEarnings).toBe(0);
    expect(career.eliminationCount).toBe(0);
  });

  it('provides an empty default loadout on a valid chassis', () => {
    const career = newCareer(1, 'Ada', 8000);
    expect(career.currentLoadout.chassisId).toBe('hellcat');
    expect(Object.values(career.currentLoadout.weapons).every((w) => w === null)).toBe(true);
    expect(Object.values(career.currentLoadout.components).every((c) => c === null)).toBe(true);
  });
});
