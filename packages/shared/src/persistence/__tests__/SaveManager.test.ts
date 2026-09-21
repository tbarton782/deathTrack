/**
 * Unit and property tests for {@link SaveManager} and {@link InMemorySlotStorage}.
 *
 * Covers the save/load round-trip through a slot, slot listing (occupied,
 * empty, and corrupt), missing-slot loads returning null, and corrupt-save
 * loads surfacing a distinct {@link CorruptSaveError}.
 *
 * Requirements: 12.1, 12.3, 12.4, 12.5, 12.6, 5.5
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  SaveManager,
  InMemorySlotStorage,
  SAVE_SLOTS,
  type SaveSlot,
} from '../SaveManager.js';
import { CorruptSaveError } from '../../codec/SaveFileCodec.js';
import type { CareerState } from '../../types/career.js';
import type { Loadout } from '../../types/car.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLoadout(): Loadout {
  return {
    chassisId: 'chassis-viper' as Loadout['chassisId'],
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
}

function makeCareer(overrides: Partial<CareerState> = {}): CareerState {
  return {
    saveSlot: 1,
    playerName: 'Ace',
    money: 5000,
    ownedComponents: [],
    ownedWeapons: [],
    currentCircuitIndex: 0,
    circuitNumber: 1,
    currentLoadout: makeLoadout(),
    totalEarnings: 12000,
    eliminationCount: 7,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Save / load round-trip
// ---------------------------------------------------------------------------

describe('SaveManager save/load round-trip', () => {
  it('loads back a career equal to the one saved', async () => {
    const mgr = new SaveManager(new InMemorySlotStorage());
    const career = makeCareer({
      saveSlot: 2,
      playerName: 'Menace',
      money: 42,
      ownedComponents: ['comp-engine-v8' as CareerState['ownedComponents'][number]],
      ownedWeapons: ['weapon-cannon' as CareerState['ownedWeapons'][number]],
      currentCircuitIndex: 5,
      circuitNumber: 3,
    });

    await mgr.save(career, 2);
    const loaded = await mgr.load(2);

    expect(loaded).toEqual(career);
  });

  it('normalises the persisted saveSlot to match the target slot', async () => {
    const mgr = new SaveManager(new InMemorySlotStorage());
    // Career claims slot 1 but we save it to slot 3.
    const career = makeCareer({ saveSlot: 1 });

    await mgr.save(career, 3);
    const loaded = await mgr.load(3);

    expect(loaded?.saveSlot).toBe(3);
  });

  it('overwrites an existing save in place', async () => {
    const mgr = new SaveManager(new InMemorySlotStorage());
    await mgr.save(makeCareer({ money: 100 }), 1);
    await mgr.save(makeCareer({ money: 999 }), 1);

    const loaded = await mgr.load(1);
    expect(loaded?.money).toBe(999);
  });

  it('keeps saves in different slots independent', async () => {
    const mgr = new SaveManager(new InMemorySlotStorage());
    await mgr.save(makeCareer({ playerName: 'One' }), 1);
    await mgr.save(makeCareer({ playerName: 'Two' }), 2);

    expect((await mgr.load(1))?.playerName).toBe('One');
    expect((await mgr.load(2))?.playerName).toBe('Two');
  });
});

// ---------------------------------------------------------------------------
// Missing slot
// ---------------------------------------------------------------------------

describe('SaveManager missing slots', () => {
  it('returns null when loading a slot that was never written', async () => {
    const mgr = new SaveManager(new InMemorySlotStorage());
    expect(await mgr.load(1)).toBeNull();
  });

  it('returns null after a slot is deleted', async () => {
    const mgr = new SaveManager(new InMemorySlotStorage());
    await mgr.save(makeCareer(), 2);
    await mgr.deleteSlot(2);
    expect(await mgr.load(2)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listSlots
// ---------------------------------------------------------------------------

describe('SaveManager.listSlots', () => {
  it('reports all three slots as empty for a fresh store', async () => {
    const mgr = new SaveManager(new InMemorySlotStorage());
    const infos = await mgr.listSlots();

    expect(infos).toHaveLength(3);
    expect(infos.map((i) => i.slot)).toEqual([1, 2, 3]);
    expect(infos.every((i) => i.exists === false)).toBe(true);
    expect(infos.every((i) => i.playerName === '' && i.totalEarnings === 0)).toBe(true);
  });

  it('reports occupied slots with player name and total earnings', async () => {
    const mgr = new SaveManager(new InMemorySlotStorage());
    await mgr.save(makeCareer({ playerName: 'Crimson', totalEarnings: 88000 }), 2);

    const infos = await mgr.listSlots();
    const slot2 = infos.find((i) => i.slot === 2)!;

    expect(slot2.exists).toBe(true);
    expect(slot2.playerName).toBe('Crimson');
    expect(slot2.totalEarnings).toBe(88000);

    // Untouched slots remain empty.
    expect(infos.find((i) => i.slot === 1)!.exists).toBe(false);
    expect(infos.find((i) => i.slot === 3)!.exists).toBe(false);
  });

  it('reports a corrupt slot as not-existing at the list level', async () => {
    const storage = new InMemorySlotStorage();
    const mgr = new SaveManager(storage);
    await mgr.save(makeCareer(), 1);

    // Corrupt the stored bytes by flipping a payload byte, breaking the CRC.
    const bytes = storage.read(1)!;
    const idx = bytes.length - 6;
    bytes[idx] = bytes[idx]! ^ 0xff;
    storage.write(1, bytes);
    storage.commit(1);

    const infos = await mgr.listSlots();
    expect(infos.find((i) => i.slot === 1)!.exists).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Corrupt-save handling
// ---------------------------------------------------------------------------

describe('SaveManager corrupt-save handling', () => {
  it('throws CorruptSaveError distinct from missing when bytes are damaged', async () => {
    const storage = new InMemorySlotStorage();
    const mgr = new SaveManager(storage);
    await mgr.save(makeCareer(), 1);

    // Flip a byte in the CRC-covered region to force a checksum mismatch.
    const bytes = storage.read(1)!;
    const idx = bytes.length - 6;
    bytes[idx] = bytes[idx]! ^ 0xff;
    storage.write(1, bytes);
    storage.commit(1);

    await expect(mgr.load(1)).rejects.toBeInstanceOf(CorruptSaveError);
    await expect(mgr.load(1)).rejects.toMatchObject({ reason: 'crc-mismatch' });
  });

  it('throws CorruptSaveError with bad-magic for foreign bytes', async () => {
    const storage = new InMemorySlotStorage();
    const mgr = new SaveManager(storage);
    // Enough bytes to pass the length guard, but wrong magic.
    storage.write(1, new Uint8Array(32));
    storage.commit(1);

    await expect(mgr.load(1)).rejects.toMatchObject({
      name: 'CorruptSaveError',
      reason: 'bad-magic',
    });
  });
});

// ---------------------------------------------------------------------------
// confirmOverwrite
// ---------------------------------------------------------------------------

describe('SaveManager.confirmOverwrite', () => {
  it('is false for an empty slot and true once occupied', async () => {
    const mgr = new SaveManager(new InMemorySlotStorage());
    expect(await mgr.confirmOverwrite(1)).toBe(false);

    await mgr.save(makeCareer(), 1);
    expect(await mgr.confirmOverwrite(1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Property: round-trip preserves persisted fields for any career
// ---------------------------------------------------------------------------

describe('SaveManager round-trip property', () => {
  const careerArb: fc.Arbitrary<CareerState> = fc.record({
    saveSlot: fc.constantFrom<SaveSlot>(...SAVE_SLOTS),
    playerName: fc.string({ minLength: 0, maxLength: 20 }),
    money: fc.nat({ max: 0xffffffff }),
    ownedComponents: fc.array(fc.string({ maxLength: 16 })),
    ownedWeapons: fc.array(fc.string({ maxLength: 16 })),
    currentCircuitIndex: fc.nat({ max: 9 }),
    circuitNumber: fc.nat({ max: 0xffffffff }),
    totalEarnings: fc.nat({ max: 0xffffffff }),
    eliminationCount: fc.nat({ max: 0xffffffff }),
  }).map((base) => ({
    ...base,
    ownedComponents: base.ownedComponents as CareerState['ownedComponents'],
    ownedWeapons: base.ownedWeapons as CareerState['ownedWeapons'],
    currentLoadout: makeLoadout(),
  }));

  it('load(save(career)) equals career (saveSlot normalised to target)', async () => {
    await fc.assert(
      fc.asyncProperty(careerArb, fc.constantFrom<SaveSlot>(...SAVE_SLOTS), async (career, slot) => {
        const mgr = new SaveManager(new InMemorySlotStorage());
        await mgr.save(career, slot);
        const loaded = await mgr.load(slot);
        expect(loaded).toEqual({ ...career, saveSlot: slot });
      }),
    );
  });
});
