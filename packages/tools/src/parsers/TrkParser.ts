/**
 * `.TRK` track-geometry parser for the Deathtrack asset conversion pipeline.
 *
 * The original DOS Deathtrack game stores each city track in a `.TRK` file. No
 * canonical byte-level specification survives, so this module defines a
 * self-consistent, documented binary layout that captures every geometry
 * element the design requires: road segments, jump ramps, the AI waypoint
 * graph, pit-lane entry/exit and path, hazard zones, and scenery objects. The
 * layout is deliberately regular so that a matching encoder can round-trip the
 * parsed {@link TrackData} back to a byte-identical buffer.
 *
 * All multi-byte fields are little-endian, matching the shared binary codec.
 * Any structural problem throws a {@link TrkParseError} carrying the byte
 * offset at which parsing failed, so the Asset Loader can surface a descriptive
 * error identifying the track and failure point.
 *
 * Binary layout (all offsets relative to the start of the buffer):
 *
 * ```
 * Header (32 bytes)
 *   0   u32  magic          = 0x314B5254  ('TRK1' little-endian)
 *   4   u16  version        = 1
 *   6   u16  trackId        index into TRACK_IDS (0..9)
 *   8   u16  lapCount
 *   10  u16  nameLen        byte length of UTF-8 name that follows the header
 *   12  u16  cityLen        byte length of UTF-8 city that follows the name
 *   14  u16  roadCount
 *   16  u16  rampCount
 *   18  u16  waypointNodeCount
 *   20  u16  waypointEdgeCount
 *   22  u16  hazardCount
 *   24  u16  sceneryCount
 *   26  u16  pitPathCount
 *   28  u32  reserved       = 0
 *
 * Variable-length name / city
 *   nameLen bytes  UTF-8 track name
 *   cityLen bytes  UTF-8 city name
 *
 * Road segments        (roadCount × 22 bytes)
 *   f32 centre.x, f32 centre.y, f32 width, f32 normal.x, f32 normal.y, u8 surface,
 *   u8 pad
 *
 * Jump ramps           (rampCount × 16 bytes)
 *   f32 position.x, f32 position.y, f32 angle, f32 launchMultiplier
 *
 * Waypoint nodes       (nodeCount × 14 bytes)
 *   u16 id, f32 position.x, f32 position.y, f32 width
 *
 * Waypoint edges       (edgeCount × 8 bytes)
 *   u16 from, u16 to, f32 distance
 *
 * Pit lane             (16 bytes + path)
 *   f32 entry.x, f32 entry.y, f32 exit.x, f32 exit.y
 *   pitPathCount × (f32 x, f32 y)
 *
 * Hazard zones         (per zone)
 *   u16 id, u16 typeLen, typeLen bytes UTF-8 hazardType, u16 vertexCount,
 *   vertexCount × (f32 x, f32 y)
 *
 * Scenery objects      (per object)
 *   u16 id, f32 position.x, f32 position.y, f32 depth, u16 spriteLen,
 *   spriteLen bytes UTF-8 spriteId
 *
 * Palette              (768 bytes)
 *   256 × (u8 r, u8 g, u8 b)
 * ```
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
 */

import { BinaryReader } from '@deathtrack/shared';
import type {
  HazardZone,
  JumpRamp,
  PitLaneData,
  RoadSegment,
  SceneryObject,
  SurfaceType,
  TrackId,
  Vec2,
  WaypointEdge,
  WaypointGraph,
  WaypointNode,
} from '@deathtrack/shared';

// ---------------------------------------------------------------------------
// Format constants
// ---------------------------------------------------------------------------

/** Magic number identifying a `.TRK` file: the ASCII bytes `TRK1` (little-endian u32). */
export const TRK_MAGIC = 0x314b5254;

/** The `.TRK` layout version this parser understands. */
export const TRK_VERSION = 1;

/** Size of the fixed header in bytes. */
const HEADER_SIZE = 32;

/** Number of palette entries; each entry is three bytes (RGB). */
const PALETTE_ENTRIES = 256;

/** Total palette size in bytes (256 × 3). */
const PALETTE_BYTES = PALETTE_ENTRIES * 3;

