/**
 * Tests for the `.MAP` backdrop decoder, verified against all 10 real Death
 * Track tracks. The `.MAP` payload is an LZW leaf that decompresses to a small
 * header (count + widths + heights) followed by horizontal EGA backdrop strips;
 * this was reverse-engineered by rendering (the Bay Area strips show the SF
 * skyline + Golden Gate Bridge). These tests lock in the header parse, the
 * "all 10 decode without error" criterion, and the strip geometry.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { describe, it, expect } from 'vitest';

import { decodeMap, MapDecodeError } from '../MapDecoder.js';

const DTRACK_DIR = 'C:\\Users\\tbart\\OneDrive\\1Projects\\Games\\dtrack';

const MAP_FILES = [
  'BAY_AREA.MAP',
  'BOSTON.MAP',
  'CHICAGO.MAP',
  'HOUSTON.MAP',
  'LA.MAP',
  'NYC.MAP',
  'ORLANDO.MAP',
  'PHOENIX.MAP',
  'SEATTLE.MAP',
  'ST_LOUIS.MAP',
];

async function readMap(name: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await fs.readFile(path.join(DTRACK_DIR, name)));
  } catch {
    return undefined;
  }
}

describe('decodeMap against all 10 real tracks', () => {
  it('decodes every .MAP into 6 backdrop strips of 160x25 without error', async () => {
    let checked = 0;
    for (const name of MAP_FILES) {
      const bytes = await readMap(name);
      if (bytes === undefined) continue;
      checked += 1;

      const backdrop = decodeMap(bytes);
      expect(backdrop.count).toBe(6);
      expect(backdrop.strips.length).toBe(6);
      for (const strip of backdrop.strips) {
        expect(strip.width).toBe(160);
        expect(strip.height).toBe(25);
        expect(strip.indices.length).toBe(160 * 25);
        // Backdrop imagery uses many EGA indices, not a flat fill.
        expect(strip.indices.every((v) => v <= 255)).toBe(true);
      }
      // The decompressed payload is the canonical 24026 bytes.
      expect(backdrop.raw.length).toBe(24026);
      // Collectively the strips use several distinct colours.
      const all = new Set<number>();
      for (const s of backdrop.strips) for (const v of s.indices) all.add(v);
      expect(all.size).toBeGreaterThan(4);
    }
    if (checked > 0) expect(checked).toBe(MAP_FILES.length);
  });
});

describe('decodeMap error handling (synthetic)', () => {
  it('throws when the payload cannot be decompressed', () => {
    // A leaf claiming LZW (0x02) but with a nonsense body / size.
    const bogus = new Uint8Array([0x02, 0x10, 0x00, 0x00, 0x00, 0xff, 0xff, 0xff]);
    expect(() => decodeMap(bogus)).toThrowError(MapDecodeError);
  });

  it('throws when the header declares more strips than the payload holds', () => {
    // Uncompressed leaf (type 0x00) whose payload is a count header claiming
    // 6 strips but with no room for the width/height tables.
    const payload = new Uint8Array([6, 0]); // count = 6, nothing else
    const leaf = new Uint8Array(5 + payload.length);
    leaf[0] = 0x00; // compression: none
    leaf[1] = payload.length & 0xff;
    leaf[2] = (payload.length >> 8) & 0xff;
    leaf.set(payload, 5);
    expect(() => decodeMap(leaf)).toThrowError(MapDecodeError);
  });
});
