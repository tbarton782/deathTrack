import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  AdaptiveLod,
  FPS_RECOVERY_TARGET,
  FPS_TARGET,
  FPS_WINDOW_MS,
  LOD_MAX_FRACTION,
  LOD_MIN_FRACTION,
  LOD_STEP_FACTOR,
  reduceLodFraction,
  restoreLodFraction,
} from '../adaptiveLod';

/**
 * Headless unit + property tests for the PURE adaptive-LOD state machine.
 * These run in the `node` vitest environment and never touch PixiJS, WebGL, or
 * requestAnimationFrame — the machine is driven entirely by injected frame
 * deltas, so "time" is advanced deterministically by pushing chosen deltas.
 *
 * Validates: Requirements 2.5 (rolling 5 s average fps) and 2.8 (reduce scenery
 * draw distance by 25% increments after > 2 s sustained < 30 fps, floored at
 * 20% of baseline; recovery steps back up with hysteresis).
 */

// A frame delta (ms) that yields a given steady fps: 1000 / fps ms per frame.
const deltaForFps = (fps: number): number => 1000 / fps;

/** Push `count` identical deltas, returning the transitions seen. */
function pushSteady(lod: AdaptiveLod, deltaMs: number, count: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    out.push(lod.pushFrame(deltaMs));
  }
  return out;
}

/** Push frames at a steady fps for a total wall-clock duration (ms). */
function pushForDuration(lod: AdaptiveLod, fps: number, durationMs: number): void {
  const delta = deltaForFps(fps);
  const frames = Math.ceil(durationMs / delta);
  pushSteady(lod, delta, frames);
}

// ---------------------------------------------------------------------------
// Rolling FPS average over a 5 s window (Requirement 2.5)
// ---------------------------------------------------------------------------

describe('rolling FPS average over the 5 s window (Requirement 2.5)', () => {
  it('reports 0 before any frame is recorded', () => {
    const lod = new AdaptiveLod();
    expect(lod.averageFps).toBe(0);
    expect(lod.sampleCount).toBe(0);
  });

  it('averages a steady 60 fps stream to ~60 fps', () => {
    const lod = new AdaptiveLod();
    pushSteady(lod, deltaForFps(60), 300); // 5 s worth
    expect(lod.averageFps).toBeCloseTo(60, 5);
  });

  it('averages a steady 20 fps stream to ~20 fps', () => {
    const lod = new AdaptiveLod();
    pushSteady(lod, deltaForFps(20), 200);
    expect(lod.averageFps).toBeCloseTo(20, 5);
  });

  it('only retains samples within the trailing 5 s window', () => {
    const lod = new AdaptiveLod();
    // 10 s of 60 fps; the window should hold ~5 s (~300 frames), not all 600.
    pushSteady(lod, deltaForFps(60), 600);
    expect(lod.sampleCount).toBeLessThanOrEqual(301);
    expect(lod.averageFps).toBeCloseTo(60, 3);
  });

  it('reflects a recent drop: window average moves toward the newer rate', () => {
    const lod = new AdaptiveLod();
    // Fill the window with 60 fps then push a full window of 15 fps.
    pushSteady(lod, deltaForFps(60), 300);
    pushForDuration(lod, 15, FPS_WINDOW_MS + 500);
    // Old fast frames have aged out; average is now near 15 fps.
    expect(lod.averageFps).toBeLessThan(FPS_TARGET);
    expect(lod.averageFps).toBeCloseTo(15, 0);
  });
});

// ---------------------------------------------------------------------------
// No reduction until sustained < 30 fps for > 2 s (Requirement 2.8)
// ---------------------------------------------------------------------------

