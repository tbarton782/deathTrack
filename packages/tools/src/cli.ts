/**
 * Asset-conversion CLI entry point for `@deathtrack/tools`.
 *
 * Walks an input directory of original Deathtrack game files, dispatches each
 * file to the appropriate parser by extension, and writes the parsed result as
 * a compact binary asset into an `assets/` subdirectory of the output path. The
 * output container mirrors the shared `SaveFile` on-disk format: a `uint32`
 * magic, a version byte, an asset-kind discriminator, the JSON-encoded parsed
 * payload, and a trailing CRC32 computed over all preceding bytes so the Asset
 * Loader can detect corruption before decoding.
 *
 * Each parser throws a typed error carrying the byte `offset` at which parsing
 * failed (see {@link TrkParseError}, {@link MapParseError}, etc.). When a file
 * fails to parse, the pipeline logs the file/track name together with that byte
 * offset and does not emit a partial asset for that file, satisfying the
 * requirement that a failed track load never produces partial track data.
 *
 * The pipeline is exposed as a programmatic {@link run} function so it can be
 * exercised in tests without spawning a process; {@link main} is the thin CLI
 * wrapper that parses `process.argv` and calls {@link run}.
 *
 * Requirements: 9.5, 9.6
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BinaryWriter, BinaryReader } from '@deathtrack/shared';

import { parseTrack, TrkParseError } from './parsers/TrkParser.js';
import { parseMap, MapParseError } from './parsers/MapParser.js';
import { parseBlk, BlockParseError } from './parsers/BlkParser.js';
import { parsePalette, PaletteParseError } from './parsers/PalParser.js';
import { parseWeaponTable, parseChassisTable, TblParseError } from './parsers/TblParser.js';
import { convertMusToOggStub, MusParseError } from './parsers/MusParser.js';
import { parseScr, ScreenParseError } from './parsers/ScrParser.js';

// ---------------------------------------------------------------------------
// Container format
// ---------------------------------------------------------------------------

/**
 * Magic marking a converted Deathtrack asset container: the ASCII bytes
 * `"DTRA"` as a little-endian `uint32`. This matches the shared `SaveFile`
 * magic so all Deathtrack binary containers share one recognisable prefix.
 */
export const ASSET_MAGIC = 0x44545241;

/** The one supported asset-container format version. */
export const ASSET_VERSION = 1;

/**
 * Discriminator identifying which parser produced an asset's payload. Stored as
 * a single byte after the version so the Asset Loader can route decoding.
 */
export enum AssetKind {
  Track = 1,
  Map = 2,
  SpriteSheet = 3,
  Palette = 4,
  WeaponTable = 5,
  ChassisTable = 6,
  Music = 7,
  Screen = 8,
}

/**
 * Compute a CRC-32 (IEEE 802.3 polynomial, reflected) over `bytes`. Used as the
 * trailing integrity check of every asset container, mirroring the `SaveFile`
 * CRC trailer.
 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc ^= bytes[i] as number;
    for (let bit = 0; bit < 8; bit += 1) {
      const mask = -(crc & 1);
      crc = (crc >>> 1) ^ (0xedb88320 & mask);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Wrap a parsed asset payload in the `SaveFile`-style container:
 * `magic:u32 | version:u8 | kind:u8 | payloadLength:u32 | payload | crc32:u32`.
 *
 * The CRC is computed over every byte preceding it (header + payload) so a
 * reader can verify integrity before trusting the payload.
 *
 * @param kind The asset-kind discriminator for `payload`.
 * @param payload The JSON-encoded parsed representation.
 * @returns The framed container bytes.
 * Requirements: 9.6
 */
