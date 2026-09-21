import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  AIRBORNE_OFFSET_MAX_PX,
  AIRBORNE_OFFSET_MIN_PX,
  AIRBORNE_SCALE_MAX,
  AIRBORNE_SCALE_MIN,
  DEFAULT_MAX_JUMP_HEIGHT,
  airborneFraction,
  airborneOffsetPx,
  airborneScale,
  depthAndLateral,
  projectCar,
  projectCars,
  type CarRenderTarget,
} from '../carSprite';
import { placeCamera, type CameraTarget, type ProjectionParams } from '../scanline';

/**
 * Headless unit + property tests for the PURE car-sprite placement math. These
 * run in the `node` vitest environment and never touch PixiJS or WebGL — the
 * actual sprite draw calls in Renderer.drawCars are browser-only and are not
 * covered here.
 *
 * Validates: Requirements 2.3 (pseudo-3D depth scaling `focalLength / depth`,
 * car sprites depth-sorted) and 2.4 (airborne scale clamped to [100 %, 150 %],
 * vertical offset in [0, 80] px proportional to jump height).
 */

const params: ProjectionParams = {
  screenHeight: 240,
  horizonRow: 80,
  focalLength: 200,
};

const camTarget: CameraTarget = {
  position: { x: 100, y: 200 },
  heading: 0, // facing north (+Y)
};

const camera = placeCamera(camTarget, { behindPx: 200, abovePx: 100 });

// -------------------------------------------------------------------------
// Airborne scale (Requirement 2.4: 100 %–150 %)
// -------------------------------------------------------------------------

describe('airborneScale (Requirement 2.4)', () => {
  it('is exactly 100 % when grounded (height 0)', () => {
    expect(airborneScale(0)).toBe(AIRBORNE_SCALE_MIN);
  });

  it('is exactly 150 % at the reference max jump height', () => {
    expect(airborneScale(DEFAULT_MAX_JUMP_HEIGHT)).toBeCloseTo(AIRBORNE_SCALE_MAX, 10);
  });

  it('is the midpoint (125 %) at half the reference height', () => {
    expect(airborneScale(DEFAULT_MAX_JUMP_HEIGHT / 2)).toBeCloseTo(1.25, 10);
  });

  it('always stays clamped within [100 %, 150 %] for any height', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 5000, noNaN: true }),
        fc.double({ min: 1, max: 500, noNaN: true }),
        (height, maxJumpHeight) => {
          const s = airborneScale(height, { maxJumpHeight });
          expect(s).toBeGreaterThanOrEqual(AIRBORNE_SCALE_MIN);
          expect(s).toBeLessThanOrEqual(AIRBORNE_SCALE_MAX);
        },
      ),
    );
  });

  it('is monotonic non-decreasing in jump height', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 0, max: 100, noNaN: true }),
        fc.double({ min: 0, max: 100, noNaN: true }),
        (a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          expect(airborneScale(hi)).toBeGreaterThanOrEqual(airborneScale(lo));
        },
      ),
    );
  });
});

// -------------------------------------------------------------------------
// Airborne vertical offset (Requirement 2.4: 0–80 px, proportional)
// -------------------------------------------------------------------------

describe('airborneOffsetPx (Requirement 2.4)', () => {
  it('is 0 px when grounded', () => {
    expect(airborneOffsetPx(0)).toBe(AIRBORNE_OFFSET_MIN_PX);
  });

  it('is 80 px at the reference max jump height', () => {
    expect(airborneOffsetPx(DEFAULT_MAX_JUMP_HEIGHT)).toBeCloseTo(AIRBORNE_OFFSET_MAX_PX, 10);
  });

  it('always stays clamped within [0, 80] px for any height', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 5000, noNaN: true }),
        fc.double({ min: 1, max: 500, noNaN: true }),
        (height, maxJumpHeight) => {
          const px = airborneOffsetPx(height, { maxJumpHeight });
          expect(px).toBeGreaterThanOrEqual(AIRBORNE_OFFSET_MIN_PX);
          expect(px).toBeLessThanOrEqual(AIRBORNE_OFFSET_MAX_PX);
        },
      ),
    );
  });

  it('is proportional to jump height within the clamp range', () => {
    // For two heights both within [0, maxJumpHeight], offset ratio == height ratio.
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 39, noNaN: true }),
        fc.double({ min: 1, max: 39, noNaN: true }),
        (a, b) => {
          const oa = airborneOffsetPx(a);
          const ob = airborneOffsetPx(b);
          // offset = 80 * (h / maxHeight), so oa/ob == a/b.
          expect(oa * b).toBeCloseTo(ob * a, 6);
        },
      ),
    );
  });

  it('scales linearly with the fraction: offset == 80 * fraction', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 40, noNaN: true }), (h) => {
        const frac = airborneFraction(h);
        expect(airborneOffsetPx(h)).toBeCloseTo(AIRBORNE_OFFSET_MAX_PX * frac, 6);
      }),
    );
  });
});

describe('airborneFraction', () => {
  it('clamps negative height to 0 and beyond-max to 1', () => {
    expect(airborneFraction(-5)).toBe(0);
    expect(airborneFraction(DEFAULT_MAX_JUMP_HEIGHT * 2)).toBe(1);
  });

  it('returns 0 for a non-positive maxJumpHeight (no divide-by-zero)', () => {
    expect(airborneFraction(10, { maxJumpHeight: 0 })).toBe(0);
    expect(airborneFraction(10, { maxJumpHeight: -1 })).toBe(0);
  });
});

