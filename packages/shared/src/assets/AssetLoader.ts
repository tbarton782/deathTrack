/**
 * Runtime asset loader for the Deathtrack Multiplayer Recreation.
 *
 * At build time the `@deathtrack/tools` conversion CLI parses the original DOS
 * game files and writes each parsed asset as a compact binary *container* under
 * an `assets/` directory. This module reads those same containers back at
 * runtime and decodes them into the shared domain types (`TrackDef`,
 * `WeaponDef`, sprite-sheet references, music buffers).
 *
 * Container layout (produced by the tool's `encodeAsset`, mirroring the
 * `SaveFile` on-disk framing):
 *
 * ```
 * magic:u32 | version:u8 | kind:u8 | payloadLength:u32 | payload | crc32:u32
 * ```
 *
 * The trailing CRC32 is computed over every preceding byte (header + payload)
 * so the loader can detect corruption before trusting a payload. The payload
 * itself is UTF-8 JSON of the parser's output, with `Uint8Array`/
 * `Uint8ClampedArray` fields serialised as plain number arrays.
 *
 * `AssetLoader` does not touch the network or filesystem directly. Byte access
 * is abstracted behind {@link AssetSource} so a browser build can supply a
 * `fetch`-backed source, a Node build a filesystem source, and tests an
 * in-memory source. Track parsing (the decode below) is a bounded, allocation-
 * only operation and is expected to complete well within the 5 s budget of
 * Requirement 9.2; no real timers are used so behaviour stays deterministic.
 *
 * Requirements: 9.2, 9.5
 */

import { BinaryReader } from '../codec/BinaryReader.js';
import { crc32 } from '../codec/SaveFileCodec.js';
import type { ChassisId, MusicContext, TrackId } from '../types/primitives.js';
import type { TrackDef } from '../types/track.js';
import type { WeaponDef } from '../types/weapons.js';

// ---------------------------------------------------------------------------
// Container constants (must match `@deathtrack/tools` cli.ts)
// ---------------------------------------------------------------------------

/**
 * Magic marking a converted Deathtrack asset container: the ASCII bytes
 * `"DTRA"` as a little-endian `uint32`. Kept in sync with the conversion tool's
 * `ASSET_MAGIC`.
 */
export const ASSET_MAGIC = 0x44545241;

/** The one supported asset-container format version. */
export const ASSET_VERSION = 1;

/**
 * Discriminator identifying which parser produced an asset's payload. Mirrors
 * the tool's `AssetKind` enum so the loader can route decoding and reject a
 * container whose kind does not match the requested load.
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

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Typed error thrown when a track container fails to load: bad magic, wrong
 * version, truncation, CRC mismatch, wrong asset kind, or malformed JSON
 * payload. Carries the track name/id being loaded and, when known, the byte
 * offset at which decoding failed so the UI can surface a descriptive error
 * screen (Requirement 9.5) rather than starting a race with partial data.
 */
export class TrackLoadError extends Error {
  /** The track id/name that was being loaded when the failure occurred. */
  readonly trackId: string;
  /** Byte offset within the container at which decoding failed, when known. */
  readonly offset: number | null;

  constructor(trackId: string, message: string, offset: number | null = null) {
    super(`failed to load track "${trackId}": ${message}`);
    this.name = 'TrackLoadError';
    this.trackId = trackId;
    this.offset = offset;
    // Restore the prototype chain for `instanceof` under transpiled targets.
    Object.setPrototypeOf(this, TrackLoadError.prototype);
  }
}

// ---------------------------------------------------------------------------
// Byte source abstraction
// ---------------------------------------------------------------------------

/**
 * Supplies the raw bytes of a pre-converted asset container given its path
 * (relative to the `assets/` root). Implementations decide the transport: a
 * browser source fetches over HTTP, a Node source reads from disk, and tests
 * provide an in-memory map. Rejections/throws are surfaced by the loader as the
 * appropriate typed error for the asset being loaded.
 */
export interface AssetSource {
  /** Resolve the bytes of the container stored at `path`. */
  readAsset(path: string): Promise<Uint8Array>;
}

