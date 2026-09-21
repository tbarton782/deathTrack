/**
 * Pure, GPU-free adaptive level-of-detail (LOD) state machine for the renderer.
 *
 * Like {@link ./scanline.scanline}, {@link ./carSprite.carSprite} and
 * {@link ./explosion.explosion}, this module contains **no PixiJS / WebGL /
 * requestAnimationFrame dependency**. It is driven entirely by *injected frame
 * deltas* (the wall-clock milliseconds elapsed between two rendered frames), so
 * the whole rolling-FPS + LOD-step logic can be unit-tested headless (in the
 * `node` vitest environment) fully deterministically. The PixiJS glue that
 * feeds it real frame times and applies the resulting scenery draw distance to
 * {@link ./Renderer.Renderer.drawScenery} lives in the renderer.
 *
 * ## What this computes (Requirements 2.5, 2.8)
 *
 * Requirement 2.5: the renderer targets a minimum of 30 fps measured as the
 * **average frame rate over any 5-second window**. This module owns that
 * rolling window: {@link AdaptiveLod.pushFrame} accumulates frame deltas and
 * {@link AdaptiveLod.averageFps} reports the average fps over the trailing
 * 5 seconds of samples.
 *
 * Requirement 2.8: IF the renderer fails to sustain 30 fps for **more than 2
 * consecutive seconds**, THEN it reduces scenery object draw distance by **25%
 * increments** until the target is restored or the **minimum draw distance of
 * 20% of the default** is reached. This module owns that state machine:
 *
 * - It tracks how long the rolling-average fps has been continuously below the
 *   30 fps target. Once that "below" streak exceeds 2 seconds, it drops one LOD
 *   step (multiplying the current draw-distance fraction by 0.75, i.e. a 25%
 *   reduction) and resets the streak timer so the next drop needs a fresh 2 s
 *   of sustained low fps.
 * - Draw distance never drops below 20% of the baseline. The multiplicative
 *   25% steps are `1.0 → 0.75 → 0.5625 → …`; the final step is clamped so the
 *   floor is exactly `0.20 × baseline` rather than overshooting below it.
 *
 * ## Recovery rule (documented design decision)
 *
 * Requirement 2.8 only mandates *reduction*; it does not specify how draw
 * distance returns once the frame rate recovers. We choose a **symmetric,
 * hysteresis-guarded** recovery so the LOD does not oscillate:
 *
 * - Recovery is considered only while the rolling-average fps stays at or above
 *   a *recovery threshold* that sits a margin **above** the 30 fps target
 *   (default 33 fps). Requiring headroom above the target prevents a car that
 *   is hovering right at 30 fps from repeatedly stepping up and immediately
 *   back down.
 * - The recovery streak must be sustained for the same **2 seconds** as the
 *   reduction streak. Once it is, draw distance steps **back up** by one 25%
 *   increment (dividing the fraction by 0.75), never exceeding the 100%
 *   baseline, and the recovery streak resets.
 * - The reduction streak and the recovery streak are mutually exclusive: any
 *   frame that is below the target zeroes the recovery streak, and any frame at
 *   or above the recovery threshold zeroes the reduction streak. Frames in the
 *   dead-band between the target and the recovery threshold hold both streaks
 *   frozen (no change), which is the hysteresis band.
 *
 * All timing is expressed in the injected frame deltas, so a test can advance
 * "time" precisely by pushing a chosen sequence of deltas.
 */

// ---------------------------------------------------------------------------
// Constants (Requirements 2.5, 2.8)
// ---------------------------------------------------------------------------

/** Rolling window over which the average fps is measured (Requirement 2.5). */
export const FPS_WINDOW_MS = 5_000;

/**
 * Target minimum frame rate. Sustained average fps below this for longer than
 * {@link SUSTAINED_LOW_MS} triggers a draw-distance reduction (Requirement 2.8).
 */
export const FPS_TARGET = 30;

/**
 * How long the rolling-average fps must stay continuously below
 * {@link FPS_TARGET} before a reduction fires: "more than 2 consecutive
 * seconds" (Requirement 2.8). The same duration governs a recovery step-up.
 */
export const SUSTAINED_LOW_MS = 2_000;

/**
 * Recovery threshold. The rolling-average fps must be at or above this — a
 * margin above {@link FPS_TARGET} — before draw distance is allowed to step
 * back up. The margin is the hysteresis that stops oscillation around 30 fps.
 */
export const FPS_RECOVERY_TARGET = 33;

/** Fraction retained per reduction step: a 25% reduction (Requirement 2.8). */
export const LOD_STEP_FACTOR = 0.75;

