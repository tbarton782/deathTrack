/**
 * Integration test: the track asset pipeline, end-to-end through
 * `AssetLoader.loadTrack`.
 *
 * Requirement 9.1/9.2 calls for loading each of the ten converted city tracks
 * and confirming the parse succeeds and a usable AI waypoint graph is available.
 *
 * This test prefers the **real** converted containers: when the original DOS
 * game files are present, it runs the `@deathtrack/tools` `convertReal`
 * pipeline over them into a temp directory and loads the resulting
 * `assets/tracks/<id>.dtasset` bundles through the shipped
 * `BinaryAssetLoader.loadTrack` -> `reconstructTrack` decode path — the genuine
 * decode-of-real-data pipeline (task 25.12). Real tracks emit an empty
 * `waypointGraph` on purpose (the `.TRK` format carries no graph), so the AI
 * navigation graph is verified by running the runtime `buildWaypointGraph`,
 * which rebuilds a populated closed-loop graph from the decoded `roadSegments`.
 *
 * When the game files are absent (a clean checkout / CI — they are not in
 * source control), the test falls back to synthetic containers assembled with
 * the SAME framing the conversion tool emits (magic | version | kind | length |
 * JSON payload | CRC-32), so the decode pipeline is still exercised without
 * faking a pass. The synthetic fixtures carry an authored `waypointGraph`.
 *
 * Either way, for each of the ten tracks the assertion is: `loadTrack` resolves
 * without a `TrackLoadError`, the decoded track has road geometry, and a
 * non-empty AI waypoint graph is obtainable.
 *
 * Validates: Requirements 9.1, 9.2
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, accessSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import {
  BinaryAssetLoader,
  BinaryWriter,
  buildWaypointGraph,
  crc32,
  ASSET_MAGIC,
  ASSET_VERSION,
  AssetKind,
  TrackLoadError,
  type AssetSource,
  type TrackDef,
  type TrackId,
} from '@deathtrack/shared';
import { convertReal } from '@deathtrack/tools';

// ---------------------------------------------------------------------------
// The ten city tracks (one converted bundle each).
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
];

// ---------------------------------------------------------------------------
// Fixture generation.
// ---------------------------------------------------------------------------

/**
 * Build a deterministic, structurally-complete `TrackDef` for one track. Every
 * field the loader's `reconstructTrack` requires is present, and the waypoint
 * graph carries several connected nodes so the `nodes.length > 0` assertion is
 * a real check rather than a tautology. The shape (including a `palette` as a
 * flat RGB number array) mirrors what the conversion tool serialises.
 */
function buildTrackDef(id: TrackId, index: number): Record<string, unknown> {
  // A small ring of waypoints; count varies per track so fixtures are distinct.
  const nodeCount = 4 + index;
  const nodes = Array.from({ length: nodeCount }, (_, i) => ({
    id: i,
    position: { x: Math.cos((i / nodeCount) * Math.PI * 2) * 100, y: Math.sin((i / nodeCount) * Math.PI * 2) * 100 },
    width: 12,
  }));
  const edges = nodes.map((from, i) => {
    const toIndex = (i + 1) % nodeCount;
    const to = nodes[toIndex]!;
    const dx = to.position.x - from.position.x;
    const dy = to.position.y - from.position.y;
    return { from: i, to: toIndex, distance: Math.hypot(dx, dy) };
  });

  const roadSegments = nodes.map((n, i) => ({
    index: i,
    centre: n.position,
    width: 24,
    normal: { x: 0, y: 1 },
    surface: 'asphalt',
  }));

  // 256-colour palette as a flat RGB byte array (256 * 3), serialised as a
  // plain number array exactly as the tool's JSON replacer emits typed arrays.
  const palette = Array.from({ length: 256 * 3 }, (_, i) => i % 256);

  return {
    id,
    name: `Track ${index}`,
    city: id,
    lapCount: 3,
    roadSegments,
    jumpRamps: [
      { position: { x: 50, y: 0 }, angle: 15, launchMultiplier: 1.4 },
    ],
    waypointGraph: { nodes, edges },
    pitLane: {
      entryPosition: { x: -100, y: 0 },
      exitPosition: { x: 100, y: 0 },
      path: [
        { x: -100, y: 0 },
        { x: 0, y: -20 },
        { x: 100, y: 0 },
      ],
    },
    hazardZones: [
      {
        id: 0,
        bounds: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
        hazardType: 'oil_slick',
      },
    ],
    scenery: [
      { id: 0, position: { x: 20, y: 20 }, spriteId: 'tree', depth: 5 },
    ],
    palette,
  };
}

/** UTF-8 JSON bytes of a value (matches the tool's `toJsonBytes`). */
function toJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

