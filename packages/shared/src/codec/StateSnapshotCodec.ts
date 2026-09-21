/**
 * Binary codec for the authoritative {@link StateSnapshot} broadcast from the
 * server to every client at 20 Hz.
 *
 * A snapshot carries a small fixed header followed by a length-prefixed array of
 * up to 8 {@link CompressedCarState} entries. The whole packet is engineered to
 * stay comfortably under the 512-byte per-participant packet cap
 * (Requirements: 8.8) so that a single snapshot fits inside one unfragmented UDP
 * -sized datagram.
 *
 * ## Wire layout
 *
 * | Field                | Wire type              | Bytes            | Notes                                |
 * | -------------------- | ---------------------- | ---------------- | ------------------------------------ |
 * | `tick`               | uint32                 | 4                | server authoritative physics tick    |
 * | `serverTime`         | uint32                 | 4                | ms since race start                  |
 * | `authorityChecksum`  | uint32                 | 4                | CRC-32 of full world state           |
 * | `cars`               | array(CompressedCar)   | 2 + n × 12       | uint16 count prefix + n car entries  |
 *
 * ## Size budget (Requirements: 8.8)
 *
 * - Header: `tick` (4) + `serverTime` (4) + `authorityChecksum` (4) = **12 bytes**.
 * - Cars array: 2-byte `uint16` length prefix + up to 8 × {@link COMPRESSED_CAR_STATE_BYTES}
 *   (12) = 2 + 96 = **98 bytes**.
 * - Maximum encoded snapshot: 12 + 98 = **110 bytes**, i.e. **≤ 512 bytes** with a
 *   comfortable 402-byte margin. See {@link STATE_SNAPSHOT_MAX_BYTES}.
 *
 * ## Scope: the `events` field
 *
 * The {@link StateSnapshot} interface also carries an `events` array (a
 * discriminated union of network events used for lossy event replay). Encoding
 * that union is intentionally *not* part of this codec: the header + car-state
 * payload is the synchronised game state that must round-trip losslessly
 * (Requirements: 8.7, 3.10), whereas `events` is an at-most-3-entry replay
 * window layered on top by the network manager. This codec therefore encodes
 * only the header and car array; on decode it normalises `events` to an empty
 * array so the returned value is a structurally valid {@link StateSnapshot}.
 * Callers that need event replay attach/read those events alongside the encoded
 * snapshot rather than inside it.
 *
 * Requirements: 8.7, 8.8
 */

import {
  createCodec,
  uint32,
  array,
  nested,
  type Codec,
  type FieldType,
  type SchemaDescriptor,
} from './schema.js';
import {
  compressedCarStateSchema,
  COMPRESSED_CAR_STATE_BYTES,
} from './CompressedCarStateCodec.js';
import type { StateSnapshot, CompressedCarState } from '../types/network.js';

/** Maximum number of cars (participant slots) a single snapshot may carry. */
export const STATE_SNAPSHOT_MAX_CARS = 8;

/**
 * Fixed header size in bytes: `tick` (4) + `serverTime` (4)
 * + `authorityChecksum` (4).
 */
export const STATE_SNAPSHOT_HEADER_BYTES = 12;

/** Width of the `uint16` element-count prefix the `array` field writes. */
const CARS_LENGTH_PREFIX_BYTES = 2;

/**
 * Worst-case encoded snapshot size in bytes, at the maximum of 8 cars:
 *
 * `STATE_SNAPSHOT_HEADER_BYTES` (12) + `CARS_LENGTH_PREFIX_BYTES` (2)
 * + 8 × {@link COMPRESSED_CAR_STATE_BYTES} (12) = 110 bytes.
 *
 * This is the value the size budget above is derived from; it is asserted at
 * module load to stay within the 512-byte cap (Requirements: 8.8).
 */
export const STATE_SNAPSHOT_MAX_BYTES =
  STATE_SNAPSHOT_HEADER_BYTES +
  CARS_LENGTH_PREFIX_BYTES +
  STATE_SNAPSHOT_MAX_CARS * COMPRESSED_CAR_STATE_BYTES;

/** The hard packet cap the encoded snapshot must never exceed (Requirements: 8.8). */
export const STATE_SNAPSHOT_PACKET_CAP_BYTES = 512;

// Compile-time-ish guard: fail fast at import if a layout change ever pushes the
// worst-case snapshot past the packet cap.
if (STATE_SNAPSHOT_MAX_BYTES > STATE_SNAPSHOT_PACKET_CAP_BYTES) {
  throw new Error(
    `StateSnapshot worst-case size ${STATE_SNAPSHOT_MAX_BYTES} bytes exceeds ` +
      `the ${STATE_SNAPSHOT_PACKET_CAP_BYTES}-byte packet cap`,
  );
}

/**
 * Field type for a single {@link CompressedCarState}, reusing the published
 * 12-byte fixed-point layout from {@link compressedCarStateSchema}.
 */
const compressedCarField: FieldType<CompressedCarState> = nested(compressedCarStateSchema);

/**
 * The subset of {@link StateSnapshot} this codec serialises: the header fields
 * plus the car array. `events` is handled separately (see the module doc) and is
 * therefore omitted from the schema.
 */
type EncodedSnapshot = Pick<
  StateSnapshot,
  'tick' | 'serverTime' | 'authorityChecksum' | 'cars'
>;

/**
 * Ordered schema descriptor for the encoded portion of a {@link StateSnapshot}.
 *
 * The field order *is* the wire layout and must not be reordered once published
 * as part of the network protocol; a change here is a breaking protocol change.
 */
export const stateSnapshotSchema: SchemaDescriptor<EncodedSnapshot> = [
  { key: 'tick', type: uint32 },
  { key: 'serverTime', type: uint32 },
  { key: 'authorityChecksum', type: uint32 },
  { key: 'cars', type: array(compressedCarField) as FieldType<CompressedCarState[]> },
];

const encodedCodec: Codec<EncodedSnapshot> = createCodec(stateSnapshotSchema);

/**
 * Codec that encodes/decodes a {@link StateSnapshot}'s synchronised state (header
 * + car array) to/from a little-endian buffer that is guaranteed to be at most
 * {@link STATE_SNAPSHOT_MAX_BYTES} (110) bytes for the maximum 8 cars — well
 * within the 512-byte packet cap.
 *
 * `decode` returns a structurally valid {@link StateSnapshot} whose `events`
 * array is empty (see the module doc for why `events` is out of scope here).
 *
 * Requirements: 8.7, 8.8
 */
export const StateSnapshotCodec: Codec<StateSnapshot> = {
  encode(value: StateSnapshot): Uint8Array {
    return encodedCodec.encode({
      tick: value.tick,
      serverTime: value.serverTime,
      authorityChecksum: value.authorityChecksum,
      cars: value.cars,
    });
  },
  decode(buf: Uint8Array): StateSnapshot {
    const { tick, serverTime, authorityChecksum, cars } = encodedCodec.decode(buf);
    return { tick, serverTime, authorityChecksum, cars, events: [] };
  },
};