/**
 * Small tolerance (fps) applied when classifying the rolling average against
 * the target. Because the average is derived from summed floating-point frame
 * deltas, a stream intended to sit *exactly* at the 30 fps target can round to
 * 29.9999… fps; without tolerance that would be misclassified as "below target"
 * and wrongly trigger a reduction. The target boundary is inclusive: an average
 * within this epsilon of the target counts as meeting it, not below it.
 */
export const FPS_EPSILON = 1e-6;

/** Full baseline draw distance (100%). */
export const LOD_MAX_FRACTION = 1;

/**
 * Minimum draw-distance fraction: 20% of the baseline (Requirement 2.8). Draw
 * distance never drops below this regardless of how long fps stays low.
 */
export const LOD_MIN_FRACTION = 0.2;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Applies one 25% reduction to a draw-distance fraction, clamped so it never
 * falls below {@link LOD_MIN_FRACTION}. Pure.
 *
 * @param fraction - Current draw-distance fraction in `[LOD_MIN_FRACTION, 1]`.
 * @returns The reduced fraction, floored at `LOD_MIN_FRACTION`.
 */
export function reduceLodFraction(fraction: number): number {
  const next = fraction * LOD_STEP_FACTOR;
  return next < LOD_MIN_FRACTION ? LOD_MIN_FRACTION : next;
}

/**
 * Steps one 25% increment back up, clamped so it never exceeds
 * {@link LOD_MAX_FRACTION}. Because a reduction may have been clamped at the
 * floor, stepping up divides by {@link LOD_STEP_FACTOR} and then re-clamps into
 * `[LOD_MIN_FRACTION, 1]`. Pure.
 *
 * @param fraction - Current draw-distance fraction in `[LOD_MIN_FRACTION, 1]`.
 * @returns The increased fraction, capped at `LOD_MAX_FRACTION`.
 */
export function restoreLodFraction(fraction: number): number {
  const next = fraction / LOD_STEP_FACTOR;
  if (next > LOD_MAX_FRACTION) return LOD_MAX_FRACTION;
  if (next < LOD_MIN_FRACTION) return LOD_MIN_FRACTION;
  return next;
}

/** A change reported by {@link AdaptiveLod.pushFrame}. */
export type LodTransition = 'reduced' | 'restored' | 'none';

/** Options for constructing an {@link AdaptiveLod}. */
export interface AdaptiveLodOptions {
  /** Rolling window length in ms. Defaults to {@link FPS_WINDOW_MS}. */
  readonly windowMs?: number;
  /** Low-fps target in fps. Defaults to {@link FPS_TARGET}. */
  readonly targetFps?: number;
  /** Recovery fps threshold. Defaults to {@link FPS_RECOVERY_TARGET}. */
  readonly recoveryFps?: number;
  /**
   * Sustained duration (ms) that must elapse below the target before a
   * reduction, and above the recovery threshold before a step-up. Defaults to
   * {@link SUSTAINED_LOW_MS}.
   */
  readonly sustainedMs?: number;
}

/**
 * Rolling-FPS tracker + scenery draw-distance LOD state machine (Requirements
 * 2.5, 2.8). Driven purely by injected per-frame deltas — no timers, no
 * `requestAnimationFrame`, no PixiJS — so it is fully deterministic under test.
 *
 * Usage from the renderer's game loop:
 * ```ts
 * const lod = new AdaptiveLod();
 * // each frame:
 * lod.pushFrame(deltaMs);
 * renderer.drawScenery(camera, params, scenery, {
 *   farClipDepth: baselineFarClip * lod.drawDistanceFraction,
 * });
 * ```
 */
export class AdaptiveLod {
  private readonly windowMs: number;
  private readonly targetFps: number;
  private readonly recoveryFps: number;
  private readonly sustainedMs: number;

  /** Trailing frame deltas (ms) within the rolling window. FIFO. */
  private readonly deltas: number[] = [];
  /** Sum of {@link deltas}, kept in sync to avoid re-summing each frame. */
  private windowSumMs = 0;

  /** Current scenery draw-distance fraction of the baseline, in `[0.2, 1]`. */
  private fraction = LOD_MAX_FRACTION;

  /** Continuous ms the rolling-average fps has been below the target. */
  private belowStreakMs = 0;
  /** Continuous ms the rolling-average fps has been at/above the recovery threshold. */
  private aboveStreakMs = 0;

