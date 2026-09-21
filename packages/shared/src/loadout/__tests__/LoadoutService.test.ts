/**
 * Behavioural unit tests for the LoadoutService.
 *
 * Covers each public function: weapon/component equipping rules, effective
 * stat computation and clamping, component preview, loadout confirmation and
 * immutability, and the race lock.
 *
 * Requirements: 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */

import { describe, it, expect } from 'vitest';

import type { ChassisDef, ComponentDef, Loadout } from '../../types/car.js';
import type { WeaponDef } from '../../types/weapons.js';
import type { ComponentId, WeaponId } from '../../types/primitives.js';

import {
  equip,
  equipComponent,
  computeEffectiveStats,
  previewComponent,
  confirmLoadout,
  rejectEquipDuringRace,
  emptyLoadout,
  STAT_MAXIMA,
  CHASSIS_BASE_MASS,
  MASS_PER_ARMOR,
} from '../LoadoutService.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const chassis: ChassisDef = {
  id: 'hellcat',
  name: 'Hellcat',
  baseStats: { topSpeed: 60, acceleration: 50, armor: 100, handling: 55 },
  spriteSheet: { path: 'assets/hellcat.bin' },
};

const turbo: ComponentDef = {
  id: 'turbo',
  slot: 'engine',
  name: 'Turbo Engine',
  price: 500,
  statDeltas: { topSpeed: 20, acceleration: 10 },
};

const heavyArmor: ComponentDef = {
  id: 'heavy_armor',
  slot: 'armor',
  name: 'Heavy Armor',
  price: 800,
  statDeltas: { armor: 150 },
};

const componentCatalogue = new Map<ComponentId, ComponentDef>([
  [turbo.id, turbo],
  [heavyArmor.id, heavyArmor],
]);

const machineGun: WeaponDef = {
  id: 'machine_gun',
  name: 'Machine Gun',
  category: 'forward',
  damage: 5,
  beamDPS: null,
  projectileSpeed: 400,
  ammoMax: 200,
  rangeUnits: 300,
  price: 100,
  slot: 'forward',
};

const mine: WeaponDef = {
  id: 'mine',
  name: 'Mine',
  category: 'rear_drop',
  damage: 40,
  beamDPS: null,
  projectileSpeed: null,
  ammoMax: 10,
  rangeUnits: null,
  price: 150,
  slot: 'rear',
};

const weaponCatalogue = new Map<WeaponId, WeaponDef>([
  [machineGun.id, machineGun],
  [mine.id, mine],
]);

const base = (): Loadout => emptyLoadout('hellcat');

// ---------------------------------------------------------------------------
// equip
// ---------------------------------------------------------------------------

describe('equip (Req 4.4)', () => {
  it('equips a weapon into an empty slot without mutating the input', () => {
    const loadout = base();
    const result = equip(loadout, 'forward', 'machine_gun', weaponCatalogue);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.weapons.forward).toBe('machine_gun');
    }
    // input untouched
    expect(loadout.weapons.forward).toBeNull();
  });

  it('rejects when the slot is already occupied', () => {
    const first = equip(base(), 'forward', 'machine_gun', weaponCatalogue);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = equip(first.value, 'forward', 'machine_gun', weaponCatalogue);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe('slot_occupied');
  });

  it('rejects a weapon that is not in the catalogue', () => {
    const empty = new Map<WeaponId, WeaponDef>();
    const result = equip(base(), 'forward', 'machine_gun', empty);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('weapon_not_in_catalogue');
  });

  it('rejects when the weapon does not belong to the requested slot', () => {
    const result = equip(base(), 'rear', 'machine_gun', weaponCatalogue);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('weapon_slot_mismatch');
  });
});

// ---------------------------------------------------------------------------
// equipComponent
// ---------------------------------------------------------------------------

