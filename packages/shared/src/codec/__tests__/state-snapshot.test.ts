/**
 * Unit and property tests for {@link StateSnapshotCodec}.
 *
 * Verifies the snapshot wire layout: a fixed 12-byte header (`tick`,
 * `serverTime`, `authorityChecksum`) followed by a length-prefixed array of up
 * to 8 {@link CompressedCarState} entries; that the encode -> decode round-trip
 * reproduces the synchronised header and car fields; and that every encoded
 * snapshot with 1–8 cars stays within the 512-byte packet cap.
 *
 * Requirements: 8.7, 8.8
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  StateSnapshotCodec,
  STATE_SNAPSHOT_HEADER_BYTES,
  STATE_SNAPSHOT_MAX_CARS,
  STATE_SNAPSHOT_MAX_BYTES,
  STATE_SNAPSHOT_PACKET_CAP_BYTES,
} from '../StateSnapshotCodec.js';
import { COMPRESSED_CAR_STATE_BYTES } from '../CompressedCarStateCodec.js';
import type { CompressedCarState, StateSnapshot } from '../../types/network.js';

const carArb = fc.record<CompressedCarState>({
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

function makeCar(id: number): CompressedCarState {
  return {
    id,
    x: 1000 + id,
    y: 2000 + id,
    heading: id * 10,
    speed: 500 + id,
    armor: 200 - id,
    flags: id & 0x07,
    ammoForward: id,
    ammoRear: 7 - id,
  };
}

describe('StateSnapshotCodec layout', () => {
  it('encodes the header then a uint16 car count in little-endian order', () => {
    const snapshot: StateSnapshot = {
      tick: 0x0102_0304,
      serverTime: 0x0A0B_0C0D,
      authorityChecksum: 0xDEAD_BEEF,
      cars: [makeCar(0), makeCar(1)],
      events: [],
    };
    const bytes = StateSnapshotCodec.encode(snapshot);

    // tick (uint32 LE) = 04 03 02 01
    expect(Array.from(bytes.subarray(0, 4))).toEqual([0x04, 0x03, 0x02, 0x01]);
    // serverTime (uint32 LE) = 0D 0C 0B 0A
    expect(Array.from(bytes.subarray(4, 8))).toEqual([0x0D, 0x0C, 0x0B, 0x0A]);
    // authorityChecksum (uint32 LE) = EF BE AD DE
    expect(Array.from(bytes.subarray(8, 12))).toEqual([0xEF, 0xBE, 0xAD, 0xDE]);
    // cars count (uint16 LE) = 02 00
    expect(Array.from(bytes.subarray(12, 14))).toEqual([0x02, 0x00]);
  });

  it('encodes header + prefix + 12 bytes per car', () => {
    const snapshot: StateSnapshot = {
      tick: 1,
      serverTime: 2,
      authorityChecksum: 3,
      cars: [makeCar(0), makeCar(1), makeCar(2)],
      events: [],
    };
    const expected = STATE_SNAPSHOT_HEADER_BYTES + 2 + 3 * COMPRESSED_CAR_STATE_BYTES;
    expect(StateSnapshotCodec.encode(snapshot).byteLength).toBe(expected);
  });

  it('round-trips header and cars, normalising events to an empty array', () => {
    const snapshot: StateSnapshot = {
      tick: 123456,
      serverTime: 987654,
      authorityChecksum: 0xFFFF_FFFF,
      cars: [makeCar(0), makeCar(3), makeCar(7)],
      events: [],
    };
    const decoded = StateSnapshotCodec.decode(StateSnapshotCodec.encode(snapshot));
    expect(decoded.tick).toBe(snapshot.tick);
    expect(decoded.serverTime).toBe(snapshot.serverTime);
    expect(decoded.authorityChecksum).toBe(snapshot.authorityChecksum);
    expect(decoded.cars).toEqual(snapshot.cars);
    expect(decoded.events).toEqual([]);
  });

  it('round-trips a single-car snapshot', () => {
    const snapshot: StateSnapshot = {
      tick: 0,
      serverTime: 0,
      authorityChecksum: 0,
      cars: [makeCar(0)],
      events: [],
    };
    expect(StateSnapshotCodec.decode(StateSnapshotCodec.encode(snapshot)).cars).toEqual(
      snapshot.cars,
    );
  });

  it('the worst-case 8-car snapshot fits within the 512-byte cap', () => {
    const cars = Array.from({ length: STATE_SNAPSHOT_MAX_CARS }, (_, i) => makeCar(i));
    const snapshot: StateSnapshot = {
      tick: 0xFFFF_FFFF,
      serverTime: 0xFFFF_FFFF,
      authorityChecksum: 0xFFFF_FFFF,
      cars,
      events: [],
    };
    const size = StateSnapshotCodec.encode(snapshot).byteLength;
    expect(size).toBe(STATE_SNAPSHOT_MAX_BYTES);
    expect(size).toBeLessThanOrEqual(STATE_SNAPSHOT_PACKET_CAP_BYTES);
  });
});

describe('property: StateSnapshotCodec round-trip and size cap', () => {
  const snapshotArb = fc.record({
    tick: fc.integer({ min: 0, max: 0xFFFF_FFFF }),
    serverTime: fc.integer({ min: 0, max: 0xFFFF_FFFF }),
    authorityChecksum: fc.integer({ min: 0, max: 0xFFFF_FFFF }),
    cars: fc.array(carArb, { minLength: 1, maxLength: STATE_SNAPSHOT_MAX_CARS }),
  });

  it('reproduces header + cars and stays within the 512-byte cap for 1–8 cars', () => {
    fc.assert(
      fc.property(snapshotArb, (parts) => {
        const snapshot: StateSnapshot = { ...parts, events: [] };
        const encoded = StateSnapshotCodec.encode(snapshot);

        // Property 19: packet size cap (Requirements: 8.8).
        expect(encoded.byteLength).toBeLessThanOrEqual(STATE_SNAPSHOT_PACKET_CAP_BYTES);

        // Property 18: synchronised-field round-trip (Requirements: 8.7).
        const decoded = StateSnapshotCodec.decode(encoded);
        expect(decoded.tick).toBe(snapshot.tick);
        expect(decoded.serverTime).toBe(snapshot.serverTime);
        expect(decoded.authorityChecksum).toBe(snapshot.authorityChecksum);
        expect(decoded.cars).toEqual(snapshot.cars);
        expect(decoded.events).toEqual([]);
      }),
      { numRuns: 1000 },
    );
  });
});
