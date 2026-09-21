/**
 * Binary codec for the on-disk career {@link SaveFile}.
 *
 * A save file persists a single career slot to disk. Its layout is, in strict
 * order:
 *
 * | Field     | Wire type                | Notes                                        |
 * | --------- | ------------------------ | -------------------------------------------- |
 * | `magic`   | uint32                   | constant {@link SAVE_FILE_MAGIC} `0x44545241` ("DTRA") |
 * | `version` | uint32                   | codec schema version ({@link SAVE_FILE_VERSION}) |
 * | `slot`    | uint8                    | save slot index (1–3)                        |
 * | `career`  | {@link CareerState}      | all persisted career fields (see below)      |
 * | `crc32`   | uint32                   | IEEE CRC-32 over every preceding byte        |
 *
 * The `crc32` trailer is computed over the fully-encoded prefix
 * (`magic` + `version` + `slot` + `career`). On decode the trailer is
 * recomputed over the same prefix bytes and compared; a mismatch throws a
 * {@link CorruptSaveError} before any career field is trusted. A wrong `magic`
 * or an unsupported `version` likewise throws {@link CorruptSaveError}, so a
 * truncated, tampered, or foreign file is rejected rather than silently
 * misparsed.
 *
 * ## CareerState field order
 *
 * The nested {@link CareerState} is encoded in this immutable order:
 * `saveSlot`, `playerName`, `money`, `ownedComponents`, `ownedWeapons`,
 * `currentCircuitIndex`, `circuitNumber`, `currentLoadout`, `totalEarnings`,
 * `eliminationCount`. The `currentLoadout` nests its `chassisId`, the six
 * component slots, and the four weapon slots (each nullable). Because encode
 * and decode both walk this one order, `decode(encode(v))` reproduces a
 * structurally identical value.
 *
 * Requirements: 12.4, 5.5
 */

import { BinaryWriter } from './BinaryWriter.js';
import { BinaryReader } from './BinaryReader.js';
import {
  uint8,
  uint32,
  type FieldType,
} from './schema.js';
import type { CareerState, SaveFile } from '../types/career.js';
import type { Loadout } from '../types/car.js';
import type { ChassisId, ComponentId, WeaponId } from '../types/primitives.js';

/** Four-byte file magic: `0x44545241` ("DTRA"). */
export const SAVE_FILE_MAGIC = 0x44545241;

/** Current save-file codec schema version. Increment on any breaking change. */
export const SAVE_FILE_VERSION = 1;

/**
 * Error thrown when a save file fails integrity validation: a bad magic number,
 * an unsupported version, or a CRC-32 checksum mismatch (indicating a corrupt or
 * truncated file). Carries a machine-readable {@link CorruptSaveError.reason}.
 *
 * Requirements: 12.4
 */
export class CorruptSaveError extends Error {
  /** Why the save was rejected. */
  readonly reason: 'bad-magic' | 'bad-version' | 'crc-mismatch' | 'truncated';

  constructor(reason: CorruptSaveError['reason'], message: string) {
    super(message);
    this.name = 'CorruptSaveError';
    this.reason = reason;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, CorruptSaveError.prototype);
  }
}

// ---------------------------------------------------------------------------
// CRC-32 (IEEE 802.3 polynomial, reflected)
// ---------------------------------------------------------------------------

/** Precomputed CRC-32 lookup table for the reflected IEEE polynomial 0xEDB88320. */
const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

/**
 * Compute the standard IEEE CRC-32 checksum of `bytes`.
 *
 * Uses the reflected polynomial `0xEDB88320` with the conventional `0xFFFFFFFF`
 * initial value and final XOR, matching zlib/PNG/Ethernet CRC-32. The result is
 * an unsigned 32-bit integer.
 *
 * @param bytes The input bytes to checksum.
 * @returns The CRC-32 as an unsigned 32-bit integer.
 */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// Composable field types for variable-length and nullable strings
// ---------------------------------------------------------------------------

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder('utf-8', { fatal: false });

/**
 * A variable-length UTF-8 string field: a `uint16` byte-length prefix followed
 * by that many UTF-8 bytes. Supports strings whose encoding is up to 65535
 * bytes, comfortably covering player names and item identifiers.
 */
