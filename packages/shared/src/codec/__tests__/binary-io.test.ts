/**
 * Unit and property tests for BinaryWriter / BinaryReader.
 *
 * Verifies primitive round-trips, fixed-length string padding/trimming, nested
 * struct read/write, buffer growth, and bounds checking.
 *
 * Requirements: 8.7, 12.4
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { BinaryWriter } from '../BinaryWriter.js';
import { BinaryReader } from '../BinaryReader.js';

describe('BinaryWriter / BinaryReader primitives', () => {
  it('round-trips each fixed-width primitive at its boundaries', () => {
    const w = new BinaryWriter();
    w.uint8(0).uint8(255);
    w.uint16(0).uint16(65535);
    w.int16(-32768).int16(32767);
    w.uint32(0).uint32(0xffff_ffff);
    w.int32(-2147483648).int32(2147483647);
    w.float32(1.5).float64(-3.141592653589793);

    const r = new BinaryReader(w.toUint8Array());
    expect(r.uint8()).toBe(0);
    expect(r.uint8()).toBe(255);
    expect(r.uint16()).toBe(0);
    expect(r.uint16()).toBe(65535);
    expect(r.int16()).toBe(-32768);
    expect(r.int16()).toBe(32767);
    expect(r.uint32()).toBe(0);
    expect(r.uint32()).toBe(0xffff_ffff);
    expect(r.int32()).toBe(-2147483648);
    expect(r.int32()).toBe(2147483647);
    expect(r.float32()).toBeCloseTo(1.5, 5);
    expect(r.float64()).toBe(-3.141592653589793);
    expect(r.atEnd).toBe(true);
  });

  it('writes little-endian byte order for uint32', () => {
    const w = new BinaryWriter();
    w.uint32(0x4454_5241); // 'DTRA'
    const bytes = w.toUint8Array();
    expect(Array.from(bytes)).toEqual([0x41, 0x52, 0x54, 0x44]);
  });

  it('grows the backing buffer beyond its initial capacity', () => {
    const w = new BinaryWriter(4);
    for (let i = 0; i < 100; i += 1) {
      w.uint32(i);
    }
    const r = new BinaryReader(w.toUint8Array());
    for (let i = 0; i < 100; i += 1) {
      expect(r.uint32()).toBe(i);
    }
  });
});

describe('fixed-length strings', () => {
  it('pads short strings and trims padding on read', () => {
    const w = new BinaryWriter();
    w.fixedString('hi', 8);
    expect(w.length).toBe(8);
    const r = new BinaryReader(w.toUint8Array());
    expect(r.fixedString(8)).toBe('hi');
  });

  it('round-trips a string that exactly fills the field', () => {
    const w = new BinaryWriter();
    w.fixedString('abcd', 4);
    const r = new BinaryReader(w.toUint8Array());
    expect(r.fixedString(4)).toBe('abcd');
  });

  it('rejects strings whose encoding exceeds the field width', () => {
    const w = new BinaryWriter();
    expect(() => w.fixedString('toolong', 4)).toThrow(RangeError);
  });

  it('handles multi-byte UTF-8 characters within the field', () => {
    const w = new BinaryWriter();
    // 'é' is 2 bytes in UTF-8
    w.fixedString('é', 4);
    const r = new BinaryReader(w.toUint8Array());
    expect(r.fixedString(4)).toBe('é');
  });
});

describe('nested struct read/write', () => {
  interface Vec2 {
    x: number;
    y: number;
  }

  const writeVec = (w: BinaryWriter, v: Vec2): void => {
    w.struct((ww) => {
      ww.float32(v.x);
      ww.float32(v.y);
    });
  };
  const readVec = (r: BinaryReader): Vec2 =>
    r.struct((rr) => ({ x: rr.float32(), y: rr.float32() }));

  it('encodes and decodes a nested struct inline', () => {
    const w = new BinaryWriter();
    w.uint8(7);
    writeVec(w, { x: 1.25, y: -2.5 });
    w.uint8(9);

    const r = new BinaryReader(w.toUint8Array());
    expect(r.uint8()).toBe(7);
    const vec = readVec(r);
    expect(vec.x).toBeCloseTo(1.25, 5);
    expect(vec.y).toBeCloseTo(-2.5, 5);
    expect(r.uint8()).toBe(9);
  });
});

describe('bounds checking', () => {
  it('throws when reading past the end of the buffer', () => {
    const w = new BinaryWriter();
    w.uint8(1);
    const r = new BinaryReader(w.toUint8Array());
    expect(r.uint8()).toBe(1);
    expect(() => r.uint32()).toThrow(RangeError);
  });
});

describe('property: primitive sequences round-trip', () => {
  it('preserves an arbitrary sequence of typed writes', () => {
    type Op =
      | { t: 'uint8'; v: number }
      | { t: 'uint16'; v: number }
      | { t: 'int16'; v: number }
      | { t: 'uint32'; v: number }
      | { t: 'int32'; v: number }
      | { t: 'float64'; v: number };

    const opArb: fc.Arbitrary<Op> = fc.oneof(
      fc.integer({ min: 0, max: 255 }).map((v) => ({ t: 'uint8', v }) as const),
      fc.integer({ min: 0, max: 65535 }).map((v) => ({ t: 'uint16', v }) as const),
      fc.integer({ min: -32768, max: 32767 }).map((v) => ({ t: 'int16', v }) as const),
      fc.integer({ min: 0, max: 0xffff_ffff }).map((v) => ({ t: 'uint32', v }) as const),
      fc
        .integer({ min: -2147483648, max: 2147483647 })
        .map((v) => ({ t: 'int32', v }) as const),
      fc
        .double({ noNaN: true, noDefaultInfinity: true })
        .map((v) => ({ t: 'float64', v }) as const),
    );

    fc.assert(
      fc.property(fc.array(opArb, { maxLength: 200 }), (ops) => {
        const w = new BinaryWriter();
        for (const op of ops) {
          w[op.t](op.v);
        }
        const r = new BinaryReader(w.toUint8Array());
        for (const op of ops) {
          expect(r[op.t]()).toBe(op.v);
        }
        expect(r.atEnd).toBe(true);
      }),
      { numRuns: 1000 },
    );
  });

  it('preserves fixed-length strings that fit their field', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 16 }), (s) => {
        const byteLength = 64; // generous field so UTF-8 always fits
        const w = new BinaryWriter();
        w.fixedString(s, byteLength);
        const r = new BinaryReader(w.toUint8Array());
        // NUL characters cannot survive trailing-NUL trimming; skip those.
        fc.pre(!s.includes('\u0000'));
        expect(r.fixedString(byteLength)).toBe(s);
      }),
      { numRuns: 500 },
    );
  });
});
