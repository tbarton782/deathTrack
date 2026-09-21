/**
 * Unit tests for {@link parsePalette}.
 *
 * Requirements: 2.6, 9.1
 */

import { describe, it, expect } from 'vitest';
import {
  parsePalette,
  PaletteParseError,
  RAW_PALETTE_BYTE_LENGTH,
  PALETTE_ENTRY_COUNT,
} from '../PalParser.js';

/** Build a raw 768-byte palette buffer from a per-index colour function. */
function buildRawPalette(colour: (index: number) => [number, number, number]): Buffer {
  const buf = Buffer.alloc(RAW_PALETTE_BYTE_LENGTH);
  for (let i = 0; i < PALETTE_ENTRY_COUNT; i += 1) {
    const [r, g, b] = colour(i);
    buf[i * 3] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  }
  return buf;
}

describe('parsePalette', () => {
  it('parses a raw 8-bit palette without scaling', () => {
    const buf = buildRawPalette((i) => [i, 255 - i, 128]);
    const { rgb, wasVga6Bit } = parsePalette(buf);

    expect(rgb).toHaveLength(RAW_PALETTE_BYTE_LENGTH);
    expect(wasVga6Bit).toBe(false);
    expect(rgb[0]).toBe(0);
    expect(rgb[1]).toBe(255);
    expect(rgb[2]).toBe(128);
    expect(rgb[255 * 3]).toBe(255);
  });

  it('detects and scales a 6-bit VGA palette to 8-bit', () => {
    // All channels ≤ 63 => treated as VGA 6-bit.
    const buf = buildRawPalette(() => [63, 0, 31]);
    const { rgb, wasVga6Bit } = parsePalette(buf);

    expect(wasVga6Bit).toBe(true);
    expect(rgb[0]).toBe(255); // 63 scales to 255
    expect(rgb[1]).toBe(0); // 0 stays 0
    // 31 -> (31<<2)|(31>>4) = 124 | 1 = 125
    expect(rgb[2]).toBe(125);
  });

  it('parses a headed "PALS" palette', () => {
    const body = buildRawPalette((i) => [i, i, i]);
    const buf = Buffer.concat([Buffer.from('PALS', 'ascii'), body]);
    const { rgb, wasVga6Bit } = parsePalette(buf);

    // 0..255 range exceeds 63 so not treated as VGA.
    expect(wasVga6Bit).toBe(false);
    expect(rgb[10 * 3]).toBe(10);
  });

  it('throws PaletteParseError with offset when too short', () => {
    const buf = Buffer.alloc(100);
    expect(() => parsePalette(buf)).toThrow(PaletteParseError);
    try {
      parsePalette(buf);
    } catch (err) {
      expect(err).toBeInstanceOf(PaletteParseError);
      expect((err as PaletteParseError).offset).toBe(0);
    }
  });

  it('reports the header offset when a headed file is truncated', () => {
    // "PALS" magic recognised but body short.
    const buf = Buffer.concat([Buffer.from('PALS', 'ascii'), Buffer.alloc(10)]);
    try {
      parsePalette(buf);
      expect.fail('expected PaletteParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(PaletteParseError);
      expect((err as PaletteParseError).offset).toBe(4);
    }
  });
});