/**
 * Ordered list of the ten city track identifiers, indexed by the `trackId`
 * field in the header. The ordering is stable so that encode/decode is
 * symmetric.
 * Requirements: 9.1
 */
const TRACK_IDS: readonly TrackId[] = [
  'bay_area',
  'boston',
  'chicago',
  'houston',
  'los_angeles',
  'manhattan',
  'orlando',
  'phoenix',
  'seattle',
  'st_louis',
] as const;

/**
 * Surface material codes as stored in road-segment records. The ordering is
 * stable so that encode/decode is symmetric.
 * Requirements: 9.1
 */
const SURFACE_TYPES: readonly SurfaceType[] = ['asphalt', 'dirt', 'gravel'] as const;

// ---------------------------------------------------------------------------
// Parser output type
// ---------------------------------------------------------------------------

/**
 * Fully parsed track representation produced by {@link parseTrack}.
 *
 * This mirrors the `TrackData` shape consumed by the Asset Loader (see
 * `packages/shared/src/assets/AssetLoader.ts`), reusing the shared domain
 * geometry types. `roadGeometry` is the ordered list of road segments; the
 * remaining fields map one-to-one onto the shared track types.
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
 */
export interface TrackData {
  /** Unique track identifier corresponding to one of the ten city tracks. */
  id: TrackId;
  /** Human-readable track name. */
  name: string;
  /** City name displayed in menus. */
  city: string;
  /** Number of laps required to complete the race. */
  lapCount: number;
  /** Ordered array of road segments defining the driveable surface. */
  roadGeometry: RoadSegment[];
  /** All jump ramps present on the track. */
  jumpRamps: JumpRamp[];
  /** Directed waypoint graph used by AI navigation. */
  waypointGraph: WaypointGraph;
  /** Pit lane geometry (entry/exit positions and path). */
  pitLane: PitLaneData;
  /** Static hazard zones overlaid on the track surface. */
  hazardZones: HazardZone[];
  /** Scenery objects placed alongside the road. */
  scenery: SceneryObject[];
  /** 256-colour palette as a flat RGB byte array (length = 256 × 3). */
  palette: Uint8Array;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a `.TRK` buffer cannot be parsed. Carries the byte `offset` at
 * which the failure was detected so callers (the Asset Loader) can report the
 * precise point of failure.
 * Requirements: 9.5
 */
export class TrkParseError extends Error {
  /** Byte offset within the source buffer at which parsing failed. */
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`TRK parse error at byte offset ${offset}: ${message}`);
    this.name = 'TrkParseError';
    this.offset = offset;
  }
}

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

/**
 * Read a `Vec2` (two little-endian float32s) from the reader.
 */
function readVec2(reader: BinaryReader): Vec2 {
  return { x: reader.float32(), y: reader.float32() };
}

/**
 * Wrap a read operation so any {@link RangeError} thrown by the underlying
 * reader (an unexpected end of buffer) is re-thrown as a {@link TrkParseError}
 * carrying the offset at which the read began.
 */
function guard<T>(reader: BinaryReader, what: string, read: () => T): T {
  const start = reader.position;
  try {
    return read();
  } catch (err) {
    if (err instanceof TrkParseError) {
      throw err;
    }
    const detail = err instanceof Error ? err.message : String(err);
    throw new TrkParseError(`failed to read ${what}: ${detail}`, start);
  }
}

// ---------------------------------------------------------------------------
// Section readers
// ---------------------------------------------------------------------------

interface TrkHeader {
  trackId: number;
  lapCount: number;
  nameLen: number;
  cityLen: number;
  roadCount: number;
  rampCount: number;
  waypointNodeCount: number;
  waypointEdgeCount: number;
  hazardCount: number;
  sceneryCount: number;
  pitPathCount: number;
}

/**
 * Read and validate the 32-byte header.
 * Requirements: 9.5
 */
