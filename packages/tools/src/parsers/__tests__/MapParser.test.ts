/**
 * Unit tests for {@link parseMap}.
 *
 * Requirements: 9.1, 2.6
 */

import { describe, it, expect } from 'vitest';
import { parseMap, MapParseError } from '../MapParser.js';

/** Build a valid `.MAP` buffer with the given dimensions and pixel filler. */
function buildMap(width: number, height: number, fill: (i: number) => number): Buffer {
  const header = Buffer.alloc(8);
  header.write('DMAP', 0, 'ascii');
  header.writeUInt16LE(width, 4);
  header.writeUInt16LE(height, 6);
  const pixels = Buffer.alloc(width * height);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = fill(i) & 0xff;
  return Buffer.concat([header, pixels]);
}

describe('parseMap', () => {
  it('parses a valid minimap and preserves dimensions and pixels', () => {
    const buf = buildMap(4, 3, (i) => i);
    const map = parseMap(buf);

    expect(map.width).toBe(4);
    expect(map.height).toBe(3);
    expect(map.pixels).toHaveLength(12);
    expect(Array.from(map.pixels)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('throws on bad magic with offset 0', () => {
    const buf = buildMap(2, 2, () => 0);
    buf.write('XXXX', 0, 'ascii');
    try {
      parseMap(buf);
      expect.fail('expected MapParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(MapParseError);
      expect((err as MapParseError).offset).toBe(0);
    }
  });

  it('throws when width is out of range', () => {
    const buf = buildMap(1, 1, () => 0);
    buf.writeUInt16LE(0, 4); // width = 0
    try {
      parseMap(buf);
      expect.fail('expected MapParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(MapParseError);
      expect((err as MapParseError).offset).toBe(4);
    }
  });

  it('throws when pixel data is truncated', () => {
    const buf = buildMap(4, 4, () => 0).subarray(0, 8 + 5); // only 5 of 16 pixels
    try {
      parseMap(buf);
      expect.fail('expected MapParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(MapParseError);
      expect((err as MapParseError).offset).toBe(8);
    }
  });
});
