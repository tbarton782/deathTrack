/**
 * Property-based test for the `.TRK` track file round-trip.
 *
 * Property 23: Track file parse–encode round-trip is byte-equivalent.
 *
 * *For any* well-formed original Deathtrack track file, parsing with
 * `TrkParser` and then re-encoding the resulting `TrackData` with the track
 * binary codec produces a byte sequence that is identical to the original
 * input file.
 *
 * The `TrkParser` module intentionally does not ship a standalone encoder, so
 * this test defines the inverse encoder (`encodeTrackData`) mirroring the byte
 * layout documented in `TrkParser.ts`. The property generates an arbitrary
 * well-formed `.TRK` buffer, parses it into `TrackData`, re-encodes that
 * `TrackData`, and asserts the re-encoded bytes are identical to the original
 * buffer — i.e. `encode(parse(buf)) === buf`.
 *
 * Validates: Requirements 9.6
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { BinaryWriter } from '@deathtrack/shared';
import type {
  HazardZone,
  JumpRamp,
  PitLaneData,
  RoadSegment,
  SceneryObject,
  SurfaceType,
  TrackId,
  Vec2,
  WaypointGraph,
} from '@deathtrack/shared';
import { parseTrack, type TrackData, TRK_MAGIC, TRK_VERSION } from '../parsers/TrkParser.js';

// ---------------------------------------------------------------------------
// Format constants — mirror the ordering documented in TrkParser.ts so that
// encode/decode are symmetric.
// ---------------------------------------------------------------------------

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

const SURFACE_TYPES: readonly SurfaceType[] = ['asphalt', 'dirt', 'gravel'] as const;

const utf8 = new TextEncoder();
const byteLen = (s: string): number => utf8.encode(s).length;

function writeVec2(w: BinaryWriter, v: Vec2): void {
  w.float32(v.x).float32(v.y);
}

// ---------------------------------------------------------------------------
// Inverse encoder — reproduces the exact byte layout parseTrack consumes.
// ---------------------------------------------------------------------------

/**
 * Encode a {@link TrackData} back to a `.TRK` buffer following the layout
 * documented in `TrkParser.ts`. This is the inverse of {@link parseTrack}.
 */
function encodeTrackData(track: TrackData): Buffer {
  const w = new BinaryWriter(1024);

  const trackIdIndex = TRACK_IDS.indexOf(track.id);

  // Header (32 bytes)
  w.uint32(TRK_MAGIC);
  w.uint16(TRK_VERSION);
  w.uint16(trackIdIndex);
  w.uint16(track.lapCount);
  w.uint16(byteLen(track.name));
  w.uint16(byteLen(track.city));
  w.uint16(track.roadGeometry.length);
  w.uint16(track.jumpRamps.length);
  w.uint16(track.waypointGraph.nodes.length);
  w.uint16(track.waypointGraph.edges.length);
  w.uint16(track.hazardZones.length);
  w.uint16(track.scenery.length);
  w.uint16(track.pitLane.path.length);
  w.uint32(0); // reserved

  // Names
  w.fixedString(track.name, byteLen(track.name));
  w.fixedString(track.city, byteLen(track.city));

  // Road segments
  for (const seg of track.roadGeometry) {
    writeVec2(w, seg.centre);
    w.float32(seg.width);
    writeVec2(w, seg.normal);
    w.uint8(SURFACE_TYPES.indexOf(seg.surface));
    w.uint8(0); // padding
  }

  // Jump ramps
  for (const ramp of track.jumpRamps) {
    writeVec2(w, ramp.position);
    w.float32(ramp.angle);
    w.float32(ramp.launchMultiplier);
  }

  // Waypoint nodes
  for (const node of track.waypointGraph.nodes) {
    w.uint16(node.id);
    writeVec2(w, node.position);
    w.float32(node.width);
  }
  // Waypoint edges
  for (const edge of track.waypointGraph.edges) {
    w.uint16(edge.from);
    w.uint16(edge.to);
    w.float32(edge.distance);
  }

  // Pit lane
  writeVec2(w, track.pitLane.entryPosition);
  writeVec2(w, track.pitLane.exitPosition);
  for (const p of track.pitLane.path) {
    writeVec2(w, p);
  }

  // Hazard zones
  for (const zone of track.hazardZones) {
    w.uint16(zone.id);
    w.uint16(byteLen(zone.hazardType));
    w.fixedString(zone.hazardType, byteLen(zone.hazardType));
    w.uint16(zone.bounds.length);
    for (const v of zone.bounds) {
      writeVec2(w, v);
    }
  }

  // Scenery
  for (const obj of track.scenery) {
    w.uint16(obj.id);
    writeVec2(w, obj.position);
    w.float32(obj.depth);
    w.uint16(byteLen(obj.spriteId));
    w.fixedString(obj.spriteId, byteLen(obj.spriteId));
  }

  // Palette (768 bytes)
  w.bytes(track.palette);

  return Buffer.from(w.toUint8Array());
}

