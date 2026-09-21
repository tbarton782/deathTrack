import { describe, expect, it, vi } from 'vitest';
import type {
  CareerState,
  ComponentDef,
  WeaponDef,
} from '@deathtrack/shared';
import {
  attemptPurchase,
  buildCatalogueRows,
  componentToCatalogueItem,
  describeComponentEffect,
  describeWeaponEffect,
  formatMoney,
  weaponToCatalogueItem,
  type ShopCatalogueItem,
} from '../Shop';

/**
 * These tests exercise only the GPU-free shop model: the catalogue → display
 * row mapping (name, effect, price, affordability, exact shortfall) and the
 * purchase decision that delegates to the shared `purchaseItem` rule. They run
 * in the headless `node` vitest environment.
 *
 * The PixiJS `Shop` overlay draw path requires a WebGL context and is validated
 * in the browser, not here.
 *
 * Validates: Requirements 5.3 (catalogue entries show name, effect, price) and
 * 5.4 (exact shortfall shown and purchase blocked when funds are insufficient).
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const turbo: ComponentDef = {
  id: 'turbo_engine',
  slot: 'engine',
  name: 'Turbo Engine',
  price: 1200,
  statDeltas: { topSpeed: 8, handling: -2 },
};

const armorPlate: ComponentDef = {
  id: 'armor_plate',
  slot: 'armor',
  name: 'Armor Plate',
  price: 800,
  statDeltas: { armor: 25 },
};

const machineGun: WeaponDef = {
  id: 'machine_gun',
  name: 'Machine Gun',
  category: 'forward',
  damage: 12,
  beamDPS: null,
  projectileSpeed: 60,
  ammoMax: 200,
  rangeUnits: 40,
  price: 500,
  slot: 'forward',
};

const laser: WeaponDef = {
  id: 'laser',
  name: 'Laser',
  category: 'forward',
  damage: 0,
  beamDPS: 40,
  projectileSpeed: null,
  ammoMax: 60,
  rangeUnits: null,
  price: 2000,
  slot: 'forward',
};

function career(money: number): CareerState {
  return {
    saveSlot: 1,
    playerName: 'Tester',
    money,
    ownedComponents: [],
    ownedWeapons: [],
    currentCircuitIndex: 0,
    circuitNumber: 1,
    currentLoadout: {
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
    },
    totalEarnings: 0,
    eliminationCount: 0,
  };
}

// ---------------------------------------------------------------------------
// Effect descriptions
// ---------------------------------------------------------------------------

describe('describeComponentEffect', () => {
  it('lists non-zero stat deltas in stable order with signs', () => {
    expect(describeComponentEffect(turbo)).toBe('+8 top speed, -2 handling');
  });

  it('renders a single delta', () => {
    expect(describeComponentEffect(armorPlate)).toBe('+25 armor');
  });

  it('reports no stat change when there are no deltas', () => {
    const inert: ComponentDef = { ...turbo, statDeltas: {} };
    expect(describeComponentEffect(inert)).toBe('no stat change');
  });
});

describe('describeWeaponEffect', () => {
  it('describes a per-hit projectile weapon', () => {
    expect(describeWeaponEffect(machineGun)).toBe('forward · 12 dmg/hit · 200 ammo');
  });

  it('describes a beam weapon using dmg/s', () => {
    expect(describeWeaponEffect(laser)).toBe('forward · 40 dmg/s · 60 ammo');
  });
});

describe('componentToCatalogueItem / weaponToCatalogueItem', () => {
  it('normalises a component entry with name, effect and price', () => {
    expect(componentToCatalogueItem(turbo)).toEqual<ShopCatalogueItem>({
      id: 'turbo_engine',
      kind: 'component',
      name: 'Turbo Engine',
      effect: '+8 top speed, -2 handling',
      price: 1200,
    });
  });

  it('normalises a weapon entry with name, effect and price', () => {
    expect(weaponToCatalogueItem(machineGun)).toEqual<ShopCatalogueItem>({
      id: 'machine_gun',
      kind: 'weapon',
      name: 'Machine Gun',
      effect: 'forward · 12 dmg/hit · 200 ammo',
      price: 500,
    });
  });
});

// ---------------------------------------------------------------------------
// buildCatalogueRows — name/effect/price, affordability, exact shortfall
// ---------------------------------------------------------------------------

describe('buildCatalogueRows', () => {
  it('lists components before weapons, preserving input order within each', () => {
    const rows = buildCatalogueRows([turbo, armorPlate], [machineGun, laser], 100000);
    expect(rows.map((r) => r.id)).toEqual([
      'turbo_engine',
      'armor_plate',
      'machine_gun',
      'laser',
    ]);
    expect(rows.map((r) => r.kind)).toEqual([
      'component',
      'component',
      'weapon',
      'weapon',
    ]);
  });

  it('carries name, effect, and price for each entry', () => {
    const rows = buildCatalogueRows([turbo], [machineGun], 100000);
    expect(rows[0]).toMatchObject({
      name: 'Turbo Engine',
      effect: '+8 top speed, -2 handling',
      price: 1200,
    });
    expect(rows[1]).toMatchObject({
      name: 'Machine Gun',
      effect: 'forward · 12 dmg/hit · 200 ammo',
      price: 500,
    });
  });

  it('marks items affordable and reports zero shortfall when money covers price', () => {
    const rows = buildCatalogueRows([turbo], [], 1200);
    expect(rows[0]!.affordable).toBe(true);
    expect(rows[0]!.shortfall).toBe(0);
  });

  it('marks items affordable when money exceeds price', () => {
    const rows = buildCatalogueRows([turbo], [], 5000);
    expect(rows[0]!.affordable).toBe(true);
    expect(rows[0]!.shortfall).toBe(0);
  });

  it('reports the EXACT shortfall when funds are insufficient', () => {
    // price 1200, money 850 -> shortfall 350; price 500 weapon -> affordable.
    const rows = buildCatalogueRows([turbo], [machineGun], 850);
    expect(rows[0]!.affordable).toBe(false);
    expect(rows[0]!.shortfall).toBe(350);
    expect(rows[1]!.affordable).toBe(true);
    expect(rows[1]!.shortfall).toBe(0);
  });

  it('reports the full price as shortfall when the player has no money', () => {
    const rows = buildCatalogueRows([], [laser], 0);
    expect(rows[0]!.affordable).toBe(false);
    expect(rows[0]!.shortfall).toBe(2000);
  });

  it('does not mutate the input catalogues', () => {
    const components = [turbo, armorPlate];
    const weapons = [machineGun];
    const csnap = [...components];
    const wsnap = [...weapons];
    buildCatalogueRows(components, weapons, 100);
    expect(components).toEqual(csnap);
    expect(weapons).toEqual(wsnap);
  });
});

// ---------------------------------------------------------------------------
// attemptPurchase — delegates to shared purchaseItem
// ---------------------------------------------------------------------------

describe('attemptPurchase', () => {
  it('succeeds for an affordable item and deducts exactly the price', () => {
    const item = weaponToCatalogueItem(machineGun); // price 500
    const result = attemptPurchase(career(1000), item);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.money).toBe(500);
    }
  });

  it('rejects an unaffordable item with the exact shortfall and no deduction', () => {
    const item = componentToCatalogueItem(turbo); // price 1200
    const result = attemptPurchase(career(850), item);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('insufficient_funds');
      expect(result.shortfall).toBe(350);
    }
  });
});

// ---------------------------------------------------------------------------
// Shop overlay buy() — callback wiring (constructed headlessly)
// ---------------------------------------------------------------------------

describe('Shop.buy (purchase callback wiring)', () => {
  it('invokes the purchase callback for an affordable row', async () => {
    const { Shop } = await import('../Shop');
    const onPurchase = vi.fn();
    // money 1000: turbo (1200) unaffordable, machine gun (500) affordable.
    const shop = new Shop([turbo], [machineGun], 1000, onPurchase);
    // rows: [0] turbo (unaffordable), [1] machine gun (affordable).
    const fired = shop.buy(1);
    expect(fired).toBe(true);
    expect(onPurchase).toHaveBeenCalledTimes(1);
    expect(onPurchase.mock.calls[0]![0]).toMatchObject({ id: 'machine_gun' });
  });

  it('does not invoke the purchase callback for an unaffordable row', async () => {
    const { Shop } = await import('../Shop');
    const onPurchase = vi.fn();
    const shop = new Shop([turbo], [machineGun], 1000, onPurchase);
    const fired = shop.buy(0); // turbo, unaffordable at money 1000
    expect(fired).toBe(false);
    expect(onPurchase).not.toHaveBeenCalled();
    // and the row surfaces the exact shortfall instead
    expect(shop.rows[0]!.shortfall).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// formatMoney
// ---------------------------------------------------------------------------

describe('formatMoney', () => {
  it('formats whole currency units with a $ prefix and separators', () => {
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoney(1200)).toBe('$1,200');
    expect(formatMoney(2000000)).toBe('$2,000,000');
  });
});
