/**
 * Pure, deterministic physics step for the Deathtrack Multiplayer Recreation.
 *
 * `stepPhysics` advances the whole world by a single fixed 1/60 s tick. It is a
 * pure function of its arguments: it never reads `Math.random()`, `Date.now()`,
 * or any ambient mutable state, and it never mutates the inputs it is given. All
 * randomness must be drawn from the explicitly-passed {@link RNG}. This is what
 * makes the simulation safe for lockstep client/server reconciliation and for
 * replay: the same `(state, inputs, dt, rng-seed)` always yields byte-identical
 * output.
 *
 * This module currently implements the *base* step:
 *   - throttle / brake speed ramp, clamped to `[0, effectiveTopSpeed]`
 *   - steering whose rate scales with handling and inversely with speed
 *   - off-track traction penalty (halved handling, halved speed cap)
 *   - deterministic iteration of cars sorted by {@link ParticipantId}
 *
 * Collision resolution (task 6.3) runs as a post-integration pass: after every
 * car has been advanced, overlapping car pairs are detected and momentum-
 * conserving impulses are applied to any pair whose closing speed exceeds
 * 0.5 units/s, resolving multiple collisions on the same car hardest-first
 * (Req 1.6, 1.8).
 *
 * Jump ramps (task 6.4) run as a per-car pass folded into the integration step:
 * a grounded car that reaches a ramp is launched with a vertical velocity
 * proportional to the ramp angle and its speed, then gravity decelerates that
 * velocity each subsequent tick until the car returns to surface level, at which
 * point it lands (Req 1.7). Launch/land moments emit `jump_launch` / `jump_land`
 * events.
 *
 * Pit-lane restoration (task 6.5) runs as a final pass over the post-collision
 * positions: a car reaching the pit-lane entry point emits a `pit_lane_enter`
 * event and one reaching the exit emits `pit_lane_exit`. Crucially, the physics
 * step does *not* own armor or ammo — those live in `CarRaceState`, not in
 * `CarPhysicsState`. So the step only *signals* the transition; the authority
 * loop / weapon system restores `currentArmor = maxArmor` and reloads all ammo
 * on the enter event, guaranteeing completion before the matching exit
 * (Req 9.3, 9.4).
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 9.3, 9.4
 */

import type { ParticipantId, Vec2 } from '../types/primitives.js';
import type {
  CarInputs,
  CarPhysicsState,
  PhysicsEvent,
  PhysicsStepResult,
  RNG,
  WorldPhysicsState,
} from '../types/physics.js';
import type { JumpRamp, PitLaneData } from '../types/track.js';

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/**
 * The subset of a car's resolved stats the physics step needs each tick.
 *
 * These mirror the relevant fields of `EffectiveCarStats` but are kept as a
 * dedicated, minimal shape so the physics module has no dependency on the car /
 * loadout module. Values follow the design's stat ranges (units/s, units/s²,
 * turn-rate factor 1..100).
 *
 * Requirements: 1.2, 1.3, 1.4
 */
export interface PhysicsCarStats {
  /** Top speed in units/second. Speed is clamped to `[0, topSpeed]`. Requirements: 1.2 */
  readonly topSpeed: number;
  /** Acceleration in units/second². Drives the throttle ramp. Requirements: 1.2 */
  readonly acceleration: number;
  /**
   * Braking power in units/second². Drives the brake ramp. If a caller only has
   * the four canonical stats, pass the `handling`-independent brake value here;
   * the design treats braking as proportional to a brake stat (Req 1.3).
   */
  readonly brake: number;
  /** Turn-rate factor (design range 1..100). Drives steering. Requirements: 1.4 */
  readonly handling: number;
  /**
   * Derived mass used to weight collision impulses (see `EffectiveCarStats.mass`
   * in the design). Heavier cars are deflected less by an impact. Optional so
   * pre-collision callers need not supply it; defaults to
   * {@link DEFAULT_MASS} when absent. Requirements: 1.6
   */
  readonly mass?: number;
  /**
   * Collision radius in track units. Two cars are in contact when the distance
   * between their centres is less than the sum of their radii. Optional;
   * defaults to {@link DEFAULT_COLLISION_RADIUS}. Requirements: 1.6, 1.8
   */
  readonly collisionRadius?: number;
  /**
   * The car's configured *maximum* armor (HP), mirroring
   * `EffectiveCarStats.armor` in the design. The physics step never owns or
   * mutates mutable armor — armor and ammo live in the car/weapon domain
   * (`CarRaceState`), not in {@link CarPhysicsState}. This value is read only to
   * populate {@link PitLaneEnterEvent.maxArmor} and
   * {@link PitLaneExitEvent.restoredArmor} so the authority loop / weapon system
   * knows the target to restore to when it applies the pit-lane restoration.
   * Optional; defaults to {@link DEFAULT_MAX_ARMOR} when absent. Requirements: 9.4
   */
  readonly armor?: number;
}

