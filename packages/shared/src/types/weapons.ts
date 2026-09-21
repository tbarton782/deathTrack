/**
 * Weapon system types for the Deathtrack Multiplayer Recreation.
 *
 * Requirements: 3.1–3.10
 */

import type {
  HazardId,
  ParticipantId,
  ProjectileId,
  WeaponId,
  WeaponSlot,
  Vec2,
} from './primitives.js';

// ---------------------------------------------------------------------------
// Weapon category and definition
// ---------------------------------------------------------------------------

/**
 * The four weapon categories supported by the Weapon System.
 * - `forward`: projectile weapons fired from the car's front (machine gun, laser, beam cannon, missile, terminator)
 * - `rear_drop`: hazards dropped behind the car (mines, caltrops, wheel spikes)
 * - `ram`: contact/collision weapons (ram)
 * - `spike`: side-mounted contact weapons (wheel spikes)
 *
 * Requirements: 3.1
 */
export type WeaponCategory = 'forward' | 'rear_drop' | 'ram' | 'spike';

/**
 * Static definition of a weapon as read from the weapon catalogue / TBL file.
 * All values are immutable once loaded; they describe the weapon's capabilities
 * rather than any per-instance mutable state.
 *
 * Requirements: 3.1, 3.4, 3.6, 3.7
 */
export interface WeaponDef {
  /** Unique weapon identifier. */
  id: WeaponId;
  /** Human-readable name shown in the shop and HUD. */
  name: string;
  /** Determines spawn behaviour and slot eligibility. */
  category: WeaponCategory;
  /**
   * Armor reduction per hit for projectile/hazard weapons.
   * For beam/laser weapons this value is ignored; use `beamDPS` instead.
   * Requirements: 3.4
   */
  damage: number;
  /**
   * Continuous damage rate in hit-points per second for beam/laser weapons.
   * `null` for non-beam weapons.
   * Requirements: 3.6
   */
  beamDPS: number | null;
  /**
   * Speed of the projectile in track-space units per second.
   * `null` for rear-drop hazards and contact weapons.
   * Requirements: 3.2
   */
  projectileSpeed: number | null;
  /**
   * Maximum number of rounds/charges/uses carried per weapon slot.
   * Whole number in [1, 999].
   * Requirements: 3.7
   */
  ammoMax: number;
  /**
   * Maximum effective range in track-space units.
   * `null` for weapons with unlimited range (beam cannon) or contact-only weapons.
   */
  rangeUnits: number | null;
  /** Purchase price in whole career currency units. */
  price: number;
  /**
   * The weapon slot this weapon occupies in a car's loadout.
   * Requirements: 3.9, 4.4
   */
  slot: WeaponSlot;
}

/**
 * Runtime weapon configuration passed into the Weapon System during a race.
 * Identical shape to `WeaponDef`; aliased here so call-sites can use a more
 * semantically meaningful name when working with per-simulation config rather
 * than catalogue definitions.
 *
 * Requirements: 3.1
 */
export type WeaponConfig = WeaponDef;

// ---------------------------------------------------------------------------
// In-flight projectiles and placed hazards
// ---------------------------------------------------------------------------

/**
 * An active projectile currently in flight on the track.
 *
 * Requirements: 3.2, 3.10
 */
export interface ActiveProjectile {
  /** Unique identifier for this projectile instance. */
  id: ProjectileId;
  /** The participant whose car fired this projectile. */
  ownerId: ParticipantId;
  /** The weapon that produced this projectile. */
  weaponId: WeaponId;
  /** Current position in track-space. */
  position: Vec2;
  /** Current velocity vector in track-space units per second. */
  velocity: Vec2;
  /** Server simulation tick on which this projectile was spawned. */
  spawnTick: number;
}

/**
 * A hazard object (mine, caltrop, wheel spike) currently placed on the track.
 *
 * Requirements: 3.3, 3.8
 */
export interface PlacedHazard {
  /** Unique identifier for this hazard instance. */
  id: HazardId;
  /** The participant whose car dropped this hazard. */
  ownerId: ParticipantId;
  /** The weapon that produced this hazard. */
  weaponId: WeaponId;
  /** Position on the track surface where the hazard was placed. */
  position: Vec2;
  /** Server simulation tick on which this hazard was placed. */
  spawnTick: number;
  /**
   * `true` once the hazard has been contacted by a car; the hazard is removed
   * from the world during the same tick this becomes `true`.
   * Requirements: 3.8
   */
  triggered: boolean;
}

