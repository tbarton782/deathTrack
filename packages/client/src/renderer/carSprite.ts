/**
 * Pure, GPU-free math for placing and sizing car sprites in the scanline
 * pseudo-3D scene.
 *
 * Like {@link ../scanline.scanline}, this module contains **no PixiJS / WebGL
 * dependency**: every function is a pure function of its arguments so the
 * depth-based scale, airborne scale and airborne vertical-offset math can be
 * unit-tested headless (in the `node` vitest environment) without a real
 * rendering context. The PixiJS draw glue that turns these numbers into sprites
 * lives in {@link ../Renderer.Renderer} (the `drawCars` method).
 *
 * ## What this computes
 *
 * A car in the world sits at some depth in front of the camera. Two effects
 * combine to place its sprite on screen:
 *
 * 1. **Depth-based scale.** Exactly like scenery, a car one world-unit tall at
 *    depth `z` projects to `focalLength / z` screen pixels — nearer cars are
 *    bigger. This is the {@link ScanlineProjection.scale} value.
 *
 * 2. **Airborne exaggeration (Requirement 2.4 / 2.3).** While a jump is in
 *    progress the sprite is additionally scaled between **100 % and 150 %** of
 *    its base size, and lifted by a **0–80 px** vertical offset, both
 *    proportional to the jump's current height. This sells the "car is in the
 *    air" read without a real 3D scene. On the ground (height 0) the factor is
 *    exactly 1.0 and the offset exactly 0.
 *
 * The two scales multiply: `finalScale = depthScale * airborneScale`.
 *
 * Requirements: 2.3 (pseudo-3D perspective / depth scaling), 2.4 (airborne
 * scaling 100 %–150 % and 0–80 px vertical offset proportional to jump height).
 */

import type { CameraState, ProjectionParams } from './scanline.js';
import { clamp, depthToRow, headingToForward } from './scanline.js';
import type { Vec2 } from '@deathtrack/shared';

// ---------------------------------------------------------------------------
// Airborne exaggeration bounds (Requirement 2.4)
// ---------------------------------------------------------------------------

/** Sprite scale factor when fully grounded (100 % of base size). */
export const AIRBORNE_SCALE_MIN = 1.0;
/** Sprite scale factor at the top of the highest jump (150 % of base size). */
export const AIRBORNE_SCALE_MAX = 1.5;
/** Vertical offset, in pixels, when grounded. */
export const AIRBORNE_OFFSET_MIN_PX = 0;
/** Vertical offset, in pixels, at the top of the highest jump. */
export const AIRBORNE_OFFSET_MAX_PX = 80;

/**
 * The reference jump height (in track units) that maps to the *maximum*
 * airborne scale and offset. Heights at or above this are clamped to the max.
 * Callers can override this per-track / per-car via
 * {@link AirborneRenderParams.maxJumpHeight}, but a sensible default keeps the
 * common case simple.
 */
export const DEFAULT_MAX_JUMP_HEIGHT = 40;

// ---------------------------------------------------------------------------
// Airborne scale + offset
// ---------------------------------------------------------------------------

/** Optional tuning for the airborne exaggeration curve. */
export interface AirborneRenderParams {
  /**
   * Jump height (track units) that corresponds to the maximum scale/offset.
   * Must be `> 0`; defaults to {@link DEFAULT_MAX_JUMP_HEIGHT}.
   */
  readonly maxJumpHeight?: number;
}

/**
 * Normalises a raw airborne height into a `[0, 1]` fraction of the reference
 * maximum jump height. Negative heights clamp to 0; heights at or above the
 * reference clamp to 1. A non-positive `maxJumpHeight` degenerates to 0 (no
 * exaggeration) rather than dividing by zero.
 *
 * @param airborneHeight - Height above the road surface in track units.
 * @param params - Optional reference max-height override.
 */
export function airborneFraction(
  airborneHeight: number,
  params: AirborneRenderParams = {},
): number {
  const maxHeight = params.maxJumpHeight ?? DEFAULT_MAX_JUMP_HEIGHT;
  if (!(maxHeight > 0)) {
    return 0;
  }
  return clamp(airborneHeight / maxHeight, 0, 1);
}

/**
 * Airborne scale factor for a given jump height, in `[1.0, 1.5]`. Proportional
 * to the jump-height fraction: grounded (0) → 1.0, at/above the reference
 * height → 1.5.
 *
 * @param airborneHeight - Height above the road surface in track units.
 * @param params - Optional reference max-height override.
 */
export function airborneScale(
  airborneHeight: number,
  params: AirborneRenderParams = {},
): number {
  const t = airborneFraction(airborneHeight, params);
  return AIRBORNE_SCALE_MIN + (AIRBORNE_SCALE_MAX - AIRBORNE_SCALE_MIN) * t;
}

/**
 * Airborne vertical offset (in pixels) for a given jump height, in `[0, 80]`.
 * Proportional to the jump-height fraction: grounded (0) → 0 px, at/above the
 * reference height → 80 px. The value is a magnitude; the draw glue subtracts
 * it from the sprite's screen `y` to lift the sprite upward.
 *
 * @param airborneHeight - Height above the road surface in track units.
 * @param params - Optional reference max-height override.
 */
export function airborneOffsetPx(
  airborneHeight: number,
  params: AirborneRenderParams = {},
): number {
  const t = airborneFraction(airborneHeight, params);
  return (
    AIRBORNE_OFFSET_MIN_PX +
    (AIRBORNE_OFFSET_MAX_PX - AIRBORNE_OFFSET_MIN_PX) * t
  );
}

// ---------------------------------------------------------------------------
// Full per-car placement
// ---------------------------------------------------------------------------

