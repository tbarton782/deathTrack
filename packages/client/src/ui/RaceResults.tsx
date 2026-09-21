import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import {
  computePrizeMoney,
  type PrizeTable,
  type ParticipantId,
} from '@deathtrack/shared';

/**
 * Race results screen (task 17.2).
 *
 * When a race concludes the game shows every participant's final placement,
 * the number of eliminations they caused, and the prize money they earned
 * (Requirement 11.2). This module follows the same convention as the renderer's
 * {@link createLayers}: the data → display-row mapping is a pure, GPU-free
 * function ({@link buildResultRows}) that can be unit-tested headlessly, while
 * the PixiJS {@link Container} overlay ({@link RaceResults}) only consumes the
 * already-computed rows to draw them.
 *
 * The `.tsx` extension matches the established UI convention for this package:
 * these UI files are PixiJS `Container` overlays (see HUD.tsx, task 17.1), not
 * React component trees. The draw path requires a WebGL context and is verified
 * in the browser, not in the headless test environment.
 */

// ---------------------------------------------------------------------------
// Domain input
// ---------------------------------------------------------------------------

/**
 * The per-participant race outcome fed into the results screen. This is the
 * minimal, transport-agnostic shape the screen needs; callers may derive it
 * from a session's `ParticipantInfo` plus the authoritative finishing order and
 * elimination tallies produced by the simulation.
 */
export interface ParticipantRaceOutcome {
  /** Slot index of the participant (0–7). */
  readonly id: ParticipantId;
  /** Display name shown in the results table (1–20 characters). */
  readonly displayName: string;
  /** `true` for AI-controlled participants; used only for presentation. */
  readonly isAI: boolean;
  /**
   * Final finishing placement (1-based; 1 = winner). A participant that was
   * eliminated and did not finish should still be assigned a placement by the
   * caller so the table is fully ordered.
   */
  readonly placement: number;
  /** Number of opponent eliminations this participant caused during the race. */
  readonly eliminationCount: number;
  /**
   * Pre-computed prize money for this participant, in whole currency units.
   *
   * Optional: when omitted, {@link buildResultRows} computes it from the
   * supplied {@link PrizeTable} using {@link computePrizeMoney}, so the value
   * always matches the shared career formula
   * (`placementPrize(placement) + eliminationCount × eliminationBonus`).
   */
  readonly prizeMoney?: number;
}

/**
 * A single fully-resolved row of the results table, ready to render. Rows are
 * emitted sorted by ascending placement (winner first).
 */
export interface ResultRow {
  readonly placement: number;
  readonly id: ParticipantId;
  readonly displayName: string;
  readonly isAI: boolean;
  readonly eliminationCount: number;
  /** Prize money in whole currency units. */
  readonly prizeMoney: number;
}

// ---------------------------------------------------------------------------
// Pure row/sort model (GPU-free, unit-testable)
// ---------------------------------------------------------------------------

/**
 * Builds the ordered list of results rows from raw per-participant outcomes.
 *
 * Pure and free of any PixiJS / WebGL dependency so it can be exercised
 * headlessly. Responsibilities:
 *
 * - Resolve each participant's prize money. If an outcome already carries a
 *   `prizeMoney` value it is used verbatim (the "accept already-computed
 *   results" path); otherwise the value is computed with the shared
 *   {@link computePrizeMoney} against `prizeTable`, keeping the screen
 *   consistent with `CareerService`'s formula (Requirement 11.2 / 5.2).
 * - Sort rows by ascending placement (1 = winner first). Ties on placement are
 *   broken by ascending participant id so the ordering is deterministic.
 *
 * The input array is not mutated.
 *
 * @param outcomes - Per-participant race outcomes, in any order.
 * @param prizeTable - Prize schedule used to compute prize money for any
 *   outcome that does not already provide it.
 * @returns Results rows sorted by placement, one per input outcome.
 */
export function buildResultRows(
  outcomes: readonly ParticipantRaceOutcome[],
  prizeTable: PrizeTable,
): ResultRow[] {
  const rows: ResultRow[] = outcomes.map((o) => ({
    placement: o.placement,
    id: o.id,
    displayName: o.displayName,
    isAI: o.isAI,
    eliminationCount: o.eliminationCount,
    prizeMoney:
      o.prizeMoney ??
      computePrizeMoney(o.placement, o.eliminationCount, prizeTable),
  }));

  rows.sort((a, b) =>
    a.placement !== b.placement ? a.placement - b.placement : a.id - b.id,
  );

  return rows;
}

