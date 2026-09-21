/**
 * Property test for network state snapshot codec round-trip consistency.
 *
 * Property 18: Network state snapshot round-trip preserves all synchronised
 * fields. For any valid {@link StateSnapshot}, encoding it with
 * {@link StateSnapshotCodec.encode} then decoding with
 * {@link StateSnapshotCodec.decode} produces a {@link StateSnapshot} whose every
 * synchronised field (per-car position, speed, heading, armor, ammo counts and
 * status flags, plus the `tick`, `serverTime` and `authorityChecksum` header
 * fields) equals the original within the codec's documented fixed-point
 * precision. The {@link CompressedCarState} values are already quantised, so the
 * round-trip is exact for them; `events` is out of scope for the codec and is
 * normalised to an empty array on decode.
 *
 * Validates: Requirements 8.7, 3.10
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  StateSnapshotCodec,
  STATE_SNAPSHOT_MAX_CARS,
} from '../StateSnapshotCodec.js';
import type { CompressedCarState, StateSnapshot } from '../../types/network.js';

/**
 * Generator for a single {@link CompressedCarState}. Each numeric field is
 * constrained to the exact integer range its fixed-point wire type can carry
 * (uint8 or uint16), so a value drawn here is always representable losslessly.
 */
const carArb: fc.Arbitrary<CompressedCarState> = fc.record({
  id: fc.integer({ min: 0, max: 7 }),
  x: fc.integer({ min: 0, max: 0xffff }),
  y: fc.integer({ min: 0, max: 0xffff }),
  heading: fc.integer({ min: 0, max: 0xff }),
  speed: fc.integer({ min: 0, max: 0xffff }),
  armor: fc.integer({ min: 0, max: 0xff }),
  flags: fc.integer({ min: 0, max: 0xff }),
  ammoForward: fc.integer({ min: 0, max: 0xff }),
  ammoRear: fc.integer({ min: 0, max: 0xff }),
});

/**
 * Generator for a full {@link StateSnapshot} with a valid 1–8 car array and
 * uint32 header fields. `events` is fixed to empty because the codec does not
 * serialise it (see {@link StateSnapshotCodec} docs).
 */
const snapshotArb: fc.Arbitrary<StateSnapshot> = fc.record({
  tick: fc.integer({ min: 0, max: 0xffff_ffff }),
  serverTime: fc.integer({ min: 0, max: 0xffff_ffff }),
  authorityChecksum: fc.integer({ min: 0, max: 0xffff_ffff }),
  cars: fc.array(carArb, { minLength: 1, maxLength: STATE_SNAPSHOT_MAX_CARS }),
  events: fc.constant([]),
});

describe('Property 18: StateSnapshot round-trip preserves all synchronised fields', () => {
  it('decode(encode(snapshot)) reproduces every synchronised header and car field (Validates: Requirements 8.7, 3.10)', () => {
    fc.assert(
      fc.property(snapshotArb, (snapshot) => {
        const decoded = StateSnapshotCodec.decode(StateSnapshotCodec.encode(snapshot));

        // Header fields survive the round-trip exactly.
        expect(decoded.tick).toBe(snapshot.tick);
        expect(decoded.serverTime).toBe(snapshot.serverTime);
        expect(decoded.authorityChecksum).toBe(snapshot.authorityChecksum);

        // Every synchronised per-car field (position, speed, heading, armor,
        // ammo counts, status flags) is preserved for every car, in order.
        expect(decoded.cars).toEqual(snapshot.cars);
        expect(decoded.cars).toHaveLength(snapshot.cars.length);

        // `events` is out of scope for the codec and is normalised to empty.
        expect(decoded.events).toEqual([]);
      }),
      { numRuns: 1000 },
    );
  });
});