// -------------------------------------------------------------------------
// Depth-based scale (Requirement 2.3)
// -------------------------------------------------------------------------

describe('projectCar depth-based scale (Requirement 2.3)', () => {
  it('depthScale equals focalLength / depth', () => {
    const car: CarRenderTarget = { position: { x: 100, y: 300 }, heading: 0 };
    const p = projectCar(car, camera, params, { screenWidth: 320 });
    expect(p.visible).toBe(true);
    expect(p.depthScale).toBeCloseTo(params.focalLength / p.depth, 10);
  });

  it('final scale is depthScale * airborneScale', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 500, noNaN: true }), // forward distance
        fc.double({ min: 0, max: 80, noNaN: true }), // airborne height
        (forwardDist, height) => {
          // Place the car straight ahead of the camera eye along +Y.
          const car: CarRenderTarget = {
            position: { x: camera.eye.x, y: camera.eye.y + forwardDist },
            heading: 0,
            airborneHeight: height,
          };
          const p = projectCar(car, camera, params, { screenWidth: 320 });
          expect(p.visible).toBe(true);
          expect(p.scale).toBeCloseTo(p.depthScale * p.airborneScale, 6);
          expect(p.depthScale).toBeCloseTo(params.focalLength / p.depth, 6);
        },
      ),
    );
  });

  it('nearer cars project to a larger depth scale', () => {
    const near: CarRenderTarget = { position: { x: camera.eye.x, y: camera.eye.y + 50 }, heading: 0 };
    const far: CarRenderTarget = { position: { x: camera.eye.x, y: camera.eye.y + 400 }, heading: 0 };
    const pNear = projectCar(near, camera, params, { screenWidth: 320 });
    const pFar = projectCar(far, camera, params, { screenWidth: 320 });
    expect(pNear.depthScale).toBeGreaterThan(pFar.depthScale);
  });

  it('lifts the sprite upward by the airborne offset', () => {
    const grounded: CarRenderTarget = { position: { x: camera.eye.x, y: camera.eye.y + 100 }, heading: 0 };
    const jumping: CarRenderTarget = { ...grounded, airborneHeight: DEFAULT_MAX_JUMP_HEIGHT };
    const g = projectCar(grounded, camera, params, { screenWidth: 320 });
    const j = projectCar(jumping, camera, params, { screenWidth: 320 });
    // Same depth => same base row; jumping one is offset upward (smaller y).
    expect(g.screenY - j.screenY).toBeCloseTo(AIRBORNE_OFFSET_MAX_PX, 6);
  });

  it('marks cars behind the camera as not visible', () => {
    const behind: CarRenderTarget = { position: { x: camera.eye.x, y: camera.eye.y - 100 }, heading: 0 };
    const p = projectCar(behind, camera, params, { screenWidth: 320 });
    expect(p.visible).toBe(false);
  });
});

describe('depthAndLateral', () => {
  it('reports forward distance as depth and 0 lateral when dead ahead', () => {
    const { depth, lateral } = depthAndLateral(
      { x: camera.eye.x, y: camera.eye.y + 250 },
      camera,
    );
    expect(depth).toBeCloseTo(250, 6);
    expect(lateral).toBeCloseTo(0, 6);
  });
});

// -------------------------------------------------------------------------
// Depth sorting (Requirement 2.3: car sprites depth-sorted)
// -------------------------------------------------------------------------

describe('projectCars depth sorting (Requirement 2.3)', () => {
  it('returns visible cars far-to-near (descending depth)', () => {
    const cars: CarRenderTarget[] = [
      { position: { x: camera.eye.x, y: camera.eye.y + 100 }, heading: 0 },
      { position: { x: camera.eye.x, y: camera.eye.y + 400 }, heading: 0 },
      { position: { x: camera.eye.x, y: camera.eye.y + 250 }, heading: 0 },
    ];
    const placements = projectCars(cars, camera, params, { screenWidth: 320 });
    expect(placements).toHaveLength(3);
    for (let i = 1; i < placements.length; i++) {
      expect(placements[i - 1]!.depth).toBeGreaterThanOrEqual(placements[i]!.depth);
    }
  });

  it('drops cars behind the camera and beyond the far clip', () => {
    const cars: CarRenderTarget[] = [
      { position: { x: camera.eye.x, y: camera.eye.y - 50 }, heading: 0 }, // behind
      { position: { x: camera.eye.x, y: camera.eye.y + 100 }, heading: 0 }, // visible
      { position: { x: camera.eye.x, y: camera.eye.y + 5000 }, heading: 0 }, // beyond clip
    ];
    const placements = projectCars(cars, camera, params, {
      screenWidth: 320,
      farClipDepth: 1000,
    });
    expect(placements).toHaveLength(1);
    expect(placements[0]!.visible).toBe(true);
  });

  it('always yields a descending-depth ordering for arbitrary car sets', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            dx: fc.double({ min: -300, max: 300, noNaN: true }),
            fwd: fc.double({ min: 1, max: 900, noNaN: true }),
          }),
          { minLength: 0, maxLength: 8 },
        ),
        (specs) => {
          const cars: CarRenderTarget[] = specs.map((s) => ({
            position: { x: camera.eye.x + s.dx, y: camera.eye.y + s.fwd },
            heading: 0,
          }));
          const placements = projectCars(cars, camera, params, { screenWidth: 320 });
          for (let i = 1; i < placements.length; i++) {
            expect(placements[i - 1]!.depth).toBeGreaterThanOrEqual(placements[i]!.depth);
          }
        },
      ),
    );
  });
});
