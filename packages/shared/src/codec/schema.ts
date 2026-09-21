/**
 * Schema-driven binary codec factory for the shared serialisation layer.
 *
 * A {@link SchemaDescriptor} lists an object's fields in a fixed, immutable
 * order together with the wire type of each field. {@link createCodec} turns a
 * descriptor into a {@link Codec} whose `encode`/`decode` pair walks the fields
 * in that exact order, guaranteeing that `decode(encode(value))` reproduces a
 * structurally identical object. Because both directions iterate the same
 * ordered field list, the encoder and decoder can never drift out of sync.
 *
 * The factory is built on top of {@link BinaryWriter}/{@link BinaryReader} and
 * exposes a small set of composable field types (primitives, fixed-length
 * strings, nested schemas, and length-prefixed arrays) that cover the network
 * packet and save-file structures used across the game.
 *
 * Requirements: 8.7, 8.8
 */

import { BinaryWriter } from './BinaryWriter.js';
import { BinaryReader } from './BinaryReader.js';

/**
 * A schema-driven encoder/decoder pair for values of type `T`.
 *
 * `encode` serialises a value to a little-endian byte buffer; `decode` parses a
 * buffer produced by `encode` back into an equal value.
 */
export interface Codec<T> {
  /** Serialise `value` to a freshly allocated little-endian byte buffer. */
  encode(value: T): Uint8Array;
  /** Parse a buffer produced by {@link encode} back into a `T`. */
  decode(buf: Uint8Array): T;
}

/**
 * A single field's wire type: it knows how to append its portion of a value to
 * a {@link BinaryWriter} and how to read that same portion back from a
 * {@link BinaryReader}. Field types are the composable building blocks of a
 * {@link SchemaDescriptor}.
 *
 * @typeParam V The TypeScript type of the value this field carries.
 */
export interface FieldType<V> {
  /** Append `value` to `writer` at its current offset. */
  write(writer: BinaryWriter, value: V): void;
  /** Read a value of this field type from `reader` at its current offset. */
  read(reader: BinaryReader): V;
}

/**
 * One entry in a {@link SchemaDescriptor}: binds an object property `key` to the
 * {@link FieldType} that encodes and decodes it. The `key` must be a property of
 * `T`, and the field type must match that property's value type.
 *
 * @typeParam T The object type the parent schema describes.
 * @typeParam K The specific property key this field binds to.
 */
export type SchemaField<T, K extends keyof T = keyof T> = {
  readonly key: K;
  readonly type: FieldType<T[K]>;
};

/**
 * An ordered, immutable description of how to serialise an object of type `T`.
 *
 * The array order *is* the wire order: fields are written and read strictly
 * top-to-bottom, so reordering the descriptor changes the binary layout. Once a
 * descriptor is published as a codec schema version it must not be reordered or
 * have fields inserted/removed; breaking changes require a new schema version.
 *
 * @typeParam T The object type this schema describes.
 */
export type SchemaDescriptor<T> = ReadonlyArray<SchemaField<T>>;

/**
 * Produce a {@link Codec} from a field-ordered {@link SchemaDescriptor}.
 *
 * `encode` walks the descriptor in order, delegating each field to its
 * {@link FieldType.write}; `decode` walks the identical order, delegating to
 * {@link FieldType.read} and assembling the result object. Because both
 * directions share the one ordered descriptor, field order is preserved and the
 * encode -> decode round-trip is structure-preserving.
 *
 * @typeParam T The object type the schema describes.
 * @param schema The ordered field descriptor.
 * @returns A codec that encodes and decodes values of type `T`.
 */
export function createCodec<T>(schema: SchemaDescriptor<T>): Codec<T> {
  return {
    encode(value: T): Uint8Array {
      const writer = new BinaryWriter();
      for (const field of schema) {
        field.type.write(writer, value[field.key]);
      }
      return writer.toUint8Array();
    },
    decode(buf: Uint8Array): T {
      const reader = new BinaryReader(buf);
      // Assemble into a partial and cast once at the end: every schema field
      // populates exactly one key, so the completed object satisfies `T`.
      const result = {} as { [K in keyof T]: T[K] };
      for (const field of schema) {
        result[field.key] = field.type.read(reader);
      }
      return result as T;
    },
  };
}

