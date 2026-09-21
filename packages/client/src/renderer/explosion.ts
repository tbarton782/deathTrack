/**
 * Pure, GPU-free explosion lifetime state machine for the renderer.
 *
 * Like {@link ./scanline.scanline} and {@link ./carSprite.carSprite}, this
 * module contains **no PixiJS / WebGL dependency**: every function is a pure
 * function of its arguments so the explosion spawn / advance / finish logic can
 * be unit-tested headless (in the `node` vitest environment) without a real
 * rendering context. The PixiJS `AnimatedSprite` draw glue that turns these
 * numbers into on-screen frames lives in {@link ./Renderer.Renderer} (the
 * `spawnExplosion` / `advanceExplosions` methods).
 *
 * ## What this computes
 *
 * When a car is Eliminated the renderer plays an explosion animation at the
 * car's **last-known** screen position for a duration between **500 ms and
 * 1500 ms**, then removes the car sprite once the animation finishes
 * (Requirement 2.7). This module owns that timeline:
 *
 * 1. **Spawn.** {@link spawnExplosion} records the eliminated car's id, its
 *    last-known position, and a duration clamped into `[500, 1500]` ms. The
 *    explosion begins at `elapsedMs = 0`.
 *
 * 2. **Advance.** {@link advanceExplosion} / {@link ExplosionManager.advance}
 *    accumulate elapsed time. An explosion is *active* while
 *    `elapsedMs < durationMs` and *finished* once `elapsedMs >= durationMs`.
 *    {@link explosionProgress} reports a `[0, 1]` fraction for driving the
 *    animation frame.
 *
 * 3. **Finish → remove car.** The tick that first drives an explosion to
 *    finished reports its `eliminatedId` in {@link ExplosionAdvanceResult.carsToRemove}
 *    so the draw glue can remove the associated car sprite exactly once.
 *
 * Multiple concurrent explosions are tracked independently by
 * {@link ExplosionManager}.
 *
 * Requirements: 2.7 (explosion 500–1500 ms at last-known position, remove car
 * sprite on completion).
 */

import type { ParticipantId, Vec2 } from '@deathtrack/shared';

// ---------------------------------------------------------------------------
// Duration bounds (Requirement 2.7)
// ---------------------------------------------------------------------------

/** Minimum explosion animation duration, in milliseconds. */
export const EXPLOSION_MIN_DURATION_MS = 500;
/** Maximum explosion animation duration, in milliseconds. */
export const EXPLOSION_MAX_DURATION_MS = 1500;
/**
 * Default explosion duration used when a caller does not specify one, chosen as
 * the midpoint of the allowed range.
 */
export const EXPLOSION_DEFAULT_DURATION_MS =
  (EXPLOSION_MIN_DURATION_MS + EXPLOSION_MAX_DURATION_MS) / 2;

/**
 * Clamps a requested explosion duration into the allowed `[500, 1500]` ms range
 * (Requirement 2.7). A non-finite request (`NaN`, `Infinity`) falls back to the
 * {@link EXPLOSION_DEFAULT_DURATION_MS default} rather than propagating garbage.
 *
 * @param durationMs - Requested duration in milliseconds.
 * @returns A duration within `[EXPLOSION_MIN_DURATION_MS, EXPLOSION_MAX_DURATION_MS]`.
 */
export function clampExplosionDuration(durationMs: number): number {
  if (!Number.isFinite(durationMs)) {
    return EXPLOSION_DEFAULT_DURATION_MS;
  }
  if (durationMs < EXPLOSION_MIN_DURATION_MS) {
    return EXPLOSION_MIN_DURATION_MS;
  }
  if (durationMs > EXPLOSION_MAX_DURATION_MS) {
    return EXPLOSION_MAX_DURATION_MS;
  }
  return durationMs;
}

// ---------------------------------------------------------------------------
// Single explosion state
// ---------------------------------------------------------------------------

/**
 * The immutable-once-spawned identity of one explosion plus its mutable
 * lifetime cursor. Produced by {@link spawnExplosion} and advanced by
 * {@link advanceExplosion}.
 */
export interface ExplosionState {
  /**
   * The participant whose car was eliminated. Carried through so the draw glue
   * can remove the correct car sprite when this explosion finishes, and so
   * concurrent explosions can be told apart.
   */
  readonly eliminatedId: ParticipantId;
  /**
   * The eliminated car's last-known world/screen position. The explosion plays
   * here for its whole lifetime (Requirement 2.7: "at the Car's last known
   * position"). A defensive copy is taken at spawn so later mutation of the
   * caller's object does not move a live explosion.
   */
  readonly position: Vec2;
  /** Clamped total duration, in milliseconds, within `[500, 1500]`. */
  readonly durationMs: number;
  /** Time elapsed since spawn, in milliseconds. Advances toward `durationMs`. */
  elapsedMs: number;
}

/** Options for {@link spawnExplosion}. */
export interface SpawnExplosionOptions {
  /**
   * Requested animation duration in milliseconds; clamped into `[500, 1500]`.
   * Defaults to {@link EXPLOSION_DEFAULT_DURATION_MS} when omitted.
   */
  readonly durationMs?: number;
}

/**
 * Creates a fresh {@link ExplosionState} for an eliminated car at its
 * last-known position. The duration is clamped into `[500, 1500]` ms and the
 * explosion starts at `elapsedMs = 0` (active).
 *
 * Pure factory: it does not mutate its inputs. The supplied position is copied
 * so the explosion is pinned to the last-known location.
 *
 * @param eliminatedId - Participant whose car was eliminated.
 * @param position - The car's last-known position.
 * @param options - Optional duration override (clamped).
 */
