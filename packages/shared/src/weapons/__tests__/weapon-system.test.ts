/**
 * Unit tests for the deterministic weapon step (`stepWeapons`).
 *
 * Covers the behaviours required by task 7.1:
 *   - projectile spawn on forward fire / hazard drop on rear fire (Req 3.2, 3.3)
 *   - exact `weaponDef.damage` reduction on contact (Req 3.4)
 *   - elimination when armor reaches zero (Req 3.5)
 *   - beam/laser DPS applied in discrete ticks (Req 3.6)
 *   - ammo clamped to [0, ammoMax] and firing blocked at zero (Req 3.7)
 *   - hazard removed on contact by any car, including its owner (Req 3.8)
 *
 * Requirements: 3.1–3.9
 */

import { describe, it, expect } from 'vitest';
import { stepWeapons } from '../WeaponSystem.js';
import type {
  WeaponConfig,
  WeaponSystemState,
  ActiveProjectile,
  PlacedHazard,
  ProjectileFiredEvent,
  HazardPlacedEvent,
  HitEvent,
  EliminationEvent,
  BeamDamageEvent,
} from '../../types/weapons.js';
import type { CarRaceState } from '../../types/car.js';
import type { CarPhysicsState } from '../../types/physics.js';
import type { WeaponId } from '../../types/primitives.js';

const DT = 1 / 60;

// --- Fixtures --------------------------------------------------------------

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

const MACHINE_GUN: WeaponConfig = {
  id: 'machine_gun',
  name: 'Machine Gun',
  category: 'forward',
  damage: 10,
  beamDPS: null,
  projectileSpeed: 100,
  ammoMax: 200,
  rangeUnits: null,
  price: 100,
  slot: 'forward',
};

const BEAM: WeaponConfig = {
  id: 'beam_cannon',
  name: 'Beam Cannon',
  category: 'forward',
  damage: 0,
  beamDPS: 60,
  projectileSpeed: null,
  ammoMax: 999,
  rangeUnits: null,
  price: 500,
  slot: 'forward',
};

const MINE: WeaponConfig = {
  id: 'mine',
  name: 'Mine',
  category: 'rear_drop',
  damage: 25,
  beamDPS: null,
  projectileSpeed: null,
  ammoMax: 10,
  rangeUnits: null,
  price: 50,
  slot: 'rear',
};

function configs(...defs: WeaponConfig[]): Map<WeaponId, WeaponConfig> {
  return new Map(defs.map((d) => [d.id, d]));
}

function emptyState(
  projectiles: ActiveProjectile[] = [],
  hazards: PlacedHazard[] = [],
): WeaponSystemState {
  return { projectiles, hazards, weaponStates: new Map() };
}

// --- Fire → spawn (Req 3.2, 3.3) ------------------------------------------

describe('stepWeapons: firing', () => {
  it('spawns a projectile at the car front on forward fire (Req 3.2)', () => {
    const shooter = car(0, 5, 5, 100, new Map([['machine_gun', 50]]));
    const out = stepWeapons(emptyState(), [shooter], DT, {
      weaponConfigs: configs(MACHINE_GUN),
      tick: 0,
      fireInputs: [
        {
          participantId: 0,
          fireForward: true,
          fireRear: false,
          forwardWeaponId: 'machine_gun',
          rearWeaponId: null,
        },
      ],
    });

    expect(out.updatedState.projectiles).toHaveLength(1);
    const p = out.updatedState.projectiles[0]!;
    // Heading 0 = +Y (north): front is offset in +Y by the muzzle offset.
    expect(p.position.x).toBeCloseTo(5);
    expect(p.position.y).toBeCloseTo(6);
    expect(p.velocity.y).toBeCloseTo(100);
    expect(p.ownerId).toBe(0);

    const fired = out.events.find((e) => e.type === 'projectile_fired') as ProjectileFiredEvent;
    expect(fired).toBeDefined();
    expect(fired.ownerId).toBe(0);

    // Ammo decremented by exactly one.
    expect(out.updatedCars[0]!.ammo.get('machine_gun')).toBe(49);
  });

  it('places a hazard at the car rear on rear fire (Req 3.3)', () => {
    const dropper = car(0, 5, 5, 100, new Map([['mine', 3]]));
    const out = stepWeapons(emptyState(), [dropper], DT, {
      weaponConfigs: configs(MINE),
      tick: 7,
      fireInputs: [
        {
          participantId: 0,
          fireForward: false,
          fireRear: true,
          forwardWeaponId: null,
          rearWeaponId: 'mine',
        },
      ],
    });

    expect(out.updatedState.hazards).toHaveLength(1);
    const h = out.updatedState.hazards[0]!;
    // Rear is opposite the forward (+Y) direction: offset in -Y.
    expect(h.position.x).toBeCloseTo(5);
    expect(h.position.y).toBeCloseTo(4);
    expect(h.triggered).toBe(false);
    expect(h.spawnTick).toBe(7);

    const placed = out.events.find((e) => e.type === 'hazard_placed') as HazardPlacedEvent;
    expect(placed).toBeDefined();
    expect(out.updatedCars[0]!.ammo.get('mine')).toBe(2);
  });

  it('allocates sequential deterministic projectile ids', () => {
    const a = car(0, 0, 0, 100, new Map([['machine_gun', 5]]));
    const b = car(1, 10, 0, 100, new Map([['machine_gun', 5]]));
    const out = stepWeapons(emptyState(), [a, b], DT, {
      weaponConfigs: configs(MACHINE_GUN),
      tick: 0,
      nextProjectileId: 42,
      fireInputs: [
        { participantId: 0, fireForward: true, fireRear: false, forwardWeaponId: 'machine_gun', rearWeaponId: null },
        { participantId: 1, fireForward: true, fireRear: false, forwardWeaponId: 'machine_gun', rearWeaponId: null },
      ],
    });
    const ids = out.updatedState.projectiles.map((p) => p.id).sort((x, y) => x - y);
    expect(ids).toEqual([42, 43]);
    expect(out.nextProjectileId).toBe(44);
  });
});