/** Renders a placement as an ordinal string (1 → "1st", 2 → "2nd", ...). */
export function formatPlacement(placement: number): string {
  const abs = Math.abs(placement);
  const mod100 = abs % 100;
  const mod10 = abs % 10;
  let suffix = 'th';
  if (mod100 < 11 || mod100 > 13) {
    if (mod10 === 1) suffix = 'st';
    else if (mod10 === 2) suffix = 'nd';
    else if (mod10 === 3) suffix = 'rd';
  }
  return `${placement}${suffix}`;
}

/** Formats prize money in whole currency units with thousands separators. */
export function formatPrizeMoney(amount: number): string {
  return `$${Math.trunc(amount).toLocaleString('en-US')}`;
}

// ---------------------------------------------------------------------------
// PixiJS overlay (browser-only draw path)
// ---------------------------------------------------------------------------

/** Layout constants for the results table draw. */
const ROW_HEIGHT = 28;
const HEADER_HEIGHT = 44;
const PADDING = 24;
const PANEL_WIDTH = 560;

/** Column x-offsets (relative to the panel's left padding). */
const COL_PLACEMENT = 0;
const COL_NAME = 90;
const COL_ELIMS = 380;
const COL_PRIZE = 460;

/**
 * Race results overlay. A self-contained PixiJS {@link Container} that draws a
 * table of every participant's placement, elimination count, and prize money.
 *
 * Construction is GPU-free (PixiJS display objects instantiate without a WebGL
 * context); only attaching the container to a live stage and presenting it
 * requires a renderer. The overlay derives its rows via {@link buildResultRows}
 * so ordering and prize amounts stay consistent with the shared career formula.
 */
export class RaceResults extends Container {
  private readonly bodyRows: ResultRow[];

  /**
   * @param outcomes - Per-participant race outcomes to display.
   * @param prizeTable - Prize schedule used for any outcome lacking a
   *   pre-computed `prizeMoney`.
   */
  constructor(
    outcomes: readonly ParticipantRaceOutcome[],
    prizeTable: PrizeTable,
  ) {
    super();
    this.label = 'raceResults';
    this.bodyRows = buildResultRows(outcomes, prizeTable);
    this.draw();
  }

  /** The rendered rows, in display (placement) order. Exposed for inspection. */
  get rows(): readonly ResultRow[] {
    return this.bodyRows;
  }

  private draw(): void {
    const bodyHeight = this.bodyRows.length * ROW_HEIGHT;
    const panelHeight = HEADER_HEIGHT + bodyHeight + PADDING * 2;

    // Backing panel.
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
    const title = new Text({ text: 'RACE RESULTS', style: titleStyle });
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
      placement: 'POS',
      name: 'DRIVER',
      elims: 'KILLS',
      prize: 'PRIZE',
    });

    const rowStyle = new TextStyle({
      fill: 0xffffff,
      fontFamily: 'monospace',
      fontSize: 14,
    });

    this.bodyRows.forEach((row, index) => {
      const y = PADDING + HEADER_HEIGHT + index * ROW_HEIGHT;
      this.addColumnLabels(rowStyle, y, {
        placement: formatPlacement(row.placement),
        name: row.isAI ? `${row.displayName} (AI)` : row.displayName,
        elims: String(row.eliminationCount),
        prize: formatPrizeMoney(row.prizeMoney),
      });
    });
  }

  private addColumnLabels(
    style: TextStyle,
    y: number,
    values: { placement: string; name: string; elims: string; prize: string },
  ): void {
    const cols: Array<[number, string]> = [
      [COL_PLACEMENT, values.placement],
      [COL_NAME, values.name],
      [COL_ELIMS, values.elims],
      [COL_PRIZE, values.prize],
    ];
    for (const [dx, text] of cols) {
      const label = new Text({ text, style });
      label.position.set(PADDING + dx, y);
      this.addChild(label);
    }
  }
}
