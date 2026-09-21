/**
 * Property-based test for loadout effective stats — Property 8.
 *
 * **Property 8**: Loadout effective stats are the clamped additive sum of the
 * chassis base stats and every equipped component's deltas. For each of the
 * four canonical stats (`topSpeed`, `acceleration`, `armor`, `handling`) the
 * effective value is `clamp(baseStat + sum(equipped deltas), 0, STAT_MAXIMA[stat])`,
 * and the derived `mass` is `CHASSIS_BASE_MASS + clampedArmor * MASS_PER_ARMOR`
 * where `clampedArmor` is the clamped effective armor.
 *
 * This exercises {@link computeEffectiveStats} across arbitrary chassis base
 * stats and arbitrary sets of equipped components carrying arbitrary (possibly
 * negative, possibly extreme) stat deltas. Each run compares the service output
 * against an independent reference implementation of the same additive-then-clamp
 * rule, so the test does not merely re-derive the implementation's arithmetic in
 * the same shape it uses internally.
 *
 * The generator builds a genuine {@link Loadout} + component catalogue pair:
 * for every one of the six component slots it may (or may not) equip a
 * component, and the reference sums only the deltas of the components that are
 * actually equipped and present in the catalogue — mirroring the service's own
 * "ignore unknown ids" contract.
 *
 * **Validates: Requirements 4.3**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  computeEffectiveStats,
  emptyLoadout,
  STAT_MAXIMA,
  CHASSIS_BASE_MASS,
  MASS_PER_ARMOR,
} from '../LoadoutService.js';
import type {
  CarBaseStats,
  ChassisDef,
  ComponentDef,
  Loadout,
} from '../../types/car.js';
import type { ComponentId, ComponentSlot } from '../../types/primitives.js';

// ---------------------------------------------------------------------------
// Constants mirrored from the domain
// ---------------------------------------------------------------------------

/** The six component slots a car exposes. */
const COMPONENT_SLOTS: readonly ComponentSlot[] = [
  'engine',
  'brakes',
  'transmission',
  'tires',
  'airfoil',
  'armor',
];

const STAT_KEYS: readonly (keyof CarBaseStats)[] = [
  'topSpeed',
  'acceleration',
  'armor',
  'handling',
];

// ---------------------------------------------------------------------------
// Independent reference implementation
// ---------------------------------------------------------------------------

function refClamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Reference computation of effective stats, written independently of the
 * service: start from the base stats, add every equipped-and-known component's
 * declared delta for each stat, then clamp each stat into `[0, STAT_MAXIMA]`.
 * `mass` is derived from the clamped armor.
 */