/**
 * Signed-distance-field lookup for off-track detection.
 *
 * Returns the signed distance (in track units) from `position` to the nearest
 * road-surface boundary: positive when the point is on the road, negative when
 * it is outside. Precomputed from track geometry (see design "Physics Errors").
 * A car is considered off-track when this value is `< 0`.
 *
 * Requirements: 1.5
 */
export type TrackSDF = (position: Vec2) => number;

/**
 * Optional per-step configuration passed alongside the world state. Kept
 * optional so the base contract `stepPhysics(state, inputs, dt, rng)` is
 * preserved; callers that have resolved stats and track geometry supply them
 * through {@link WorldPhysicsState} (via the optional `carStats` / `trackSDF`
 * fields) — see {@link PhysicsWorldExtras}.
 */
export interface PhysicsWorldExtras {
  /** Resolved per-car stats keyed by participant. */
  readonly carStats?: ReadonlyMap<ParticipantId, PhysicsCarStats>;
  /** Track signed-distance field for off-track detection. */
  readonly trackSDF?: TrackSDF;
  /**
   * Jump ramps present on the current track, in track-space units. A car that
   * is on the ground and comes within {@link RAMP_CONTACT_RADIUS} of a ramp's
   * trigger point is launched airborne (Req 1.7). Supplied here rather than on
   * the shared {@link WorldPhysicsState} so the base snapshot type stays a pure
   * geometry-free shape. When absent, no jumps occur.
   */
  readonly jumpRamps?: readonly JumpRamp[];
  /**
   * Pit-lane geometry for the current track, in track-space units. When a car
   * reaches the pit-lane {@link PitLaneData.entryPosition} it enters the pit
   * lane; when it later reaches the {@link PitLaneData.exitPosition} it leaves.
   * Supplied here (rather than on the shared {@link WorldPhysicsState}) so the
   * base snapshot type stays geometry-free — the same non-breaking pattern used
   * for {@link jumpRamps}. When absent, no pit-lane transitions occur.
   *
   * The physics step only *detects* these transitions and emits
   * `pit_lane_enter` / `pit_lane_exit` events; the actual armor/ammo
   * restoration is applied by the authority loop, which owns `CarRaceState`.
   * Requirements: 9.3, 9.4
   */
  readonly pitLane?: PitLaneData;
}

/**
 * `WorldPhysicsState` augmented with the optional physics inputs this step
 * reads. The base `WorldPhysicsState` intentionally omits stats/geometry so it
 * stays a pure snapshot; this alias documents the fields `stepPhysics` will use
 * when present without widening the shared type in a breaking way.
 */
export type PhysicsWorldState = WorldPhysicsState & PhysicsWorldExtras;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The fixed simulation timestep: 60 updates per second. Requirements: 1.1 */
export const FIXED_TIMESTEP = 1 / 60;

/** Traction multiplier applied to handling while off-track. Requirements: 1.5 */
const OFF_TRACK_HANDLING_FACTOR = 0.5;

/** Fraction of top speed a car may hold while off-track. Requirements: 1.5 */
const OFF_TRACK_SPEED_CAP_FACTOR = 0.5;

/**
 * Speed floor used when scaling the steering rate. Below this the turn rate is
 * computed as if the car were moving at exactly 1 unit/second, so a nearly
 * stationary car does not spin arbitrarily fast. Requirements: 1.4
 */
const MIN_STEER_SPEED = 1;

/**
 * Default stats used when a caller supplies no `carStats` entry for a car. These
 * are deliberately conservative mid-range values so the step remains total for
 * any well-formed world; production callers always pass resolved stats.
 */
const DEFAULT_STATS: PhysicsCarStats = {
  topSpeed: 50,
  acceleration: 30,
  brake: 40,
  handling: 50,
};

