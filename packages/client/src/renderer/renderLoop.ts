/**
 * Render-loop wiring for the renderer (task 15.7).
 *
 * This module has two halves, split so the timing logic is testable without a
 * browser:
 *
 *  1. {@link RenderLoopStepper} — a **pure**, GPU-free, DOM-free fixed-timestep
 *     accumulator. Fed a monotonically increasing timestamp each frame, it
 *     decides how much simulation time has elapsed and reports the render
 *     interpolation factor `alpha ∈ [0, 1]` for that frame (the standard
 *     "fix your timestep" accumulator). It never touches `requestAnimationFrame`
 *     or any global, so it can be driven by an injected clock in unit tests.
 *
 *  2. {@link startRenderLoop} — a **thin** browser-only wrapper that pumps the
 *     stepper from `requestAnimationFrame`. It is the only place that touches
 *     the global `requestAnimationFrame` / `cancelAnimationFrame`, and it does
 *     essentially nothing beyond translating rAF callbacks into stepper calls,
 *     so it needs no unit test — the interesting logic lives in the stepper.
 *
 * The dedicated {@link GameLoop} (task 19.1) will own reading input and stepping
 * the simulation; task 15.7 only provides the render-side timing (`alpha`
 * production) and the rAF wrapper so the renderer can be driven end-to-end.
 *
 * Requirements: 13.2 (60 fps render path), 2.5 (per-frame LOD sampling feeds off
 * the same frame deltas).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Target render/simulation rate: 60 frames per second. */
export const TARGET_FPS = 60;
/** Fixed simulation timestep in milliseconds (1/60 s). */
export const FIXED_TIMESTEP_MS = 1000 / TARGET_FPS;
/**
 * Upper bound on the simulation time consumed in a single frame, in
 * milliseconds. Guards against the "spiral of death" when the tab is
 * backgrounded and the next frame arrives after a long gap: rather than trying
 * to catch up on seconds of simulation at once, we clamp the delta. 250 ms
 * (= 15 fixed steps) is a common choice.
 */
export const MAX_FRAME_DELTA_MS = 250;

// ---------------------------------------------------------------------------
// Pure fixed-timestep stepper
// ---------------------------------------------------------------------------

/** Options for {@link RenderLoopStepper}. */
export interface RenderLoopStepperOptions {
  /** Fixed simulation timestep in ms. Defaults to {@link FIXED_TIMESTEP_MS}. */
  readonly fixedTimestepMs?: number;
  /** Max simulation time consumed per frame in ms. Defaults to {@link MAX_FRAME_DELTA_MS}. */
  readonly maxFrameDeltaMs?: number;
}

/** The result of advancing the stepper by one animation frame. */
export interface FrameStep {
  /** Raw wall-clock milliseconds elapsed since the previous frame (clamped). */
  readonly deltaMs: number;
  /**
   * Number of whole fixed simulation steps that should be run this frame. The
   * game loop should call `stepPhysics` this many times before rendering.
   */
  readonly simulationSteps: number;
  /**
   * The render interpolation factor in `[0, 1]`: the fraction of a fixed
   * timestep that remains in the accumulator after taking `simulationSteps`
   * whole steps. Passed straight to {@link Renderer.render} as `alpha`.
   */
  readonly alpha: number;
}

/**
 * A pure fixed-timestep accumulator that converts irregular animation-frame
 * timestamps into (a) a count of whole simulation steps to run and (b) a render
 * interpolation factor `alpha`.
 *
 * The maths: each frame we add the elapsed wall-clock time to an accumulator,
 * consume as many whole `fixedTimestepMs` chunks as fit (those are the
 * simulation steps), and the leftover fraction of a step becomes
 * `alpha = accumulator / fixedTimestepMs`. `alpha` is what the renderer uses to
 * blend the previous and current simulation snapshots so motion looks smooth
 * even when the display refresh rate differs from 60 Hz.
 *
 * The stepper holds only a tiny amount of mutable state (the last timestamp and
 * the accumulator) and has **no** DOM/GPU dependency, so it is fully unit
 * testable with an injected sequence of timestamps.
 */
export class RenderLoopStepper {
  private readonly fixedTimestepMs: number;
  private readonly maxFrameDeltaMs: number;

  /** Wall-clock timestamp (ms) of the previous frame, or null before the first. */
  private lastTimeMs: number | null = null;
  /** Unconsumed simulation time carried into the next frame, in ms. */
  private accumulatorMs = 0;

  constructor(options: RenderLoopStepperOptions = {}) {
    this.fixedTimestepMs = options.fixedTimestepMs ?? FIXED_TIMESTEP_MS;
    this.maxFrameDeltaMs = options.maxFrameDeltaMs ?? MAX_FRAME_DELTA_MS;
  }

