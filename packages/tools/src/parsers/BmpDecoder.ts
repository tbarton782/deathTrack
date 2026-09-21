/**
 * Sprite (`BMP:`) decoder for the real Death Track (Dynamix, 1989) files.
 *
 * A `BMP:` container holds an `INF:` info chunk plus the pixel data. In the
 * Death Track files (`BITMAPS.BLK` and single sprites such as `ANGEL.BMP`,
 * `BAY_AREA.BMP`) the pixel data is the **`BIN:` single-image form** — an
 * LZW-compressed buffer of consecutive subimages.
 *
 * `INF:` layout (matches `research/dynamix-formats.md` §5.1):
 *
 * ```
 * offset 0            uint16            imgCount
 * offset 2            uint16[imgCount]  widths
 * offset 2+imgCount*2 uint16[imgCount]  heights
 * ```
 *
 * `BIN:` payload: a standard compressed leaf (method + decompressedSize + data,
 * see `decompress.ts`). After decompression the subimages are stored back to
 * back; **each subimage is 4-bpp — 2 pixels per byte, high nibble = left pixel —
 * row-major**. This 4-bpp packing (reverse-engineered and verified: for every
 * `BMP:` in `BITMAPS.BLK`, `sum(width*height)/2` equals the decompressed byte
 * count exactly) is what distinguishes sprites from `SCR:` screens (which are
 * 1 byte per pixel). Each 4-bit index selects a colour in the EGA remap palette
 * (see `PaletteDecoder`).
 *
 * The `SCN:`/`OFF:` subimage-table form (§5.2) is not used by Death Track's
 * files and is left unimplemented until a file that needs it appears.
 *
 * Requirements: 2.2, 2.6
 */

import { parseChunks, findChunk, type ChunkNode } from './ChunkReader.js';
import { decompress } from './decompress.js';
import type { Palette } from './PaletteDecoder.js';

/** Error raised when a sprite cannot be decoded. */
export class BmpDecodeError extends Error {
  readonly offset: number;
  constructor(message: string, offset = 0) {
    super(message);
    this.name = 'BmpDecodeError';
    this.offset = offset;
  }
}

/** A single decoded subimage: dimensions plus one 4-bit palette index per pixel. */
export interface SubImage {
  width: number;
  height: number;
  /** Palette indices (0..15), row-major, length = width * height. */
  indices: Uint8Array;
}

/** A decoded `BMP:` sprite sheet. */
export interface SpriteSheet {
  /** Number of subimages. */
  count: number;
  /** The subimages, in order. */
  images: SubImage[];
}

/** Read a little-endian uint16 at `offset`. */
function u16(data: Uint8Array, offset: number): number {
  return (data[offset] as number) | ((data[offset + 1] as number) << 8);
}

/** Parsed `INF:` header: per-subimage dimensions. */
export interface BmpInfo {
  count: number;
  widths: number[];
  heights: number[];
}

/**
 * Parse the `INF:` chunk into per-subimage dimensions.
 *
 * @param inf The `INF:` chunk data.
 */
export function parseInf(inf: Uint8Array): BmpInfo {
  if (inf.length < 2) throw new BmpDecodeError('INF chunk too short for imgCount');
  const count = u16(inf, 0);
  const need = 2 + count * 4;
  if (inf.length < need) {
    throw new BmpDecodeError(
      `INF too short: need ${need} bytes for ${count} subimages, have ${inf.length}`,
    );
  }
  const widths: number[] = [];
  const heights: number[] = [];
  for (let i = 0; i < count; i += 1) widths.push(u16(inf, 2 + i * 2));
  for (let i = 0; i < count; i += 1) heights.push(u16(inf, 2 + count * 2 + i * 2));
  return { count, widths, heights };
}

/**
 * Unpack a 4-bpp subimage from `raw` starting at byte `byteOffset`.
 *
 * @param raw        The full decompressed pixel buffer.
 * @param byteOffset Byte offset of this subimage's data.
 * @param width      Subimage width in pixels.
 * @param height     Subimage height in pixels.
 */