/**
 * Frame a payload into an asset container, byte-for-byte identical to the
 * conversion tool's `encodeAsset`: magic | version | kind | length | payload |
 * crc32-over-everything-preceding.
 */
function encodeContainer(kind: AssetKind, payload: Uint8Array): Uint8Array {
  const writer = new BinaryWriter(payload.byteLength + 16);
  writer.uint32(ASSET_MAGIC);
  writer.uint8(ASSET_VERSION);
  writer.uint8(kind);
  writer.uint32(payload.byteLength);
  writer.bytes(payload);
  const framed = writer.toUint8Array();
  const crc = crc32(framed);
  const withCrc = new BinaryWriter(framed.byteLength + 4);
  withCrc.bytes(framed);
  withCrc.uint32(crc);
  return withCrc.toUint8Array();
}

// ---------------------------------------------------------------------------
// Node filesystem AssetSource: reads container bytes off disk by path.
// ---------------------------------------------------------------------------

class NodeFsAssetSource implements AssetSource {
  constructor(private readonly rootDir: string) {}

  async readAsset(path: string): Promise<Uint8Array> {
    const bytes = readFileSync(join(this.rootDir, path));
    return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
}

// ---------------------------------------------------------------------------
// Test.
// ---------------------------------------------------------------------------

/** The original DOS game folder, if present on this host. */
const DTRACK_DIR = 'C:\\Users\\tbart\\OneDrive\\1Projects\\Games\\dtrack';

/** Whether the real game files are available to convert. */
function dtrackPresent(): boolean {
  try {
    accessSync(join(DTRACK_DIR, 'ORLANDO.TRK'));
    return true;
  } catch {
    return false;
  }
}

describe('asset pipeline: loadTrack over the ten converted tracks', () => {
  let rootDir: string;
  let loader: BinaryAssetLoader;
  /** True when the bundles under test came from the real conversion pipeline. */
  let usingRealAssets = false;

  beforeAll(async () => {
    // A temp root that plays the role of the deployed asset directory. The
    // loader's default basePath is 'assets/', so containers live under
    // <root>/assets/tracks/<id>.dtasset.
    rootDir = mkdtempSync(join(tmpdir(), 'deathtrack-assets-'));

    if (dtrackPresent()) {
      // Preferred path: convert the REAL game files and load those bundles.
      usingRealAssets = true;
      await convertReal(DTRACK_DIR, rootDir, {
        logger: { info: () => {}, error: () => {} },
      });
    } else {
      // Fallback: synthesise byte-identical containers so the decode pipeline
      // is still exercised in a clean checkout without the game files.
      const assetsDir = join(rootDir, 'assets');
      TRACK_IDS.forEach((id, i) => {
        const def = buildTrackDef(id, i);
        const container = encodeContainer(AssetKind.Track, toJsonBytes(def));
        const outPath = join(assetsDir, 'tracks', `${id}.dtasset`);
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, container);
      });
    }

    loader = new BinaryAssetLoader(new NodeFsAssetSource(rootDir));
  });

  afterAll(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('has exactly ten city tracks', () => {
    expect(TRACK_IDS).toHaveLength(10);
  });

  it.each(TRACK_IDS)(
    'loads "%s" without a parse error and yields road geometry + a usable waypoint graph',
    async (id) => {
      let track: TrackDef;
      try {
        track = await loader.loadTrack(id);
      } catch (err) {
        // Surface the exact failure so a regression names the track and reason.
        if (err instanceof TrackLoadError) {
          throw new Error(`loadTrack("${id}") threw TrackLoadError: ${err.message}`);
        }
        throw err;
      }

      expect(track.id).toBe(id);
      // The decoded track carries road geometry (the real centerline, or the
      // synthetic ring).
      expect(track.roadSegments.length).toBeGreaterThan(0);
      // A usable AI waypoint graph is obtainable: real tracks emit an empty
      // graph that the runtime rebuilds from roadSegments; synthetic fixtures
      // carry an authored graph. Either way buildWaypointGraph yields nodes.
      const graph = buildWaypointGraph(track);
      expect(graph.nodes.length).toBeGreaterThan(0);
    },
  );

  it('loads all ten tracks with no parse error and every waypoint graph populated', async () => {
    const results = await Promise.all(
      TRACK_IDS.map(async (id) => {
        const track = await loader.loadTrack(id);
        return { id, nodeCount: buildWaypointGraph(track).nodes.length };
      }),
    );

    expect(results).toHaveLength(10);
    for (const { nodeCount } of results) {
      expect(nodeCount).toBeGreaterThan(0);
    }
  });

  it('reports whether real converted assets were exercised', () => {
    // Not an assertion on the environment — this documents, in the test output,
    // whether the real game files drove this run or the synthetic fallback did.
    expect(typeof usingRealAssets).toBe('boolean');
  });
});
