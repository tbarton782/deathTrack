/**
 * Shared decompressors for Dynamix RES compressed leaf entries, used by the
 * real Death Track (Dynamix, 1994) game files.
 *
 * A compressed leaf begins with a small header, then the compressed bytes:
 *
 * ```
 * offset 0  uint8   compressionType   0x00 none, 0x01 RLE, 0x02 LZW, 0x03 LH1
 * offset 1  uint32  decompressedSize  size of the output buffer in bytes
 * offset 5  byte[]  compressedData    remainder of the leaf
 * ```
 *
 * This module exposes one entry point per method plus a {@link decompress}
 * dispatcher keyed on the leading `compressionType` byte.
 *
 * See `research/dynamix-formats.md` section 2.
 *
 * Requirements: 9.5
 */

/** Compression method discriminators used in the leaf header. */
export enum CompressionType {
  None = 0x00,
  Rle = 0x01,
  Lzw = 0x02,
  Lh1 = 0x03,
}

/** Error raised when decompression fails or produces the wrong output length. */
export class DecompressError extends Error {
  readonly offset: number;

  constructor(message: string, offset = 0) {
    super(offset > 0 ? `${message} (at byte offset ${offset})` : message);
    this.name = 'DecompressError';
    this.offset = offset;
  }
}

// ---------------------------------------------------------------------------
// Method 0x01 — RLE (Dynamix font RLE)
// ---------------------------------------------------------------------------

/**
 * Decompress the Dynamix code-based RLE stream.
 *
 * For each code byte: if the high bit is set it is a Repeat (low 7 bits = count
 * `n`, followed by one byte emitted `n` times); otherwise it is a Copy (low 7
 * bits = count `n`, followed by `n` verbatim bytes).
 *
 * @param src               The compressed bytes (after the 5-byte leaf header).
 * @param decompressedSize  Expected output length.
 * @returns The decompressed bytes.
 */
