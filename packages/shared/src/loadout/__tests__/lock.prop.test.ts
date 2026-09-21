/**
 * Property-based test for loadout immutability during a race — Property 9.
 *
 * **Property 9: A loadout is immutable once confirmed for a race.**
 *
 * For any arbitrary confirmed loadout, {@link confirmLoadout} must return a
 * deeply-frozen {@link ResolvedLoadout}: the resolved object itself and its
 * nested `components`, `weapons`, and `effectiveStats` structures are all
 * frozen. Once confirmed, no further reconfiguration is permitted — any attempt
 * to mutate a frozen structure throws in strict mode and, regardless, leaves
 * the stored values unchanged. In parallel, {@link rejectEquipDuringRace}
 * always rejects (`true`) while a race is active and always permits (`false`)
 * while it is not — the gate that prevents mid-race equip changes.
 *
 * These two guarantees together enforce the "locked for the duration of the
 * race" rule: the resolved data cannot be edited in place, and the equip
 * entry-points refuse to run while racing.
 *
 * **Validates: Requirements 4.5**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  confirmLoadout,
  rejectEquipDuringRace,
} from '../LoadoutService.js';
import type {
  ChassisDef,
  ComponentDef,
  Loadout,
} from '../../types/car.js';
import type { WeaponDef } from '../../types/weapons.js';
import type {
  ChassisId,
  ComponentId,
  ComponentSlot,
  WeaponId,
  WeaponSlot,
} from '../../types/primitives.js';

// ---------------------------------------------------------------------------
// Domain constants (mirroring the type definitions)
// ---------------------------------------------------------------------------

const CHASSIS_IDS: readonly ChassisId[] = ['hellcat', 'crusher', 'pitbull'];

const COMPONENT_SLOTS: readonly ComponentSlot[] = [
  'engine',
  'brakes',
  'transmission',
  'tires',
  'airfoil',
  'armor',
];

/** Maps each weapon slot to the weapon ids that legally occupy it. */
const WEAPONS_BY_SLOT: Readonly<Record<WeaponSlot, readonly WeaponId[]>> = {
  forward: ['machine_gun', 'laser', 'beam_cannon', 'missile', 'terminator'],
  rear: ['mine', 'caltrop'],
  side_spike: ['wheel_spike'],
  ram: ['ram'],
};

const WEAPON_SLOTS = Object.keys(WEAPONS_BY_SLOT) as readonly WeaponSlot[];

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** A component definition whose id is unique and whose slot is well-formed. */
function componentDefArb(): fc.Arbitrary<ComponentDef> {
  return fc.record({
    id: fc.string({ minLength: 1, maxLength: 8 }).map((s) => `comp_${s}` as ComponentId),
    slot: fc.constantFrom(...COMPONENT_SLOTS),
    name: fc.string({ maxLength: 12 }),
    price: fc.nat({ max: 2000 }),
    statDeltas: fc.record(
      {
        topSpeed: fc.integer({ min: -50, max: 50 }),
        acceleration: fc.integer({ min: -50, max: 50 }),
        armor: fc.integer({ min: -100, max: 250 }),
        handling: fc.integer({ min: -50, max: 50 }),
      },
      { requiredKeys: [] },
    ),
  });
}

function weaponDefArb(slot: WeaponSlot, id: WeaponId): fc.Arbitrary<WeaponDef> {
  return fc.record({
    id: fc.constant(id),
    name: fc.string({ maxLength: 12 }),
    category: fc.constantFrom('forward', 'rear_drop', 'ram', 'spike'),
    damage: fc.nat({ max: 100 }),
    beamDPS: fc.option(fc.nat({ max: 100 }), { nil: null }),
    projectileSpeed: fc.option(fc.nat({ max: 800 }), { nil: null }),
    ammoMax: fc.integer({ min: 1, max: 999 }),
    rangeUnits: fc.option(fc.nat({ max: 1000 }), { nil: null }),
    price: fc.nat({ max: 2000 }),
    slot: fc.constant(slot),
  });
}

const chassisArb: fc.Arbitrary<ChassisDef> = fc.record({
  id: fc.constantFrom(...CHASSIS_IDS),
  name: fc.string({ maxLength: 12 }),
  baseStats: fc.record({
    topSpeed: fc.integer({ min: 1, max: 100 }),
    acceleration: fc.integer({ min: 1, max: 100 }),
    armor: fc.integer({ min: 1, max: 200 }),
    handling: fc.integer({ min: 1, max: 100 }),
  }),
  spriteSheet: fc.record({ path: fc.constant('assets/car.bin') }),
});

interface Scenario {
  loadout: Loadout;
  chassis: ChassisDef;
  components: ReadonlyMap<ComponentId, ComponentDef>;
  weaponCatalogue: ReadonlyMap<WeaponId, WeaponDef>;
}

/**
 * Build a self-consistent confirmation scenario: a chassis, a component
 * catalogue, a weapon catalogue, and a loadout that references only ids present
 * in those catalogues in slots that match each definition.
 */
