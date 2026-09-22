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
 * - the bulk of the body is the **road path**: an array of 6-byte records of
 *   three int16 columns, tracing the track's centerline. Two of the columns are
 *   the ground plane (`x`, `z`) and the third is a smoothly-varying **profile**
 *   term (curvature / banking / elevation — named neutrally as its exact
 *   meaning is unconfirmed). Verified across all 10 tracks, each step changes at
 *   **most one** column by more than ~±40: a straight run advances one ground
 *   axis, a corner switches to the other, and the profile drifts smoothly. The
 *   profile is **not** in a fixed column — it is `col1` for 8 tracks but `col0`
 *   for BAY_AREA and ST_LOUIS — so it is identified as the smallest-span column
 *   (it stays within a ~40–200 band while the ground axes sweep thousands of
 *   units). Rendering the `(x, z)` polyline produces a recognisable **closed
 *   race circuit** for all 10 tracks, covering all but a 2–4-byte terminator.
 *
 * What is **not** decoded (deliberately left raw): the exact meaning of the
 * profile column, and any per-segment attributes (pit lane, jump ramps, hazard
 * zones, scenery, AI waypoint graph — `research/dynamix-formats.md` §7.1). No
 * separate section follows the road path (the tail is only a 2–4-byte
 * terminator for every track), so those attributes, if present, are encoded
 * within the records; they could not be confirmed without inventing structure
 * (which the format notes forbid). Anything past the traced road path is
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
 * A single road-path point decoded from a 6-byte three-column record. `x` and
 * `z` are the centerline position on the ground plane (the two large-span
 * columns); between consecutive points exactly one of them advances by a small
 * step while the other holds. `profile` is the smoothly-varying smallest-span
 * column (curvature / banking / elevation) whose exact meaning is unconfirmed,
 * so it is named neutrally. The profile's source column varies per track; see
 * {@link extractRoadPath}.
 */
export interface RoadPathPoint {
  /** Centerline X coordinate (a ground-plane column). */
  x: number;
  /** Smoothly-varying profile term (curvature / banking / elevation). */
  profile: number;
  /** Centerline Z coordinate (a ground-plane column). */
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
 * Number of lead-in records at the start of the road path that are a
 * header/transition rather than loop geometry. Verified across all 10 real
 * tracks: the first record holds a large value in one column and the second is
 * a transition; the traced loop body begins at this index and returns near it.
 */
const PATH_PREAMBLE_RECORDS = 2;

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
 * Decode the road-path polyline starting at the centerline end.
 *
 * Each record is a raw `[a, b, c]` triple of little-endian int16s. Verified
 * across all 10 real tracks, a valid step changes **at most one** of the three
 * columns by more than {@link MAX_PATH_STEP}: two columns are the ground plane
 * (each advancing one at a time — a straight run advances one, a corner
 * switches to the other) and the third is a smoothly-varying **profile** term.
 *
 * The profile does not occupy a fixed column: it is `col1` for 8 tracks but
 * `col0` for BAY_AREA and ST_LOUIS. It is identified structurally as the
 * **smallest-span column** — while the two ground axes sweep thousands of
 * units, the profile stays in a tight band (~40–200 units). The other two
 * columns become `x` and `z`, preserving their original column order.
 *
 * @returns The path points, its start/end byte offsets, and whether the path
 *   closes back near its origin (a full circuit).
 */
function extractRoadPath(
  bytes: Uint8Array,
  from: number,
): { path: RoadPathPoint[]; start: number; end: number; closed: boolean } {
  const readTriple = (o: number): [number, number, number] => [
    readI16(bytes, o),
    readI16(bytes, o + 2),
    readI16(bytes, o + 4),
  ];

  // Walk a generic [a, b, c] polyline from byte offset `o0`: a valid step
  // changes at most one column by more than MAX_PATH_STEP (one ground axis
  // advances, or a corner switches axes; the profile changes smoothly). A step
  // that jumps two or more columns at once, or jumps any column absurdly far,
  // marks the end of the polyline.
  const walkFrom = (o0: number): { triples: [number, number, number][]; end: number } => {
    const triples: [number, number, number][] = [];
    if (o0 + 6 > bytes.length) return { triples, end: o0 };
    let prev = readTriple(o0);
    triples.push(prev);
    let o = o0 + 6;
    while (o + 6 <= bytes.length) {
      const p = readTriple(o);
      const d0 = Math.abs(p[0] - prev[0]);
      const d1 = Math.abs(p[1] - prev[1]);
      const d2 = Math.abs(p[2] - prev[2]);
      const bigCols = (d0 > MAX_PATH_STEP ? 1 : 0) + (d1 > MAX_PATH_STEP ? 1 : 0) + (d2 > MAX_PATH_STEP ? 1 : 0);
      if (bigCols > 1) break;
      if (d0 > 4000 || d1 > 4000 || d2 > 4000) break;
      triples.push(p);
      prev = p;
      o += 6;
    }
    return { triples, end: o };
  };

  // A short transition (a handful of int16s) can sit between the centerline
  // preamble and the true start of the road-path records, and the record phase
  // (even vs odd int16 alignment) can shift. Search a small window of candidate
  // start offsets and keep the one that yields the longest polyline.
  let best: { triples: [number, number, number][]; end: number; start: number } = {
    triples: [],
    end: from,
    start: from,
  };
  const limit = Math.min(from + 64, bytes.length);
  for (let o = from; o + 6 <= limit; o += 2) {
    const { triples, end } = walkFrom(o);
    if (triples.length > best.triples.length) best = { triples, end, start: o };
  }

  const path = assignColumns(best.triples);
  // The loop's true origin is the first *body* record: the two lead-in records
  // are a header/transition (one column carries a large value that would
  // otherwise inflate the closure gap). Verified across all 10 tracks, the body
  // starts at index PATH_PREAMBLE_RECORDS and the last point returns near it.
  const loopStart = path[PATH_PREAMBLE_RECORDS];
  const last = path[path.length - 1];
  let closed = false;
  if (loopStart !== undefined && last !== undefined && path.length > PATH_PREAMBLE_RECORDS + 8) {
    const gap = Math.abs(loopStart.x - last.x) + Math.abs(loopStart.z - last.z);
    closed = gap <= LOOP_CLOSE_DISTANCE;
  }

  return { path, start: best.start, end: best.end, closed };
}

/**
 * Assign column roles to raw `[a, b, c]` triples. The **profile** is the
 * smallest-span column (it stays in a tight band while the two ground axes
 * sweep thousands of units); the remaining two columns become `x` and `z` in
 * their original column order. See {@link extractRoadPath}.
 */
function assignColumns(triples: [number, number, number][]): RoadPathPoint[] {
  if (triples.length === 0) return [];
  const spans = [0, 1, 2].map((c) => {
    let min = Infinity;
    let max = -Infinity;
    for (const t of triples) {
      const v = t[c] as number;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    return max - min;
  });
  // Profile = smallest-span column; the other two (in order) are x, z.
  let profileCol = 0;
  if ((spans[1] as number) < (spans[profileCol] as number)) profileCol = 1;
  if ((spans[2] as number) < (spans[profileCol] as number)) profileCol = 2;
  const groundCols = [0, 1, 2].filter((c) => c !== profileCol);
  const xCol = groundCols[0] as number;
  const zCol = groundCols[1] as number;
  return triples.map((t) => ({
    x: t[xCol] as number,
    profile: t[profileCol] as number,
    z: t[zCol] as number,
  }));
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
