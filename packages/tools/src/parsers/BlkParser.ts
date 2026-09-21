/**
 * Parser for original Deathtrack `.BLK` sprite-sheet files.
 *
 * A `.BLK` file packs many small bitmap "blocks" (individual sprites) into a
 * single file: car frames, scenery tiles, HUD glyphs, etc. Each block is an
 * indexed-colour raster whose pixel bytes index into the track palette (see
 * {@link PalParser}). This parser returns each block's dimensions and raw
 * palette-indexed pixels; palette application and atlas packing are performed
 * later by the sprite-sheet loader.
 *
 * ## Byte layout
 *
 * The design document does not pin down an exact `.BLK` byte layout, so this
 * parser uses a well-defined header + block-table + pixel-heap structure:
 *
 * | Offset | Size          | Field       | Notes                             |
 * |--------|---------------|-------------|-----------------------------------|
 * | 0      | 4             | magic       | ASCII `"DBLK"`                    |
 * | 4      | 2 (uint16 LE) | blockCount  | number of blocks, 0–4096          |
 * | 6      | blockCount ×  | block table | per-block descriptor (see below)  |
 * |        | 8             |             |                                   |
 * | …      | variable      | pixel heap  | concatenated block pixel data     |
 *
 * Each block-table descriptor is 8 bytes:
 *
 * | Offset | Size          | Field   | Notes                                |
 * |--------|---------------|---------|--------------------------------------|
 * | +0     | 2 (uint16 LE) | width   | block width in pixels, 1–1024        |
 * | +2     | 2 (uint16 LE) | height  | block height in pixels, 1–1024       |
 * | +4     | 4 (uint32 LE) | offset  | byte offset of pixels within file    |
 *
 * The pixel data for a block is `width × height` palette-index bytes located at
 * `offset`. Parse errors are reported with the failing byte offset.
 *
 * Requirements: 9.1, 2.6
 */

import { BinaryReader } from '@deathtrack/shared';

/** ASCII magic marker at the start of a `.BLK` file. */
const BLK_MAGIC = 'DBLK';

/** Size in bytes of a single block-table descriptor. */
const BLOCK_DESCRIPTOR_SIZE = 8;

/** Maximum accepted block count, as a sanity bound against corruption. */
const MAX_BLOCK_COUNT = 4096;

/** Maximum accepted block dimension, as a sanity bound against corruption. */
const MAX_DIMENSION = 1024;

/**
 * A single decoded sprite block.
 *
 * `pixels` is a row-major array of palette indices, length `width × height`.
 */
export interface SpriteBlock {
  /** Zero-based index of this block within the sheet. */
  index: number;
  /** Block width in pixels. */
  width: number;
  /** Block height in pixels. */
  height: number;
  /** Row-major palette indices, length `width × height`. */
  pixels: Uint8Array;
}

/**
 * A parsed `.BLK` sprite sheet: an ordered collection of sprite blocks.
 */
export interface SpriteSheetData {
  /** All decoded blocks, in file order. */
  blocks: SpriteBlock[];
}

/**
 * Raised when a `.BLK` buffer cannot be parsed. Carries the byte offset at
 * which parsing failed to aid debugging of malformed asset files.
 */
export class BlockParseError extends Error {
  /** Byte offset within the source buffer where the failure was detected. */
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`BlkParser: ${message} (at byte offset ${offset})`);
    this.name = 'BlockParseError';
    this.offset = offset;
  }
}

/** Descriptor read from the block table before pixel data is resolved. */
interface BlockDescriptor {
  width: number;
  height: number;
  offset: number;
  /** Byte offset of this descriptor, retained for error reporting. */
  descriptorOffset: number;
}

/**
 * Parse a `.BLK` sprite-sheet file.
 *
 * @param buf The raw `.BLK` file contents.
 * @returns The decoded {@link SpriteSheetData}.
 * @throws {BlockParseError} If the magic is wrong, the block count or any block
 *   dimension is out of range, or a block's pixel data is truncated or points
 *   outside the file.
 *
 * Requirements: 9.1, 2.6
 */
export function parseBlk(buf: Buffer): SpriteSheetData {
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const reader = new BinaryReader(bytes);

  if (bytes.byteLength < BLK_MAGIC.length) {
    throw new BlockParseError(
      `file too short to contain "${BLK_MAGIC}" magic (${bytes.byteLength} bytes)`,
      0,
    );
  }

  const magic = reader.fixedString(BLK_MAGIC.length);
  if (magic !== BLK_MAGIC) {
    throw new BlockParseError(`bad magic: expected "${BLK_MAGIC}", got "${magic}"`, 0);
  }

  let blockCount: number;
  try {
    blockCount = reader.uint16();
  } catch {
    throw new BlockParseError('truncated header: missing block count', reader.position);
  }

  if (blockCount > MAX_BLOCK_COUNT) {
    throw new BlockParseError(
      `block count ${blockCount} exceeds maximum ${MAX_BLOCK_COUNT}`,
      BLK_MAGIC.length,
    );
  }

  // Read the block table.
  const tableByteLength = blockCount * BLOCK_DESCRIPTOR_SIZE;
  if (reader.remaining < tableByteLength) {
    throw new BlockParseError(
      `truncated block table: expected ${tableByteLength} bytes but ${reader.remaining} remain`,
      reader.position,
    );
  }

  const descriptors: BlockDescriptor[] = [];
  for (let i = 0; i < blockCount; i += 1) {
    const descriptorOffset = reader.position;
    const width = reader.uint16();
    const height = reader.uint16();
    const offset = reader.uint32();

    if (width < 1 || width > MAX_DIMENSION) {
      throw new BlockParseError(
        `block ${i} width ${width} out of range 1..${MAX_DIMENSION}`,
        descriptorOffset,
      );
    }
    if (height < 1 || height > MAX_DIMENSION) {
      throw new BlockParseError(
        `block ${i} height ${height} out of range 1..${MAX_DIMENSION}`,
        descriptorOffset + 2,
      );
    }

    descriptors.push({ width, height, offset, descriptorOffset });
  }

  // Resolve pixel heaps for each block.
  const blocks: SpriteBlock[] = descriptors.map((desc, index) => {
    const pixelCount = desc.width * desc.height;
    const end = desc.offset + pixelCount;
    if (desc.offset < 0 || end > bytes.byteLength) {
      throw new BlockParseError(
        `block ${index} pixel range ${desc.offset}..${end} lies outside file of ${bytes.byteLength} bytes`,
        desc.descriptorOffset + 4,
      );
    }
    const pixels = bytes.slice(desc.offset, end);
    return { index, width: desc.width, height: desc.height, pixels };
  });

  return { blocks };
}