/**
 * Minimum relative approach speed (along the contact normal) for an impulse to
 * be applied. Contacts with a relative velocity at or below this are treated as
 * resting/separating and produce no impulse and no event. Requirements: 1.6
 */
const COLLISION_VELOCITY_THRESHOLD = 0.5;

/**
 * Coefficient of restitution for car-car impacts. 0 = perfectly inelastic,
 * 1 = perfectly elastic. A partly-elastic value gives arcadey bounce while
 * conserving momentum exactly (restitution never adds momentum). Requirements: 1.6
 */
const COLLISION_RESTITUTION = 0.4;

/** Default mass used when a car's stats omit `mass`. Requirements: 1.6 */
const DEFAULT_MASS = 1;

/** Default collision radius (track units) when stats omit `collisionRadius`. Requirements: 1.6 */
const DEFAULT_COLLISION_RADIUS = 1;

/**
 * Gravitational deceleration applied to a car's vertical velocity each second
 * while airborne, in track units/second². Chosen so a mid-speed launch produces
 * a jump lasting a fraction of a second before returning to surface level. The
 * exact value is arcadey rather than physical; only the shape of the arc (rise
 * then fall to `airborneHeight <= 0`) is required by Req 1.7.
 */
const GRAVITY = 60;

/**
 * Distance (track units) within which a grounded car is considered to have
 * reached a jump ramp's trigger point. Contact launches the car airborne
 * (Req 1.7). Cars already airborne cannot be re-launched by another ramp until
 * they land.
 */
const RAMP_CONTACT_RADIUS = 2;

/**
 * Distance (track units) within which a car is considered to have reached a
 * pit-lane trigger point (entry or exit). Reaching the entry point while
 * outside the pit lane enters it; reaching the exit point while inside it
 * leaves. Requirements: 9.3, 9.4
 */
const PIT_LANE_CONTACT_RADIUS = 2;

/**
 * Default configured maximum armor used to populate pit-lane restoration events
 * when a car's stats omit `armor`. Armor is not owned by the physics step; this
 * is only a reporting fallback so the emitted events always carry a value.
 * Requirements: 9.4
 */
