import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  CAMERA_ABOVE_MAX_PX,
  CAMERA_ABOVE_MIN_PX,
  CAMERA_BEHIND_MAX_PX,
  CAMERA_BEHIND_MIN_PX,
  clamp,
  depthToRow,
  groundPointAtDepth,
  headingToForward,
  placeCamera,
  projectAllScanlines,
  projectScanline,
  type CameraTarget,
  type ProjectionParams,
} from '../scanline';

/**
 * Headless unit + property tests for the PURE scanline / camera math. These run
 * in the `node` vitest environment and never touch PixiJS or WebGL. The actual
 * texture sampling / draw calls in Renderer.drawScanlineRoad are browser-only
 * and are not covered here.
 *
 * Validates: Requirements 11.1 (camera 150–300 px behind, 60–120 px above the
 * leading car) and the pseudo-3D scanline depth projection from design.md.
 */

const baseParams: ProjectionParams = {
  screenHeight: 240,
  horizonRow: 80,
  focalLength: 200,
};

const target: CameraTarget = {
  position: { x: 100, y: 200 },
  heading: 0, // facing north (+Y)
};

describe('clamp', () => {
  it('clamps below, within, and above the range', () => {
    expect(clamp(-5, 0, 10)).toBe(0);
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it('returns the min for NaN', () => {
    expect(clamp(Number.NaN, 3, 9)).toBe(3);
  });
});

describe('headingToForward', () => {
  it('points north (+Y) at heading 0', () => {
    const f = headingToForward(0);
    expect(f.x).toBeCloseTo(0);
    expect(f.y).toBeCloseTo(1);
  });

  it('points east (+X) at heading pi/2 (clockwise from north)', () => {
    const f = headingToForward(Math.PI / 2);
    expect(f.x).toBeCloseTo(1);
    expect(f.y).toBeCloseTo(0);
  });

  it('is always a unit vector', () => {
    fc.assert(
      fc.property(fc.double({ min: -10, max: 10, noNaN: true }), (h) => {
        const f = headingToForward(h);
        const len = Math.hypot(f.x, f.y);
        expect(len).toBeCloseTo(1, 10);
      }),
    );
  });
});

describe('placeCamera (Requirement 11.1)', () => {
  it('uses range midpoints by default', () => {
    const cam = placeCamera(target);
    expect(cam.behindPx).toBe((CAMERA_BEHIND_MIN_PX + CAMERA_BEHIND_MAX_PX) / 2);
    expect(cam.abovePx).toBe((CAMERA_ABOVE_MIN_PX + CAMERA_ABOVE_MAX_PX) / 2);
  });

  it('places the eye behind the car opposite the heading', () => {
    // Heading 0 = +Y, so "behind" is -Y.
    const cam = placeCamera(target, { behindPx: 200 });
    expect(cam.eye.x).toBeCloseTo(100);
    expect(cam.eye.y).toBeCloseTo(200 - 200);
  });

  it('adds airborne height to the camera height', () => {
    const grounded = placeCamera(target, { abovePx: 90 });
    const airborne = placeCamera(
      { ...target, airborneHeight: 40 },
      { abovePx: 90 },
    );
    expect(airborne.height - grounded.height).toBeCloseTo(40);
  });

  it('always clamps offsets into the required ranges', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: -1000, max: 1000, noNaN: true }),
        fc.double({ min: -Math.PI, max: Math.PI, noNaN: true }),
        (behindPx, abovePx, heading) => {
          const cam = placeCamera(
            { position: { x: 0, y: 0 }, heading },
            { behindPx, abovePx },
          );
          expect(cam.behindPx).toBeGreaterThanOrEqual(CAMERA_BEHIND_MIN_PX);
          expect(cam.behindPx).toBeLessThanOrEqual(CAMERA_BEHIND_MAX_PX);
          expect(cam.abovePx).toBeGreaterThanOrEqual(CAMERA_ABOVE_MIN_PX);
          expect(cam.abovePx).toBeLessThanOrEqual(CAMERA_ABOVE_MAX_PX);
          // Eye is exactly behindPx away from the car.
          const dist = Math.hypot(cam.eye.x - 0, cam.eye.y - 0);
          expect(dist).toBeCloseTo(cam.behindPx, 6);
        },
      ),
    );
  });
});