const varString: FieldType<string> = {
  write: (w: BinaryWriter, value: string) => {
    const encoded = utf8Encoder.encode(value);
    if (encoded.byteLength > 0xffff) {
      throw new RangeError(
        `varString value encodes to ${encoded.byteLength} bytes, exceeding the 65535-byte limit`,
      );
    }
    w.uint16(encoded.byteLength);
    w.bytes(encoded);
  },
  read: (r: BinaryReader): string => {
    const len = r.uint16();
    return utf8Decoder.decode(r.bytes(len));
  },
};

/**
 * A nullable variable-length string field: a single presence byte (0 = null,
 * 1 = present) optionally followed by a {@link varString}. Used for the loadout
 * slots, which are `null` when nothing is equipped.
 */
function nullableVarString<T extends string>(): FieldType<T | null> {
  return {
    write: (w: BinaryWriter, value: T | null) => {
      if (value === null) {
        w.uint8(0);
        return;
      }
      w.uint8(1);
      varString.write(w, value);
    },
    read: (r: BinaryReader): T | null => {
      const present = r.uint8();
      return present === 0 ? null : (varString.read(r) as T);
    },
  };
}

/**
 * A variable-length array of {@link varString} elements: a `uint16` count prefix
 * followed by that many strings. Used for `ownedComponents` / `ownedWeapons`.
 */
