/**
 * Real-asset conversion pipeline (task 25.11).
 *
 * Converts the **real** Death Track (Dynamix, 1989) game files using the
 * reverse-engineered section-25 decoders (`ChunkReader`, `decompress`,
 * `PaletteDecoder`, `ScrDecoder`, `BmpDecoder`, `FntDecoder`) and emits
 * `AssetLoader`-compatible containers (`encodeAsset`, same magic/version/kind/
 * CRC framing the runtime `BinaryAssetLoader` reads) under a nested `assets/`
 * tree.
 *
 * This supersedes the legacy `run`/`DISPATCH` path in `cli.ts`, which targeted
 * the assumed (section-4) layouts. It is intentionally scoped to the formats
 * that are **fully decoded and verified against the real files**:
 *
 * - `PAL:` container (`ACTIVISI`) → 16-colour EGA palette → `assets/palette/<name>.dtasset`
 * - `.SCR` full-screen images → 160×200 indices → `assets/screens/<name>.dtasset`
 * - `.BMP` / `.BLK` sprite sheets → `SpriteSheetBundle` → `assets/sprites/<name>.dtasset`
 * - `FONTS.BLK` fonts → glyph data → `assets/fonts/<name>.dtasset`
 * - `.MAP` track horizon backdrops → strips → `assets/backdrops/<name>.dtasset`
 * - `.TRK` tracks → a runtime-loadable `TrackDef` → `assets/tracks/<trackId>.dtasset`
 *   (named by the canonical `trackId`). The decoded road-path polyline becomes
 *   real `roadSegments` (centre + computed normal); the waypoint graph is left
 *   empty so the runtime rebuilds it from the segments. Data the `.TRK` format
 *   does not encode — per-segment lane width/surface (documented defaults) and
 *   the gameplay zones (`pitLane`/`jumpRamps`/`hazardZones`/`scenery`, emitted
 *   empty rather than fabricated; the decoded tail is only a terminator, see
 *   task 25.9). The raw `roadPath` (incl. the neutral `profile` column) and
 *   lead-in `centerline` are carried through for fidelity. The container loads
 *   through `BinaryAssetLoader.loadTrack` / `reconstructTrack`.
 *
 * Deliberately **not** emitted (blocked / reclassified — see tasks.md §25):
 * `.TBL` (3D vector models, not stat tables), and `.MUS`.
 *
 * Requirements: 9.1, 9.5, 9.6
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { AssetKind, encodeAsset } from './cli.js';
import { parseChunks } from './parsers/ChunkReader.js';
import { decodePalContainer, type Palette } from './parsers/PaletteDecoder.js';
import { decodeScr } from './parsers/ScrDecoder.js';
import { decodeBmpFile, type SpriteSheet } from './parsers/BmpDecoder.js';
import { decodeFonts, type Font } from './parsers/FntDecoder.js';
import { decodeMap } from './parsers/MapDecoder.js';
import { decodeTrk, trackIdForFilename } from './parsers/TrkDecoder.js';

/** Serialise a value to UTF-8 JSON bytes, expanding typed arrays to number[]. */
function toJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(value, (_key, v) =>
      v instanceof Uint8Array || v instanceof Uint8ClampedArray ? Array.from(v) : v,
    ),
  );
}

/** A single logged conversion failure. */
export interface RealConversionError {
  file: string;
  message: string;
}

/** Outcome of a {@link convertReal} run. */
export interface RealConversionResult {
  /** Relative paths (under the output root) of assets successfully written. */
  written: string[];
  /** Files skipped because their type is not (yet) part of the real pipeline. */
  skipped: string[];
  /** Conversion failures, each carrying the file name. */
  errors: RealConversionError[];
}

/** A minimal console-like sink so tests can capture log output. */
export interface Logger {
  info(message: string): void;
  error(message: string): void;
}

const defaultLogger: Logger = {
  info: (m) => console.log(m),
  error: (m) => console.error(m),
};

/** Options controlling {@link convertReal}. */
export interface ConvertRealOptions {
  logger?: Logger;
}

