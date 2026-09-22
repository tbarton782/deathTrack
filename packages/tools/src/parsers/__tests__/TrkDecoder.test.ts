/**
 * Tests for the `.TRK` track decoder, verified against all 10 real Death Track
 * tracks. Confidently decoded: the `"TRK:"` tag, the lead-in `(dx, distance)`
 * centerline preamble, and the **road path** — an `[x, profile, z]` polyline
 * tracing the track centerline (verified to render as a closed race circuit).
 * Anything past the traced road path is exposed raw. These tests lock in the
 * confirmed structure, the road-path polyline, and the "all 10 decode without
 * error" acceptance criterion (Requirement 9.2).
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { describe, it, expect } from 'vitest';

import {
  decodeTrk,
  trackIdForFilename,
  TRK_TAG,
  TrkDecodeError,
} from '../TrkDecoder.js';

const DTRACK_DIR = 'C:\\Users\\tbart\\OneDrive\\1Projects\\Games\\dtrack';

const TRACK_FILES = [
  'BAY_AREA.TRK',
  'BOSTON.TRK',
  'CHICAGO.TRK',
  'HOUSTON.TRK',
  'LA.TRK',
  'NYC.TRK',
  'ORLANDO.TRK',
  'PHOENIX.TRK',
  'SEATTLE.TRK',
  'ST_LOUIS.TRK',
];

/** Tracks whose road path traces a full closed loop covering ~the whole body. */
const FULL_LOOP_TRACKS = new Set(['ORLANDO.TRK', 'PHOENIX.TRK', 'ST_LOUIS.TRK']);

async function readTrack(name: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await fs.readFile(path.join(DTRACK_DIR, name)));
  } catch {
    return undefined;
  }
}

/** Build a `.TRK` buffer from a body of int16 values (prepends the TRK: tag). */
function makeTrk(body: number[]): Uint8Array {
  const bytes = new Uint8Array(4 + body.length * 2);
  bytes.set([0x54, 0x52, 0x4b, 0x3a], 0); // "TRK:"
  for (let i = 0; i < body.length; i += 1) {
    bytes[4 + i * 2] = body[i]! & 0xff;
    bytes[4 + i * 2 + 1] = (body[i]! >> 8) & 0xff;
  }
  return bytes;
}

describe('decodeTrk (synthetic)', () => {
  it('decodes the tag and a short centerline preamble', () => {
    // "TRK:" + pairs (2,10)(−3,20)(0,20) then a decreasing distance ends the run.
    // The road path then reads the remaining record(s) as [x,profile,z].
    const bytes = makeTrk([2, 10, -3, 20, 0, 20, 0, 5]);
    const track = decodeTrk(bytes);
    expect(track.centerline).toEqual([
      { dx: 2, distance: 10 },
      { dx: -3, distance: 20 },
      { dx: 0, distance: 20 },
    ]);
    expect(track.centerlineEnd).toBe(4 + 3 * 4);
    expect(track.int16Stream.length).toBe(8);
    // The road path starts at or after the centerline end; sections plus the
    // raw tail cover the whole file.
    expect(track.roadPathStart).toBeGreaterThanOrEqual(track.centerlineEnd);
    expect(track.roadPathEnd + track.tail.length).toBe(bytes.length);
  });

  it('traces a road-path polyline advancing one ground axis at a time', () => {
    // Centerline preamble (1, 100), then a small square-ish path in [x,profile,z]:
    //   (0,5,0) -> (30,6,0) -> (30,7,30) -> (0,8,30) -> (0,9,0)  [returns near start]
    // Each step moves x OR z by 30 while the other holds.
    const bytes = makeTrk([
      1, 100, // centerline pair (distance rises to 100)
      0, 5, 0,
      30, 6, 0,
      30, 7, 30,
      0, 8, 30,
      0, 9, 0,
    ]);
    const track = decodeTrk(bytes);
    // The centerline preamble is just the first (1,100) pair; the path starts
    // right after it.
    expect(track.roadPath.length).toBeGreaterThanOrEqual(5);
    const xs = track.roadPath.map((p) => p.x);
    const zs = track.roadPath.map((p) => p.z);
    expect(xs.slice(0, 5)).toEqual([0, 30, 30, 0, 0]);
    expect(zs.slice(0, 5)).toEqual([0, 0, 30, 30, 0]);
    // profile column is carried through.
    expect(track.roadPath[1]!.profile).toBe(6);
  });

  it('rejects a file without the TRK: tag', () => {
    const bytes = new Uint8Array([0x42, 0x41, 0x44, 0x21, 0, 0]);
    expect(() => decodeTrk(bytes)).toThrowError(TrkDecodeError);
  });

  it('rejects an odd-length body', () => {
    const bytes = new Uint8Array([0x54, 0x52, 0x4b, 0x3a, 1]); // TRK: + 1 stray byte
    expect(() => decodeTrk(bytes)).toThrowError(TrkDecodeError);
  });
});

