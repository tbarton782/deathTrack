/**
 * Pure, deterministic AI driver "brain" for the Deathtrack Multiplayer
 * Recreation.
 *
 * {@link computeAIInputs} maps an AI driver's runtime state and its view of the
 * world to a single tick of {@link CarInputs} (throttle / brake / steer /
 * fireForward / fireRear). It is a **pure function** of its arguments: it never
 * reads `Math.random()`, `Date.now()`, or any ambient mutable state, and never
 * mutates its inputs. All randomness is drawn from the supplied {@link RNG}, so
 * a given `(driver, world, config, rng-at-a-fixed-state)` always resolves to
 * identical inputs. This determinism is what lets AI decisions run inside the
 * authoritative lockstep loop and be reproduced during replay/reconciliation.
 *
 * Behaviours (Requirements 6.1–6.6):
 *
 *   1. **Steering** — follow the waypoint racing line resolved by the
 *      {@link WaypointNavigator} for the driver's aggression level. (Req 6.1)
 *   2. **Forward fire** — when an opponent is within forward-weapon range, draw
 *      against the skill-tier hit probability (novice 30 % / standard 60 % /
 *      expert 90 %) and fire on success. Suppressed while evading. (Req 6.2)
 *   3. **Evasive mode** — enter when armor drops below 25 % of max; remain
 *      evasive until armor recovers to ≥ 40 % of max OR no opponent is within
 *      200 units. Offensive fire ceases while evasive. (Req 6.3)
 *   4. **Hazard avoidance** — detect mines/caltrops within the tier detection
 *      radius (novice 50 / standard 100 / expert 150 units) ahead and steer
 *      away from them. (Req 6.4)
 *   5. **Rear drop** — when an opponent is within 10 units directly behind and
 *      the driver is not evading, deploy a rear-drop weapon if one is loaded.
 *      (Req 6.5)
 *   6. **Lap-time variation** — apply the per-lap throttle jitter carried on the
 *      driver state (a ±2 %–±10 % multiplier sampled per lap) so repeated runs
 *      vary within the required band. {@link sampleLapThrottleJitter} draws a
 *      fresh jitter value from the RNG for callers rolling a new lap. (Req 6.6)
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import type { Vec2 } from '../types/primitives.js';
import type { CarInputs, CarPhysicsState, RNG } from '../types/physics.js';
import type { AIDriverConfig, AIDriverState, SkillTier } from '../types/ai.js';
import type { PlacedHazard } from '../types/weapons.js';
import type { WaypointGraph } from '../types/track.js';
import {
  racingLineTarget,
  nextWaypoint,
} from './WaypointNavigator.js';

// ---------------------------------------------------------------------------
// Tunable constants (Requirements 6.2–6.6)
// ---------------------------------------------------------------------------

/**
 * Forward-fire hit probability by skill tier.
 * novice 30 % / standard 60 % / expert 90 %. Requirements: 6.2
 */
export const FIRE_PROBABILITY_BY_TIER: Readonly<Record<SkillTier, number>> = {
  novice: 0.3,
  standard: 0.6,
  expert: 0.9,
};

/**
 * Hazard-detection radius by skill tier, in track-space units.
 * novice 50 / standard 100 / expert 150. Requirements: 6.4
 */
export const HAZARD_RADIUS_BY_TIER: Readonly<Record<SkillTier, number>> = {
  novice: 50,
  standard: 100,
  expert: 150,
};

/** Armor fraction (of max) at/below which the AI enters evasive mode. Requirements: 6.3 */
export const EVASIVE_ENTER_FRACTION = 0.25;

/** Armor fraction (of max) at/above which the AI may exit evasive mode. Requirements: 6.3 */
export const EVASIVE_EXIT_FRACTION = 0.4;

/** Opponent proximity (units) that keeps the AI evasive even above the exit armor. Requirements: 6.3 */
export const EVASIVE_THREAT_RANGE = 200;

/** Distance (units) directly behind the AI within which a trailing opponent triggers a rear drop. Requirements: 6.5 */
export const REAR_DROP_DISTANCE = 10;

/**
 * Cosine threshold defining "directly behind": the opponent's bearing relative
 * to the AI's reverse heading must lie within ~45° for a rear drop to fire.
 * Requirements: 6.5
 */
export const REAR_DROP_CONE_COS = Math.SQRT1_2; // cos(45°)

/** Minimum per-lap throttle-jitter magnitude (±2 %). Requirements: 6.6 */
export const LAP_JITTER_MIN = 0.02;

