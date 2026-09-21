/**
 * Tests for the `.TRK` track decoder, verified against all 10 real Death Track
 * tracks. The `.TRK` format is only partially reverse-engineered: the `"TRK:"`
 * tag and the leading `(dx, distance)` centerline profile are confidently
 * decoded; the remaining sections (waypoints, ramps, pit lane, hazards,
 * scenery) are exposed raw. These tests lock in the confirmed structure and the
 * "all 10 decode without error" acceptance criterion (Requirement 9.2).
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

async function readTrack(name: string): Promise<Uint8Array | undefined> {
  try {
    return new Uint8Array(await fs.readFile(path.join(DTRACK_DIR, name)));
  } catch {
    return undefined;
  }
}

describe('decodeTrk (synthetic)', () => {
  it('decodes the tag and a short centerline', () => {
    // "TRK:" + pairs (2,10)(−3,20)(0,20) then a non-monotone value to end the run.
    const body = new Int16Array([2, 10, -3, 20, 0, 20, 0, 5]);
    const bytes = new Uint8Array(4 + body.byteLength);
    bytes.set([0x54, 0x52, 0x4b, 0x3a], 0); // TRK:
    for (let i = 0; i < body.length; i += 1) {
      bytes[4 + i * 2] = body[i]! & 0xff;
      bytes[4 + i * 2 + 1] = (body[i]! >> 8) & 0xff;
    }
    const track = decodeTrk(bytes);
    expect(track.centerline).toEqual([
      { dx: 2, distance: 10 },
      { dx: -3, distance: 20 },
      { dx: 0, distance: 20 },
    ]);
    // The 4th pair (0, 5) has a decreasing distance, ending the run.
    expect(track.centerlineEnd).toBe(4 + 3 * 4);
    expect(track.tail.length).toBe(4); // the trailing (0,5) pair
    expect(track.int16Stream.length).toBe(body.length);
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
  it('decodes every track without error, with a monotonic centerline', async () => {
    let checked = 0;
    for (const name of TRACK_FILES) {
      const bytes = await readTrack(name);
      if (bytes === undefined) continue;
      checked += 1;

      const track = decodeTrk(bytes);
      // Tag and even int16 body.
      expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe(TRK_TAG);
      expect(track.int16Stream.length).toBe((bytes.length - 4) / 2);

      // A real centerline has several samples with non-decreasing distance.
      expect(track.centerline.length).toBeGreaterThanOrEqual(4);
      for (let i = 1; i < track.centerline.length; i += 1) {
        expect(track.centerline[i]!.distance).toBeGreaterThanOrEqual(
          track.centerline[i - 1]!.distance,
        );
        expect(Math.abs(track.centerline[i]!.dx)).toBeLessThanOrEqual(200);
      }

      // The tail (undecoded sections) plus the centerline covers the whole file.
      expect(track.centerlineEnd + track.tail.length).toBe(bytes.length);
    }
    // When the game files are present, all 10 must have been checked.
    if (checked > 0) expect(checked).toBe(TRACK_FILES.length);
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
