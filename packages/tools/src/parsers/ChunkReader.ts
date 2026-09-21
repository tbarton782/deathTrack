/**
 * `ChunkReader` for the Dynamix RES chunk tree used by the real Death Track
 * (Dynamix, 1994) game files.
 *
 * Every chunk has a fixed 8-byte header followed by its data:
 *
 * ```
 * offset 0  char[4]  contentType    3-char ASCII ID + ':'  (e.g. "PAL:", "BIN:")
 * offset 4  uint32   isFolder_length  bit 31 = container flag, low 31 bits = data length
 * offset 8  byte[N]  data             N = low 31 bits
 * ```
 *
 * When the container flag is set, `data` is itself a sequence of nested chunks
 * and is parsed recursively. Otherwise `data` is a raw/compressed leaf payload.
 *
 * All multi-byte integers are little-endian.
 *
 * See `research/dynamix-formats.md` section 1.
 *
 * Requirements: 9.1, 9.5
 */

/** The container-flag bit in the length word (most-significant bit). */
const CONTAINER_FLAG = 0x80000000;

/** Mask for the low 31 length bits. */
const LENGTH_MASK = 0x7fffffff;

/** Size of a chunk header in bytes: 4-byte ID + 4-byte length word. */
export const CHUNK_HEADER_SIZE = 8;

/** A parsed node in the Dynamix RES chunk tree. */
export interface ChunkNode {
  /** 3-character ASCII ID with the trailing ':' stripped, e.g. "PAL", "BIN". */
  id: string;
  /** Whether this chunk is a container of nested chunks. */
  isContainer: boolean;
  /** Length of this chunk's data (low 31 bits of the length word). */
  length: number;
  /**
   * Raw bytes of this chunk's payload. For a container this is the concatenated
   * bytes of its children; for a leaf it is the raw/compressed payload.
   */
  data: Uint8Array;
  /** Byte offset of this chunk's header within the original buffer. */
  offset: number;
  /** Nested chunks, populated when {@link isContainer} is `true`. */
  children: ChunkNode[];
}

/** An error raised while parsing a malformed chunk tree; carries the byte offset. */
export class ChunkParseError extends Error {
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`${message} (at byte offset ${offset})`);
    this.name = 'ChunkParseError';
    this.offset = offset;
  }
}

/**
 * Normalise the incoming buffer to a `Uint8Array` view without copying.
 */
function toBytes(input: Uint8Array | ArrayBuffer | Buffer): Uint8Array {
  if (input instanceof Uint8Array) return input;
  return new Uint8Array(input);
}

/**
 * Decode the 4-byte content type into a 3-character ID. The real files use a
 * 3-character ASCII ID followed by ':'; we validate the shape and strip the
 * colon.
 */
function readChunkId(bytes: Uint8Array, offset: number): string {
  const b0 = bytes[offset];
  const b1 = bytes[offset + 1];
  const b2 = bytes[offset + 2];
  const b3 = bytes[offset + 3];
  if (b3 !== 0x3a /* ':' */) {
    throw new ChunkParseError(
      `expected ':' at byte 3 of chunk tag but found 0x${(b3 ?? 0).toString(16).padStart(2, '0')}`,
      offset + 3,
    );
  }
  // Content IDs are printable ASCII; guard against reading arbitrary binary as a tag.
  for (const [i, b] of [b0, b1, b2].entries()) {
    if (b === undefined || b < 0x20 || b > 0x7e) {
      throw new ChunkParseError(
        `non-ASCII byte 0x${(b ?? 0).toString(16).padStart(2, '0')} in chunk tag`,
        offset + i,
      );
    }
  }
  // The loop above proves b0..b2 are defined printable bytes.
  return String.fromCharCode(b0 as number, b1 as number, b2 as number);
}

/**
 * Parse a sequence of sibling chunks occupying `[start, end)` within `bytes`.
 *
 * @param bytes  The full backing buffer.
 * @param start  Offset of the first chunk header.
 * @param end    Exclusive end offset (the parent's data boundary or buffer end).
 * @returns The parsed sibling chunks in order.
 * @throws {ChunkParseError} On a truncated header or a child length that
 *   overruns the available bytes.
 */
function parseChunkSequence(bytes: Uint8Array, start: number, end: number): ChunkNode[] {
  const nodes: ChunkNode[] = [];
  let cursor = start;

  while (cursor < end) {
    if (cursor + CHUNK_HEADER_SIZE > end) {
      throw new ChunkParseError(
        `truncated chunk header: need ${CHUNK_HEADER_SIZE} bytes but only ${end - cursor} remain`,
        cursor,
      );
    }

    const id = readChunkId(bytes, cursor);

    // uint32 little-endian length word at offset+4. The header-size check above
    // guarantees these four bytes are in range.
    const lengthWord =
      ((bytes[cursor + 4] as number) |
        ((bytes[cursor + 5] as number) << 8) |
        ((bytes[cursor + 6] as number) << 16) |
        ((bytes[cursor + 7] as number) << 24)) >>>
      0;

    const isContainer = (lengthWord & CONTAINER_FLAG) !== 0;
    const length = lengthWord & LENGTH_MASK;

    const dataStart = cursor + CHUNK_HEADER_SIZE;
    const dataEnd = dataStart + length;
    if (dataEnd > end) {
      throw new ChunkParseError(
        `chunk "${id}" declares ${length} bytes but only ${end - dataStart} remain in parent`,
        cursor + 4,
      );
    }

    const data = bytes.subarray(dataStart, dataEnd);
    const children = isContainer ? parseChunkSequence(bytes, dataStart, dataEnd) : [];

    nodes.push({ id, isContainer, length, data, offset: cursor, children });

    cursor = dataEnd;
  }

  return nodes;
}

/**
 * Parse a whole Dynamix RES chunk-tree buffer into its top-level chunk nodes.
 *
 * @param input The raw file bytes.
 * @returns The top-level chunks, each with recursively-parsed children.
 * @throws {ChunkParseError} On malformed input, with the failing byte offset.
 * Requirements: 9.1, 9.5
 */
export function parseChunks(input: Uint8Array | ArrayBuffer | Buffer): ChunkNode[] {
  const bytes = toBytes(input);
  return parseChunkSequence(bytes, 0, bytes.length);
}

/**
 * Depth-first search for the first chunk with the given `id` anywhere in the
 * tree. Convenience for locating a known sub-block such as "VGA" or "BIN".
 *
 * @param nodes Top-level nodes (from {@link parseChunks}) to search.
 * @param id    The 3-character ID to find (colon stripped).
 * @returns The first matching node, or `undefined` if none is present.
 */
export function findChunk(nodes: ChunkNode[], id: string): ChunkNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    const nested = findChunk(node.children, id);
    if (nested !== undefined) return nested;
  }
  return undefined;
}
