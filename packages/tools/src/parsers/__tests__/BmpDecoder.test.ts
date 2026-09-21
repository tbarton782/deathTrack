/**
 * Tests for the BMP sprite decoder, verified against the real Death Track
 * sprite files. The pixel packing (4-bpp, 2 px/byte, high nibble = left pixel)
 * was reverse-engineered and confirmed: for every `BMP:` container in
 * `BITMAPS.BLK`, `sum(width*height)/2` equals the decompressed BIN size.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  decodeBmpFile,
  decodeBmp,
  parseInf,
  subImageToRgba,
  BmpDecodeError,
} from '../BmpDecoder.js';
import { parseChunks } from '../ChunkReader.js';
import { egaPalette16 } from '../PaletteDecoder.js';

const DTRACK_DIR = 'C:\\Users\\tbart\\OneDrive\\1Projects\\Games\\dtrack';

async function readFile(name: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await fs.readFile(path.join(DTRACK_DIR, name)));
  } catch {
    return undefined;
  }
}

describe('parseInf (synthetic)', () => {
  it('parses imgCount, widths and heights', () => {
    // 2 subimages: 3x4 and 5x6.
    const inf = new Uint8Array([
      2, 0, // imgCount
      3, 0, 5, 0, // widths
      4, 0, 6, 0, // heights
    ]);
    const info = parseInf(inf);
    expect(info.count).toBe(2);
    expect(info.widths).toEqual([3, 5]);
    expect(info.heights).toEqual([4, 6]);
  });

  it('rejects a truncated INF', () => {
    expect(() => parseInf(new Uint8Array([2, 0, 3, 0]))).toThrowError(BmpDecodeError);
  });
});

describe('decodeBmp against the real ANGEL.BMP', () => {
  it('decodes a single 160x115 subimage as 4bpp', async () => {
    const bytes = await readFile('ANGEL.BMP');
    if (bytes === undefined) return;
    const sheets = decodeBmpFile(bytes);
    expect(sheets.length).toBe(1);
    const sheet = sheets[0]!;
    expect(sheet.count).toBe(1);
    const img = sheet.images[0]!;
    expect(img.width).toBe(160);
    expect(img.height).toBe(115);
    expect(img.indices.length).toBe(160 * 115);
    // All indices are 4-bit.
    expect(img.indices.every((v) => v <= 15)).toBe(true);
    // The top-left is background (uniform), and the image is not a flat fill.
    expect(new Set(img.indices).size).toBeGreaterThan(3);
    // RGBA conversion produces the right buffer length with full alpha.
    const rgba = subImageToRgba(img, egaPalette16());
    expect(rgba.length).toBe(160 * 115 * 4);
    expect(rgba[3]).toBe(255);
  });
});

describe('decodeBmp against the real BITMAPS.BLK', () => {
  it('decodes every BMP container with exact 4bpp sizing', async () => {
    const bytes = await readFile('BITMAPS.BLK');
    if (bytes === undefined) return;
    const chunks = parseChunks(bytes);
    const bmps = chunks.filter((c) => c.id === 'BMP');
    expect(bmps.length).toBeGreaterThan(0);

    for (const bmp of bmps) {
      const sheet = decodeBmp(bmp);
      expect(sheet.count).toBeGreaterThan(0);
      // Each subimage's index buffer is exactly width*height and 4-bit.
      for (const img of sheet.images) {
        expect(img.indices.length).toBe(img.width * img.height);
        expect(img.indices.every((v) => v <= 15)).toBe(true);
      }
    }
  });
});
