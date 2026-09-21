/**
 * Property-based test for exact per-hit weapon damage — Property 5.
 *
 * **Property 5**: Weapon damage is exactly the configured value per hit. For
 * any weapon damage value and any target armor, a single projectile (or hazard)
 * contact reduces the target's `currentArmor` by exactly the weapon's configured
 * `damage` — that is, `remainingArmor === armorBefore - damage` — and the
 * emitted {@link HitEvent}'s `damageDealt` equals exactly `weaponDef.damage`.
 *
 * This drives {@link stepWeapons} with arbitrary integer damage and armor
 * values over both damage-dealing contact paths in the step:
 *   - a projectile already overlapping an opponent car (Pass 3, Req 3.4), and
 *   - a placed hazard already overlapping a car (Pass 4, Req 3.8),
 * asserting the exact-arithmetic invariant in every case. Integer generators
 * are used so the check can be an exact equality free of floating-point slop:
 * the requirement is about *exactness*, and the machine-gun/mine fixtures the
 * unit tests use are themselves whole-number damage weapons.
 *
 * **Validates: Requirements 3.4**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { stepWeapons } from '../WeaponSystem.js';
import type {
  WeaponConfig,
  WeaponSystemState,
  ActiveProjectile,
  PlacedHazard,
  HitEvent,
} from '../../types/weapons.js';
import type { CarRaceState } from '../../types/car.js';
import type { CarPhysicsState } from '../../types/physics.js';
import type { WeaponId } from '../../types/primitives.js';

const DT = 1 / 60;

// ---------------------------------------------------------------------------
// Fixtures (mirroring weapon-system.test.ts patterns)
// ---------------------------------------------------------------------------

function physics(id: number, x: number, y: number, heading = 0): CarPhysicsState {
  return {
    id,
    position: { x, y },
    velocity: { x: 0, y: 0 },
    heading,
    speed: 0,
    angularVelocity: 0,
    onTrack: true,
    airborne: false,
    airborneHeight: 0,
    airborneVY: 0,
  };
}

function car(
  id: number,
  x: number,
  y: number,
  armor: number,
  ammo: Map<WeaponId, number> = new Map(),
  heading = 0,
): CarRaceState {
  return {
    participantId: id,
    physics: physics(id, x, y, heading),
    currentArmor: armor,
    ammo,
    eliminated: false,
    lap: 1,
    placement: 1,
    waypointIndex: 0,
  };
}

/** A forward projectile weapon with the given whole-number damage. */
function projectileWeapon(damage: number): WeaponConfig {
  return {
    id: 'machine_gun',
    name: 'Machine Gun',
    category: 'forward',
    damage,
    beamDPS: null,
    projectileSpeed: 100,
    ammoMax: 200,
    rangeUnits: null,
    price: 100,
    slot: 'forward',
  };
}

/** A rear-drop hazard weapon with the given whole-number damage. */
function hazardWeapon(damage: number): WeaponConfig {
  return {
    id: 'mine',
    name: 'Mine',
    category: 'rear_drop',
    damage,
    beamDPS: null,
    projectileSpeed: null,
    ammoMax: 10,
    rangeUnits: null,
    price: 50,
    slot: 'rear',
  };
}

function configs(...defs: WeaponConfig[]): Map<WeaponId, WeaponConfig> {
  return new Map(defs.map((d) => [d.id, d]));
}

function emptyState(
  projectiles: ActiveProjectile[] = [],
  hazards: PlacedHazard[] = [],
): WeaponSystemState {
  return { projectiles, hazards, weaponStates: new Map() };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Whole-number weapon damage in the range a catalogue weapon can carry. The
 * requirement (Req 3.4) is that whatever the configured damage is, the armor
 * drops by exactly that amount.
 */
const damageArb = fc.integer({ min: 1, max: 999 });

/**
 * Whole-number starting armor. The full range — including armor smaller than
 * the incoming damage — is exercised so the invariant is checked even when the
 * hit drives armor to zero or below (the step deducts the exact amount before
 * any elimination pass runs, so the arithmetic must still hold).
 */
const armorArb = fc.integer({ min: 1, max: 5000 });

// ---------------------------------------------------------------------------
// Property 5: armor drops by exactly the configured damage per hit
// ---------------------------------------------------------------------------

describe('Property 5 — exact weapon damage per hit', () => {
  it('reduces target armor by exactly the projectile weapon damage on contact', () => {
    // Validates: Requirements 3.4
    fc.assert(
      fc.property(damageArb, armorArb, (damage, armorBefore) => {
        const weapon = projectileWeapon(damage);
        // Target sits at the origin; projectile is placed to overlap it after
        // integration (zero velocity keeps it on top of the target).
        const target = car(1, 0, 0, armorBefore);
        const proj: ActiveProjectile = {
          id: 1,
          ownerId: 0,
          weaponId: weapon.id,
          position: { x: 0, y: 0 },
          velocity: { x: 0, y: 0 },
          spawnTick: 0,
        };

        const out = stepWeapons(emptyState([proj]), [target], DT, {
          weaponConfigs: configs(weapon),
          tick: 1,
        });

        const hit = out.events.find((e) => e.type === 'hit') as HitEvent | undefined;
        expect(hit).toBeDefined();
        // The emitted HitEvent reports exactly the configured damage.
        expect(hit!.damageDealt).toBe(damage);
        // remainingArmor === armorBefore - damage, exactly.
        expect(hit!.remainingArmor).toBe(armorBefore - damage);
        // And the returned car state matches the event's remaining armor.
        expect(out.updatedCars[0]!.currentArmor).toBe(armorBefore - damage);
      }),
    );
  });

  it('reduces contacting car armor by exactly the hazard weapon damage on contact', () => {
    // Validates: Requirements 3.4 (shared exact-damage contract with Req 3.8)
    fc.assert(
      fc.property(damageArb, armorArb, (damage, armorBefore) => {
        const weapon = hazardWeapon(damage);
        // Victim overlaps the placed hazard exactly.
        const victim = car(2, 3, 3, armorBefore);
        const haz: PlacedHazard = {
          id: 1,
          ownerId: 0,
          weaponId: weapon.id,
          position: { x: 3, y: 3 },
          spawnTick: 0,
          triggered: false,
        };

        const out = stepWeapons(emptyState([], [haz]), [victim], DT, {
          weaponConfigs: configs(weapon),
          tick: 1,
        });

        const hit = out.events.find((e) => e.type === 'hit') as HitEvent | undefined;
        expect(hit).toBeDefined();
        expect(hit!.damageDealt).toBe(damage);
        expect(hit!.remainingArmor).toBe(armorBefore - damage);
        expect(out.updatedCars[0]!.currentArmor).toBe(armorBefore - damage);
      }),
    );
  });
});