// ---------------------------------------------------------------------------
// Loader interface
// ---------------------------------------------------------------------------

/**
 * Loads pre-converted game assets and decodes them into shared domain types.
 * Requirements: 9.2, 9.5
 */
export interface AssetLoader {
  /** Load and decode a track container into a {@link TrackDef}. */
  loadTrack(id: TrackId): Promise<TrackDef>;
  /** Load the sprite-sheet container for a chassis, returning its decoded payload. */
  loadCarSprites(chassis: ChassisId): Promise<SpriteSheetData>;
  /** Load and decode the weapon table into an array of {@link WeaponDef}. */
  loadWeaponTable(): Promise<WeaponDef[]>;
  /** Load the encoded music buffer for a screen context. */
  loadMusicTrack(screen: MusicContext): Promise<MusicTrackData>;
}

/**
 * Decoded sprite-sheet payload. The conversion tool emits a `.BLK`-derived
 * atlas whose exact JSON shape is defined by the tool's `BlkParser`; the loader
 * returns it structurally so the client's sprite-sheet loader can consume it
 * without `shared` depending on `tools`.
 */
export interface SpriteSheetData {
  [key: string]: unknown;
}

/**
 * Decoded music payload: the raw (already OGG-converted at build time) audio
 * bytes plus the screen context they belong to. Decoding into a Web Audio
 * `AudioBuffer` happens in the client audio system, which owns an
 * `AudioContext`; `shared` stays platform-neutral and hands back the bytes.
 */
export interface MusicTrackData {
  screen: MusicContext;
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// Container decoding
// ---------------------------------------------------------------------------

/** A decoded container: its kind discriminator and verified payload bytes. */
interface DecodedContainer {
  kind: AssetKind;
  payload: Uint8Array;
}

/**
 * Decode and integrity-check a container produced by the conversion tool's
 * `encodeAsset`. Verifies magic, version, declared payload length, and the
 * trailing CRC32 before returning the payload.
 *
 * @param bytes The full container bytes.
 * @returns The container kind and payload.
 * @throws {ContainerDecodeError} If any framing or integrity check fails.
 */
function decodeContainer(bytes: Uint8Array): DecodedContainer {
  // Minimum size: magic(4) + version(1) + kind(1) + length(4) + crc(4) = 14.
  if (bytes.byteLength < 14) {
    throw new ContainerDecodeError(
      `container too small: ${bytes.byteLength} byte(s), need at least 14`,
      0,
    );
  }

  const reader = new BinaryReader(bytes);

  const magic = reader.uint32();
  if (magic !== ASSET_MAGIC) {
    throw new ContainerDecodeError(
      `bad magic 0x${magic.toString(16).padStart(8, '0')} (expected 0x${ASSET_MAGIC.toString(16)})`,
      0,
    );
  }

  const version = reader.uint8();
  if (version !== ASSET_VERSION) {
    throw new ContainerDecodeError(
      `unsupported version ${version} (expected ${ASSET_VERSION})`,
      4,
    );
  }

  const kind = reader.uint8() as AssetKind;
  const payloadLength = reader.uint32();

  // payload + trailing 4-byte CRC must fit exactly in what remains.
  if (payloadLength + 4 > reader.remaining) {
    throw new ContainerDecodeError(
      `declared payload length ${payloadLength} exceeds available ${reader.remaining - 4} byte(s)`,
      reader.position,
    );
  }

  let payload: Uint8Array;
  try {
    payload = reader.bytes(payloadLength);
  } catch (err) {
    throw new ContainerDecodeError(
      `truncated payload: ${err instanceof Error ? err.message : String(err)}`,
      reader.position,
    );
  }

  const storedCrc = reader.uint32();
  const expectedCrc = crc32(bytes.subarray(0, bytes.byteLength - 4));
  if (storedCrc !== expectedCrc) {
    throw new ContainerDecodeError(
      `CRC mismatch: stored 0x${storedCrc.toString(16)} but computed 0x${expectedCrc.toString(16)}`,
      bytes.byteLength - 4,
    );
  }

  return { kind, payload };
}

/**
 * Internal error carrying a byte offset, thrown by {@link decodeContainer} and
 * translated by each `load*` method into the caller-facing typed error (e.g.
 * {@link TrackLoadError}).
 */
class ContainerDecodeError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.name = 'ContainerDecodeError';
    this.offset = offset;
    Object.setPrototypeOf(this, ContainerDecodeError.prototype);
  }
}

