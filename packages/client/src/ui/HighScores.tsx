import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import { HIGH_SCORE_CAPACITY, type HighScoreEntry } from '@deathtrack/shared';

/**
 * High-scores screen (task 17.11).
 *
 * The game keeps a persistent high-score table of the top 10 career results,
 * ranked by total earnings in descending order; each entry records the
 * player-entered name (1–12 characters) and their total earnings, and the
 * table survives between application launches (Requirement 5.9). When a new
 * career completes the player is prompted to enter a name to associate with
 * their run before it is inserted into the table.
 *
 * As with the other UI files in this package (see `RaceResults.tsx`,
 * `Shop.tsx`, `MainMenu.tsx`, `HUD.tsx`, `Settings.tsx`), the `.tsx` extension
 * is a naming convention only: these screens are PixiJS {@link Container}
 * overlays, not React component trees. The GPU-free logic — building the
 * sorted, capped top-10 rows from a raw table, and validating an entered player
 * name — lives in pure, headlessly unit-tested functions
 * ({@link buildHighScoreRows}, {@link isValidPlayerName}), while the PixiJS
 * overlay ({@link HighScores}) only consumes the already-computed rows to draw
 * them. The draw path requires a WebGL context and is verified in the browser.
 *
 * The raw high-score table is read from the shared persistence layer. Rather
 * than reach into a concrete store, the overlay is handed the raw table (or a
 * loader for it) so it stays decoupled from IndexedDB / `fs` and is testable
 * headlessly.
 *
 * Requirements: 5.9
 */

// ---------------------------------------------------------------------------
// Player-name validation (GPU-free, unit-testable)
// ---------------------------------------------------------------------------

/** Minimum length of a valid high-score player name, in characters. */
export const PLAYER_NAME_MIN_LENGTH = 1;
/** Maximum length of a valid high-score player name, in characters. */
export const PLAYER_NAME_MAX_LENGTH = 12;

/**
 * Validate a player name entered on career completion.
 *
 * A name is valid when its length is within the inclusive range
 * [{@link PLAYER_NAME_MIN_LENGTH}, {@link PLAYER_NAME_MAX_LENGTH}] — i.e. 1–12
 * characters (Requirement 5.9). Length is measured in Unicode code points so a
 * name composed of astral characters (emoji, etc.) is counted the same way a
 * player perceives it, rather than by UTF-16 code units.
 *
 * The name is validated verbatim: this predicate does not trim surrounding
 * whitespace, so callers that wish to reject whitespace-only names should trim
 * before calling.
 *
 * @param name - The candidate player name.
 * @returns `true` when the name has 1–12 characters, `false` otherwise.
 */
export function isValidPlayerName(name: string): boolean {
  const length = [...name].length;
  return length >= PLAYER_NAME_MIN_LENGTH && length <= PLAYER_NAME_MAX_LENGTH;
}

// ---------------------------------------------------------------------------
// Pure row model (GPU-free, unit-testable)
// ---------------------------------------------------------------------------

/**
 * A single fully-resolved high-score row, ready to render. Rows are emitted in
 * ranked order (rank 1 = highest earner first) with `rank` re-numbered 1-based
 * to match their final position, regardless of any stale `rank` on the input.
 */
export interface HighScoreRow {
  /** 1-based position in the table (1 = highest earner). */
  readonly rank: number;
  /** Display name as entered at career completion (1–12 characters). */
  readonly playerName: string;
  /** Total prize money earned across the full career. */
  readonly totalEarnings: number;
}

/**
 * Build the display rows for the high-score screen from a raw saved table.
 *
 * Pure and free of any PixiJS / WebGL dependency so it can be exercised
 * headlessly. Responsibilities (Requirement 5.9):
 *
 * - Sort entries by `totalEarnings` in descending order (highest earner first).
 *   Ties are broken by ascending `playerName` so the ordering is deterministic.
 * - Cap the table at the top {@link HIGH_SCORE_CAPACITY} (10) entries, matching
 *   the shared `addHighScore` rule that maintains the persisted table.
 * - Re-number `rank` 1-based to match the final display order, so the rendered
 *   rank is always correct even if the stored `rank` is stale.
 *
 * The input array is not mutated.
 *
 * @param table - The raw high-score entries read from persistence, in any order.
 * @returns The top-10 rows, sorted by descending earnings and ranked 1-based.
 */