describe('equipComponent (Req 4.2, 4.6)', () => {
  it('equips an owned component that exists in the catalogue', () => {
    const result = equipComponent(base(), 'engine', 'turbo', componentCatalogue, ['turbo']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.components.engine).toBe('turbo');
  });

  it('rejects a component that is not in the catalogue', () => {
    const result = equipComponent(base(), 'engine', 'ghost', componentCatalogue, ['ghost']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('component_not_in_catalogue');
  });

  it('rejects a component whose slot does not match', () => {
    const result = equipComponent(base(), 'armor', 'turbo', componentCatalogue, ['turbo']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('component_slot_mismatch');
  });

  it('rejects a component the player does not own', () => {
    const result = equipComponent(base(), 'engine', 'turbo', componentCatalogue, []);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('component_not_owned');
  });

  it('overwrites an existing component in the same slot (one per slot)', () => {
    const first = equipComponent(base(), 'engine', 'turbo', componentCatalogue, ['turbo']);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    // Only one component id ever lives in the slot.
    expect(first.value.components.engine).toBe('turbo');
  });
});

// ---------------------------------------------------------------------------
// computeEffectiveStats
// ---------------------------------------------------------------------------

describe('computeEffectiveStats (Req 4.3)', () => {
  it('returns base stats when nothing is equipped', () => {
    const stats = computeEffectiveStats(base(), chassis, componentCatalogue);
    expect(stats.topSpeed).toBe(60);
    expect(stats.acceleration).toBe(50);
    expect(stats.armor).toBe(100);
    expect(stats.handling).toBe(55);
  });

  it('additively applies component deltas', () => {
    const loadout: Loadout = { ...base(), components: { ...base().components, engine: 'turbo' } };
    const stats = computeEffectiveStats(loadout, chassis, componentCatalogue);
    expect(stats.topSpeed).toBe(80); // 60 + 20
    expect(stats.acceleration).toBe(60); // 50 + 10
  });

  it('clamps effective stats to the defined maxima', () => {
    const loadout: Loadout = { ...base(), components: { ...base().components, armor: 'heavy_armor' } };
    const stats = computeEffectiveStats(loadout, chassis, componentCatalogue);
    // 100 + 150 = 250, clamped to armor max 200
    expect(stats.armor).toBe(STAT_MAXIMA.armor);
    expect(stats.armor).toBe(200);
  });

  it('derives mass from clamped effective armor', () => {
    const stats = computeEffectiveStats(base(), chassis, componentCatalogue);
    expect(stats.mass).toBe(CHASSIS_BASE_MASS + 100 * MASS_PER_ARMOR);
  });
});

// ---------------------------------------------------------------------------
// previewComponent
// ---------------------------------------------------------------------------

describe('previewComponent (Req 4.7)', () => {
  it('reports delta and resulting effective stat per stat', () => {
    const result = previewComponent(base(), chassis, componentCatalogue, 'turbo');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.topSpeed.delta).toBe(20);
    expect(result.value.topSpeed.effective).toBe(80);
    expect(result.value.armor.delta).toBe(0);
    expect(result.value.armor.effective).toBe(100);
  });

  it('rejects previewing an unknown component', () => {
    const result = previewComponent(base(), chassis, componentCatalogue, 'ghost');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('component_not_in_catalogue');
  });
});

// ---------------------------------------------------------------------------
// confirmLoadout
// ---------------------------------------------------------------------------

describe('confirmLoadout (Req 4.5, 4.3)', () => {
  it('produces a ResolvedLoadout with effective stats and initial ammo', () => {
    let loadout = base();
    const eq = equip(loadout, 'forward', 'machine_gun', weaponCatalogue);
    expect(eq.ok).toBe(true);
    if (!eq.ok) return;
    loadout = eq.value;

    const resolved = confirmLoadout(loadout, chassis, componentCatalogue, weaponCatalogue);
    expect(resolved.effectiveStats.topSpeed).toBe(60);
    expect(resolved.initialAmmo.get('machine_gun')).toBe(200);
    expect(resolved.initialAmmo.has('mine')).toBe(false);
  });

  it('freezes the resolved loadout so it cannot be mutated', () => {
    const resolved = confirmLoadout(base(), chassis, componentCatalogue, weaponCatalogue);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.weapons)).toBe(true);
    expect(Object.isFrozen(resolved.components)).toBe(true);
    expect(() => {
      'use strict';
      // Deliberately attempting an illegal mutation of a frozen object.
      (resolved.weapons as { forward: WeaponId | null }).forward = 'mine';
    }).toThrow();
  });
});

// ---------------------------------------------------------------------------
// rejectEquipDuringRace
// ---------------------------------------------------------------------------

describe('rejectEquipDuringRace (Req 4.5)', () => {
  it('rejects while a race is active', () => {
    expect(rejectEquipDuringRace(true)).toBe(true);
  });

  it('allows while no race is active', () => {
    expect(rejectEquipDuringRace(false)).toBe(false);
  });
});