// ---------------------------------------------------------------------------
// Field-type constructors
//
// Each constructor returns a FieldType wrapping the matching BinaryWriter /
// BinaryReader primitive, so schemas read as a declarative list of fields.
// ---------------------------------------------------------------------------

/** Unsigned 8-bit integer field (0–255). */
export const uint8: FieldType<number> = {
  write: (w, v) => void w.uint8(v),
  read: (r) => r.uint8(),
};

/** Unsigned 16-bit integer field (0–65535), little-endian. */
export const uint16: FieldType<number> = {
  write: (w, v) => void w.uint16(v),
  read: (r) => r.uint16(),
};

/** Signed 16-bit integer field (-32768–32767), little-endian. */
export const int16: FieldType<number> = {
  write: (w, v) => void w.int16(v),
  read: (r) => r.int16(),
};

/** Unsigned 32-bit integer field, little-endian. */
export const uint32: FieldType<number> = {
  write: (w, v) => void w.uint32(v),
  read: (r) => r.uint32(),
};

/** Signed 32-bit integer field, little-endian. */
export const int32: FieldType<number> = {
  write: (w, v) => void w.int32(v),
  read: (r) => r.int32(),
};

/** 32-bit IEEE-754 float field, little-endian. */
export const float32: FieldType<number> = {
  write: (w, v) => void w.float32(v),
  read: (r) => r.float32(),
};

/** 64-bit IEEE-754 float field, little-endian. */
export const float64: FieldType<number> = {
  write: (w, v) => void w.float64(v),
  read: (r) => r.float64(),
};

/** Boolean field encoded as a single byte (0 or 1). */
export const boolean: FieldType<boolean> = {
  write: (w, v) => void w.uint8(v ? 1 : 0),
  read: (r) => r.uint8() !== 0,
};

/**
 * A fixed-length UTF-8 string field occupying exactly `byteLength` bytes on the
 * wire. Shorter strings are zero-padded; strings whose UTF-8 encoding exceeds
 * `byteLength` are rejected by the underlying writer.
 *
 * @param byteLength The exact on-wire width of the field in bytes.
 */
export function fixedString(byteLength: number): FieldType<string> {
  return {
    write: (w, v) => void w.fixedString(v, byteLength),
    read: (r) => r.fixedString(byteLength),
  };
}

/**
 * A nested object field encoded inline using its own {@link SchemaDescriptor}.
 * The nested fields are appended at the current offset in schema order, so the
 * decoder consumes them in the identical order.
 *
 * @typeParam V The nested object type.
 * @param schema The ordered descriptor for the nested object.
 */
export function nested<V>(schema: SchemaDescriptor<V>): FieldType<V> {
  return {
    write: (w, v) => {
      for (const field of schema) {
        field.type.write(w, v[field.key]);
      }
    },
    read: (r) => {
      const result = {} as { [K in keyof V]: V[K] };
      for (const field of schema) {
        result[field.key] = field.type.read(r);
      }
      return result as V;
    },
  };
}

/**
 * A variable-length array field, encoded as a `uint16` element count followed by
 * that many elements each serialised with `element`. Supports up to 65535
 * elements, which comfortably covers the game's small bounded collections.
 *
 * @typeParam V The element type.
 * @param element The field type used for each element.
 */
export function array<V>(element: FieldType<V>): FieldType<readonly V[]> {
  return {
    write: (w, values) => {
      w.uint16(values.length);
      for (const item of values) {
        element.write(w, item);
      }
    },
    read: (r) => {
      const count = r.uint16();
      const out: V[] = [];
      for (let i = 0; i < count; i += 1) {
        out.push(element.read(r));
      }
      return out;
    },
  };
}
