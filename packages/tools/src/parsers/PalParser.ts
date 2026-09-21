/**
 * Parser for original Deathtrack `.PALS` palette files.
 *
 * A `.PALS` file holds a single 256-colour indexed palette. Each entry is an
 * RGB triple. Original DOS-era VGA palettes stored each channel as a 6-bit
 * value (0–63); this parser detects that convention and scales such values up
 * to the full 8-bit range (0–255) so the resulting palette can be uploaded
 * directly to the WebGL palette-lookup texture.
 *
 * ## Byte layout
 *
 * The design document does not pin down an exact `.PALS` byte layout, so this
 * parser accepts the two forms found in practice:
 *
 * 1. **Raw** — exactly `256 × 3 = 768` bytes of RGB triples, no header.
 * 2. **Headed** — a 4-byte ASCII magic `"PALS"` followed by `256 × 3` RGB
 *    bytes. Any trailing bytes are ignored.
 *
 * Parse errors are reported with the failing byte offset for diagnosis.
 *
 * Requirements: 2.6, 9.1
 */

import { BinaryReader } from '@deathtrack/shared';

/** Number of colour entries in a Deathtrack palette. */
export const PALETTE_ENTRY_COUNT = 256;

/** Number of bytes in a raw (headerless) palette: 256 entries × 3 channels. */
export const RAW_PALETTE_BYTE_LENGTH = PALETTE_ENTRY_COUNT * 3;

/** ASCII magic marker for the headed `.PALS` variant. */
const PALS_MAGIC = 'PALS';

/**
 * A parsed 256-colour palette.
 *
 * `rgb` is a flat `Uint8Array` of length `256 × 3` laid out as
 * `[r0, g0, b0, r1, g1, b1, …]`, matching the `palette` field of `TrackDef`
 * and the format expected by the palette-lookup shader.
 */
export interface PaletteData {
  /** Flat RGB byte array, length `256 × 3 = 768`, channels in 0–255. */
  rgb: Uint8Array;
  /**
   * Whether the source channels were detected as 6-bit VGA values (0–63) and
   * scaled up to 8-bit. Useful for diagnostics and round-trip fidelity.
   */
  wasVga6Bit: boolean;
}

/**
 * Raised when a `.PALS` buffer cannot be parsed. Carries the byte offset at
 * which parsing failed to aid debugging of malformed asset files.
 */
export class PaletteParseError extends Error {
  /** Byte offset within the source buffer where the failure was detected. */
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`PalParser: ${message} (at byte offset ${offset})`);
    this.name = 'PaletteParseError';
    this.offset = offset;
  }
}

/**
 * Scale a 6-bit VGA channel value (0–63) up to the full 8-bit range (0–255).
 * The scaling `(v << 2) | (v >> 4)` maps 63 → 255 and 0 → 0 evenly.
 */
function scale6to8(value: number): number {
  return ((value << 2) | (value >> 4)) & 0xff;
}

/**
 * Parse a `.PALS` palette file into a 256-colour RGB palette.
 *
 * @param buf The raw `.PALS` file contents.
 * @returns The decoded {@link PaletteData}.
 * @throws {PaletteParseError} If the buffer is too short or otherwise malformed.
 *
 * Requirements: 2.6, 9.1
 */
export function parsePalette(buf: Buffer): PaletteData {
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const reader = new BinaryReader(bytes);

  // Detect and skip an optional "PALS" magic header.
  let dataStart = 0;
  if (bytes.byteLength >= PALS_MAGIC.length) {
    const magic = reader.fixedString(PALS_MAGIC.length);
    if (magic === PALS_MAGIC) {
      dataStart = PALS_MAGIC.length;
    }
    // If the magic does not match, treat the file as raw; reset the reader.
  }

  const available = bytes.byteLength - dataStart;
  if (available < RAW_PALETTE_BYTE_LENGTH) {
    throw new PaletteParseError(
      `expected ${RAW_PALETTE_BYTE_LENGTH} palette bytes but only ${available} remain after header`,
      dataStart,
    );
  }

  const raw = bytes.subarray(dataStart, dataStart + RAW_PALETTE_BYTE_LENGTH);

  // Detect the VGA 6-bit convention: if every channel value is ≤ 63 the palette
  // is almost certainly 6-bit and must be scaled to 8-bit.
  let wasVga6Bit = true;
  for (let i = 0; i < raw.length; i += 1) {
    if ((raw[i] as number) > 63) {
      wasVga6Bit = false;
      break;
    }
  }

  const rgb = new Uint8Array(RAW_PALETTE_BYTE_LENGTH);
  for (let i = 0; i < RAW_PALETTE_BYTE_LENGTH; i += 1) {
    const channel = raw[i] as number;
    rgb[i] = wasVga6Bit ? scale6to8(channel) : channel;
  }

  return { rgb, wasVga6Bit };
}
