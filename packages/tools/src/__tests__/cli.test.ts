/**
 * Tests for the asset-conversion CLI pipeline in {@link ../cli.ts}.
 *
 * Exercises the directory walk, per-extension parser dispatch, `SaveFile`-style
 * container encoding, the encode -> decode round-trip, and the parse-error
 * logging that reports the offending file name together with the byte offset of
 * failure.
 *
 * Requirements: 9.5, 9.6
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  run,
  encodeAsset,
  decodeAsset,
  crc32,
  AssetKind,
  ASSET_MAGIC,
  type ConversionError,
  type Logger,
} from '../cli.js';

// ---------------------------------------------------------------------------
// Fixture builders — minimal valid files for each parser.
// ---------------------------------------------------------------------------

/** Build a valid `.MAP` buffer. */
function buildMap(width: number, height: number): Buffer {
  const header = Buffer.alloc(8);
  header.write('DMAP', 0, 'ascii');
  header.writeUInt16LE(width, 4);
  header.writeUInt16LE(height, 6);
  const pixels = Buffer.alloc(width * height);
  for (let i = 0; i < pixels.length; i += 1) pixels[i] = i & 0xff;
  return Buffer.concat([header, pixels]);
}

/** Build a valid `.SCR` buffer. */
function buildScr(width: number, height: number): Buffer {
  const header = Buffer.alloc(8);
  header.write('DSCR', 0, 'ascii');
  header.writeUInt16LE(width, 4);
  header.writeUInt16LE(height, 6);
  const pixels = Buffer.alloc(width * height);
  return Buffer.concat([header, pixels]);
}

/** Build a valid raw (headerless) `.PALS` buffer of 256 RGB triples. */
function buildPalette(): Buffer {
  const buf = Buffer.alloc(256 * 3);
  for (let i = 0; i < buf.length; i += 1) buf[i] = 200; // > 63 => treated as 8-bit
  return buf;
}

// ---------------------------------------------------------------------------
// Test harness helpers
// ---------------------------------------------------------------------------

/** A logger that records everything for later assertions. */
function makeRecordingLogger(): Logger & { infos: string[]; errors: string[] } {
  const infos: string[] = [];
  const errors: string[] = [];
  return {
    infos,
    errors,
    info: (m) => infos.push(m),
    error: (m) => errors.push(m),
  };
}

let inputDir: string;
let outputDir: string;

beforeEach(async () => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'dt-cli-'));
  inputDir = path.join(base, 'in');
  outputDir = path.join(base, 'out');
  await fs.mkdir(inputDir, { recursive: true });
});