  /**
   * Advances the accumulator to `nowMs` and reports the frame's simulation-step
   * count and render `alpha`.
   *
   * The very first call establishes the timing baseline: it reports zero
   * elapsed time, zero simulation steps, and `alpha = 0` (so the first rendered
   * frame draws the current snapshot exactly). Subsequent calls report the time
   * since the previous call, clamped to {@link maxFrameDeltaMs}.
   *
   * @param nowMs - Current monotonic timestamp in milliseconds (e.g. the value
   *   passed to a `requestAnimationFrame` callback, or an injected clock in
   *   tests). Non-monotonic (backward) timestamps are treated as zero elapsed.
   * @returns The {@link FrameStep} for this frame.
   */
  step(nowMs: number): FrameStep {
    if (this.lastTimeMs === null) {
      this.lastTimeMs = nowMs;
      return { deltaMs: 0, simulationSteps: 0, alpha: this.currentAlpha() };
    }

    let delta = nowMs - this.lastTimeMs;
    this.lastTimeMs = nowMs;

    // Guard against backward clocks and long stalls (backgrounded tab).
    if (!(delta > 0)) {
      delta = 0;
    } else if (delta > this.maxFrameDeltaMs) {
      delta = this.maxFrameDeltaMs;
    }

    this.accumulatorMs += delta;

    let steps = 0;
    while (this.accumulatorMs >= this.fixedTimestepMs) {
      this.accumulatorMs -= this.fixedTimestepMs;
      steps++;
    }

    return {
      deltaMs: delta,
      simulationSteps: steps,
      alpha: this.currentAlpha(),
    };
  }

  /** The render interpolation factor for the current accumulator state. */
  private currentAlpha(): number {
    if (!(this.fixedTimestepMs > 0)) {
      return 0;
    }
    const alpha = this.accumulatorMs / this.fixedTimestepMs;
    if (alpha < 0) return 0;
    if (alpha > 1) return 1;
    return alpha;
  }

  /** The interpolation factor that the next {@link step} would report. */
  get alpha(): number {
    return this.currentAlpha();
  }

  /**
   * Resets the stepper to its pre-first-frame state (next {@link step} re-baselines
   * the clock). Call when the loop is stopped and restarted, or when the
   * simulation is reset, to avoid a large catch-up on resume.
   */
  reset(): void {
    this.lastTimeMs = null;
    this.accumulatorMs = 0;
  }
}

// ---------------------------------------------------------------------------
// Thin browser rAF wrapper
// ---------------------------------------------------------------------------

/** A handle returned by {@link startRenderLoop} used to stop the loop. */
export interface RenderLoopHandle {
  /** Stops the loop and cancels any pending animation-frame request. */
  stop(): void;
  /** Whether the loop is currently running. */
  readonly running: boolean;
}

/**
 * The per-frame callback invoked by {@link startRenderLoop}. Receives the pure
 * {@link FrameStep} computed for the frame (simulation-step count + render
 * `alpha`). The renderer's game loop implements this to step the simulation and
 * call `render(state, alpha)`.
 */
export type RenderLoopCallback = (frame: FrameStep) => void;

/**
 * Optional injection points for {@link startRenderLoop}, so even the thin
 * wrapper can be exercised without a browser if ever needed. Both default to
 * the browser globals.
 */
export interface RenderLoopEnv {
  readonly requestAnimationFrame?: (cb: (timeMs: number) => void) => number;
  readonly cancelAnimationFrame?: (handle: number) => void;
}

/**
 * Starts a `requestAnimationFrame`-driven render loop that pumps a
 * {@link RenderLoopStepper} and invokes `onFrame` once per animation frame with
 * the computed {@link FrameStep}.
 *
 * This wrapper is deliberately minimal: it owns only the rAF scheduling and the
 * running flag. All timing decisions live in the (unit-tested)
 * {@link RenderLoopStepper}; all drawing lives in `onFrame`. Because it is the
 * sole toucher of `requestAnimationFrame`, keeping WebGL/rAF out of the tested
 * path, it is validated in the browser rather than in headless unit tests.
 *
 * @param onFrame - Called each frame with the frame's step/alpha.
 * @param stepper - The stepper to pump; defaults to a fresh one at 60 fps.
 * @param env - Optional rAF/cancel overrides (default: browser globals).
 * @returns A handle to stop the loop.
 */
export function startRenderLoop(
  onFrame: RenderLoopCallback,
  stepper: RenderLoopStepper = new RenderLoopStepper(),
  env: RenderLoopEnv = {},
): RenderLoopHandle {
  const raf =
    env.requestAnimationFrame ??
    (globalThis.requestAnimationFrame?.bind(globalThis) as
      | ((cb: (timeMs: number) => void) => number)
      | undefined);
  const caf =
    env.cancelAnimationFrame ??
    (globalThis.cancelAnimationFrame?.bind(globalThis) as
      | ((handle: number) => void)
      | undefined);

  if (!raf || !caf) {
    throw new Error(
      'startRenderLoop requires requestAnimationFrame; run in a browser or pass env overrides',
    );
  }

  let running = true;
  let handle = 0;

  const tick = (timeMs: number): void => {
    if (!running) {
      return;
    }
    onFrame(stepper.step(timeMs));
    handle = raf(tick);
  };

  handle = raf(tick);

  return {
    stop(): void {
      if (!running) {
        return;
      }
      running = false;
      caf(handle);
    },
    get running(): boolean {
      return running;
    },
  };
}
