/**
 * Font (`FNT:`) decoder for the real Death Track (Dynamix, 1989) files.
 *
 * The `FONTS.BLK` file holds three `FNT:` leaf chunks (nominal cell sizes 4×5,
 * 6×6 and 8×8). Reverse-engineered from the real bytes, the Death Track font is
 * a simple fixed-width, uncompressed, 1-bit-per-pixel format — much simpler than
 * the later Dynamix v4/v5 font layout described in `research/dynamix-formats.md`
 * §6 (which does not match these files):
 *
 * ```
 * offset 0  uint8  width        cell width in pixels
 * offset 1  uint8  height       cell height in pixels (rows per glyph)
 * offset 2  uint8  startSymbol  ASCII code of the first glyph (0x20 = space)
 * offset 3  uint8  count        number of glyphs
 * offset 4  byte[] glyphs       `count` glyphs, each `height` bytes
 * ```
 *
 * Each glyph is `height` rows of one byte; within a row the **most-significant
 * bit is the leftmost pixel**. Widths ≤ 8 fit in a single byte per row. This
 * was confirmed by rendering: with a 4-byte header and `height` bytes per glyph,
 * `'A'` and `'H'` render as their letters, and `(dataLen - 4) / count` is
 * exactly `height` for all three fonts.
 *
 * Requirements: 2.6, 11.1
 */

import { parseChunks, findChunk, type ChunkNode } from './ChunkReader.js';

/** Size of the fixed FNT header in bytes. */
export const FNT_HEADER_SIZE = 4;

/** Error raised when a font cannot be decoded. */
export class FntDecodeError extends Error {
  readonly offset: number;
  constructor(message: string, offset = 0) {
    super(message);
    this.name = 'FntDecodeError';
    this.offset = offset;
  }
}

/** A single decoded glyph. */
export interface Glyph {
  /** ASCII code of this glyph. */
  code: number;
  /** Cell width in pixels. */
  width: number;
  /** Cell height in pixels. */
  height: number;
  /**
   * One byte per pixel: 1 = set, 0 = clear, row-major (length = width*height).
   */
  pixels: Uint8Array;
}

/** A decoded fixed-width bitmap font. */
export interface Font {
  width: number;
  height: number;
  startSymbol: number;
  count: number;
  /** Glyphs in order, indexable by `code - startSymbol`. */
  glyphs: Glyph[];
}

/**
 * Decode a single `FNT:` chunk's data into a {@link Font}.
 *
 * @param data The `FNT:` chunk data (starting at the 4-byte header).
 */
export function decodeFnt(data: Uint8Array): Font {
  if (data.length < FNT_HEADER_SIZE) {
    throw new FntDecodeError('FNT chunk shorter than 4-byte header');
  }
  const width = data[0] as number;
  const height = data[1] as number;
  const startSymbol = data[2] as number;
  const count = data[3] as number;

  if (width === 0 || width > 8) {
    // This decoder handles widths that fit in a single byte per row, which is
    // the case for all Death Track fonts (4, 6, 8). Guard against surprises.
    throw new FntDecodeError(`unsupported FNT width ${width} (expected 1..8)`, 0);
  }

  const bytesPerGlyph = height; // 1 byte per row, width <= 8
  const needed = FNT_HEADER_SIZE + count * bytesPerGlyph;
  if (data.length < needed) {
    throw new FntDecodeError(
      `FNT data too short: need ${needed} bytes for ${count} glyphs of ${height} rows, have ${data.length}`,
      data.length,
    );
  }

  const glyphs: Glyph[] = [];
  for (let g = 0; g < count; g += 1) {
    const base = FNT_HEADER_SIZE + g * bytesPerGlyph;
    const pixels = new Uint8Array(width * height);
    for (let row = 0; row < height; row += 1) {
      const rowByte = data[base + row] as number;
      for (let col = 0; col < width; col += 1) {
        // MSB is the leftmost pixel.
        const bit = (rowByte >> (7 - col)) & 1;
        pixels[row * width + col] = bit;
      }
    }
    glyphs.push({ code: startSymbol + g, width, height, pixels });
  }

  return { width, height, startSymbol, count, glyphs };
}

/**
 * Parse a `FONTS.BLK`-style file and decode every top-level `FNT:` chunk.
 *
 * @param fileBytes Raw file bytes.
 */
export function decodeFonts(fileBytes: Uint8Array): Font[] {
  const chunks = parseChunks(fileBytes);
  const fonts: Font[] = [];
  collectFnts(chunks, fonts);
  if (fonts.length === 0) {
    throw new FntDecodeError('no FNT: chunk found in file');
  }
  return fonts;
}

/** Recursively decode every `FNT:` chunk in a node tree. */
function collectFnts(nodes: ChunkNode[], out: Font[]): void {
  for (const node of nodes) {
    if (node.id === 'FNT' && !node.isContainer) {
      out.push(decodeFnt(node.data));
    }
    if (node.children.length) collectFnts(node.children, out);
  }
}

/** Look up a glyph by ASCII code, or `undefined` if outside the font's range. */
export function glyphForCode(font: Font, code: number): Glyph | undefined {
  const idx = code - font.startSymbol;
  if (idx < 0 || idx >= font.count) return undefined;
  return font.glyphs[idx];
}

// Re-export for convenience.
export { findChunk };