/** Parse a container payload as UTF-8 JSON. */
function decodeJsonPayload(payload: Uint8Array): unknown {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  return JSON.parse(text) as unknown;
}

/**
 * Reconstruct a `Uint8Array` from a value the tool serialised as a plain number
 * array (its JSON replacer converts typed arrays to `Array.from(...)`). Accepts
 * an already-`Uint8Array` value defensively.
 */
function toUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (Array.isArray(value)) return Uint8Array.from(value as number[]);
  return new Uint8Array(0);
}

// ---------------------------------------------------------------------------
// Loader implementation
// ---------------------------------------------------------------------------

/**
 * Options controlling how {@link BinaryAssetLoader} maps logical asset ids to
 * container paths under the `assets/` root.
 */
export interface AssetLoaderOptions {
  /**
   * Path prefix prepended to every generated container path. Defaults to
   * `'assets/'`. A browser source typically points this at the deployed asset
   * directory; a test source can leave it as-is and key its in-memory map on
   * the resulting paths.
   */
  basePath?: string;
}

/**
 * Default {@link AssetLoader} backed by an injected {@link AssetSource}. All
 * transport concerns live in the source; this class only maps ids to paths,
 * decodes containers, and reconstructs typed values.
 *
 * Requirements: 9.2, 9.5
 */
export class BinaryAssetLoader implements AssetLoader {
  private readonly source: AssetSource;
  private readonly basePath: string;

  constructor(source: AssetSource, options: AssetLoaderOptions = {}) {
    this.source = source;
    const prefix = options.basePath ?? 'assets/';
    // Normalise to a single trailing slash so path joins stay predictable.
    this.basePath = prefix.endsWith('/') || prefix === '' ? prefix : `${prefix}/`;
  }

  /** Build the container path for a logical asset name. */
  private path(name: string): string {
    return `${this.basePath}${name}`;
  }

  /**
   * Load and decode a track container into a {@link TrackDef}. Any failure to
   * read, frame-decode, integrity-check, or JSON-parse the container is
   * surfaced as a {@link TrackLoadError} carrying the track id and (when known)
   * the byte offset of failure. No partial track is ever returned.
   */
  async loadTrack(id: TrackId): Promise<TrackDef> {
    let bytes: Uint8Array;
    try {
      bytes = await this.source.readAsset(this.path(`tracks/${id}.dtasset`));
    } catch (err) {
      throw new TrackLoadError(id, `could not read asset: ${errMessage(err)}`);
    }

    let container: DecodedContainer;
    try {
      container = decodeContainer(bytes);
    } catch (err) {
      if (err instanceof ContainerDecodeError) {
        throw new TrackLoadError(id, err.message, err.offset);
      }
      throw new TrackLoadError(id, errMessage(err));
    }

    if (container.kind !== AssetKind.Track) {
      throw new TrackLoadError(
        id,
        `unexpected asset kind ${container.kind} (expected Track=${AssetKind.Track})`,
        5,
      );
    }

    let raw: unknown;
    try {
      raw = decodeJsonPayload(container.payload);
    } catch (err) {
      throw new TrackLoadError(id, `malformed track payload: ${errMessage(err)}`);
    }

    return reconstructTrack(id, raw);
  }

  /**
   * Load a chassis sprite-sheet container, returning its decoded JSON payload.
   */
  async loadCarSprites(chassis: ChassisId): Promise<SpriteSheetData> {
    const bytes = await this.source.readAsset(this.path(`sprites/${chassis}.dtasset`));
    const container = decodeContainer(bytes);
    if (container.kind !== AssetKind.SpriteSheet) {
      throw new Error(
        `loadCarSprites("${chassis}"): unexpected asset kind ${container.kind} (expected SpriteSheet=${AssetKind.SpriteSheet})`,
      );
    }
    return decodeJsonPayload(container.payload) as SpriteSheetData;
  }

