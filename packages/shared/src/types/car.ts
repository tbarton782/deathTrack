/**
 * Car, chassis, component, loadout, and race-state types for the Deathtrack
 * Multiplayer Recreation.
 *
 * Requirements: 4.1–4.7
 */

import type { ChassisId, ComponentId, ComponentSlot, ParticipantId, SpriteSheetRef, WeaponId } from './primitives.js';
import type { CarPhysicsState } from './physics.js';

// ---------------------------------------------------------------------------
// Base and effective stats
// ---------------------------------------------------------------------------

/**
 * The four raw performance statistics defined per chassis.
 * All values are in the range 1–200 (armor) or 1–100 (others).
 * Requirements: 4.1, 4.3
 */
export interface CarBaseStats {
  /** Maximum speed in track-space units per second. Range: 1–100. */
  topSpeed: number;
  /** Rate of speed increase in units/s². Range: 1–100. */
  acceleration: number;
  /** Hit-point pool for the car's chassis. Range: 1–200. */
  armor: number;
  /** Turn-rate factor applied per physics tick. Range: 1–100. */
  handling: number;
}

/**
 * Fully resolved performance statistics after applying all equipped component
 * deltas to the chassis base stats. Used by the physics engine during a race.
 *
 * `mass` is a derived value (not stored in the loadout) used to compute
 * collision impulse magnitudes.
 *
 * Requirements: 4.3
 */
export interface EffectiveCarStats {
  /** Resolved top speed (units/s). */
  topSpeed: number;
  /** Resolved acceleration (units/s²). */
  acceleration: number;
  /** Resolved armor (HP). */
  armor: number;
  /** Resolved handling factor. */
  handling: number;
  /**
   * Derived mass used in collision impulse calculations.
   * Not directly configurable; computed from chassis and armor stat.
   */
  mass: number;
}

// ---------------------------------------------------------------------------
// Chassis definition
// ---------------------------------------------------------------------------

/**
 * Static definition for one of the three selectable car chassis.
 * Requirements: 4.1
 */
export interface ChassisDef {
  /** Unique chassis identifier. */
  id: ChassisId;
  /** Human-readable chassis name (e.g. "Hellcat"). */
  name: string;
  /** Factory base stats before any component upgrades are applied. */
  baseStats: CarBaseStats;
  /** Reference to the sprite sheet asset used to render this chassis. */
  spriteSheet: SpriteSheetRef;
}

// ---------------------------------------------------------------------------
// Component definition
// ---------------------------------------------------------------------------

/**
 * A purchasable upgrade component that modifies one or more base stats.
 * Requirements: 4.2, 4.3
 */
export interface ComponentDef {
  /** Unique component identifier (e.g. "turbo_engine_mk2"). */
  id: ComponentId;
  /** The slot this component occupies on the loadout. */
  slot: ComponentSlot;
  /** Human-readable component name shown in the shop. */
  name: string;
  /** Purchase price in whole currency units. */
  price: number;
  /**
   * Additive deltas applied on top of the chassis base stats.
   * Only the stats listed here are modified; others are unchanged.
   */
  statDeltas: Partial<CarBaseStats>;
}

// ---------------------------------------------------------------------------
// Loadout
// ---------------------------------------------------------------------------

/**
 * A player's current car configuration: chassis, equipped components, and
 * equipped weapons. Slots accept `null` when nothing is equipped.
 *
 * Requirements: 4.4, 4.6, 4.7
 */
export interface Loadout {
  /** The chosen chassis. */
  chassisId: ChassisId;
  /** One optional component per upgrade slot. */
  components: {
    engine: ComponentId | null;
    brakes: ComponentId | null;
    transmission: ComponentId | null;
    tires: ComponentId | null;
    airfoil: ComponentId | null;
    armor: ComponentId | null;
  };
  /** One optional weapon per weapon slot. */
  weapons: {
    forward: WeaponId | null;
    rear: WeaponId | null;
    side_spike: WeaponId | null;
    ram: WeaponId | null;
  };
}

/**
 * A validated, fully-computed loadout produced just before a race starts.
 * Once created, this object must not be mutated (Requirements: 4.5).
 *
 * Requirements: 4.5, 4.3
 */
export interface ResolvedLoadout extends Loadout {
  /** Effective stats after all component deltas are applied and clamped. */
  effectiveStats: EffectiveCarStats;
  /**
   * Starting ammo count for every equipped weapon.
   * Weapons not in the loadout are absent from the map.
   */
  initialAmmo: Map<WeaponId, number>;
}

// ---------------------------------------------------------------------------
// Runtime race state
// ---------------------------------------------------------------------------

/**
 * Mutable runtime state for a single car during a race.
 * Combines physics simulation data with race-specific bookkeeping.
 *
 * Requirements: 4.6, 4.7
 */
export interface CarRaceState {
  /** Slot index of the participant controlling this car. */
  participantId: ParticipantId;
  /** Low-level physics state (position, velocity, heading, etc.). */
  physics: CarPhysicsState;
  /** Current armor/HP remaining. Starts at `effectiveStats.armor`. */
  currentArmor: number;
  /** Live ammo counts keyed by weapon ID. */
  ammo: Map<WeaponId, number>;
  /** `true` once the car's armor reaches zero and an Elimination event fires. */
  eliminated: boolean;
  /** Current lap number (1-indexed). */
  lap: number;
  /** Current race placement (1 = leading). Updated each lap completion. */
  placement: number;
  /** Index into the track's waypoint graph used for lap and AI tracking. */
  waypointIndex: number;
}
