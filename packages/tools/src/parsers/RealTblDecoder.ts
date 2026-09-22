/**
 * Real Death Track `.TBL` structure decoder (task 25.8).
 *
 * This decodes the **actual** Dynamix (1989) Death Track `.TBL` files — the
 * per-character car files (`SLY.TBL`, `ANGEL.TBL`, `MYCAR0.TBL`, …) and the
 * shared shape library (`SHAPE.TBL`) — as opposed to {@link TblParser} (which
 * reads a synthetic `TBL1`-magic stat container the tooling itself emits, a
 * format that never matched the real files).
 *
 * ## What is confidently decoded (verified across all 12 real per-car `.TBL`s)
 *
 * A per-car `.TBL` is an **offset-indexed record container**, not the
 * stat-table layout section 4 originally assumed (it has **no ASCII magic**; it
 * opens with the binary words `00 00 01 00 …`). Its confirmed structure:
 *
 * - a fixed **header** whose first `uint16` is a version/flags word (`0x0000`
 *   in every file) and whose byte at `0x10` is a small record-region marker;
 * - at byte **`0x1e`** a **`0xffff`-terminated array of `uint16` file offsets**.
 *   In all 12 files the offsets are strictly monotonic and land inside
 *   `[0, byteLength)`, so they are genuine byte offsets that partition the file
 *   body into a sequence of variable-length **records**. This offset table
 *   drives the decode: consecutive offsets (and the file end) bound each
 *   record's byte slice.
 *
 * `SHAPE.TBL` (the 78 KB shared shape library) is a **larger offset-indexed
 * container** of the same family: a leading table of monotonically increasing
 * offsets (stored as `uint16` in the low half of each 4-byte record) followed
 * by the referenced record data. {@link decodeRealTbl} handles the per-car form;
 * the shape library's leaf format (3D vector meshes) is intentionally left
 * opaque — see below.
 *
 * ## What is deliberately NOT interpreted (no invention)
 *
 * The **meaning of the bytes inside each record** is not decoded. The records
 * are a mix of the car's 3D vector-mesh geometry and (possibly) small
 * attribute/animation blocks; their field semantics are not recoverable from
 * the bytes alone without inventing structure, which the format notes
 * (`research/dynamix-formats.md` §7.3) explicitly forbid. Accordingly this
 * decoder exposes each record as an **opaque byte slice** (offset + length),
 * plus the confirmed header fields and the raw offset table. It never claims a
 * record is "stats" or assigns numeric stat fields. Consumers that only need
 * the container shape (record count, boundaries, round-trip, name→file mapping)
 * are fully served; anyone later reverse-engineering a record's interior can
 * build on the exact slices this returns.
 *
 * Requirements: 4.1, 9.1, 9.5
 */

/** Byte offset at which the `uint16` offset table begins in a per-car `.TBL`. */
export const TBL_OFFSET_TABLE_START = 0x1e;

/** Sentinel `uint16` terminating the offset table. */
export const TBL_OFFSET_TABLE_TERMINATOR = 0xffff;

/** Raised when a real `.TBL` buffer cannot be decoded; carries the byte offset. */
export class RealTblDecodeError extends Error {
  /** Byte offset within the source buffer where the failure was detected. */
  readonly offset: number;

  constructor(message: string, offset = 0) {
    super(`${message} (at byte offset ${offset})`);
    this.name = 'RealTblDecodeError';
    this.offset = offset;
  }
}

/**
 * One decoded record: an opaque byte slice bounded by two consecutive entries
 * of the offset table (the last record runs to the end of the file).
 *
 * The `bytes` are a **view** into the source buffer (no copy). Field semantics
 * inside `bytes` are intentionally not decoded (see the module doc).
 */
export interface RealTblRecord {
  /** Index of this record in the offset table (0-based). */
  index: number;
  /** Byte offset of the record within the file. */
  offset: number;
  /** Length of the record in bytes. */
  length: number;
  /** The record's raw bytes (a subarray view of the source). */
  bytes: Uint8Array;
}