// --- Ammo bounds (Req 3.7) -------------------------------------------------

describe('stepWeapons: ammo enforcement (Req 3.7)', () => {
  it('blocks firing at zero ammo and produces no projectile', () => {
    const shooter = car(0, 0, 0, 100, new Map([['machine_gun', 0]]));
    const out = stepWeapons(emptyState(), [shooter], DT, {
      weaponConfigs: configs(MACHINE_GUN),
      tick: 0,
      fireInputs: [
        { participantId: 0, fireForward: true, fireRear: false, forwardWeaponId: 'machine_gun', rearWeaponId: null },
      ],
    });
    expect(out.updatedState.projectiles).toHaveLength(0);
    expect(out.events.some((e) => e.type === 'projectile_fired')).toBe(false);
    expect(out.updatedCars[0]!.ammo.get('machine_gun')).toBe(0);
  });

  it('never drives ammo below zero across repeated fire', () => {
    let cars: CarRaceState[] = [car(0, 0, 0, 100, new Map([['machine_gun', 2]]))];
    let state = emptyState();
    let nextId = 0;
    for (let tick = 0; tick < 5; tick++) {
      const out = stepWeapons(state, cars, DT, {
        weaponConfigs: configs(MACHINE_GUN),
        tick,
        nextProjectileId: nextId,
        fireInputs: [
          { participantId: 0, fireForward: true, fireRear: false, forwardWeaponId: 'machine_gun', rearWeaponId: null },
        ],
      });
      cars = out.updatedCars as CarRaceState[];
      state = emptyState(); // isolate spawn counting per tick
      nextId = out.nextProjectileId;
    }
    // Started with 2, fired 5 times: ammo bottoms out at 0, never negative.
    expect(cars[0]!.ammo.get('machine_gun')).toBe(0);
  });
});

// --- Projectile contact damage (Req 3.4) -----------------------------------

describe('stepWeapons: projectile contact (Req 3.4)', () => {
  it('reduces target armor by exactly weaponDef.damage on contact', () => {
    const target = car(1, 0, 1, 100);
    // Projectile already positioned to overlap target after integration.
    const proj: ActiveProjectile = {
      id: 1,
      ownerId: 0,
      weaponId: 'machine_gun',
      position: { x: 0, y: 1 },
      velocity: { x: 0, y: 0 },
      spawnTick: 0,
    };
    const out = stepWeapons(emptyState([proj]), [target], DT, {
      weaponConfigs: configs(MACHINE_GUN),
      tick: 1,
    });

    const hit = out.events.find((e) => e.type === 'hit') as HitEvent;
    expect(hit).toBeDefined();
    expect(hit.damageDealt).toBe(10);
    expect(hit.remainingArmor).toBe(90);
    expect(out.updatedCars[0]!.currentArmor).toBe(90);
    // Projectile consumed on contact.
    expect(out.updatedState.projectiles).toHaveLength(0);
  });

  it('never hits the projectile owner', () => {
    const owner = car(0, 0, 0, 100);
    const proj: ActiveProjectile = {
      id: 1,
      ownerId: 0,
      weaponId: 'machine_gun',
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      spawnTick: 0,
    };
    const out = stepWeapons(emptyState([proj]), [owner], DT, {
      weaponConfigs: configs(MACHINE_GUN),
      tick: 1,
    });
    expect(out.events.some((e) => e.type === 'hit')).toBe(false);
    expect(out.updatedCars[0]!.currentArmor).toBe(100);
  });
});

// --- Elimination (Req 3.5) -------------------------------------------------

