/**
 * Pure, GPU-free render-state types and fixed-timestep interpolation for the
 * renderer's per-frame `render(state, alpha)` entry point (task 15.7).
 *
 * Like the other `renderer/*` math modules ({@link ./scanline.scanline},
 * {@link ./carSprite.carSprite}, {@link ./explosion.explosion}), this module
 * contains **no PixiJS / WebGL dependency**. Everything here is a pure function
 * of its arguments so the render-state assembly and the fixed-timestep
 * interpolation can be unit-tested headless (in the `node` vitest environment)
 * without a real rendering context. The PixiJS draw orchestration that consumes
 * a {@link RenderState} lives in {@link ./Renderer.Renderer.render}.
 *
 * ## The fixed-timestep interpolation model
 *
 * The simulation advances in discrete fixed steps (1/60 s). Rendering happens
 * on `requestAnimationFrame`, which fires at the display's refresh rate and is
 * generally *not* aligned to simulation ticks. To avoid visual stutter the
 * renderer draws an interpolated blend of the two most recent simulation
 * snapshots — the `previous` and `current` states — using an interpolation
 * factor `alpha` in `[0, 1]`:
 *
 * ```
 *   rendered = lerp(previous, current, alpha)
 * ```
 *
 * `alpha = 0` draws exactly the previous snapshot, `alpha = 1` draws exactly the
 * current snapshot, and values in between blend positions and headings. This is
 * the standard "fix your timestep" render-interpolation technique. The
 * {@link interpolateRenderState} function here is the pure implementation; the
 * game loop (task 19.1) owns the accumulator that produces `alpha`.
 *
 * Requirements: 2.1–2.4 (pseudo-3D scene, camera follow, depth/airborne car
 * placement), 2.7 (elimination → explosion), 13.2 (60 fps render path).
 */

import type {
  ActiveProjectile,
  EliminationEvent,
  ParticipantId,
  PlacedHazard,
  SceneryObject,
  SpriteAtlas,
  SpritePalette,
  Vec2,
} from '@deathtrack/shared';
import type { Texture } from 'pixi.js';
import type { CameraOffsetRequest, CameraTarget } from './scanline.js';

// ---------------------------------------------------------------------------
// Per-car render input
// ---------------------------------------------------------------------------

/**
 * The per-car data the renderer consumes each frame. A structural subset of the
 * fields carried by the network layer's interpolated car plus the physics
 * airborne height, kept intentionally light so callers can build it from a
 * `CarPhysicsState`, a `CarRaceState.physics`, or the network manager's
 * interpolated `RenderCar`.
 *
 * The position/heading/airborneHeight fields are the ones that vary continuously
 * between simulation ticks and are therefore interpolated by
 * {@link interpolateRenderState}; the remaining fields are taken from the
 * `current` snapshot as-is.
 */
export interface RenderCar {
  /** Participant slot owning this car (0–7). Stable across snapshots. */
  readonly id: ParticipantId;
  /** World-space position in track units. Interpolated. */
  readonly position: Vec2;
  /** Heading in radians (physics convention: 0 = north, clockwise). Interpolated. */
  readonly heading: number;
  /** Height above the road surface in track units (0 when grounded). Interpolated. */
  readonly airborneHeight: number;
  /**
   * Atlas frame key for this car's sprite. Falls back to a plain placeholder
   * when absent or not present in the atlas.
   */
  readonly spriteId?: string;
  /** Whether the car has been eliminated (its sprite is removed post-explosion). */
  readonly eliminated?: boolean;
}

// ---------------------------------------------------------------------------
// The render state consumed by Renderer.render
// ---------------------------------------------------------------------------

/**
 * The complete per-frame data the renderer draws. This is the renderer's own
 * view of the world, distinct from (and richer than) the network layer's
 * interpolated `RenderState` (which carries only cars): it additionally carries
 * the camera target, the static scene (scenery, hazards), in-flight projectiles,
 * elimination events to turn into explosions, and the asset handles (palette,
 * atlas) needed to draw them.
 *
 * A `RenderState` describes a *single* simulation snapshot. To interpolate
 * between two snapshots for smooth rendering, build one `RenderState` per
 * snapshot and blend them with {@link interpolateRenderState}; the continuous
 * fields (car positions/headings/heights) are lerped and the discrete fields
 * (scene, events, assets) are taken from the `current` snapshot.
 */
export interface RenderState {
  /**
   * The car whose viewpoint the camera follows — normally the leading car
   * (Requirement 2.1). Supplies position + heading (+ airborne height) to
   * {@link import('./scanline.js').placeCamera}.
   */
  readonly cameraTarget: CameraTarget;
  /** Optional camera offset overrides (clamped into the Requirement 2.1 ranges). */
  readonly cameraOffsets?: CameraOffsetRequest;
  /** All cars to draw this frame. */
  readonly cars: readonly RenderCar[];
  /** Static scenery objects from the track definition (distance-sorted on draw). */
  readonly scenery: readonly SceneryObject[];
  /** Placed hazards (mines, caltrops, wheel spikes) currently on the track. */
  readonly hazards: readonly PlacedHazard[];
  /** In-flight projectiles currently on the track. */
  readonly projectiles: readonly ActiveProjectile[];
  /**
   * Elimination events emitted since the previous rendered frame. Each spawns
   * a 500–1500 ms explosion at the eliminated car's last-known position
   * (Requirement 2.7). Optional; absent when nothing was eliminated.
   */
  readonly eliminations?: readonly EliminationEvent[];
  /**
   * The active 256-colour palette (Requirement 2.6). When present and changed
   * since the last frame the renderer re-uploads it to the palette shader.
   */
  readonly palette?: SpritePalette;
  /** The sprite/texture atlas frame table used to look up sprites. */
  readonly atlas?: SpriteAtlas;
  /** The PixiJS texture backing {@link atlas}. */
  readonly atlasTexture?: Texture;
  /** Atlas frame key for the road surface band, when sampling from the atlas. */
  readonly roadFrameName?: string;
  /**
   * Ordered atlas frame keys making up the explosion animation, passed through
   * to {@link import('./Renderer.js').Renderer.spawnExplosion}.
   */
  readonly explosionFrameNames?: readonly string[];
}

