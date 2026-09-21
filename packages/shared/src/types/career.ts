/**
 * Career mode and high-score types for the Deathtrack Multiplayer Recreation.
 *
 * Requirements: 5.1–5.10, 12.1–12.6
 */

import type { ComponentId, WeaponId } from './primitives.js';
import type { Loadout } from './car.js';

// ---------------------------------------------------------------------------
// Career state
// ---------------------------------------------------------------------------

/**
 * All persisted state for a single career save slot.
 *
 * - `saveSlot`: which of the three save slots this career occupies (1–3).
 * - `playerName`: the player's chosen display name (1–20 characters).
 * - `money`: current balance in whole currency units; always ≥ 0.
 * - `ownedComponents`: IDs of all purchased component upgrades.
 * - `ownedWeapons`: IDs of all purchased weapons.
 * - `currentCircuitIndex`: zero-based index of the current track within the
 *   circuit (0–9). Advances after each race; wraps back to 0 when all 10
 *   tracks have been completed.
 * - `circuitNumber`: how many full circuits (sets of 10 tracks) have been
 *   completed; starts at 1 and increments each time `currentCircuitIndex`
 *   wraps.
 * - `currentLoadout`: the player's currently configured car loadout.
 * - `totalEarnings`: cumulative prize money earned across all races (used for
 *   high-score ranking).
 * - `eliminationCount`: total number of opponent eliminations across all races.
 *
 * Requirements: 5.1, 5.5, 12.1–12.4
 */
export interface CareerState {
  saveSlot: 1 | 2 | 3;
  playerName: string;
  money: number;
  ownedComponents: ComponentId[];
  ownedWeapons: WeaponId[];
  /** Zero-based index into the 10-track circuit; wraps to 0 after track 9. */
  currentCircuitIndex: number;
  /** Increments each time the full 10-track circuit is completed. Starts at 1. */
  circuitNumber: number;
  currentLoadout: Loadout;
  totalEarnings: number;
  eliminationCount: number;
}

// ---------------------------------------------------------------------------
// High-score table
// ---------------------------------------------------------------------------

/**
 * A single entry in the top-10 high-score table.
 *
 * - `rank`: 1-based position in the table (1 = highest earner).
 * - `playerName`: display name as entered at career completion (1–12 characters).
 * - `totalEarnings`: total prize money earned across the full career.
 *
 * Requirements: 5.9
 */
export interface HighScoreEntry {
  rank: number;
  /** 1–12 characters. */
  playerName: string;
  totalEarnings: number;
}

// ---------------------------------------------------------------------------
// Save file format
// ---------------------------------------------------------------------------

/**
 * On-disk binary representation of a career save slot.
 *
 * The codec writes fields in declaration order:
 * 1. `magic`   — 4-byte constant `0x44545241` ("DTRA") used for format detection.
 * 2. `version` — uint32 codec schema version; currently 1.
 * 3. `slot`    — uint8 save slot index (1–3).
 * 4. `career`  — encoded `CareerState`.
 * 5. `crc32`   — uint32 CRC-32 computed over all preceding bytes; verified on
 *                load before deserialisation.
 *
 * On write the file is first written to a `.tmp` path and then atomically
 * renamed, preventing partial-write corruption.
 *
 * Requirements: 12.4, 5.5
 */
export interface SaveFile {
  /** Four-byte file magic: 0x44545241 ("DTRA"). */
  magic: 0x44545241;
  /** Codec schema version — currently 1. Increment on any breaking field change. */
  version: number;
  slot: 1 | 2 | 3;
  career: CareerState;
  /** CRC-32 computed over all bytes preceding this field. */
  crc32: number;
}

// ---------------------------------------------------------------------------
// Save slot info (used by SaveManager.listSlots)
// ---------------------------------------------------------------------------

/**
 * Summary information for a save slot as returned by `SaveManager.listSlots`.
 *
 * When `exists` is `false`, `playerName` and `totalEarnings` will be empty
 * string and 0 respectively, indicating an unused slot.
 *
 * Requirements: 12.3, 12.5
 */
export interface SlotInfo {
  slot: 1 | 2 | 3;
  playerName: string;
  totalEarnings: number;
  /** `true` if a valid save file exists for this slot; `false` if the slot is empty. */
  exists: boolean;
}
