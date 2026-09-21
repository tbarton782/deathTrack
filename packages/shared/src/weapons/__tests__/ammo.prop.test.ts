/**
 * Property-based test for weapon ammunition bounds — Property 6.
 *
 * **Property 6**: A weapon's ammunition count always stays within
 * `[0, ammoMax]` under any fire sequence and never goes negative. A successful
 * fire deducts exactly one round; firing at 0 ammo is blocked and produces no
 * projectile / hazard while leaving ammo at 0.
 *
 * This exercises {@link stepWeapons} across arbitrary sequences of forward/rear
 * fire inputs, threading `updatedCars` (and the advanced id counters) forward
 * from one tick to the next so ammo state accumulates exactly as it would in a
 * real lockstep run. Both a forward projectile weapon (ammo consumer) and a
 * rear-drop hazard weapon (ammo consumer) are driven, starting from arbitrary
 * initial ammo values in the requirement's `0..999` range.
 *
 * On every tick the invariants checked are:
 *   - each weapon's ammo stays within `[0, ammoMax]` (never negative);
 *   - a fire that spent a round decremented ammo by exactly one;
 *   - a fire attempted at 0 ammo spawned nothing and left ammo at 0.
 *
 * **Validates: Requirements 3.7**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { stepWeapons, type WeaponStepOutput } from '../WeaponSystem.js';
import type {
  WeaponConfig,
  WeaponSystemState,
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
  ammo: Map<WeaponId, number>,
): CarRaceState {
  return {
    participantId: id,
    physics: physics(id, x, y),
    currentArmor: armor,
    ammo,
    eliminated: false,
    lap: 1,
    placement: 1,
    waypointIndex: 0,
  };
}

// A forward projectile weapon and a rear-drop hazard weapon, both ammo
// consumers, with distinct ammoMax caps so the clamp bound is exercised.
const GUN: WeaponConfig = {
  id: 'machine_gun',
  name: 'Machine Gun',
  category: 'forward',
  damage: 10,
  beamDPS: null,
  projectileSpeed: 100,
  ammoMax: 999,
  rangeUnits: null,
  price: 100,
  slot: 'forward',
};

const MINE: WeaponConfig = {
  id: 'mine',
  name: 'Mine',
  category: 'rear_drop',
  damage: 25,
  beamDPS: null,
  projectileSpeed: null,
  ammoMax: 999,
  rangeUnits: null,
  price: 50,
  slot: 'rear',
};

const WEAPON_CONFIGS = new Map<WeaponId, WeaponConfig>([
  [GUN.id, GUN],
  [MINE.id, MINE],
]);

function emptyState(): WeaponSystemState {
  return { projectiles: [], hazards: [], weaponStates: new Map() };
}

// A single tick's fire intent. Placing the lone car far from the origin with no
// existing projectiles/hazards means Pass 1 (firing) is the only pass that can
// change ammo, so per-tick spawn counts map directly onto ammo spent.
interface FireTick {
  readonly fireForward: boolean;
  readonly fireRear: boolean;
}

const fireTickArb: fc.Arbitrary<FireTick> = fc.record({
  fireForward: fc.boolean(),
  fireRear: fc.boolean(),
});

// ---------------------------------------------------------------------------
// Property 6 — ammo bounds under any fire sequence (Req 3.7)
// ---------------------------------------------------------------------------

describe('Property 6: ammo count stays within bounds under any fire sequence (Req 3.7)', () => {
  it('never drives ammo out of [0, ammoMax] and only decrements on a successful fire', () => {
    fc.assert(
      fc.property(
        // Arbitrary starting ammo for each weapon within the required 0..999 range.
        fc.integer({ min: 0, max: 999 }),
        fc.integer({ min: 0, max: 999 }),
        // An arbitrary sequence of fire inputs to thread tick-by-tick.
        fc.array(fireTickArb, { minLength: 0, maxLength: 40 }),
        (startGunAmmo, startMineAmmo, sequence) => {
          let cars: readonly CarRaceState[] = [
            car(
              0,
              0,
              0,
              100,
              new Map<WeaponId, number>([
                [GUN.id, startGunAmmo],
                [MINE.id, startMineAmmo],
              ]),
            ),
          ];
          let state = emptyState();
          let nextProjectileId = 0;
          let nextHazardId = 0;

          sequence.forEach((tickInput, tick) => {
            const before = cars[0]!.ammo;
            const gunBefore = before.get(GUN.id) ?? 0;
            const mineBefore = before.get(MINE.id) ?? 0;

            const out: WeaponStepOutput = stepWeapons(state, cars, DT, {
              weaponConfigs: WEAPON_CONFIGS,
              tick,
              nextProjectileId,
              nextHazardId,
              fireInputs: [
                {
                  participantId: 0,
                  fireForward: tickInput.fireForward,
                  fireRear: tickInput.fireRear,
                  forwardWeaponId: GUN.id,
                  rearWeaponId: MINE.id,
                },
              ],
            });

            const gunAfter = out.updatedCars[0]!.ammo.get(GUN.id) ?? 0;
            const mineAfter = out.updatedCars[0]!.ammo.get(MINE.id) ?? 0;

            // --- Bounds: ammo always within [0, ammoMax], never negative. ---
            expect(gunAfter).toBeGreaterThanOrEqual(0);
            expect(gunAfter).toBeLessThanOrEqual(GUN.ammoMax);
            expect(mineAfter).toBeGreaterThanOrEqual(0);
            expect(mineAfter).toBeLessThanOrEqual(MINE.ammoMax);

            // --- Forward weapon: spend exactly one iff a shot was possible. ---
            const gunFired = tickInput.fireForward && gunBefore > 0;
            if (gunFired) {
              expect(gunAfter).toBe(gunBefore - 1);
              // A successful fire spawns exactly one projectile this tick.
              expect(out.nextProjectileId).toBe(nextProjectileId + 1);
            } else {
              // No shot possible: ammo unchanged, nothing spawned.
              expect(gunAfter).toBe(gunBefore);
              expect(out.nextProjectileId).toBe(nextProjectileId);
              if (tickInput.fireForward) {
                // Attempted at zero ammo: blocked, still zero.
                expect(gunBefore).toBe(0);
                expect(gunAfter).toBe(0);
              }
            }

            // --- Rear weapon: spend exactly one iff a drop was possible. ---
            const mineFired = tickInput.fireRear && mineBefore > 0;
            if (mineFired) {
              expect(mineAfter).toBe(mineBefore - 1);
              expect(out.nextHazardId).toBe(nextHazardId + 1);
            } else {
              expect(mineAfter).toBe(mineBefore);
              expect(out.nextHazardId).toBe(nextHazardId);
              if (tickInput.fireRear) {
                expect(mineBefore).toBe(0);
                expect(mineAfter).toBe(0);
              }
            }

            // Thread forward: reset spawned projectiles/hazards each tick so
            // Pass 1 remains the sole ammo-affecting pass, but carry ammo state
            // and the monotonic id counters as a real run would.
            cars = out.updatedCars;
            state = emptyState();
            nextProjectileId = out.nextProjectileId;
            nextHazardId = out.nextHazardId;
          });
        },
      ),
    );
  });

  it('firing continuously eventually bottoms out at exactly 0 and stays there', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 50 }), (startAmmo) => {
        let cars: readonly CarRaceState[] = [
          car(0, 0, 0, 100, new Map<WeaponId, number>([[GUN.id, startAmmo]])),
        ];
        let state = emptyState();
        let nextProjectileId = 0;

        // Fire more times than we have ammo; ammo must clamp at 0.
        for (let tick = 0; tick < startAmmo + 10; tick++) {
          const out = stepWeapons(state, cars, DT, {
            weaponConfigs: WEAPON_CONFIGS,
            tick,
            nextProjectileId,
            fireInputs: [
              {
                participantId: 0,
                fireForward: true,
                fireRear: false,
                forwardWeaponId: GUN.id,
                rearWeaponId: null,
              },
            ],
          });
          const ammo = out.updatedCars[0]!.ammo.get(GUN.id) ?? 0;
          expect(ammo).toBeGreaterThanOrEqual(0);
          cars = out.updatedCars;
          state = emptyState();
          nextProjectileId = out.nextProjectileId;
        }

        expect(cars[0]!.ammo.get(GUN.id)).toBe(0);
      }),
    );
  });
});