export function encodeAsset(kind: AssetKind, payload: Uint8Array): Uint8Array {
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

/** A decoded asset container: its kind, payload bytes, and verified CRC. */
export interface DecodedAsset {
  kind: AssetKind;
  payload: Uint8Array;
}

/**
 * Decode a container produced by {@link encodeAsset}, verifying the magic,
 * version, and trailing CRC32. Primarily used by tests to confirm the
 * encode -> decode round-trip.
 *
 * @throws {Error} If the magic, version, length, or CRC is invalid.
 * Requirements: 9.6
 */
export function decodeAsset(bytes: Uint8Array): DecodedAsset {
  const reader = new BinaryReader(bytes);
  const magic = reader.uint32();
  if (magic !== ASSET_MAGIC) {
    throw new Error(
      `bad asset magic 0x${magic.toString(16).padStart(8, '0')} (expected 0x${ASSET_MAGIC.toString(16)})`,
    );
  }
  const version = reader.uint8();
  if (version !== ASSET_VERSION) {
    throw new Error(`unsupported asset version ${version} (expected ${ASSET_VERSION})`);
  }
  const kind = reader.uint8() as AssetKind;
  const payloadLength = reader.uint32();
  const payload = reader.bytes(payloadLength);
  const storedCrc = reader.uint32();
  const expectedCrc = crc32(bytes.subarray(0, bytes.byteLength - 4));
  if (storedCrc !== expectedCrc) {
    throw new Error(
      `asset CRC mismatch: stored 0x${storedCrc.toString(16)} but computed 0x${expectedCrc.toString(16)}`,
    );
  }
  return { kind, payload };
}

// ---------------------------------------------------------------------------
// Parser dispatch
// ---------------------------------------------------------------------------

/** A parse error that carries the byte offset at which parsing failed. */
interface OffsetError {
  message: string;
  offset: number;
}

/**
 * Narrow an unknown thrown value to an {@link OffsetError} when it is one of the
 * parser error types (all of which expose a numeric `offset`).
 */
function asOffsetError(err: unknown): OffsetError | null {
  if (
    err instanceof TrkParseError ||
    err instanceof MapParseError ||
    err instanceof BlockParseError ||
    err instanceof PaletteParseError ||
    err instanceof TblParseError ||
    err instanceof MusParseError ||
    err instanceof ScreenParseError
  ) {
    return { message: err.message, offset: err.offset };
  }
  return null;
}

/** Serialise an arbitrary parsed value to UTF-8 JSON bytes. */
function toJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(value, (_key, v) =>
      v instanceof Uint8Array || v instanceof Uint8ClampedArray ? Array.from(v) : v,
    ),
  );
}

/**
 * Map a lower-cased file extension (without the leading dot) to the parser that
 * handles it and the {@link AssetKind} its output is tagged with. Extensions
 * absent from this table are skipped by the walk.
 */
const DISPATCH: Record<string, { kind: AssetKind; parse: (buf: Buffer) => unknown } | undefined> = {
  trk: { kind: AssetKind.Track, parse: (buf) => parseTrack(buf) },
  map: { kind: AssetKind.Map, parse: (buf) => parseMap(buf) },
  blk: { kind: AssetKind.SpriteSheet, parse: (buf) => parseBlk(buf) },
  pals: { kind: AssetKind.Palette, parse: (buf) => parsePalette(buf) },
  pal: { kind: AssetKind.Palette, parse: (buf) => parsePalette(buf) },
  scr: { kind: AssetKind.Screen, parse: (buf) => parseScr(buf) },
  mus: { kind: AssetKind.Music, parse: (buf) => convertMusToOggStub(new Uint8Array(buf)) },
  // `.tbl` files carry either a weapon or chassis table; the parsers self-check
  // the table-kind discriminator in the header, so we try weapon first and fall
  // back to chassis on a kind mismatch.
  tbl: { kind: AssetKind.WeaponTable, parse: (buf) => parseTable(buf) },
};

/**
 * Parse a `.tbl` buffer as either a weapon or chassis table, returning a tagged
 * union so the caller can pick the correct {@link AssetKind}.
 */