/**
 * The `SpriteSheetBundle` shape the shared `SpriteSheetLoader` consumes: an
 * ordered list of blocks with palette-index pixels. Mirrored here so the tools
 * package does not import runtime types from `shared`.
 */
interface SpriteBundleJson {
  blocks: { width: number; height: number; pixels: number[]; name: string }[];
}

/** Convert a decoded {@link SpriteSheet} to the loader's bundle JSON shape. */
function spriteSheetToBundle(sheet: SpriteSheet, baseName: string): SpriteBundleJson {
  return {
    blocks: sheet.images.map((img, i) => ({
      width: img.width,
      height: img.height,
      pixels: Array.from(img.indices),
      name: `${baseName}_${i}`,
    })),
  };
}

/** Convert a decoded palette to the loader's flat-RGB palette JSON shape. */
function paletteToJson(pal: Palette): { count: number; rgb: number[] } {
  return { count: pal.count, rgb: Array.from(pal.rgb) };
}

/** Convert decoded fonts to a compact JSON shape. */
function fontsToJson(fonts: Font[]): unknown {
  return {
    fonts: fonts.map((f) => ({
      width: f.width,
      height: f.height,
      startSymbol: f.startSymbol,
      count: f.count,
      glyphs: f.glyphs.map((g) => Array.from(g.pixels)),
    })),
  };
}

/** Base name (no extension, upper-case) of a file path. */
function baseName(file: string): string {
  return path.parse(file).name.toUpperCase();
}

/**
 * Display metadata (name / city) for each canonical trackId. These are the
 * real Death Track venue names — not decoded from the `.TRK` bytes (the format
 * carries no text), so they are a small fixed lookup rather than fabricated
 * per-run values.
 */
const TRACK_META: Readonly<Record<string, { name: string; city: string }>> = {
  bay_area: { name: 'Bay Area', city: 'San Francisco' },
  boston: { name: 'Boston', city: 'Boston' },
  chicago: { name: 'Chicago', city: 'Chicago' },
  houston: { name: 'Houston', city: 'Houston' },
  los_angeles: { name: 'Los Angeles', city: 'Los Angeles' },
  manhattan: { name: 'Manhattan', city: 'New York' },
  orlando: { name: 'Orlando', city: 'Orlando' },
  phoenix: { name: 'Phoenix', city: 'Phoenix' },
  seattle: { name: 'Seattle', city: 'Seattle' },
  st_louis: { name: 'St. Louis', city: 'St. Louis' },
};

/**
 * Default driveable lane width applied to every road segment. The `.TRK`
 * format does not encode a per-segment lane width (see `TrkDecoder`), so a
 * single documented constant is used rather than inventing per-segment values.
 * The runtime treats `RoadSegment.width` as the full lane width in track-space
 * units.
 */
const DEFAULT_ROAD_WIDTH = 20;

/** A road-path point as emitted by the TRK decoder. */
interface RoadPathPointJson {
  x: number;
  profile: number;
  z: number;
}

/**
 * Transform a decoded `.TRK` road-path polyline into a runtime-loadable
 * `TrackDef`-shaped JSON payload (the shape `BinaryAssetLoader.reconstructTrack`
 * and `buildWaypointGraph` consume).
 *
 * What is **real decoded geometry**: `roadSegments[i].centre` (`x` from the
 * ground-plane X column, `y` from the ground-plane Z column) and
 * `roadSegments[i].normal` (the unit perpendicular of the direction to the next
 * point). The raw `roadPath` (incl. the neutral `profile` column) and lead-in
 * `centerline` are carried through unchanged for fidelity.
 *
 * What is **a documented default** (not in the `.TRK` format): each segment's
 * `width` ({@link DEFAULT_ROAD_WIDTH}) and `surface` (`'asphalt'`).
 *
 * What is **honestly empty** (no such section exists in the `.TRK` — the decoded
 * tail is only a terminator): `jumpRamps`, `hazardZones`, `scenery`, and
 * `pitLane.path`. `waypointGraph` is left empty on purpose so the runtime
 * `buildWaypointGraph` rebuilds it from `roadSegments` (a closed loop over the
 * ordered centerline).
 */