function readHeader(reader: BinaryReader): TrkHeader {
  const magic = guard(reader, 'header magic', () => reader.uint32());
  if (magic !== TRK_MAGIC) {
    throw new TrkParseError(
      `bad magic 0x${magic.toString(16).padStart(8, '0')} (expected 0x${TRK_MAGIC.toString(16)})`,
      0,
    );
  }

  const version = guard(reader, 'header version', () => reader.uint16());
  if (version !== TRK_VERSION) {
    throw new TrkParseError(`unsupported version ${version} (expected ${TRK_VERSION})`, 4);
  }

  const trackIdIndex = guard(reader, 'header trackId', () => reader.uint16());
  if (trackIdIndex >= TRACK_IDS.length) {
    throw new TrkParseError(
      `track id index ${trackIdIndex} out of range (0..${TRACK_IDS.length - 1})`,
      6,
    );
  }

  const header: TrkHeader = {
    trackId: trackIdIndex,
    lapCount: guard(reader, 'header lapCount', () => reader.uint16()),
    nameLen: guard(reader, 'header nameLen', () => reader.uint16()),
    cityLen: guard(reader, 'header cityLen', () => reader.uint16()),
    roadCount: guard(reader, 'header roadCount', () => reader.uint16()),
    rampCount: guard(reader, 'header rampCount', () => reader.uint16()),
    waypointNodeCount: guard(reader, 'header waypointNodeCount', () => reader.uint16()),
    waypointEdgeCount: guard(reader, 'header waypointEdgeCount', () => reader.uint16()),
    hazardCount: guard(reader, 'header hazardCount', () => reader.uint16()),
    sceneryCount: guard(reader, 'header sceneryCount', () => reader.uint16()),
    pitPathCount: guard(reader, 'header pitPathCount', () => reader.uint16()),
  };

  // Consume the reserved u32 so the cursor sits exactly at HEADER_SIZE.
  guard(reader, 'header reserved', () => reader.uint32());
  return header;
}

/**
 * Read the ordered array of road segments.
 * Requirements: 9.1, 9.2
 */
function readRoadSegments(reader: BinaryReader, count: number): RoadSegment[] {
  const segments: RoadSegment[] = [];
  for (let index = 0; index < count; index += 1) {
    const segment = guard<RoadSegment>(reader, `road segment ${index}`, () => {
      const centre = readVec2(reader);
      const width = reader.float32();
      const normal = readVec2(reader);
      const surfaceCode = reader.uint8();
      reader.uint8(); // padding byte
      const surface = SURFACE_TYPES[surfaceCode];
      if (surface === undefined) {
        throw new TrkParseError(`unknown surface code ${surfaceCode}`, reader.position - 2);
      }
      return { index, centre, width, normal, surface };
    });
    segments.push(segment);
  }
  return segments;
}

/**
 * Read the array of jump ramps.
 * Requirements: 9.1
 */
function readJumpRamps(reader: BinaryReader, count: number): JumpRamp[] {
  const ramps: JumpRamp[] = [];
  for (let i = 0; i < count; i += 1) {
    const ramp = guard<JumpRamp>(reader, `jump ramp ${i}`, () => ({
      position: readVec2(reader),
      angle: reader.float32(),
      launchMultiplier: reader.float32(),
    }));
    ramps.push(ramp);
  }
  return ramps;
}

/**
 * Read the AI waypoint graph (nodes then edges).
 * Requirements: 9.1, 9.2
 */
function readWaypointGraph(
  reader: BinaryReader,
  nodeCount: number,
  edgeCount: number,
): WaypointGraph {
  const nodes: WaypointNode[] = [];
  for (let i = 0; i < nodeCount; i += 1) {
    const node = guard<WaypointNode>(reader, `waypoint node ${i}`, () => ({
      id: reader.uint16(),
      position: readVec2(reader),
      width: reader.float32(),
    }));
    nodes.push(node);
  }

  const edges: WaypointEdge[] = [];
  for (let i = 0; i < edgeCount; i += 1) {
    const edge = guard<WaypointEdge>(reader, `waypoint edge ${i}`, () => ({
      from: reader.uint16(),
      to: reader.uint16(),
      distance: reader.float32(),
    }));
    edges.push(edge);
  }

  return { nodes, edges };
}

/**
 * Read pit-lane entry/exit positions and the ordered path.
 * Requirements: 9.3, 9.4
 */
