/**
 * Unit tests for the runtime {@link BinaryAssetLoader}.
 *
 * Verifies that the loader decodes containers produced in the tool's
 * `encodeAsset` framing (magic | version | kind | length | payload | crc32),
 * reconstructs shared domain types, and surfaces a typed {@link TrackLoadError}
 * on decode/CRC/kind/payload failures. A local `encodeContainer` helper
 * reproduces the tool's framing using only `@deathtrack/shared` primitives so
 * these tests do not depend on `@deathtrack/tools`.
 *
 * Requirements: 9.2, 9.5
 */

import { describe, it, expect } from 'vitest';

import { BinaryWriter } from '../../codec/BinaryWriter.js';
import { crc32 } from '../../codec/SaveFileCodec.js';
import {
  AssetKind,
  ASSET_MAGIC,
  ASSET_VERSION,
  BinaryAssetLoader,
  InMemoryAssetSource,
  TrackLoadError,
} from '../AssetLoader.js';
import type { TrackDef } from '../../types/track.js';
import type { WeaponDef } from '../../types/weapons.js';

// ---------------------------------------------------------------------------
// Helpers: reproduce the tool's container framing and JSON payload encoding.
// ---------------------------------------------------------------------------

/** JSON-encode a value, converting typed arrays to plain number arrays. */
function toJsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify(value, (_key, v) =>
      v instanceof Uint8Array || v instanceof Uint8ClampedArray ? Array.from(v as Uint8Array) : v,
    ),
  );
}

/** Frame a payload as `magic | version | kind | length | payload | crc32`. */
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

