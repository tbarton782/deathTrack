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
 * - it begins with a short run of 4-byte **`(dx, distance)` pairs** — a small
 *   signed lateral offset paired with a rising `distance`. This is a lead-in
 *   **centerline / curvature profile** preamble.
 * - the bulk of the body is the **road path**: an array of 6-byte
 *   `[x, profile, z]` records tracing the track's centerline as a 2-D polyline.
 *   Between consecutive records exactly one of `x`/`z` advances by a small
 *   amount (~±30) while the other holds; a corner is where the advancing axis
 *   switches. The `profile` middle column varies smoothly along the track
 *   (a curvature / banking / elevation term — named neutrally as its exact
 *   meaning is unconfirmed). Rendering the `(x, z)` polyline produces a
 *   recognisable **closed race circuit** (verified: ORLANDO, PHOENIX and
 *   ST_LOUIS trace complete loops covering all but a 4-byte terminator; the
 *   other tracks trace a valid partial loop before an additional section).
 *
 * What is **not** decoded (deliberately left raw): some tracks carry further
 * data after the first traced loop (a second lap/section, pit lane, jump ramps,
 * hazard zones, scenery, or the AI waypoint graph — `research/dynamix-formats.md`
 * §7.1). Those layouts could not be confirmed without inventing structure
 * (which the format notes forbid), so anything past the traced road path is
 * exposed as an opaque `tail` and via the raw int16 stream. The decoder always
 * parses every track without error.
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
 * A single road-path point: a 6-byte `[x, profile, z]` record. `x` and `z` are
 * the centerline position on the ground plane; between consecutive points
 * exactly one of them advances by a small step while the other holds. `profile`
 * is a smoothly-varying per-point term (curvature / banking / elevation) whose
 * exact meaning is unconfirmed, so it is named neutrally.
 */
export interface RoadPathPoint {
  /** Centerline X coordinate. */
  x: number;
  /** Smoothly-varying profile term (curvature / banking / elevation). */
  profile: number;
  /** Centerline Z coordinate. */
  z: number;
}

/** A decoded track. */
export interface TrackData {
  /**
   * The lead-in centerline preamble: `(dx, distance)` pairs read from the start
   * of the body. Confidently decoded; see the module docs.
   */
  centerline: CenterlinePoint[];
  /** Byte offset (from the start of the file) where the centerline run ends. */
  centerlineEnd: number;
  /**
   * The road path: `[x, profile, z]` points tracing the track centerline as a
   * 2-D polyline. Confidently decoded and verified to trace a race circuit;
   * see the module docs.
   */
  roadPath: RoadPathPoint[];
  /** Byte offset where the road path begins. */
  roadPathStart: number;
  /** Byte offset just past the road path (start of the raw tail). */
  roadPathEnd: number;
  /**
   * Whether the road path returns close to its start (a closed loop). `true`
   * for a full circuit; `false` when the traced path stops before closing
   * (an additional undecoded section follows in the tail).
   */
  roadPathClosed: boolean;
  /**
   * The remaining, not-yet-reverse-engineered bytes after the road path
   * (possible second section, pit lane, ramps, hazards, scenery, AI waypoint
   * graph). Exposed raw.
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
 * Maximum per-record step of the advancing axis in the road path. Straight runs
 * step ~30; corners approximate diagonals with slightly smaller steps. A step
 * larger than this on *both* axes marks the end of the traced path.
 */
const MAX_PATH_STEP = 40;

/**
 * Distance (in world units) within which the path end is treated as "closed"
 * back to its start. Real circuits close to within a few segments (~18–76 units
 * observed); a value well above that but far below any open path keeps the test
 * unambiguous.
 */
const LOOP_CLOSE_DISTANCE = 100;

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

  // Decode the road path: a polyline of [x, profile, z] points that starts at
  // the centerline end and advances one ground axis at a time.
  const { path, start, end, closed } = extractRoadPath(fileBytes, centerlineEnd);

  const tail = fileBytes.subarray(end);

  return {
    centerline,
    centerlineEnd,
    roadPath: path,
    roadPathStart: start,
    roadPathEnd: end,
    roadPathClosed: closed,
    tail: tail.slice(),
    int16Stream,
    byteLength: fileBytes.length,
  };
}

/**
 * Decode the road-path polyline of `[x, profile, z]` records starting at the
 * centerline end. Walks records while the ground position `(x, z)` advances
 * smoothly: at each step exactly one of `x`/`z` moves by up to
 * {@link MAX_PATH_STEP} while the other stays close, so a straight run advances
 * one axis and a corner switches axes. The walk stops when *both* axes jump
 * (past the path) or the record would run off the buffer.
 *
 * @returns The path points, its start/end byte offsets, and whether the path
 *   closes back near its origin (a full circuit).
 */
function extractRoadPath(
  bytes: Uint8Array,
  from: number,
): { path: RoadPathPoint[]; start: number; end: number; closed: boolean } {
  const readPoint = (o: number): RoadPathPoint => ({
    x: readI16(bytes, o),
    profile: readI16(bytes, o + 2),
    z: readI16(bytes, o + 4),
  });

  // Walk a smooth [x, profile, z] polyline from byte offset `o0`: successive
  // points advance one ground axis at a time by a small step. Returns the
  // points and the byte offset just past them.
  const walkFrom = (o0: number): { pts: RoadPathPoint[]; end: number } => {
    const pts: RoadPathPoint[] = [];
    if (o0 + 6 > bytes.length) return { pts, end: o0 };
    let prev = readPoint(o0);
    pts.push(prev);
    let o = o0 + 6;
    while (o + 6 <= bytes.length) {
      const p = readPoint(o);
      const dx = Math.abs(p.x - prev.x);
      const dz = Math.abs(p.z - prev.z);
      // A smooth step advances (at most) one ground axis by a small amount, so
      // the *smaller* of the two deltas stays tiny. A big jump on both axes at
      // once marks the end of the polyline.
      if (Math.min(dx, dz) > MAX_PATH_STEP) break;
      if (dx > 4000 || dz > 4000) break;
      pts.push(p);
      prev = p;
      o += 6;
    }
    return { pts, end: o };
  };

  // A short transition (a handful of int16s) can sit between the centerline
  // preamble and the true start of the road-path records, and the record phase
  // (even vs odd int16 alignment) can shift. Search a small window of candidate
  // start offsets and keep the one that yields the longest polyline.
  let best: { pts: RoadPathPoint[]; end: number; start: number } = {
    pts: [],
    end: from,
    start: from,
  };
  const limit = Math.min(from + 64, bytes.length);
  for (let o = from; o + 6 <= limit; o += 2) {
    const { pts, end } = walkFrom(o);
    if (pts.length > best.pts.length) best = { pts, end, start: o };
  }

  const path = best.pts;
  const first = path[0];
  const last = path[path.length - 1];
  let closed = false;
  if (first !== undefined && last !== undefined && path.length > 8) {
    const gap = Math.abs(first.x - last.x) + Math.abs(first.z - last.z);
    closed = gap <= LOOP_CLOSE_DISTANCE;
  }

  return { path, start: best.start, end: best.end, closed };
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
