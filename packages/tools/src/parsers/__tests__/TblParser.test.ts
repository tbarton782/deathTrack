/**
 * Tests for the `.TBL` weapon/chassis stat-table parser.
 *
 * Requirements: 4.1, 4.2, 4.3, 3.1
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type {
  CarBaseStats,
  ChassisDef,
  ComponentDef,
  ComponentSlot,
  WeaponCategory,
  WeaponDef,
  WeaponSlot,
} from '@deathtrack/shared';
import {
  TBL_KIND_CHASSIS,
  TBL_KIND_WEAPON,
  TBL_MAGIC,
  TBL_VERSION,
  TblParseError,
  parseChassisTable,
  parseWeaponTable,
  type ChassisTable,
  type WeaponTable,
} from '../TblParser.js';

// ---------------------------------------------------------------------------
// Test-only encoder mirroring the parser's container layout
// ---------------------------------------------------------------------------

const STRING_FIELD_BYTES = 32;
const NULL_U32 = 0xffffffff;
const WEAPON_CATEGORIES: readonly WeaponCategory[] = ['forward', 'rear_drop', 'ram', 'spike'];
const WEAPON_SLOTS: readonly WeaponSlot[] = ['forward', 'rear', 'side_spike', 'ram'];
const COMPONENT_SLOTS: readonly ComponentSlot[] = [
  'engine',
  'brakes',
  'transmission',
  'tires',
  'airfoil',
  'armor',
];

/** Sequential little-endian writer matching the parser's expectations. */
class Writer {
  private parts: number[] = [];

  u8(v: number): this {
    this.parts.push(v & 0xff);
    return this;
  }

  u16(v: number): this {
    this.parts.push(v & 0xff, (v >> 8) & 0xff);
    return this;
  }

  i16(v: number): this {
    return this.u16(v < 0 ? v + 0x10000 : v);
  }

  u32(v: number): this {
    this.parts.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }

  str(s: string): this {
    const bytes = new TextEncoder().encode(s);
    for (let i = 0; i < STRING_FIELD_BYTES; i += 1) {
      this.parts.push(i < bytes.length ? (bytes[i] as number) : 0);
    }
    return this;
  }

  toBytes(): Uint8Array {
    return new Uint8Array(this.parts);
  }
}

function writeHeader(w: Writer, kind: number, primary: number, secondary: number): void {
  w.u32(TBL_MAGIC).u32(TBL_VERSION).u8(kind).u8(0).u16(primary).u16(secondary).u16(0);
}

function writeWeapon(w: Writer, def: WeaponDef): void {
  w.str(def.id)
    .str(def.name)
    .u8(WEAPON_CATEGORIES.indexOf(def.category))
    .u8(WEAPON_SLOTS.indexOf(def.slot))
    .u16(0)
    .u32(def.damage)
    .u32(def.beamDPS ?? NULL_U32)
    .u32(def.projectileSpeed ?? NULL_U32)
    .u32(def.ammoMax)
    .u32(def.rangeUnits ?? NULL_U32)
    .u32(def.price);
}

function writeChassis(w: Writer, def: ChassisDef): void {
  w.str(def.id)
    .str(def.name)
    .str(def.spriteSheet.path)
    .str(def.spriteSheet.atlasKey ?? '')
    .u16(def.baseStats.topSpeed)
    .u16(def.baseStats.acceleration)
    .u16(def.baseStats.armor)
    .u16(def.baseStats.handling);
}

function writeComponent(w: Writer, def: ComponentDef): void {
  const d = def.statDeltas;
  let mask = 0;
  if (d.topSpeed !== undefined) mask |= 0b0001;
  if (d.acceleration !== undefined) mask |= 0b0010;
  if (d.armor !== undefined) mask |= 0b0100;
  if (d.handling !== undefined) mask |= 0b1000;
  w.str(def.id)
    .str(def.name)
    .u8(COMPONENT_SLOTS.indexOf(def.slot))
    .u8(mask)
    .u16(0)
    .u32(def.price)
    .i16(d.topSpeed ?? 0)
    .i16(d.acceleration ?? 0)
    .i16(d.armor ?? 0)
    .i16(d.handling ?? 0);
}

function encodeWeaponTable(table: WeaponTable): Uint8Array {
  const w = new Writer();
  writeHeader(w, TBL_KIND_WEAPON, table.weapons.length, 0);
  for (const wpn of table.weapons) writeWeapon(w, wpn);
  return w.toBytes();
}

function encodeChassisTable(table: ChassisTable): Uint8Array {
  const w = new Writer();
  writeHeader(w, TBL_KIND_CHASSIS, table.chassis.length, table.components.length);
  for (const c of table.chassis) writeChassis(w, c);
  for (const comp of table.components) writeComponent(w, comp);
  return w.toBytes();
}

// ---------------------------------------------------------------------------
// Sample fixtures
// ---------------------------------------------------------------------------

