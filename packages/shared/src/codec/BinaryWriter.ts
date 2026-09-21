/**
 * Low-level binary writer for the shared binary codec.
 *
 * Provides sequential little-endian writes for the fixed-width primitive types
 * used by network packets and save files, plus fixed-length string and nested
 * struct helpers. The writer grows an internal buffer as needed and produces a
 * `Uint8Array` view over exactly the bytes written.
 *
 * All multi-byte values are encoded little-endian for a stable, deterministic
 * byte layout that survives the encode -> decode round-trip.
 *
 * Requirements: 8.7, 12.4
 */

/** Number of bytes a UTF-8 encoded string may occupy is bounded by the field width. */
const utf8Encoder = new TextEncoder();

/**
 * A growable, sequential binary writer producing little-endian output.
 *
 * Typical usage:
 * ```ts
 * const w = new BinaryWriter();
 * w.uint32(0x4454_5241);
 * w.float32(1.5);
 * const bytes = w.toUint8Array();
 * ```
 */
export class BinaryWriter {
  private buffer: ArrayBuffer;
  private view: DataView;
  private offset = 0;

  /**
   * @param initialCapacity Initial backing-buffer size in bytes. The buffer
   *   grows automatically when writes exceed the current capacity.
   */
  constructor(initialCapacity = 256) {
    const capacity = Math.max(1, initialCapacity | 0);
    this.buffer = new ArrayBuffer(capacity);
    this.view = new DataView(this.buffer);
  }

  /** The number of bytes written so far. */
  get length(): number {
    return this.offset;
  }

  /** Ensure the backing buffer can hold at least `additional` more bytes. */
  private ensure(additional: number): void {
    const required = this.offset + additional;
    if (required <= this.buffer.byteLength) {
      return;
    }
    let newCapacity = this.buffer.byteLength * 2;
    while (newCapacity < required) {
      newCapacity *= 2;
    }
    const next = new ArrayBuffer(newCapacity);
    new Uint8Array(next).set(new Uint8Array(this.buffer, 0, this.offset));
    this.buffer = next;
    this.view = new DataView(next);
  }

  /** Write an unsigned 8-bit integer (0–255). */
  uint8(value: number): this {
    this.ensure(1);
    this.view.setUint8(this.offset, value);
    this.offset += 1;
    return this;
  }

  /** Write an unsigned 16-bit integer (0–65535), little-endian. */
  uint16(value: number): this {
    this.ensure(2);
    this.view.setUint16(this.offset, value, true);
    this.offset += 2;
    return this;
  }

  /** Write a signed 16-bit integer (-32768–32767), little-endian. */
  int16(value: number): this {
    this.ensure(2);
    this.view.setInt16(this.offset, value, true);
    this.offset += 2;
    return this;
  }

  /** Write an unsigned 32-bit integer, little-endian. */
  uint32(value: number): this {
    this.ensure(4);
    this.view.setUint32(this.offset, value, true);
    this.offset += 4;
    return this;
  }

  /** Write a signed 32-bit integer, little-endian. */
  int32(value: number): this {
    this.ensure(4);
    this.view.setInt32(this.offset, value, true);
    this.offset += 4;
    return this;
  }

  /** Write a 32-bit IEEE-754 float, little-endian. */
  float32(value: number): this {
    this.ensure(4);
    this.view.setFloat32(this.offset, value, true);
    this.offset += 4;
    return this;
  }

  /** Write a 64-bit IEEE-754 float, little-endian. */
  float64(value: number): this {
    this.ensure(8);
    this.view.setFloat64(this.offset, value, true);
    this.offset += 8;
    return this;
  }

  /**
   * Write a fixed-length UTF-8 string field occupying exactly `byteLength`
   * bytes. The string is UTF-8 encoded; if the encoding is shorter than
   * `byteLength` the remainder is zero-padded, and if it is longer the write is
   * rejected to avoid silent truncation that would break the round-trip.
   *
   * @throws RangeError if the UTF-8 encoding exceeds `byteLength`.
   */
  fixedString(value: string, byteLength: number): this {
    if (byteLength < 0 || (byteLength | 0) !== byteLength) {
      throw new RangeError(`fixedString byteLength must be a non-negative integer, got ${byteLength}`);
    }
    const encoded = utf8Encoder.encode(value);
    if (encoded.byteLength > byteLength) {
      throw new RangeError(
        `fixedString value encodes to ${encoded.byteLength} bytes, exceeding the ${byteLength}-byte field`,
      );
    }
    this.ensure(byteLength);
    const dest = new Uint8Array(this.buffer, this.offset, byteLength);
    dest.set(encoded);
    // Remaining bytes are already zero from the fresh ArrayBuffer allocation,
    // but explicitly clear them in case the region was previously written.
    dest.fill(0, encoded.byteLength);
    this.offset += byteLength;
    return this;
  }

  /**
   * Write raw bytes verbatim. Useful for embedding pre-encoded nested structs.
   */
  bytes(source: Uint8Array): this {
    this.ensure(source.byteLength);
    new Uint8Array(this.buffer, this.offset, source.byteLength).set(source);
    this.offset += source.byteLength;
    return this;
  }

  /**
   * Write a nested struct by delegating to a callback that receives this same
   * writer. The struct's fields are appended inline at the current offset, so
   * the reader must decode them in the identical field order.
   */
  struct(write: (writer: BinaryWriter) => void): this {
    write(this);
    return this;
  }

  /**
   * Produce a `Uint8Array` view over exactly the bytes written so far. The
   * returned array is a copy and is safe to retain independently of the writer.
   */
  toUint8Array(): Uint8Array {
    return new Uint8Array(this.buffer.slice(0, this.offset));
  }
}
