/**
 * Pure, GPU-free math for the scanline-based pseudo-3D road projection.
 *
 * This module deliberately contains **no PixiJS / WebGL dependency**. Every
 * function here is a pure function of its arguments, so the projection and
 * camera-placement math can be unit-tested headless (in the `node` vitest
 * environment) without a real rendering context. The actual texture sampling
 * and draw calls live in {@link ../Renderer.Renderer} and consume the numbers
 * produced here.
 *
 * ## The pseudo-3D model
 *
 * Deathtrack's track is drawn with a classic "scanline racer" projection (the
 * same family of math used by Pole Position / OutRun style renderers): the
 * world is a ground plane, the camera floats above and behind the leading car
 * looking forward along the ground, and each horizontal screen row (scanline)
 * below the horizon corresponds to a single world-space depth `z` in front of
 * the camera. Rows near the horizon map to large depths (far away); rows near
 * the bottom of the screen map to small depths (close to the camera).
 *
 * For a camera at height `cameraHeight` above the ground, a focal length
 * `focalLength` (in pixels), and a horizon at screen row `horizonRow`, a screen
 * row `row` maps to world depth:
 *
 * ```
 *   dy = row - horizonRow          // pixels below the horizon (> 0 on screen)
 *   z  = (cameraHeight * focalLength) / dy
 * ```
 *
 * and the projected scale of one world unit at that depth is
 * `scale = focalLength / z`. See design.md "Pseudo-3D perspective".
 *
 * Requirements: 11.1 (fixed camera offset 150–300 px behind and 60–120 px
 * above the leading car), 11.2 (road / boundaries / scenery draw order feeds
 * off these depths).
 */

import type { Vec2 } from '@deathtrack/shared';

// ---------------------------------------------------------------------------
// Camera-offset bounds (Requirement 11.1)
// ---------------------------------------------------------------------------

/** Minimum distance, in pixels, the camera sits behind the leading car. */
export const CAMERA_BEHIND_MIN_PX = 150;
/** Maximum distance, in pixels, the camera sits behind the leading car. */
export const CAMERA_BEHIND_MAX_PX = 300;
/** Minimum height, in pixels, the camera sits above the leading car. */
export const CAMERA_ABOVE_MIN_PX = 60;
/** Maximum height, in pixels, the camera sits above the leading car. */
export const CAMERA_ABOVE_MAX_PX = 120;

/** Default "behind" offset: midpoint of the allowed range. */
export const CAMERA_BEHIND_DEFAULT_PX =
  (CAMERA_BEHIND_MIN_PX + CAMERA_BEHIND_MAX_PX) / 2;
/** Default "above" offset: midpoint of the allowed range. */
export const CAMERA_ABOVE_DEFAULT_PX =
  (CAMERA_ABOVE_MIN_PX + CAMERA_ABOVE_MAX_PX) / 2;

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/**
 * The subset of a car's state the camera needs to follow it. This is a
 * structural subset of `CarPhysicsState` (position + heading + airborne
 * height) so callers can pass a full car state or a minimal stand-in.
 */
export interface CameraTarget {
  /** World-space position of the car, in track units. */
  readonly position: Vec2;
  /**
   * Heading in radians. Matches the physics convention: 0 = north (+Y),
   * increasing clockwise. The camera sits opposite the heading (behind).
   */
  readonly heading: number;
  /** Height above the road surface, in track units (0 when grounded). */
  readonly airborneHeight?: number;
}

/**
 * Requested camera offsets. Both are clamped into the Requirement 11.1 ranges
 * by {@link placeCamera}, so out-of-range requests are corrected rather than
 * rejected. Omitted values fall back to the range midpoints.
 */
export interface CameraOffsetRequest {
  /** Desired distance behind the car, in pixels (clamped to 150–300). */
  readonly behindPx?: number;
  /** Desired height above the car, in pixels (clamped to 60–120). */
  readonly abovePx?: number;
}

// ---------------------------------------------------------------------------
// Camera state (output of placeCamera)
// ---------------------------------------------------------------------------

/**
 * A fully-resolved camera pose used by the scanline projection. All distances
 * are in pixels/track units consistent with the projection math below.
 */
export interface CameraState {
  /**
   * World-space position of the camera "eye" on the ground plane, i.e. the
   * point directly below the camera. This is the car position pushed backward
   * along the opposite of the heading by the (clamped) behind offset.
   */
  readonly eye: Vec2;
  /**
   * Height of the camera above the ground plane, in pixels. Equal to the
   * clamped "above" offset plus the car's airborne height (so the view rises
   * with the car during jumps).
   */
  readonly height: number;
  /** Heading the camera is looking along, in radians (matches the car). */
  readonly heading: number;
  /** The clamped behind offset actually applied, in pixels. */
  readonly behindPx: number;
  /** The clamped above offset actually applied, in pixels. */
  readonly abovePx: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamps `value` into the inclusive range `[min, max]`. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) {
    return min;
  }
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}

/**
 * Unit forward vector for a heading, using the physics convention
 * (0 rad = +Y / north, increasing clockwise). Clockwise-from-north means the
 * x component follows `sin(heading)` and the y component follows
 * `cos(heading)`.
 */
export function headingToForward(heading: number): Vec2 {
  return { x: Math.sin(heading), y: Math.cos(heading) };
}

// ---------------------------------------------------------------------------
// Camera placement (Requirement 11.1)
// ---------------------------------------------------------------------------

/**
 * Places the camera relative to the leading car.
 *
 * The camera is pushed **behind** the car (opposite its heading) by a distance
 * clamped to 150–300 px and lifted **above** the ground by a height clamped to
 * 60–120 px, per Requirement 11.1. During a jump the car's airborne height is
 * added to the camera height so the view tracks the car upward.
 *
 * This is a pure function: identical inputs always yield an identical
 * {@link CameraState}.
 *
 * @param target - The leading car's position/heading (and optional airborne
 *   height).
 * @param request - Optional desired offsets; clamped into the allowed ranges.
 * @returns The resolved camera pose.
 */