  /**
   * Load and decode the weapon table into an array of {@link WeaponDef}. A
   * parse failure here is fatal (see design "Asset Loading Errors"): the error
   * propagates so startup halts rather than running with a partial table.
   */
  async loadWeaponTable(): Promise<WeaponDef[]> {
    const bytes = await this.source.readAsset(this.path('tables/weapons.dtasset'));
    const container = decodeContainer(bytes);
    if (container.kind !== AssetKind.WeaponTable) {
      throw new Error(
        `loadWeaponTable(): unexpected asset kind ${container.kind} (expected WeaponTable=${AssetKind.WeaponTable})`,
      );
    }
    const raw = decodeJsonPayload(container.payload);
    if (Array.isArray(raw)) return raw as WeaponDef[];
    // The tool may wrap the array as `{ weapons: [...] }`; accept either.
    if (raw && typeof raw === 'object' && Array.isArray((raw as { weapons?: unknown }).weapons)) {
      return (raw as { weapons: WeaponDef[] }).weapons;
    }
    throw new Error('loadWeaponTable(): payload is not a weapon table');
  }

  /** Load the encoded music buffer for a screen context. */
  async loadMusicTrack(screen: MusicContext): Promise<MusicTrackData> {
    const bytes = await this.source.readAsset(this.path(`music/${screen}.dtasset`));
    const container = decodeContainer(bytes);
    if (container.kind !== AssetKind.Music) {
      throw new Error(
        `loadMusicTrack("${screen}"): unexpected asset kind ${container.kind} (expected Music=${AssetKind.Music})`,
      );
    }
    // The music payload is the OGG bytes; the tool wraps raw bytes as a JSON
    // number array, so reconstruct the typed array.
    const raw = decodeJsonPayload(container.payload);
    return { screen, data: toUint8Array(raw) };
  }
}

/**
 * Reconstruct a {@link TrackDef} from the decoded JSON payload, restoring typed
 * fields (the palette) that the tool serialised as number arrays. Validates the
 * minimal shape needed to avoid handing back a partial track.
 */
function reconstructTrack(id: TrackId, raw: unknown): TrackDef {
  if (raw === null || typeof raw !== 'object') {
    throw new TrackLoadError(id, 'track payload is not an object');
  }
  const obj = raw as Record<string, unknown>;

  // Required structural fields; a missing one means the container is not a
  // usable track and we must not proceed with partial data.
  const required = ['roadSegments', 'waypointGraph', 'pitLane', 'jumpRamps', 'hazardZones'];
  for (const key of required) {
    if (!(key in obj)) {
      throw new TrackLoadError(id, `track payload missing required field "${key}"`);
    }
  }

  return {
    ...(obj as unknown as TrackDef),
    // Prefer the id the caller requested so the returned def is self-consistent.
    id,
    palette: toUint8Array(obj.palette),
  };
}

/** Extract a human-readable message from an unknown thrown value. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// In-memory source (primarily for tests and Node-side prototyping)
// ---------------------------------------------------------------------------

/**
 * An {@link AssetSource} backed by an in-memory map of path -> bytes. Useful in
 * tests and for supplying already-loaded buffers. Reading an unknown path
 * rejects, mirroring a 404/ENOENT from a real transport.
 */
export class InMemoryAssetSource implements AssetSource {
  private readonly assets: Map<string, Uint8Array>;

  constructor(initial?: Iterable<readonly [string, Uint8Array]>) {
    this.assets = new Map(initial ?? []);
  }

  /** Register or overwrite the bytes for a path. */
  set(path: string, bytes: Uint8Array): void {
    this.assets.set(path, bytes);
  }

  async readAsset(path: string): Promise<Uint8Array> {
    const bytes = this.assets.get(path);
    if (bytes === undefined) {
      throw new Error(`InMemoryAssetSource: no asset registered at "${path}"`);
    }
    return bytes;
  }
}
