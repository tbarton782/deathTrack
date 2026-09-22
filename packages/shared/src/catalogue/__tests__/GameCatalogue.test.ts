import { describe, it, expect } from 'vitest';

import {
  CHASSIS_CATALOGUE,
  COMPONENT_CATALOGUE,
  WEAPON_CATALOGUE,
  findChassis,
} from '../GameCatalogue.js';
import {
  computeEffectiveStats,
  emptyLoadout,
  STAT_MAXIMA,
} from '../../loadout/LoadoutService.js';
import type { ComponentDef, ComponentId } from '../../types/car.js';
import type { WeaponSlot } from '../../types/primitives.js';

/** The legal weapon ids per slot (mirrors the loadout service's contract). */
const WEAPONS_BY_SLOT: Record<WeaponSlot, readonly string[]> = {
  forward: ['machine_gun', 'laser', 'beam_cannon', 'missile', 'terminator'],
  rear: ['mine', 'caltrop'],
  side_spike: ['wheel_spike'],
  ram: ['ram'],
};

describe('CHASSIS_CATALOGUE', () => {
  it('provides at least three chassis (Req 4.1)', () => {
    expect(CHASSIS_CATALOGUE.length).toBeGreaterThanOrEqual(3);
  });

  it('has unique ids', () => {
    const ids = CHASSIS_CATALOGUE.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('no two chassis share identical values across all four base stats (Req 4.1)', () => {
    for (let i = 0; i < CHASSIS_CATALOGUE.length; i++) {
      for (let j = i + 1; j < CHASSIS_CATALOGUE.length; j++) {
        const a = CHASSIS_CATALOGUE[i]!.baseStats;
        const b = CHASSIS_CATALOGUE[j]!.baseStats;
        const identical =
          a.topSpeed === b.topSpeed &&
          a.acceleration === b.acceleration &&
          a.armor === b.armor &&
          a.handling === b.handling;
        expect(identical).toBe(false);
      }
    }
  });

  it('keeps every base stat within the clamped ranges (Req 4.3)', () => {
    for (const c of CHASSIS_CATALOGUE) {
      const s = c.baseStats;
      expect(s.topSpeed).toBeGreaterThan(0);
      expect(s.topSpeed).toBeLessThanOrEqual(STAT_MAXIMA.topSpeed);
      expect(s.acceleration).toBeGreaterThan(0);
      expect(s.acceleration).toBeLessThanOrEqual(STAT_MAXIMA.acceleration);
      expect(s.armor).toBeGreaterThan(0);
      expect(s.armor).toBeLessThanOrEqual(STAT_MAXIMA.armor);
      expect(s.handling).toBeGreaterThan(0);
      expect(s.handling).toBeLessThanOrEqual(STAT_MAXIMA.handling);
    }
  });

  it('findChassis resolves known ids and rejects unknown ones', () => {
    expect(findChassis('hellcat')?.name).toBe('Hellcat');
    expect(findChassis('nope')).toBeUndefined();
  });
});

describe('COMPONENT_CATALOGUE', () => {
  it('offers a component for every one of the six upgrade slots (Req 4.2)', () => {
    const slots = new Set(COMPONENT_CATALOGUE.map((c) => c.slot));
    expect(slots).toEqual(
      new Set(['engine', 'brakes', 'transmission', 'tires', 'airfoil', 'armor']),
    );
  });

  it('has unique component ids and positive prices', () => {
    const ids = COMPONENT_CATALOGUE.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of COMPONENT_CATALOGUE) expect(c.price).toBeGreaterThan(0);
  });

  it('components apply via the shared effective-stats service, clamped (Req 4.3)', () => {
    // Equip every component on the Hellcat and confirm the result stays clamped.
    const chassis = findChassis('hellcat')!;
    const loadout = emptyLoadout('hellcat');
    const byId = new Map<ComponentId, ComponentDef>();
    for (const c of COMPONENT_CATALOGUE) {
      byId.set(c.id, c);
      loadout.components[c.slot] = c.id;
    }
    const stats = computeEffectiveStats(loadout, chassis, byId);
    expect(stats.topSpeed).toBeLessThanOrEqual(STAT_MAXIMA.topSpeed);
    expect(stats.acceleration).toBeLessThanOrEqual(STAT_MAXIMA.acceleration);
    expect(stats.armor).toBeLessThanOrEqual(STAT_MAXIMA.armor);
    expect(stats.handling).toBeLessThanOrEqual(STAT_MAXIMA.handling);
    // The V8 engine (+15 topSpeed) and racing tires (+3) raise the Hellcat's 70.
    expect(stats.topSpeed).toBeGreaterThan(chassis.baseStats.topSpeed);
  });
});

describe('WEAPON_CATALOGUE', () => {
  it('defines every WeaponId exactly once', () => {
    const ids = WEAPON_CATALOGUE.map((w) => w.id).sort();
    expect(ids).toEqual(
      [
        'beam_cannon',
        'caltrop',
        'laser',
        'machine_gun',
        'mine',
        'missile',
        'ram',
        'terminator',
        'wheel_spike',
      ].sort(),
    );
  });

  it('assigns each weapon to a slot that legally accepts it (Req 3.9/4.4)', () => {
    for (const w of WEAPON_CATALOGUE) {
      expect(WEAPONS_BY_SLOT[w.slot]).toContain(w.id);
    }
  });

  it('has coherent damage/beam fields and positive ammo + price', () => {
    for (const w of WEAPON_CATALOGUE) {
      expect(w.ammoMax).toBeGreaterThanOrEqual(1);
      expect(w.ammoMax).toBeLessThanOrEqual(999);
      expect(w.price).toBeGreaterThan(0);
      // A weapon deals damage EITHER by hit (`damage`) OR continuously (`beamDPS`).
      const dealsDamage = w.damage > 0 || (w.beamDPS !== null && w.beamDPS > 0);
      expect(dealsDamage).toBe(true);
    }
  });
});
