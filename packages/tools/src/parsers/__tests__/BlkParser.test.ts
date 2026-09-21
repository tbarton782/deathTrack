/**
 * Unit tests for {@link parseBlk}.
 *
 * Requirements: 9.1, 2.6
 */

import { describe, it, expect } from 'vitest';
import { parseBlk, BlockParseError } from '../BlkParser.js';

interface BlockSpec {
  width: number;
  height: number;
  fill: (i: number) => number;
}

/** Build a valid `.BLK` buffer from an ordered list of block specs. */
function buildBlk(specs: BlockSpec[]): Buffer {
  const magic = Buffer.from('DBLK', 'ascii');
  const count = Buffer.alloc(2);
  count.writeUInt16LE(specs.length, 0);

  const tableSize = specs.length * 8;
  const table = Buffer.alloc(tableSize);
  const pixelBuffers: Buffer[] = [];

  let pixelOffset = magic.length + count.length + tableSize;
  specs.forEach((spec, i) => {
    const base = i * 8;
    table.writeUInt16LE(spec.width, base);
    table.writeUInt16LE(spec.height, base + 2);
    table.writeUInt32LE(pixelOffset, base + 4);

    const px = Buffer.alloc(spec.width * spec.height);
    for (let p = 0; p < px.length; p += 1) px[p] = spec.fill(p) & 0xff;
    pixelBuffers.push(px);
    pixelOffset += px.length;
  });

  return Buffer.concat([magic, count, table, ...pixelBuffers]);
}

describe('parseBlk', () => {
  it('parses multiple blocks with correct dimensions and pixels', () => {
    const buf = buildBlk([
      { width: 2, height: 2, fill: (i) => i },
      { width: 3, height: 1, fill: (i) => 100 + i },
    ]);
    const sheet = parseBlk(buf);

    expect(sheet.blocks).toHaveLength(2);

    const [a, b] = sheet.blocks;
    expect(a?.index).toBe(0);
    expect(a?.width).toBe(2);
    expect(a?.height).toBe(2);
    expect(Array.from(a?.pixels ?? [])).toEqual([0, 1, 2, 3]);

    expect(b?.index).toBe(1);
    expect(b?.width).toBe(3);
    expect(b?.height).toBe(1);
    expect(Array.from(b?.pixels ?? [])).toEqual([100, 101, 102]);
  });

  it('parses an empty sheet (zero blocks)', () => {
    const buf = buildBlk([]);
    const sheet = parseBlk(buf);
    expect(sheet.blocks).toHaveLength(0);
  });

  it('throws on bad magic with offset 0', () => {
    const buf = buildBlk([{ width: 1, height: 1, fill: () => 0 }]);
    buf.write('ZZZZ', 0, 'ascii');
    try {
      parseBlk(buf);
      expect.fail('expected BlockParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(BlockParseError);
      expect((err as BlockParseError).offset).toBe(0);
    }
  });

  it('throws when a block dimension is out of range', () => {
    const buf = buildBlk([{ width: 2, height: 2, fill: () => 0 }]);
    // Zero out the first block width (table starts at offset 6).
    buf.writeUInt16LE(0, 6);
    try {
      parseBlk(buf);
      expect.fail('expected BlockParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(BlockParseError);
      expect((err as BlockParseError).offset).toBe(6);
    }
  });

  it('throws when a block pixel range lies outside the file', () => {
    const buf = buildBlk([{ width: 2, height: 2, fill: () => 0 }]);
    // Corrupt the pixel offset (table entry offset field at 6 + 4 = 10).
    buf.writeUInt32LE(0xffff, 10);
    try {
      parseBlk(buf);
      expect.fail('expected BlockParseError');
    } catch (err) {
      expect(err).toBeInstanceOf(BlockParseError);
      expect((err as BlockParseError).offset).toBe(10);
    }
  });
});