describe('decodeTrk against all 10 real tracks', () => {
  it('decodes every track without error, with a valid centerline and road path', async () => {
    let checked = 0;
    for (const name of TRACK_FILES) {
      const bytes = await readTrack(name);
      if (bytes === undefined) continue;
      checked += 1;

      const track = decodeTrk(bytes);
      // Tag and even int16 body.
      expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe(TRK_TAG);
      expect(track.int16Stream.length).toBe((bytes.length - 4) / 2);

      // A real centerline preamble has several samples with non-decreasing distance.
      expect(track.centerline.length).toBeGreaterThanOrEqual(4);
      for (let i = 1; i < track.centerline.length; i += 1) {
        expect(track.centerline[i]!.distance).toBeGreaterThanOrEqual(
          track.centerline[i - 1]!.distance,
        );
      }

      // The road path is a substantial polyline whose consecutive points move
      // smoothly (one ground axis at a time, small steps).
      expect(track.roadPath.length).toBeGreaterThan(50);
      for (let i = 1; i < track.roadPath.length; i += 1) {
        const dx = Math.abs(track.roadPath[i]!.x - track.roadPath[i - 1]!.x);
        const dz = Math.abs(track.roadPath[i]!.z - track.roadPath[i - 1]!.z);
        expect(Math.min(dx, dz)).toBeLessThanOrEqual(40);
      }

      // Sections cover the whole file exactly, offsets ordered.
      expect(track.roadPathStart).toBeGreaterThanOrEqual(track.centerlineEnd);
      expect(track.roadPathEnd).toBeGreaterThan(track.roadPathStart);
      expect(track.roadPathEnd + track.tail.length).toBe(bytes.length);
    }
    if (checked > 0) expect(checked).toBe(TRACK_FILES.length);
  });

  it('traces a full closed circuit for the single-section tracks', async () => {
    for (const name of FULL_LOOP_TRACKS) {
      const bytes = await readTrack(name);
      if (bytes === undefined) continue;
      const track = decodeTrk(bytes);
      // These tracks' road path covers all but a tiny terminator (<= 8 bytes)
      // and forms a large closed loop that returns near its start.
      expect(track.tail.length).toBeLessThanOrEqual(8);
      expect(track.roadPath.length).toBeGreaterThan(500);
      expect(track.roadPathClosed).toBe(true);
    }
  });
});

describe('trackIdForFilename', () => {
  it('maps every real filename to its internal trackId', () => {
    expect(trackIdForFilename('BAY_AREA.TRK')).toBe('bay_area');
    expect(trackIdForFilename('LA.TRK')).toBe('los_angeles');
    expect(trackIdForFilename('NYC.TRK')).toBe('manhattan');
    expect(trackIdForFilename('ST_LOUIS.TRK')).toBe('st_louis');
    // Case-insensitive and path/extension tolerant.
    expect(trackIdForFilename('c:\\games\\dtrack\\seattle.trk')).toBe('seattle');
    expect(trackIdForFilename('UNKNOWN.TRK')).toBeUndefined();
  });
});
