/**
 * Fixed-point binary codec for {@link CompressedCarState}.
 *
 * A car's state is broadcast to every client 20 times per second inside a
 * {@link StateSnapshot}, so each entry must be as small as possible while still
 * preserving enough precision for smooth client-side interpolation. This codec
 * packs one car into exactly 12 bytes using a byte-aligned fixed-point scheme.
 *
 * The design's "~10 bytes per car" figure assumed sub-byte bit-packing of the
 * `id` field (3 bits); the shared codec framework only supports byte-aligned
 * field types, so `id` occupies a full byte and the real on-wire size is
 * 12 bytes. That is still far within the 512-byte packet cap
 * (8 cars × 12 = 96 bytes plus header — Requirements: 8.8).
 *
 * | Field         | Wire type | Bytes | Encoding                              |
 * | ------------- | --------- | ----- | ------------------------------------- |
 * | `id`          | uint8     | 1     | participant slot index (0–7)          |
 * | `x`           | uint16    | 2     | position × 0.1-unit resolution        |
 * | `y`           | uint16    | 2     | position × 0.1-unit resolution        |
 * | `heading`     | uint8     | 1     | 256 steps across 0–2π (~1.4°/step)    |
 * | `speed`       | uint16    | 2     | speed × 0.01-unit resolution          |
 * | `armor`       | uint8     | 1     | 0–255 linearly mapped from 0–maxArmor |
 * | `flags`       | uint8     | 1     | bitfield (see {@link CompressedCarState}) |
 * | `ammoForward` | uint8     | 1     | forward weapon ammo                   |
 * | `ammoRear`    | uint8     | 1     | rear weapon ammo                      |
 *
 * The {@link CompressedCarState} interface already carries the *quantised*
 * integer values (heading as a 0–255 step, `x`/`y` as fixed-point units, and so
 * on): the caller is responsible for the lossy float → fixed-point conversion
 * when building the snapshot. This codec is therefore lossless with respect to
 * the `CompressedCarState` object it is given — `decode(encode(v))` reproduces a
 * structurally identical value — and simply lays those integer fields out on
 * the wire in a fixed, immutable order.
 *
 * Requirements: 8.8
 */

import { createCodec, uint8, uint16, type Codec, type SchemaDescriptor } from './schema.js';
import type { CompressedCarState } from '../types/network.js';

/**
 * On-wire size of a single encoded {@link CompressedCarState} in bytes.
 *
 * 1 (`id`) + 2 (`x`) + 2 (`y`) + 1 (`heading`) + 2 (`speed`) + 1 (`armor`)
 * + 1 (`flags`) + 1 (`ammoForward`) + 1 (`ammoRear`) = 12 bytes.
 */
export const COMPRESSED_CAR_STATE_BYTES = 12;

/**
 * Ordered schema descriptor for {@link CompressedCarState}.
 *
 * The field order *is* the wire layout and must not be reordered once published
 * as part of the network protocol; a change here is a breaking protocol change.
 */
export const compressedCarStateSchema: SchemaDescriptor<CompressedCarState> = [
  { key: 'id', type: uint8 },
  { key: 'x', type: uint16 },
  { key: 'y', type: uint16 },
  { key: 'heading', type: uint8 },
  { key: 'speed', type: uint16 },
  { key: 'armor', type: uint8 },
  { key: 'flags', type: uint8 },
  { key: 'ammoForward', type: uint8 },
  { key: 'ammoRear', type: uint8 },
];

/**
 * Codec that encodes/decodes a single {@link CompressedCarState} to/from a
 * fixed 12-byte little-endian buffer using the fixed-point field layout above.
 *
 * Requirements: 8.8
 */
export const CompressedCarStateCodec: Codec<CompressedCarState> =
  createCodec(compressedCarStateSchema);