// ---------------------------------------------------------------------------
// Generators — build well-formed `.TRK` buffers directly (independent of the
// inverse encoder above) so the property genuinely tests parse -> encode.
// ---------------------------------------------------------------------------

// Constrain floats to exact float32 values so encode/decode is lossless.
const finiteF32 = fc.float({ min: -1e6, max: 1e6, noNaN: true }).map((n) => Math.fround(n));
const vec2 = fc.record<Vec2>({ x: finiteF32, y: finiteF32 });
const u16 = fc.integer({ min: 0, max: 65535 });
// Printable-ASCII strings keep byte length equal to character length and avoid
// any encoding surprises; the parser stores raw UTF-8 either way.
const ascii = fc
  .string({ minLength: 0, maxLength: 12 })
  .map((s) => s.replace(/[^\x20-\x7e]/g, 'a'));

const roadArb: fc.Arbitrary<Omit<RoadSegment, 'index'>> = fc.record({
  centre: vec2,
  width: finiteF32,
  normal: vec2,
  surface: fc.constantFrom<SurfaceType>('asphalt', 'dirt', 'gravel'),
});

const rampArb: fc.Arbitrary<JumpRamp> = fc.record({
  position: vec2,
  angle: finiteF32,
  launchMultiplier: finiteF32,
});

const nodeArb = fc.record({ id: u16, position: vec2, width: finiteF32 });
const edgeArb = fc.record({ from: u16, to: u16, distance: finiteF32 });

const hazardArb: fc.Arbitrary<HazardZone> = fc.record({
  id: u16,
  hazardType: ascii,
  bounds: fc.array(vec2, { maxLength: 5 }),
});

const sceneryArb: fc.Arbitrary<SceneryObject> = fc.record({
  id: u16,
  position: vec2,
  spriteId: ascii,
  depth: finiteF32,
});

const paletteArb = fc
  .array(fc.integer({ min: 0, max: 255 }), { minLength: 768, maxLength: 768 })
  .map((bytes) => Uint8Array.from(bytes));

interface GeneratedTrack {
  trackIdIndex: number;
  name: string;
  city: string;
  lapCount: number;
  roads: Omit<RoadSegment, 'index'>[];
  jumpRamps: JumpRamp[];
  waypointGraph: WaypointGraph;
  pitLane: PitLaneData;
  hazardZones: HazardZone[];
  scenery: SceneryObject[];
  palette: Uint8Array;
}

const trackArb: fc.Arbitrary<GeneratedTrack> = fc.record({
  trackIdIndex: fc.integer({ min: 0, max: 9 }),
  name: ascii,
  city: ascii,
  lapCount: u16,
  roads: fc.array(roadArb, { maxLength: 6 }),
  jumpRamps: fc.array(rampArb, { maxLength: 4 }),
  waypointGraph: fc.record({
    nodes: fc.array(nodeArb, { maxLength: 5 }),
    edges: fc.array(edgeArb, { maxLength: 5 }),
  }),
  pitLane: fc.record({
    entryPosition: vec2,
    exitPosition: vec2,
    path: fc.array(vec2, { maxLength: 5 }),
  }),
  hazardZones: fc.array(hazardArb, { maxLength: 3 }),
  scenery: fc.array(sceneryArb, { maxLength: 3 }),
  palette: paletteArb,
});