function readPitLane(reader: BinaryReader, pathCount: number): PitLaneData {
  return guard<PitLaneData>(reader, 'pit lane', () => {
    const entryPosition = readVec2(reader);
    const exitPosition = readVec2(reader);
    const path: Vec2[] = [];
    for (let i = 0; i < pathCount; i += 1) {
      path.push(readVec2(reader));
    }
    return { entryPosition, exitPosition, path };
  });
}

/**
 * Read the polygonal hazard zones.
 * Requirements: 9.1
 */
function readHazardZones(reader: BinaryReader, count: number): HazardZone[] {
  const zones: HazardZone[] = [];
  for (let i = 0; i < count; i += 1) {
    const zone = guard<HazardZone>(reader, `hazard zone ${i}`, () => {
      const id = reader.uint16();
      const typeLen = reader.uint16();
      const hazardType = reader.fixedString(typeLen);
      const vertexCount = reader.uint16();
      const bounds: Vec2[] = [];
      for (let v = 0; v < vertexCount; v += 1) {
        bounds.push(readVec2(reader));
      }
      return { id, bounds, hazardType };
    });
    zones.push(zone);
  }
  return zones;
}

/**
 * Read the scenery object placements.
 * Requirements: 9.1, 9.2
 */
function readScenery(reader: BinaryReader, count: number): SceneryObject[] {
  const objects: SceneryObject[] = [];
  for (let i = 0; i < count; i += 1) {
    const object = guard<SceneryObject>(reader, `scenery object ${i}`, () => {
      const id = reader.uint16();
      const position = readVec2(reader);
      const depth = reader.float32();
      const spriteLen = reader.uint16();
      const spriteId = reader.fixedString(spriteLen);
      return { id, position, spriteId, depth };
    });
    objects.push(object);
  }
  return objects;
}

/**
 * Read the trailing 768-byte palette (256 RGB triples).
 * Requirements: 9.6
 */
function readPalette(reader: BinaryReader): Uint8Array {
  return guard<Uint8Array>(reader, 'palette', () => reader.bytes(PALETTE_BYTES));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse a `.TRK` track file into a structured {@link TrackData}.
 *
 * Reads the full track geometry — road segments, jump ramps, the AI waypoint
 * graph, pit-lane entry/exit and path, hazard zones, and scenery objects —
 * followed by the 256-colour palette.
 *
 * On any structural failure a {@link TrkParseError} is thrown carrying the byte
 * offset of the failure, so the caller can identify the exact point at which a
 * malformed track file broke, without producing partial track data.
 *
 * @param buf The raw `.TRK` file bytes.
 * @returns The fully parsed track representation.
 * @throws {TrkParseError} If the buffer is malformed or truncated.
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
 */
export function parseTrack(buf: Buffer): TrackData {
  if (buf.length < HEADER_SIZE) {
    throw new TrkParseError(
      `buffer too small: ${buf.length} byte(s), need at least ${HEADER_SIZE} for the header`,
      0,
    );
  }

  const reader = new BinaryReader(
    new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
  );

  const header = readHeader(reader);

  const id = TRACK_IDS[header.trackId];
  if (id === undefined) {
    // Defensive: header validation already bounds-checks trackId.
    throw new TrkParseError(`track id index ${header.trackId} out of range`, 6);
  }

  const name = guard(reader, 'track name', () => reader.fixedString(header.nameLen));
  const city = guard(reader, 'city name', () => reader.fixedString(header.cityLen));

  const roadGeometry = readRoadSegments(reader, header.roadCount);
  const jumpRamps = readJumpRamps(reader, header.rampCount);
  const waypointGraph = readWaypointGraph(
    reader,
    header.waypointNodeCount,
    header.waypointEdgeCount,
  );
  const pitLane = readPitLane(reader, header.pitPathCount);
  const hazardZones = readHazardZones(reader, header.hazardCount);
  const scenery = readScenery(reader, header.sceneryCount);
  const palette = readPalette(reader);

  return {
    id,
    name,
    city,
    lapCount: header.lapCount,
    roadGeometry,
    jumpRamps,
    waypointGraph,
    pitLane,
    hazardZones,
    scenery,
    palette,
  };
}