describe('projectScanline', () => {
  const camera = placeCamera(target, { abovePx: 100 });

  it('treats rows at/above the horizon as sky', () => {
    const atHorizon = projectScanline(baseParams.horizonRow, camera, baseParams);
    const above = projectScanline(baseParams.horizonRow - 10, camera, baseParams);
    expect(atHorizon.aboveHorizon).toBe(true);
    expect(atHorizon.depth).toBe(Infinity);
    expect(atHorizon.scale).toBe(0);
    expect(above.aboveHorizon).toBe(true);
  });

  it('returns finite positive depth below the horizon', () => {
    const p = projectScanline(baseParams.horizonRow + 40, camera, baseParams);
    expect(p.aboveHorizon).toBe(false);
    expect(p.depth).toBeGreaterThan(0);
    expect(Number.isFinite(p.depth)).toBe(true);
    expect(p.scale).toBeGreaterThan(0);
  });

  it('depth decreases (gets closer) toward the bottom of the screen', () => {
    let previous = Infinity;
    for (let row = baseParams.horizonRow + 1; row < baseParams.screenHeight; row++) {
      const p = projectScanline(row, camera, baseParams);
      expect(p.depth).toBeLessThan(previous);
      previous = p.depth;
    }
  });

  it('matches the closed-form z = height*focal/dy', () => {
    const row = baseParams.horizonRow + 50;
    const p = projectScanline(row, camera, baseParams);
    const dy = row - baseParams.horizonRow;
    expect(p.depth).toBeCloseTo((camera.height * baseParams.focalLength) / dy, 6);
    expect(p.scale).toBeCloseTo(baseParams.focalLength / p.depth, 6);
  });
});

describe('projectAllScanlines', () => {
  it('produces one entry per screen row', () => {
    const camera = placeCamera(target);
    const rows = projectAllScanlines(camera, baseParams);
    expect(rows).toHaveLength(baseParams.screenHeight);
    expect(rows[0]?.row).toBe(0);
    expect(rows[rows.length - 1]?.row).toBe(baseParams.screenHeight - 1);
  });
});

describe('depthToRow is the inverse of projectScanline depth', () => {
  const camera = placeCamera(target, { abovePx: 110 });

  it('round-trips row -> depth -> row for below-horizon rows', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: baseParams.horizonRow + 1, max: baseParams.screenHeight - 1 }),
        (row) => {
          const p = projectScanline(row, camera, baseParams);
          const back = depthToRow(p.depth, camera, baseParams);
          expect(back).toBeCloseTo(row, 6);
        },
      ),
    );
  });

  it('maps depths behind the camera to Infinity', () => {
    expect(depthToRow(-1, camera, baseParams)).toBe(Infinity);
    expect(depthToRow(0, camera, baseParams)).toBe(Infinity);
  });
});

describe('groundPointAtDepth', () => {
  it('advances from the eye along the heading', () => {
    const camera = placeCamera(target, { behindPx: 150 });
    const g = groundPointAtDepth(300, camera);
    // heading 0 => +Y; eye is at y = 200 - 150 = 50, so ground at depth 300 => y = 350.
    expect(g.x).toBeCloseTo(100);
    expect(g.y).toBeCloseTo(50 + 300);
  });

  it('depth 0 returns the eye position', () => {
    const camera = placeCamera(target);
    const g = groundPointAtDepth(0, camera);
    expect(g.x).toBeCloseTo(camera.eye.x);
    expect(g.y).toBeCloseTo(camera.eye.y);
  });
});