const scenarioArb: fc.Arbitrary<Scenario> = fc
  .record({
    chassis: chassisArb,
    componentDefs: fc.uniqueArray(componentDefArb(), {
      minLength: 0,
      maxLength: 6,
      selector: (c) => c.id,
    }),
    // Independently decide, per component slot, whether to equip a matching component.
    equipComponentFlags: fc.array(fc.boolean(), { minLength: 6, maxLength: 6 }),
    // Per weapon slot: optionally pick one of that slot's legal weapon ids.
    weaponPicks: fc.record({
      forward: fc.option(fc.constantFrom(...WEAPONS_BY_SLOT.forward), { nil: null }),
      rear: fc.option(fc.constantFrom(...WEAPONS_BY_SLOT.rear), { nil: null }),
      side_spike: fc.option(fc.constantFrom(...WEAPONS_BY_SLOT.side_spike), { nil: null }),
      ram: fc.option(fc.constantFrom(...WEAPONS_BY_SLOT.ram), { nil: null }),
    }),
    weaponDefsSeed: fc.constant(null),
  })
  .chain((raw) => {
    // Weapon catalogue: for each picked weapon id, generate a matching def.
    const pickedWeapons: Array<{ slot: WeaponSlot; id: WeaponId }> = [];
    for (const slot of WEAPON_SLOTS) {
      const id = raw.weaponPicks[slot];
      if (id !== null) pickedWeapons.push({ slot, id });
    }
    const weaponDefArbs = pickedWeapons.map(({ slot, id }) => weaponDefArb(slot, id));

    return fc.tuple(...weaponDefArbs).map((weaponDefs) => {
      const componentCatalogue = new Map<ComponentId, ComponentDef>();
      for (const def of raw.componentDefs) componentCatalogue.set(def.id, def);

      const weaponCatalogue = new Map<WeaponId, WeaponDef>();
      for (const def of weaponDefs) weaponCatalogue.set(def.id, def);

      // Build component slots: for each slot, pick the first catalogued component
      // whose declared slot matches, when the flag for that slot is set.
      const componentSlots: Loadout['components'] = {
        engine: null,
        brakes: null,
        transmission: null,
        tires: null,
        airfoil: null,
        armor: null,
      };
      COMPONENT_SLOTS.forEach((slot, i) => {
        if (!raw.equipComponentFlags[i]) return;
        const match = raw.componentDefs.find((c) => c.slot === slot);
        if (match) componentSlots[slot] = match.id;
      });

      const weaponSlots: Loadout['weapons'] = {
        forward: raw.weaponPicks.forward,
        rear: raw.weaponPicks.rear,
        side_spike: raw.weaponPicks.side_spike,
        ram: raw.weaponPicks.ram,
      };

      const loadout: Loadout = {
        chassisId: raw.chassis.id,
        components: componentSlots,
        weapons: weaponSlots,
      };

      return {
        loadout,
        chassis: raw.chassis,
        components: componentCatalogue,
        weaponCatalogue,
      };
    });
  });

// ---------------------------------------------------------------------------
// Property 9 — immutability of a confirmed loadout
// ---------------------------------------------------------------------------

describe('Property 9: loadout immutability once confirmed for a race (Req 4.5)', () => {
  it('deep-freezes the resolved loadout and its nested structures for arbitrary inputs', () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const resolved = confirmLoadout(
          s.loadout,
          s.chassis,
          s.components,
          s.weaponCatalogue,
        );

        // The resolved object and every nested config structure is frozen.
        expect(Object.isFrozen(resolved)).toBe(true);
        expect(Object.isFrozen(resolved.components)).toBe(true);
        expect(Object.isFrozen(resolved.weapons)).toBe(true);
        expect(Object.isFrozen(resolved.effectiveStats)).toBe(true);
      }),
    );
  });

  it('rejects every mutation attempt in strict mode and leaves values unchanged', () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        'use strict';
        const resolved = confirmLoadout(
          s.loadout,
          s.chassis,
          s.components,
          s.weaponCatalogue,
        );

        // Snapshot the observable values before any mutation attempt.
        const beforeChassis = resolved.chassisId;
        const beforeForward = resolved.weapons.forward;
        const beforeEngine = resolved.components.engine;
        const beforeTopSpeed = resolved.effectiveStats.topSpeed;

        // Every write against a frozen structure throws in strict mode.
        expect(() => {
          (resolved as { chassisId: ChassisId }).chassisId = 'crusher';
        }).toThrow();
        expect(() => {
          (resolved.weapons as { forward: WeaponId | null }).forward = 'ram';
        }).toThrow();
        expect(() => {
          (resolved.components as { engine: ComponentId | null }).engine = 'x';
        }).toThrow();
        expect(() => {
          (resolved.effectiveStats as { topSpeed: number }).topSpeed = -999;
        }).toThrow();

        // And the values are genuinely unchanged.
        expect(resolved.chassisId).toBe(beforeChassis);
        expect(resolved.weapons.forward).toBe(beforeForward);
        expect(resolved.components.engine).toBe(beforeEngine);
        expect(resolved.effectiveStats.topSpeed).toBe(beforeTopSpeed);
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9 — the race lock rejects equip attempts while racing
// ---------------------------------------------------------------------------

describe('Property 9: race lock gates equip attempts (Req 4.5)', () => {
  it('rejects equip attempts iff a race is active', () => {
    fc.assert(
      fc.property(fc.boolean(), (isRaceActive) => {
        // The gate mirrors the race flag exactly: reject while racing, permit otherwise.
        expect(rejectEquipDuringRace(isRaceActive)).toBe(isRaceActive);
      }),
    );
  });

  it('always rejects while a race is active and always permits while it is not', () => {
    expect(rejectEquipDuringRace(true)).toBe(true);
    expect(rejectEquipDuringRace(false)).toBe(false);
  });
});