describe('stepWeapons: elimination (Req 3.5)', () => {
  it('emits an elimination event when armor reaches zero in the same tick', () => {
    const target = car(1, 0, 0, 10); // exactly one machine-gun hit of damage
    const proj: ActiveProjectile = {
      id: 1,
      ownerId: 0,
      weaponId: 'machine_gun',
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      spawnTick: 0,
    };
    const out = stepWeapons(emptyState([proj]), [target], DT, {
      weaponConfigs: configs(MACHINE_GUN),
      tick: 1,
    });

    const elim = out.events.find((e) => e.type === 'elimination') as EliminationEvent;
    expect(elim).toBeDefined();
    expect(elim.eliminatedId).toBe(1);
    expect(elim.killedById).toBe(0);
    expect(out.updatedCars[0]!.eliminated).toBe(true);
    expect(out.updatedCars[0]!.currentArmor).toBeLessThanOrEqual(0);
  });
});

// --- Beam DPS (Req 3.6) ----------------------------------------------------

describe('stepWeapons: beam damage (Req 3.6)', () => {
  it('applies beamDPS * dt per discrete tick', () => {
    const attacker = car(0, 0, 0, 100);
    const target = car(1, 10, 0, 100);
    const out = stepWeapons(emptyState(), [attacker, target], DT, {
      weaponConfigs: configs(BEAM),
      tick: 0,
      fireInputs: [
        {
          participantId: 0,
          fireForward: true,
          fireRear: false,
          forwardWeaponId: 'beam_cannon',
          rearWeaponId: null,
          beamTargetId: 1,
        },
      ],
    });

    const beam = out.events.find((e) => e.type === 'beam_damage') as BeamDamageEvent;
    expect(beam).toBeDefined();
    expect(beam.damageDealt).toBeCloseTo(60 * DT); // 1 HP per tick at 60 DPS / 60 Hz
    expect(out.updatedCars[1]!.currentArmor).toBeCloseTo(100 - 60 * DT);
    // A beam does not spawn a projectile.
    expect(out.updatedState.projectiles).toHaveLength(0);
  });
});

// --- Hazard contact & removal (Req 3.8) ------------------------------------

describe('stepWeapons: hazard contact (Req 3.8)', () => {
  it('damages any contacting car and removes the hazard', () => {
    const victim = car(2, 3, 3, 100);
    const haz: PlacedHazard = {
      id: 1,
      ownerId: 0,
      weaponId: 'mine',
      position: { x: 3, y: 3 },
      spawnTick: 0,
      triggered: false,
    };
    const out = stepWeapons(emptyState([], [haz]), [victim], DT, {
      weaponConfigs: configs(MINE),
      tick: 1,
    });

    const hit = out.events.find((e) => e.type === 'hit') as HitEvent;
    expect(hit).toBeDefined();
    expect(hit.damageDealt).toBe(25);
    expect(out.updatedCars[0]!.currentArmor).toBe(75);
    expect(out.updatedState.hazards).toHaveLength(0); // removed on contact
  });

  it('triggers on the owner car too (self-damage)', () => {
    const owner = car(0, 0, 0, 100);
    const haz: PlacedHazard = {
      id: 1,
      ownerId: 0,
      weaponId: 'mine',
      position: { x: 0, y: 0 },
      spawnTick: 0,
      triggered: false,
    };
    const out = stepWeapons(emptyState([], [haz]), [owner], DT, {
      weaponConfigs: configs(MINE),
      tick: 1,
    });
    expect(out.updatedCars[0]!.currentArmor).toBe(75);
    expect(out.updatedState.hazards).toHaveLength(0);
  });
});

// --- Purity / determinism --------------------------------------------------

describe('stepWeapons: purity and determinism', () => {
  it('does not mutate the input car states', () => {
    const shooter = car(0, 0, 0, 100, new Map([['machine_gun', 5]]));
    const originalArmor = shooter.currentArmor;
    const originalAmmo = shooter.ammo.get('machine_gun');
    stepWeapons(emptyState(), [shooter], DT, {
      weaponConfigs: configs(MACHINE_GUN),
      tick: 0,
      fireInputs: [
        { participantId: 0, fireForward: true, fireRear: false, forwardWeaponId: 'machine_gun', rearWeaponId: null },
      ],
    });
    expect(shooter.currentArmor).toBe(originalArmor);
    expect(shooter.ammo.get('machine_gun')).toBe(originalAmmo);
  });

  it('produces identical output for identical input', () => {
    const build = () => {
      const attacker = car(0, 0, 0, 100, new Map([['machine_gun', 5]]));
      const target = car(1, 0, 1, 100);
      return stepWeapons(emptyState(), [attacker, target], DT, {
        weaponConfigs: configs(MACHINE_GUN),
        tick: 3,
        fireInputs: [
          { participantId: 0, fireForward: true, fireRear: false, forwardWeaponId: 'machine_gun', rearWeaponId: null },
        ],
      });
    };
    const a = build();
    const b = build();
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.nextProjectileId).toBe(b.nextProjectileId);
  });
});
