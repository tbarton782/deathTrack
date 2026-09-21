/**
 * Property 13: Save file round-trip preserves all persisted career fields.
 *
 * *For any* valid `CareerState`, encoding it with `SaveFileCodec.encode` then
 * decoding the resulting bytes with `SaveFileCodec.decode` produces a
 * `CareerState` where all persisted fields — `money`, `ownedComponents`,
 * `ownedWeapons`, `currentCircuitIndex`, `circuitNumber`, and `playerName`
 * (plus `saveSlot`, `currentLoadout`, `totalEarnings`, and `eliminationCount`)
 * — are deeply equal to the originals.
 *
 * This is the dedicated property file for Property 13. It exercises the full
 * encode -> decode round-trip across ~1000 arbitrary valid careers.
 *
 * Validates: Requirements 5.5, 12.4
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  SaveFileCodec,
  SAVE_FILE_MAGIC,
  SAVE_FILE_VERSION,
} from '../SaveFileCodec.js';
import type { CareerState, SaveFile } from '../../types/career.js';
import type { Loadout } from '../../types/car.js';
import type { ComponentId, WeaponId } from '../../types/primitives.js';

// ---------------------------------------------------------------------------
// Generators
//
// These are constrained to the valid CareerState input space:
// - integer fields are bounded to the uint8/uint16/uint32 wire widths the
//   codec uses, so the round-trip is exercised only on representable values;
// - `playerName` is a non-empty string within the documented 1–20 char range;
// - loadout / owned-list ids are non-empty component/weapon identifiers, with
//   nullable loadout slots to cover the "nothing equipped" case.
// ---------------------------------------------------------------------------

/** Non-empty component identifier (opaque string, capped for practicality). */
const componentIdArb: fc.Arbitrary<ComponentId> = fc.string({ minLength: 1, maxLength: 24 });
const nullableComponentArb = fc.option(componentIdArb, { nil: null });

/** Weapon identifier drawn from the closed WeaponId union. */
const weaponIdArb = fc.constantFrom<WeaponId>(
  'machine_gun',
  'laser',
  'beam_cannon',
  'missile',
  'terminator',
  'mine',
  'caltrop',
  'wheel_spike',
  'ram',
);
const nullableWeaponArb = fc.option(weaponIdArb, { nil: null });

const loadoutArb: fc.Arbitrary<Loadout> = fc.record({
  chassisId: fc.constantFrom<Loadout['chassisId']>('hellcat', 'crusher', 'pitbull'),
  components: fc.record({
    engine: nullableComponentArb,
    brakes: nullableComponentArb,
    transmission: nullableComponentArb,
    tires: nullableComponentArb,
    airfoil: nullableComponentArb,
    armor: nullableComponentArb,
  }),
  weapons: fc.record({
    forward: nullableWeaponArb,
    rear: nullableWeaponArb,
    side_spike: nullableWeaponArb,
    ram: nullableWeaponArb,
  }),
});

const careerArb: fc.Arbitrary<CareerState> = fc.record({
  // saveSlot is a uint8 constrained to the three valid slots.
  saveSlot: fc.constantFrom<CareerState['saveSlot']>(1, 2, 3),
  // playerName: documented 1–20 characters (varString, unicode-safe).
  playerName: fc.string({ minLength: 1, maxLength: 20 }),
  // money: uint32 wire field.
  money: fc.integer({ min: 0, max: 0xffffffff }),
  ownedComponents: fc.array(componentIdArb, { maxLength: 20 }),
  ownedWeapons: fc.array(weaponIdArb, { maxLength: 20 }),
  // currentCircuitIndex: zero-based index into the 10-track circuit (0–9).
  currentCircuitIndex: fc.integer({ min: 0, max: 9 }),
  // circuitNumber: starts at 1; uint32 wire field.
  circuitNumber: fc.integer({ min: 1, max: 0xffffffff }),
  currentLoadout: loadoutArb,
  totalEarnings: fc.integer({ min: 0, max: 0xffffffff }),
  eliminationCount: fc.integer({ min: 0, max: 0xffffffff }),
});

/** Wrap an arbitrary career into the SaveFile envelope the codec consumes. */
const saveArb: fc.Arbitrary<SaveFile> = careerArb.map((career) => ({
  magic: SAVE_FILE_MAGIC as SaveFile['magic'],
  version: SAVE_FILE_VERSION,
  slot: career.saveSlot,
  career,
  crc32: 0, // ignored on encode; recomputed by the codec
}));

// ---------------------------------------------------------------------------
// Property 13
// ---------------------------------------------------------------------------

describe('Property 13: Save file round-trip preserves all persisted career fields', () => {
  it('encode -> decode reproduces every persisted CareerState field for any valid career', () => {
    fc.assert(
      fc.property(saveArb, (save) => {
        const decoded = SaveFileCodec.decode(SaveFileCodec.encode(save));

        // Whole-career deep equality is the strongest statement of the property:
        // every persisted field, including the nested loadout, is preserved.
        expect(decoded.career).toEqual(save.career);

        // Spell out the fields the property names explicitly, so a regression
        // pinpoints which field diverged rather than only reporting the object.
        expect(decoded.career.money).toBe(save.career.money);
        expect(decoded.career.ownedComponents).toEqual(save.career.ownedComponents);
        expect(decoded.career.ownedWeapons).toEqual(save.career.ownedWeapons);
        expect(decoded.career.currentCircuitIndex).toBe(save.career.currentCircuitIndex);
        expect(decoded.career.circuitNumber).toBe(save.career.circuitNumber);
        expect(decoded.career.playerName).toBe(save.career.playerName);

        // Remaining persisted fields round-trip too.
        expect(decoded.career.saveSlot).toBe(save.career.saveSlot);
        expect(decoded.career.currentLoadout).toEqual(save.career.currentLoadout);
        expect(decoded.career.totalEarnings).toBe(save.career.totalEarnings);
        expect(decoded.career.eliminationCount).toBe(save.career.eliminationCount);

        // The envelope slot mirrors the career slot on a well-formed save.
        expect(decoded.slot).toBe(save.slot);
      }),
      { numRuns: 1000 },
    );
  });
});
