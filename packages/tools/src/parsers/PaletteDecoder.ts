/**
 * Palette decoder for the real Death Track (Dynamix, 1994) files.
 *
 * A `PAL:` container holds one or more palette sub-blocks. The documented VGA
 * form (`VGA:`) stores 3 bytes per colour (R, G, B), each channel in the 6-bit
 * VGA DAC range 0–63. We scale to 0–255 for modern output. See
 * `research/dynamix-formats.md` section 3.
 *
 * Note: the real `ACTIVISI` palette file uses `EGA:`/`CGA:` sub-blocks rather
 * than `VGA:`; those are fixed hardware palettes selected by index, so this
 * module also exposes the standard 16-colour EGA palette for decoding EGA-form
 * images. The 6-bit -> 8-bit scaling helper is shared.
 *
 * Requirements: 2.6
 */

import { parseChunks, findChunk, type ChunkNode } from './ChunkReader.js';

/** A decoded palette: `count` RGB triples flattened into `rgb` (length 3*count). */
export interface Palette {
  count: number;
  /** Flattened RGB bytes, 0–255 per channel, length = 3 * count. */
  rgb: Uint8Array;
}

/** Error raised when a palette cannot be decoded. */
export class PaletteDecodeError extends Error {
  readonly offset: number;
  constructor(message: string, offset = 0) {
    super(message);
    this.name = 'PaletteDecodeError';
    this.offset = offset;
  }
}

/**
 * Convert a 6-bit VGA DAC channel value (0–63) to 8-bit (0–255) using the exact
 * scaling `round(v * 255 / 63)` for colour fidelity.
 */
export function scale6to8(v: number): number {
  return Math.round((v & 0x3f) * 255 / 63);
}

/**
 * Decode a `VGA:` palette sub-block: consecutive R,G,B triples in the 0–63 DAC
 * range, scaled to 0–255.
 *
 * @param data The `VGA:` chunk data.
 */
export function decodeVgaPalette(data: Uint8Array): Palette {
  const count = Math.floor(data.length / 3);
  const rgb = new Uint8Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    rgb[i * 3 + 0] = scale6to8(data[i * 3 + 0] as number);
    rgb[i * 3 + 1] = scale6to8(data[i * 3 + 1] as number);
    rgb[i * 3 + 2] = scale6to8(data[i * 3 + 2] as number);
  }
  return { count, rgb };
}

/**
 * The standard 16-colour EGA palette (RGB, 0–255). Used when an image is decoded
 * against an `EGA:` sub-block, which selects from these fixed hardware colours.
 */
export const EGA_PALETTE_16: ReadonlyArray<readonly [number, number, number]> = [
  [0x00, 0x00, 0x00], // 0 black
  [0x00, 0x00, 0xaa], // 1 blue
  [0x00, 0xaa, 0x00], // 2 green
  [0x00, 0xaa, 0xaa], // 3 cyan
  [0xaa, 0x00, 0x00], // 4 red
  [0xaa, 0x00, 0xaa], // 5 magenta
  [0xaa, 0x55, 0x00], // 6 brown
  [0xaa, 0xaa, 0xaa], // 7 light grey
  [0x55, 0x55, 0x55], // 8 dark grey
  [0x55, 0x55, 0xff], // 9 bright blue
  [0x55, 0xff, 0x55], // 10 bright green
  [0x55, 0xff, 0xff], // 11 bright cyan
  [0xff, 0x55, 0x55], // 12 bright red
  [0xff, 0x55, 0xff], // 13 bright magenta
  [0xff, 0xff, 0x55], // 14 yellow
  [0xff, 0xff, 0xff], // 15 white
];

/** Build a {@link Palette} from the fixed 16-colour EGA table. */
export function egaPalette16(): Palette {
  const rgb = new Uint8Array(16 * 3);
  EGA_PALETTE_16.forEach(([r, g, b], i) => {
    rgb[i * 3 + 0] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  });
  return { count: 16, rgb };
}

/**
 * Decode the Death Track `EGA:` sub-block into a 16-colour RGB palette.
 *
 * Reverse-engineered from `ACTIVISI`: the 128-byte `EGA:` block is 64 little-
 * endian 16-bit words where each word has both bytes equal and each byte has
 * both nibbles equal — i.e. every entry collapses to a single 4-bit value. The
 * block is two identical halves of 32 entries; the first 16 entries of a half
 * form a **logical -> EGA hardware colour** remap table (the next 16 are an
 * identity ramp `0..15`). A screen pixel's colour index selects a logical entry
 * whose value is the EGA hardware colour, which we then look up in the fixed
 * 16-colour EGA RGB table.
 *
 * The returned palette is already resolved to RGB, so it can be indexed
 * directly by a screen pixel's 4-bit colour index.
 *
 * @param egaRaw The raw `EGA:` sub-block bytes (128 bytes for the full table).
 */
export function decodeEgaRemapPalette(egaRaw: Uint8Array): Palette {
  const hw = egaPalette16();
  // Collapse each 16-bit word to its low nibble; take the first 16 as the
  // logical->hardware remap.
  const remap: number[] = [];
  for (let i = 0; i + 1 < egaRaw.length && remap.length < 16; i += 2) {
    remap.push((egaRaw[i] as number) & 0x0f);
  }
  while (remap.length < 16) remap.push(remap.length); // identity fallback

  const rgb = new Uint8Array(16 * 3);
  for (let logical = 0; logical < 16; logical += 1) {
    const hwIndex = (remap[logical] as number) & 0x0f;
    rgb[logical * 3 + 0] = hw.rgb[hwIndex * 3 + 0] ?? 0;
    rgb[logical * 3 + 1] = hw.rgb[hwIndex * 3 + 1] ?? 0;
    rgb[logical * 3 + 2] = hw.rgb[hwIndex * 3 + 2] ?? 0;
  }
  return { count: 16, rgb };
}

/** Result of decoding a `PAL:` container: whichever sub-blocks it carries. */
export interface PalContainer {
  /** The scaled VGA palette, when a `VGA:` sub-block is present. */
  vga?: Palette;
  /** The raw `EGA:` sub-block bytes, when present. */
  egaRaw?: Uint8Array;
  /**
   * The `EGA:` sub-block resolved to a 16-colour RGB palette (via the
   * logical -> hardware remap), when an `EGA:` block is present. This is the
   * palette to index screen pixels against.
   */
  ega?: Palette;
  /** The raw `CGA:` sub-block bytes, when present. */
  cgaRaw?: Uint8Array;
}

/**
 * Parse a whole file's chunk tree and pull out the palette sub-blocks from its
 * first `PAL:` container.
 *
 * @param fileBytes The raw file bytes (e.g. the `ACTIVISI` file).
 */
export function decodePalContainer(fileBytes: Uint8Array): PalContainer {
  const chunks = parseChunks(fileBytes);
  const pal = findChunk(chunks, 'PAL');
  if (pal === undefined) {
    throw new PaletteDecodeError('no PAL: container found in file');
  }
  const out: PalContainer = {};
  const vga = findChunkIn(pal.children, 'VGA');
  const ega = findChunkIn(pal.children, 'EGA');
  const cga = findChunkIn(pal.children, 'CGA');
  if (vga) out.vga = decodeVgaPalette(vga.data);
  if (ega) {
    out.egaRaw = ega.data;
    out.ega = decodeEgaRemapPalette(ega.data);
  }
  if (cga) out.cgaRaw = cga.data;
  return out;
}

/** Find a direct child (or nested) chunk by id within a node list. */
function findChunkIn(nodes: ChunkNode[], id: string): ChunkNode | undefined {
  return findChunk(nodes, id);
}
