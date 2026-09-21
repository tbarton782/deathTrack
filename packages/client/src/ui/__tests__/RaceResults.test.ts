import { describe, expect, it } from 'vitest';
import type { PrizeTable } from '@deathtrack/shared';
import {
  buildResultRows,
  formatPlacement,
  formatPrizeMoney,
  type ParticipantRaceOutcome,
} from '../RaceResults';

/**
 * These tests exercise only the GPU-free results-row model: the data → display
 * row mapping, the placement sort, and the prize-money resolution. They run in
 * the headless `node` vitest environment.
 *
 * The PixiJS `RaceResults` overlay draw path requires a WebGL context and is
 * validated in the browser, not here.
 *
 * Validates: Requirements 11.2 (results screen lists every participant's final
 * placement, elimination count, and prize money earned).
 */

// index 0 unused; placements 1..8, matching CareerService.test.ts fixture.
const prizeTable: PrizeTable = {
  placementPrizes: [0, 10000, 6000, 4000, 2500, 1500, 1000, 500, 250],
  eliminationBonus: 750,
};

function outcome(
  overrides: Partial<ParticipantRaceOutcome> &
    Pick<ParticipantRaceOutcome, 'id' | 'placement'>,
): ParticipantRaceOutcome {
  return {
    displayName: `P${overrides.id}`,
    isAI: false,
    eliminationCount: 0,
    ...overrides,
  };
}

describe('buildResultRows', () => {
  it('orders rows by ascending placement (winner first)', () => {
    const rows = buildResultRows(
      [
        outcome({ id: 2, placement: 3 }),
        outcome({ id: 0, placement: 1 }),
        outcome({ id: 1, placement: 2 }),
      ],
      prizeTable,
    );
    expect(rows.map((r) => r.placement)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.id)).toEqual([0, 1, 2]);
  });

  it('emits one row per participant and preserves display fields', () => {
    const rows = buildResultRows(
      [
        outcome({ id: 0, placement: 1, displayName: 'Melissa', isAI: true }),
        outcome({ id: 1, placement: 2, displayName: 'You' }),
      ],
      prizeTable,
    );
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ displayName: 'Melissa', isAI: true });
    expect(rows[1]).toMatchObject({ displayName: 'You', isAI: false });
  });

  it('computes prize money via the shared formula when not pre-computed', () => {
    // 1st place (10000) + 3 kills × 750 = 12250; 4th place (2500) + 0 = 2500.
    const rows = buildResultRows(
      [
        outcome({ id: 0, placement: 1, eliminationCount: 3 }),
        outcome({ id: 1, placement: 4, eliminationCount: 0 }),
      ],
      prizeTable,
    );
    expect(rows[0]!.prizeMoney).toBe(12250);
    expect(rows[1]!.prizeMoney).toBe(2500);
  });

  it('accepts an already-computed prize amount verbatim', () => {
    const rows = buildResultRows(
      [outcome({ id: 0, placement: 1, eliminationCount: 3, prizeMoney: 99 })],
      prizeTable,
    );
    expect(rows[0]!.prizeMoney).toBe(99);
  });

  it('awards only the elimination bonus for a placement outside the table', () => {
    const rows = buildResultRows(
      [outcome({ id: 0, placement: 99, eliminationCount: 2 })],
      prizeTable,
    );
    expect(rows[0]!.prizeMoney).toBe(1500);
  });

  it('breaks placement ties deterministically by participant id', () => {
    const rows = buildResultRows(
      [
        outcome({ id: 5, placement: 2 }),
        outcome({ id: 1, placement: 2 }),
      ],
      prizeTable,
    );
    expect(rows.map((r) => r.id)).toEqual([1, 5]);
  });

  it('does not mutate the input array', () => {
    const input = [
      outcome({ id: 2, placement: 3 }),
      outcome({ id: 0, placement: 1 }),
    ];
    const snapshot = [...input];
    buildResultRows(input, prizeTable);
    expect(input).toEqual(snapshot);
  });
});

describe('formatPlacement', () => {
  it('renders ordinal suffixes', () => {
    expect(formatPlacement(1)).toBe('1st');
    expect(formatPlacement(2)).toBe('2nd');
    expect(formatPlacement(3)).toBe('3rd');
    expect(formatPlacement(4)).toBe('4th');
  });

  it('handles the 11-13 teens exception', () => {
    expect(formatPlacement(11)).toBe('11th');
    expect(formatPlacement(12)).toBe('12th');
    expect(formatPlacement(13)).toBe('13th');
    expect(formatPlacement(21)).toBe('21st');
  });
});

describe('formatPrizeMoney', () => {
  it('formats whole currency units with a $ prefix and separators', () => {
    expect(formatPrizeMoney(0)).toBe('$0');
    expect(formatPrizeMoney(12250)).toBe('$12,250');
  });
});
