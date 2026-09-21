/**
 * Parser for original Deathtrack `.SCR` full-screen image files.
 *
 * A `.SCR` file stores a single full-screen indexed-colour raster: the title
 * screen, menu backdrops, and the AI-driver character portraits shown on the
 * Competitor Info screen. Each pixel byte indexes into a 256-colour palette
 * (see {@link PalParser}). This parser returns the raw palette-indexed pixels
 * plus the image dimensions, and provides {@link applyPalette} to expand those
 * indices into a browser-ready RGBA `Uint8ClampedArray` (the layout accepted by
 * `ImageData` / canvas / WebGL texture uploads).
 *
 * ## Byte layout
 *
 * The design document does not pin down an exact `.SCR` byte layout, so this
 * parser uses a small, well-defined header followed by row-major pixel data,
 * mirroring the convention used by {@link MapParser} and {@link BlkParser}:
 *
 * | Offset | Size            | Field    | Notes                              |
 * |--------|-----------------|----------|------------------------------------|
 * | 0      | 4               | magic    | ASCII `"DSCR"`                     |
 * | 4      | 2 (uint16 LE)   | width    | image width in pixels, 1–4096      |
 * | 6      | 2 (uint16 LE)   | height   | image height in pixels, 1–4096     |
 * | 8      | width × height  | pixels   | row-major palette indices (uint8)  |
 *
 * Parse errors are reported with the failing byte offset for diagnosis.
 *
 * Requirements: 11.6
 */

import { BinaryReader } from '@deathtrack/shared';
import type { PaletteData } from './PalParser.js';

/** ASCII magic marker at the start of a `.SCR` file. */
const SCR_MAGIC = 'DSCR';

/**
 * Maximum accepted image dimension, as a sanity bound against corruption.
 * Full-screen images are historically small (e.g. 320×200), but portraits and
 * higher-resolution art are allowed some headroom.
 */
const MAX_DIMENSION = 4096;

/** Number of colour entries a palette must contain to index every byte value. */
const PALETTE_ENTRY_COUNT = 256;

/** Number of bytes in a flat 256-colour RGB palette (`256 × 3`). */
const PALETTE_RGB_BYTE_LENGTH = PALETTE_ENTRY_COUNT * 3;

/**
 * A parsed full-screen image.
 *
 * `pixels` is a row-major array of palette indices, length `width × height`.
 * Each entry indexes into a palette produced by {@link PalParser}; call
 * {@link applyPalette} to obtain displayable RGBA data.
 */
export interface ScreenImage {
  /** Image width in pixels. */
  width: number;
  /** Image height in pixels. */
  height: number;
  /** Row-major palette indices, length `width × height`. */
  pixels: Uint8Array;
}

/**
 * Raised when a `.SCR` buffer cannot be parsed. Carries the byte offset at
 * which parsing failed to aid debugging of malformed asset files.
 */
export class ScreenParseError extends Error {
  /** Byte offset within the source buffer where the failure was detected. */
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`ScrParser: ${message} (at byte offset ${offset})`);
    this.name = 'ScreenParseError';
    this.offset = offset;
  }
}

/**
 * Parse a `.SCR` full-screen image file.
 *
 * @param buf The raw `.SCR` file contents.
 * @returns The decoded {@link ScreenImage}.
 * @throws {ScreenParseError} If the magic is wrong, dimensions are out of
 *   range, or the pixel data is truncated.
 *
 * Requirements: 11.6
 */
export function parseScr(buf: Buffer): ScreenImage {
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const reader = new BinaryReader(bytes);

  if (bytes.byteLength < SCR_MAGIC.length) {
    throw new ScreenParseError(
      `file too short to contain "${SCR_MAGIC}" magic (${bytes.byteLength} bytes)`,
      0,
    );
  }

  const magic = reader.fixedString(SCR_MAGIC.length);
  if (magic !== SCR_MAGIC) {
    throw new ScreenParseError(`bad magic: expected "${SCR_MAGIC}", got "${magic}"`, 0);
  }

  let width: number;
  let height: number;
  try {
    width = reader.uint16();
    height = reader.uint16();
  } catch {
    throw new ScreenParseError('truncated header: missing width/height', reader.position);
  }

  if (width < 1 || width > MAX_DIMENSION) {
    throw new ScreenParseError(`width ${width} out of range 1..${MAX_DIMENSION}`, SCR_MAGIC.length);
  }
  if (height < 1 || height > MAX_DIMENSION) {
    throw new ScreenParseError(
      `height ${height} out of range 1..${MAX_DIMENSION}`,
      SCR_MAGIC.length + 2,
    );
  }

  const pixelCount = width * height;
  if (reader.remaining < pixelCount) {
    throw new ScreenParseError(
      `truncated pixel data: expected ${pixelCount} bytes but ${reader.remaining} remain`,
      reader.position,
    );
  }

  const pixels = reader.bytes(pixelCount);

  return { width, height, pixels };
}

/**
 * Expand a palette-indexed {@link ScreenImage} into a displayable RGBA buffer.
 *
 * Each palette index in `image.pixels` is looked up in `palette.rgb` (the flat
 * `256 × 3` RGB array produced by {@link PalParser}) and written as an opaque
 * RGBA quad (`alpha = 255`). The result is a row-major `Uint8ClampedArray` of
 * length `width × height × 4`, matching the layout expected by the DOM
 * `ImageData` constructor and WebGL `RGBA`/`UNSIGNED_BYTE` texture uploads.
 *
 * @param image The decoded indexed image.
 * @param palette The palette to apply; `palette.rgb` must contain at least
 *   `256 × 3` bytes.
 * @returns An RGBA `Uint8ClampedArray` of length `width × height × 4`.
 * @throws {ScreenParseError} If the palette is too small to index every colour.
 *
 * Requirements: 11.6
 */
export function applyPalette(image: ScreenImage, palette: PaletteData): Uint8ClampedArray {
  if (palette.rgb.length < PALETTE_RGB_BYTE_LENGTH) {
    throw new ScreenParseError(
      `palette too small: expected at least ${PALETTE_RGB_BYTE_LENGTH} RGB bytes but got ${palette.rgb.length}`,
      0,
    );
  }

  const { pixels } = image;
  const rgba = new Uint8ClampedArray(pixels.length * 4);
  const rgb = palette.rgb;

  for (let i = 0; i < pixels.length; i += 1) {
    const paletteIndex = pixels[i] as number;
    const src = paletteIndex * 3;
    const dst = i * 4;
    rgba[dst] = rgb[src] as number;
    rgba[dst + 1] = rgb[src + 1] as number;
    rgba[dst + 2] = rgb[src + 2] as number;
    rgba[dst + 3] = 255;
  }

  return rgba;
}

/**
 * Convenience helper: parse a `.SCR` file and immediately apply a palette,
 * returning both the decoded image and its RGBA expansion.
 *
 * @param buf The raw `.SCR` file contents.
 * @param palette The palette to apply.
 * @returns The decoded {@link ScreenImage} and its RGBA `Uint8ClampedArray`.
 * @throws {ScreenParseError} If parsing or palette application fails.
 *
 * Requirements: 11.6
 */
export function parseScrToRgba(
  buf: Buffer,
  palette: PaletteData,
): { image: ScreenImage; rgba: Uint8ClampedArray } {
  const image = parseScr(buf);
  const rgba = applyPalette(image, palette);
  return { image, rgba };
}
