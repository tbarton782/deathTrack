import { describe, expect, it } from 'vitest';
import type {
  CarPhysicsState,
  CarRaceState,
  Loadout,
  WeaponConfig,
  WeaponId,
} from '@deathtrack/shared';
import {
  HOMING_WEAPON_IDS,
  WEAPON_SLOT_ORDER,
  buildAmmoRows,
  buildHudModel,
  formatAmmo,
  formatArmor,
  formatLap,
  formatPlacement,
  formatSpeed,
  isHomingWarningActive,
  isHomingWeapon,
  type IncomingHomingThreat,
} from '../HUD';

/**
 * These tests exercise only the GPU-free HUD model: speed/armor/lap/placement
 * formatting, the per-weapon ammo-row builder, the homing-warning decision, and
 * the aggregate HUD-model builder. They run in the headless `node` vitest
 * environment.
 *
 * The PixiJS `HUD` overlay draw path requires a WebGL context and is validated
 * in the browser, not here.
 *
 * Validates: Requirements 11.1 (HUD shows speed, armor level, per-weapon ammo
 * counts, current lap, placement, and a homing-weapon warning indicator).
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function weaponConfig(
  id: WeaponId,
  overrides: Partial<WeaponConfig> = {},
): WeaponConfig {
  return {
    id,
    name: id,
    category: 'forward',
    damage: 10,
    beamDPS: null,
    projectileSpeed: 200,
    ammoMax: 100,
    rangeUnits: 500,
    price: 1000,
    slot: 'forward',
    ...overrides,
  };
}

function physics(speed: number): CarPhysicsState {
  return {
    id: 0,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: speed },
    heading: 0,
    speed,
    angularVelocity: 0,
    onTrack: true,
    airborne: false,
    airborneHeight: 0,
    airborneVY: 0,
  };
}

function raceState(overrides: Partial<CarRaceState> = {}): CarRaceState {
  return {
    participantId: 0,
    physics: physics(72),
    currentArmor: 134,
    ammo: new Map<WeaponId, number>(),
    eliminated: false,
    lap: 2,
    placement: 3,
    waypointIndex: 0,
    ...overrides,
  };
}

const emptyLoadout: Loadout = {
  chassisId: 'hellcat',
  components: {
    engine: null,
    brakes: null,
    transmission: null,
    tires: null,
    airfoil: null,
    armor: null,
  },
  weapons: {
    forward: null,
    rear: null,
    side_spike: null,
    ram: null,
  },
};

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

describe('formatSpeed', () => {
  it('rounds to a whole number and appends the unit label', () => {
    expect(formatSpeed(72.4)).toBe('72 MPH');
    expect(formatSpeed(72.6)).toBe('73 MPH');
  });

  it('clamps negatives to zero', () => {
    expect(formatSpeed(-5)).toBe('0 MPH');
    expect(formatSpeed(0)).toBe('0 MPH');
  });
});

describe('formatArmor', () => {
  it('renders a whole non-negative number', () => {
    expect(formatArmor(134)).toBe('134');
    expect(formatArmor(0.4)).toBe('0');
  });

  it('never renders a negative value', () => {
    expect(formatArmor(-10)).toBe('0');
  });
});

describe('formatLap', () => {
  it('renders lap n/total when the total is known', () => {
    expect(formatLap(2, 5)).toBe('LAP 2/5');
  });

  it('renders lap n when the total is unknown', () => {
    expect(formatLap(2)).toBe('LAP 2');
    expect(formatLap(2, 0)).toBe('LAP 2');
  });

  it('clamps the lap number to at least 1', () => {
    expect(formatLap(0, 5)).toBe('LAP 1/5');
    expect(formatLap(-3)).toBe('LAP 1');
  });
});

describe('formatPlacement', () => {
  it('renders ordinal suffixes', () => {
    expect(formatPlacement(1)).toBe('1st');
    expect(formatPlacement(2)).toBe('2nd');
    expect(formatPlacement(3)).toBe('3rd');
    expect(formatPlacement(4)).toBe('4th');
  });

  it('handles the 11-13 teens exception', () => {
    expect(formatPlacement(11)).toBe('11th');
    expect(formatPlacement(12)).toBe('12th');
    expect(formatPlacement(13)).toBe('13th');
  });
});

// ---------------------------------------------------------------------------
// Homing warning
// ---------------------------------------------------------------------------

describe('isHomingWeapon', () => {
  it('recognises the missile and terminator as homing weapons', () => {
    expect(isHomingWeapon('missile')).toBe(true);
    expect(isHomingWeapon('terminator')).toBe(true);
    expect([...HOMING_WEAPON_IDS].sort()).toEqual(['missile', 'terminator']);
  });

  it('treats other weapons as non-homing', () => {
    expect(isHomingWeapon('machine_gun')).toBe(false);
    expect(isHomingWeapon('laser')).toBe(false);
    expect(isHomingWeapon('mine')).toBe(false);
  });
});

describe('isHomingWarningActive', () => {
  it('arms when a homing threat has acquired the local player', () => {
    const threats: IncomingHomingThreat[] = [
      { weaponId: 'missile', targetId: 0 },
    ];
    expect(isHomingWarningActive(threats, 0)).toBe(true);
  });

  it('ignores homing threats aimed at other participants', () => {
    const threats: IncomingHomingThreat[] = [
      { weaponId: 'missile', targetId: 1 },
      { weaponId: 'terminator', targetId: 2 },
    ];
    expect(isHomingWarningActive(threats, 0)).toBe(false);
  });

  it('ignores non-homing threats targeting the local player', () => {
    const threats: IncomingHomingThreat[] = [
      { weaponId: 'machine_gun', targetId: 0 },
    ];
    expect(isHomingWarningActive(threats, 0)).toBe(false);
  });

  it('is inactive when there are no threats', () => {
    expect(isHomingWarningActive([], 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Ammo rows
// ---------------------------------------------------------------------------

describe('buildAmmoRows', () => {
  it('emits one row per equipped weapon in slot order', () => {
    const loadout: Loadout = {
      ...emptyLoadout,
      weapons: {
        forward: 'machine_gun',
        rear: 'mine',
        side_spike: null,
        ram: 'ram',
      },
    };
    const ammo = new Map<WeaponId, number>([
      ['machine_gun', 40],
      ['mine', 3],
      ['ram', 1],
    ]);
    const configs = new Map<WeaponId, WeaponConfig>([
      ['machine_gun', weaponConfig('machine_gun', { name: 'Machine Gun', ammoMax: 200 })],
      ['mine', weaponConfig('mine', { name: 'Mine', ammoMax: 5, slot: 'rear' })],
      ['ram', weaponConfig('ram', { name: 'Ram', ammoMax: 1, slot: 'ram' })],
    ]);

    const rows = buildAmmoRows(loadout, ammo, configs);
    expect(rows.map((r) => r.slot)).toEqual(['forward', 'rear', 'ram']);
    expect(rows.map((r) => r.weaponId)).toEqual(['machine_gun', 'mine', 'ram']);
    expect(rows.map((r) => r.name)).toEqual(['Machine Gun', 'Mine', 'Ram']);
    expect(rows.map((r) => r.ammo)).toEqual([40, 3, 1]);
    expect(rows.map((r) => r.ammoMax)).toEqual([200, 5, 1]);
  });

  it('follows the fixed slot order regardless of loadout key order', () => {
    expect([...WEAPON_SLOT_ORDER]).toEqual([
      'forward',
      'rear',
      'side_spike',
      'ram',
    ]);
  });

  it('skips empty slots', () => {
    const rows = buildAmmoRows(
      emptyLoadout,
      new Map<WeaponId, number>(),
      new Map<WeaponId, WeaponConfig>(),
    );
    expect(rows).toEqual([]);
  });

  it('treats live ammo missing from the map as zero', () => {
    const loadout: Loadout = {
      ...emptyLoadout,
      weapons: { ...emptyLoadout.weapons, forward: 'machine_gun' },
    };
    const configs = new Map<WeaponId, WeaponConfig>([
      ['machine_gun', weaponConfig('machine_gun', { ammoMax: 100 })],
    ]);
    const rows = buildAmmoRows(loadout, new Map(), configs);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.ammo).toBe(0);
  });

  it('skips weapons with no config so it only shows describable weapons', () => {
    const loadout: Loadout = {
      ...emptyLoadout,
      weapons: { ...emptyLoadout.weapons, forward: 'laser' },
    };
    const rows = buildAmmoRows(
      loadout,
      new Map<WeaponId, number>([['laser', 10]]),
      new Map<WeaponId, WeaponConfig>(),
    );
    expect(rows).toEqual([]);
  });
});

describe('formatAmmo', () => {
  it('renders current/max', () => {
    const row = {
      slot: 'forward' as const,
      weaponId: 'machine_gun' as WeaponId,
      name: 'Machine Gun',
      ammo: 40,
      ammoMax: 200,
    };
    expect(formatAmmo(row)).toBe('40/200');
  });

  it('never renders a negative current count', () => {
    const row = {
      slot: 'rear' as const,
      weaponId: 'mine' as WeaponId,
      name: 'Mine',
      ammo: -1,
      ammoMax: 5,
    };
    expect(formatAmmo(row)).toBe('0/5');
  });
});

// ---------------------------------------------------------------------------
// Aggregate model
// ---------------------------------------------------------------------------

describe('buildHudModel', () => {
  it('combines all readouts from live race state', () => {
    const loadout: Loadout = {
      ...emptyLoadout,
      weapons: { ...emptyLoadout.weapons, forward: 'machine_gun' },
    };
    const car = raceState({
      physics: physics(72),
      currentArmor: 134,
      lap: 2,
      placement: 3,
      ammo: new Map<WeaponId, number>([['machine_gun', 40]]),
    });
    const configs = new Map<WeaponId, WeaponConfig>([
      ['machine_gun', weaponConfig('machine_gun', { name: 'Machine Gun', ammoMax: 200 })],
    ]);

    const model = buildHudModel(car, loadout, configs, { totalLaps: 5 });
    expect(model.speed).toBe('72 MPH');
    expect(model.armor).toBe('134');
    expect(model.lap).toBe('LAP 2/5');
    expect(model.placement).toBe('3rd');
    expect(model.ammoRows).toHaveLength(1);
    expect(model.ammoRows[0]!.name).toBe('Machine Gun');
    expect(model.homingWarning).toBe(false);
  });

  it('arms the homing warning only for threats acquiring the local car', () => {
    const car = raceState({ participantId: 2 });
    const configs = new Map<WeaponId, WeaponConfig>();

    const armed = buildHudModel(car, emptyLoadout, configs, {
      homingThreats: [{ weaponId: 'terminator', targetId: 2 }],
    });
    expect(armed.homingWarning).toBe(true);

    const other = buildHudModel(car, emptyLoadout, configs, {
      homingThreats: [{ weaponId: 'terminator', targetId: 5 }],
    });
    expect(other.homingWarning).toBe(false);
  });

  it('defaults to no homing warning and lap-only formatting', () => {
    const car = raceState({ lap: 1, placement: 1 });
    const model = buildHudModel(car, emptyLoadout, new Map());
    expect(model.lap).toBe('LAP 1');
    expect(model.placement).toBe('1st');
    expect(model.homingWarning).toBe(false);
  });
});
