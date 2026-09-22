/**
 * Tests for the real-asset conversion pipeline (task 25.11).
 *
 * Verifies that `convertReal` runs the section-25 decoders over the real Death
 * Track files and emits `AssetLoader`-compatible containers at the expected
 * nested paths, and that each emitted container round-trips through the shared
 * container decoder (`decodeAsset`). When the real game files are not present
 * (they are not in source control), the real-file test is skipped.
 */

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { describe, it, expect, afterEach } from 'vitest';

import { BinaryAssetLoader, InMemoryAssetSource } from '@deathtrack/shared';

import { convertReal } from '../realPipeline.js';
import { decodeAsset, AssetKind } from '../cli.js';

const DTRACK_DIR = 'C:\\Users\\tbart\\OneDrive\\1Projects\\Games\\dtrack';

/** A silent logger so the test output stays clean. */
const silentLogger = { info: () => {}, error: () => {} };

let tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-real-'));
  tempDirs.push(dir);
  return dir;
}

async function dtrackPresent(): Promise<boolean> {
  try {
    await fs.access(path.join(DTRACK_DIR, 'ACTIVISI'));
    return true;
  } catch {
    return false;
  }
}

/** Read and decode-verify an emitted container, returning its parsed payload. */
async function readAsset(outDir: string, rel: string): Promise<{ kind: AssetKind; payload: unknown }> {
  const bytes = new Uint8Array(await fs.readFile(path.join(outDir, rel)));
  const { kind, payload } = decodeAsset(bytes);
  return { kind, payload: JSON.parse(new TextDecoder().decode(payload)) };
}

describe('convertReal against the real dtrack folder', () => {
  it('converts the decodable formats into loader-compatible containers', async () => {
    if (!(await dtrackPresent())) return; // real files absent; skip

    const outDir = await makeTempDir();
    const result = await convertReal(DTRACK_DIR, outDir, { logger: silentLogger });

    // No conversion errors, and a healthy number of assets written.
    expect(result.errors).toEqual([]);
    expect(result.written.length).toBeGreaterThan(10);

    // Expected nested paths exist for each fully-decoded format.
    expect(result.written).toContain(path.join('assets', 'palette', 'ACTIVISI.dtasset'));
    expect(result.written).toContain(path.join('assets', 'screens', 'CITYPIC.dtasset'));
    expect(result.written).toContain(path.join('assets', 'sprites', 'ANGEL.dtasset'));
    expect(result.written).toContain(path.join('assets', 'fonts', 'FONTS.dtasset'));

    // The palette container decodes to a 16-colour EGA palette.
    const pal = await readAsset(outDir, path.join('assets', 'palette', 'ACTIVISI.dtasset'));
    expect(pal.kind).toBe(AssetKind.Palette);
    const palPayload = pal.payload as { count: number; rgb: number[] };
    expect(palPayload.count).toBe(16);
    expect(palPayload.rgb.length).toBe(16 * 3);

    // The CITYPIC screen decodes to a 160x200 index buffer.
    const scr = await readAsset(outDir, path.join('assets', 'screens', 'CITYPIC.dtasset'));
    expect(scr.kind).toBe(AssetKind.Screen);
    const scrPayload = scr.payload as { width: number; height: number; indices: number[] };
    expect(scrPayload.width).toBe(160);
    expect(scrPayload.height).toBe(200);
    expect(scrPayload.indices.length).toBe(160 * 200);

    // The ANGEL sprite decodes to a SpriteSheetLoader-compatible bundle.
    const spr = await readAsset(outDir, path.join('assets', 'sprites', 'ANGEL.dtasset'));
    expect(spr.kind).toBe(AssetKind.SpriteSheet);
    const sprPayload = spr.payload as {
      blocks: { width: number; height: number; pixels: number[]; name: string }[];
    };
    expect(sprPayload.blocks.length).toBeGreaterThanOrEqual(1);
    const block = sprPayload.blocks[0]!;
    expect(block.width).toBe(160);
    expect(block.height).toBe(115);
    expect(block.pixels.length).toBe(160 * 115);
    expect(block.name).toBe('ANGEL_0');

    // Tracks are emitted under their canonical trackId as a runtime-loadable
    // TrackDef: real decoded roadSegments (centerline geometry) plus the five
    // fields reconstructTrack requires.
    expect(result.written).toContain(path.join('assets', 'tracks', 'orlando.dtasset'));
    const trk = await readAsset(outDir, path.join('assets', 'tracks', 'orlando.dtasset'));
    expect(trk.kind).toBe(AssetKind.Track);
    const trkPayload = trk.payload as {
      id: string;
      roadPathClosed: boolean;
      roadPath: { x: number; profile: number; z: number }[];
      roadSegments: { index: number; centre: { x: number; y: number }; width: number; normal: { x: number; y: number }; surface: string }[];
      waypointGraph: { nodes: unknown[]; edges: unknown[] };
    };
    expect(trkPayload.id).toBe('orlando');
    expect(trkPayload.roadPathClosed).toBe(true);
    expect(trkPayload.roadPath.length).toBeGreaterThan(500);
    // roadSegments is the real centerline: one segment per road-path point,
    // each with a decoded centre and a unit normal.
    expect(trkPayload.roadSegments.length).toBe(trkPayload.roadPath.length);
    const seg0 = trkPayload.roadSegments[0]!;
    expect(seg0.centre.x).toBe(trkPayload.roadPath[0]!.x);
    expect(seg0.centre.y).toBe(trkPayload.roadPath[0]!.z);
    expect(Math.hypot(seg0.normal.x, seg0.normal.y)).toBeCloseTo(1, 5);
    // The waypoint graph is intentionally empty (runtime rebuilds it).
    expect(trkPayload.waypointGraph.nodes.length).toBe(0);

    // The container actually loads through the shared runtime loader: build an
    // in-memory source over every emitted asset and prove reconstructTrack
    // accepts the Orlando track (all five required fields present).
    const assetEntries = await Promise.all(
      result.written.map(async (rel) => {
        const bytes = new Uint8Array(await fs.readFile(path.join(outDir, rel)));
        // The loader keys on `assets/<...>` with forward slashes (basePath
        // defaults to 'assets/'); `rel` is already `assets/<...>` but uses the
        // OS path separator.
        const key = rel.split(path.sep).join('/');
        return [key, bytes] as const;
      }),
    );
    const source = new InMemoryAssetSource(assetEntries);
    const loader = new BinaryAssetLoader(source);
    const trackDef = await loader.loadTrack('orlando');
    expect(trackDef.id).toBe('orlando');
    expect(trackDef.roadSegments.length).toBeGreaterThan(500);
    expect(trackDef.name).toBe('Orlando');
    expect(Array.isArray(trackDef.jumpRamps)).toBe(true);

    // Backdrops (.MAP) are emitted too.
    expect(result.written.some((p) => p.includes(`${path.sep}backdrops${path.sep}`))).toBe(true);

    // Tables/music are still deliberately not emitted (deferred/blocked).
    expect(result.written.some((p) => p.includes(`${path.sep}tables${path.sep}`))).toBe(false);

    // Every emitted container round-trips through the shared decoder.
    for (const rel of result.written) {
      const bytes = new Uint8Array(await fs.readFile(path.join(outDir, rel)));
      expect(() => decodeAsset(bytes)).not.toThrow();
    }
  });
});