function parseTable(buf: Buffer): { kind: AssetKind; table: unknown } {
  const bytes = new Uint8Array(buf);
  try {
    return { kind: AssetKind.WeaponTable, table: parseWeaponTable(bytes) };
  } catch (err) {
    if (err instanceof TblParseError && /expected weapon table/.test(err.message)) {
      return { kind: AssetKind.ChassisTable, table: parseChassisTable(bytes) };
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Directory walk + conversion
// ---------------------------------------------------------------------------

/** A single logged parse failure. */
export interface ConversionError {
  /** File name (track name) whose conversion failed. */
  file: string;
  /** Byte offset within the file at which parsing failed, when known. */
  offset: number | null;
  /** Human-readable failure description. */
  message: string;
}

/** Aggregate outcome of a {@link run}. */
export interface ConversionResult {
  /** Relative paths of the assets successfully written under `assets/`. */
  written: string[];
  /** Files that were skipped because their extension has no parser. */
  skipped: string[];
  /** Parse failures, each carrying the file name and byte offset. */
  errors: ConversionError[];
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

/** Options controlling {@link run}. */
export interface RunOptions {
  /** Log sink; defaults to `console`. */
  logger?: Logger;
  /**
   * When `true`, stop at the first parse failure and rethrow it instead of
   * collecting errors and continuing. Defaults to `false` (batch mode: log each
   * failure and press on, never emitting a partial asset for a failed file).
   */
  haltOnError?: boolean;
}

/** Recursively collect every file path under `dir`, in sorted order. */
async function walk(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(full)));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Convert every recognised file under `inputDir`, writing binary assets into
 * `outputDir/assets/`. Returns a summary of what was written, skipped, and what
 * failed.
 *
 * On a parse failure the file/track name and the parser's byte offset are
 * logged and no asset is written for that file. In the default batch mode the
 * walk continues so a single bad file does not abort the whole conversion; with
 * `haltOnError` set, the first failure is rethrown.
 *
 * @param inputDir Directory of original Deathtrack game files.
 * @param outputDir Output root; assets are written to `outputDir/assets/`.
 * @param options Logging and error-handling options.
 * @returns The {@link ConversionResult} summary.
 * Requirements: 9.5, 9.6
 */
export async function run(
  inputDir: string,
  outputDir: string,
  options: RunOptions = {},
): Promise<ConversionResult> {
  const logger = options.logger ?? defaultLogger;
  const assetsDir = path.join(outputDir, 'assets');
  await fs.mkdir(assetsDir, { recursive: true });

  const result: ConversionResult = { written: [], skipped: [], errors: [] };
  const files = await walk(inputDir);

  for (const file of files) {
    const ext = path.extname(file).slice(1).toLowerCase();
    const dispatch = DISPATCH[ext];
    const name = path.basename(file);

    if (dispatch === undefined) {
      result.skipped.push(name);
      continue;
    }

    let buffer: Buffer;
    try {
      buffer = await fs.readFile(file);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push({ file: name, offset: null, message });
      logger.error(`[assets] ${name}: failed to read file: ${message}`);
      if (options.haltOnError) throw err;
      continue;
    }

    try {
      const parsed = dispatch.parse(buffer);
      // `.tbl` returns a tagged union so we can pick the correct kind.
      const kind =
        parsed && typeof parsed === 'object' && 'kind' in parsed && 'table' in parsed
          ? (parsed as { kind: AssetKind }).kind
          : dispatch.kind;
      const payloadValue =
        parsed && typeof parsed === 'object' && 'kind' in parsed && 'table' in parsed
          ? (parsed as { table: unknown }).table
          : parsed;

      const container = encodeAsset(kind, toJsonBytes(payloadValue));
      const outName = `${path.parse(file).name}.${ext}.dtasset`;
      await fs.writeFile(path.join(assetsDir, outName), container);
      result.written.push(outName);
      logger.info(`[assets] ${name} -> assets/${outName} (${container.byteLength} bytes)`);
    } catch (err) {
      const offsetErr = asOffsetError(err);
      const message = offsetErr ? offsetErr.message : err instanceof Error ? err.message : String(err);
      const offset = offsetErr ? offsetErr.offset : null;
      result.errors.push({ file: name, offset, message });
      // Requirement 9.5: identify the track name and the point of parse failure;
      // do not write any partial asset for the failed file.
      logger.error(
        `[assets] ${name}: parse failed${offset !== null ? ` at byte offset ${offset}` : ''}: ${message}`,
      );
      if (options.haltOnError) throw err;
    }
  }

  logger.info(
    `[assets] done: ${result.written.length} written, ${result.skipped.length} skipped, ` +
      `${result.errors.length} error(s)`,
  );
  return result;
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/**
 * CLI wrapper: reads `<inputDir> <outputDir>` from `argv` and runs the
 * conversion, exiting non-zero if any file failed to parse.
 *
 * @param argv Argument list (defaults to `process.argv.slice(2)`).
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const useReal = argv.includes('--real');
  const useProbe = argv.includes('--probe');
  const positional = argv.filter((a) => !a.startsWith('--'));

  if (useProbe) {
    // Chunk-tree probe (section 25.3): walk <inputDir> and record every file's
    // Dynamix RES chunk structure. Optional second arg is an output report
    // file; otherwise the report is printed to stdout.
    const [inputDir, reportFile] = positional;
    if (!inputDir) {
      console.error('Usage: deathtrack-tools --probe <inputDir> [reportFile]');
      return 2;
    }
    const { probeChunkDir, formatChunkReport } = await import('./chunkProbe.js');
    const reports = await probeChunkDir(inputDir);
    const text = formatChunkReport(reports);
    if (reportFile) {
      const { promises: fsp } = await import('node:fs');
      await fsp.writeFile(reportFile, text, 'utf8');
      console.log(`[probe] wrote ${reports.length} file report(s) to ${reportFile}`);
    } else {
      console.log(text);
    }
    return 0;
  }

  const [inputDir, outputDir] = positional;
  if (!inputDir || !outputDir) {
    console.error('Usage: deathtrack-tools [--real|--probe] <inputDir> <outputDir>');
    return 2;
  }
  if (useReal) {
    // The real-asset pipeline (section 25). Imported lazily to avoid a circular
    // module dependency (realPipeline imports encodeAsset/AssetKind from here).
    const { convertReal } = await import('./realPipeline.js');
    const realResult = await convertReal(inputDir, outputDir);
    return realResult.errors.length > 0 ? 1 : 0;
  }
  const result = await run(inputDir, outputDir);
  return result.errors.length > 0 ? 1 : 0;
}

/**
 * Whether this module is being run directly as a script (rather than imported
 * by a test). Compares the resolved path of `import.meta.url` against
 * `process.argv[1]` in a Windows-safe way.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const modulePath = fileURLToPath(import.meta.url);
    return path.resolve(entry) === path.resolve(modulePath);
  } catch {
    return false;
  }
}

// Execute when invoked directly as a script (not when imported by tests).
if (isMainModule()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
