/**
 * Tests for the FNT font decoder, verified against the real Death Track
 * `FONTS.BLK`. The format (4-byte header + fixed-width 1bpp glyphs, MSB = left
 * pixel) was reverse-engineered by rendering glyphs; these tests lock in the
 * header parse, glyph geometry, and specific letterforms.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  decodeFnt,
  decodeFonts,
  glyphForCode,
  FntDecodeError,
  FNT_HEADER_SIZE,
} from '../FntDecoder.js';

const DTRACK_DIR = 'C:\\Users\\tbart\\OneDrive\\1Projects\\Games\\dtrack';

/** Render a glyph to lines of '#'/'.' for readable assertions. */
function glyphArt(glyph: { width: number; height: number; pixels: Uint8Array }): string[] {
  const lines: string[] = [];
  for (let y = 0; y < glyph.height; y += 1) {
    let line = '';
    for (let x = 0; x < glyph.width; x += 1) {
      line += glyph.pixels[y * glyph.width + x] ? '#' : '.';
    }
    lines.push(line);
  }
  return lines;
}

describe('decodeFnt (synthetic)', () => {
  it('parses the 4-byte header and reads MSB-left 1bpp glyphs', () => {
    // 8x2 font, 1 glyph starting at 'A' (0x41).
    // row0 = 0b10000001 (# at col0 and col7), row1 = 0b00011000 (# at col3,4)
    const data = new Uint8Array([8, 2, 0x41, 1, 0b10000001, 0b00011000]);
    const font = decodeFnt(data);
    expect(font.width).toBe(8);
    expect(font.height).toBe(2);
    expect(font.startSymbol).toBe(0x41);
    expect(font.count).toBe(1);
    const glyph = glyphForCode(font, 0x41)!;
    expect(glyphArt(glyph)).toEqual(['#......#', '...##...']);
  });

  it('rejects a chunk shorter than the header', () => {
    expect(() => decodeFnt(new Uint8Array([1, 2]))).toThrowError(FntDecodeError);
  });

  it('rejects truncated glyph data', () => {
    // Declares 4 glyphs of height 3 but supplies none.
    const data = new Uint8Array([8, 3, 0x20, 4]);
    expect(() => decodeFnt(data)).toThrowError(FntDecodeError);
  });

  it('has the expected header size constant', () => {
    expect(FNT_HEADER_SIZE).toBe(4);
  });
});

describe('decodeFonts against the real FONTS.BLK', () => {
  it('decodes three fixed-width fonts with readable letterforms', async () => {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await fs.readFile(path.join(DTRACK_DIR, 'FONTS.BLK')));
    } catch {
      return; // real file absent; skip
    }
    const fonts = decodeFonts(bytes);
    expect(fonts.length).toBe(3);

    // Expected nominal cell sizes and glyph range (0x20 space .. 96 glyphs).
    const sizes = fonts.map((f) => `${f.width}x${f.height}`);
    expect(sizes).toEqual(['4x5', '6x6', '8x8']);
    for (const f of fonts) {
      expect(f.startSymbol).toBe(0x20);
      expect(f.count).toBe(96);
      expect(f.glyphs.length).toBe(96);
      // Space (0x20) must be blank.
      const space = glyphForCode(f, 0x20)!;
      expect(space.pixels.every((p) => p === 0)).toBe(true);
    }

    // The 8x8 'H' should be two vertical strokes joined by a middle crossbar.
    const big = fonts[2]!;
    const h = glyphForCode(big, 0x48)!;
    const art = glyphArt(h);
    // Find the two stroke columns from the top row (it has exactly two set pixels).
    const topSetCols = [...art[0]!].flatMap((c, i) => (c === '#' ? [i] : []));
    expect(topSetCols.length).toBe(2);
    const [leftCol, rightCol] = topSetCols as [number, number];
    expect(rightCol - leftCol).toBeGreaterThan(1);
    // The two stroke columns are set on most rows (the verticals run nearly the
    // full height; the very last row may be blank).
    const bothStrokeRows = art.filter(
      (row) => row[leftCol] === '#' && row[rightCol] === '#',
    ).length;
    expect(bothStrokeRows).toBeGreaterThanOrEqual(big.height - 1);
    // Some middle row fills the gap between the strokes (the crossbar).
    expect(
      art.some((row) => {
        for (let c = leftCol; c <= rightCol; c += 1) if (row[c] !== '#') return false;
        return true;
      }),
    ).toBe(true);
  });

  it('looks up glyphs by code and returns undefined out of range', async () => {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await fs.readFile(path.join(DTRACK_DIR, 'FONTS.BLK')));
    } catch {
      return;
    }
    const font = decodeFonts(bytes)[0]!;
    expect(glyphForCode(font, 0x1f)).toBeUndefined(); // before startSymbol
    expect(glyphForCode(font, 0x41)).toBeDefined(); // 'A'
    expect(glyphForCode(font, 0x20 + 96)).toBeUndefined(); // past the last glyph
  });
});
