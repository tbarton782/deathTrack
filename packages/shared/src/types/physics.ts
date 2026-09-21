/**
 * Physics-related types for the Deathtrack Multiplayer Recreation.
 *
 * Requirements: 1.1–1.9
 */

import type { ParticipantId, TrackId, Vec2 } from './primitives.js';

// ---------------------------------------------------------------------------
// RNG interface
// ---------------------------------------------------------------------------

/**
 * Seeded pseudo-random number generator interface.
 * All physics and AI code must use this RNG — never `Math.random()`.
 * Requirements: 1.9
 */
export interface RNG {
  /** The seed this RNG was initialised with. */
  readonly seed: number;
  /**
   * Returns the next pseudo-random float in [0, 1).
   */
  next(): number;
  /**
   * Returns the next pseudo-random integer in the inclusive range [min, max].
   */
  nextInt(min: number, max: number): number;
}

// ---------------------------------------------------------------------------
// Car state
// ---------------------------------------------------------------------------

/**
 * The complete mutable physics state of a single car for one simulation tick.
 * Requirements: 1.1
 */
export interface CarPhysicsState {
  /** Participant slot owning this car (0–7). */
  readonly id: ParticipantId;
  /** World-space position in track units. */
  readonly position: Vec2;
  /** World-space velocity vector in units/second. */
  readonly velocity: Vec2;
  /** Heading in radians, 0 = north (positive Y), increasing clockwise. */
  readonly heading: number;
  /** Scalar speed in units/second; always ≥ 0. Requirements: 1.2, 1.3 */
  readonly speed: number;
  /** Angular velocity in radians/second. Requirements: 1.4 */
  readonly angularVelocity: number;
  /**
   * Whether the car is currently on the road surface.
   * False triggers the 50 % handling and speed cap. Requirements: 1.5
   */
  readonly onTrack: boolean;
  /** Whether the car is currently in mid-air after a jump ramp. Requirements: 1.7 */
  readonly airborne: boolean;
  /** Height above the road surface in track units. 0 when not airborne. Requirements: 1.7 */
  readonly airborneHeight: number;
  /** Vertical velocity in units/second (positive = rising). Requirements: 1.7 */
  readonly airborneVY: number;
}

// ---------------------------------------------------------------------------
// Player / AI inputs
// ---------------------------------------------------------------------------

/**
 * Control inputs for a single car in one simulation tick.
 * Requirements: 1.1
 */
export interface CarInputs {
  /** Normalised throttle input in [0, 1]. Requirements: 1.2 */
  readonly throttle: number;
  /** Normalised brake input in [0, 1]. Requirements: 1.3 */
  readonly brake: number;
  /** Normalised steering input in [-1, 1]; negative = left. Requirements: 1.4 */
  readonly steer: number;
  /** Whether the forward weapon fire button is held this tick. Requirements: 3.2 */
  readonly fireForward: boolean;
  /** Whether the rear weapon deploy button is held this tick. Requirements: 3.3 */
  readonly fireRear: boolean;
}

// ---------------------------------------------------------------------------
// World state
// ---------------------------------------------------------------------------

/**
 * The complete world physics state passed into `stepPhysics`.
 * Requirements: 1.1
 */
export interface WorldPhysicsState {
  /** All active cars in the simulation. Iteration order is by `ParticipantId`. */
  readonly cars: ReadonlyArray<CarPhysicsState>;
  /** Monotonically increasing tick counter; increments once per 1/60 s step. */
  readonly tick: number;
  /** The track currently being raced on. */
  readonly trackId: TrackId;
  /**
   * Participant IDs whose cars are currently in contact with a jump ramp.
   * Populated externally from track geometry queries. Requirements: 1.7
   */
  readonly rampContacts?: ReadonlyArray<ParticipantId>;
  /**
   * Participant IDs whose cars are currently inside the pit lane boundaries.
   * Populated externally from track geometry queries. Requirements: 9.3, 9.4
   */
  readonly pitLaneOccupants?: ReadonlyArray<ParticipantId>;
}

// ---------------------------------------------------------------------------
// Physics events (discriminated union)
// ---------------------------------------------------------------------------

/** Two cars collided. Requirements: 1.6, 1.8 */
export interface CollisionEvent {
  readonly type: 'collision';
  readonly participantId: ParticipantId;
  /** The other car involved in the collision. */
  readonly otherParticipantId: ParticipantId;
  /** Relative speed at impact in units/second. */
  readonly relativeSpeed: number;
  /** Impulse magnitude applied to this car in units/second. */
  readonly impulseMagnitude: number;
}

/** Car left a jump ramp and became airborne. Requirements: 1.7 */
export interface JumpLaunchEvent {
  readonly type: 'jump_launch';
  readonly participantId: ParticipantId;
  /** Vertical launch velocity in units/second at the moment of launch. */
  readonly launchVY: number;
}

/** Airborne car has returned to the road surface. Requirements: 1.7 */
export interface JumpLandEvent {
  readonly type: 'jump_land';
  readonly participantId: ParticipantId;
  /** Speed at moment of landing in units/second. */
  readonly landingSpeed: number;
}

/** Car has left the road surface (onTrack transition false). Requirements: 1.5 */
export interface OffTrackEvent {
  readonly type: 'off_track';
  readonly participantId: ParticipantId;
  /** World-space position where the car left the track. */
  readonly position: Vec2;
}

/** Car has returned to the road surface (onTrack transition true). Requirements: 1.5 */
export interface OnTrackEvent {
  readonly type: 'on_track';
  readonly participantId: ParticipantId;
  /** World-space position where the car re-joined the track. */
  readonly position: Vec2;
}

/**
 * Car has entered the pit lane. This is the restoration trigger: on receiving
 * this event the authority loop / weapon system restores the owning car's
 * `currentArmor` to `maxArmor` and reloads every equipped weapon to its
 * configured `ammoMax` (armor and ammo live in `CarRaceState`, not in the
 * physics state). `maxArmor` carries the configured maximum so the applier does
 * not need to re-derive it. The restoration must complete before the matching
 * {@link PitLaneExitEvent}. Requirements: 9.3, 9.4
 */
export interface PitLaneEnterEvent {
  readonly type: 'pit_lane_enter';
  readonly participantId: ParticipantId;
  /** The car's configured maximum armor — the value `currentArmor` is restored to. */
  readonly maxArmor: number;
}

/** Car has exited the pit lane after restoration. Requirements: 9.3, 9.4 */
export interface PitLaneExitEvent {
  readonly type: 'pit_lane_exit';
  readonly participantId: ParticipantId;
  /** Armor value after restoration (should equal maxArmor). */
  readonly restoredArmor: number;
}

/**
 * Discriminated union of all events emitted by the physics step.
 * Requirements: 1.1
 */
export type PhysicsEvent =
  | CollisionEvent
  | JumpLaunchEvent
  | JumpLandEvent
  | OffTrackEvent
  | OnTrackEvent
  | PitLaneEnterEvent
  | PitLaneExitEvent;

// ---------------------------------------------------------------------------
// Step result
// ---------------------------------------------------------------------------

/**
 * The output of a single `stepPhysics` call.
 * Requirements: 1.1
 */
export interface PhysicsStepResult {
  /** Updated car states after the tick. Ordering matches `WorldPhysicsState.cars`. */
  readonly cars: ReadonlyArray<CarPhysicsState>;
  /**
   * Events that occurred during this tick (collisions, jumps, track transitions, pit lane).
   * Multiple events for the same participant are allowed within a single tick.
   */
  readonly events: ReadonlyArray<PhysicsEvent>;
}
