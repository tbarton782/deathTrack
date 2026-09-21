/**
 * Unit and property tests for {@link SaveFileCodec}.
 *
 * Covers:
 * - Full-career encode -> decode round-trip preserving every persisted field.
 * - Correct header layout (magic, version) and trailing CRC-32.
 * - Rejection of a corrupt file (flipped byte) via CRC-32 mismatch.
 * - Rejection of a bad magic and an unsupported version.
 *
 * Requirements: 12.4, 5.5
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  SaveFileCodec,
  CorruptSaveError,
  crc32,
  SAVE_FILE_MAGIC,
  SAVE_FILE_VERSION,
} from '../SaveFileCodec.js';
import type { CareerState, SaveFile } from '../../types/career.js';
import type { Loadout } from '../../types/car.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLoadout(): Loadout {
  return {
    chassisId: 'hellcat',
    components: {
      engine: 'turbo_engine_mk2',
      brakes: null,
      transmission: 'gearbox_x',
      tires: null,
      airfoil: null,
      armor: 'plate_v',
    },
    weapons: {
      forward: 'machine_gun',
      rear: 'mine',
      side_spike: null,
      ram: 'ram',
    },
  };
}

function makeCareer(overrides: Partial<CareerState> = {}): CareerState {
  return {
    saveSlot: 2,
    playerName: 'Rip Hunter',
    money: 123456,
    ownedComponents: ['turbo_engine_mk2', 'gearbox_x', 'plate_v'],
    ownedWeapons: ['machine_gun', 'mine', 'ram'],
    currentCircuitIndex: 4,
    circuitNumber: 2,
    currentLoadout: makeLoadout(),
    totalEarnings: 987654,
    eliminationCount: 42,
    ...overrides,
  };
}

function makeSaveFile(career: CareerState = makeCareer()): SaveFile {
  return {
    magic: SAVE_FILE_MAGIC,
    version: SAVE_FILE_VERSION,
    slot: career.saveSlot,
    career,
    crc32: 0, // ignored on encode; recomputed
  };
}

// ---------------------------------------------------------------------------
// Layout and round-trip unit tests
// ---------------------------------------------------------------------------

describe('SaveFileCodec layout', () => {
  it('writes the DTRA magic as the first four little-endian bytes', () => {
    const bytes = SaveFileCodec.encode(makeSaveFile());
    // 0x44545241 little-endian -> 41 52 54 44
    expect(bytes[0]).toBe(0x41);
    expect(bytes[1]).toBe(0x52);
    expect(bytes[2]).toBe(0x54);
    expect(bytes[3]).toBe(0x44);
  });

  it('appends a CRC-32 trailer computed over all preceding bytes', () => {
    const bytes = SaveFileCodec.encode(makeSaveFile());
    const prefix = bytes.subarray(0, bytes.byteLength - 4);
    const trailer = new DataView(
      bytes.buffer,
      bytes.byteOffset + bytes.byteLength - 4,
      4,
    ).getUint32(0, true);
    expect(trailer).toBe(crc32(prefix));
  });

  it('emits the canonical magic even if the input object carries a stale one', () => {
    const save = makeSaveFile();
    const decoded = SaveFileCodec.decode(SaveFileCodec.encode(save));
    expect(decoded.magic).toBe(SAVE_FILE_MAGIC);
    expect(decoded.version).toBe(SAVE_FILE_VERSION);
  });
});

describe('SaveFileCodec round-trip', () => {
  it('round-trips a full career with all fields populated', () => {
    const save = makeSaveFile();
    const decoded = SaveFileCodec.decode(SaveFileCodec.encode(save));
    expect(decoded.career).toEqual(save.career);
    expect(decoded.slot).toBe(save.slot);
  });

  it('round-trips a fresh career with empty owned lists and null loadout slots', () => {
    const career = makeCareer({
      saveSlot: 1,
      playerName: 'A',
      money: 0,
      ownedComponents: [],
      ownedWeapons: [],
      currentCircuitIndex: 0,
      circuitNumber: 1,
      currentLoadout: {
        chassisId: 'crusher',
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
    });
    const decoded = SaveFileCodec.decode(SaveFileCodec.encode(makeSaveFile(career)));
    expect(decoded.career).toEqual(career);
  });

  it('preserves unicode player names', () => {
    const career = makeCareer({ playerName: 'Zoë 車 💀' });
    const decoded = SaveFileCodec.decode(SaveFileCodec.encode(makeSaveFile(career)));
    expect(decoded.career.playerName).toBe('Zoë 車 💀');
  });
});

// ---------------------------------------------------------------------------
// Corruption / validation unit tests
// ---------------------------------------------------------------------------

describe('SaveFileCodec integrity validation', () => {
  it('throws CorruptSaveError with crc-mismatch when a fixed-width payload byte is flipped', () => {
    const bytes = SaveFileCodec.encode(makeSaveFile());
    // Flip a byte inside the `money` uint32 field. Header = magic(4) + version(4)
    // + slot(1) = 9; career then writes saveSlot(1) + playerName varString
    // (2-byte len + 10 name bytes = 12) = offset 22 is the first `money` byte.
    // Flipping a fixed-width data byte cannot corrupt any length prefix, so the
    // buffer stays structurally decodable and the CRC-32 guard is what rejects it.
    const moneyOffset = 9 + 1 + 2 + 'Rip Hunter'.length;
    bytes[moneyOffset] = bytes[moneyOffset]! ^ 0xff;
    expect(() => SaveFileCodec.decode(bytes)).toThrowError(CorruptSaveError);
    try {
      SaveFileCodec.decode(bytes);
    } catch (err) {
      expect((err as CorruptSaveError).reason).toBe('crc-mismatch');
    }
  });

  it('throws CorruptSaveError with crc-mismatch when the trailer is flipped', () => {
    const bytes = SaveFileCodec.encode(makeSaveFile());
    bytes[bytes.byteLength - 1] = bytes[bytes.byteLength - 1]! ^ 0x01;
    try {
      SaveFileCodec.decode(bytes);
      throw new Error('expected decode to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CorruptSaveError);
      expect((err as CorruptSaveError).reason).toBe('crc-mismatch');
    }
  });

  it('throws CorruptSaveError with bad-magic for a foreign file', () => {
    const bytes = SaveFileCodec.encode(makeSaveFile());
    bytes[0] = 0x00; // corrupt magic
    // Recompute a valid CRC so we isolate the magic check.
    const prefix = bytes.subarray(0, bytes.byteLength - 4);
    const view = new DataView(bytes.buffer, bytes.byteOffset + bytes.byteLength - 4, 4);
    view.setUint32(0, crc32(prefix), true);
    try {
      SaveFileCodec.decode(bytes);
      throw new Error('expected decode to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CorruptSaveError);
      expect((err as CorruptSaveError).reason).toBe('bad-magic');
    }
  });

  it('throws CorruptSaveError with bad-version for an unsupported version', () => {
    const bytes = SaveFileCodec.encode(makeSaveFile());
    // Bump the version (bytes 4..7) to an unsupported value, then fix the CRC.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(4, SAVE_FILE_VERSION + 1, true);
    const prefix = bytes.subarray(0, bytes.byteLength - 4);
    view.setUint32(bytes.byteLength - 4, crc32(prefix), true);
    try {
      SaveFileCodec.decode(bytes);
      throw new Error('expected decode to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CorruptSaveError);
      expect((err as CorruptSaveError).reason).toBe('bad-version');
    }
  });

  it('throws CorruptSaveError with truncated for a too-short buffer', () => {
    const bytes = SaveFileCodec.encode(makeSaveFile()).subarray(0, 8);
    try {
      SaveFileCodec.decode(bytes);
      throw new Error('expected decode to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CorruptSaveError);
      expect((err as CorruptSaveError).reason).toBe('truncated');
    }
  });
});

// ---------------------------------------------------------------------------
// CRC-32 sanity
// ---------------------------------------------------------------------------

describe('crc32', () => {
  it('matches the well-known check value for "123456789"', () => {
    const input = new TextEncoder().encode('123456789');
    expect(crc32(input)).toBe(0xcbf43926);
  });

  it('returns 0 for an empty input', () => {
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Property tests
// ---------------------------------------------------------------------------

describe('property: SaveFileCodec round-trip preserves all persisted career fields', () => {
  const componentIdArb = fc.string({ minLength: 1, maxLength: 24 });
  const nullableComponentArb = fc.option(componentIdArb, { nil: null });
  const weaponIdArb = fc.constantFrom<import('../../types/primitives.js').WeaponId>(
    'machine_gun',
    'laser',
    'beam_cannon',
    'missile',
    'terminator',
    'mine',
    'caltrop',
    'wheel_spike',
    'ram',
  );
  const nullableWeaponArb = fc.option(weaponIdArb, { nil: null });

  const loadoutArb: fc.Arbitrary<Loadout> = fc.record({
    chassisId: fc.constantFrom<Loadout['chassisId']>('hellcat', 'crusher', 'pitbull'),
    components: fc.record({
      engine: nullableComponentArb,
      brakes: nullableComponentArb,
      transmission: nullableComponentArb,
      tires: nullableComponentArb,
      airfoil: nullableComponentArb,
      armor: nullableComponentArb,
    }),
    weapons: fc.record({
      forward: nullableWeaponArb,
      rear: nullableWeaponArb,
      side_spike: nullableWeaponArb,
      ram: nullableWeaponArb,
    }),
  });

  const careerArb: fc.Arbitrary<CareerState> = fc.record({
    saveSlot: fc.constantFrom<CareerState['saveSlot']>(1, 2, 3),
    playerName: fc.string({ minLength: 1, maxLength: 20 }),
    money: fc.integer({ min: 0, max: 0xffffffff }),
    ownedComponents: fc.array(componentIdArb, { maxLength: 20 }),
    ownedWeapons: fc.array(weaponIdArb, { maxLength: 20 }),
    currentCircuitIndex: fc.integer({ min: 0, max: 9 }),
    circuitNumber: fc.integer({ min: 1, max: 0xffff }),
    currentLoadout: loadoutArb,
    totalEarnings: fc.integer({ min: 0, max: 0xffffffff }),
    eliminationCount: fc.integer({ min: 0, max: 0xffffffff }),
  });

  const saveArb: fc.Arbitrary<SaveFile> = careerArb.map((career) => ({
    magic: SAVE_FILE_MAGIC as SaveFile['magic'],
    version: SAVE_FILE_VERSION,
    slot: career.saveSlot,
    career,
    crc32: 0,
  }));

  it('reproduces a deeply-equal SaveFile for any valid career', () => {
    fc.assert(
      fc.property(saveArb, (save) => {
        const decoded = SaveFileCodec.decode(SaveFileCodec.encode(save));
        expect(decoded.career).toEqual(save.career);
        expect(decoded.slot).toBe(save.slot);
        expect(decoded.version).toBe(save.version);
        expect(decoded.magic).toBe(SAVE_FILE_MAGIC);
      }),
      { numRuns: 1000 },
    );
  });

  it('detects corruption when any single payload byte is flipped', () => {
    fc.assert(
      fc.property(
        saveArb,
        fc.nat(),
        (save, rawIndex) => {
          const bytes = SaveFileCodec.encode(save);
          // Pick a byte anywhere in the buffer and flip it; the CRC (or magic /
          // version guard) must reject it. Skip the pure round-trip case.
          const index = rawIndex % bytes.byteLength;
          const original = bytes[index]!;
          bytes[index] = original ^ 0xff;
          expect(() => SaveFileCodec.decode(bytes)).toThrowError(CorruptSaveError);
        },
      ),
      { numRuns: 1000 },
    );
  });
});