/** Maximum per-lap throttle-jitter magnitude (±10 %). Requirements: 6.6 */
export const LAP_JITTER_MAX = 0.1;

/** Base throttle the AI applies when cruising the racing line. Requirements: 6.1 */
const BASE_THROTTLE = 1;

// ---------------------------------------------------------------------------
// World input shape
// ---------------------------------------------------------------------------

/**
 * The minimal, read-only view of the world that {@link computeAIInputs} needs
 * to decide a single tick of control inputs for one AI driver.
 *
 * This is intentionally narrower than {@link WorldPhysicsState}: the AI brain
 * only requires the driver's own car, its opponents, placed hazards, the
 * navigation graph, and the driver's armor bookkeeping. Keeping the input
 * explicit (rather than reaching into a broader mutable world) preserves purity
 * and makes the function trivially testable.
 *
 * Requirements: 6.1–6.5
 */
export interface AIBrainWorld {
  /** The AI driver's own current physics state. */
  readonly self: CarPhysicsState;
  /** Current armor of the AI driver's car (hit points). Requirements: 6.3 */
  readonly selfArmor: number;
  /** Maximum armor of the AI driver's car (hit points). Requirements: 6.3 */
  readonly selfMaxArmor: number;
  /** All opponent cars (excluding `self`). Requirements: 6.2, 6.3, 6.5 */
  readonly opponents: ReadonlyArray<CarPhysicsState>;
  /** Hazards currently placed on the track. Requirements: 6.4 */
  readonly hazards: ReadonlyArray<PlacedHazard>;
  /** The waypoint navigation graph for the current track. Requirements: 6.1 */
  readonly waypointGraph: WaypointGraph;
  /**
   * Maximum effective range (units) of the AI's forward weapon, or `null` when
   * no forward weapon is equipped / it has unlimited range handling elsewhere.
   * A `null` range disables the range-gated fire decision. Requirements: 6.2
   */
  readonly forwardWeaponRange: number | null;
  /**
   * Whether a rear-drop weapon is equipped AND has ammo loaded this tick.
   * Requirements: 6.5
   */
  readonly rearWeaponLoaded: boolean;
}

// ---------------------------------------------------------------------------
// Small pure vector helpers
// ---------------------------------------------------------------------------

function sub(a: Vec2, b: Vec2): Vec2 {
  return { x: a.x - b.x, y: a.y - b.y };
}

function len(v: Vec2): number {
  return Math.sqrt(v.x * v.x + v.y * v.y);
}

function distance(a: Vec2, b: Vec2): number {
  return len(sub(a, b));
}

/**
 * Unit forward direction of a car derived from its heading.
 *
 * Matches the physics convention documented on {@link CarPhysicsState.heading}:
 * heading 0 points north (+Y) and increases clockwise, so the forward vector is
 * `(sin θ, cos θ)`.
 */
function forwardVector(heading: number): Vec2 {
  return { x: Math.sin(heading), y: Math.cos(heading) };
}

// ---------------------------------------------------------------------------
// Evasive-mode transition (Requirements 6.3)
// ---------------------------------------------------------------------------

/**
 * Resolve the next evasive-mode flag from the current flag, armor level, and
 * nearest-opponent distance, applying hysteresis:
 *
 *  - Enter evasive when armor < 25 % of max.
 *  - While evasive, remain evasive until armor ≥ 40 % of max OR no opponent is
 *    within {@link EVASIVE_THREAT_RANGE} units.
 *
 * `maxArmor <= 0` is treated as "no armor system" and never triggers evasion.
 *
 * Requirements: 6.3
 */
export function nextEvasive(
  currentlyEvasive: boolean,
  armor: number,
  maxArmor: number,
  nearestOpponentDistance: number,
): boolean {
  if (maxArmor <= 0) return false;
  const fraction = armor / maxArmor;

  if (fraction < EVASIVE_ENTER_FRACTION) {
    // Low armor always (re-)enters evasive mode.
    return true;
  }

  if (!currentlyEvasive) {
    // Not evasive and armor is at/above the enter threshold: stay calm.
    return false;
  }

  // Currently evasive: exit only once recovered OR no opponent is close.
  const recovered = fraction >= EVASIVE_EXIT_FRACTION;
  const threatGone = nearestOpponentDistance > EVASIVE_THREAT_RANGE;
  return !(recovered || threatGone);
}

// ---------------------------------------------------------------------------
// Steering (Requirements 6.1, 6.4)
// ---------------------------------------------------------------------------