const stringArray: FieldType<string[]> = {
  write: (w: BinaryWriter, values: string[]) => {
    if (values.length > 0xffff) {
      throw new RangeError(
        `stringArray length ${values.length} exceeds the 65535-element limit`,
      );
    }
    w.uint16(values.length);
    for (const v of values) {
      varString.write(w, v);
    }
  },
  read: (r: BinaryReader): string[] => {
    const count = r.uint16();
    const out: string[] = [];
    for (let i = 0; i < count; i += 1) {
      out.push(varString.read(r));
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// Loadout and CareerState field writers
//
// The loadout and career-state payloads are written inline (no length prefix)
// as a fixed, ordered sequence of fields. Both directions walk the identical
// order, guaranteeing a structure-preserving round-trip.
// ---------------------------------------------------------------------------

const componentSlot = nullableVarString<ComponentId>();
const weaponSlot = nullableVarString<WeaponId>();

/** Write a {@link Loadout} inline in its fixed field order. */
function writeLoadout(w: BinaryWriter, loadout: Loadout): void {
  varString.write(w, loadout.chassisId);
  componentSlot.write(w, loadout.components.engine);
  componentSlot.write(w, loadout.components.brakes);
  componentSlot.write(w, loadout.components.transmission);
  componentSlot.write(w, loadout.components.tires);
  componentSlot.write(w, loadout.components.airfoil);
  componentSlot.write(w, loadout.components.armor);
  weaponSlot.write(w, loadout.weapons.forward);
  weaponSlot.write(w, loadout.weapons.rear);
  weaponSlot.write(w, loadout.weapons.side_spike);
  weaponSlot.write(w, loadout.weapons.ram);
}

/** Read a {@link Loadout} inline in the identical field order it was written. */
function readLoadout(r: BinaryReader): Loadout {
  const chassisId = varString.read(r) as ChassisId;
  const components: Loadout['components'] = {
    engine: componentSlot.read(r),
    brakes: componentSlot.read(r),
    transmission: componentSlot.read(r),
    tires: componentSlot.read(r),
    airfoil: componentSlot.read(r),
    armor: componentSlot.read(r),
  };
  const weapons: Loadout['weapons'] = {
    forward: weaponSlot.read(r),
    rear: weaponSlot.read(r),
    side_spike: weaponSlot.read(r),
    ram: weaponSlot.read(r),
  };
  return { chassisId, components, weapons };
}

/** Write a {@link CareerState} inline in its fixed field order. */
function writeCareer(w: BinaryWriter, career: CareerState): void {
  uint8.write(w, career.saveSlot);
  varString.write(w, career.playerName);
  uint32.write(w, career.money);
  stringArray.write(w, career.ownedComponents);
  stringArray.write(w, career.ownedWeapons);
  uint32.write(w, career.currentCircuitIndex);
  uint32.write(w, career.circuitNumber);
  writeLoadout(w, career.currentLoadout);
  uint32.write(w, career.totalEarnings);
  uint32.write(w, career.eliminationCount);
}

/** Read a {@link CareerState} inline in the identical field order it was written. */
function readCareer(r: BinaryReader): CareerState {
  const saveSlot = uint8.read(r) as CareerState['saveSlot'];
  const playerName = varString.read(r);
  const money = uint32.read(r);
  const ownedComponents = stringArray.read(r) as ComponentId[];
  const ownedWeapons = stringArray.read(r) as WeaponId[];
  const currentCircuitIndex = uint32.read(r);
  const circuitNumber = uint32.read(r);
  const currentLoadout = readLoadout(r);
  const totalEarnings = uint32.read(r);
  const eliminationCount = uint32.read(r);
  return {
    saveSlot,
    playerName,
    money,
    ownedComponents,
    ownedWeapons,
    currentCircuitIndex,
    circuitNumber,
    currentLoadout,
    totalEarnings,
    eliminationCount,
  };
}

// ---------------------------------------------------------------------------
// SaveFileCodec
// ---------------------------------------------------------------------------

/**
 * Codec that encodes/decodes a {@link SaveFile} to/from a little-endian byte
 * buffer with a trailing CRC-32 integrity checksum.
 *
 * - `encode` writes `magic`, `version`, `slot`, the nested `career`, then
 *   appends {@link crc32} of all preceding bytes. The `magic` and `crc32` values
 *   on the input object are ignored: the codec always emits
 *   {@link SAVE_FILE_MAGIC} and the freshly-computed checksum, so a caller cannot
 *   accidentally persist a stale or inconsistent trailer.
 * - `decode` validates the magic and version, recomputes the CRC-32 over the
 *   prefix, and throws {@link CorruptSaveError} on any mismatch before returning
 *   the parsed value.
 *
 * Requirements: 12.4, 5.5
 */
export const SaveFileCodec = {
  encode(value: SaveFile): Uint8Array {
    const w = new BinaryWriter();
    w.uint32(SAVE_FILE_MAGIC);
    w.uint32(value.version);
    w.uint8(value.slot);
    writeCareer(w, value.career);
    const prefix = w.toUint8Array();
    const checksum = crc32(prefix);
    w.uint32(checksum);
    return w.toUint8Array();
  },

  decode(buf: Uint8Array): SaveFile {
    // Minimum size: magic(4) + version(4) + slot(1) + crc32(4) = 13 bytes,
    // with an empty career payload being larger still; guard the trailer read.
    if (buf.byteLength < 13) {
      throw new CorruptSaveError(
        'truncated',
        `save file is ${buf.byteLength} bytes, too short to contain a header and CRC-32 trailer`,
      );
    }

    const r = new BinaryReader(buf);
    const magic = r.uint32();
    if (magic !== SAVE_FILE_MAGIC) {
      throw new CorruptSaveError(
        'bad-magic',
        `save file magic 0x${magic.toString(16).padStart(8, '0')} does not match expected ` +
          `0x${SAVE_FILE_MAGIC.toString(16).padStart(8, '0')}`,
      );
    }

    const version = r.uint32();
    if (version !== SAVE_FILE_VERSION) {
      throw new CorruptSaveError(
        'bad-version',
        `save file version ${version} is not supported (expected ${SAVE_FILE_VERSION})`,
      );
    }

    const slot = r.uint8() as SaveFile['slot'];
    let career: CareerState;
    try {
      career = readCareer(r);
    } catch (err) {
      // A read past the end of the buffer means the payload is truncated.
      if (err instanceof RangeError) {
        throw new CorruptSaveError('truncated', `save file payload is truncated: ${err.message}`);
      }
      throw err;
    }

    // The next 4 bytes are the stored CRC-32; everything before them is covered.
    if (r.remaining < 4) {
      throw new CorruptSaveError(
        'truncated',
        'save file is missing its 4-byte CRC-32 trailer',
      );
    }
    const crcOffset = r.position;
    const storedCrc = r.uint32();
    const computedCrc = crc32(buf.subarray(0, crcOffset));
    if (storedCrc !== computedCrc) {
      throw new CorruptSaveError(
        'crc-mismatch',
        `save file CRC-32 mismatch: stored 0x${storedCrc.toString(16)} ` +
          `!= computed 0x${computedCrc.toString(16)} (corrupt save)`,
      );
    }

    return {
      magic: SAVE_FILE_MAGIC,
      version,
      slot,
      career,
      crc32: storedCrc,
    };
  },
};
