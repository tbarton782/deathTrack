/**
 * Parser for original Deathtrack `.MAP` overhead minimap files.
 *
 * A `.MAP` file stores the low-resolution overhead map shown on the race HUD.
 * It is an indexed-colour raster: each pixel byte is an index into the track's
 * 256-colour palette (see {@link PalParser}). The parser returns the raw
 * palette-indexed pixels plus the map dimensions; palette application is
 * performed later by the renderer / sprite-sheet loader.
 *
 * ## Byte layout
 *
 * The design document does not pin down an exact `.MAP` byte layout, so this
 * parser uses a small, well-defined header followed by row-major pixel data:
 *
 * | Offset | Size            | Field    | Notes                              |
 * |--------|-----------------|----------|------------------------------------|
 * | 0      | 4               | magic    | ASCII `"DMAP"`                     |
 * | 4      | 2 (uint16 LE)   | width    | minimap width in pixels, 1–1024    |
 * | 6      | 2 (uint16 LE)   | height   | minimap height in pixels, 1–1024   |
 * | 8      | width × height  | pixels   | row-major palette indices (uint8)  |
 *
 * Parse errors are reported with the failing byte offset for diagnosis.
 *
 * Requirements: 9.1, 2.6
 */

import { BinaryReader } from '@deathtrack/shared';

/** ASCII magic marker at the start of a `.MAP` file. */
const MAP_MAGIC = 'DMAP';

/** Maximum accepted minimap dimension, as a sanity bound against corruption. */
const MAX_DIMENSION = 1024;

/**
 * A parsed overhead minimap.
 *
 * `pixels` is a row-major array of palette indices, length `width × height`.
 * Each entry indexes into the track palette produced by {@link PalParser}.
 */
export interface MapData {
  /** Minimap width in pixels. */
  width: number;
  /** Minimap height in pixels. */
  height: number;
  /** Row-major palette indices, length `width × height`. */
  pixels: Uint8Array;
}

/**
 * Raised when a `.MAP` buffer cannot be parsed. Carries the byte offset at
 * which parsing failed to aid debugging of malformed asset files.
 */
export class MapParseError extends Error {
  /** Byte offset within the source buffer where the failure was detected. */
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`MapParser: ${message} (at byte offset ${offset})`);
    this.name = 'MapParseError';
    this.offset = offset;
  }
}

/**
 * Parse a `.MAP` overhead minimap file.
 *
 * @param buf The raw `.MAP` file contents.
 * @returns The decoded {@link MapData}.
 * @throws {MapParseError} If the magic is wrong, dimensions are out of range,
 *   or the pixel data is truncated.
 *
 * Requirements: 9.1, 2.6
 */
export function parseMap(buf: Buffer): MapData {
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const reader = new BinaryReader(bytes);

  if (bytes.byteLength < MAP_MAGIC.length) {
    throw new MapParseError(
      `file too short to contain "${MAP_MAGIC}" magic (${bytes.byteLength} bytes)`,
      0,
    );
  }

  const magic = reader.fixedString(MAP_MAGIC.length);
  if (magic !== MAP_MAGIC) {
    throw new MapParseError(`bad magic: expected "${MAP_MAGIC}", got "${magic}"`, 0);
  }

  let width: number;
  let height: number;
  try {
    width = reader.uint16();
    height = reader.uint16();
  } catch {
    throw new MapParseError('truncated header: missing width/height', reader.position);
  }

  if (width < 1 || width > MAX_DIMENSION) {
    throw new MapParseError(`width ${width} out of range 1..${MAX_DIMENSION}`, MAP_MAGIC.length);
  }
  if (height < 1 || height > MAX_DIMENSION) {
    throw new MapParseError(
      `height ${height} out of range 1..${MAX_DIMENSION}`,
      MAP_MAGIC.length + 2,
    );
  }

  const pixelCount = width * height;
  if (reader.remaining < pixelCount) {
    throw new MapParseError(
      `truncated pixel data: expected ${pixelCount} bytes but ${reader.remaining} remain`,
      reader.position,
    );
  }

  const pixels = reader.bytes(pixelCount);

  return { width, height, pixels };
}
