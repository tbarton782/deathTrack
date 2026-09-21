/**
 * Property-based test for the weapon slot invariant — Property 7.
 *
 * **Property 7**: The weapon slot invariant is preserved under any equip
 * sequence. Concretely, for an arbitrary sequence of equip attempts drawn from
 * a weapon catalogue and applied left-to-right (threading each *successful*
 * loadout forward), the resulting loadout always satisfies:
 *
 *   - at most one weapon per weapon slot (each of `forward`, `rear`,
 *     `side_spike`, `ram` holds a single `WeaponId | null`); and
 *   - every equipped weapon occupies the slot its catalogue definition
 *     declares (`catalogue.get(weaponId).slot === occupiedSlot`).
 *
 * The {@link equip} operation is the only mutation exercised. It rejects
 * `slot_occupied`, `weapon_not_in_catalogue`, and `weapon_slot_mismatch`; on
 * rejection the loadout is carried forward unchanged, on success the new
 * loadout replaces it. The invariant must hold after *every* step regardless
 * of how the random sequence interleaves valid placements, slot mismatches,
 * unknown weapons, and re-equips into occupied slots.
 *
 * **Validates: Requirements 3.9, 4.4**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import { equip, emptyLoadout } from '../LoadoutService.js';
import type { Loadout } from '../../types/car.js';
import type { WeaponDef } from '../../types/weapons.js';
import type { ChassisId, WeaponId, WeaponSlot } from '../../types/primitives.js';

// ---------------------------------------------------------------------------
// Domain constants
// ---------------------------------------------------------------------------

/** The four weapon slots on a car's loadout (Req 3.9, 4.4). */
const WEAPON_SLOTS: readonly WeaponSlot[] = ['forward', 'rear', 'side_spike', 'ram'];

const CHASSIS_IDS: readonly ChassisId[] = ['hellcat', 'crusher', 'pitbull'];

/**
 * A catalogue with at least one weapon declared for every slot, plus a second
 * weapon sharing the `forward` slot so re-equips into an occupied slot are
 * exercised. Ids are deliberately real `WeaponId`s so the types line up.
 */
const CATALOGUE_WEAPONS: readonly WeaponDef[] = [
  mkWeapon('machine_gun', 'forward', 'forward'),
  mkWeapon('laser', 'forward', 'forward'),
  mkWeapon('mine', 'rear', 'rear_drop'),
  mkWeapon('wheel_spike', 'side_spike', 'spike'),
  mkWeapon('ram', 'ram', 'ram'),
];

const catalogue: ReadonlyMap<WeaponId, WeaponDef> = new Map(
  CATALOGUE_WEAPONS.map((w) => [w.id, w]),
);

/** All weapon ids present in the catalogue. */
const CATALOGUE_IDS: readonly WeaponId[] = CATALOGUE_WEAPONS.map((w) => w.id);

/**
 * An id that is intentionally absent from the catalogue, so the generator can
 * drive the `weapon_not_in_catalogue` rejection path too.
 */
const UNKNOWN_WEAPON_ID = 'terminator' as WeaponId;

function mkWeapon(
  id: WeaponId,
  slot: WeaponSlot,
  category: WeaponDef['category'],
): WeaponDef {
  return {
    id,
    name: id,
    category,
    damage: 10,
    beamDPS: null,
    projectileSpeed: null,
    ammoMax: 100,
    rangeUnits: null,
    price: 100,
    slot,
  };
}

// ---------------------------------------------------------------------------
// Invariant checker
// ---------------------------------------------------------------------------

/**
 * Assert the weapon slot invariant on a loadout: every occupied slot holds a
 * weapon whose declared slot matches the slot it occupies. The "at most one
 * weapon per slot" half is structurally guaranteed by the `Loadout.weapons`
 * shape (one `WeaponId | null` field per slot) — this check verifies the
 * declared-slot-matches half and that only known weapons ever land in a slot.
 */
function assertSlotInvariant(loadout: Loadout): void {
  for (const slot of WEAPON_SLOTS) {
    const weaponId = loadout.weapons[slot];
    if (weaponId === null) continue;
    const def = catalogue.get(weaponId);
    // A weapon that made it into a slot must be a known catalogue entry...
    expect(def).toBeDefined();
    // ...and its declared slot must equal the slot it occupies.
    expect(def!.slot).toBe(slot);
  }
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * A single equip attempt: a target slot paired with a weapon id. The weapon id
 * is drawn from the catalogue ids plus one unknown id, so the sequence covers
 * valid placements, slot mismatches (weapon whose declared slot != target),
 * occupied-slot re-equips, and unknown-weapon rejections.
 */
interface EquipAttempt {
  readonly slot: WeaponSlot;
  readonly weaponId: WeaponId;
}

const attemptArb: fc.Arbitrary<EquipAttempt> = fc.record({
  slot: fc.constantFrom(...WEAPON_SLOTS),
  weaponId: fc.constantFrom(...CATALOGUE_IDS, UNKNOWN_WEAPON_ID),
});

const chassisArb: fc.Arbitrary<ChassisId> = fc.constantFrom(...CHASSIS_IDS);

// ---------------------------------------------------------------------------
// Property 7: weapon slot invariant under arbitrary equip sequences
// ---------------------------------------------------------------------------

describe('Property 7 — weapon slot invariant under arbitrary equip sequences', () => {
  it('preserves at-most-one-per-slot and declared-slot-match after every equip', () => {
    // Validates: Requirements 3.9, 4.4
    fc.assert(
      fc.property(
        chassisArb,
        fc.array(attemptArb, { minLength: 0, maxLength: 100 }),
        (chassisId, attempts) => {
          let loadout = emptyLoadout(chassisId);

          // The empty loadout trivially satisfies the invariant.
          assertSlotInvariant(loadout);

          for (const attempt of attempts) {
            const before = loadout;
            const result = equip(loadout, attempt.slot, attempt.weaponId, catalogue);

            if (result.ok) {
              // A successful equip must have placed the requested weapon into
              // the requested slot, and that slot must have been empty first.
              expect(before.weapons[attempt.slot]).toBeNull();
              expect(result.value.weapons[attempt.slot]).toBe(attempt.weaponId);
              loadout = result.value;
            } else {
              // Rejections carry the loadout forward unchanged and must use one
              // of the three documented slot/catalogue error codes.
              expect([
                'slot_occupied',
                'weapon_not_in_catalogue',
                'weapon_slot_mismatch',
              ]).toContain(result.error);
              loadout = before;
            }

            // Core invariant: holds after every step in the sequence.
            assertSlotInvariant(loadout);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('never lets a weapon occupy a slot other than its declared slot, even across re-equips', () => {
    // Validates: Requirements 3.9, 4.4
    fc.assert(
      fc.property(
        chassisArb,
        fc.array(attemptArb, { minLength: 1, maxLength: 100 }),
        (chassisId, attempts) => {
          let loadout = emptyLoadout(chassisId);

          for (const attempt of attempts) {
            const result = equip(loadout, attempt.slot, attempt.weaponId, catalogue);
            if (result.ok) loadout = result.value;
          }

          // After the whole sequence, every occupied slot must hold a weapon
          // whose declared slot equals the occupied slot.
          for (const slot of WEAPON_SLOTS) {
            const weaponId = loadout.weapons[slot];
            if (weaponId === null) continue;
            const def = catalogue.get(weaponId);
            expect(def).toBeDefined();
            expect(def!.slot).toBe(slot);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
