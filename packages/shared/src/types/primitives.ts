/**
 * Primitive types and ID alias types for the Deathtrack Multiplayer Recreation.
 *
 * Requirements: 1.1, 3.1, 4.1
 */

// ---------------------------------------------------------------------------
// Geometric primitives
// ---------------------------------------------------------------------------

/** A 2D vector in track-space units. */
export interface Vec2 {
  x: number;
  y: number;
}

// ---------------------------------------------------------------------------
// Participant and session identifiers
// ---------------------------------------------------------------------------

/**
 * A numeric participant slot index in the range 0–7 (up to 8 participants per session).
 * Requirements: 7.1
 */
export type ParticipantId = number;

/**
 * A UUID v4 string identifying a multiplayer session.
 * Requirements: 7.1
 */
export type SessionId = string;

// ---------------------------------------------------------------------------
// Vehicle / chassis identifiers
// ---------------------------------------------------------------------------

/**
 * The three selectable car chassis, each with distinct base stats.
 * Requirements: 4.1
 */
export type ChassisId = 'hellcat' | 'crusher' | 'pitbull';

// ---------------------------------------------------------------------------
// Track identifiers
// ---------------------------------------------------------------------------

/**
 * All ten city tracks from the original Deathtrack game.
 * Requirements: 9.1
 */
export type TrackId =
  | 'bay_area'
  | 'boston'
  | 'chicago'
  | 'houston'
  | 'los_angeles'
  | 'manhattan'
  | 'orlando'
  | 'phoenix'
  | 'seattle'
  | 'st_louis';

// ---------------------------------------------------------------------------
// Weapon identifiers and slots
// ---------------------------------------------------------------------------

/**
 * All weapon types supported by the Weapon System.
 * Requirements: 3.1
 */
export type WeaponId =
  | 'machine_gun'
  | 'laser'
  | 'beam_cannon'
  | 'missile'
  | 'terminator'
  | 'mine'
  | 'caltrop'
  | 'wheel_spike'
  | 'ram';

/**
 * The four weapon slots on a car's loadout.
 * Requirements: 3.9, 4.4
 */
export type WeaponSlot = 'forward' | 'rear' | 'side_spike' | 'ram';

// ---------------------------------------------------------------------------
// Component identifiers and slots
// ---------------------------------------------------------------------------

/**
 * Opaque string identifier for a car component (engine, brakes, etc.).
 * Requirements: 4.2
 */
export type ComponentId = string;

/**
 * The six upgradeable component slots on a car's loadout.
 * Requirements: 4.2
 */
export type ComponentSlot =
  | 'engine'
  | 'brakes'
  | 'transmission'
  | 'tires'
  | 'airfoil'
  | 'armor';

// ---------------------------------------------------------------------------
// Projectile and hazard identifiers
// ---------------------------------------------------------------------------

/**
 * Unique identifier for an active projectile in flight.
 * Requirements: 3.2
 */
export type ProjectileId = number;

/**
 * Unique identifier for a placed hazard (mine, caltrop, wheel spike) on the track.
 * Requirements: 3.3
 */
export type HazardId = number;

// ---------------------------------------------------------------------------
// Audio identifiers
// ---------------------------------------------------------------------------

/**
 * Opaque string identifier for a sound effect asset.
 * Requirements: 10.2
 */
export type SFXId = string;

/**
 * The game screen context used to select the appropriate music track.
 * Requirements: 10.1
 */
export type MusicContext = 'main_menu' | 'race' | 'shop' | 'results';

// ---------------------------------------------------------------------------
// Asset references
// ---------------------------------------------------------------------------

/**
 * A reference to a sprite sheet asset loaded by the Asset Loader.
 * Contains the asset path and an optional atlas key for multi-sheet bundles.
 * Requirements: 2.6
 */
export interface SpriteSheetRef {
  /** Path to the pre-converted sprite sheet binary bundle under `assets/`. */
  path: string;
  /** Optional key used to select a sub-sheet within a packed atlas. */
  atlasKey?: string;
}