function unpack4bpp(
  raw: Uint8Array,
  byteOffset: number,
  width: number,
  height: number,
): Uint8Array {
  const pixelCount = width * height;
  const indices = new Uint8Array(pixelCount);
  for (let p = 0; p < pixelCount; p += 1) {
    const byte = raw[byteOffset + (p >> 1)] as number;
    // High nibble is the left (even) pixel, low nibble the right (odd) pixel.
    indices[p] = (p & 1) === 0 ? (byte >> 4) & 0x0f : byte & 0x0f;
  }
  return indices;
}

/**
 * Decode a `BMP:` container node (with `INF:` + `BIN:` children) into a
 * {@link SpriteSheet}.
 *
 * @param bmp A `BMP:` container chunk.
 */
export function decodeBmp(bmp: ChunkNode): SpriteSheet {
  if (!bmp.isContainer) throw new BmpDecodeError('BMP chunk is not a container');
  const infNode = findChunk(bmp.children, 'INF');
  if (infNode === undefined) throw new BmpDecodeError('BMP has no INF: chunk');
  const binNode = findChunk(bmp.children, 'BIN');
  if (binNode === undefined) {
    // SCN/OFF form is not present in Death Track's files.
    throw new BmpDecodeError('BMP has no BIN: chunk (SCN/OFF form is unsupported)');
  }

  const info = parseInf(infNode.data);
  const raw = decompress(binNode.data);

  // Validate the total size matches the 4-bpp assumption before decoding.
  let totalPixels = 0;
  for (let i = 0; i < info.count; i += 1) {
    totalPixels += (info.widths[i] as number) * (info.heights[i] as number);
  }
  const expectedBytes = Math.ceil(totalPixels / 2);
  if (raw.length < expectedBytes) {
    throw new BmpDecodeError(
      `BIN decompressed to ${raw.length} bytes but ${expectedBytes} needed for ${info.count} subimages`,
    );
  }

  const images: SubImage[] = [];
  let byteOffset = 0;
  for (let i = 0; i < info.count; i += 1) {
    const width = info.widths[i] as number;
    const height = info.heights[i] as number;
    const indices = unpack4bpp(raw, byteOffset, width, height);
    images.push({ width, height, indices });
    byteOffset += Math.ceil((width * height) / 2);
  }

  return { count: info.count, images };
}

/**
 * Decode every `BMP:` container in a file (a single sprite or a `.BLK` sheet).
 *
 * @param fileBytes Raw file bytes.
 */
export function decodeBmpFile(fileBytes: Uint8Array): SpriteSheet[] {
  const chunks = parseChunks(fileBytes);
  const sheets: SpriteSheet[] = [];
  for (const node of chunks) {
    if (node.id === 'BMP') sheets.push(decodeBmp(node));
  }
  if (sheets.length === 0) throw new BmpDecodeError('no BMP: container found in file');
  return sheets;
}

/**
 * Apply a palette to a subimage, producing row-major RGBA bytes. Indices are
 * 4-bit, so a 16-colour palette is expected.
 *
 * @param image   The subimage.
 * @param palette The palette to index into.
 */
export function subImageToRgba(image: SubImage, palette: Palette): Uint8Array {
  const { indices } = image;
  const rgba = new Uint8Array(indices.length * 4);
  for (let i = 0; i < indices.length; i += 1) {
    let idx = indices[i] as number;
    if (idx >= palette.count) idx = idx % Math.max(palette.count, 1);
    rgba[i * 4 + 0] = palette.rgb[idx * 3 + 0] ?? 0;
    rgba[i * 4 + 1] = palette.rgb[idx * 3 + 1] ?? 0;
    rgba[i * 4 + 2] = palette.rgb[idx * 3 + 2] ?? 0;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}
