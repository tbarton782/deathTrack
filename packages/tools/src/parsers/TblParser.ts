/**
 * `.TBL` weapon and car stat-table parser for the Deathtrack asset pipeline.
 *
 * The original Deathtrack `.TBL` files hold the numeric stat tables that drive
 * the Weapon System and the Car/Loadout subsystem. This parser reads those
 * tables into typed {@link WeaponTable} and {@link ChassisTable} structures
 * whose fields align with the shared domain definitions ({@link WeaponDef},
 * {@link ChassisDef}, {@link CarBaseStats}, {@link ComponentDef}).
 *
 * The exact original on-disk layout is undocumented in the design, so this
 * module defines a stable, self-describing little-endian container format that
 * the asset-conversion tooling emits and re-reads. Every read is bounds-checked
 * and every failure is reported through {@link TblParseError}, which carries the
 * byte offset and a human-readable context string so `AssetLoader` can surface a
 * descriptive startup error (design: "Parse errors in weapon/car tables cause
 * the application to halt with a fatal error at startup").
 *
 * Requirements: 4.1, 4.2, 4.3, 3.1
 */

import type {
  CarBaseStats,
  ChassisDef,
  ComponentDef,
  ComponentSlot,
  WeaponCategory,
  WeaponDef,
  WeaponSlot,
} from '@deathtrack/shared';

// ---------------------------------------------------------------------------
// Container format constants
// ---------------------------------------------------------------------------

/** ASCII `"TBL1"` magic marking the start of a Deathtrack stat-table file. */
export const TBL_MAGIC = 0x54424c31; // 'T''B''L''1'

/** The one supported container-format version. */
export const TBL_VERSION = 1;

/** Table-kind discriminator for a weapon stat table. */
export const TBL_KIND_WEAPON = 1;

/** Table-kind discriminator for a chassis/component stat table. */
export const TBL_KIND_CHASSIS = 2;

/**
 * Fixed byte length of every string field in the container. Strings are stored
 * as UTF-8, NUL-padded to this width; trailing NULs are trimmed on read.
 */
const STRING_FIELD_BYTES = 32;

/** Numeric encoding of {@link WeaponCategory}, in declaration order. */
const WEAPON_CATEGORIES: readonly WeaponCategory[] = ['forward', 'rear_drop', 'ram', 'spike'];

/** Numeric encoding of {@link WeaponSlot}, in declaration order. */
const WEAPON_SLOTS: readonly WeaponSlot[] = ['forward', 'rear', 'side_spike', 'ram'];

/** Numeric encoding of {@link ComponentSlot}, in declaration order. */
const COMPONENT_SLOTS: readonly ComponentSlot[] = [
  'engine',
  'brakes',
  'transmission',
  'tires',
  'airfoil',
  'armor',
];

/**
 * Sentinel `uint32` value marking an optional numeric field as absent (`null`).
 * Used for `beamDPS`, `projectileSpeed`, and `rangeUnits`, which are optional in
 * {@link WeaponDef}.
 */
const NULL_U32 = 0xffffffff;

// ---------------------------------------------------------------------------
// Exported table structures
// ---------------------------------------------------------------------------

/**
 * Typed weapon stat table parsed from a weapon `.TBL` file.
 *
 * Each entry is a {@link WeaponDef} whose numeric fields (damage, beam DPS,
 * projectile speed, ammo, range, price) come straight from the table.
 *
 * Requirements: 3.1
 */
export interface WeaponTable {
  /** All weapon definitions, in file order. */
  weapons: WeaponDef[];
}

/**
 * Typed chassis stat table parsed from a car `.TBL` file. Holds both the
 * selectable chassis (with base stats) and the purchasable upgrade components
 * (with additive stat deltas).
 *
 * Requirements: 4.1, 4.2, 4.3
 */
export interface ChassisTable {
  /** All chassis definitions, in file order. */
  chassis: ChassisDef[];
  /** All component (upgrade) definitions, in file order. */
  components: ComponentDef[];
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when a `.TBL` buffer cannot be parsed. Captures the byte offset at
 * which the failure was detected together with a context description, so the
 * caller can log exactly where parsing broke.
 *
 * Requirements: 4.3
 */
export class TblParseError extends Error {
  /** Byte offset within the source buffer where the failure was detected. */
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`TBL parse error at byte ${offset}: ${message}`);
    this.name = 'TblParseError';
    this.offset = offset;
  }
}

// ---------------------------------------------------------------------------
// Internal sequential cursor
// ---------------------------------------------------------------------------

/**
 * Minimal bounds-checked little-endian cursor over the source bytes. Kept local
 * to this module so the tool has no dependency on the runtime binary codec.
 */
class TblCursor {
  private readonly view: DataView;
  private readonly bytes: Uint8Array;
  private off = 0;

  constructor(source: Uint8Array) {
    this.bytes = source;
    this.view = new DataView(source.buffer, source.byteOffset, source.byteLength);
  }

  /** Current read offset in bytes. */
  get offset(): number {
    return this.off;
  }

  /** Bytes not yet consumed. */
  get remaining(): number {
    return this.bytes.byteLength - this.off;
  }