/**
 * The minimal per-car input the placement math needs. This is a structural
 * subset of `CarPhysicsState` (position + heading + airborne height) so callers
 * can pass a full physics state, a `CarRaceState.physics`, or a minimal
 * stand-in in tests.
 */
export interface CarRenderTarget {
  /** World-space position of the car, in track units. */
  readonly position: Vec2;
  /**
   * Heading in radians (physics convention: 0 = north/+Y, clockwise). Not used
   * for placement yet but carried through for future sprite-rotation work.
   */
  readonly heading: number;
  /** Height above the road surface in track units (0 when grounded). */
  readonly airborneHeight?: number;
}

/**
 * The fully-resolved on-screen placement for one car sprite. Consumed by the
 * PixiJS draw glue: it positions the sprite at `(screenX, screenY)`, sets its
 * scale to {@link scale}, and (for depth sorting) draws cars in ascending
 * {@link depth} last so nearer cars overlap farther ones.
 */
export interface CarPlacement<T = CarRenderTarget> {
  /** The car this placement was computed for. */
  readonly car: T;
  /** World-space depth in front of the camera, in track units. */
  readonly depth: number;
  /** Signed lateral offset from the view axis, in track units. */
  readonly lateral: number;
  /** Projected screen column for the sprite centre. */
  readonly screenX: number;
  /** Projected screen row for the sprite's base, after airborne lift. */
  readonly screenY: number;
  /** Depth-based projection scale (`focalLength / depth`) before exaggeration. */
  readonly depthScale: number;
  /** Airborne exaggeration factor in `[1.0, 1.5]`. */
  readonly airborneScale: number;
  /** Final sprite scale (`depthScale * airborneScale`). */
  readonly scale: number;
  /** Airborne vertical lift applied, in pixels (`[0, 80]`). */
  readonly offsetPx: number;
  /** True when the car is in front of the camera and should be drawn. */
  readonly visible: boolean;
}

/** Options controlling {@link projectCars}. */
export interface CarProjectionOptions extends AirborneRenderParams {
  /** Screen width in pixels used to centre sprites horizontally. */
  readonly screenWidth: number;
  /** Depth beyond which cars are culled; defaults to no far clip. */
  readonly farClipDepth?: number;
}

/**
 * Computes the depth of one car along the camera's view axis plus its signed
 * lateral offset. Pure helper shared by {@link projectCar} and the scenery
 * math; kept exported so it can be unit-tested directly.
 *
 * @param position - World-space car position.
 * @param camera - Resolved camera pose.
 */
export function depthAndLateral(
  position: Vec2,
  camera: CameraState,
): { depth: number; lateral: number } {
  const forward = headingToForward(camera.heading);
  const dx = position.x - camera.eye.x;
  const dy = position.y - camera.eye.y;
  // Depth: projection onto the forward axis. Lateral: onto the perpendicular.
  const depth = dx * forward.x + dy * forward.y;
  const lateral = dx * forward.y - dy * forward.x;
  return { depth, lateral };
}

/**
 * Projects a single car to its on-screen placement, combining the depth-based
 * projection scale with the airborne exaggeration. Cars behind the camera
 * (`depth <= 0`) come back with `visible: false` and are meant to be skipped by
 * the caller.
 *
 * Pure function of `(car, camera, params, options)`.
 *
 * @param car - The car to place.
 * @param camera - Resolved camera pose from `placeCamera`.
 * @param params - Projection parameters (screen height, horizon, focal length).
 * @param options - Screen width, optional far clip, and airborne tuning.
 */
export function projectCar<T extends CarRenderTarget>(
  car: T,
  camera: CameraState,
  params: ProjectionParams,
  options: CarProjectionOptions,
): CarPlacement<T> {
  const { depth, lateral } = depthAndLateral(car.position, camera);
  const airborneHeight = car.airborneHeight ?? 0;
  const aScale = airborneScale(airborneHeight, options);
  const offsetPx = airborneOffsetPx(airborneHeight, options);
  const farClip = options.farClipDepth ?? Number.POSITIVE_INFINITY;

  if (!(depth > 0) || depth > farClip) {
    return {
      car,
      depth,
      lateral,
      screenX: Number.NaN,
      screenY: Number.NaN,
      depthScale: 0,
      airborneScale: aScale,
      scale: 0,
      offsetPx,
      visible: false,
    };
  }

  const depthScale = params.focalLength / depth;
  const row = depthToRow(depth, camera, params);
  const screenX = options.screenWidth / 2 + lateral * depthScale;
  // Lift the sprite upward (toward the top of the screen) by the airborne
  // offset, so higher jumps float the car further off the road line.
  const screenY = row - offsetPx;

  return {
    car,
    depth,
    lateral,
    screenX,
    screenY,
    depthScale,
    airborneScale: aScale,
    scale: depthScale * aScale,
    offsetPx,
    visible: true,
  };
}

/**
 * Projects and depth-sorts an array of cars for drawing. Visible cars are
 * returned **far-to-near** (descending depth) so a caller drawing them in order
 * naturally paints nearer cars on top of farther ones (Requirement 2.3 draw
 * order: "Car sprites (depth-sorted)"). Cars behind the camera or beyond the
 * far clip are dropped from the result.
 *
 * Pure function of its inputs.
 *
 * @param cars - Cars to project.
 * @param camera - Resolved camera pose.
 * @param params - Projection parameters.
 * @param options - Screen width, optional far clip, and airborne tuning.
 */
export function projectCars<T extends CarRenderTarget>(
  cars: readonly T[],
  camera: CameraState,
  params: ProjectionParams,
  options: CarProjectionOptions,
): CarPlacement<T>[] {
  return cars
    .map((car) => projectCar(car, camera, params, options))
    .filter((placement) => placement.visible)
    // Far first so near cars draw last (on top).
    .sort((a, b) => b.depth - a.depth);
}