function roadPathToTrackDef(
  trackId: string,
  roadPath: RoadPathPointJson[],
  centerline: { dx: number; distance: number }[],
  roadPathClosed: boolean,
  source: string,
): Record<string, unknown> {
  const n = roadPath.length;
  const roadSegments = roadPath.map((p, i) => {
    // Direction to the next point (wrapping at the end for a closed loop) gives
    // the road heading; the segment normal is its unit perpendicular.
    const next = roadPath[(i + 1) % n] ?? p;
    const dx = next.x - p.x;
    const dz = next.z - p.z;
    const len = Math.hypot(dx, dz) || 1;
    // Perpendicular of (dx, dz) is (-dz, dx); normalise. Vec2 uses x/y, where
    // our ground-plane Z maps onto y.
    const normal = { x: -dz / len, y: dx / len };
    return {
      index: i,
      centre: { x: p.x, y: p.z },
      width: DEFAULT_ROAD_WIDTH,
      normal,
      surface: 'asphalt' as const,
    };
  });

  const meta = TRACK_META[trackId] ?? { name: trackId, city: trackId };

  return {
    id: trackId,
    name: meta.name,
    city: meta.city,
    lapCount: 3,
    // Real decoded centerline geometry.
    roadSegments,
    // Left empty so the runtime rebuilds the graph from roadSegments.
    waypointGraph: { nodes: [], edges: [] },
    // Not present in the .TRK format — emitted empty rather than fabricated.
    pitLane: {
      entryPosition: { x: 0, y: 0 },
      exitPosition: { x: 0, y: 0 },
      path: [],
    },
    jumpRamps: [],
    hazardZones: [],
    scenery: [],
    // The WebGL palette is supplied separately (assets/palette); an empty array
    // reconstructs to an empty Uint8Array at load time.
    palette: [],
    // Fidelity extras: the raw decoded road path (incl. the neutral profile
    // column), the lead-in centerline preamble, and closure flag.
    roadPath,
    centerline,
    roadPathClosed,
    source,
  };
}

/**
 * Convert the recognised real assets under `inputDir` into `AssetLoader`
 * containers written beneath `outputDir/assets/`. Batch mode: a failure on one
 * file is logged and the walk continues (no partial asset is written for it).
 *
 * @param inputDir  Directory of original Death Track game files.
 * @param outputDir Output root; assets are written under `outputDir/assets/`.
 * @param options   Logging options.
 */