export function rleDecompress(src: Uint8Array, decompressedSize: number): Uint8Array {
  const out = new Uint8Array(decompressedSize);
  let sp = 0;
  let dp = 0;

  while (dp < decompressedSize) {
    if (sp >= src.length) {
      throw new DecompressError('RLE: input exhausted before output filled', sp);
    }
    const code = src[sp++] as number;
    const count = code & 0x7f;
    if ((code & 0x80) !== 0) {
      // Repeat: next byte emitted `count` times.
      if (sp >= src.length) throw new DecompressError('RLE: missing repeat byte', sp);
      const value = src[sp++] as number;
      for (let i = 0; i < count && dp < decompressedSize; i += 1) out[dp++] = value;
    } else {
      // Copy: `count` verbatim bytes.
      for (let i = 0; i < count && dp < decompressedSize; i += 1) {
        if (sp >= src.length) throw new DecompressError('RLE: input exhausted mid-copy', sp);
        out[dp++] = src[sp++] as number;
      }
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// Method 0x02 — LZW (Dynamix variable-width, little-endian bit packing)
// ---------------------------------------------------------------------------

const LZW_MIN_WIDTH = 9;
const LZW_MAX_WIDTH = 12;
/** Dictionary-reset / clear signal code. */
const LZW_RESET = 256;
/**
 * First code assigned to a new dictionary entry / first emitted dynamic code.
 * The dictionary is seeded with codes 0..255 (single bytes) plus code 256
 * (reset), so the first dynamically-assigned entry is 257.
 */
const LZW_FIRST_CODE = 257;
/** Dictionary size ceiling: the 12-bit code space (0..4095). */
const LZW_MAX_CODES = 1 << LZW_MAX_WIDTH;

/**
 * A little-endian (LSB-first) bit reader over a byte buffer. Within each byte
 * the least-significant bit is consumed first, and a codeword's low bits come
 * from earlier bit positions. This matches the real Death Track / Stellar 7
 * Dynamix RES LZW streams, confirmed by decoding the actual game files (see
 * `research/dynamix-formats.md` section 2.2 and the decode verified against
 * `CAR1.SCR`).
 */
class LittleEndianBitReader {
  private bitPos = 0;

  constructor(private readonly src: Uint8Array) {}

  /** Whether `width` more bits are available. */
  hasBits(width: number): boolean {
    return this.bitPos + width <= this.src.length * 8;
  }

  /** Read `width` bits (1..24) as an unsigned integer, LSB-first. */
  read(width: number): number {
    let result = 0;
    for (let i = 0; i < width; i += 1) {
      const byteIndex = this.bitPos >> 3;
      const bitIndex = this.bitPos & 7;
      const bit = ((this.src[byteIndex] as number) >> bitIndex) & 1;
      result |= bit << i;
      this.bitPos += 1;
    }
    return result >>> 0;
  }

  /** Total bits consumed so far. */
  get bitsConsumed(): number {
    return this.bitPos;
  }
}

/**
 * Decompress the Dynamix variable-width LZW stream (the Stellar 7 RES variant
 * that Death Track's files inherit).
 *
 * Codes are 9–12 bits, packed little-endian at the bit level. The dictionary is
 * seeded with the 256 single-byte values plus code 256 (reset/clear); the first
 * dynamically-assigned entry is 257. The code width grows from 9 toward 12 bits
 * the moment the next entry index reaches `2^width` (so 512 -> 10 bits,
 * 1024 -> 11 bits, 2048 -> 12 bits), and the dictionary stops growing at 4096
 * entries. Code 256 clears the dictionary back to its seed state and 9-bit
 * width.
 *
 * On a reset (code 256), the divisible-by-8 skip rule applies: reset codes are
 * emitted in blocks of 8 codewords, so any remaining codewords in the current
 * block are padding and are discarded before decoding resumes.
 *
 * This convention (LSB-first, first code 257, grow at `2^width`, divisible-by-8
 * reset) was determined empirically by decoding the real Death Track LZW leaves
 * to their exact declared lengths; unit tests lock it in against `CAR1.SCR`
 * (no reset) and `CITYPIC.SCR` (dictionary-full reset).
 *
 * @param src               Compressed bytes (after the 5-byte leaf header).
 * @param decompressedSize  Expected output length.
 * @returns The decompressed bytes.
 */
export function lzwDecompress(src: Uint8Array, decompressedSize: number): Uint8Array {
  const out = new Uint8Array(decompressedSize);
  let dp = 0;

  const reader = new LittleEndianBitReader(src);

  // Dictionary: each entry maps a code to a byte sequence.
  let dict: Uint8Array[] = [];
  let width = LZW_MIN_WIDTH;
  let nextCode = LZW_FIRST_CODE;
  let prev: Uint8Array | null = null;
  // Count of codewords read since the last reset (or stream start), used to
  // apply the divisible-by-8 skip rule on reset (see below).
  let codesSinceReset = 0;

  const resetState = (): void => {
    dict = new Array<Uint8Array>(LZW_FIRST_CODE);
    for (let i = 0; i < 256; i += 1) dict[i] = Uint8Array.of(i);
    dict[LZW_RESET] = new Uint8Array(0); // 256 = reset marker
    width = LZW_MIN_WIDTH;
    nextCode = LZW_FIRST_CODE;
    prev = null;
    codesSinceReset = 0;
  };

  const emit = (bytes: Uint8Array): void => {
    for (let i = 0; i < bytes.length; i += 1) {
      if (dp >= decompressedSize) return;
      out[dp++] = bytes[i] as number;
    }
  };

  resetState();

  while (dp < decompressedSize) {
    if (!reader.hasBits(width)) {
      throw new DecompressError(
        `LZW: input exhausted after ${dp}/${decompressedSize} bytes`,
        reader.bitsConsumed >> 3,
      );
    }

    const code = reader.read(width);
    codesSinceReset += 1;

    if (code === LZW_RESET) {
      // Divisible-by-8 skip rule: the encoder emits reset codes in blocks of 8
      // codewords, so after a reset any remaining codewords in the current
      // block of 8 are padding and must be discarded before decoding resumes.
      // (Confirmed against the real CITYPIC.SCR stream, which triggers a
      // dictionary-full reset; CAR1.SCR never resets so did not exercise this.)
      while (codesSinceReset % 8 !== 0 && reader.hasBits(width)) {
        reader.read(width);
        codesSinceReset += 1;
      }
      resetState();
      continue;
    }

    let entry: Uint8Array;
    if (code < nextCode && dict[code] !== undefined) {
      entry = dict[code] as Uint8Array;
    } else if (code === nextCode && prev !== null) {
      // KwKwK special case: new entry is prev + prev[0].
      entry = concat(prev, prev.subarray(0, 1));
    } else {
      throw new DecompressError(
        `LZW: invalid code ${code} (nextCode=${nextCode})`,
        reader.bitsConsumed >> 3,
      );
    }

    emit(entry);

    // Add prev + entry[0] as a new dictionary entry once we have a previous
    // string, freezing the dictionary at the 4096-entry ceiling. The code width
    // grows the instant the next entry index reaches `2^width`.
    if (prev !== null && nextCode < LZW_MAX_CODES) {
      dict[nextCode] = concat(prev, entry.subarray(0, 1));
      nextCode += 1;
      if (nextCode === 1 << width && width < LZW_MAX_WIDTH) {
        width += 1;
      }
    }

    prev = entry;
  }

  return out;
}

/** Concatenate two byte arrays into a new one. */
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const r = new Uint8Array(a.length + b.length);
  r.set(a, 0);
  r.set(b, a.length);
  return r;
}

// ---------------------------------------------------------------------------
// Method 0x03 — LH1 (LHA 'lh1' method: LZSS + adaptive Huffman)
// ---------------------------------------------------------------------------

/**
 * Decompress the LHA `lh1` stream (LZSS + dynamic/adaptive Huffman).
 *
 * This is a placeholder that faithfully validates the interface but is not yet
 * implemented; it will be filled in when an `lh1`-compressed leaf is actually
 * encountered in the pipeline. Throwing keeps callers from silently trusting a
 * wrong result.
 *
 * @throws {DecompressError} Always, until implemented.
 */
export function lh1Decompress(_src: Uint8Array, _decompressedSize: number): Uint8Array {
  throw new DecompressError('LH1 (lh1) decompression is not yet implemented');
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

/** A compressed leaf split into its method, expected size, and payload. */
export interface CompressedLeaf {
  type: CompressionType;
  decompressedSize: number;
  data: Uint8Array;
}

/**
 * Split a compressed leaf payload into its 5-byte header fields and the
 * remaining compressed bytes.
 *
 * @param leaf The full leaf bytes (starting at the `compressionType` byte).
 */
export function parseCompressedLeaf(leaf: Uint8Array): CompressedLeaf {
  if (leaf.length < 5) {
    throw new DecompressError('compressed leaf shorter than 5-byte header', 0);
  }
  const type = leaf[0] as CompressionType;
  const decompressedSize =
    ((leaf[1] as number) |
      ((leaf[2] as number) << 8) |
      ((leaf[3] as number) << 16) |
      ((leaf[4] as number) << 24)) >>>
    0;
  return { type, decompressedSize, data: leaf.subarray(5) };
}

/**
 * Decompress a compressed leaf payload by reading its header and dispatching on
 * the `compressionType` byte. Verifies the produced length matches the header's
 * `decompressedSize`.
 *
 * @param leaf The full leaf bytes (starting at the `compressionType` byte).
 * @returns The decompressed output.
 * Requirements: 9.5
 */
export function decompress(leaf: Uint8Array): Uint8Array {
  const { type, decompressedSize, data } = parseCompressedLeaf(leaf);

  let out: Uint8Array;
  switch (type) {
    case CompressionType.None:
      out = data.subarray(0, decompressedSize);
      if (out.length !== decompressedSize) {
        throw new DecompressError(
          `uncompressed leaf has ${out.length} bytes but header declares ${decompressedSize}`,
        );
      }
      return out.slice();
    case CompressionType.Rle:
      out = rleDecompress(data, decompressedSize);
      break;
    case CompressionType.Lzw:
      out = lzwDecompress(data, decompressedSize);
      break;
    case CompressionType.Lh1:
      out = lh1Decompress(data, decompressedSize);
      break;
    default:
      throw new DecompressError(`unknown compression type 0x${(type as number).toString(16)}`);
  }

  if (out.length !== decompressedSize) {
    throw new DecompressError(
      `decompressed length ${out.length} != declared ${decompressedSize}`,
    );
  }
  return out;
}
