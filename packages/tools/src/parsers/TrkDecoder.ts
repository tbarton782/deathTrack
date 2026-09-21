/**
 * Track (`.TRK`) decoder for the real Death Track (Dynamix, 1989) files.
 *
 * Death Track `.TRK` files are a **raw** payload (not the Dynamix chunk
 * container): they open with the 4-byte ASCII tag `"TRK:"` followed immediately
 * by binary geometry. (The chunk-tree probe confirmed the `uint32` after the
 * tag is not a valid chunk length, so these are not chunk-wrapped.)
 *
 * What is confidently decoded here — verified consistent across **all 10**
 * real tracks:
 *
 * - the `"TRK:"` tag;
 * - the body is an even-length little-endian **int16 stream**;
 * - it begins with a run of 4-byte **`(dx, distance)` pairs** — a small signed
 *   lateral offset (observed range roughly `-16..25`) paired with a
 *   monotonically non-decreasing cumulative `distance`. This is the road
 *   **centerline / curvature profile**.
 *
 * What is **not** decoded (deliberately left raw): the format continues with
 * additional undocumented sections — per `research/dynamix-formats.md` §7.1 the
 * `.TRK` payload also carries the AI **waypoint graph**, **jump ramps**, **pit
 * lane**, **hazard zones** and **scenery placements**. Their exact byte layouts
 * could not be confirmed against the files without inventing structure (which
 * the format notes explicitly forbid), so the remaining bytes are exposed as an
 * opaque `tail` and as the raw int16 stream for later reverse engineering,
 * rather than guessed at. The decoder still guarantees every track parses
 * without error.
 *
 * Requirements: 9.1, 9.2, 9.5
 */

/** The 4-byte ASCII tag every `.TRK` file starts with. */
export const TRK_TAG = 'TRK:';

/** Error raised when a track cannot be decoded; carries the byte offset. */
export class TrkDecodeError extends Error {
  readonly offset: number;
  constructor(message: string, offset = 0) {
    super(`${message} (at byte offset ${offset})`);
    this.name = 'TrkDecodeError';
    this.offset = offset;
  }
}

/** A single centerline sample: a lateral offset and a cumulative distance. */
export interface CenterlinePoint {
  /** Small signed lateral offset / curvature term for this segment. */
  dx: number;
  /** Cumulative distance along the track (monotonically non-decreasing). */
  distance: number;
}

/** A decoded track. */
export interface TrackData {
  /**
   * The road centerline profile: `(dx, distance)` pairs read from the start of
   * the body. Confidently decoded; see the module docs.
   */
  centerline: CenterlinePoint[];
  /** Byte offset (from the start of the file) where the centerline run ends. */
  centerlineEnd: number;
  /**
   * The remaining, not-yet-reverse-engineered bytes after the centerline
   * (waypoint graph, ramps, pit lane, hazards, scenery). Exposed raw.
   */
  tail: Uint8Array;
  /** The entire body (everything after the 4-byte tag) as little-endian int16s. */
  int16Stream: Int16Array;
  /** Total file length in bytes. */
  byteLength: number;
}

/** Maximum plausible absolute lateral offset for a centerline pair. */
const MAX_CENTERLINE_DX = 200;

/**
 * Read a signed little-endian int16 at `offset`.
 */
function readI16(bytes: Uint8Array, offset: number): number {
  const v = (bytes[offset] as number) | ((bytes[offset + 1] as number) << 8);
  return v >= 0x8000 ? v - 0x10000 : v;
}

/**
 * Decode a `.TRK` file.
 *
 * @param fileBytes Raw `.TRK` file bytes.
 * @returns The decoded {@link TrackData}.
 * @throws {TrkDecodeError} If the `"TRK:"` tag is missing or the body has an odd
 *   length (not a whole int16 stream).
 * Requirements: 9.1, 9.2, 9.5
 */
export function decodeTrk(fileBytes: Uint8Array): TrackData {
  if (fileBytes.length < 4) {
    throw new TrkDecodeError('file shorter than the 4-byte TRK: tag', 0);
  }
  const tag = String.fromCharCode(
    fileBytes[0] as number,
    fileBytes[1] as number,
    fileBytes[2] as number,
    fileBytes[3] as number,
  );
  if (tag !== TRK_TAG) {
    throw new TrkDecodeError(`expected "${TRK_TAG}" tag but found "${tag}"`, 0);
  }

  const bodyLength = fileBytes.length - 4;
  if (bodyLength % 2 !== 0) {
    throw new TrkDecodeError('TRK body length is odd (not a whole int16 stream)', 4);
  }

  // Full int16 view of the body, for downstream reverse engineering.
  const int16Stream = new Int16Array(bodyLength / 2);
  for (let i = 0; i < int16Stream.length; i += 1) {
    int16Stream[i] = readI16(fileBytes, 4 + i * 2);
  }

  // Decode the leading centerline: 4-byte (dx, distance) pairs while distance is
  // non-decreasing and dx stays within the plausible lateral range.
  const centerline: CenterlinePoint[] = [];
  let offset = 4;
  let prevDistance = -1;
  while (offset + 4 <= fileBytes.length) {
    const dx = readI16(fileBytes, offset);
    const distance = readI16(fileBytes, offset + 2);
    if (distance < prevDistance) break;
    if (Math.abs(dx) > MAX_CENTERLINE_DX) break;
    centerline.push({ dx, distance });
    prevDistance = distance;
    offset += 4;
  }

  const tail = fileBytes.subarray(offset);

  return {
    centerline,
    centerlineEnd: offset,
    tail: tail.slice(),
    int16Stream,
    byteLength: fileBytes.length,
  };
}

/** Real filename (upper-case, no extension) → internal `trackId`. */
export const TRACK_ID_BY_FILENAME: Readonly<Record<string, string>> = {
  BAY_AREA: 'bay_area',
  BOSTON: 'boston',
  CHICAGO: 'chicago',
  HOUSTON: 'houston',
  LA: 'los_angeles',
  NYC: 'manhattan',
  ORLANDO: 'orlando',
  PHOENIX: 'phoenix',
  SEATTLE: 'seattle',
  ST_LOUIS: 'st_louis',
};

/**
 * Map a `.TRK` filename (with or without extension/path) to its internal
 * `trackId`, or `undefined` if unknown.
 *
 * @param filename e.g. `"BAY_AREA.TRK"`, `"nyc.trk"`, or a full path.
 */
export function trackIdForFilename(filename: string): string | undefined {
  const base = filename.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '').toUpperCase();
  return TRACK_ID_BY_FILENAME[base];
}