export async function convertReal(
  inputDir: string,
  outputDir: string,
  options: ConvertRealOptions = {},
): Promise<RealConversionResult> {
  const logger = options.logger ?? defaultLogger;
  const assetsDir = path.join(outputDir, 'assets');
  const result: RealConversionResult = { written: [], skipped: [], errors: [] };

  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const writeAsset = async (subdir: string, name: string, kind: AssetKind, payload: unknown) => {
    const dir = path.join(assetsDir, subdir);
    await fs.mkdir(dir, { recursive: true });
    const container = encodeAsset(kind, toJsonBytes(payload));
    const rel = path.join('assets', subdir, `${name}.dtasset`);
    await fs.writeFile(path.join(outputDir, rel), container);
    result.written.push(rel);
    logger.info(`[real] ${name} -> ${rel} (${container.byteLength} bytes)`);
  };

  for (const fname of files) {
    const full = path.join(inputDir, fname);
    const ext = path.extname(fname).slice(1).toLowerCase();
    const stem = baseName(fname);

    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await fs.readFile(full));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ file: fname, message });
      logger.error(`[real] ${fname}: failed to read: ${message}`);
      continue;
    }

    try {
      if (ext === 'scr') {
        // Full-screen image: 160x200 palette indices.
        const image = decodeScr(bytes);
        await writeAsset('screens', stem, AssetKind.Screen, {
          width: image.width,
          height: image.height,
          indices: Array.from(image.indices),
        });
      } else if (ext === 'map') {
        // Track horizon backdrop: N strips of EGA-index pixels.
        const backdrop = decodeMap(bytes);
        await writeAsset('backdrops', stem, AssetKind.Map, {
          count: backdrop.count,
          strips: backdrop.strips.map((s) => ({
            width: s.width,
            height: s.height,
            indices: Array.from(s.indices),
          })),
        });
      } else if (ext === 'trk') {
        // Track: transform the decoded road-path polyline into a runtime
        // `TrackDef`-shaped payload (real `roadSegments` centerline geometry;
        // empty waypoint graph so the runtime rebuilds it; empty gameplay zones
        // that the `.TRK` format does not encode). Named by canonical trackId.
        const track = decodeTrk(bytes);
        const trackId = trackIdForFilename(fname) ?? stem.toLowerCase();
        const roadPath = track.roadPath.map((p) => ({ x: p.x, profile: p.profile, z: p.z }));
        const centerline = track.centerline.map((c) => ({ dx: c.dx, distance: c.distance }));
        const payload = roadPathToTrackDef(
          trackId,
          roadPath,
          centerline,
          track.roadPathClosed,
          stem,
        );
        await writeAsset('tracks', trackId, AssetKind.Track, payload);
      } else if (isFontContainer(bytes)) {
        // A file of FNT: chunks (e.g. FONTS.BLK) — decode before the BMP branch
        // since fonts also use the `.BLK` extension but hold FNT:, not BMP:.
        const fonts = decodeFonts(bytes);
        await writeAsset('fonts', stem, AssetKind.SpriteSheet, fontsToJson(fonts));
      } else if (ext === 'bmp' || ext === 'blk') {
        // Sprite sheet(s): the shared SpriteSheetLoader-compatible bundle.
        const sheets = decodeBmpFile(bytes);
        // A file may hold multiple BMP containers; emit one bundle per file with
        // all subimages concatenated in order, named `<STEM>_<i>`.
        const bundle: SpriteBundleJson = { blocks: [] };
        let idx = 0;
        for (const sheet of sheets) {
          const b = spriteSheetToBundle(sheet, stem);
          for (const block of b.blocks) {
            bundle.blocks.push({ ...block, name: `${stem}_${idx}` });
            idx += 1;
          }
        }
        await writeAsset('sprites', stem, AssetKind.SpriteSheet, bundle);
      } else if (isPaletteContainer(bytes)) {
        // A PAL: container (e.g. ACTIVISI): emit the recovered EGA palette.
        const pal = decodePalContainer(bytes);
        const palette = pal.ega ?? pal.vga;
        if (palette) {
          await writeAsset('palette', stem, AssetKind.Palette, paletteToJson(palette));
        } else {
          result.skipped.push(fname);
        }
      } else {
        result.skipped.push(fname);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ file: fname, message });
      logger.error(`[real] ${fname}: convert failed: ${message}`);
    }
  }

  logger.info(
    `[real] done: ${result.written.length} written, ${result.skipped.length} skipped, ${result.errors.length} error(s)`,
  );
  return result;
}

/**
 * Cheap check for a chunk-wrapped file whose first (or nested) chunk is a
 * `PAL:` container — used to route extensionless files like `ACTIVISI`.
 */
function isPaletteContainer(bytes: Uint8Array): boolean {
  try {
    const chunks = parseChunks(bytes);
    return chunks.some((c) => c.id === 'PAL' || c.children.some((cc) => cc.id === 'PAL'));
  } catch {
    return false;
  }
}

/**
 * Cheap check for a file of top-level `FNT:` chunks (e.g. `FONTS.BLK`), so it is
 * routed to the font decoder rather than the sprite decoder.
 */
function isFontContainer(bytes: Uint8Array): boolean {
  try {
    const chunks = parseChunks(bytes);
    return chunks.length > 0 && chunks.every((c) => c.id === 'FNT');
  } catch {
    return false;
  }
}