/**
 * Compute a normalised steering input in [-1, 1] that turns the car from its
 * current heading toward a world-space `target` point. Negative = steer left.
 *
 * The signed angle between the car's forward vector and the direction to the
 * target is mapped linearly onto [-1, 1] across ±90°, then clamped, giving a
 * proportional controller that is smooth near the target and saturates for
 * sharp turns.
 */
export function steerToward(
  position: Vec2,
  heading: number,
  target: Vec2,
): number {
  const to = sub(target, position);
  if (to.x === 0 && to.y === 0) return 0;

  const fwd = forwardVector(heading);
  // Signed angle: cross gives left/right sign, dot gives forward/back.
  const cross = fwd.x * to.y - fwd.y * to.x;
  const dot = fwd.x * to.x + fwd.y * to.y;
  const angle = Math.atan2(cross, dot);

  // In this physics convention a positive cross (target to the car's left in
  // screen space) corresponds to a left turn, which is negative steer.
  const steer = -angle / (Math.PI / 2);
  return clamp(steer, -1, 1);
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

/**
 * Find the most threatening hazard within the tier detection radius that lies
 * ahead of the car, or `undefined` if none. "Ahead" means the hazard is in the
 * forward half-plane (dot product with the forward vector > 0). The nearest
 * qualifying hazard is returned; ties break on iteration order.
 *
 * Requirements: 6.4
 */
export function detectHazardAhead(
  position: Vec2,
  heading: number,
  hazards: ReadonlyArray<PlacedHazard>,
  radius: number,
): PlacedHazard | undefined {
  const fwd = forwardVector(heading);
  let best: PlacedHazard | undefined;
  let bestDist = Infinity;
  for (const hazard of hazards) {
    if (hazard.triggered) continue;
    const to = sub(hazard.position, position);
    const dist = len(to);
    if (dist > radius || dist === 0) continue;
    // Only avoid hazards in front of us; ones behind are irrelevant.
    const ahead = fwd.x * to.x + fwd.y * to.y;
    if (ahead <= 0) continue;
    if (dist < bestDist) {
      bestDist = dist;
      best = hazard;
    }
  }
  return best;
}

/**
 * Compute an avoidance steering input that turns the car away from a hazard.
 * Returns a value in [-1, 1]; the sign is opposite the side the hazard sits on
 * so the car veers clear. Requirements: 6.4
 */
export function steerAwayFrom(
  position: Vec2,
  heading: number,
  hazard: Vec2,
): number {
  const to = sub(hazard, position);
  const fwd = forwardVector(heading);
  const cross = fwd.x * to.y - fwd.y * to.x;
  // If the hazard is to our left (cross > 0 -> would be a left turn), steer
  // right (positive), and vice versa. Full-lock avoidance.
  if (cross === 0) {
    // Hazard dead ahead: pick a deterministic side (steer right).
    return 1;
  }
  return cross > 0 ? 1 : -1;
}

// ---------------------------------------------------------------------------
// Forward-fire decision (Requirements 6.2, 6.3)
// ---------------------------------------------------------------------------

/**
 * Distance to the nearest opponent, or `Infinity` when there are none.
 */
export function nearestOpponentDistance(
  self: Vec2,
  opponents: ReadonlyArray<CarPhysicsState>,
): number {
  let best = Infinity;
  for (const opp of opponents) {
    const d = distance(self, opp.position);
    if (d < best) best = d;
  }
  return best;
}

/**
 * Decide whether to fire the forward weapon this tick.
 *
 * Fire only when: not evading, a forward-weapon range is defined, at least one
 * opponent is within that range, and a fresh RNG draw falls under the tier's
 * hit probability. The RNG is advanced exactly once when a range check would
 * otherwise pass so the sequence stays deterministic and lockstep-safe.
 *
 * Requirements: 6.2, 6.3
 */
export function decideForwardFire(
  self: Vec2,
  opponents: ReadonlyArray<CarPhysicsState>,
  range: number | null,
  tier: SkillTier,
  evasive: boolean,
  rng: RNG,
): boolean {
  if (evasive) return false;
  if (range === null) return false;
  if (nearestOpponentDistance(self, opponents) > range) return false;
  const probability = FIRE_PROBABILITY_BY_TIER[tier];
  return rng.next() < probability;
}

// ---------------------------------------------------------------------------
// Rear-drop decision (Requirements 6.5)
// ---------------------------------------------------------------------------

/**
 * Decide whether to deploy a rear-drop weapon this tick.
 *
 * Fires when: a rear weapon is loaded, the driver is not evading, and an
 * opponent lies within {@link REAR_DROP_DISTANCE} units *directly behind* — the
 * bearing to the opponent must fall within a ±45° cone around the car's reverse
 * heading. Requirements: 6.5
 */
export function decideRearDrop(
  self: CarPhysicsState,
  opponents: ReadonlyArray<CarPhysicsState>,
  rearWeaponLoaded: boolean,
  evasive: boolean,
): boolean {
  if (!rearWeaponLoaded || evasive) return false;

  const back = forwardVector(self.heading);
  // Reverse heading points behind the car.
  const rev = { x: -back.x, y: -back.y };

  for (const opp of opponents) {
    const to = sub(opp.position, self.position);
    const dist = len(to);
    if (dist > REAR_DROP_DISTANCE || dist === 0) continue;
    // Normalised bearing dot with the reverse heading -> cos of the angle.
    const cos = (to.x * rev.x + to.y * rev.y) / dist;
    if (cos >= REAR_DROP_CONE_COS) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Lap throttle jitter (Requirements 6.6)
// ---------------------------------------------------------------------------

/**
 * Sample a per-lap throttle-jitter multiplier from the RNG.
 *
 * The returned value is `1 + delta` where `delta` has magnitude in
 * [{@link LAP_JITTER_MIN}, {@link LAP_JITTER_MAX}] (±2 %–±10 %) and a random
 * sign, so applying it to a base throttle produces the required lap-time
 * variation band. Advances the RNG twice (magnitude, then sign).
 *
 * Requirements: 6.6
 */
export function sampleLapThrottleJitter(rng: RNG): number {
  const magnitude =
    LAP_JITTER_MIN + rng.next() * (LAP_JITTER_MAX - LAP_JITTER_MIN);
  const sign = rng.next() < 0.5 ? -1 : 1;
  return 1 + sign * magnitude;
}

// ---------------------------------------------------------------------------
// Main brain (Requirements 6.1–6.6)
// ---------------------------------------------------------------------------

/**
 * Compute one tick of control inputs for an AI driver.
 *
 * Pure and deterministic: every random choice is drawn from `rng`, and no
 * argument is mutated. The returned {@link CarInputs} reflect, in order:
 * evasive-mode transition (Req 6.3), racing-line steering with hazard avoidance
 * override (Req 6.1 / 6.4), forward-fire decision (Req 6.2), rear-drop decision
 * (Req 6.5), and per-lap throttle jitter carried on the driver state (Req 6.6).
 *
 * Note: this does NOT resample the lap jitter — that is done at lap boundaries
 * via {@link sampleLapThrottleJitter} — so calling `computeAIInputs` repeatedly
 * within a lap is stable for a given RNG state.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */
export function computeAIInputs(
  driver: AIDriverState,
  world: AIBrainWorld,
  config: AIDriverConfig,
  rng: RNG,
): CarInputs {
  const { self } = world;

  // --- Evasive-mode transition (Req 6.3) ---
  const oppDist = nearestOpponentDistance(self.position, world.opponents);
  const evasive = nextEvasive(
    driver.evasive,
    world.selfArmor,
    world.selfMaxArmor,
    oppDist,
  );

  // --- Steering: racing line, overridden by hazard avoidance (Req 6.1 / 6.4) ---
  const radius = HAZARD_RADIUS_BY_TIER[config.skillTier];
  const hazard = detectHazardAhead(self.position, self.heading, world.hazards, radius);

  let steer: number;
  if (hazard !== undefined) {
    steer = steerAwayFrom(self.position, self.heading, hazard.position);
  } else {
    const target = racingLineTarget(
      world.waypointGraph,
      // nextWaypoint returns the node to aim at; racingLineTarget offsets it.
      nextWaypoint(world.waypointGraph, self.position) ?? {
        id: -1,
        position: self.position,
        width: 0,
      },
      config.aggression,
    );
    steer = steerToward(self.position, self.heading, target);
  }

  // --- Throttle with per-lap jitter (Req 6.6) ---
  const throttle = clamp(BASE_THROTTLE * driver.lapThrottleJitter, 0, 1);

  // --- Forward-fire decision (Req 6.2, suppressed while evasive per 6.3) ---
  const fireForward = decideForwardFire(
    self.position,
    world.opponents,
    world.forwardWeaponRange,
    config.skillTier,
    evasive,
    rng,
  );

  // --- Rear-drop decision (Req 6.5) ---
  const fireRear = decideRearDrop(self, world.opponents, world.rearWeaponLoaded, evasive);

  return {
    throttle,
    brake: 0,
    steer,
    fireForward,
    fireRear,
  };
}