export function placeCamera(
  target: CameraTarget,
  request: CameraOffsetRequest = {},
): CameraState {
  const behindPx = clamp(
    request.behindPx ?? CAMERA_BEHIND_DEFAULT_PX,
    CAMERA_BEHIND_MIN_PX,
    CAMERA_BEHIND_MAX_PX,
  );
  const abovePx = clamp(
    request.abovePx ?? CAMERA_ABOVE_DEFAULT_PX,
    CAMERA_ABOVE_MIN_PX,
    CAMERA_ABOVE_MAX_PX,
  );

  const forward = headingToForward(target.heading);
  // "Behind" is opposite the forward direction.
  const eye: Vec2 = {
    x: target.position.x - forward.x * behindPx,
    y: target.position.y - forward.y * behindPx,
  };

  const airborne = target.airborneHeight ?? 0;

  return {
    eye,
    height: abovePx + Math.max(0, airborne),
    heading: target.heading,
    behindPx,
    abovePx,
  };
}

// ---------------------------------------------------------------------------
// Scanline projection
// ---------------------------------------------------------------------------

/**
 * Parameters controlling the scanline projection. `screenHeight` and
 * `horizonRow` are in screen pixels (row 0 = top of the screen). `focalLength`
 * is the projection focal length in pixels and controls how quickly depth
 * grows toward the horizon.
 */
export interface ProjectionParams {
  /** Total number of screen rows (canvas height in pixels). */
  readonly screenHeight: number;
  /** Screen row of the horizon line. Rows below this map to the ground. */
  readonly horizonRow: number;
  /** Projection focal length in pixels (> 0). */
  readonly focalLength: number;
}

/** The projection result for a single screen row. */
export interface ScanlineProjection {
  /** The screen row this projection is for (0 = top). */
  readonly row: number;
  /**
   * World-space depth in front of the camera for this row, in track units.
   * `Infinity` for rows at or above the horizon (they never touch the ground).
   */
  readonly depth: number;
  /**
   * Projected scale of one world unit at this depth (`focalLength / depth`).
   * `0` at/above the horizon (infinitely small), growing toward the bottom.
   */
  readonly scale: number;
  /** True when this row is at or above the horizon (sky, not road). */
  readonly aboveHorizon: boolean;
}

/**
 * Projects a single screen row to its world-space ground depth.
 *
 * Rows at or above the horizon return `depth = Infinity`, `scale = 0`, and
 * `aboveHorizon = true` — the caller should draw sky there rather than road.
 * Rows below the horizon return a finite, strictly-positive depth that
 * decreases (gets closer) as the row moves toward the bottom of the screen.
 *
 * Pure function of `(row, camera, params)`.
 *
 * @param row - Screen row to project (0 = top of screen).
 * @param camera - The resolved camera pose from {@link placeCamera}.
 * @param params - Projection parameters (screen height, horizon, focal length).
 */
export function projectScanline(
  row: number,
  camera: CameraState,
  params: ProjectionParams,
): ScanlineProjection {
  const dy = row - params.horizonRow;
  if (dy <= 0) {
    return { row, depth: Infinity, scale: 0, aboveHorizon: true };
  }
  const depth = (camera.height * params.focalLength) / dy;
  const scale = params.focalLength / depth;
  return { row, depth, scale, aboveHorizon: false };
}

/**
 * Projects every screen row in `[0, params.screenHeight)` to its ground depth.
 * A convenience wrapper over {@link projectScanline} that returns the rows in
 * top-to-bottom order (index 0 = screen row 0).
 *
 * @param camera - The resolved camera pose.
 * @param params - Projection parameters.
 * @returns One {@link ScanlineProjection} per screen row.
 */
export function projectAllScanlines(
  camera: CameraState,
  params: ProjectionParams,
): ScanlineProjection[] {
  const rows: ScanlineProjection[] = [];
  const count = Math.max(0, Math.floor(params.screenHeight));
  for (let row = 0; row < count; row++) {
    rows.push(projectScanline(row, camera, params));
  }
  return rows;
}

/**
 * Maps a world-space depth back to the screen row that would render it, the
 * inverse of {@link projectScanline}'s depth mapping. Used to place scenery /
 * car sprites at the correct vertical position for their depth.
 *
 * @param depth - World-space depth in front of the camera (> 0).
 * @param camera - The resolved camera pose.
 * @param params - Projection parameters.
 * @returns The (possibly fractional) screen row for that depth. Depths `<= 0`
 *   map to `Infinity` (behind the camera / never visible on the ground).
 */
export function depthToRow(
  depth: number,
  camera: CameraState,
  params: ProjectionParams,
): number {
  if (depth <= 0 || !Number.isFinite(depth)) {
    return depth <= 0 ? Infinity : params.horizonRow;
  }
  const dy = (camera.height * params.focalLength) / depth;
  return params.horizonRow + dy;
}

/**
 * Computes the world-space point on the ground plane at a given depth directly
 * ahead of the camera. Callers use this (plus the per-row scale) to figure out
 * which road/scenery tiles from the track texture atlas to sample for a row.
 *
 * @param depth - World-space depth in front of the camera (track units).
 * @param camera - The resolved camera pose.
 * @returns The world-space ground position at that depth along the view axis.
 */
export function groundPointAtDepth(depth: number, camera: CameraState): Vec2 {
  const forward = headingToForward(camera.heading);
  return {
    x: camera.eye.x + forward.x * depth,
    y: camera.eye.y + forward.y * depth,
  };
}
