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

    // Tracks/tables/maps/music are deliberately not emitted (deferred/blocked).
    expect(result.written.some((p) => p.includes(`${path.sep}tracks${path.sep}`))).toBe(false);

    // Every emitted container round-trips through the shared decoder.
    for (const rel of result.written) {
      const bytes = new Uint8Array(await fs.readFile(path.join(outDir, rel)));
      expect(() => decodeAsset(bytes)).not.toThrow();
    }
  });
});