  constructor(options: AdaptiveLodOptions = {}) {
    this.windowMs = options.windowMs ?? FPS_WINDOW_MS;
    this.targetFps = options.targetFps ?? FPS_TARGET;
    this.recoveryFps = options.recoveryFps ?? FPS_RECOVERY_TARGET;
    this.sustainedMs = options.sustainedMs ?? SUSTAINED_LOW_MS;
  }

  /** Current scenery draw-distance fraction of the baseline, in `[0.2, 1]`. */
  get drawDistanceFraction(): number {
    return this.fraction;
  }

  /** Whether draw distance is currently below the full baseline. */
  get isReduced(): boolean {
    return this.fraction < LOD_MAX_FRACTION;
  }

  /** Whether draw distance has hit the 20% floor. */
  get isAtMinimum(): boolean {
    return this.fraction <= LOD_MIN_FRACTION;
  }

  /** Number of frame samples currently in the rolling window. */
  get sampleCount(): number {
    return this.deltas.length;
  }

  /**
   * Average frame rate (fps) over the trailing {@link windowMs} of samples
   * (Requirement 2.5). Returns 0 while no samples have been collected. Computed
   * as `sampleCount / windowSeconds` where `windowSeconds` is the actual span
   * of buffered deltas (capped at the window length), so the value is a true
   * frames-per-second over the retained window rather than an instantaneous
   * reciprocal of the latest delta.
   */
  get averageFps(): number {
    if (this.deltas.length === 0 || this.windowSumMs <= 0) {
      return 0;
    }
    return (this.deltas.length * 1000) / this.windowSumMs;
  }

  /**
   * Feeds one rendered frame's delta (ms since the previous frame) into the
   * tracker and advances the LOD state machine by that same delta. Returns the
   * transition that occurred this frame, if any.
   *
   * Steps:
   * 1. Append the delta to the rolling window and evict the oldest samples so
   *    the retained span does not exceed {@link windowMs}.
   * 2. Compare the rolling-average fps against the target / recovery threshold
   *    to advance the mutually-exclusive below/above streak timers.
   * 3. If the below streak exceeds {@link sustainedMs} and draw distance is not
   *    already at the floor, drop one 25% step and reset the below streak.
   * 4. Else if the above streak exceeds {@link sustainedMs} and draw distance
   *    is below baseline, step up one 25% increment and reset the above streak.
   *
   * @param deltaMs - Milliseconds elapsed since the previous frame. Non-finite
   *   or non-positive deltas are ignored (time does not run backward and a
   *   zero-length frame carries no information).
   * @returns `'reduced'`, `'restored'`, or `'none'`.
   */
  pushFrame(deltaMs: number): LodTransition {
    if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
      return 'none';
    }

    // (1) Roll the window.
    this.deltas.push(deltaMs);
    this.windowSumMs += deltaMs;
    // Evict oldest samples once the retained span exceeds the window. Keep at
    // least one sample so the average is always defined after a push.
    while (this.deltas.length > 1 && this.windowSumMs - this.deltas[0]! >= this.windowMs) {
      this.windowSumMs -= this.deltas.shift()!;
    }

    // (2) Advance the streak timers from the current rolling-average fps.
    const fps = this.averageFps;
    if (fps < this.targetFps - FPS_EPSILON) {
      // Below the target: extend the reduction streak, break recovery.
      this.belowStreakMs += deltaMs;
      this.aboveStreakMs = 0;
    } else if (fps >= this.recoveryFps) {
      // Comfortably above the target: extend the recovery streak, break reduction.
      this.aboveStreakMs += deltaMs;
      this.belowStreakMs = 0;
    } else {
      // Hysteresis dead-band [target, recovery): hold both streaks steady.
    }

    // (3) Reduction takes priority over recovery.
    if (this.belowStreakMs > this.sustainedMs && this.fraction > LOD_MIN_FRACTION) {
      this.fraction = reduceLodFraction(this.fraction);
      this.belowStreakMs = 0;
      return 'reduced';
    }

    // (4) Recovery step-up.
    if (this.aboveStreakMs > this.sustainedMs && this.fraction < LOD_MAX_FRACTION) {
      this.fraction = restoreLodFraction(this.fraction);
      this.aboveStreakMs = 0;
      return 'restored';
    }

    return 'none';
  }

  /**
   * Resets the tracker to its initial state: full baseline draw distance, empty
   * rolling window, cleared streak timers. Useful at race start / teardown.
   */
  reset(): void {
    this.deltas.length = 0;
    this.windowSumMs = 0;
    this.fraction = LOD_MAX_FRACTION;
    this.belowStreakMs = 0;
    this.aboveStreakMs = 0;
  }
}