const sampleWeapons: WeaponDef[] = [
  {
    id: 'machine_gun',
    name: 'Machine Gun',
    category: 'forward',
    damage: 5,
    beamDPS: null,
    projectileSpeed: 400,
    ammoMax: 200,
    rangeUnits: 300,
    price: 500,
    slot: 'forward',
  },
  {
    id: 'beam_cannon',
    name: 'Beam Cannon',
    category: 'forward',
    damage: 0,
    beamDPS: 40,
    projectileSpeed: null,
    ammoMax: 100,
    rangeUnits: null,
    price: 3000,
    slot: 'forward',
  },
  {
    id: 'mine',
    name: 'Proximity Mine',
    category: 'rear_drop',
    damage: 30,
    beamDPS: null,
    projectileSpeed: null,
    ammoMax: 10,
    rangeUnits: null,
    price: 800,
    slot: 'rear',
  },
];

const sampleChassis: ChassisDef[] = [
  {
    id: 'hellcat',
    name: 'Hellcat',
    baseStats: { topSpeed: 80, acceleration: 60, armor: 100, handling: 70 },
    spriteSheet: { path: 'assets/cars/hellcat.bin', atlasKey: 'hellcat' },
  },
  {
    id: 'crusher',
    name: 'Crusher',
    baseStats: { topSpeed: 55, acceleration: 45, armor: 180, handling: 40 },
    spriteSheet: { path: 'assets/cars/crusher.bin' },
  },
];

const sampleComponents: ComponentDef[] = [
  {
    id: 'turbo_engine_mk2',
    slot: 'engine',
    name: 'Turbo Engine Mk2',
    price: 1200,
    statDeltas: { topSpeed: 15, acceleration: 10 },
  },
  {
    id: 'reinforced_armor',
    slot: 'armor',
    name: 'Reinforced Armor',
    price: 900,
    statDeltas: { armor: 40, handling: -5 },
  },
];

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe('parseWeaponTable', () => {
  it('parses all weapon records with correct fields and optional nulls', () => {
    const table = parseWeaponTable(encodeWeaponTable({ weapons: sampleWeapons }));
    expect(table.weapons).toEqual(sampleWeapons);
  });

  it('preserves beamDPS for beam weapons and null for projectile weapons', () => {
    const table = parseWeaponTable(encodeWeaponTable({ weapons: sampleWeapons }));
    const beam = table.weapons.find((w) => w.id === 'beam_cannon');
    const gun = table.weapons.find((w) => w.id === 'machine_gun');
    expect(beam?.beamDPS).toBe(40);
    expect(beam?.projectileSpeed).toBeNull();
    expect(gun?.beamDPS).toBeNull();
    expect(gun?.projectileSpeed).toBe(400);
  });

  it('parses an empty weapon table', () => {
    const table = parseWeaponTable(encodeWeaponTable({ weapons: [] }));
    expect(table.weapons).toEqual([]);
  });

  it('rejects a buffer with a bad magic number, reporting offset 0', () => {
    const buf = encodeWeaponTable({ weapons: sampleWeapons });
    buf[0] = 0x00;
    expect(() => parseWeaponTable(buf)).toThrowError(TblParseError);
    try {
      parseWeaponTable(buf);
    } catch (err) {
      expect((err as TblParseError).offset).toBe(0);
    }
  });

  it('rejects an unsupported version at the version offset', () => {
    const buf = encodeWeaponTable({ weapons: sampleWeapons });
    buf[4] = 0x99; // version field starts at byte 4
    try {
      parseWeaponTable(buf);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TblParseError);
      expect((err as TblParseError).offset).toBe(4);
      expect((err as TblParseError).message).toContain('unsupported version');
    }
  });

  it('rejects a chassis table passed to the weapon parser', () => {
    const buf = encodeChassisTable({ chassis: sampleChassis, components: [] });
    expect(() => parseWeaponTable(buf)).toThrowError(/expected weapon table/);
  });

  it('reports the record index and byte offset on truncation', () => {
    const full = encodeWeaponTable({ weapons: sampleWeapons });
    const truncated = full.subarray(0, full.length - 4);
    try {
      parseWeaponTable(truncated);
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(TblParseError);
      expect((err as TblParseError).message).toContain('weapon record');
      expect((err as TblParseError).offset).toBeGreaterThan(0);
    }
  });

  it('rejects an out-of-range weapon category index', () => {
    const buf = encodeWeaponTable({ weapons: [sampleWeapons[0] as WeaponDef] });
    // Category byte sits right after id (32) + name (32) fields, past the 16-byte header.
    const categoryOffset = 16 + STRING_FIELD_BYTES * 2;
    buf[categoryOffset] = 99;
    expect(() => parseWeaponTable(buf)).toThrowError(/invalid weapon category index 99/);
  });
});

