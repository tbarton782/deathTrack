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
 * - immediately after the centerline, most tracks carry a **road-profile
 *   array**: 6-byte `[c0, c1, distance]` records sampled at a fixed **±30**
 *   distance step (the sign is per-track — some tracks run the distance axis
 *   negative). `c0` sits near zero and `c1` ramps smoothly up and down along the
 *   track; the array is confidently *located* (start / step / length) even
 *   though the exact meaning of `c0`/`c1` (curvature / banking / elevation /
 *   width) is not yet confirmed, so those columns are exposed neutrally.
 *
 * What is **not** decoded (deliberately left raw): after the road-profile array
 * the majority of the file remains undocumented — per
 * `research/dynamix-formats.md` §7.1 the `.TRK` payload also carries the AI
 * **waypoint graph**, **jump ramps**, **pit lane**, **hazard zones** and
 * **scenery placements**. Their exact byte layouts could not be confirmed
 * against the files without inventing structure (which the format notes
 * explicitly forbid), so the remaining bytes are exposed as an opaque `tail`
 * and as the raw int16 stream for later reverse engineering, rather than
 * guessed at. The decoder still guarantees every track parses without error.
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

/**
 * A single road-profile record: a run of these follows the centerline, sampled
 * at a fixed ~30-unit distance step. The two leading columns (`c0`, `c1`) carry
 * per-segment road data — one is near-zero and the other ramps smoothly up and
 * down along the track — but their exact meaning (curvature / banking /
 * elevation / width) is not yet confirmed against the engine, so they are named
 * neutrally rather than guessed.
 */
export interface RoadProfilePoint {
  /** First per-segment column (usually near zero). */
  c0: number;
  /** Second per-segment column (a smoothly varying profile value). */
  c1: number;
  /** Signed cumulative distance for this segment (steps by +30 or -30). */
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
   * The road-profile array: 6-byte `[c0, c1, distance]` records at a ~±30 unit
   * distance step, found in most tracks immediately after the centerline.
   * Confidently *located* (start/step/length), though `c0`/`c1` semantics are
   * not yet confirmed. Empty when the array could not be identified for a track
   * (e.g. a variant cadence).
   */
  roadProfile: RoadProfilePoint[];
  /**
   * `+30` or `-30`: the direction the road-profile `distance` steps, or `0`
   * when no road-profile array was identified.
   */
  roadProfileStep: number;
  /** Byte offset where the road-profile array ends (equals its start when empty). */
  roadProfileEnd: number;
  /**
   * The remaining, not-yet-reverse-engineered bytes after the decoded sections
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

/** The fixed distance step of the road-profile array. */
const ROAD_PROFILE_STEP = 30;

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

  const centerlineEnd = offset;

  // Locate the road-profile array: a run of 6-byte [c0, c1, distance] records
  // whose distance steps by +30 or -30. Search from the centerline end for the
  // first place three consecutive records step consistently, then walk it while
  // the step holds. This is a best-effort *location* of a real, recurring
  // section — not a claim about c0/c1 semantics.
  const { profile, step, end } = extractRoadProfile(fileBytes, centerlineEnd);

  const tail = fileBytes.subarray(end);

  return {
    centerline,
    centerlineEnd,
    roadProfile: profile,
    roadProfileStep: step,
    roadProfileEnd: end,
    tail: tail.slice(),
    int16Stream,
    byteLength: fileBytes.length,
  };
}

/**
 * Locate and read the road-profile array. Scans forward from `from` for the
 * first offset where three consecutive 6-byte records have a `distance` column
 * stepping by a consistent ±30, then walks records while that step holds.
 *
 * @returns The profile points, the detected step (`±30`, or `0` if none), and
 *   the byte offset just past the array (equal to `from` when none is found).
 */
function extractRoadProfile(
  bytes: Uint8Array,
  from: number,
): { profile: RoadProfilePoint[]; step: number; end: number } {
  const distAt = (o: number): number => readI16(bytes, o + 4);

  // Find the start + step direction: 3 records stepping +30 or -30.
  let start = -1;
  let step = 0;
  for (let o = from; o + 18 <= bytes.length; o += 2) {
    const d0 = distAt(o);
    const d1 = distAt(o + 6);
    const d2 = distAt(o + 12);
    if (d1 - d0 === ROAD_PROFILE_STEP && d2 - d1 === ROAD_PROFILE_STEP) {
      start = o;
      step = ROAD_PROFILE_STEP;
      break;
    }
    if (d1 - d0 === -ROAD_PROFILE_STEP && d2 - d1 === -ROAD_PROFILE_STEP) {
      start = o;
      step = -ROAD_PROFILE_STEP;
      break;
    }
  }

  if (start < 0) {
    return { profile: [], step: 0, end: from };
  }

  const profile: RoadProfilePoint[] = [];
  let o = start;
  let expect = distAt(start);
  while (o + 6 <= bytes.length && distAt(o) === expect) {
    profile.push({ c0: readI16(bytes, o), c1: readI16(bytes, o + 2), distance: expect });
    o += 6;
    expect += step;
  }

  return { profile, step, end: o };
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