describe('reduction only after > 2 s sustained below target (Requirement 2.8)', () => {
  it('does not reduce while fps stays at/above 30', () => {
    const lod = new AdaptiveLod();
    pushForDuration(lod, 60, 10_000);
    expect(lod.drawDistanceFraction).toBe(LOD_MAX_FRACTION);
    expect(lod.isReduced).toBe(false);
  });

  it('does not reduce for a low-fps burst shorter than 2 s', () => {
    const lod = new AdaptiveLod();
    // ~1.5 s of 20 fps — below target but under the 2 s sustained threshold.
    pushForDuration(lod, 20, 1_500);
    expect(lod.drawDistanceFraction).toBe(LOD_MAX_FRACTION);
  });

  it('reduces exactly once after just over 2 s sustained below target', () => {
    const lod = new AdaptiveLod();
    let reductions = 0;
    const delta = deltaForFps(20); // 50 ms/frame, clearly < 30 fps
    // Push ~2.5 s of low fps; count reduction transitions.
    const frames = Math.ceil(2_500 / delta);
    for (let i = 0; i < frames; i += 1) {
      if (lod.pushFrame(delta) === 'reduced') reductions += 1;
    }
    expect(reductions).toBe(1);
    expect(lod.drawDistanceFraction).toBeCloseTo(LOD_STEP_FACTOR, 10);
  });

  it('does not reduce again until a fresh 2 s of sustained low fps elapses', () => {
    const lod = new AdaptiveLod();
    const delta = deltaForFps(20);
    // First 2.5 s -> exactly one reduction.
    for (let i = 0; i < Math.ceil(2_500 / delta); i += 1) lod.pushFrame(delta);
    expect(lod.drawDistanceFraction).toBeCloseTo(0.75, 10);
    // Another ~1.5 s (still under the fresh 2 s streak) -> no further reduction.
    let reductions = 0;
    for (let i = 0; i < Math.ceil(1_500 / delta); i += 1) {
      if (lod.pushFrame(delta) === 'reduced') reductions += 1;
    }
    expect(reductions).toBe(0);
    expect(lod.drawDistanceFraction).toBeCloseTo(0.75, 10);
  });
});

// ---------------------------------------------------------------------------
// Each reduction is a 25% increment (Requirement 2.8)
// ---------------------------------------------------------------------------

describe('each reduction is a 25% increment (Requirement 2.8)', () => {
  it('steps 1.0 -> 0.75 -> 0.5625 across successive sustained-low periods', () => {
    const lod = new AdaptiveLod();
    const delta = deltaForFps(20);
    const period = Math.ceil(2_100 / delta); // just over 2 s each

    pushSteady(lod, delta, period);
    expect(lod.drawDistanceFraction).toBeCloseTo(0.75, 10);

    pushSteady(lod, delta, period);
    expect(lod.drawDistanceFraction).toBeCloseTo(0.5625, 10);

    pushSteady(lod, delta, period);
    expect(lod.drawDistanceFraction).toBeCloseTo(0.421875, 10);
  });

  it('reduceLodFraction multiplies by 0.75 above the floor', () => {
    expect(reduceLodFraction(1)).toBeCloseTo(0.75, 10);
    expect(reduceLodFraction(0.75)).toBeCloseTo(0.5625, 10);
    expect(reduceLodFraction(0.5625)).toBeCloseTo(0.421875, 10);
  });
});

// ---------------------------------------------------------------------------
// Draw distance never drops below 20% of baseline (Requirement 2.8)
// ---------------------------------------------------------------------------