  private require(size: number, what: string): void {
    if (this.off + size > this.bytes.byteLength) {
      throw new TblParseError(
        `unexpected end of buffer reading ${what} (${size} byte(s), ${this.remaining} remaining)`,
        this.off,
      );
    }
  }

  u8(what: string): number {
    this.require(1, what);
    const v = this.view.getUint8(this.off);
    this.off += 1;
    return v;
  }

  u16(what: string): number {
    this.require(2, what);
    const v = this.view.getUint16(this.off, true);
    this.off += 2;
    return v;
  }

  u32(what: string): number {
    this.require(4, what);
    const v = this.view.getUint32(this.off, true);
    this.off += 4;
    return v;
  }

  /** Read a fixed-width UTF-8 string, trimming trailing NUL padding. */
  str(what: string): string {
    this.require(STRING_FIELD_BYTES, what);
    const slice = this.bytes.subarray(this.off, this.off + STRING_FIELD_BYTES);
    let end = STRING_FIELD_BYTES;
    while (end > 0 && slice[end - 1] === 0) {
      end -= 1;
    }
    const value = new TextDecoder('utf-8', { fatal: false }).decode(slice.subarray(0, end));
    this.off += STRING_FIELD_BYTES;
    return value;
  }
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

interface TblHeader {
  kind: number;
  recordCount: number;
  /** Only present for chassis tables; component count follows the chassis. */
  secondaryCount: number;
}

/**
 * Read and validate the shared 16-byte container header:
 * `magic:u32 | version:u32 | kind:u8 | reserved:u8 | primaryCount:u16 | secondaryCount:u16 | reserved:u16`.
 */
function readHeader(cur: TblCursor): TblHeader {
  const magicOffset = cur.offset;
  const magic = cur.u32('magic');
  if (magic !== TBL_MAGIC) {
    throw new TblParseError(
      `bad magic 0x${magic.toString(16).padStart(8, '0')} (expected 0x${TBL_MAGIC.toString(16)})`,
      magicOffset,
    );
  }

  const versionOffset = cur.offset;
  const version = cur.u32('version');
  if (version !== TBL_VERSION) {
    throw new TblParseError(`unsupported version ${version} (expected ${TBL_VERSION})`, versionOffset);
  }

  const kind = cur.u8('table kind');
  cur.u8('reserved');
  const recordCount = cur.u16('record count');
  const secondaryCount = cur.u16('secondary count');
  cur.u16('reserved');

  return { kind, recordCount, secondaryCount };
}

// ---------------------------------------------------------------------------
// Field decoders
// ---------------------------------------------------------------------------

/** Map a `uint8` enum index onto its string union member, or throw. */
function decodeEnum<T extends string>(
  members: readonly T[],
  index: number,
  what: string,
  offset: number,
): T {
  const member = members[index];
  if (member === undefined) {
    throw new TblParseError(`invalid ${what} index ${index} (max ${members.length - 1})`, offset);
  }
  return member;
}

/** Decode an optional numeric field: `NULL_U32` becomes `null`. */
function decodeOptionalU32(raw: number): number | null {
  return raw === NULL_U32 ? null : raw;
}

/**
 * Read one weapon record:
 * `id | name` (strings) followed by
 * `category:u8 | slot:u8 | pad:u16 | damage:u32 | beamDPS:u32 | projectileSpeed:u32 | ammoMax:u32 | rangeUnits:u32 | price:u32`.
 */
function readWeaponRecord(cur: TblCursor): WeaponDef {
  const id = cur.str('weapon id') as WeaponDef['id'];
  const name = cur.str('weapon name');

  const categoryOffset = cur.offset;
  const category = decodeEnum(WEAPON_CATEGORIES, cur.u8('weapon category'), 'weapon category', categoryOffset);

  const slotOffset = cur.offset;
  const slot = decodeEnum(WEAPON_SLOTS, cur.u8('weapon slot'), 'weapon slot', slotOffset);

  cur.u16('reserved');

  const damage = cur.u32('weapon damage');
  const beamDPS = decodeOptionalU32(cur.u32('weapon beamDPS'));
  const projectileSpeed = decodeOptionalU32(cur.u32('weapon projectileSpeed'));
  const ammoMax = cur.u32('weapon ammoMax');
  const rangeUnits = decodeOptionalU32(cur.u32('weapon rangeUnits'));
  const price = cur.u32('weapon price');

  return { id, name, category, damage, beamDPS, projectileSpeed, ammoMax, rangeUnits, price, slot };
}

/**
 * Read the four packed base stats (`topSpeed | acceleration | armor | handling`)
 * as consecutive `uint16` values.
 */
function readBaseStats(cur: TblCursor, what: string): CarBaseStats {
  return {
    topSpeed: cur.u16(`${what} topSpeed`),
    acceleration: cur.u16(`${what} acceleration`),
    armor: cur.u16(`${what} armor`),
    handling: cur.u16(`${what} handling`),
  };
}

/**
 * Read one chassis record:
 * `id | name | spritePath | spriteAtlasKey` (strings) followed by the four base
 * stats. An empty `spriteAtlasKey` string is treated as absent.
 */
function readChassisRecord(cur: TblCursor): ChassisDef {
  const id = cur.str('chassis id') as ChassisDef['id'];
  const name = cur.str('chassis name');
  const spritePath = cur.str('chassis sprite path');
  const atlasKey = cur.str('chassis sprite atlasKey');
  const baseStats = readBaseStats(cur, 'chassis');

  const spriteSheet = atlasKey.length > 0 ? { path: spritePath, atlasKey } : { path: spritePath };
  return { id, name, baseStats, spriteSheet };
}

/**
 * Read one component record:
 * `id | name | slot:u8 | statMask:u8 | pad:u16 | price:u32` followed by the four
 * potential stat deltas as `int16`. The `statMask` bitfield selects which of the
 * four deltas are actually present in the resulting {@link ComponentDef.statDeltas}.
 */
function readComponentRecord(cur: TblCursor): ComponentDef {
  const id = cur.str('component id');
  const name = cur.str('component name');

  const slotOffset = cur.offset;
  const slot = decodeEnum(COMPONENT_SLOTS, cur.u8('component slot'), 'component slot', slotOffset);

  const statMask = cur.u8('component statMask');
  cur.u16('reserved');
  const price = cur.u32('component price');

  const topSpeed = readInt16(cur, 'component delta topSpeed');
  const acceleration = readInt16(cur, 'component delta acceleration');
  const armor = readInt16(cur, 'component delta armor');
  const handling = readInt16(cur, 'component delta handling');

  const statDeltas: Partial<CarBaseStats> = {};
  if (statMask & 0b0001) statDeltas.topSpeed = topSpeed;
  if (statMask & 0b0010) statDeltas.acceleration = acceleration;
  if (statMask & 0b0100) statDeltas.armor = armor;
  if (statMask & 0b1000) statDeltas.handling = handling;

  return { id, slot, name, price, statDeltas };
}

/** Read a signed 16-bit little-endian integer via the cursor's unsigned read. */
function readInt16(cur: TblCursor, what: string): number {
  const raw = cur.u16(what);
  return raw >= 0x8000 ? raw - 0x10000 : raw;
}

// ---------------------------------------------------------------------------
// Public parse functions
// ---------------------------------------------------------------------------

/**
 * Parse a weapon `.TBL` buffer into a typed {@link WeaponTable}.
 *
 * @param buf Raw file bytes (`Uint8Array` or Node `Buffer`).
 * @returns The decoded weapon table.
 * @throws {TblParseError} If the magic, version, or table kind is wrong, an
 *   enum value is out of range, or the buffer is truncated. The thrown error's
 *   `offset` field identifies the failing byte.
 *
 * Requirements: 3.1
 */
export function parseWeaponTable(buf: Uint8Array): WeaponTable {
  const cur = new TblCursor(buf);
  const header = readHeader(cur);
  if (header.kind !== TBL_KIND_WEAPON) {
    throw new TblParseError(
      `expected weapon table (kind ${TBL_KIND_WEAPON}) but found kind ${header.kind}`,
      0,
    );
  }

  const weapons: WeaponDef[] = [];
  for (let i = 0; i < header.recordCount; i += 1) {
    try {
      weapons.push(readWeaponRecord(cur));
    } catch (err) {
      throw wrapRecordError(err, `weapon record ${i}`);
    }
  }
  return { weapons };
}

/**
 * Parse a chassis/component `.TBL` buffer into a typed {@link ChassisTable}.
 *
 * The header's primary count is the number of chassis records; the secondary
 * count is the number of component records that follow.
 *
 * @param buf Raw file bytes (`Uint8Array` or Node `Buffer`).
 * @returns The decoded chassis + component table.
 * @throws {TblParseError} On any structural or range error, with the failing
 *   byte offset attached.
 *
 * Requirements: 4.1, 4.2, 4.3
 */
export function parseChassisTable(buf: Uint8Array): ChassisTable {
  const cur = new TblCursor(buf);
  const header = readHeader(cur);
  if (header.kind !== TBL_KIND_CHASSIS) {
    throw new TblParseError(
      `expected chassis table (kind ${TBL_KIND_CHASSIS}) but found kind ${header.kind}`,
      0,
    );
  }

  const chassis: ChassisDef[] = [];
  for (let i = 0; i < header.recordCount; i += 1) {
    try {
      chassis.push(readChassisRecord(cur));
    } catch (err) {
      throw wrapRecordError(err, `chassis record ${i}`);
    }
  }

  const components: ComponentDef[] = [];
  for (let i = 0; i < header.secondaryCount; i += 1) {
    try {
      components.push(readComponentRecord(cur));
    } catch (err) {
      throw wrapRecordError(err, `component record ${i}`);
    }
  }

  return { chassis, components };
}

/**
 * Wrap a lower-level {@link TblParseError} with additional record context while
 * preserving the original byte offset. Non-parse errors are rethrown untouched.
 */
function wrapRecordError(err: unknown, context: string): TblParseError {
  if (err instanceof TblParseError) {
    return new TblParseError(`${context}: ${err.message.replace(/^TBL parse error at byte \d+: /, '')}`, err.offset);
  }
  throw err;
}
