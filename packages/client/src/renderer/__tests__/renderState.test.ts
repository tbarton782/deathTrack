import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  clampAlpha,
  interpolateCameraTarget,
  interpolateCar,
  interpolateRenderState,
  lerp,
  lerpAngle,
  lerpVec2,
  type RenderCar,
  type RenderState,
} from '../renderState';
import type { CameraTarget } from '../scanline';

/**
 * Headless unit + property tests for the pure fixed-timestep render
 * interpolation (task 15.7). No PixiJS / WebGL is touched: these exercise the
 * `renderState.ts` math directly under the `node` vitest environment.
 *
 * Validates: Requirements 2.1–2.4 (interpolated camera + car placement between
 * simulation snapshots), 13.2 (smooth 60 fps render path).
 */

const TAU = Math.PI * 2;

function car(id: number, x: number, y: number, heading = 0, h = 0): RenderCar {
  return { id, position: { x, y }, heading, airborneHeight: h };
}

function baseState(cars: RenderCar[], target?: CameraTarget): RenderState {
  return {
    cameraTarget: target ?? { position: { x: 0, y: 0 }, heading: 0 },
    cars,
    scenery: [],
    hazards: [],
    projectiles: [],
  };
}

describe('clampAlpha', () => {
  it('clamps below 0 and above 1', () => {
    expect(clampAlpha(-0.5)).toBe(0);
    expect(clampAlpha(1.5)).toBe(1);
    expect(clampAlpha(0.25)).toBe(0.25);
  });

  it('maps non-finite values to 0', () => {
    expect(clampAlpha(Number.NaN)).toBe(0);
    expect(clampAlpha(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('lerp / lerpVec2', () => {
  it('interpolates scalars linearly', () => {
    expect(lerp(0, 10, 0)).toBe(0);
    expect(lerp(0, 10, 1)).toBe(10);
    expect(lerp(0, 10, 0.5)).toBe(5);
  });

  it('interpolates 2D points component-wise', () => {
    expect(lerpVec2({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({
      x: 5,
      y: 10,
    });
  });
});

describe('lerpAngle', () => {
  it('takes the short way across the 0/2π seam', () => {
    // From 0.1 rad to (2π - 0.1) rad the short path is backwards through 0.
    const a = 0.1;
    const b = TAU - 0.1;
    const mid = lerpAngle(a, b, 0.5);
    // Midpoint should sit near 0 / 2π, not near π.
    const wrapped = ((mid % TAU) + TAU) % TAU;
    const distToZero = Math.min(wrapped, TAU - wrapped);
    expect(distToZero).toBeCloseTo(0, 3);
  });

  it('returns endpoints at alpha 0 and 1', () => {
    expect(lerpAngle(0.3, 1.2, 0)).toBeCloseTo(0.3);
    expect(lerpAngle(0.3, 1.2, 1)).toBeCloseTo(1.2);
  });

  // Property: interpolated angle is always within the short arc between a and b.
  it('stays within the shortest arc for any angles and alpha', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: -10, max: 10, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (a, b, alpha) => {
          const result = lerpAngle(a, b, alpha);
          // Shortest signed delta from a to b.
          let diff = ((b - a) % TAU + TAU) % TAU;
          if (diff > Math.PI) diff -= TAU;
          const expected = a + diff * alpha;
          expect(result).toBeCloseTo(expected, 9);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('interpolateCar', () => {
  it('blends position and height by alpha, keeps identity from current', () => {
    const prev: RenderCar = { ...car(3, 0, 0, 0, 0), spriteId: 'old' };
    const curr: RenderCar = {
      ...car(3, 100, 200, 0, 40),
      spriteId: 'new',
      eliminated: false,
    };
    const mid = interpolateCar(prev, curr, 0.5);
    expect(mid.id).toBe(3);
    expect(mid.position).toEqual({ x: 50, y: 100 });
    expect(mid.airborneHeight).toBe(20);
    expect(mid.spriteId).toBe('new');
    expect(mid.eliminated).toBe(false);
  });
});

describe('interpolateCameraTarget', () => {
  it('blends position and airborne height', () => {
    const prev: CameraTarget = {
      position: { x: 0, y: 0 },
      heading: 0,
      airborneHeight: 0,
    };
    const curr: CameraTarget = {
      position: { x: 10, y: 10 },
      heading: 0,
      airborneHeight: 40,
    };
    const mid = interpolateCameraTarget(prev, curr, 0.25);
    expect(mid.position).toEqual({ x: 2.5, y: 2.5 });
    expect(mid.airborneHeight).toBe(10);
  });
});

describe('interpolateRenderState', () => {
  it('alpha 0 reproduces the previous continuous fields', () => {
    const prev = baseState([car(0, 0, 0)], {
      position: { x: 1, y: 2 },
      heading: 0,
    });
    const curr = baseState([car(0, 100, 100)], {
      position: { x: 9, y: 9 },
      heading: 0,
    });
    const out = interpolateRenderState(prev, curr, 0);
    expect(out.cars[0]!.position).toEqual({ x: 0, y: 0 });
    expect(out.cameraTarget.position).toEqual({ x: 1, y: 2 });
  });

  it('alpha 1 reproduces the current continuous fields', () => {
    const prev = baseState([car(0, 0, 0)]);
    const curr = baseState([car(0, 100, 100)]);
    const out = interpolateRenderState(prev, curr, 1);
    expect(out.cars[0]!.position).toEqual({ x: 100, y: 100 });
  });

  it('matches cars by id regardless of order', () => {
    const prev = baseState([car(0, 0, 0), car(1, 10, 10)]);
    const curr = baseState([car(1, 20, 20), car(0, 100, 100)]);
    const out = interpolateRenderState(prev, curr, 0.5);
    // Output order follows current: [id 1, id 0].
    expect(out.cars.map((c) => c.id)).toEqual([1, 0]);
    expect(out.cars[0]!.position).toEqual({ x: 15, y: 15 });
    expect(out.cars[1]!.position).toEqual({ x: 50, y: 50 });
  });

  it('emits a newly-spawned car (not in previous) at its current state', () => {
    const prev = baseState([car(0, 0, 0)]);
    const curr = baseState([car(0, 100, 100), car(1, 5, 5)]);
    const out = interpolateRenderState(prev, curr, 0.5);
    const spawned = out.cars.find((c) => c.id === 1)!;
    expect(spawned.position).toEqual({ x: 5, y: 5 });
  });

  it('drops a despawned car (only in previous)', () => {
    const prev = baseState([car(0, 0, 0), car(1, 10, 10)]);
    const curr = baseState([car(0, 100, 100)]);
    const out = interpolateRenderState(prev, curr, 0.5);
    expect(out.cars.map((c) => c.id)).toEqual([0]);
  });

  it('carries discrete fields from the current snapshot', () => {
    const prev = baseState([car(0, 0, 0)]);
    const curr: RenderState = {
      ...baseState([car(0, 100, 100)]),
      eliminations: [{ type: 'elimination', eliminatedId: 0, killedById: 1 }],
      roadFrameName: 'road',
    };
    const out = interpolateRenderState(prev, curr, 0.5);
    expect(out.eliminations).toBe(curr.eliminations);
    expect(out.roadFrameName).toBe('road');
  });

  it('does not mutate either input snapshot', () => {
    const prev = baseState([car(0, 0, 0)]);
    const curr = baseState([car(0, 100, 100)]);
    const prevSnapshot = JSON.parse(JSON.stringify(prev));
    const currSnapshot = JSON.parse(JSON.stringify(curr));
    interpolateRenderState(prev, curr, 0.5);
    expect(prev).toEqual(prevSnapshot);
    expect(curr).toEqual(currSnapshot);
  });

  // Property: interpolated car position lies on the segment between prev/curr.
  it('keeps each interpolated position on the prev→curr segment', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (px, py, cx, cy, alpha) => {
          const prev = baseState([car(0, px, py)]);
          const curr = baseState([car(0, cx, cy)]);
          const out = interpolateRenderState(prev, curr, alpha);
          const p = out.cars[0]!.position;
          expect(p.x).toBeCloseTo(px + (cx - px) * alpha, 6);
          expect(p.y).toBeCloseTo(py + (cy - py) * alpha, 6);
          // Bounded by the two endpoints.
          expect(p.x).toBeGreaterThanOrEqual(Math.min(px, cx) - 1e-6);
          expect(p.x).toBeLessThanOrEqual(Math.max(px, cx) + 1e-6);
        },
      ),
      { numRuns: 200 },
    );
  });
});