// ---------------------------------------------------------------------------
// Per-car weapon runtime state
// ---------------------------------------------------------------------------

/**
 * Tracks mutable weapon state for a single car during a race.
 *
 * Requirements: 3.7, 3.9
 */
export interface CarWeaponState {
  /** Participant whose car this state belongs to. */
  participantId: ParticipantId;
  /**
   * Current ammo count for each equipped weapon, keyed by `WeaponId`.
   * A missing key means the weapon is not equipped.
   * Values are whole numbers in [0, weaponDef.ammoMax].
   * Requirements: 3.7
   */
  ammo: Map<WeaponId, number>;
  /**
   * `true` while a beam/laser weapon is actively firing.
   * Requirements: 3.6
   */
  beamActive: boolean;
  /** ID of the beam weapon currently active, if any. */
  activeBeamWeaponId: WeaponId | null;
}

// ---------------------------------------------------------------------------
// Weapon system aggregate state
// ---------------------------------------------------------------------------

/**
 * The complete mutable state of the Weapon System for a single simulation step.
 *
 * Requirements: 3.1–3.9
 */
export interface WeaponSystemState {
  /** All projectiles currently in flight. */
  projectiles: ActiveProjectile[];
  /** All hazards currently placed on the track. */
  hazards: PlacedHazard[];
  /**
   * Per-car weapon state, keyed by `ParticipantId`.
   * Contains one entry per active participant (human or AI).
   */
  weaponStates: Map<ParticipantId, CarWeaponState>;
}

// ---------------------------------------------------------------------------
// Weapon events emitted during a step
// ---------------------------------------------------------------------------

/** A projectile was successfully spawned at a car's front position. Requirements: 3.2 */
export interface ProjectileFiredEvent {
  type: 'projectile_fired';
  ownerId: ParticipantId;
  projectile: ActiveProjectile;
}

/** A rear-drop hazard was placed at a car's rear position. Requirements: 3.3 */
export interface HazardPlacedEvent {
  type: 'hazard_placed';
  ownerId: ParticipantId;
  hazard: PlacedHazard;
}

/** A projectile or hazard contacted a target car and dealt damage. Requirements: 3.4 */
export interface HitEvent {
  type: 'hit';
  /** Participant who owns the weapon that caused the hit. */
  attackerId: ParticipantId;
  /** Participant whose car was hit. */
  targetId: ParticipantId;
  weaponId: WeaponId;
  /** Exact armor reduction applied (equals weaponDef.damage for instant-hit weapons). */
  damageDealt: number;
  /** Remaining armor on the target car after this hit. */
  remainingArmor: number;
}

/**
 * A car's armor reached zero; the car is eliminated this tick.
 * Requirements: 3.5
 */
export interface EliminationEvent {
  type: 'elimination';
  /** Participant whose car was destroyed. */
  eliminatedId: ParticipantId;
  /** Participant who delivered the killing blow, if identifiable. */
  killedById: ParticipantId | null;
}

/**
 * A beam/laser weapon applied a discrete tick of continuous damage.
 * Requirements: 3.6
 */
export interface BeamDamageEvent {
  type: 'beam_damage';
  attackerId: ParticipantId;
  targetId: ParticipantId;
  weaponId: WeaponId;
  /** HP deducted this tick (beamDPS × dt). */
  damageDealt: number;
  remainingArmor: number;
}

/**
 * Discriminated union of all events the Weapon System can emit in a single step.
 *
 * Requirements: 3.2–3.6
 */
export type WeaponEvent =
  | ProjectileFiredEvent
  | HazardPlacedEvent
  | HitEvent
  | EliminationEvent
  | BeamDamageEvent;

// ---------------------------------------------------------------------------
// Step result
// ---------------------------------------------------------------------------

/**
 * The output of a single `stepWeapons` invocation.
 *
 * Requirements: 3.1–3.9
 */
export interface WeaponStepResult {
  /**
   * Events emitted during this step, in the order they occurred.
   * Consumers (Network Manager, Audio System, Renderer) should process these
   * in order to maintain consistency.
   */
  events: WeaponEvent[];
  /**
   * The updated weapon system state after all projectile movement, hazard
   * detection, damage application, and ammo deduction have been resolved.
   */
  updatedState: WeaponSystemState;
}