// ---------------------------------------------------------------------------
// Interpolation helpers
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;

/**
 * Clamps an interpolation factor into `[0, 1]`. A non-finite `alpha` (`NaN`,
 * `Infinity`) degenerates to 0 so a garbage accumulator can never throw the
 * rendered blend outside the two bracketing snapshots.
 *
 * @param alpha - Raw interpolation factor.
 */
export function clampAlpha(alpha: number): number {
  if (!Number.isFinite(alpha)) {
    return 0;
  }
  if (alpha < 0) return 0;
  if (alpha > 1) return 1;
  return alpha;
}

/** Linear interpolation of a scalar. `alpha` is assumed already clamped. */
export function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

/** Linear interpolation of a 2D point. `alpha` is assumed already clamped. */
export function lerpVec2(a: Vec2, b: Vec2, alpha: number): Vec2 {
  return { x: lerp(a.x, b.x, alpha), y: lerp(a.y, b.y, alpha) };
}

/**
 * Shortest-arc angular interpolation in radians. Blends `a → b` along the
 * shorter of the two directions around the circle so a car turning across the
 * 0/2π seam does not spin the long way round. `alpha` is assumed clamped.
 *
 * @param a - Start angle (radians).
 * @param b - End angle (radians).
 * @param alpha - Interpolation factor in `[0, 1]`.
 */
export function lerpAngle(a: number, b: number, alpha: number): number {
  // Normalise the raw delta into (-π, π] then walk `alpha` of the way along it.
  let diff = ((b - a) % TAU + TAU) % TAU;
  if (diff > Math.PI) {
    diff -= TAU;
  }
  return a + diff * alpha;
}

/**
 * Interpolates one car between its `previous` and `current` snapshot states.
 * The continuous fields (position, heading, airborne height) are blended by
 * `alpha`; the discrete/identity fields (`id`, `spriteId`, `eliminated`) are
 * taken from the `current` state.
 *
 * @param previous - The car's state in the previous simulation snapshot.
 * @param current - The car's state in the current simulation snapshot.
 * @param alpha - Clamped interpolation factor in `[0, 1]`.
 */
export function interpolateCar(
  previous: RenderCar,
  current: RenderCar,
  alpha: number,
): RenderCar {
  return {
    id: current.id,
    position: lerpVec2(previous.position, current.position, alpha),
    heading: lerpAngle(previous.heading, current.heading, alpha),
    airborneHeight: lerp(
      previous.airborneHeight,
      current.airborneHeight,
      alpha,
    ),
    ...(current.spriteId !== undefined ? { spriteId: current.spriteId } : {}),
    ...(current.eliminated !== undefined
      ? { eliminated: current.eliminated }
      : {}),
  };
}

/**
 * Interpolates a {@link CameraTarget} between two snapshots (same continuous
 * fields as a car: position, heading, airborne height).
 */
export function interpolateCameraTarget(
  previous: CameraTarget,
  current: CameraTarget,
  alpha: number,
): CameraTarget {
  return {
    position: lerpVec2(previous.position, current.position, alpha),
    heading: lerpAngle(previous.heading, current.heading, alpha),
    ...(current.airborneHeight !== undefined
      ? {
          airborneHeight: lerp(
            previous.airborneHeight ?? 0,
            current.airborneHeight,
            alpha,
          ),
        }
      : {}),
  };
}

/**
 * Produces the render state to draw for the current frame by interpolating the
 * continuously-varying fields (camera target + every car's position, heading
 * and airborne height) between the `previous` and `current` simulation
 * snapshots by `alpha`, while taking every discrete field (scenery, hazards,
 * projectiles, elimination events, palette, atlas) from the `current` snapshot.
 *
 * Cars are matched between snapshots by their {@link RenderCar.id}. A car
 * present only in `current` (newly spawned) is emitted at its `current` state
 * un-interpolated; a car present only in `previous` (despawned) is dropped. The
 * output car order follows the `current` snapshot.
 *
 * This is a pure function: identical inputs always yield an identical result,
 * and neither snapshot is mutated.
 *
 * @param previous - The previous simulation snapshot's render state.
 * @param current - The current simulation snapshot's render state.
 * @param alpha - Interpolation factor in `[0, 1]` (clamped internally).
 * @returns A blended {@link RenderState} ready for {@link Renderer.render}.
 */
export function interpolateRenderState(
  previous: RenderState,
  current: RenderState,
  alpha: number,
): RenderState {
  const a = clampAlpha(alpha);

  const previousById = new Map<ParticipantId, RenderCar>();
  for (const car of previous.cars) {
    previousById.set(car.id, car);
  }

  const cars = current.cars.map((currentCar) => {
    const previousCar = previousById.get(currentCar.id);
    // Newly-spawned car (not in the previous snapshot): no blend possible.
    if (!previousCar) {
      return currentCar;
    }
    return interpolateCar(previousCar, currentCar, a);
  });

  const cameraTarget = interpolateCameraTarget(
    previous.cameraTarget,
    current.cameraTarget,
    a,
  );

  // Discrete fields always come from the current snapshot.
  return {
    ...current,
    cameraTarget,
    cars,
  };
}