describe('draw distance floored at 20% of baseline (Requirement 2.8)', () => {
  it('clamps to exactly 0.2 rather than overshooting below', () => {
    // 0.2373... * 0.75 = 0.178... which is below 0.2, so it must clamp to 0.2.
    expect(reduceLodFraction(0.237)).toBe(LOD_MIN_FRACTION);
    expect(reduceLodFraction(LOD_MIN_FRACTION)).toBe(LOD_MIN_FRACTION);
  });

  it('never goes below 0.2 no matter how long fps stays low', () => {
    const lod = new AdaptiveLod();
    // Push 60 s of terrible fps — far more than enough for all steps.
    pushForDuration(lod, 10, 60_000);
    expect(lod.drawDistanceFraction).toBe(LOD_MIN_FRACTION);
    expect(lod.isAtMinimum).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Recovery: steps back up when fps returns above threshold (documented rule)
// ---------------------------------------------------------------------------

describe('recovery steps back up when fps recovers (documented hysteresis rule)', () => {
  it('restores one 25% step after > 2 s at/above the recovery threshold', () => {
    const lod = new AdaptiveLod();
    // Drive down two steps first.
    pushForDuration(lod, 20, 2_200);
    pushForDuration(lod, 20, 2_200);
    expect(lod.drawDistanceFraction).toBeCloseTo(0.5625, 10);

    // Now recover well above the recovery threshold for > 2 s.
    let restores = 0;
    const delta = deltaForFps(60);
    for (let i = 0; i < Math.ceil((FPS_WINDOW_MS + 2_500) / delta); i += 1) {
      if (lod.pushFrame(delta) === 'restored') restores += 1;
    }
    expect(restores).toBeGreaterThanOrEqual(1);
    expect(lod.drawDistanceFraction).toBeGreaterThan(0.5625);
    expect(lod.drawDistanceFraction).toBeLessThanOrEqual(LOD_MAX_FRACTION);
  });

  it('does not step above the 100% baseline', () => {
    const lod = new AdaptiveLod();
    // Never reduced; a long healthy run must not push fraction above 1.
    pushForDuration(lod, 60, 30_000);
    expect(lod.drawDistanceFraction).toBe(LOD_MAX_FRACTION);
  });

  it('holds steady in the hysteresis dead-band [target, recovery)', () => {
    const lod = new AdaptiveLod();
    // Reduce once first.
    pushForDuration(lod, 20, 2_200);
    expect(lod.drawDistanceFraction).toBeCloseTo(0.75, 10);

    // Dead-band fps: >= 30 (never reduces) but < 33 (never recovers).
    const deadband = 31;
    expect(deadband).toBeGreaterThanOrEqual(FPS_TARGET);
    expect(deadband).toBeLessThan(FPS_RECOVERY_TARGET);
    const delta = deltaForFps(deadband);

    // Flush the rolling window so it holds *only* dead-band frames — otherwise
    // the trailing 20 fps samples keep the average below target (the window
    // lags reality, which is correct machine behaviour). Reductions during this
    // flush are expected and not what this test is about.
    for (let i = 0; i < Math.ceil((FPS_WINDOW_MS + 1_000) / delta); i += 1) {
      lod.pushFrame(delta);
    }
    const settled = lod.drawDistanceFraction;

    // Now that the window is pure dead-band fps, no further transitions occur:
    // neither reduces (fps >= target) nor restores (fps < recovery): frozen.
    let transitions = 0;
    for (let i = 0; i < Math.ceil(10_000 / delta); i += 1) {
      if (lod.pushFrame(delta) !== 'none') transitions += 1;
    }
    expect(transitions).toBe(0);
    expect(lod.drawDistanceFraction).toBeCloseTo(settled, 10);
  });

  it('restoreLodFraction divides by 0.75 and caps at 1', () => {
    expect(restoreLodFraction(0.5625)).toBeCloseTo(0.75, 10);
    expect(restoreLodFraction(0.75)).toBeCloseTo(1, 10);
    expect(restoreLodFraction(1)).toBe(LOD_MAX_FRACTION);
    // Stepping up from the clamped floor stays within bounds.
    expect(restoreLodFraction(LOD_MIN_FRACTION)).toBeGreaterThanOrEqual(LOD_MIN_FRACTION);
  });
});

// ---------------------------------------------------------------------------
// Boundary conditions
// ---------------------------------------------------------------------------

describe('boundary conditions', () => {
  it('ignores non-finite and non-positive deltas', () => {
    const lod = new AdaptiveLod();
    expect(lod.pushFrame(NaN)).toBe('none');
    expect(lod.pushFrame(Infinity)).toBe('none');
    expect(lod.pushFrame(0)).toBe('none');
    expect(lod.pushFrame(-16)).toBe('none');
    expect(lod.sampleCount).toBe(0);
    expect(lod.averageFps).toBe(0);
  });

  it('exactly 30 fps is not "below target" and never reduces', () => {
    const lod = new AdaptiveLod();
    pushForDuration(lod, FPS_TARGET, 10_000);
    expect(lod.drawDistanceFraction).toBe(LOD_MAX_FRACTION);
  });

  it('reset() returns to full baseline and empty window', () => {
    const lod = new AdaptiveLod();
    pushForDuration(lod, 20, 3_000);
    expect(lod.isReduced).toBe(true);
    lod.reset();
    expect(lod.drawDistanceFraction).toBe(LOD_MAX_FRACTION);
    expect(lod.sampleCount).toBe(0);
    expect(lod.averageFps).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Property-based invariants
// ---------------------------------------------------------------------------

describe('adaptive-LOD invariants (property-based)', () => {
  it('draw-distance fraction always stays within [0.2, 1] for any delta stream', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 1, max: 500, noNaN: true }), { maxLength: 400 }),
        (deltas) => {
          const lod = new AdaptiveLod();
          for (const d of deltas) {
            lod.pushFrame(d);
            expect(lod.drawDistanceFraction).toBeGreaterThanOrEqual(LOD_MIN_FRACTION);
            expect(lod.drawDistanceFraction).toBeLessThanOrEqual(LOD_MAX_FRACTION);
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  it('reduceLodFraction output is always in [0.2, input] for in-range inputs', () => {
    fc.assert(
      fc.property(fc.double({ min: LOD_MIN_FRACTION, max: 1, noNaN: true }), (f) => {
        const out = reduceLodFraction(f);
        expect(out).toBeGreaterThanOrEqual(LOD_MIN_FRACTION);
        expect(out).toBeLessThanOrEqual(f + 1e-9);
      }),
      { numRuns: 200 },
    );
  });

  it('a healthy 60 fps stream never reduces below baseline', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1200 }), (frames) => {
        const lod = new AdaptiveLod();
        pushSteady(lod, deltaForFps(60), frames);
        expect(lod.drawDistanceFraction).toBe(LOD_MAX_FRACTION);
      }),
      { numRuns: 100 },
    );
  });
});