export function spawnExplosion(
  eliminatedId: ParticipantId,
  position: Vec2,
  options: SpawnExplosionOptions = {},
): ExplosionState {
  const requested = options.durationMs ?? EXPLOSION_DEFAULT_DURATION_MS;
  return {
    eliminatedId,
    position: { x: position.x, y: position.y },
    durationMs: clampExplosionDuration(requested),
    elapsedMs: 0,
  };
}

/**
 * Whether an explosion is still playing. Active means `elapsedMs < durationMs`.
 *
 * @param explosion - The explosion to test.
 */
export function isExplosionActive(explosion: ExplosionState): boolean {
  return explosion.elapsedMs < explosion.durationMs;
}

/**
 * Whether an explosion has completed. Finished means `elapsedMs >= durationMs`;
 * the car sprite should be removed on the tick this first becomes true.
 *
 * @param explosion - The explosion to test.
 */
export function isExplosionFinished(explosion: ExplosionState): boolean {
  return explosion.elapsedMs >= explosion.durationMs;
}

/**
 * Normalised `[0, 1]` progress through an explosion's lifetime, suitable for
 * selecting an animation frame. Grounded at 0 on spawn and clamped to 1 once
 * finished. A degenerate zero/negative duration reports 1 (already finished).
 *
 * @param explosion - The explosion to measure.
 */
export function explosionProgress(explosion: ExplosionState): number {
  if (!(explosion.durationMs > 0)) {
    return 1;
  }
  const t = explosion.elapsedMs / explosion.durationMs;
  if (t < 0) return 0;
  if (t > 1) return 1;
  return t;
}

/**
 * Advances a single explosion by `deltaMs` milliseconds, mutating its
 * `elapsedMs` in place, and reports whether this call *transitioned* the
 * explosion from active to finished (i.e. it just completed). Negative deltas
 * are ignored (time does not run backward).
 *
 * @param explosion - The explosion to advance (mutated).
 * @param deltaMs - Elapsed frame time in milliseconds.
 * @returns `true` iff the explosion was active before and is finished after.
 */
export function advanceExplosion(
  explosion: ExplosionState,
  deltaMs: number,
): boolean {
  const wasFinished = isExplosionFinished(explosion);
  if (deltaMs > 0) {
    explosion.elapsedMs += deltaMs;
  }
  return !wasFinished && isExplosionFinished(explosion);
}

// ---------------------------------------------------------------------------
// Multiple concurrent explosions
// ---------------------------------------------------------------------------

/** Result of {@link ExplosionManager.advance}. */
export interface ExplosionAdvanceResult {
  /**
   * Participants whose explosion finished on this tick and whose car sprite
   * should therefore be removed now. Empty when nothing finished. Reported at
   * most once per explosion (the finishing tick).
   */
  readonly carsToRemove: ParticipantId[];
}

/**
 * Tracks any number of concurrent explosions independently, keyed by the
 * eliminated participant id. Each Elimination event spawns one explosion; when
 * an explosion finishes its car is scheduled for removal exactly once.
 *
 * This class is pure logic (no PixiJS): the renderer holds one instance and
 * mirrors its state onto the `explosions` / `cars` draw layers.
 */
export class ExplosionManager {
  private readonly explosions = new Map<ParticipantId, ExplosionState>();

  /**
   * Spawns an explosion for an eliminated car at its last-known position.
   * Re-spawning for a participant that already has a live explosion replaces
   * the previous one (a fresh elimination restarts the animation).
   *
   * @param eliminatedId - Participant whose car was eliminated.
   * @param position - The car's last-known position.
   * @param options - Optional duration override (clamped to `[500, 1500]` ms).
   * @returns The spawned {@link ExplosionState}.
   */
  spawn(
    eliminatedId: ParticipantId,
    position: Vec2,
    options: SpawnExplosionOptions = {},
  ): ExplosionState {
    const explosion = spawnExplosion(eliminatedId, position, options);
    this.explosions.set(eliminatedId, explosion);
    return explosion;
  }

  /** Number of explosions currently tracked (active or awaiting cleanup). */
  get size(): number {
    return this.explosions.size;
  }

  /** The live explosion for a participant, or `undefined` if none. */
  get(eliminatedId: ParticipantId): ExplosionState | undefined {
    return this.explosions.get(eliminatedId);
  }

  /** Whether a participant currently has a tracked explosion. */
  has(eliminatedId: ParticipantId): boolean {
    return this.explosions.has(eliminatedId);
  }

  /** All currently-tracked explosions, in insertion order. */
  active(): ExplosionState[] {
    return [...this.explosions.values()];
  }

  /**
   * Advances every tracked explosion by `deltaMs`, collecting the participants
   * whose explosion finished on this tick, and drops finished explosions from
   * the manager so their entries do not accumulate. Each finished explosion is
   * reported exactly once.
   *
   * @param deltaMs - Elapsed frame time in milliseconds.
   * @returns The set of cars to remove this tick.
   */
  advance(deltaMs: number): ExplosionAdvanceResult {
    const carsToRemove: ParticipantId[] = [];
    for (const [id, explosion] of this.explosions) {
      const justFinished = advanceExplosion(explosion, deltaMs);
      if (justFinished) {
        carsToRemove.push(id);
      }
    }
    // Remove finished explosions after iterating so we don't mutate mid-loop.
    for (const id of carsToRemove) {
      this.explosions.delete(id);
    }
    return { carsToRemove };
  }

  /** Removes all tracked explosions (e.g. on race reset / teardown). */
  clear(): void {
    this.explosions.clear();
  }
}
