/**
 * `.MAP` decoder for the real Death Track (Dynamix, 1989) files.
 *
 * `.MAP` files are a **raw** payload (no chunk tag): a single LZW-compressed
 * leaf (compression type `0x02`, 5-byte header) that decompresses to a
 * fixed-size buffer. Reverse-engineered and verified against all 10 tracks, the
 * decompressed payload is **not** a minimap — it is the track's **horizon
 * backdrop panorama**, stored as a small set of horizontal scenery strips:
 *
 * ```
 * offset 0            uint16            count            (6 for every track)
 * offset 2            uint16[count]     widths           (160 for every strip)
 * offset 2+count*2    uint16[count]     heights          (25 for every strip)
 * offset 2+count*4    byte[]            strips           count strips, each
 *                                                        width*height bytes,
 *                                                        one EGA colour index
 *                                                        per pixel, row-major
 * ```
 *
 * For every real track this is `count=6`, `160×25` strips, `2 + 6*4 + 6*160*25
 * = 24026` decompressed bytes. Each pixel is a 16-colour EGA index (apply the
 * EGA remap palette from `PaletteDecoder`). Rendering confirms the strips are
 * recognisable backdrops (e.g. the Bay Area strips show the San Francisco
 * skyline and the Golden Gate Bridge), which is why this supersedes the
 * "minimap" description in the task/spec.
 *
 * The layout mirrors the `BMP:` `INF:` header (count + widths + heights + pixel
 * data); the difference is `.MAP` strips are 1 byte per pixel, whereas `BMP:`
 * sprites are 4-bpp.
 *
 * Requirements: 9.1
 */

import { decompress } from './decompress.js';

/** Error raised when a `.MAP` cannot be decoded. */
export class MapDecodeError extends Error {
  readonly offset: number;
  constructor(message: string, offset = 0) {
    super(message);
    this.name = 'MapDecodeError';
    this.offset = offset;
  }
}

/** A single backdrop strip: dimensions plus one palette index per pixel. */
export interface BackdropStrip {
  width: number;
  height: number;
  /** Row-major EGA colour indices, length = width * height. */
  indices: Uint8Array;
}

/** A decoded `.MAP`: the track's horizon backdrop strips. */
export interface TrackBackdrop {
  /** Number of strips. */
  count: number;
  /** The backdrop strips, in order. */
  strips: BackdropStrip[];
  /** The raw decompressed payload, for diagnostics. */
  raw: Uint8Array;
}

/** Read a little-endian uint16 at `offset`. */
function u16(data: Uint8Array, offset: number): number {
  return (data[offset] as number) | ((data[offset + 1] as number) << 8);
}

/**
 * Decode a `.MAP` file into its {@link TrackBackdrop}.
 *
 * @param fileBytes Raw `.MAP` file bytes (an LZW-compressed leaf).
 * @throws {MapDecodeError} On a malformed header or truncated strip data.
 * Requirements: 9.1
 */
export function decodeMap(fileBytes: Uint8Array): TrackBackdrop {
  let raw: Uint8Array;
  try {
    raw = decompress(fileBytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new MapDecodeError(`failed to decompress .MAP payload: ${message}`);
  }

  if (raw.length < 2) {
    throw new MapDecodeError('.MAP payload too short for a count header');
  }
  const count = u16(raw, 0);
  const headerEnd = 2 + count * 4;
  if (raw.length < headerEnd) {
    throw new MapDecodeError(
      `.MAP header declares ${count} strips but payload is only ${raw.length} bytes`,
      raw.length,
    );
  }

  const widths: number[] = [];
  const heights: number[] = [];
  for (let i = 0; i < count; i += 1) widths.push(u16(raw, 2 + i * 2));
  for (let i = 0; i < count; i += 1) heights.push(u16(raw, 2 + count * 2 + i * 2));

  let totalPixels = 0;
  for (let i = 0; i < count; i += 1) totalPixels += (widths[i] as number) * (heights[i] as number);
  if (raw.length < headerEnd + totalPixels) {
    throw new MapDecodeError(
      `.MAP strip data truncated: need ${headerEnd + totalPixels} bytes, have ${raw.length}`,
      raw.length,
    );
  }

  const strips: BackdropStrip[] = [];
  let offset = headerEnd;
  for (let i = 0; i < count; i += 1) {
    const width = widths[i] as number;
    const height = heights[i] as number;
    const size = width * height;
    const indices = raw.subarray(offset, offset + size).slice();
    strips.push({ width, height, indices });
    offset += size;
  }

  return { count, strips, raw };
}
