import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  FIXED_TIMESTEP_MS,
  MAX_FRAME_DELTA_MS,
  RenderLoopStepper,
  startRenderLoop,
  TARGET_FPS,
  type FrameStep,
} from '../renderLoop';

/**
 * Headless unit + property tests for the fixed-timestep render-loop stepper
 * (task 15.7). The stepper is pure and DOM-free, driven by an injected sequence
 * of timestamps, so it runs under the `node` vitest environment with no rAF and
 * no WebGL. The thin `startRenderLoop` rAF wrapper is exercised with injected
 * fake `requestAnimationFrame`/`cancelAnimationFrame`.
 *
 * Validates: Requirements 13.2 (60 fps render loop), 2.5 (per-frame delta feed).
 */

describe('RenderLoopStepper constants', () => {
  it('targets 60 fps with a ~16.67 ms fixed step', () => {
    expect(TARGET_FPS).toBe(60);
    expect(FIXED_TIMESTEP_MS).toBeCloseTo(1000 / 60, 6);
  });
});

describe('RenderLoopStepper.step', () => {
  it('first frame establishes a baseline: zero delta, zero steps, alpha 0', () => {
    const s = new RenderLoopStepper();
    const first = s.step(1000);
    expect(first.deltaMs).toBe(0);
    expect(first.simulationSteps).toBe(0);
    expect(first.alpha).toBe(0);
  });

  it('runs exactly one simulation step per fixed timestep elapsed', () => {
    const s = new RenderLoopStepper();
    s.step(0);
    const f = s.step(FIXED_TIMESTEP_MS);
    expect(f.simulationSteps).toBe(1);
    expect(f.alpha).toBeCloseTo(0, 6);
  });

  it('reports a fractional alpha for a partial timestep', () => {
    const s = new RenderLoopStepper();
    s.step(0);
    const f = s.step(FIXED_TIMESTEP_MS / 2);
    expect(f.simulationSteps).toBe(0);
    expect(f.alpha).toBeCloseTo(0.5, 6);
  });

  it('accumulates multiple whole steps for a long frame', () => {
    const s = new RenderLoopStepper();
    s.step(0);
    // Nudge just past 3 whole steps so floating-point accumulation of the
    // 16.666… ms step lands unambiguously above the third boundary.
    const f = s.step(FIXED_TIMESTEP_MS * 3 + 0.01);
    expect(f.simulationSteps).toBe(3);
    expect(f.alpha).toBeCloseTo(0, 2);
  });

  it('carries the accumulator remainder across frames', () => {
    const s = new RenderLoopStepper();
    s.step(0);
    // 1.5 steps elapsed: 1 whole step now, ~0.5 left over.
    const a = s.step(FIXED_TIMESTEP_MS * 1.5);
    expect(a.simulationSteps).toBe(1);
    expect(a.alpha).toBeCloseTo(0.5, 6);
    // Total elapsed now 3 steps + a nudge: leftover 0.5 + 1.5 (+ε) → 2 steps.
    const b = s.step(FIXED_TIMESTEP_MS * 3.0 + 0.01);
    expect(b.simulationSteps).toBe(2);
    expect(b.alpha).toBeCloseTo(0, 2);
  });

  it('clamps an over-long frame to MAX_FRAME_DELTA_MS', () => {
    const s = new RenderLoopStepper();
    s.step(0);
    const f = s.step(10_000); // 10 s stall
    expect(f.deltaMs).toBe(MAX_FRAME_DELTA_MS);
    // At most ceil(MAX_FRAME_DELTA_MS / step) whole steps.
    expect(f.simulationSteps).toBeLessThanOrEqual(
      Math.ceil(MAX_FRAME_DELTA_MS / FIXED_TIMESTEP_MS),
    );
  });

  it('treats a backward clock as zero elapsed time', () => {
    const s = new RenderLoopStepper();
    s.step(1000);
    const f = s.step(500);
    expect(f.deltaMs).toBe(0);
    expect(f.simulationSteps).toBe(0);
  });

  it('reset re-baselines the clock', () => {
    const s = new RenderLoopStepper();
    s.step(0);
    s.step(FIXED_TIMESTEP_MS / 2); // leaves 0.5 in accumulator
    expect(s.alpha).toBeCloseTo(0.5, 6);
    s.reset();
    expect(s.alpha).toBe(0);
    // Next step after reset is a fresh baseline.
    const f = s.step(1_000_000);
    expect(f.deltaMs).toBe(0);
    expect(f.simulationSteps).toBe(0);
  });

  // Property: alpha is always in [0, 1) after any monotonic timestamp sequence.
  it('keeps alpha in [0, 1] for any monotonic frame sequence', () => {
    fc.assert(
      fc.property(
        fc.array(fc.double({ min: 0, max: 100, noNaN: true }), {
          minLength: 1,
          maxLength: 50,
        }),
        (deltas) => {
          const s = new RenderLoopStepper();
          let t = 0;
          s.step(t);
          for (const d of deltas) {
            t += d;
            const f = s.step(t);
            expect(f.alpha).toBeGreaterThanOrEqual(0);
            expect(f.alpha).toBeLessThanOrEqual(1);
            expect(f.simulationSteps).toBeGreaterThanOrEqual(0);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('startRenderLoop (injected rAF)', () => {
  it('pumps the stepper each animation frame and stops cleanly', () => {
    // A controllable fake rAF: queue callbacks and fire them manually.
    const queue: ((t: number) => void)[] = [];
    let nextHandle = 1;
    const cancelled: number[] = [];
    const env = {
      requestAnimationFrame: (cb: (t: number) => void): number => {
        queue.push(cb);
        return nextHandle++;
      },
      cancelAnimationFrame: (h: number): void => {
        cancelled.push(h);
      },
    };

    const frames: FrameStep[] = [];
    const handle = startRenderLoop(
      (f) => frames.push(f),
      new RenderLoopStepper(),
      env,
    );

    expect(handle.running).toBe(true);

    // Fire three frames.
    let time = 0;
    for (let i = 0; i < 3; i++) {
      const cb = queue.shift()!;
      cb(time);
      time += FIXED_TIMESTEP_MS;
    }

    expect(frames).toHaveLength(3);
    // First frame is the baseline (0 steps); later frames advance the sim.
    expect(frames[0]!.simulationSteps).toBe(0);
    expect(frames[1]!.simulationSteps).toBe(1);

    handle.stop();
    expect(handle.running).toBe(false);
    expect(cancelled.length).toBe(1);

    // After stopping, a stale queued callback must not push more frames.
    const stale = queue.shift();
    if (stale) {
      stale(time);
    }
    expect(frames).toHaveLength(3);
  });

  it('throws when no rAF is available and none is injected', () => {
    expect(() =>
      startRenderLoop(() => {}, new RenderLoopStepper(), {
        // Force both to undefined so the guard triggers regardless of env.
        requestAnimationFrame: undefined as unknown as (
          cb: (t: number) => void,
        ) => number,
        cancelAnimationFrame: undefined as unknown as (h: number) => void,
      }),
    ).toThrow(/requestAnimationFrame/);
  });
});
