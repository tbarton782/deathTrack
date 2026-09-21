/**
 * Integration test: career save/load round-trip through a real temp file.
 *
 * Constructs a `CareerState` populated with non-default values across every
 * persisted field, encodes it with `SaveFileCodec`, writes the bytes to a real
 * temp file on disk via `node:fs`, reads the bytes back, decodes them, and
 * asserts every persisted field survives the round-trip unchanged.
 *
 * This exercises the shared package as consumed from its BUILT dist
 * (`@deathtrack/shared`), covering the full on-disk framing (magic + version +
 * slot + career payload + CRC-32 trailer) against an actual filesystem, which
 * satisfies "save to a temp file, reload".
 *
 * Validates: Requirements 5.5, 12.4
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SaveFileCodec,
  SAVE_FILE_MAGIC,
  SAVE_FILE_VERSION,
  newCareer,
  type CareerState,
  type SaveFile,
} from '@deathtrack/shared';

/** Build a CareerState whose every persisted field diverges from the defaults. */
function buildPopulatedCareer(): CareerState {
  // Start from a fresh career, then override every field with a distinct,
  // non-default value so the round-trip proves each one is persisted.
  const base = newCareer(2, 'Razor-Kate', 5000);
  return {
    ...base,
    saveSlot: 2,
    playerName: 'Razor-Kate the 3rd',
    money: 137_425,
    ownedComponents: ['turbo_engine_mk2', 'race_brakes', 'sticky_tires', 'reinforced_armor'],
    ownedWeapons: ['machine_gun', 'mine', 'wheel_spike', 'ram'],
    currentCircuitIndex: 7,
    circuitNumber: 3,
    currentLoadout: {
      chassisId: 'crusher',
      components: {
        engine: 'turbo_engine_mk2',
        brakes: 'race_brakes',
        transmission: 'close_ratio_gearbox',
        tires: 'sticky_tires',
        airfoil: 'downforce_wing',
        armor: 'reinforced_armor',
      },
      weapons: {
        forward: 'machine_gun',
        rear: 'mine',
        side_spike: 'wheel_spike',
        ram: 'ram',
      },
    },
    totalEarnings: 987_654,
    eliminationCount: 42,
  };
}

describe('career save/load round-trip via temp file', () => {
  let tempDir: string;
  let savePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'deathtrack-save-'));
    savePath = join(tempDir, 'slot2.dtsave');
  });

  afterEach(() => {
    // Remove the whole temp dir (and any files inside) regardless of outcome.
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists every CareerState field through encode -> temp file -> decode', () => {
    const original = buildPopulatedCareer();

    const file: SaveFile = {
      magic: SAVE_FILE_MAGIC,
      version: SAVE_FILE_VERSION,
      slot: original.saveSlot,
      career: original,
      crc32: 0, // recomputed by the codec on encode
    };

    // Save: encode to bytes and write them to a real file on disk.
    const encoded = SaveFileCodec.encode(file);
    writeFileSync(savePath, encoded);

    // Reload: read the raw bytes back off disk and decode them.
    const reloadedBytes = readFileSync(savePath);
    const decoded = SaveFileCodec.decode(
      new Uint8Array(reloadedBytes.buffer, reloadedBytes.byteOffset, reloadedBytes.byteLength),
    );

    // Whole-object deep equality across all persisted career fields.
    expect(decoded.career).toEqual(original);

    // Explicit per-field assertions so a regression names the offending field.
    const c = decoded.career;
    expect(c.saveSlot).toBe(original.saveSlot);
    expect(c.playerName).toBe(original.playerName);
    expect(c.money).toBe(original.money);
    expect(c.ownedComponents).toEqual(original.ownedComponents);
    expect(c.ownedWeapons).toEqual(original.ownedWeapons);
    expect(c.currentCircuitIndex).toBe(original.currentCircuitIndex);
    expect(c.circuitNumber).toBe(original.circuitNumber);
    expect(c.currentLoadout).toEqual(original.currentLoadout);
    expect(c.totalEarnings).toBe(original.totalEarnings);
    expect(c.eliminationCount).toBe(original.eliminationCount);

    // File-frame fields survive too.
    expect(decoded.magic).toBe(SAVE_FILE_MAGIC);
    expect(decoded.version).toBe(SAVE_FILE_VERSION);
    expect(decoded.slot).toBe(original.saveSlot);
  });
});
