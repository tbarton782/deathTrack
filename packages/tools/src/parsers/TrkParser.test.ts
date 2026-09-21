/**
 * Tests for the `.TRK` track parser.
 *
 * Uses the shared `BinaryWriter` to synthesise well-formed `.TRK` buffers that
 * match the layout documented in `TrkParser.ts`, then asserts `parseTrack`
 * reconstructs every geometry element. Also covers malformed-input error
 * reporting and a parse round-trip property.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
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
  Vec2,
  WaypointGraph,
} from '@deathtrack/shared';
import { parseTrack, TrkParseError, TRK_MAGIC, TRK_VERSION } from './TrkParser.js';

// ---------------------------------------------------------------------------
// Fixture encoder — mirrors the layout documented in TrkParser.ts
// ---------------------------------------------------------------------------

const TRACK_IDS = [
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

const SURFACE_TYPES: readonly SurfaceType[] = ['asphalt', 'dirt', 'gravel'];

interface TrackFixture {
  trackIdIndex: number;
  name: string;
  city: string;
  lapCount: number;
  roadGeometry: RoadSegment[];
  jumpRamps: JumpRamp[];
  waypointGraph: WaypointGraph;
  pitLane: PitLaneData;
  hazardZones: HazardZone[];
  scenery: SceneryObject[];
  palette: Uint8Array;
}

const utf8 = new TextEncoder();
const byteLen = (s: string): number => utf8.encode(s).length;

function writeVec2(w: BinaryWriter, v: Vec2): void {
  w.float32(v.x).float32(v.y);
}

/** Encode a fixture into a `.TRK` buffer following the documented layout. */
function encodeTrk(f: TrackFixture): Buffer {
  const w = new BinaryWriter(1024);

  // Header (32 bytes)
  w.uint32(TRK_MAGIC);
  w.uint16(TRK_VERSION);
  w.uint16(f.trackIdIndex);
  w.uint16(f.lapCount);
  w.uint16(byteLen(f.name));
  w.uint16(byteLen(f.city));
  w.uint16(f.roadGeometry.length);
  w.uint16(f.jumpRamps.length);
  w.uint16(f.waypointGraph.nodes.length);
  w.uint16(f.waypointGraph.edges.length);
  w.uint16(f.hazardZones.length);
  w.uint16(f.scenery.length);
  w.uint16(f.pitLane.path.length);
  w.uint32(0); // reserved

  // Names
  w.fixedString(f.name, byteLen(f.name));
  w.fixedString(f.city, byteLen(f.city));

  // Road segments
  for (const seg of f.roadGeometry) {
    writeVec2(w, seg.centre);
    w.float32(seg.width);
    writeVec2(w, seg.normal);
    w.uint8(SURFACE_TYPES.indexOf(seg.surface));
    w.uint8(0); // padding
  }

  // Jump ramps
  for (const ramp of f.jumpRamps) {
    writeVec2(w, ramp.position);
    w.float32(ramp.angle);
    w.float32(ramp.launchMultiplier);
  }

  // Waypoint nodes
  for (const node of f.waypointGraph.nodes) {
    w.uint16(node.id);
    writeVec2(w, node.position);
    w.float32(node.width);
  }
  // Waypoint edges
  for (const edge of f.waypointGraph.edges) {
    w.uint16(edge.from);
    w.uint16(edge.to);
    w.float32(edge.distance);
  }

  // Pit lane
  writeVec2(w, f.pitLane.entryPosition);
  writeVec2(w, f.pitLane.exitPosition);
  for (const p of f.pitLane.path) {
    writeVec2(w, p);
  }

  // Hazard zones
  for (const zone of f.hazardZones) {
    w.uint16(zone.id);
    w.uint16(byteLen(zone.hazardType));
    w.fixedString(zone.hazardType, byteLen(zone.hazardType));
    w.uint16(zone.bounds.length);
    for (const v of zone.bounds) {
      writeVec2(w, v);
    }
  }

  // Scenery
  for (const obj of f.scenery) {
    w.uint16(obj.id);
    writeVec2(w, obj.position);
    w.float32(obj.depth);
    w.uint16(byteLen(obj.spriteId));
    w.fixedString(obj.spriteId, byteLen(obj.spriteId));
  }

  // Palette (768 bytes)
  w.bytes(f.palette);

  return Buffer.from(w.toUint8Array());
}