export function buildHighScoreRows(
  table: readonly HighScoreEntry[],
): HighScoreRow[] {
  const sorted = [...table].sort((a, b) => {
    if (a.totalEarnings !== b.totalEarnings) {
      return b.totalEarnings - a.totalEarnings;
    }
    return a.playerName < b.playerName ? -1 : a.playerName > b.playerName ? 1 : 0;
  });

  return sorted.slice(0, HIGH_SCORE_CAPACITY).map((entry, index) => ({
    rank: index + 1,
    playerName: entry.playerName,
    totalEarnings: entry.totalEarnings,
  }));
}

/** Formats an earnings amount in whole currency units with thousands separators. */
export function formatEarnings(amount: number): string {
  return `$${Math.trunc(amount).toLocaleString('en-US')}`;
}

// ---------------------------------------------------------------------------
// Persistence source (injected, GPU-free)
// ---------------------------------------------------------------------------

/**
 * A source of the persisted high-score table. Injecting the read behind this
 * type keeps the overlay decoupled from the concrete byte store (IndexedDB in
 * the browser, `fs` on the server) and lets tests supply a plain array.
 *
 * A source may be the table itself, or a synchronous / asynchronous loader that
 * resolves to it; {@link loadHighScoreTable} normalises all three forms.
 */
export type HighScoreSource =
  | readonly HighScoreEntry[]
  | (() => readonly HighScoreEntry[])
  | (() => Promise<readonly HighScoreEntry[]>);

/**
 * Resolve a {@link HighScoreSource} into the raw high-score table, awaiting a
 * loader when one is supplied. The result is not yet sorted or capped; feed it
 * to {@link buildHighScoreRows} for display.
 */
export async function loadHighScoreTable(
  source: HighScoreSource,
): Promise<readonly HighScoreEntry[]> {
  const resolved = typeof source === 'function' ? await source() : source;
  return resolved;
}

// ---------------------------------------------------------------------------
// PixiJS overlay (browser-only draw path)
// ---------------------------------------------------------------------------

/** Layout constants for the high-score table draw. */
const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 44;
const PADDING = 24;
const PANEL_WIDTH = 480;

/** Column x-offsets (relative to the panel's left padding). */
const COL_RANK = 0;
const COL_NAME = 70;
const COL_EARNINGS = 320;

/**
 * Callback invoked when the player confirms a name for a new high-score entry
 * on career completion. Injecting the side effect behind a callback keeps the
 * overlay testable and decoupled from the career controller: the overlay itself
 * performs no persistence. Implementations typically call the shared
 * `addHighScore` and write the result back through the persistence layer.
 */
export type HighScoreSubmitHandler = (entry: HighScoreEntry) => void;

/**
 * High-scores overlay. A self-contained PixiJS {@link Container} that draws the
 * top-10 career results ranked by descending total earnings, and — when created
 * for a freshly completed career — exposes a name-entry action that validates
 * the entered name (1–12 characters) before submitting the new entry.
 *
 * Construction is GPU-free (PixiJS display objects instantiate without a WebGL
 * context); only attaching the container to a live stage and presenting it
 * requires a renderer. Rows are derived via {@link buildHighScoreRows} so the
 * ordering and cap stay consistent with the shared high-score rule.
 */
export class HighScores extends Container {
  private readonly bodyRows: HighScoreRow[];
  private readonly pendingEarnings: number | undefined;
  private readonly onSubmit: HighScoreSubmitHandler | undefined;

