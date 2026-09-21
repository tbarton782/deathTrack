/**
 * Full-screen image (`SCR:`) decoder for the real Death Track (Dynamix, 1989)
 * files.
 *
 * A `SCR:` container holds a `BIN:` leaf: a compressed payload (5-byte method +
 * decompressedSize header, then compressed bytes). Every Death Track `.SCR`
 * decompresses to exactly **32000 bytes**, and — determined empirically by
 * rendering the decoded bytes — the image is **160×200 with one palette index
 * per byte**, stored row-major (top to bottom, left to right). This was
 * confirmed against `CAR1.SCR` (a car), `POSTWAR.SCR` (a city skyline) and
 * `DASH0.SCR` (a dashboard), all of which render as complete, correctly
 * proportioned scenes at 160×200.
 *
 * This supersedes the two-plane 64000-byte VGA description in
 * `research/dynamix-formats.md` §4.1, which does not match the real files.
 *
 * Native pixels are 160×200. Death Track displayed these on a 320×200 screen by
 * doubling each pixel horizontally, so {@link decodeScr} can optionally emit the
 * doubled 320×200 image via `doubleWidth`.
 *
 * The decoder produces per-pixel palette indices; apply a {@link Palette} to
 * get RGBA. The 256-colour palette that maps these indices to RGB is not
 * present in the accessible data files (only 16-colour `EGA:`/`CGA:` blocks in
 * `ACTIVISI`/`PALS.BLK`); that palette source is tracked separately in task
 * 25.4. Until then {@link grayscalePalette} gives a faithful luminance preview.
 *
 * Requirements: 2.6, 11.6
 */

import { parseChunks, findChunk } from './ChunkReader.js';
import { decompress } from './decompress.js';
import type { Palette } from './PaletteDecoder.js';

/** Native stored dimensions of a Death Track full-screen image. */
export const SCREEN_WIDTH = 160;
export const SCREEN_HEIGHT = 200;
export const SCREEN_PIXELS = SCREEN_WIDTH * SCREEN_HEIGHT; // 32000

/** Displayed width after horizontal pixel-doubling. */
export const DISPLAY_WIDTH = SCREEN_WIDTH * 2; // 320

/** Error raised when a screen image cannot be decoded. */
export class ScrDecodeError extends Error {
  readonly offset: number;
  constructor(message: string, offset = 0) {
    super(message);
    this.name = 'ScrDecodeError';
    this.offset = offset;
  }
}

/** A decoded screen: dimensions plus one palette index per pixel. */
export interface ScreenImage {
  width: number;
  height: number;
  /** Palette indices, row-major, length = width * height. */
  indices: Uint8Array;
  /** The raw decompressed bytes, for diagnostics. */
  raw: Uint8Array;
}

/**
 * Locate the `SCR:` container's `BIN:` leaf in a file's chunk tree and return
 * its decompressed bytes.
 *
 * @param fileBytes Raw file bytes.
 */
export function decompressScrBin(fileBytes: Uint8Array): Uint8Array {
  const chunks = parseChunks(fileBytes);
  const scr = findChunk(chunks, 'SCR');
  if (scr === undefined) throw new ScrDecodeError('no SCR: container found');
  const bin = findChunk(scr.children.length ? scr.children : chunks, 'BIN');
  if (bin === undefined) throw new ScrDecodeError('no BIN: leaf inside SCR:');
  return decompress(bin.data);
}

/**
 * Interpret decompressed screen bytes as a 160×200, one-index-per-byte image.
 *
 * @param raw The decompressed screen bytes (expected 32000).
 */
export function decodeScreenBytes(raw: Uint8Array): ScreenImage {
  if (raw.length < SCREEN_PIXELS) {
    throw new ScrDecodeError(
      `screen has ${raw.length} bytes, need at least ${SCREEN_PIXELS} for ${SCREEN_WIDTH}x${SCREEN_HEIGHT}`,
    );
  }
  const indices = raw.subarray(0, SCREEN_PIXELS).slice();
  return { width: SCREEN_WIDTH, height: SCREEN_HEIGHT, indices, raw };
}

/**
 * Double a screen horizontally (each pixel becomes two), yielding a 320×200
 * image — the resolution Death Track presented these at.
 *
 * @param image A 160×200 screen.
 */
export function doublePixelsHorizontally(image: ScreenImage): ScreenImage {
  const { width, height, indices, raw } = image;
  const out = new Uint8Array(width * 2 * height);
  let p = 0;
  for (let i = 0; i < indices.length; i += 1) {
    const v = indices[i] as number;
    out[p++] = v;
    out[p++] = v;
  }
  return { width: width * 2, height, indices: out, raw };
}

/**
 * Full pipeline: file bytes → chunk → LZW → 160×200 screen indices.
 *
 * @param fileBytes   Raw `.SCR` file bytes.
 * @param doubleWidth When true, return the 320×200 pixel-doubled image.
 */
export function decodeScr(fileBytes: Uint8Array, doubleWidth = false): ScreenImage {
  const raw = decompressScrBin(fileBytes);
  const image = decodeScreenBytes(raw);
  return doubleWidth ? doublePixelsHorizontally(image) : image;
}

/**
 * Build a 256-entry greyscale palette (index -> that value in R, G and B). Used
 * as a faithful luminance preview until the real 256-colour palette source is
 * recovered (task 25.4).
 */
export function grayscalePalette(): Palette {
  const rgb = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i += 1) {
    rgb[i * 3 + 0] = i;
    rgb[i * 3 + 1] = i;
    rgb[i * 3 + 2] = i;
  }
  return { count: 256, rgb };
}

/**
 * Apply a palette to a decoded screen, producing row-major RGBA bytes.
 *
 * Death Track screens carry a colour index per byte. For the recovered
 * 16-colour EGA palette the meaningful index is the byte's **high nibble**
 * (`byte >> 4`); for a 256-colour palette the full byte is used. The mapping is
 * chosen automatically from `palette.count` unless overridden.
 *
 * @param image   The decoded screen.
 * @param palette The palette to index into.
 * @param mode    `'auto'` (default) uses the high nibble for a ≤16-colour
 *                palette and the full byte otherwise; `'byte'` and `'nibble'`
 *                force the mapping.
 */
export function applyPalette(
  image: ScreenImage,
  palette: Palette,
  mode: 'auto' | 'byte' | 'nibble' = 'auto',
): Uint8Array {
  const { indices } = image;
  const useNibble = mode === 'nibble' || (mode === 'auto' && palette.count <= 16);
  const rgba = new Uint8Array(indices.length * 4);
  for (let i = 0; i < indices.length; i += 1) {
    const raw = indices[i] as number;
    let idx = useNibble ? (raw >> 4) & 0x0f : raw;
    if (idx >= palette.count) idx = idx % Math.max(palette.count, 1);
    rgba[i * 4 + 0] = palette.rgb[idx * 3 + 0] ?? 0;
    rgba[i * 4 + 1] = palette.rgb[idx * 3 + 1] ?? 0;
    rgba[i * 4 + 2] = palette.rgb[idx * 3 + 2] ?? 0;
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}
