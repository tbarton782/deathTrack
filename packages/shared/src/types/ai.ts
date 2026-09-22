/**
 * AI driver types for the Deathtrack Multiplayer Recreation.
 *
 * Requirements: 6.1–6.6
 */

// ---------------------------------------------------------------------------
// Skill tier
// ---------------------------------------------------------------------------

/**
 * The three difficulty tiers for AI drivers.
 *
 * Firing probabilities per tier (Requirements: 6.2):
 * - `'novice'`   — 30% chance to fire when opponent is in range
 * - `'standard'` — 60% chance to fire when opponent is in range
 * - `'expert'`   — 90% chance to fire when opponent is in range
 */
export type SkillTier = 'novice' | 'standard' | 'expert';

// ---------------------------------------------------------------------------
// AI characters
// ---------------------------------------------------------------------------

/**
 * The nine AI driver characters from the original Deathtrack game.
 *
 * These are the **real** opponent roster, taken from the original game's own
 * per-character asset filenames (`SLY.TBL`/`.BMP`, `ANGEL.*`, `CRIMSON.*`,
 * `MANIAC.*`, `MENACE.*`, `MEGA.*`, `LURKER.*`, `MELISSA.*`, `WRECKER.*`) — the
 * nine competitor cars the player races against. (`CHAMP.BMP` is the champion
 * portrait, not one of the nine field opponents, so it is excluded.)
 *
 * Requirements: 11.6
 */
export type AICharacter =
  | 'sly'
  | 'angel'
  | 'crimson'
  | 'maniac'
  | 'menace'
  | 'mega'
  | 'lurker'
  | 'melissa'
  | 'wrecker';

// ---------------------------------------------------------------------------
// AI configuration
// ---------------------------------------------------------------------------

/**
 * Configuration record for an AI-controlled driver slot.
 * Requirements: 6.1–6.6
 */
export interface AIDriverConfig {
  /** The AI character identity (affects portrait and bio text). Requirements: 11.6 */
  character: AICharacter;
  /**
   * Skill tier governing firing probability and hazard-detection radius.
   * Requirements: 6.2, 6.4
   */
  skillTier: SkillTier;
  /**
   * Aggression level on a 1–5 scale.
   * Affects racing-line selection and rear-drop trigger distance.
   * Requirements: 6.1, 6.5
   */
  aggression: number;
}

// ---------------------------------------------------------------------------
// AI runtime state
// ---------------------------------------------------------------------------

/**
 * Mutable runtime state tracked for each AI driver during a race.
 * Requirements: 6.3
 */
export interface AIDriverState {
  /** Reference to the configuration for this AI slot. */
  config: AIDriverConfig;
  /** Index of the next waypoint the AI is navigating toward. */
  currentWaypointIndex: number;
  /**
   * Whether the AI is currently in evasive mode.
   * Entered when armor < 25% of max; exited when armor ≥ 40% or no threat within range.
   * Requirements: 6.3
   */
  evasive: boolean;
  /**
   * Per-lap throttle jitter multiplier sampled at lap start.
   * Range: ±2%–±10% of base throttle. Requirements: 6.6
   */
  lapThrottleJitter: number;
}