/** The decoded structure of a real per-car `.TBL` file. */
export interface RealTbl {
  /** Total file length in bytes. */
  byteLength: number;
  /** The version/flags `uint16` at offset 0 (`0x0000` in every observed file). */
  versionWord: number;
  /** The small record-region marker byte at offset `0x10`. */
  regionMarker: number;
  /** The raw `uint16` offsets from the table at {@link TBL_OFFSET_TABLE_START}. */
  offsetTable: number[];
  /** Byte offset just past the `0xffff` table terminator. */
  offsetTableEnd: number;
  /** The records the offset table partitions the body into. */
  records: RealTblRecord[];
}

/**
 * Decode a real per-car Death Track `.TBL` buffer into its confirmed container
 * structure: header fields, the `0xffff`-terminated `uint16` offset table at
 * {@link TBL_OFFSET_TABLE_START}, and the record slices those offsets bound.
 *
 * This is a **structure-only** decode: record interiors are returned as opaque
 * byte slices and are never interpreted as stats or mesh fields.
 *
 * @param buf Raw file bytes (`Uint8Array` or Node `Buffer`).
 * @returns The decoded {@link RealTbl} structure.
 * @throws {RealTblDecodeError} If the buffer is too short to hold the header +
 *   an offset table, if the table is not `0xffff`-terminated, or if any offset
 *   is out of bounds or not strictly increasing.
 */
export function decodeRealTbl(buf: Uint8Array): RealTbl {
  if (buf.length < TBL_OFFSET_TABLE_START + 2) {
    throw new RealTblDecodeError(
      `buffer too short (${buf.length} bytes) to hold a .TBL header + offset table`,
      0,
    );
  }

  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const versionWord = view.getUint16(0, true);
  const regionMarker = buf[0x10]!;

  // Read the 0xffff-terminated, strictly-increasing, in-bounds uint16 offsets.
  const offsetTable: number[] = [];
  let p = TBL_OFFSET_TABLE_START;
  let prev = -1;
  for (;;) {
    if (p + 2 > buf.length) {
      throw new RealTblDecodeError('offset table not terminated by 0xffff before end of file', p);
    }
    const v = view.getUint16(p, true);
    if (v === TBL_OFFSET_TABLE_TERMINATOR) {
      p += 2;
      break;
    }
    if (v <= prev) {
      throw new RealTblDecodeError(`offset table not strictly increasing (0x${v.toString(16)} after 0x${prev.toString(16)})`, p);
    }
    if (v >= buf.length) {
      throw new RealTblDecodeError(`offset 0x${v.toString(16)} is out of bounds (file is ${buf.length} bytes)`, p);
    }
    offsetTable.push(v);
    prev = v;
    p += 2;
  }

  if (offsetTable.length === 0) {
    throw new RealTblDecodeError('offset table is empty', TBL_OFFSET_TABLE_START);
  }

  // Partition the body into records: each record runs from its offset to the
  // next offset, and the final record runs to the end of the file.
  const records: RealTblRecord[] = offsetTable.map((offset, index) => {
    const end = index + 1 < offsetTable.length ? offsetTable[index + 1]! : buf.length;
    return {
      index,
      offset,
      length: end - offset,
      bytes: buf.subarray(offset, end),
    };
  });

  return {
    byteLength: buf.length,
    versionWord,
    regionMarker,
    offsetTable,
    offsetTableEnd: p,
    records,
  };
}

/**
 * A compact, human-readable one-line summary of a decoded `.TBL` (for the CLI
 * probe): file size, version word, marker, record count, and the offset range.
 */
export function summarizeRealTbl(name: string, tbl: RealTbl): string {
  const first = tbl.offsetTable[0] ?? 0;
  const last = tbl.offsetTable[tbl.offsetTable.length - 1] ?? 0;
  return (
    `${name}: ${tbl.byteLength} bytes, version=0x${tbl.versionWord.toString(16).padStart(4, '0')}, ` +
    `marker=0x${tbl.regionMarker.toString(16).padStart(2, '0')}, ` +
    `${tbl.records.length} records, offsets 0x${first.toString(16)}..0x${last.toString(16)}`
  );
}
