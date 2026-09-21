import { describe, expect, it, vi } from 'vitest';
import { HIGH_SCORE_CAPACITY, type HighScoreEntry } from '@deathtrack/shared';
import {
  buildHighScoreRows,
  isValidPlayerName,
  loadHighScoreTable,
  formatEarnings,
  PLAYER_NAME_MIN_LENGTH,
  PLAYER_NAME_MAX_LENGTH,
} from '../HighScores';

/**
 * These tests exercise only the GPU-free high-score model: the raw table →
 * ranked top-10 row mapping, the player-name length validation, and the
 * persistence-source resolver. They run in the headless `node` vitest
 * environment.
 *
 * The PixiJS `HighScores` overlay draw path requires a WebGL context and is
 * validated in the browser, not here; only the callback-wiring seam
 * (`submitName`) is constructed headlessly.
 *
 * Validates: Requirements 5.9 (high-score table shows the top 10 career results
 * ranked by total earnings in descending order; each entry records the
 * player-entered name (1–12 characters) and total earnings).
 */

function entry(overrides: Partial<HighScoreEntry> = {}): HighScoreEntry {
  return {
    rank: 0,
    playerName: 'PLAYER',
    totalEarnings: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// buildHighScoreRows — descending sort + top-10 cap + 1-based re-rank
// ---------------------------------------------------------------------------

describe('buildHighScoreRows', () => {
  it('sorts rows by total earnings in descending order (highest first)', () => {
    const rows = buildHighScoreRows([
      entry({ playerName: 'MID', totalEarnings: 5000 }),
      entry({ playerName: 'LOW', totalEarnings: 1000 }),
      entry({ playerName: 'TOP', totalEarnings: 9000 }),
    ]);
    expect(rows.map((r) => r.totalEarnings)).toEqual([9000, 5000, 1000]);
    expect(rows.map((r) => r.playerName)).toEqual(['TOP', 'MID', 'LOW']);
  });

  it('re-numbers rank 1-based to match the final display order', () => {
    const rows = buildHighScoreRows([
      entry({ playerName: 'A', totalEarnings: 100, rank: 99 }),
      entry({ playerName: 'B', totalEarnings: 300, rank: 7 }),
      entry({ playerName: 'C', totalEarnings: 200, rank: 3 }),
    ]);
    expect(rows.map((r) => r.rank)).toEqual([1, 2, 3]);
    // rank 1 is the highest earner regardless of the stale input rank
    expect(rows[0]).toMatchObject({ playerName: 'B', totalEarnings: 300 });
  });

  it('caps the table at the top 10 entries, keeping only the highest earners', () => {
    // 15 entries with distinct earnings 100..1500.
    const table = Array.from({ length: 15 }, (_, i) =>
      entry({ playerName: `P${i}`, totalEarnings: (i + 1) * 100 }),
    );
    const rows = buildHighScoreRows(table);
    expect(rows).toHaveLength(HIGH_SCORE_CAPACITY);
    expect(rows).toHaveLength(10);
    // top row is the max (1500); the smallest kept is the 10th-highest (600).
    expect(rows[0]!.totalEarnings).toBe(1500);
    expect(rows.at(-1)!.totalEarnings).toBe(600);
    // every kept entry outranks every dropped one
    const keptMin = Math.min(...rows.map((r) => r.totalEarnings));
    expect(keptMin).toBe(600);
  });

  it('breaks earnings ties deterministically by ascending player name', () => {
    const rows = buildHighScoreRows([
      entry({ playerName: 'CHARLIE', totalEarnings: 500 }),
      entry({ playerName: 'ALPHA', totalEarnings: 500 }),
      entry({ playerName: 'BRAVO', totalEarnings: 500 }),
    ]);
    expect(rows.map((r) => r.playerName)).toEqual(['ALPHA', 'BRAVO', 'CHARLIE']);
  });

  it('returns an empty list for an empty table', () => {
    expect(buildHighScoreRows([])).toEqual([]);
  });

  it('does not mutate the input table', () => {
    const table = [
      entry({ playerName: 'A', totalEarnings: 100 }),
      entry({ playerName: 'B', totalEarnings: 300 }),
    ];
    const snapshot = table.map((e) => ({ ...e }));
    buildHighScoreRows(table);
    expect(table).toEqual(snapshot);
  });
});

// ---------------------------------------------------------------------------
// isValidPlayerName — 1–12 character boundaries
// ---------------------------------------------------------------------------

describe('isValidPlayerName', () => {
  it('exposes the 1–12 character bounds', () => {
    expect(PLAYER_NAME_MIN_LENGTH).toBe(1);
    expect(PLAYER_NAME_MAX_LENGTH).toBe(12);
  });

  it('rejects a 0-character (empty) name', () => {
    expect(isValidPlayerName('')).toBe(false);
  });

  it('accepts a 1-character name (lower boundary)', () => {
    expect(isValidPlayerName('A')).toBe(true);
  });

  it('accepts a 12-character name (upper boundary)', () => {
    expect(isValidPlayerName('ABCDEFGHIJKL')).toBe(true); // 12 chars
    expect('ABCDEFGHIJKL'.length).toBe(12);
  });

  it('rejects a 13-character name (just over the upper boundary)', () => {
    expect(isValidPlayerName('ABCDEFGHIJKLM')).toBe(false); // 13 chars
    expect('ABCDEFGHIJKLM'.length).toBe(13);
  });

  it('counts astral characters by code point, not UTF-16 code unit', () => {
    // 12 emoji = 12 code points (24 UTF-16 code units) -> valid.
    expect(isValidPlayerName('\u{1F600}'.repeat(12))).toBe(true);
    // 13 emoji -> invalid.
    expect(isValidPlayerName('\u{1F600}'.repeat(13))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// loadHighScoreTable — normalises table / sync loader / async loader
// ---------------------------------------------------------------------------

describe('loadHighScoreTable', () => {
  const table = [entry({ playerName: 'A', totalEarnings: 100 })];

  it('returns a plain table verbatim', async () => {
    expect(await loadHighScoreTable(table)).toEqual(table);
  });

  it('invokes and returns a synchronous loader result', async () => {
    expect(await loadHighScoreTable(() => table)).toEqual(table);
  });

  it('awaits an asynchronous loader result', async () => {
    expect(await loadHighScoreTable(async () => table)).toEqual(table);
  });
});

// ---------------------------------------------------------------------------
// formatEarnings
// ---------------------------------------------------------------------------

describe('formatEarnings', () => {
  it('formats whole currency units with a $ prefix and separators', () => {
    expect(formatEarnings(0)).toBe('$0');
    expect(formatEarnings(9000)).toBe('$9,000');
    expect(formatEarnings(1234567)).toBe('$1,234,567');
  });
});

// ---------------------------------------------------------------------------
// HighScores overlay — name entry callback wiring (constructed headlessly)
// ---------------------------------------------------------------------------

describe('HighScores.submitName (new-career name entry)', () => {
  const table = [entry({ playerName: 'A', totalEarnings: 100 })];

  it('submits a valid name in entry mode with the pending earnings', async () => {
    const { HighScores } = await import('../HighScores');
    const onSubmit = vi.fn();
    const screen = new HighScores(table, { pendingEarnings: 7500, onSubmit });
    expect(screen.isEntryMode).toBe(true);
    const ok = screen.submitName('WINNER');
    expect(ok).toBe(true);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]![0]).toMatchObject({
      playerName: 'WINNER',
      totalEarnings: 7500,
    });
  });

  it('rejects an invalid (empty) name and submits nothing', async () => {
    const { HighScores } = await import('../HighScores');
    const onSubmit = vi.fn();
    const screen = new HighScores(table, { pendingEarnings: 7500, onSubmit });
    expect(screen.submitName('')).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('rejects a name longer than 12 characters', async () => {
    const { HighScores } = await import('../HighScores');
    const onSubmit = vi.fn();
    const screen = new HighScores(table, { pendingEarnings: 7500, onSubmit });
    expect(screen.submitName('ABCDEFGHIJKLM')).toBe(false); // 13 chars
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('does not submit when not in entry mode', async () => {
    const { HighScores } = await import('../HighScores');
    const onSubmit = vi.fn();
    const screen = new HighScores(table, { onSubmit });
    expect(screen.isEntryMode).toBe(false);
    expect(screen.submitName('WINNER')).toBe(false);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('exposes the ranked top-10 rows on the overlay', async () => {
    const { HighScores } = await import('../HighScores');
    const screen = new HighScores([
      entry({ playerName: 'LOW', totalEarnings: 100 }),
      entry({ playerName: 'HIGH', totalEarnings: 900 }),
    ]);
    expect(screen.rows.map((r) => r.playerName)).toEqual(['HIGH', 'LOW']);
    expect(screen.rows.map((r) => r.rank)).toEqual([1, 2]);
  });
});