  /**
   * @param table - The raw high-score table read from persistence.
   * @param options - Optional new-career entry configuration. When
   *   `pendingEarnings` is provided the overlay is in name-entry mode for a
   *   just-completed career; {@link submitName} validates and forwards the new
   *   entry to `onSubmit`.
   */
  constructor(
    table: readonly HighScoreEntry[],
    options?: {
      readonly pendingEarnings?: number;
      readonly onSubmit?: HighScoreSubmitHandler;
    },
  ) {
    super();
    this.label = 'highScores';
    this.bodyRows = buildHighScoreRows(table);
    this.pendingEarnings = options?.pendingEarnings;
    this.onSubmit = options?.onSubmit;
    this.draw();
  }

  /** The rendered rows, in ranked (descending-earnings) order. */
  get rows(): readonly HighScoreRow[] {
    return this.bodyRows;
  }

  /** `true` when the overlay is prompting for a new-career name entry. */
  get isEntryMode(): boolean {
    return this.pendingEarnings !== undefined;
  }

  /**
   * Submit a player name for the pending new-career high-score entry.
   *
   * The name is validated with {@link isValidPlayerName} (1–12 characters). A
   * valid name in entry mode forwards a fully-formed {@link HighScoreEntry}
   * (with the pending earnings and a provisional rank of 0 — the persisted
   * `addHighScore` re-ranks on insert) to the injected handler and returns
   * `true`. An invalid name, or a call made when not in entry mode, submits
   * nothing and returns `false`.
   *
   * @param name - The player name entered on career completion.
   * @returns `true` if the name was valid and the entry was submitted.
   */
  submitName(name: string): boolean {
    if (this.pendingEarnings === undefined) return false;
    if (!isValidPlayerName(name)) return false;
    this.onSubmit?.({
      rank: 0,
      playerName: name,
      totalEarnings: this.pendingEarnings,
    });
    return true;
  }

  private draw(): void {
    const bodyHeight = this.bodyRows.length * ROW_HEIGHT;
    const panelHeight = HEADER_HEIGHT + bodyHeight + PADDING * 2;

    const panel = new Graphics();
    panel
      .roundRect(0, 0, PANEL_WIDTH, panelHeight, 8)
      .fill({ color: 0x0a0a12, alpha: 0.92 })
      .stroke({ color: 0x3355aa, width: 2 });
    this.addChild(panel);

    const titleStyle = new TextStyle({
      fill: 0xffcc33,
      fontFamily: 'monospace',
      fontSize: 22,
      fontWeight: 'bold',
    });
    const title = new Text({ text: 'HIGH SCORES', style: titleStyle });
    title.position.set(PADDING, PADDING - 6);
    this.addChild(title);

    const headerStyle = new TextStyle({
      fill: 0x8899cc,
      fontFamily: 'monospace',
      fontSize: 13,
      fontWeight: 'bold',
    });
    const headerY = PADDING + HEADER_HEIGHT - 20;
    this.addColumnLabels(headerStyle, headerY, {
      rank: 'RANK',
      name: 'NAME',
      earnings: 'EARNINGS',
    });

    const rowStyle = new TextStyle({
      fill: 0xffffff,
      fontFamily: 'monospace',
      fontSize: 14,
    });

    this.bodyRows.forEach((row, index) => {
      const y = PADDING + HEADER_HEIGHT + index * ROW_HEIGHT;
      this.addColumnLabels(rowStyle, y, {
        rank: `${row.rank}.`,
        name: row.playerName,
        earnings: formatEarnings(row.totalEarnings),
      });
    });
  }

  private addColumnLabels(
    style: TextStyle,
    y: number,
    values: { rank: string; name: string; earnings: string },
  ): void {
    const cols: Array<[number, string]> = [
      [COL_RANK, values.rank],
      [COL_NAME, values.name],
      [COL_EARNINGS, values.earnings],
    ];
    for (const [dx, text] of cols) {
      const label = new Text({ text, style });
      label.position.set(PADDING + dx, y);
      this.addChild(label);
    }
  }
}