/** Encode a generated track spec directly into a well-formed `.TRK` buffer. */
function encodeGenerated(g: GeneratedTrack): Buffer {
  const w = new BinaryWriter(1024);

  w.uint32(TRK_MAGIC);
  w.uint16(TRK_VERSION);
  w.uint16(g.trackIdIndex);
  w.uint16(g.lapCount);
  w.uint16(byteLen(g.name));
  w.uint16(byteLen(g.city));
  w.uint16(g.roads.length);
  w.uint16(g.jumpRamps.length);
  w.uint16(g.waypointGraph.nodes.length);
  w.uint16(g.waypointGraph.edges.length);
  w.uint16(g.hazardZones.length);
  w.uint16(g.scenery.length);
  w.uint16(g.pitLane.path.length);
  w.uint32(0);

  w.fixedString(g.name, byteLen(g.name));
  w.fixedString(g.city, byteLen(g.city));

  for (const seg of g.roads) {
    writeVec2(w, seg.centre);
    w.float32(seg.width);
    writeVec2(w, seg.normal);
    w.uint8(SURFACE_TYPES.indexOf(seg.surface));
    w.uint8(0);
  }

  for (const ramp of g.jumpRamps) {
    writeVec2(w, ramp.position);
    w.float32(ramp.angle);
    w.float32(ramp.launchMultiplier);
  }

  for (const node of g.waypointGraph.nodes) {
    w.uint16(node.id);
    writeVec2(w, node.position);
    w.float32(node.width);
  }
  for (const edge of g.waypointGraph.edges) {
    w.uint16(edge.from);
    w.uint16(edge.to);
    w.float32(edge.distance);
  }

  writeVec2(w, g.pitLane.entryPosition);
  writeVec2(w, g.pitLane.exitPosition);
  for (const p of g.pitLane.path) {
    writeVec2(w, p);
  }

  for (const zone of g.hazardZones) {
    w.uint16(zone.id);
    w.uint16(byteLen(zone.hazardType));
    w.fixedString(zone.hazardType, byteLen(zone.hazardType));
    w.uint16(zone.bounds.length);
    for (const v of zone.bounds) {
      writeVec2(w, v);
    }
  }

  for (const obj of g.scenery) {
    w.uint16(obj.id);
    writeVec2(w, obj.position);
    w.float32(obj.depth);
    w.uint16(byteLen(obj.spriteId));
    w.fixedString(obj.spriteId, byteLen(obj.spriteId));
  }

  w.bytes(g.palette);

  return Buffer.from(w.toUint8Array());
}

// ---------------------------------------------------------------------------
// Property 23
// ---------------------------------------------------------------------------

describe('Property 23: track file parse-encode round-trip is byte-equivalent', () => {
  // encode(parse(buf)) === buf for arbitrary well-formed .TRK buffers.
  // Validates: Requirements 9.6
  it('re-encoding a parsed track reproduces the original buffer byte-for-byte', () => {
    fc.assert(
      fc.property(trackArb, (g) => {
        const original = encodeGenerated(g);
        const parsed = parseTrack(original);
        const reEncoded = encodeTrackData(parsed);
        expect(reEncoded.equals(original)).toBe(true);
      }),
    );
  });

  // encode -> parse -> encode is stable: a second round-trip yields identical
  // bytes, confirming the fixed point is reached and stays reached.
  // Validates: Requirements 9.6
  it('is idempotent under repeated parse-encode cycles', () => {
    fc.assert(
      fc.property(trackArb, (g) => {
        const first = encodeTrackData(parseTrack(encodeGenerated(g)));
        const second = encodeTrackData(parseTrack(first));
        expect(second.equals(first)).toBe(true);
      }),
    );
  });
});
