/**
 * Unit tests for {@link parseScr}, {@link applyPalette}, and
 * {@link parseScrToRgba}.
 *
 * Requirements: 11.6
 */

import { describe, it, expect } from 'vitest';
import {
  parseScr,
  applyPalette,
  parseScrToRgba,
  ScreenParseError,
} from '../ScrParser.js';
import type { PaletteData } from '../PalParser.js';

/** Build a valid `.SCR` buffer with the given dimensions and pixel filler. */
function buildScr(width: number, height: number, fill: (i: number) => number): Buffer {
  const header = Buffer.alloc(8);
  header.write('DSCR', 0, 'ascii');
  header.writeUInt16LE(width, 4);
  header.writeUInt16LE(height, 6);
  const pixels = Buffer.alloc(width * height);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = fill(i) & 0xff;
  return Buffer.concat([header, pixels]);
}

/** Build a 256-colour palette from a per-index colour function. */
function buildPalette(colour: (index: number) => [number, number, number]): PaletteData {
  const rgb = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i += 1) {
    const [r, g, b] = colour(i);
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return { rgb, wasVga6Bit: false };
}

describe('parseScr', () => {
  it('parses a valid full-screen image and preserves dimensions and pixels', () => {
    const buf = buildScr(4, 3, (i) => i);
    const image = parseScr(buf);

    expect(image.width).toBe(4);
    expect(image.height).toBe(3);
    expect(image.pixels).toHaveLength(12);
    expect(Array.from(image.pixels)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('throws on bad magic with offset 0', () => {
    const buf = buildScr(2, 2, () => 0);
    buf.write('XXXX', 0, 'ascii');
    try {
      parseScr(buf);
      expect.fail('expected ScreenParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(ScreenParseError);
      expect((err as ScreenParseError).offset).toBe(0);
    }
  });

  it('throws when width is out of range with offset 4', () => {
    const buf = buildScr(1, 1, () => 0);
    buf.writeUInt16LE(0, 4); // width = 0
    try {
      parseScr(buf);
      expect.fail('expected ScreenParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(ScreenParseError);
      expect((err as ScreenParseError).offset).toBe(4);
    }
  });

  it('throws when height is out of range with offset 6', () => {
    const buf = buildScr(1, 1, () => 0);
    buf.writeUInt16LE(0, 6); // height = 0
    try {
      parseScr(buf);
      expect.fail('expected ScreenParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(ScreenParseError);
      expect((err as ScreenParseError).offset).toBe(6);
    }
  });

  it('throws when pixel data is truncated with offset 8', () => {
    const buf = buildScr(4, 4, () => 0).subarray(0, 8 + 5); // only 5 of 16 pixels
    try {
      parseScr(buf);
      expect.fail('expected ScreenParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(ScreenParseError);
      expect((err as ScreenParseError).offset).toBe(8);
    }
  });

  it('throws when file is shorter than the magic marker', () => {
    const buf = Buffer.from([0x44, 0x53]); // "DS"
    try {
      parseScr(buf);
      expect.fail('expected ScreenParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(ScreenParseError);
      expect((err as ScreenParseError).offset).toBe(0);
    }
  });
});

describe('applyPalette', () => {
  it('expands indices to opaque RGBA using the palette', () => {
    // Palette: index i -> (i, 2i mod 256, 3i mod 256).
    const palette = buildPalette((i) => [i, (2 * i) & 0xff, (3 * i) & 0xff]);
    const image = parseScr(buildScr(2, 2, (i) => [10, 20, 30, 40][i] ?? 0));

    const rgba = applyPalette(image, palette);

    expect(rgba).toBeInstanceOf(Uint8ClampedArray);
    expect(rgba).toHaveLength(2 * 2 * 4);

    // Pixel 0 -> palette index 10 -> (10, 20, 30, 255).
    expect(Array.from(rgba.subarray(0, 4))).toEqual([10, 20, 30, 255]);
    // Pixel 1 -> palette index 20 -> (20, 40, 60, 255).
    expect(Array.from(rgba.subarray(4, 8))).toEqual([20, 40, 60, 255]);
    // Pixel 3 -> palette index 40 -> (40, 80, 120, 255).
    expect(Array.from(rgba.subarray(12, 16))).toEqual([40, 80, 120, 255]);
  });

  it('sets alpha to 255 for every pixel', () => {
    const palette = buildPalette(() => [1, 2, 3]);
    const image = parseScr(buildScr(3, 3, () => 5));
    const rgba = applyPalette(image, palette);

    for (let i = 0; i < 9; i += 1) {
      expect(rgba[i * 4 + 3]).toBe(255);
    }
  });

  it('resolves the highest palette index (255) correctly', () => {
    const palette = buildPalette((i) => (i === 255 ? [7, 8, 9] : [0, 0, 0]));
    const image = parseScr(buildScr(1, 1, () => 255));
    const rgba = applyPalette(image, palette);

    expect(Array.from(rgba)).toEqual([7, 8, 9, 255]);
  });

  it('throws when the palette is too small to index every colour', () => {
    const smallPalette: PaletteData = { rgb: new Uint8Array(3 * 10), wasVga6Bit: false };
    const image = parseScr(buildScr(2, 2, () => 0));
    try {
      applyPalette(image, smallPalette);
      expect.fail('expected ScreenParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(ScreenParseError);
      expect((err as ScreenParseError).offset).toBe(0);
    }
  });
});

describe('parseScrToRgba', () => {
  it('parses and applies the palette in one call', () => {
    const palette = buildPalette((i) => [i, i, i]);
    const buf = buildScr(2, 1, (i) => [100, 200][i] ?? 0);

    const { image, rgba } = parseScrToRgba(buf, palette);

    expect(image.width).toBe(2);
    expect(image.height).toBe(1);
    expect(Array.from(rgba)).toEqual([100, 100, 100, 255, 200, 200, 200, 255]);
  });
});