function makePalette(seed = 0): Uint8Array {
  const p = new Uint8Array(256 * 3);
  for (let i = 0; i < p.length; i += 1) {
    p[i] = (i + seed) & 0xff;
  }
  return p;
}

/** A representative fixture exercising every section. */
function sampleFixture(): TrackFixture {
  return {
    trackIdIndex: 4, // los_angeles
    name: 'Downtown LA',
    city: 'Los Angeles',
    lapCount: 3,
    roadGeometry: [
      {
        index: 0,
        centre: { x: 1.5, y: 2.5 },
        width: 10,
        normal: { x: 0, y: 1 },
        surface: 'asphalt',
      },
      {
        index: 1,
        centre: { x: 3.5, y: 4.5 },
        width: 12,
        normal: { x: 1, y: 0 },
        surface: 'dirt',
      },
    ],
    jumpRamps: [{ position: { x: 20, y: 30 }, angle: 15, launchMultiplier: 1.25 }],
    waypointGraph: {
      nodes: [
        { id: 0, position: { x: 0, y: 0 }, width: 8 },
        { id: 1, position: { x: 5, y: 0 }, width: 8 },
      ],
      edges: [{ from: 0, to: 1, distance: 5 }],
    },
    pitLane: {
      entryPosition: { x: 100, y: 5 },
      exitPosition: { x: 120, y: 5 },
      path: [
        { x: 105, y: 5 },
        { x: 110, y: 5 },
      ],
    },
    hazardZones: [
      {
        id: 0,
        hazardType: 'oil_slick',
        bounds: [
          { x: 0, y: 0 },
          { x: 1, y: 0 },
          { x: 1, y: 1 },
        ],
      },
    ],
    scenery: [{ id: 0, position: { x: 50, y: 60 }, spriteId: 'palm_tree', depth: 2.5 }],
    palette: makePalette(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseTrack', () => {
  it('parses all geometry sections from a well-formed buffer', () => {
    const fixture = sampleFixture();
    const track = parseTrack(encodeTrk(fixture));

    expect(track.id).toBe('los_angeles');
    expect(track.name).toBe('Downtown LA');
    expect(track.city).toBe('Los Angeles');
    expect(track.lapCount).toBe(3);

    expect(track.roadGeometry).toEqual(fixture.roadGeometry);
    expect(track.jumpRamps).toEqual(fixture.jumpRamps);
    expect(track.waypointGraph).toEqual(fixture.waypointGraph);
    expect(track.pitLane).toEqual(fixture.pitLane);
    expect(track.hazardZones).toEqual(fixture.hazardZones);
    expect(track.scenery).toEqual(fixture.scenery);
    expect(track.palette).toEqual(fixture.palette);
  });

  it('parses a minimal track with empty geometry collections', () => {
    const fixture: TrackFixture = {
      trackIdIndex: 0,
      name: 'Bay',
      city: 'SF',
      lapCount: 1,
      roadGeometry: [],
      jumpRamps: [],
      waypointGraph: { nodes: [], edges: [] },
      pitLane: { entryPosition: { x: 0, y: 0 }, exitPosition: { x: 1, y: 1 }, path: [] },
      hazardZones: [],
      scenery: [],
      palette: makePalette(7),
    };
    const track = parseTrack(encodeTrk(fixture));
    expect(track.id).toBe('bay_area');
    expect(track.roadGeometry).toHaveLength(0);
    expect(track.waypointGraph.nodes).toHaveLength(0);
    expect(track.palette).toHaveLength(768);
  });

  it('assigns sequential indices to road segments', () => {
    const track = parseTrack(encodeTrk(sampleFixture()));
    track.roadGeometry.forEach((seg, i) => expect(seg.index).toBe(i));
  });

  it('throws TrkParseError with offset 0 on bad magic', () => {
    const buf = encodeTrk(sampleFixture());
    buf.writeUInt32LE(0xdeadbeef, 0);
    expect(() => parseTrack(buf)).toThrow(TrkParseError);
    try {
      parseTrack(buf);
    } catch (err) {
      expect(err).toBeInstanceOf(TrkParseError);
      expect((err as TrkParseError).offset).toBe(0);
    }
  });

  it('throws on an unsupported version', () => {
    const buf = encodeTrk(sampleFixture());
    buf.writeUInt16LE(TRK_VERSION + 1, 4);
    expect(() => parseTrack(buf)).toThrow(/unsupported version/);
  });

  it('throws on an out-of-range track id', () => {
    const buf = encodeTrk(sampleFixture());
    buf.writeUInt16LE(99, 6);
    expect(() => parseTrack(buf)).toThrow(/track id index 99 out of range/);
  });

  it('throws on an unknown surface code', () => {
    const fixture = sampleFixture();
    const buf = encodeTrk(fixture);
    // First road segment surface code sits right after the header + names +
    // (centre.x, centre.y, width, normal.x, normal.y) = 5 float32s.
    const surfaceOffset = 32 + byteLen(fixture.name) + byteLen(fixture.city) + 5 * 4;
    buf.writeUInt8(200, surfaceOffset);
    expect(() => parseTrack(buf)).toThrow(/unknown surface code 200/);
  });

  it('throws a TrkParseError with a positive offset on truncation', () => {
    const full = encodeTrk(sampleFixture());
    const truncated = full.subarray(0, full.length - 100);
    let caught: unknown;
    try {
      parseTrack(truncated);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TrkParseError);
    expect((caught as TrkParseError).offset).toBeGreaterThan(0);
  });

  it('throws when the buffer is smaller than the header', () => {
    const tiny = Buffer.alloc(8);
    expect(() => parseTrack(tiny)).toThrow(/buffer too small/);
  });

  // Parse round-trip: encoding a fixture and parsing it back reproduces the
  // structured data. Validates: Requirements 9.6
  it('round-trips arbitrary well-formed tracks (property)', () => {
    const finiteF32 = fc
      .float({ min: -1e6, max: 1e6, noNaN: true })
      // constrain to exact float32 values so encode->decode is lossless
      .map((n) => Math.fround(n));
    const vec2 = fc.record({ x: finiteF32, y: finiteF32 });
    const ascii = fc.string({ minLength: 0, maxLength: 12 }).map((s) =>
      s.replace(/[^\x20-\x7e]/g, 'a'),
    );

    const roadArb = fc.record({
      centre: vec2,
      width: finiteF32,
      normal: vec2,
      surface: fc.constantFrom<SurfaceType>('asphalt', 'dirt', 'gravel'),
    });

    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 9 }),
        ascii,
        ascii,
        fc.integer({ min: 0, max: 65535 }),
        fc.array(roadArb, { maxLength: 6 }),
        (trackIdIndex, name, city, lapCount, roads) => {
          const fixture: TrackFixture = {
            trackIdIndex,
            name,
            city,
            lapCount,
            roadGeometry: roads.map((r, index) => ({ index, ...r })),
            jumpRamps: [],
            waypointGraph: { nodes: [], edges: [] },
            pitLane: {
              entryPosition: { x: 0, y: 0 },
              exitPosition: { x: 0, y: 0 },
              path: [],
            },
            hazardZones: [],
            scenery: [],
            palette: makePalette(),
          };
          const parsed = parseTrack(encodeTrk(fixture));
          expect(parsed.id).toBe(TRACK_IDS[trackIdIndex]);
          expect(parsed.name).toBe(name);
          expect(parsed.city).toBe(city);
          expect(parsed.lapCount).toBe(lapCount);
          expect(parsed.roadGeometry).toEqual(fixture.roadGeometry);
        },
      ),
    );
  });
});
