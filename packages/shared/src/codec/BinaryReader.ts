/**
 * Low-level binary reader for the shared binary codec.
 *
 * Provides sequential little-endian reads that mirror `BinaryWriter`, so that a
 * buffer produced by the writer decodes back into identical values. Supports
 * the fixed-width primitive types, fixed-length strings, and nested struct
 * decoding used by network packets and save files.
 *
 * Requirements: 8.7, 12.4
 */

/** Decoder used to turn fixed-length UTF-8 fields back into strings. */
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * A sequential binary reader consuming a `Uint8Array` produced by
 * `BinaryWriter`. Reads advance an internal cursor and throw `RangeError` when
 * a read would run past the end of the buffer.
 */
export class BinaryReader {
  private readonly view: DataView;
  private readonly byteLength: number;
  private offset: number;

  /**
   * @param source The bytes to read from.
   * @param byteOffset Optional starting offset within `source`.
   */
  constructor(source: Uint8Array, byteOffset = 0) {
    this.view = new DataView(source.buffer, source.byteOffset, source.byteLength);
    this.byteLength = source.byteLength;
    this.offset = byteOffset;
  }

  /** The current read cursor position in bytes. */
  get position(): number {
    return this.offset;
  }

  /** The number of unread bytes remaining. */
  get remaining(): number {
    return this.byteLength - this.offset;
  }

  /** Whether the cursor has consumed the entire buffer. */
  get atEnd(): boolean {
    return this.offset >= this.byteLength;
  }

  /** Guard that at least `size` more bytes are available before reading. */
  private require(size: number): void {
    if (this.offset + size > this.byteLength) {
      throw new RangeError(
        `BinaryReader: attempted to read ${size} byte(s) at offset ${this.offset}, ` +
          `but only ${this.remaining} byte(s) remain`,
      );
    }
  }

  /** Read an unsigned 8-bit integer. */
  uint8(): number {
    this.require(1);
    const value = this.view.getUint8(this.offset);
    this.offset += 1;
    return value;
  }

  /** Read an unsigned 16-bit integer, little-endian. */
  uint16(): number {
    this.require(2);
    const value = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return value;
  }

  /** Read a signed 16-bit integer, little-endian. */
  int16(): number {
    this.require(2);
    const value = this.view.getInt16(this.offset, true);
    this.offset += 2;
    return value;
  }

  /** Read an unsigned 32-bit integer, little-endian. */
  uint32(): number {
    this.require(4);
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /** Read a signed 32-bit integer, little-endian. */
  int32(): number {
    this.require(4);
    const value = this.view.getInt32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /** Read a 32-bit IEEE-754 float, little-endian. */
  float32(): number {
    this.require(4);
    const value = this.view.getFloat32(this.offset, true);
    this.offset += 4;
    return value;
  }

  /** Read a 64-bit IEEE-754 float, little-endian. */
  float64(): number {
    this.require(8);
    const value = this.view.getFloat64(this.offset, true);
    this.offset += 8;
    return value;
  }

  /**
   * Read a fixed-length UTF-8 string field occupying exactly `byteLength`
   * bytes. Trailing NUL padding written by `BinaryWriter.fixedString` is
   * stripped, reproducing the original string.
   */
  fixedString(byteLength: number): string {
    if (byteLength < 0 || (byteLength | 0) !== byteLength) {
      throw new RangeError(`fixedString byteLength must be a non-negative integer, got ${byteLength}`);
    }
    this.require(byteLength);
    const bytes = new Uint8Array(this.view.buffer, this.view.byteOffset + this.offset, byteLength);
    // Determine the unpadded length by trimming trailing NUL bytes.
    let end = byteLength;
    while (end > 0 && bytes[end - 1] === 0) {
      end -= 1;
    }
    const value = utf8Decoder.decode(bytes.subarray(0, end));
    this.offset += byteLength;
    return value;
  }

  /**
   * Read `byteLength` raw bytes as a copied `Uint8Array`. Useful for extracting
   * a pre-encoded nested struct region.
   */
  bytes(byteLength: number): Uint8Array {
    this.require(byteLength);
    const out = new Uint8Array(
      this.view.buffer.slice(
        this.view.byteOffset + this.offset,
        this.view.byteOffset + this.offset + byteLength,
      ),
    );
    this.offset += byteLength;
    return out;
  }

  /**
   * Read a nested struct by delegating to a callback that receives this same
   * reader. The callback must decode the struct's fields in the identical order
   * they were written by the corresponding `BinaryWriter.struct` call.
   */
  struct<T>(read: (reader: BinaryReader) => T): T {
    return read(this);
  }
}
