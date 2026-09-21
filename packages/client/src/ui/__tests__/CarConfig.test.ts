import { describe, expect, it } from 'vitest';
import {
  computeEffectiveStats,
  previewComponent,
  type ChassisDef,
  type ComponentDef,
  type Loadout,
  type WeaponDef,
} from '@deathtrack/shared';
import {
  COMPONENT_SLOT_ORDER,
  WEAPON_SLOT_ORDER,
  buildCarConfigViewModel,
  buildChassisOptions,
  buildComponentSlotRow,
  buildComponentSlotRows,
  buildWeaponSlotRow,
  buildWeaponSlotRows,
  formatDelta,
  indexComponents,
  type CarConfigInput,
} from '../CarConfig';

/**
 * These tests exercise only the GPU-free car-config *view-model*: chassis
 * options, per-slot component rows carrying `{ delta, effective }` cells, and
 * owned-only weapon pickers. None of this needs a WebGL context, so it runs
 * headless in the `node` vitest environment. The PixiJS `CarConfig` overlay
 * draw path requires a renderer and is validated in the browser, not here.
 *
 * Validates: Requirements 4.1 (chassis picker), 4.4 (weapon slots), 4.6
 * (owned-only weapon filtering), 4.7 (per-stat delta and resulting effective
 * stat shown for each candidate component).
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const hellcat: ChassisDef = {
  id: 'hellcat',
  name: 'Hellcat',
  baseStats: { topSpeed: 60, acceleration: 50, armor: 80, handling: 55 },
  spriteSheet: { path: 'cars/hellcat.bin' },
};

const crusher: ChassisDef = {
  id: 'crusher',
  name: 'Crusher',
  baseStats: { topSpeed: 45, acceleration: 40, armor: 140, handling: 40 },
  spriteSheet: { path: 'cars/crusher.bin' },
};

const chassisCatalogue: ChassisDef[] = [hellcat, crusher];

const turboEngine: ComponentDef = {
  id: 'turbo_engine',
  slot: 'engine',
  name: 'Turbo Engine',
  price: 500,
  statDeltas: { topSpeed: 15, acceleration: 8 },
};

const stockEngine: ComponentDef = {
  id: 'stock_engine',
  slot: 'engine',
  name: 'Stock Engine',
  price: 100,
  statDeltas: { topSpeed: 5 },
};

const heavyArmor: ComponentDef = {
  id: 'heavy_armor',
  slot: 'armor',
  name: 'Heavy Armor',
  price: 400,
  // Deliberately pushes armor past the 200 maximum so we can assert clamping
  // comes from the shared service.
  statDeltas: { armor: 140, handling: -10 },
};

const componentCatalogue: ComponentDef[] = [turboEngine, stockEngine, heavyArmor];

const machineGun: WeaponDef = {
  id: 'machine_gun',
  name: 'Machine Gun',
  category: 'forward',
  damage: 5,
  beamDPS: null,
  projectileSpeed: 400,
  ammoMax: 200,
  rangeUnits: 300,
  price: 250,
  slot: 'forward',
};

const laser: WeaponDef = {
  id: 'laser',
  name: 'Laser',
  category: 'forward',
  damage: 0,
  beamDPS: 30,
  projectileSpeed: null,
  ammoMax: 100,
  rangeUnits: 250,
  price: 600,
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

const weaponCatalogue: WeaponDef[] = [machineGun, laser, mine];

function baseLoadout(): Loadout {
  return {
    chassisId: 'hellcat',
    components: {
      engine: null,
      brakes: null,
      transmission: null,
      tires: null,
      airfoil: null,
      armor: null,
    },
    weapons: { forward: null, rear: null, side_spike: null, ram: null },
  };
}

function fullInput(overrides: Partial<CarConfigInput> = {}): CarConfigInput {
  return {
    loadout: baseLoadout(),
    chassisCatalogue,
    componentCatalogue,
    weaponCatalogue,
    ownedComponents: ['turbo_engine', 'stock_engine', 'heavy_armor'],
    ownedWeapons: ['machine_gun', 'mine'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Chassis picker (Req 4.1)
// ---------------------------------------------------------------------------

describe('buildChassisOptions', () => {
  it('lists every chassis and marks the selected one', () => {
    const options = buildChassisOptions(chassisCatalogue, baseLoadout());
    expect(options.map((o) => o.id)).toEqual(['hellcat', 'crusher']);
    expect(options.find((o) => o.id === 'hellcat')?.selected).toBe(true);
    expect(options.find((o) => o.id === 'crusher')?.selected).toBe(false);
  });

  it('carries the chassis base stats through for preview', () => {
    const options = buildChassisOptions(chassisCatalogue, baseLoadout());
    expect(options.find((o) => o.id === 'crusher')?.baseStats).toEqual(crusher.baseStats);
  });
});

// ---------------------------------------------------------------------------
// Component slots: per-stat delta + resulting effective stat (Req 4.7)
// ---------------------------------------------------------------------------

describe('buildComponentSlotRow', () => {
  it('lists only components eligible for the slot', () => {
    const row = buildComponentSlotRow(
      'engine',
      baseLoadout(),
      hellcat,
      indexComponents(componentCatalogue),
      ['turbo_engine', 'stock_engine'],
    );
    expect(row.candidates.map((c) => c.id).sort()).toEqual([
      'stock_engine',
      'turbo_engine',
    ]);
  });

  it('computes each candidate delta and effective stat via the shared previewComponent', () => {
    const components = indexComponents(componentCatalogue);
    const loadout = baseLoadout();
    const row = buildComponentSlotRow('engine', loadout, hellcat, components, [
      'turbo_engine',
    ]);
    const turbo = row.candidates.find((c) => c.id === 'turbo_engine')!;

    // Independently derive the expected values from the shared service.
    const preview = previewComponent(loadout, hellcat, components, 'turbo_engine');
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;

    const topSpeedCell = turbo.stats.find((s) => s.stat === 'topSpeed')!;
    expect(topSpeedCell.delta).toBe(preview.value.topSpeed.delta);
    expect(topSpeedCell.effective).toBe(preview.value.topSpeed.effective);
    // Sanity: base 60 + delta 15 = 75.
    expect(topSpeedCell.delta).toBe(15);
    expect(topSpeedCell.effective).toBe(75);

    const accelCell = turbo.stats.find((s) => s.stat === 'acceleration')!;
    expect(accelCell.delta).toBe(8);
    expect(accelCell.effective).toBe(58);
  });

  it('reflects the shared service armor clamp in the effective stat', () => {
    const components = indexComponents(componentCatalogue);
    const loadout = baseLoadout();
    const row = buildComponentSlotRow('armor', loadout, crusher, components, ['heavy_armor']);
    const heavy = row.candidates.find((c) => c.id === 'heavy_armor')!;
    const armorCell = heavy.stats.find((s) => s.stat === 'armor')!;

    // Crusher base armor 140 + delta 140 = 280, clamped to the 200 max.
    expect(armorCell.delta).toBe(140);
    expect(armorCell.effective).toBe(200);
  });

  it('flags candidates the player does not own (Req 4.6)', () => {
    const row = buildComponentSlotRow(
      'engine',
      baseLoadout(),
      hellcat,
      indexComponents(componentCatalogue),
      ['turbo_engine'],
    );
    expect(row.candidates.find((c) => c.id === 'turbo_engine')?.owned).toBe(true);
    expect(row.candidates.find((c) => c.id === 'stock_engine')?.owned).toBe(false);
  });

  it('marks the currently equipped component', () => {
    const loadout: Loadout = {
      ...baseLoadout(),
      components: { ...baseLoadout().components, engine: 'stock_engine' },
    };
    const row = buildComponentSlotRow(
      'engine',
      loadout,
      hellcat,
      indexComponents(componentCatalogue),
      ['stock_engine', 'turbo_engine'],
    );
    expect(row.equippedId).toBe('stock_engine');
    expect(row.candidates.find((c) => c.id === 'stock_engine')?.equipped).toBe(true);
    expect(row.candidates.find((c) => c.id === 'turbo_engine')?.equipped).toBe(false);
  });
});

describe('buildComponentSlotRows', () => {
  it('produces one row per component slot in canonical order', () => {
    const rows = buildComponentSlotRows(
      baseLoadout(),
      hellcat,
      indexComponents(componentCatalogue),
      [],
    );
    expect(rows.map((r) => r.slot)).toEqual([...COMPONENT_SLOT_ORDER]);
  });
});

// ---------------------------------------------------------------------------
// Weapon slots: owned-only filtering (Req 4.4, 4.6)
// ---------------------------------------------------------------------------

describe('buildWeaponSlotRow', () => {
  it('offers only owned weapons matching the slot', () => {
    const row = buildWeaponSlotRow(
      'forward',
      baseLoadout(),
      new Map(weaponCatalogue.map((w) => [w.id, w])),
      ['machine_gun'],
    );
    expect(row.candidates.map((c) => c.id)).toEqual(['machine_gun']);
  });

  it('excludes weapons the player does not own even if in the catalogue', () => {
    const weapons = new Map(weaponCatalogue.map((w) => [w.id, w]));
    // Player owns machine_gun but NOT laser; laser must not appear.
    const row = buildWeaponSlotRow('forward', baseLoadout(), weapons, ['machine_gun']);
    expect(row.candidates.some((c) => c.id === 'laser')).toBe(false);
  });

  it('excludes owned weapons whose declared slot does not match', () => {
    const weapons = new Map(weaponCatalogue.map((w) => [w.id, w]));
    // mine is a rear weapon; it must not appear in the forward slot even though owned.
    const row = buildWeaponSlotRow('forward', baseLoadout(), weapons, [
      'machine_gun',
      'mine',
    ]);
    expect(row.candidates.map((c) => c.id)).toEqual(['machine_gun']);
  });

  it('ignores owned weapon ids absent from the catalogue', () => {
    const weapons = new Map(weaponCatalogue.map((w) => [w.id, w]));
    const row = buildWeaponSlotRow('forward', baseLoadout(), weapons, [
      'machine_gun',
      // @ts-expect-error deliberately testing an id not in the catalogue map
      'ghost_weapon',
    ]);
    expect(row.candidates.map((c) => c.id)).toEqual(['machine_gun']);
  });

  it('marks the currently fitted weapon', () => {
    const loadout: Loadout = {
      ...baseLoadout(),
      weapons: { ...baseLoadout().weapons, forward: 'machine_gun' },
    };
    const row = buildWeaponSlotRow(
      'forward',
      loadout,
      new Map(weaponCatalogue.map((w) => [w.id, w])),
      ['machine_gun'],
    );
    expect(row.equippedId).toBe('machine_gun');
    expect(row.candidates.find((c) => c.id === 'machine_gun')?.equipped).toBe(true);
  });
});

describe('buildWeaponSlotRows', () => {
  it('produces one row per weapon slot in canonical order', () => {
    const rows = buildWeaponSlotRows(
      baseLoadout(),
      new Map(weaponCatalogue.map((w) => [w.id, w])),
      [],
    );
    expect(rows.map((r) => r.slot)).toEqual([...WEAPON_SLOT_ORDER]);
  });

  it('never surfaces a non-owned weapon in any slot', () => {
    const rows = buildWeaponSlotRows(
      baseLoadout(),
      new Map(weaponCatalogue.map((w) => [w.id, w])),
      ['mine'],
    );
    const allCandidateIds = rows.flatMap((r) => r.candidates.map((c) => c.id));
    expect(allCandidateIds).toEqual(['mine']);
    expect(allCandidateIds).not.toContain('machine_gun');
    expect(allCandidateIds).not.toContain('laser');
  });
});

// ---------------------------------------------------------------------------
// Full view-model (Req 4.1–4.7)
// ---------------------------------------------------------------------------

describe('buildCarConfigViewModel', () => {
  it('resolves the selected chassis and its effective stats via the shared service', () => {
    const input = fullInput();
    const vm = buildCarConfigViewModel(input);
    expect(vm.selectedChassis?.id).toBe('hellcat');
    expect(vm.effectiveStats).toEqual(
      computeEffectiveStats(input.loadout, hellcat, indexComponents(componentCatalogue)),
    );
  });

  it('recomputes effective stats when a component is equipped', () => {
    const loadout: Loadout = {
      ...baseLoadout(),
      components: { ...baseLoadout().components, engine: 'turbo_engine' },
    };
    const vm = buildCarConfigViewModel(fullInput({ loadout }));
    // Base top speed 60 + turbo 15.
    expect(vm.effectiveStats?.topSpeed).toBe(75);
  });

  it('builds all component and weapon slots', () => {
    const vm = buildCarConfigViewModel(fullInput());
    expect(vm.componentSlots).toHaveLength(COMPONENT_SLOT_ORDER.length);
    expect(vm.weaponSlots).toHaveLength(WEAPON_SLOT_ORDER.length);
  });

  it('weapon pickers across the whole view-model exclude non-owned weapons', () => {
    const vm = buildCarConfigViewModel(fullInput({ ownedWeapons: ['machine_gun', 'mine'] }));
    const ids = vm.weaponSlots.flatMap((s) => s.candidates.map((c) => c.id));
    expect(ids.sort()).toEqual(['machine_gun', 'mine']);
    expect(ids).not.toContain('laser');
  });

  it('returns null chassis/stats and no component slots for an unknown chassis', () => {
    const vm = buildCarConfigViewModel(
      fullInput({
        loadout: { ...baseLoadout(), chassisId: 'pitbull' },
      }),
    );
    expect(vm.selectedChassis).toBeNull();
    expect(vm.effectiveStats).toBeNull();
    expect(vm.componentSlots).toHaveLength(0);
    // Weapon pickers do not depend on the chassis and still resolve.
    expect(vm.weaponSlots).toHaveLength(WEAPON_SLOT_ORDER.length);
  });
});

describe('formatDelta', () => {
  it('adds an explicit plus sign for positive deltas', () => {
    expect(formatDelta(8)).toBe('+8');
  });

  it('keeps the minus sign for negative deltas and shows zero plainly', () => {
    expect(formatDelta(-4)).toBe('-4');
    expect(formatDelta(0)).toBe('0');
  });
});
