/**
 * Tests for the palette decoder, verified against the real Death Track
 * `ACTIVISI` file. The 256-colour VGA palette is not present in the accessible
 * data files; the game is 16-colour EGA, and its `EGA:` sub-block is a
 * logical -> hardware-colour remap table (reverse-engineered from ACTIVISI).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  decodePalContainer,
  decodeEgaRemapPalette,
  scale6to8,
  egaPalette16,
  PaletteDecodeError,
} from '../PaletteDecoder.js';

const DTRACK_DIR = 'C:\\Users\\tbart\\OneDrive\\1Projects\\Games\\dtrack';

describe('scale6to8', () => {
  it('maps the 6-bit VGA DAC range to 0..255', () => {
    expect(scale6to8(0)).toBe(0);
    expect(scale6to8(63)).toBe(255);
    expect(scale6to8(32)).toBe(Math.round((32 * 255) / 63));
  });
});

describe('decodeEgaRemapPalette (synthetic)', () => {
  it('resolves each logical entry through the remap to an EGA RGB colour', () => {
    // Build a synthetic EGA block: 2 bytes per entry, both nibbles equal.
    // logical 0 -> hw 0 (black), logical 1 -> hw 15 (white), logical 2 -> hw 4 (red)
    const hwForLogical = [0, 15, 4];
    const raw = new Uint8Array(hwForLogical.length * 2);
    hwForLogical.forEach((hw, i) => {
      const b = (hw << 4) | hw; // both nibbles equal
      raw[i * 2] = b;
      raw[i * 2 + 1] = b;
    });
    const pal = decodeEgaRemapPalette(raw);
    const ega = egaPalette16();
    expect(pal.count).toBe(16);
    // logical 0 -> black
    expect(Array.from(pal.rgb.subarray(0, 3))).toEqual([0, 0, 0]);
    // logical 1 -> hw 15 (white)
    expect(Array.from(pal.rgb.subarray(3, 6))).toEqual(
      Array.from(ega.rgb.subarray(15 * 3, 15 * 3 + 3)),
    );
    // logical 2 -> hw 4 (red)
    expect(Array.from(pal.rgb.subarray(6, 9))).toEqual(
      Array.from(ega.rgb.subarray(4 * 3, 4 * 3 + 3)),
    );
  });
});

describe('decodePalContainer against the real ACTIVISI file', () => {
  it('extracts an EGA remap palette (no VGA block present)', async () => {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await fs.readFile(path.join(DTRACK_DIR, 'ACTIVISI')));
    } catch {
      return; // real file absent; skip
    }
    const pal = decodePalContainer(bytes);
    // ACTIVISI carries EGA:/CGA: sub-blocks, not VGA:.
    expect(pal.vga).toBeUndefined();
    expect(pal.egaRaw).toBeDefined();
    expect(pal.egaRaw!.length).toBe(128);
    expect(pal.ega).toBeDefined();
    expect(pal.ega!.count).toBe(16);
    // The remap table's first entry is logical 0 -> hardware 0 -> black.
    expect(Array.from(pal.ega!.rgb.subarray(0, 3))).toEqual([0, 0, 0]);
    // The palette must contain more than one distinct colour.
    const distinct = new Set<string>();
    for (let i = 0; i < 16; i += 1) {
      distinct.add(`${pal.ega!.rgb[i * 3]},${pal.ega!.rgb[i * 3 + 1]},${pal.ega!.rgb[i * 3 + 2]}`);
    }
    expect(distinct.size).toBeGreaterThan(2);
  });

  it('throws PaletteDecodeError when a valid chunk tree has no PAL: container', () => {
    // A valid single leaf chunk "BIN:" with 0 length, but no PAL container.
    const leaf = new Uint8Array([
      0x42, 0x49, 0x4e, 0x3a, // "BIN:"
      0x00, 0x00, 0x00, 0x00, // length 0, not a container
    ]);
    expect(() => decodePalContainer(leaf)).toThrow(PaletteDecodeError);
  });
});
