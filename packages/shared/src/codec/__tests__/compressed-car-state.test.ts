/**
 * Unit and property tests for {@link CompressedCarStateCodec}.
 *
 * Verifies the fixed-point wire layout: a single car encodes to exactly
 * 12 bytes in descriptor order, and the encode -> decode round-trip reproduces
 * a structurally identical {@link CompressedCarState} across arbitrary inputs.
 *
 * Requirements: 8.8
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  CompressedCarStateCodec,
  COMPRESSED_CAR_STATE_BYTES,
} from '../CompressedCarStateCodec.js';
import type { CompressedCarState } from '../../types/network.js';

describe('CompressedCarStateCodec layout', () => {
  it('encodes a car to exactly 12 bytes', () => {
    const car: CompressedCarState = {
      id: 3,
      x: 12345,
      y: 54321,
      heading: 200,
      speed: 6789,
      armor: 128,
      flags: 0b0000_0101,
      ammoForward: 12,
      ammoRear: 4,
    };
    expect(CompressedCarStateCodec.encode(car).byteLength).toBe(COMPRESSED_CAR_STATE_BYTES);
  });

  it('lays fields out in the documented little-endian order', () => {
    const car: CompressedCarState = {
      id: 1,
      x: 258, // 0x0102 -> LE bytes 02 01
      y: 0,
      heading: 0,
      speed: 0,
      armor: 0,
      flags: 0,
      ammoForward: 0,
      ammoRear: 0,
    };
    const bytes = CompressedCarStateCodec.encode(car);
    expect(bytes[0]).toBe(1); // id
    expect(bytes[1]).toBe(0x02); // x low byte
    expect(bytes[2]).toBe(0x01); // x high byte
  });

  it('round-trips a representative car state', () => {
    const car: CompressedCarState = {
      id: 7,
      x: 65535,
      y: 40000,
      heading: 255,
      speed: 65535,
      armor: 255,
      flags: 0b0000_0111,
      ammoForward: 255,
      ammoRear: 99,
    };
    expect(CompressedCarStateCodec.decode(CompressedCarStateCodec.encode(car))).toEqual(car);
  });

  it('round-trips a zeroed car state', () => {
    const car: CompressedCarState = {
      id: 0,
      x: 0,
      y: 0,
      heading: 0,
      speed: 0,
      armor: 0,
      flags: 0,
      ammoForward: 0,
      ammoRear: 0,
    };
    expect(CompressedCarStateCodec.decode(CompressedCarStateCodec.encode(car))).toEqual(car);
  });
});

describe('property: CompressedCarStateCodec round-trip and fixed size', () => {
  const arb = fc.record<CompressedCarState>({
    id: fc.integer({ min: 0, max: 7 }),
    x: fc.integer({ min: 0, max: 65535 }),
    y: fc.integer({ min: 0, max: 65535 }),
    heading: fc.integer({ min: 0, max: 255 }),
    speed: fc.integer({ min: 0, max: 65535 }),
    armor: fc.integer({ min: 0, max: 255 }),
    flags: fc.integer({ min: 0, max: 255 }),
    ammoForward: fc.integer({ min: 0, max: 255 }),
    ammoRear: fc.integer({ min: 0, max: 255 }),
  });

  it('reproduces a deeply-equal car and always encodes to 12 bytes', () => {
    fc.assert(
      fc.property(arb, (car) => {
        const encoded = CompressedCarStateCodec.encode(car);
        expect(encoded.byteLength).toBe(COMPRESSED_CAR_STATE_BYTES);
        expect(CompressedCarStateCodec.decode(encoded)).toEqual(car);
      }),
      { numRuns: 1000 },
    );
  });
});