/** Encode a JS value as a full asset container of the given kind. */
function encodeAssetValue(kind: AssetKind, value: unknown): Uint8Array {
  return encodeContainer(kind, toJsonBytes(value));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function sampleTrack(): TrackDef {
  return {
    id: 'bay_area',
    name: 'Bay Area',
    city: 'San Francisco',
    lapCount: 3,
    roadSegments: [
      { index: 0, centre: { x: 0, y: 0 }, width: 20, normal: { x: 1, y: 0 }, surface: 'asphalt' },
      { index: 1, centre: { x: 0, y: 10 }, width: 20, normal: { x: 1, y: 0 }, surface: 'dirt' },
    ],
    jumpRamps: [{ position: { x: 5, y: 5 }, angle: 30, launchMultiplier: 1.5 }],
    waypointGraph: {
      nodes: [
        { id: 0, position: { x: 0, y: 0 }, width: 10 },
        { id: 1, position: { x: 0, y: 10 }, width: 10 },
      ],
      edges: [{ from: 0, to: 1, distance: 10 }],
    },
    pitLane: {
      entryPosition: { x: -5, y: 0 },
      exitPosition: { x: -5, y: 20 },
      path: [{ x: -5, y: 0 }, { x: -5, y: 20 }],
    },
    hazardZones: [{ id: 0, bounds: [{ x: 0, y: 0 }, { x: 1, y: 1 }], hazardType: 'oil_slick' }],
    scenery: [{ id: 0, position: { x: 3, y: 3 }, spriteId: 'tree', depth: 5 }],
    palette: Uint8Array.from({ length: 256 * 3 }, (_v, i) => i % 256),
  };
}

function sampleWeapons(): WeaponDef[] {
  return [
    {
      id: 'machine_gun',
      name: 'Machine Gun',
      category: 'forward',
      damage: 5,
      beamDPS: null,
      projectileSpeed: 400,
      ammoMax: 200,
      rangeUnits: 300,
      price: 500,
      slot: 'forward',
    } as WeaponDef,
  ];
}

// ---------------------------------------------------------------------------
// loadTrack
// ---------------------------------------------------------------------------

describe('BinaryAssetLoader.loadTrack', () => {
  it('decodes a valid track container into a TrackDef', async () => {
    const track = sampleTrack();
    const source = new InMemoryAssetSource([
      ['assets/tracks/bay_area.dtasset', encodeAssetValue(AssetKind.Track, track)],
    ]);
    const loader = new BinaryAssetLoader(source);

    const loaded = await loader.loadTrack('bay_area');

    expect(loaded.id).toBe('bay_area');
    expect(loaded.name).toBe('Bay Area');
    expect(loaded.lapCount).toBe(3);
    expect(loaded.roadSegments).toHaveLength(2);
    expect(loaded.waypointGraph.nodes).toHaveLength(2);
    expect(loaded.pitLane.entryPosition).toEqual({ x: -5, y: 0 });
    expect(loaded.jumpRamps[0]?.angle).toBe(30);
    // Palette is reconstructed as a Uint8Array, not a plain array.
    expect(loaded.palette).toBeInstanceOf(Uint8Array);
    expect(loaded.palette.length).toBe(256 * 3);
    expect(Array.from(loaded.palette.subarray(0, 4))).toEqual([0, 1, 2, 3]);
  });

  it('throws TrackLoadError on a CRC mismatch', async () => {
    const container = encodeAssetValue(AssetKind.Track, sampleTrack());
    // Corrupt a payload byte without touching the trailing CRC.
    container[12] = container[12]! ^ 0xff;
    const source = new InMemoryAssetSource([['assets/tracks/bay_area.dtasset', container]]);
    const loader = new BinaryAssetLoader(source);

    await expect(loader.loadTrack('bay_area')).rejects.toBeInstanceOf(TrackLoadError);
    await expect(loader.loadTrack('bay_area')).rejects.toMatchObject({
      trackId: 'bay_area',
    });
  });

  it('throws TrackLoadError with an offset on a bad magic', async () => {
    const container = encodeAssetValue(AssetKind.Track, sampleTrack());
    container[0] = 0x00; // clobber the magic
    const source = new InMemoryAssetSource([['assets/tracks/bay_area.dtasset', container]]);
    const loader = new BinaryAssetLoader(source);

    try {
      await loader.loadTrack('bay_area');
      throw new Error('expected loadTrack to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(TrackLoadError);
      expect((err as TrackLoadError).offset).toBe(0);
      expect((err as TrackLoadError).message).toMatch(/magic/i);
    }
  });

  it('throws TrackLoadError when the container is the wrong asset kind', async () => {
    const container = encodeAssetValue(AssetKind.WeaponTable, sampleWeapons());
    const source = new InMemoryAssetSource([['assets/tracks/bay_area.dtasset', container]]);
    const loader = new BinaryAssetLoader(source);

    await expect(loader.loadTrack('bay_area')).rejects.toBeInstanceOf(TrackLoadError);
  });

  it('throws TrackLoadError when the payload is missing required fields', async () => {
    const container = encodeAssetValue(AssetKind.Track, { id: 'bay_area', name: 'X' });
    const source = new InMemoryAssetSource([['assets/tracks/bay_area.dtasset', container]]);
    const loader = new BinaryAssetLoader(source);

    await expect(loader.loadTrack('bay_area')).rejects.toBeInstanceOf(TrackLoadError);
  });

  it('throws TrackLoadError when the asset source cannot supply bytes', async () => {
    const loader = new BinaryAssetLoader(new InMemoryAssetSource());
    await expect(loader.loadTrack('boston')).rejects.toBeInstanceOf(TrackLoadError);
  });
});

// ---------------------------------------------------------------------------
// loadWeaponTable / loadCarSprites / loadMusicTrack happy paths
// ---------------------------------------------------------------------------

describe('BinaryAssetLoader.loadWeaponTable', () => {
  it('decodes a weapon-table container into WeaponDef[]', async () => {
    const source = new InMemoryAssetSource([
      ['assets/tables/weapons.dtasset', encodeAssetValue(AssetKind.WeaponTable, sampleWeapons())],
    ]);
    const loader = new BinaryAssetLoader(source);

    const weapons = await loader.loadWeaponTable();

    expect(weapons).toHaveLength(1);
    expect(weapons[0]?.id).toBe('machine_gun');
    expect(weapons[0]?.ammoMax).toBe(200);
  });

  it('accepts a { weapons: [...] } wrapped payload', async () => {
    const source = new InMemoryAssetSource([
      [
        'assets/tables/weapons.dtasset',
        encodeAssetValue(AssetKind.WeaponTable, { weapons: sampleWeapons() }),
      ],
    ]);
    const loader = new BinaryAssetLoader(source);

    const weapons = await loader.loadWeaponTable();
    expect(weapons[0]?.id).toBe('machine_gun');
  });
});

describe('BinaryAssetLoader.loadCarSprites', () => {
  it('decodes a sprite-sheet container payload', async () => {
    const atlas = { frames: { car_0: { frame: { x: 0, y: 0, w: 32, h: 32 } } }, meta: { scale: '1' } };
    const source = new InMemoryAssetSource([
      ['assets/sprites/hellcat.dtasset', encodeAssetValue(AssetKind.SpriteSheet, atlas)],
    ]);
    const loader = new BinaryAssetLoader(source);

    const sheet = await loader.loadCarSprites('hellcat');
    expect(sheet).toMatchObject({ meta: { scale: '1' } });
  });

  it('rejects when the container is not a sprite sheet', async () => {
    const source = new InMemoryAssetSource([
      ['assets/sprites/hellcat.dtasset', encodeAssetValue(AssetKind.Track, sampleTrack())],
    ]);
    const loader = new BinaryAssetLoader(source);
    await expect(loader.loadCarSprites('hellcat')).rejects.toThrow(/unexpected asset kind/i);
  });
});

describe('BinaryAssetLoader.loadMusicTrack', () => {
  it('returns the decoded music bytes and screen context', async () => {
    const oggBytes = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]); // "OggS" + data
    const source = new InMemoryAssetSource([
      ['assets/music/race.dtasset', encodeAssetValue(AssetKind.Music, oggBytes)],
    ]);
    const loader = new BinaryAssetLoader(source);

    const track = await loader.loadMusicTrack('race');
    expect(track.screen).toBe('race');
    expect(track.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(track.data)).toEqual([0x4f, 0x67, 0x67, 0x53, 1, 2, 3, 4]);
  });
});

// ---------------------------------------------------------------------------
// basePath handling
// ---------------------------------------------------------------------------

describe('BinaryAssetLoader basePath', () => {
  it('honours a custom basePath when resolving container paths', async () => {
    const source = new InMemoryAssetSource([
      ['/cdn/tracks/boston.dtasset', encodeAssetValue(AssetKind.Track, { ...sampleTrack(), id: 'boston' })],
    ]);
    const loader = new BinaryAssetLoader(source, { basePath: '/cdn' });

    const loaded = await loader.loadTrack('boston');
    expect(loaded.id).toBe('boston');
  });
});
