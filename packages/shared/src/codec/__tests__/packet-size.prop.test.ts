/**
 * Property test for the state-snapshot packet size cap.
 *
 * Property 19: Encoded state packets fit within the 512-byte size cap.
 * For any {@link StateSnapshot} with 1 to 8 participants, the total byte length
 * of the encoded packet produced by {@link StateSnapshotCodec.encode} is at most
 * 512 bytes.
 *
 * Validates: Requirements 8.8
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  StateSnapshotCodec,
  STATE_SNAPSHOT_MAX_CARS,
  STATE_SNAPSHOT_PACKET_CAP_BYTES,
} from '../StateSnapshotCodec.js';
import type { CompressedCarState, StateSnapshot } from '../../types/network.js';

/** Arbitrary for a single fully-ranged {@link CompressedCarState}. */
const carArb: fc.Arbitrary<CompressedCarState> = fc.record({
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

/**
 * Arbitrary for a {@link StateSnapshot} carrying 1..8 cars with fully-ranged
 * uint32 header fields. `events` is out of scope for the codec (encoded
 * separately) and is fixed to an empty array.
 */
const snapshotArb: fc.Arbitrary<StateSnapshot> = fc.record({
  tick: fc.integer({ min: 0, max: 0xffffffff }),
  serverTime: fc.integer({ min: 0, max: 0xffffffff }),
  authorityChecksum: fc.integer({ min: 0, max: 0xffffffff }),
  cars: fc.array(carArb, { minLength: 1, maxLength: STATE_SNAPSHOT_MAX_CARS }),
  events: fc.constant([]),
});

describe('Property 19: encoded state packets fit within the 512-byte size cap', () => {
  it('encodes any 1..8-car snapshot to at most 512 bytes', () => {
    fc.assert(
      fc.property(snapshotArb, (snapshot) => {
        const encoded = StateSnapshotCodec.encode(snapshot);
        expect(encoded.byteLength).toBeLessThanOrEqual(STATE_SNAPSHOT_PACKET_CAP_BYTES);
      }),
      { numRuns: 1000 },
    );
  });
});