describe('parseChassisTable', () => {
  it('parses chassis and component records with correct fields', () => {
    const table = parseChassisTable(
      encodeChassisTable({ chassis: sampleChassis, components: sampleComponents }),
    );
    expect(table.chassis).toEqual(sampleChassis);
    expect(table.components).toEqual(sampleComponents);
  });

  it('omits atlasKey when the sprite atlas string is empty', () => {
    const table = parseChassisTable(
      encodeChassisTable({ chassis: sampleChassis, components: [] }),
    );
    const crusher = table.chassis.find((c) => c.id === 'crusher');
    expect(crusher?.spriteSheet.atlasKey).toBeUndefined();
    expect(crusher?.spriteSheet.path).toBe('assets/cars/crusher.bin');
  });

  it('only includes stat deltas selected by the mask', () => {
    const table = parseChassisTable(
      encodeChassisTable({ chassis: [], components: sampleComponents }),
    );
    const engine = table.components.find((c) => c.id === 'turbo_engine_mk2');
    expect(engine?.statDeltas).toEqual({ topSpeed: 15, acceleration: 10 });
    expect(engine?.statDeltas.armor).toBeUndefined();
  });

  it('preserves negative stat deltas', () => {
    const table = parseChassisTable(
      encodeChassisTable({ chassis: [], components: sampleComponents }),
    );
    const armor = table.components.find((c) => c.id === 'reinforced_armor');
    expect(armor?.statDeltas.handling).toBe(-5);
  });

  it('rejects a weapon table passed to the chassis parser', () => {
    const buf = encodeWeaponTable({ weapons: sampleWeapons });
    expect(() => parseChassisTable(buf)).toThrowError(/expected chassis table/);
  });

  it('rejects an out-of-range component slot index', () => {
    const buf = encodeChassisTable({ chassis: [], components: [sampleComponents[0] as ComponentDef] });
    const slotOffset = 16 + STRING_FIELD_BYTES * 2; // after id + name
    buf[slotOffset] = 42;
    expect(() => parseChassisTable(buf)).toThrowError(/invalid component slot index 42/);
  });
});

// ---------------------------------------------------------------------------
// Property-based round-trip checks (encode -> parse yields original)
// ---------------------------------------------------------------------------

const weaponCategoryArb = fc.constantFrom<WeaponCategory>(...WEAPON_CATEGORIES);
const weaponSlotArb = fc.constantFrom<WeaponSlot>(...WEAPON_SLOTS);
const optionalU32Arb = fc.option(fc.integer({ min: 0, max: 0xfffffffe }), { nil: null });

const weaponArb: fc.Arbitrary<WeaponDef> = fc.record({
  id: fc.constantFrom('machine_gun', 'laser', 'beam_cannon', 'missile', 'terminator', 'mine', 'caltrop', 'wheel_spike', 'ram'),
  name: fc.string({ maxLength: 20 }).filter((s) => new TextEncoder().encode(s).length <= 31),
  category: weaponCategoryArb,
  damage: fc.integer({ min: 0, max: 0xffffffff }),
  beamDPS: optionalU32Arb,
  projectileSpeed: optionalU32Arb,
  ammoMax: fc.integer({ min: 0, max: 999 }),
  rangeUnits: optionalU32Arb,
  price: fc.integer({ min: 0, max: 0xffffffff }),
  slot: weaponSlotArb,
}) as fc.Arbitrary<WeaponDef>;

const componentSlotArb = fc.constantFrom<ComponentSlot>(...COMPONENT_SLOTS);
const safeStr = fc.string({ maxLength: 20 }).filter((s) => new TextEncoder().encode(s).length <= 31);
const deltaArb = fc.integer({ min: -0x8000, max: 0x7fff });

const componentArb: fc.Arbitrary<ComponentDef> = fc
  .record({
    id: safeStr,
    slot: componentSlotArb,
    name: safeStr,
    price: fc.integer({ min: 0, max: 0xffffffff }),
    statDeltas: fc.record(
      {
        topSpeed: deltaArb,
        acceleration: deltaArb,
        armor: deltaArb,
        handling: deltaArb,
      },
      { requiredKeys: [] },
    ) as fc.Arbitrary<Partial<CarBaseStats>>,
  }) as fc.Arbitrary<ComponentDef>;

describe('TblParser round-trip properties', () => {
  it('encode -> parseWeaponTable reproduces the original weapons (Validates: Requirements 3.1)', () => {
    fc.assert(
      fc.property(fc.array(weaponArb, { maxLength: 20 }), (weapons) => {
        const parsed = parseWeaponTable(encodeWeaponTable({ weapons }));
        expect(parsed.weapons).toEqual(weapons);
      }),
    );
  });

  it('encode -> parseChassisTable reproduces the original components (Validates: Requirements 4.2, 4.3)', () => {
    fc.assert(
      fc.property(fc.array(componentArb, { maxLength: 20 }), (components) => {
        const parsed = parseChassisTable(encodeChassisTable({ chassis: [], components }));
        expect(parsed.components).toEqual(components);
      }),
    );
  });
});
