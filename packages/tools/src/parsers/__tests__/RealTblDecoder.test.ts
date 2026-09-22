/**
 * Tests for the real Death Track `.TBL` structure decoder.
 *
 * These synthesise `.TBL`-shaped buffers that mirror the layout documented in
 * `RealTblDecoder.ts` (header + a `0xffff`-terminated `uint16` offset table at
 * byte `0x1e` + record bytes), so the suite is hermetic and never depends on
 * the copyrighted original game files. The decoder itself was verified against
 * the 12 real per-car `.TBL` files (all decode with contiguous, in-bounds,
 * strictly-increasing offsets covering the file to EOF).
 *
 * Requirements: 4.1, 9.1, 9.5
 */

import { describe, it, expect } from 'vitest';

import {
  decodeRealTbl,
  summarizeRealTbl,
  RealTblDecodeError,
  TBL_OFFSET_TABLE_START,
  TBL_OFFSET_TABLE_TERMINATOR,
} from '../RealTblDecoder.js';

/**
 * Build a synthetic per-car `.TBL` buffer: a `headerLen`-byte header (with a
 * version word at 0 and a marker at 0x10), then a `0xffff`-terminated `uint16`
 * offset table at 0x1e, then record bytes so the offsets are in bounds. The
 * offsets are placed immediately after the table and each record is filled with
 * its (index+1) byte value so the slices are identifiable.
 */
function buildTbl(recordLengths: number[], opts: { versionWord?: number; marker?: number } = {}): Uint8Array {
  const tableEntries = recordLengths.length;
  const tableBytes = tableEntries * 2 + 2; // + 0xffff terminator
  const bodyStart = TBL_OFFSET_TABLE_START + tableBytes;

  // Compute offsets and total size.
  const offsets: number[] = [];
  let cursor = bodyStart;
  for (const len of recordLengths) {
    offsets.push(cursor);
    cursor += len;
  }
  const total = cursor;

  const buf = new Uint8Array(total);
  const view = new DataView(buf.buffer);
  view.setUint16(0, opts.versionWord ?? 0x0000, true);
  buf[0x10] = opts.marker ?? 0x3b;

  let p = TBL_OFFSET_TABLE_START;
  for (const off of offsets) {
    view.setUint16(p, off, true);
    p += 2;
  }
  view.setUint16(p, TBL_OFFSET_TABLE_TERMINATOR, true);

  // Fill each record with a recognisable byte pattern.
  offsets.forEach((off, i) => {
    for (let b = off; b < (i + 1 < offsets.length ? offsets[i + 1]! : total); b++) {
      buf[b] = (i + 1) & 0xff;
    }
  });

  return buf;
}

describe('decodeRealTbl', () => {
  it('decodes the header fields, offset table, and record slices', () => {
    const buf = buildTbl([16, 8, 40], { versionWord: 0x0000, marker: 0x3b });
    const tbl = decodeRealTbl(buf);

    expect(tbl.byteLength).toBe(buf.length);
    expect(tbl.versionWord).toBe(0x0000);
    expect(tbl.regionMarker).toBe(0x3b);
    expect(tbl.offsetTable).toHaveLength(3);
    expect(tbl.records).toHaveLength(3);

    // Records partition the body contiguously to EOF, no overlaps.
    expect(tbl.records[0]!.length).toBe(16);
    expect(tbl.records[1]!.length).toBe(8);
    expect(tbl.records[2]!.offset + tbl.records[2]!.length).toBe(buf.length);

    // Each record's bytes match its identifiable fill pattern.
    expect([...tbl.records[0]!.bytes].every((b) => b === 1)).toBe(true);
    expect([...tbl.records[1]!.bytes].every((b) => b === 2)).toBe(true);
    expect([...tbl.records[2]!.bytes].every((b) => b === 3)).toBe(true);
  });

  it('reads the offset table starting at byte 0x1e', () => {
    const buf = buildTbl([4, 4]);
    const tbl = decodeRealTbl(buf);
    // First record offset is right after the table + terminator.
    const expectedFirst = TBL_OFFSET_TABLE_START + 2 * 2 + 2;
    expect(tbl.offsetTable[0]).toBe(expectedFirst);
    expect(tbl.offsetTableEnd).toBe(expectedFirst);
  });

  it('exposes record bytes as views into the source (no copy)', () => {
    const buf = buildTbl([4]);
    const tbl = decodeRealTbl(buf);
    expect(tbl.records[0]!.bytes.buffer).toBe(buf.buffer);
  });

  it('throws on a buffer too short for a header + table', () => {
    expect(() => decodeRealTbl(new Uint8Array(4))).toThrowError(RealTblDecodeError);
  });

  it('throws when the offset table is not 0xffff-terminated', () => {
    // A table of increasing offsets that runs to EOF without a terminator.
    const buf = new Uint8Array(TBL_OFFSET_TABLE_START + 6);
    const view = new DataView(buf.buffer);
    view.setUint16(TBL_OFFSET_TABLE_START, 0x20, true);
    view.setUint16(TBL_OFFSET_TABLE_START + 2, 0x21, true);
    view.setUint16(TBL_OFFSET_TABLE_START + 4, 0x22, true);
    expect(() => decodeRealTbl(buf)).toThrowError(/not terminated by 0xffff/);
  });

  it('throws when an offset is out of bounds', () => {
    const buf = new Uint8Array(TBL_OFFSET_TABLE_START + 4);
    const view = new DataView(buf.buffer);
    view.setUint16(TBL_OFFSET_TABLE_START, 0x9999, true); // way past EOF
    view.setUint16(TBL_OFFSET_TABLE_START + 2, TBL_OFFSET_TABLE_TERMINATOR, true);
    expect(() => decodeRealTbl(buf)).toThrowError(/out of bounds/);
  });

  it('throws when offsets are not strictly increasing', () => {
    const buf = new Uint8Array(TBL_OFFSET_TABLE_START + 8 + 4);
    const view = new DataView(buf.buffer);
    view.setUint16(TBL_OFFSET_TABLE_START, 0x28, true);
    view.setUint16(TBL_OFFSET_TABLE_START + 2, 0x28, true); // not increasing
    view.setUint16(TBL_OFFSET_TABLE_START + 4, TBL_OFFSET_TABLE_TERMINATOR, true);
    expect(() => decodeRealTbl(buf)).toThrowError(/not strictly increasing/);
  });

  it('carries the failing byte offset on errors', () => {
    try {
      decodeRealTbl(new Uint8Array(2));
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(RealTblDecodeError);
      expect(typeof (err as RealTblDecodeError).offset).toBe('number');
    }
  });
});

describe('summarizeRealTbl', () => {
  it('produces a one-line summary with size, version, marker, and record count', () => {
    const buf = buildTbl([10, 10, 10], { versionWord: 0x0000, marker: 0x38 });
    const line = summarizeRealTbl('TEST.TBL', decodeRealTbl(buf));
    expect(line).toContain('TEST.TBL');
    expect(line).toContain('3 records');
    expect(line).toContain('version=0x0000');
    expect(line).toContain('marker=0x38');
  });
});
