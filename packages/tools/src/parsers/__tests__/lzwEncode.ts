/**
 * Test-only reference LZW encoder that mirrors the exact conventions of the
 * Dynamix / Stellar 7 RES LZW decoder in `../decompress.ts`, as confirmed by
 * decoding the real Death Track files:
 *
 * - variable width 9..12 bits, packed little-endian (LSB-first) at the bit level
 * - dictionary seeded with codes 0..255 (bytes) + 256 (reset); the first
 *   dynamically-assigned entry is code 257
 * - the code width grows the instant the next entry index reaches `2^width`
 *   (512 -> 10 bits, 1024 -> 11 bits, 2048 -> 12 bits)
 * - the dictionary freezes at 4096 entries
 *
 * This encoder generates byte-exact test vectors so the decoder can be
 * validated by an encode -> decode -> original round-trip. It is NOT part of
 * the shipped decoder path.
 */

const LZW_MIN_WIDTH = 9;
const LZW_MAX_WIDTH = 12;
const LZW_FIRST_CODE = 257;
const LZW_MAX_CODES = 1 << LZW_MAX_WIDTH;

/** Little-endian (LSB-first) bit writer matching the decoder's bit order. */
export class LittleEndianBitWriter {
  private readonly bytes: number[] = [];
  private cur = 0;
  private bitCount = 0;

  write(value: number, width: number): void {
    for (let i = 0; i < width; i += 1) {
      const bit = (value >> i) & 1;
      this.cur |= bit << this.bitCount;
      this.bitCount += 1;
      if (this.bitCount === 8) {
        this.bytes.push(this.cur & 0xff);
        this.cur = 0;
        this.bitCount = 0;
      }
    }
  }

  finish(): Uint8Array {
    if (this.bitCount > 0) {
      this.bytes.push(this.cur & 0xff);
      this.cur = 0;
      this.bitCount = 0;
    }
    return Uint8Array.from(this.bytes);
  }
}

/**
 * Encode `input` into a Dynamix-compatible LZW bit stream (without the 5-byte
 * leaf header). Does not emit reset codes; the dictionary grows and freezes at
 * the ceiling, which the decoder handles symmetrically.
 */
export function lzwEncode(input: Uint8Array): Uint8Array {
  const writer = new LittleEndianBitWriter();

  // Encoder-side dictionary (string -> code) for LZW string matching.
  const dict = new Map<string, number>();
  for (let i = 0; i < 256; i += 1) dict.set(String.fromCharCode(i), i);
  let encNextCode = LZW_FIRST_CODE;

  // Decoder-side width schedule simulator. The decoder inserts a new entry only
  // once it has a previous string (i.e. from its second emitted code onward)
  // and widens the moment its own `nextCode` reaches `2^width`. Because that
  // insertion lags the encoder's by one code, we replay the decoder's exact
  // state here so every code is written at the width the decoder will read it.
  let decNextCode = LZW_FIRST_CODE;
  let decWidth = LZW_MIN_WIDTH;
  let emittedCount = 0;

  const key = (arr: number[]): string => String.fromCharCode(...arr);

  /** Write one code at the decoder's current read-width, then advance the
   * decoder's simulated dictionary/width exactly as the decoder will. */
  const emitCode = (code: number): void => {
    writer.write(code, decWidth);
    emittedCount += 1;
    // The decoder inserts its (emittedCount-1)-th dynamic entry after the 2nd
    // code onward; mirror that single-code lag.
    if (emittedCount >= 2 && decNextCode < LZW_MAX_CODES) {
      decNextCode += 1;
      if (decNextCode === 1 << decWidth && decWidth < LZW_MAX_WIDTH) {
        decWidth += 1;
      }
    }
  };

  if (input.length === 0) return writer.finish();

  let current: number[] = [input[0] as number];

  for (let i = 1; i < input.length; i += 1) {
    const byte = input[i] as number;
    const combined = [...current, byte];
    if (dict.has(key(combined))) {
      current = combined;
    } else {
      emitCode(dict.get(key(current))!);
      if (encNextCode < LZW_MAX_CODES) {
        dict.set(key(combined), encNextCode);
        encNextCode += 1;
      }
      current = [byte];
    }
  }

  emitCode(dict.get(key(current))!);
  return writer.finish();
}