const DEFAULT_MAX_ARMOR = 100;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamps `value` into the inclusive range `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** No-op input used when a car has no entry in the input map for this tick. */
const IDLE_INPUTS: CarInputs = {
  throttle: 0,
  brake: 0,
  steer: 0,
  fireForward: false,
  fireRear: false,
};

/** The airborne sub-state of a car after the jump pass for one tick. */
interface AirborneState {
  readonly airborne: boolean;
  readonly airborneHeight: number;
  readonly airborneVY: number;
}

/**
 * Advances a car's jump / airborne state by one tick (Req 1.7).
 *
 * Two cases, both pure with respect to the inputs:
 *
 *  - **Grounded and touching a ramp**: the car is launched. Vertical launch
 *    velocity is proportional to the ramp's angle and the car's current speed:
 *    `launchVY = speed * sin(angle) * launchMultiplier`. The car becomes
 *    airborne with `airborneHeight` starting at 0, and a {@link JumpLaunchEvent}
 *    is emitted. A launch only happens when `launchVY > 0` (a level ramp, or a
 *    stationary car, produces no jump).
 *
 *  - **Already airborne**: gravity decelerates the vertical velocity
 *    (`vy -= GRAVITY * dt`) and the height integrates from it
 *    (`height += vy * dt`). When the height returns to (or below) surface level
 *    the car lands: airborne clears, height/vy reset to 0, and a
 *    {@link JumpLandEvent} carrying the landing ground speed is emitted.
 *
 * A grounded car not touching any ramp stays grounded with zeroed airborne
 * fields.
 */
function stepJump(
  id: ParticipantId,
  position: Vec2,
  groundSpeed: number,
  prevAirborne: boolean,
  prevHeight: number,
  prevVY: number,
  dt: number,
  ramps: readonly JumpRamp[] | undefined,
  events: PhysicsEvent[],
): AirborneState {
  if (prevAirborne) {
    // Apply gravity to the vertical velocity, then integrate the height.
    const vy = prevVY - GRAVITY * dt;
    const height = prevHeight + vy * dt;

    if (height <= 0) {
      // Returned to surface level: land.
      events.push({ type: 'jump_land', participantId: id, landingSpeed: groundSpeed });
      return { airborne: false, airborneHeight: 0, airborneVY: 0 };
    }

    return { airborne: true, airborneHeight: height, airborneVY: vy };
  }

  // Grounded: check for a ramp contact that would launch the car.
  if (ramps) {
    for (const ramp of ramps) {
      const dx = position.x - ramp.position.x;
      const dy = position.y - ramp.position.y;
      if (Math.hypot(dx, dy) > RAMP_CONTACT_RADIUS) continue;

      // Vertical launch velocity ∝ ramp angle and current speed (Req 1.7).
      const launchVY = groundSpeed * Math.sin((ramp.angle * Math.PI) / 180) * ramp.launchMultiplier;
      if (launchVY <= 0) continue; // level/backwards ramp or stationary car: no jump.

      events.push({ type: 'jump_launch', participantId: id, launchVY });
      return { airborne: true, airborneHeight: 0, airborneVY: launchVY };
    }
  }

  return { airborne: false, airborneHeight: 0, airborneVY: 0 };
}

/**
 * Advances a single car by one tick and appends any track-transition events.
 *
 * Pure with respect to `car`: returns a fresh {@link CarPhysicsState} and never
 * mutates the argument. The RNG is threaded in for future stochastic effects
 * (e.g. surface scatter) so the signature is stable across later tasks; the base
 * step does not currently draw from it.
 */
function stepCar(
  car: CarPhysicsState,
  inputs: CarInputs,
  stats: PhysicsCarStats,
  dt: number,
  trackSDF: TrackSDF | undefined,
  ramps: readonly JumpRamp[] | undefined,
  events: PhysicsEvent[],
  // rng reserved for later stochastic effects; unused in the base step.
  _rng: RNG,
): CarPhysicsState {
  // --- Off-track detection via signed-distance-field lookup (Req 1.5) -------
  // When no SDF is supplied we trust the incoming `onTrack` flag so the step
  // stays usable in unit contexts that set the flag directly.
  const onTrack = trackSDF ? trackSDF(car.position) >= 0 : car.onTrack;

  if (onTrack !== car.onTrack) {
    if (onTrack) {
      events.push({ type: 'on_track', participantId: car.id, position: car.position });
    } else {
      events.push({ type: 'off_track', participantId: car.id, position: car.position });
    }
  }

  // --- Longitudinal speed ramp (throttle / brake), Req 1.2 & 1.3 -----------
  const throttle = clamp(inputs.throttle, 0, 1);
  const brake = clamp(inputs.brake, 0, 1);

  // Off-track caps the achievable top speed to 50% of configured (Req 1.5).
  const effectiveTopSpeed = onTrack
    ? stats.topSpeed
    : stats.topSpeed * OFF_TRACK_SPEED_CAP_FACTOR;

  // Throttle adds speed proportional to acceleration; brake subtracts speed
  // proportional to the brake stat. Both scale with dt.
  const accelDelta = throttle * stats.acceleration * dt;
  const brakeDelta = brake * stats.brake * dt;

  let speed = car.speed + accelDelta - brakeDelta;

  // Clamp into [0, effectiveTopSpeed]: never below zero (Req 1.3), never above
  // the configured (or off-track-capped) maximum (Req 1.2, 1.5).
  speed = clamp(speed, 0, effectiveTopSpeed);

  // --- Steering / heading change, Req 1.4 ----------------------------------
  const steer = clamp(inputs.steer, -1, 1);

  // Off-track halves effective handling (Req 1.5).
  const effectiveHandling = onTrack
    ? stats.handling
    : stats.handling * OFF_TRACK_HANDLING_FACTOR;

  // Turn rate is proportional to handling and inversely proportional to speed,
  // with speeds at or below 1 unit/s treated as exactly 1 (Req 1.4). Handling
  // is normalised by 100 (design stat range 1..100) into a radians/second
  // turn-rate coefficient.
  const steerSpeed = Math.max(speed, MIN_STEER_SPEED);
  const handlingCoeff = effectiveHandling / 100;
  const angularVelocity = (steer * handlingCoeff) / steerSpeed;

  let heading = car.heading + angularVelocity * dt;
  // Normalise heading into [0, 2π) so downstream consumers and equality checks
  // see a canonical value. Requirements: 1.1
  const TAU = Math.PI * 2;
  heading = ((heading % TAU) + TAU) % TAU;

  // --- Integrate position from the new heading & speed ---------------------
  // Heading 0 = north (positive Y), increasing clockwise, per CarPhysicsState.
  const velocity: Vec2 = {
    x: speed * Math.sin(heading),
    y: speed * Math.cos(heading),
  };

  const position: Vec2 = {
    x: car.position.x + velocity.x * dt,
    y: car.position.y + velocity.y * dt,
  };

  // --- Jump ramp / airborne integration (Req 1.7) --------------------------
  // Launch on ramp contact, otherwise advance any in-progress jump under
  // gravity until the car returns to surface level. Uses the freshly-integrated
  // position so ramp contact reflects where the car actually is this tick.
  const jump = stepJump(
    car.id,
    position,
    speed,
    car.airborne,
    car.airborneHeight,
    car.airborneVY,
    dt,
    ramps,
    events,
  );

  return {
    id: car.id,
    position,
    velocity,
    heading,
    speed,
    angularVelocity,
    onTrack,
    airborne: jump.airborne,
    airborneHeight: jump.airborneHeight,
    airborneVY: jump.airborneVY,
  };
}

// ---------------------------------------------------------------------------
// Collision resolution (Req 1.6, 1.8)
// ---------------------------------------------------------------------------

/**
 * A candidate car-pair contact detected after position integration.
 *
 * `relativeSpeed` is the closing speed along the contact normal (positive means
 * the two cars are approaching). Pairs are keyed by the lower/higher
 * ParticipantId so the ordering is deterministic and each pair appears once.
 */
interface CollisionPair {
  readonly a: ParticipantId;
  readonly b: ParticipantId;
  /** Closing speed along the contact normal, in units/second. */
  readonly relativeSpeed: number;
}

/** Resolved collision stats for a car, with defaults applied. */
interface CollisionStats {
  readonly mass: number;
  readonly radius: number;
}

function resolveCollisionStats(stats: PhysicsCarStats): CollisionStats {
  const mass = stats.mass ?? DEFAULT_MASS;
  const radius = stats.collisionRadius ?? DEFAULT_COLLISION_RADIUS;
  return {
    mass: mass > 0 ? mass : DEFAULT_MASS,
    radius: radius > 0 ? radius : DEFAULT_COLLISION_RADIUS,
  };
}

/**
 * Applies a single collision impulse to the two cars identified by `a`/`b`,
 * mutating the `mutable` velocity/speed lookup in place, and appends the two
 * mirrored {@link CollisionEvent}s.
 *
 * Uses the standard 2D impulse formula along the contact normal `n`:
 *
 *   vRel = (vB - vA) · n                       (closing speed; negative = approaching)
 *   j    = -(1 + e) · vRel / (1/mA + 1/mB)      (scalar impulse)
 *   vA  -= (j / mA) · n ;  vB += (j / mB) · n
 *
 * Because the impulse `j·n` is applied equal-and-opposite (subtracted from A,
 * added to B), total linear momentum `mA·vA + mB·vB` is exactly preserved for
 * any restitution `e` — this is what Property 4 checks. The impulse is only
 * applied by the caller when the *approach* speed exceeds the threshold.
 */
function applyImpulse(
  a: ParticipantId,
  b: ParticipantId,
  mutable: Map<ParticipantId, { vx: number; vy: number }>,
  positions: ReadonlyMap<ParticipantId, Vec2>,
  statsById: ReadonlyMap<ParticipantId, CollisionStats>,
  events: PhysicsEvent[],
  // Detection-time closing speed used for the emitted event's `relativeSpeed`.
  // This matches the value used to order collisions (Req 1.8) and is stable
  // regardless of other collisions resolved earlier in the same tick.
  detectedRelativeSpeed: number,
): void {
  const va = mutable.get(a)!;
  const vb = mutable.get(b)!;
  const pa = positions.get(a)!;
  const pb = positions.get(b)!;
  const sa = statsById.get(a)!;
  const sb = statsById.get(b)!;

  // Contact normal pointing from A to B. Fall back to a fixed axis when the two
  // centres coincide so the resolution stays total and deterministic.
  let nx = pb.x - pa.x;
  let ny = pb.y - pa.y;
  let dist = Math.hypot(nx, ny);
  if (dist === 0) {
    nx = 1;
    ny = 0;
    dist = 1;
  }
  nx /= dist;
  ny /= dist;

  // Closing speed along the normal: (vB - vA)·n. Negative when approaching.
  const relNormal = (vb.vx - va.vx) * nx + (vb.vy - va.vy) * ny;

  const invMassA = 1 / sa.mass;
  const invMassB = 1 / sb.mass;

  // Scalar impulse magnitude (signed). For an approaching pair (relNormal < 0)
  // this is positive.
  const j = (-(1 + COLLISION_RESTITUTION) * relNormal) / (invMassA + invMassB);

  const jx = j * nx;
  const jy = j * ny;

  mutable.set(a, { vx: va.vx - jx * invMassA, vy: va.vy - jy * invMassA });
  mutable.set(b, { vx: vb.vx + jx * invMassB, vy: vb.vy + jy * invMassB });

  // Impulse magnitude experienced by each car as a change in speed (|Δv|).
  const impulseA = Math.abs(j) * invMassA;
  const impulseB = Math.abs(j) * invMassB;

  events.push({
    type: 'collision',
    participantId: a,
    otherParticipantId: b,
    relativeSpeed: detectedRelativeSpeed,
    impulseMagnitude: impulseA,
  });
  events.push({
    type: 'collision',
    participantId: b,
    otherParticipantId: a,
    relativeSpeed: detectedRelativeSpeed,
    impulseMagnitude: impulseB,
  });
}

/**
 * Detects car-pair contacts among the integrated car states and resolves them
 * with momentum-conserving impulses, returning a new per-id velocity/speed
 * lookup. Pure with respect to its inputs.
 *
 * Detection uses circle overlap on the post-integration positions. A contact
 * produces an impulse (and a pair of {@link CollisionEvent}s) only when the
 * closing speed along the contact normal exceeds
 * {@link COLLISION_VELOCITY_THRESHOLD} (Req 1.6).
 *
 * Ordering (Req 1.8): all qualifying contacts are collected, then resolved in
 * order of decreasing relative (closing) speed. Ties break deterministically by
 * `(a, b)` ParticipantId. This means when one car is involved in several
 * collisions in the same tick, the hardest impact is resolved first.
 */
function resolveCollisions(
  cars: readonly CarPhysicsState[],
  statsFor: (id: ParticipantId) => PhysicsCarStats,
  events: PhysicsEvent[],
): Map<ParticipantId, { vx: number; vy: number }> {
  // Working velocity lookup, seeded from each car's current velocity.
  const mutable = new Map<ParticipantId, { vx: number; vy: number }>();
  const positions = new Map<ParticipantId, Vec2>();
  const statsById = new Map<ParticipantId, CollisionStats>();

  for (const car of cars) {
    mutable.set(car.id, { vx: car.velocity.x, vy: car.velocity.y });
    positions.set(car.id, car.position);
    statsById.set(car.id, resolveCollisionStats(statsFor(car.id)));
  }

  // Iterate pairs in a stable (sorted) car order so pair discovery is
  // deterministic regardless of the incoming array order.
  const sorted = [...cars].sort((x, y) => x.id - y.id);

  const pairs: CollisionPair[] = [];
  for (let i = 0; i < sorted.length; i++) {
    for (let k = i + 1; k < sorted.length; k++) {
      const ca = sorted[i]!;
      const cb = sorted[k]!;

      const sa = statsById.get(ca.id)!;
      const sb = statsById.get(cb.id)!;

      const dx = cb.position.x - ca.position.x;
      const dy = cb.position.y - ca.position.y;
      const dist = Math.hypot(dx, dy);

      // Contact test: overlapping collision circles.
      if (dist >= sa.radius + sb.radius) continue;

      // Closing speed along the contact normal. When centres coincide we use a
      // fixed axis (matching applyImpulse) so the value is well-defined.
      let nx = dx;
      let ny = dy;
      if (dist === 0) {
        nx = 1;
        ny = 0;
      } else {
        nx /= dist;
        ny /= dist;
      }
      const va = mutable.get(ca.id)!;
      const vb = mutable.get(cb.id)!;
      // Approach speed is positive when the cars are closing on each other.
      const approachSpeed = -((vb.vx - va.vx) * nx + (vb.vy - va.vy) * ny);

      // Only pairs approaching faster than the threshold produce an impulse
      // (Req 1.6). Separating or grazing contacts are ignored.
      if (approachSpeed <= COLLISION_VELOCITY_THRESHOLD) continue;

      pairs.push({ a: ca.id, b: cb.id, relativeSpeed: approachSpeed });
    }
  }

  // Resolve in decreasing relative-velocity order (Req 1.8); ties break by
  // (a, b) for determinism.
  pairs.sort((p, q) => {
    if (q.relativeSpeed !== p.relativeSpeed) return q.relativeSpeed - p.relativeSpeed;
    if (p.a !== q.a) return p.a - q.a;
    return p.b - q.b;
  });

  for (const pair of pairs) {
    applyImpulse(pair.a, pair.b, mutable, positions, statsById, events, pair.relativeSpeed);
  }

  return mutable;
}

// ---------------------------------------------------------------------------
// Pit-lane detection & restoration signalling (Req 9.3, 9.4)
// ---------------------------------------------------------------------------

/** Squared distance between two points — avoids a sqrt in the contact test. */
function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Detects pit-lane entry and exit for every car and appends the corresponding
 * restoration events. Returns the set of participants that are inside the pit
 * lane *after* this tick, so the authority loop can thread it back through the
 * next tick's {@link WorldPhysicsState.pitLaneOccupants}.
 *
 * The physics step deliberately does **not** touch armor or ammo: those live in
 * the car/weapon domain (`CarRaceState`), not in {@link CarPhysicsState}. This
 * pass only *signals* the transitions; the authority loop applies
 * `currentArmor = maxArmor` and reloads all weapons when it sees a
 * `pit_lane_enter` event, guaranteeing the restoration is complete before the
 * matching `pit_lane_exit`.
 *
 * Edge-triggered semantics (mirroring the on/off-track pattern):
 *
 *  - A car that is **not** currently an occupant and comes within
 *    {@link PIT_LANE_CONTACT_RADIUS} of {@link PitLaneData.entryPosition}
 *    *enters*: it joins the occupant set and a {@link PitLaneEnterEvent} is
 *    emitted carrying the car's configured `maxArmor` (the restoration target).
 *
 *  - A car that **is** an occupant and comes within the contact radius of
 *    {@link PitLaneData.exitPosition} *exits*: it leaves the occupant set and a
 *    {@link PitLaneExitEvent} is emitted carrying `restoredArmor` (equal to the
 *    same configured `maxArmor`), asserting the restoration completed in-lane.
 *
 * A car cannot enter and exit in the same tick: entry is only tested for
 * non-occupants and exit only for occupants, and a freshly-entered car is added
 * to the occupant set before exit is considered — but exit uses the
 * *incoming* occupancy, so the earliest a car can exit is the tick after it
 * enters. This ordering is what makes "restoration completes before exit"
 * hold deterministically.
 */
function stepPitLane(
  cars: readonly CarPhysicsState[],
  pitLane: PitLaneData | undefined,
  incomingOccupants: ReadonlySet<ParticipantId>,
  maxArmorFor: (id: ParticipantId) => number,
  events: PhysicsEvent[],
): Set<ParticipantId> {
  // Start from the incoming occupancy so a car mid-visit stays an occupant
  // across ticks until it reaches the exit.
  const occupants = new Set<ParticipantId>(incomingOccupants);
  if (!pitLane) return occupants;

  const radius2 = PIT_LANE_CONTACT_RADIUS * PIT_LANE_CONTACT_RADIUS;

  // Process in ParticipantId order for determinism (Req 1.9).
  const sorted = [...cars].sort((a, b) => a.id - b.id);

  for (const car of sorted) {
    const isOccupant = incomingOccupants.has(car.id);

    if (!isOccupant) {
      // Not in the pit lane: entering when the car reaches the entry point.
      if (dist2(car.position, pitLane.entryPosition) <= radius2) {
        occupants.add(car.id);
        const maxArmor = maxArmorFor(car.id);
        events.push({ type: 'pit_lane_enter', participantId: car.id, maxArmor });
      }
      continue;
    }

    // Already in the pit lane: exiting when the car reaches the exit point.
    if (dist2(car.position, pitLane.exitPosition) <= radius2) {
      occupants.delete(car.id);
      // Restoration completed in-lane: report the value armor was restored to.
      const restoredArmor = maxArmorFor(car.id);
      events.push({ type: 'pit_lane_exit', participantId: car.id, restoredArmor });
    }
  }

  return occupants;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Advances the world physics state by a single fixed timestep.
 *
 * @param state  The current world snapshot. May carry optional `carStats` and
 *   `trackSDF` (see {@link PhysicsWorldState}); when absent, conservative
 *   defaults are used and the incoming `onTrack` flag is trusted.
 * @param inputs Control inputs keyed by {@link ParticipantId}. Cars without an
 *   entry are simulated with idle inputs. The map is never mutated.
 * @param dt     Timestep in seconds. Always {@link FIXED_TIMESTEP} (1/60) in
 *   production; accepted as a parameter to match the design contract.
 * @param rng    Seeded generator; the single source of randomness. Threaded
 *   through for later stochastic effects but not drawn from in the base step.
 * @returns A fresh {@link PhysicsStepResult}. Car ordering matches the input
 *   `state.cars`; cars are *processed* in `ParticipantId` order for determinism
 *   (Req 1.9), independent of the array's incoming order.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.7, 1.9, 9.3, 9.4
 */
export function stepPhysics(
  state: Readonly<PhysicsWorldState>,
  inputs: ReadonlyMap<ParticipantId, CarInputs>,
  dt: number,
  rng: RNG,
): PhysicsStepResult {
  const events: PhysicsEvent[] = [];

  // Determinism (Req 1.9): process cars in a stable order sorted by
  // ParticipantId. We compute results into a lookup keyed by id, then emit the
  // updated array in the original `state.cars` order so callers relying on
  // positional correspondence with the input are unaffected.
  const order: readonly CarPhysicsState[] = [...state.cars].sort((a, b) => a.id - b.id);

  const updatedById = new Map<ParticipantId, CarPhysicsState>();

  for (const car of order) {
    const carInputs = inputs.get(car.id) ?? IDLE_INPUTS;
    const stats = state.carStats?.get(car.id) ?? DEFAULT_STATS;
    const updated = stepCar(car, carInputs, stats, dt, state.trackSDF, state.jumpRamps, events, rng);
    updatedById.set(car.id, updated);
  }

  // --- Collision resolution pass (Req 1.6, 1.8) ----------------------------
  // Detect and resolve car-pair contacts on the freshly integrated states.
  // Impulses only apply above the 0.5 units/s closing-speed threshold, and
  // multiple collisions on one car are resolved hardest-first. The pass
  // conserves total linear momentum (Property 4) and is deterministic.
  const integrated: readonly CarPhysicsState[] = order.map((car) => updatedById.get(car.id)!);
  const statsFor = (id: ParticipantId): PhysicsCarStats =>
    state.carStats?.get(id) ?? DEFAULT_STATS;
  const resolvedVelocities = resolveCollisions(integrated, statsFor, events);

  for (const car of integrated) {
    const v = resolvedVelocities.get(car.id)!;
    if (v.vx === car.velocity.x && v.vy === car.velocity.y) continue;

    // Recompute scalar speed and heading from the post-impulse velocity so the
    // car's derived fields stay consistent. A near-zero velocity keeps the
    // pre-collision heading (direction is undefined at rest).
    const speed = Math.hypot(v.vx, v.vy);
    let heading = car.heading;
    if (speed > 0) {
      // Heading 0 = north (+Y), increasing clockwise: heading = atan2(vx, vy).
      const TAU = Math.PI * 2;
      heading = Math.atan2(v.vx, v.vy);
      heading = ((heading % TAU) + TAU) % TAU;
    }

    updatedById.set(car.id, {
      ...car,
      velocity: { x: v.vx, y: v.vy },
      speed,
      heading,
    });
  }

  // Preserve the incoming array ordering in the output.
  const cars = state.cars.map((car) => updatedById.get(car.id) ?? car);

  // --- Pit-lane detection & restoration signalling (Req 9.3, 9.4) ----------
  // Runs on the final post-integration, post-collision positions so entry/exit
  // reflect where each car actually ends the tick. Emits `pit_lane_enter`
  // (the authority's cue to set currentArmor = maxArmor and reload all ammo)
  // and `pit_lane_exit` (asserting the restoration completed in-lane). The
  // physics step never touches armor/ammo itself — that state lives in
  // `CarRaceState`. Occupancy is threaded across ticks via the incoming
  // `state.pitLaneOccupants` snapshot.
  const incomingOccupants = new Set<ParticipantId>(state.pitLaneOccupants ?? []);
  const maxArmorFor = (id: ParticipantId): number =>
    state.carStats?.get(id)?.armor ?? DEFAULT_MAX_ARMOR;
  stepPitLane(cars, state.pitLane, incomingOccupants, maxArmorFor, events);

  return { cars, events };
}