function referenceEffectiveStats(
  loadout: Loadout,
  chassis: ChassisDef,
  components: ReadonlyMap<ComponentId, ComponentDef>,
): { topSpeed: number; acceleration: number; armor: number; handling: number; mass: number } {
  const sums: Record<keyof CarBaseStats, number> = {
    topSpeed: chassis.baseStats.topSpeed,
    acceleration: chassis.baseStats.acceleration,
    armor: chassis.baseStats.armor,
    handling: chassis.baseStats.handling,
  };

  for (const slot of COMPONENT_SLOTS) {
    const id = loadout.components[slot];
    if (id === null) continue;
    const def = components.get(id);
    if (def === undefined) continue;
    for (const key of STAT_KEYS) {
      const delta = def.statDeltas[key];
      if (delta !== undefined) sums[key] += delta;
    }
  }

  const clampedArmor = refClamp(sums.armor, 0, STAT_MAXIMA.armor);
  return {
    topSpeed: refClamp(sums.topSpeed, 0, STAT_MAXIMA.topSpeed),
    acceleration: refClamp(sums.acceleration, 0, STAT_MAXIMA.acceleration),
    armor: clampedArmor,
    handling: refClamp(sums.handling, 0, STAT_MAXIMA.handling),
    mass: CHASSIS_BASE_MASS + clampedArmor * MASS_PER_ARMOR,
  };
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Arbitrary base stats within (and slightly beyond) the design's ranges. */
const baseStatsArb: fc.Arbitrary<CarBaseStats> = fc.record({
  topSpeed: fc.integer({ min: 0, max: 120 }),
  acceleration: fc.integer({ min: 0, max: 120 }),
  armor: fc.integer({ min: 0, max: 220 }),
  handling: fc.integer({ min: 0, max: 120 }),
});

const chassisArb: fc.Arbitrary<ChassisDef> = baseStatsArb.map((baseStats) => ({
  id: 'hellcat' as const,
  name: 'Test Chassis',
  baseStats,
  spriteSheet: { path: 'assets/test.bin' },
}));

/**
 * A partial set of stat deltas: each stat is independently present or absent,
 * and when present may be negative or large enough to force clamping in either
 * direction.
 */
const statDeltasArb: fc.Arbitrary<Partial<CarBaseStats>> = fc
  .record({
    topSpeed: fc.option(fc.integer({ min: -150, max: 150 }), { nil: undefined }),
    acceleration: fc.option(fc.integer({ min: -150, max: 150 }), { nil: undefined }),
    armor: fc.option(fc.integer({ min: -250, max: 250 }), { nil: undefined }),
    handling: fc.option(fc.integer({ min: -150, max: 150 }), { nil: undefined }),
  })
  .map((deltas) => {
    // Strip undefined entries so statDeltas is a genuine Partial<CarBaseStats>.
    const out: Partial<CarBaseStats> = {};
    for (const key of STAT_KEYS) {
      const v = deltas[key];
      if (v !== undefined) out[key] = v;
    }
    return out;
  });

/**
 * Build a loadout + catalogue pair: for every slot, optionally equip a
 * component with arbitrary deltas. Component ids are unique per slot so the
 * catalogue is well-formed. Each equipped component's declared slot matches the
 * slot it sits in, matching a well-formed confirmed loadout.
 */
const scenarioArb: fc.Arbitrary<{
  loadout: Loadout;
  components: Map<ComponentId, ComponentDef>;
}> = fc
  .tuple(
    ...COMPONENT_SLOTS.map((slot) =>
      fc.option(statDeltasArb, { nil: undefined }).map((deltas) =>
        deltas === undefined ? null : { slot, deltas },
      ),
    ),
  )
  .map((perSlot) => {
    const loadout = emptyLoadout('hellcat');
    const catalogue = new Map<ComponentId, ComponentDef>();

    perSlot.forEach((entry, index) => {
      if (entry === null) return;
      const slot = COMPONENT_SLOTS[index]!;
      const id = `comp_${slot}`;
      const def: ComponentDef = {
        id,
        slot,
        name: `Component ${slot}`,
        price: 0,
        statDeltas: entry.deltas,
      };
      catalogue.set(id, def);
      loadout.components[slot] = id;
    });

    return { loadout, components: catalogue };
  });

// ---------------------------------------------------------------------------
// Property 8
// ---------------------------------------------------------------------------

describe('Property 8 — effective stats are clamped additive sums', () => {
  it('matches an independent additive-then-clamp reference for arbitrary loadouts', () => {
    // Validates: Requirements 4.3
    fc.assert(
      fc.property(chassisArb, scenarioArb, (chassis, { loadout, components }) => {
        const actual = computeEffectiveStats(loadout, chassis, components);
        const expected = referenceEffectiveStats(loadout, chassis, components);

        expect(actual.topSpeed).toBe(expected.topSpeed);
        expect(actual.acceleration).toBe(expected.acceleration);
        expect(actual.armor).toBe(expected.armor);
        expect(actual.handling).toBe(expected.handling);
        expect(actual.mass).toBe(expected.mass);
      }),
      { numRuns: 500 },
    );
  });

  it('never produces a stat outside [0, STAT_MAXIMA] regardless of deltas', () => {
    // Validates: Requirements 4.3
    fc.assert(
      fc.property(chassisArb, scenarioArb, (chassis, { loadout, components }) => {
        const stats = computeEffectiveStats(loadout, chassis, components);

        expect(stats.topSpeed).toBeGreaterThanOrEqual(0);
        expect(stats.topSpeed).toBeLessThanOrEqual(STAT_MAXIMA.topSpeed);
        expect(stats.acceleration).toBeGreaterThanOrEqual(0);
        expect(stats.acceleration).toBeLessThanOrEqual(STAT_MAXIMA.acceleration);
        expect(stats.armor).toBeGreaterThanOrEqual(0);
        expect(stats.armor).toBeLessThanOrEqual(STAT_MAXIMA.armor);
        expect(stats.handling).toBeGreaterThanOrEqual(0);
        expect(stats.handling).toBeLessThanOrEqual(STAT_MAXIMA.handling);

        // Mass is derived from the clamped armor.
        expect(stats.mass).toBe(CHASSIS_BASE_MASS + stats.armor * MASS_PER_ARMOR);
      }),
      { numRuns: 500 },
    );
  });
});