afterEach(async () => {
  // Clean up both temp trees; the common parent is one level above inputDir.
  const parent = path.dirname(inputDir);
  await fs.rm(parent, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Container encode / decode
// ---------------------------------------------------------------------------

describe('encodeAsset / decodeAsset', () => {
  it('round-trips a payload through the container (magic + kind + CRC)', () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const container = encodeAsset(AssetKind.Map, payload);

    // Magic sits at the front, little-endian.
    const magic = new DataView(container.buffer, container.byteOffset).getUint32(0, true);
    expect(magic).toBe(ASSET_MAGIC);

    const decoded = decodeAsset(container);
    expect(decoded.kind).toBe(AssetKind.Map);
    expect(Array.from(decoded.payload)).toEqual([1, 2, 3, 4, 5]);
  });

  it('detects corruption via the trailing CRC32', () => {
    const container = encodeAsset(AssetKind.Palette, new Uint8Array([9, 9, 9]));
    // Flip a payload byte after framing; the stored CRC no longer matches.
    const tampered = Uint8Array.from(container);
    tampered[10] = (tampered[10] as number) ^ 0xff;
    expect(() => decodeAsset(tampered)).toThrow(/CRC mismatch/);
  });

  it('crc32 matches a known IEEE reference value', () => {
    // CRC-32 of ASCII "123456789" is 0xCBF43926.
    const bytes = new TextEncoder().encode('123456789');
    expect(crc32(bytes) >>> 0).toBe(0xcbf43926);
  });
});

// ---------------------------------------------------------------------------
// Directory walk + dispatch
// ---------------------------------------------------------------------------

describe('run: walk + dispatch', () => {
  it('converts recognised files, skips unknown ones, and writes to assets/', async () => {
    await fs.writeFile(path.join(inputDir, 'city.map'), buildMap(4, 3));
    await fs.writeFile(path.join(inputDir, 'title.scr'), buildScr(2, 2));
    await fs.writeFile(path.join(inputDir, 'colors.pals'), buildPalette());
    await fs.writeFile(path.join(inputDir, 'readme.txt'), 'ignore me');

    const logger = makeRecordingLogger();
    const result = await run(inputDir, outputDir, { logger });

    expect(result.errors).toEqual([]);
    expect(result.skipped).toContain('readme.txt');
    expect(result.written).toEqual(
      expect.arrayContaining(['city.map.dtasset', 'title.scr.dtasset', 'colors.pals.dtasset']),
    );

    // The assets directory holds exactly the written containers.
    const assetsDir = path.join(outputDir, 'assets');
    const onDisk = (await fs.readdir(assetsDir)).sort();
    expect(onDisk).toEqual(['city.map.dtasset', 'colors.pals.dtasset', 'title.scr.dtasset']);

    // Each written asset decodes back with the correct kind.
    const mapBytes = await fs.readFile(path.join(assetsDir, 'city.map.dtasset'));
    const decoded = decodeAsset(new Uint8Array(mapBytes));
    expect(decoded.kind).toBe(AssetKind.Map);
  });

  it('recurses into subdirectories', async () => {
    const sub = path.join(inputDir, 'tracks');
    await fs.mkdir(sub, { recursive: true });
    await fs.writeFile(path.join(sub, 'nested.map'), buildMap(2, 2));

    const result = await run(inputDir, outputDir, { logger: makeRecordingLogger() });
    expect(result.written).toContain('nested.map.dtasset');
  });
});

// ---------------------------------------------------------------------------
// Error logging with byte offset (Requirement 9.5)
// ---------------------------------------------------------------------------

describe('run: parse-error logging', () => {
  it('logs the file name and byte offset and writes no asset for a bad file', async () => {
    // Valid file alongside a corrupt one to confirm the walk continues.
    await fs.writeFile(path.join(inputDir, 'good.map'), buildMap(2, 2));

    // A `.map` whose magic is wrong: the parser throws at byte offset 0.
    const bad = buildMap(2, 2);
    bad.write('XXXX', 0, 'ascii');
    await fs.writeFile(path.join(inputDir, 'bad.map'), bad);

    const logger = makeRecordingLogger();
    const result = await run(inputDir, outputDir, { logger });

    // Batch mode: the good file still converts.
    expect(result.written).toContain('good.map.dtasset');

    // The failure is recorded with the file name and byte offset.
    expect(result.errors).toHaveLength(1);
    const err = result.errors[0] as ConversionError;
    expect(err.file).toBe('bad.map');
    expect(err.offset).toBe(0);

    // The error log line mentions the file name and the byte offset.
    const logged = logger.errors.join('\n');
    expect(logged).toContain('bad.map');
    expect(logged).toMatch(/byte offset 0/);

    // No partial asset was written for the bad file.
    const assetsDir = path.join(outputDir, 'assets');
    const onDisk = await fs.readdir(assetsDir);
    expect(onDisk).not.toContain('bad.map.dtasset');
  });

  it('reports a non-zero byte offset for truncated pixel data', async () => {
    // Header claims 4x4 (16 pixels) but only a few bytes follow.
    const header = Buffer.alloc(8);
    header.write('DMAP', 0, 'ascii');
    header.writeUInt16LE(4, 4);
    header.writeUInt16LE(4, 6);
    await fs.writeFile(path.join(inputDir, 'trunc.map'), Buffer.concat([header, Buffer.alloc(3)]));

    const result = await run(inputDir, outputDir, { logger: makeRecordingLogger() });
    expect(result.errors).toHaveLength(1);
    const err = result.errors[0] as ConversionError;
    expect(err.offset).toBe(8); // failure detected at the pixel-data offset
  });

  it('halts on the first error when haltOnError is set', async () => {
    const bad = buildMap(2, 2);
    bad.write('XXXX', 0, 'ascii');
    await fs.writeFile(path.join(inputDir, 'bad.map'), bad);

    await expect(
      run(inputDir, outputDir, { logger: makeRecordingLogger(), haltOnError: true }),
    ).rejects.toThrow();
  });
});
