/**
 * Round-trip codec and validation guard for {@link ActiveProjectile} packets.
 *
 * Requirement 3.10 mandates that, before a projectile packet is transmitted,
 * the Weapon System validates it by performing a round-trip encode–decode and
 * rejects transmission of any packet whose decoded state differs from its
 * pre-encoded state by any field value. This module supplies:
 *
 *   1. {@link ProjectileCodec} — a schema-driven codec that serialises the
 *      transmittable fields of an {@link ActiveProjectile} to a fixed-layout,
 *      little-endian byte buffer and parses them back.
 *   2. {@link validateProjectileRoundTrip} — a pure predicate that encodes then
 *      decodes a projectile and deep-compares every field, returning `true`
 *      only when the decoded projectile is field-for-field identical to the
 *      original. The Network Manager calls this as the transmit guard: a
 *      `false` result means the packet must NOT be transmitted.
 *
 * The `weaponId` field is a string union (`WeaponId`), which the byte-aligned
 * codec framework cannot serialise directly, so it is mapped to a stable
 * `uint8` index via {@link WEAPON_ID_ORDER}. That ordering is part of the wire
 * protocol and must not be reordered once published. `position` and `velocity`
 * are encoded losslessly as `float64` components so a well-formed projectile
 * always survives the round-trip; the guard therefore only rejects packets
 * whose fields are genuinely unrepresentable (e.g. an out-of-range `id` or an
 * unknown `weaponId`), matching Requirement 3.10's "reject on any difference"
 * intent.
 *
 * Like the rest of the weapon layer, everything here is pure: no ambient state,
 * no mutation of inputs, no `Math.random()` or `Date.now()`.
 *
 * Requirements: 3.10
 */

import {
  createCodec,
  uint8,
  uint32,
  float64,
  nested,
  type Codec,
  type SchemaDescriptor,
  type FieldType,
} from '../codec/schema.js';
import type { Vec2, WeaponId } from '../types/primitives.js';
import type { ActiveProjectile } from '../types/weapons.js';

// ---------------------------------------------------------------------------
// Weapon id <-> index mapping
// ---------------------------------------------------------------------------

/**
 * Fixed, ordered list of every {@link WeaponId}. The array index is the value
 * written on the wire for a projectile's `weaponId`, so this order is part of
 * the projectile packet protocol and must never be reordered or have entries
 * removed once published; appending new ids at the end is the only safe change.
 */
export const WEAPON_ID_ORDER: readonly WeaponId[] = [
  'machine_gun',
  'laser',
  'beam_cannon',
  'missile',
  'terminator',
  'mine',
  'caltrop',
  'wheel_spike',
  'ram',
];

/** Reverse lookup: `WeaponId` -> its wire index, built once from the order. */
const WEAPON_ID_INDEX: ReadonlyMap<WeaponId, number> = new Map(
  WEAPON_ID_ORDER.map((id, index) => [id, index]),
);

/**
 * A {@link FieldType} that encodes a {@link WeaponId} as a single `uint8` index
 * into {@link WEAPON_ID_ORDER}.
 *
 * An unknown weapon id (index `255`) or an out-of-range decoded byte round-trips
 * to a sentinel that the deep-compare in {@link validateProjectileRoundTrip}
 * will detect as a mismatch, so a malformed `weaponId` is rejected rather than
 * silently transmitted.
 */
const UNKNOWN_WEAPON_INDEX = 255;

const weaponIdField: FieldType<WeaponId> = {
  write: (w, v) => {
    const index = WEAPON_ID_INDEX.get(v);
    uint8.write(w, index ?? UNKNOWN_WEAPON_INDEX);
  },
  read: (r): WeaponId => {
    const index = uint8.read(r);
    // Out-of-range index decodes to a sentinel string that is not a valid
    // WeaponId, guaranteeing the round-trip deep-compare fails for it.
    return (WEAPON_ID_ORDER[index] ?? '__unknown__') as WeaponId;
  },
};

// ---------------------------------------------------------------------------
// Vec2 sub-schema
// ---------------------------------------------------------------------------

/**
 * Ordered schema for a {@link Vec2}: `x` then `y`, each a lossless `float64`.
 * Position and velocity components can be arbitrary track-space floats, so
 * full-width doubles preserve them exactly across the round-trip.
 */
const vec2Schema: SchemaDescriptor<Vec2> = [
  { key: 'x', type: float64 },
  { key: 'y', type: float64 },
];

// ---------------------------------------------------------------------------
// Projectile schema and codec
// ---------------------------------------------------------------------------

/**
 * Ordered schema descriptor for the transmittable fields of an
 * {@link ActiveProjectile}. The field order *is* the wire layout and must not
 * be reordered once published as part of the projectile packet protocol.
 *
 * - `id` / `ownerId` / `spawnTick` — `uint32` (non-negative integer counters).
 * - `weaponId` — `uint8` index via {@link weaponIdField}.
 * - `position` / `velocity` — nested {@link vec2Schema} (`float64` components).
 */
export const projectileSchema: SchemaDescriptor<ActiveProjectile> = [
  { key: 'id', type: uint32 },
  { key: 'ownerId', type: uint8 },
  { key: 'weaponId', type: weaponIdField },
  { key: 'position', type: nested(vec2Schema) },
  { key: 'velocity', type: nested(vec2Schema) },
  { key: 'spawnTick', type: uint32 },
];

/**
 * Codec that encodes/decodes a single {@link ActiveProjectile} to/from a
 * fixed-layout little-endian buffer using {@link projectileSchema}.
 *
 * Requirements: 3.10
 */
export const ProjectileCodec: Codec<ActiveProjectile> = createCodec(projectileSchema);

// ---------------------------------------------------------------------------
// Round-trip validation guard
// ---------------------------------------------------------------------------

/** Field-for-field equality for two {@link Vec2} values. */
function vec2Equal(a: Vec2, b: Vec2): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * Deep field-for-field equality between an original projectile and the
 * projectile recovered from an encode–decode round-trip. Returns `true` only
 * when every transmittable field is identical.
 */
function projectileEqual(a: ActiveProjectile, b: ActiveProjectile): boolean {
  return (
    a.id === b.id &&
    a.ownerId === b.ownerId &&
    a.weaponId === b.weaponId &&
    a.spawnTick === b.spawnTick &&
    vec2Equal(a.position, b.position) &&
    vec2Equal(a.velocity, b.velocity)
  );
}

/**
 * Transmit guard for Requirement 3.10.
 *
 * Encodes `projectile` with {@link ProjectileCodec}, decodes the resulting
 * bytes back into an {@link ActiveProjectile}, and deep-compares every field.
 * Returns `true` when the decoded projectile is identical to the original
 * (safe to transmit) and `false` when any field differs or encoding/decoding
 * throws (reject transmission).
 *
 * The function is pure and total: it never mutates its argument and never
 * throws — an internal codec failure is treated as a validation failure so the
 * caller can uniformly branch on the boolean.
 *
 * @param projectile The projectile packet about to be transmitted.
 * @returns `true` if the round-trip preserved every field; `false` to reject.
 */
export function validateProjectileRoundTrip(projectile: ActiveProjectile): boolean {
  try {
    const decoded = ProjectileCodec.decode(ProjectileCodec.encode(projectile));
    return projectileEqual(projectile, decoded);
  } catch {
    return false;
  }
}
