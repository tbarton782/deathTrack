/**
 * Unit and property tests for the schema-driven codec factory.
 *
 * Verifies that `createCodec` preserves field order, round-trips flat objects,
 * nested objects, and arrays, and that the encode -> decode cycle reproduces a
 * deeply-equal value across arbitrary inputs.
 *
 * Requirements: 8.7, 8.8
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  createCodec,
  uint8,
  uint16,
  int16,
  uint32,
  float32,
  float64,
  boolean,
  fixedString,
  nested,
  array,
  type SchemaDescriptor,
} from '../schema.js';

describe('createCodec flat objects', () => {
  interface Header {
    tick: number;
    serverTime: number;
    checksum: number;
    active: boolean;
  }

  const schema: SchemaDescriptor<Header> = [
    { key: 'tick', type: uint32 },
    { key: 'serverTime', type: float64 },
    { key: 'checksum', type: uint32 },
    { key: 'active', type: boolean },
  ];

  it('round-trips a flat object', () => {
    const codec = createCodec(schema);
    const value: Header = { tick: 12345, serverTime: 1234.5, checksum: 0xdead_beef, active: true };
    const decoded = codec.decode(codec.encode(value));
    expect(decoded).toEqual(value);
  });

  it('encodes fields in descriptor order', () => {
    const codec = createCodec(schema);
    // tick (uint32 LE) = 1 -> 01 00 00 00 as the first four bytes.
    const bytes = codec.encode({ tick: 1, serverTime: 0, checksum: 0, active: false });
    expect(Array.from(bytes.subarray(0, 4))).toEqual([1, 0, 0, 0]);
  });

  it('produces distinct byte layouts when field order differs', () => {
    const forward: SchemaDescriptor<{ a: number; b: number }> = [
      { key: 'a', type: uint8 },
      { key: 'b', type: uint16 },
    ];
    const reversed: SchemaDescriptor<{ a: number; b: number }> = [
      { key: 'b', type: uint16 },
      { key: 'a', type: uint8 },
    ];
    const value = { a: 7, b: 258 };
    const forwardBytes = createCodec(forward).encode(value);
    const reversedBytes = createCodec(reversed).encode(value);
    // Same fields, different order -> the first byte differs.
    expect(forwardBytes[0]).not.toBe(reversedBytes[0]);
  });
});

describe('createCodec strings and nested objects', () => {
  interface Player {
    name: string;
    score: number;
  }
  interface Match {
    id: number;
    host: Player;
  }

  const playerSchema: SchemaDescriptor<Player> = [
    { key: 'name', type: fixedString(16) },
    { key: 'score', type: int16 },
  ];
  const matchSchema: SchemaDescriptor<Match> = [
    { key: 'id', type: uint16 },
    { key: 'host', type: nested(playerSchema) },
  ];

  it('round-trips a fixed-length string field', () => {
    const codec = createCodec(playerSchema);
    const value: Player = { name: 'Mad Max', score: -42 };
    expect(codec.decode(codec.encode(value))).toEqual(value);
  });

  it('round-trips a nested object field', () => {
    const codec = createCodec(matchSchema);
    const value: Match = { id: 9, host: { name: 'Ripper', score: 1000 } };
    expect(codec.decode(codec.encode(value))).toEqual(value);
  });
});

describe('createCodec array fields', () => {
  interface Roster {
    count: number;
    names: readonly string[];
  }

  const schema: SchemaDescriptor<Roster> = [
    { key: 'count', type: uint8 },
    { key: 'names', type: array(fixedString(8)) },
  ];

  it('round-trips a variable-length array of strings', () => {
    const codec = createCodec(schema);
    const value: Roster = { count: 3, names: ['ann', 'bob', 'cy'] };
    expect(codec.decode(codec.encode(value))).toEqual(value);
  });

  it('round-trips an empty array', () => {
    const codec = createCodec(schema);
    const value: Roster = { count: 0, names: [] };
    expect(codec.decode(codec.encode(value))).toEqual(value);
  });

  it('round-trips an array of nested structs', () => {
    interface Entry {
      x: number;
      y: number;
    }
    const entrySchema: SchemaDescriptor<Entry> = [
      { key: 'x', type: float32 },
      { key: 'y', type: float32 },
    ];
    interface Path {
      points: readonly Entry[];
    }
    const pathSchema: SchemaDescriptor<Path> = [{ key: 'points', type: array(nested(entrySchema)) }];
    const codec = createCodec(pathSchema);
    const value: Path = { points: [{ x: 1.5, y: -2.5 }, { x: 0, y: 3.25 }] };
    expect(codec.decode(codec.encode(value))).toEqual(value);
  });
});

describe('property: schema round-trip preserves all fields', () => {
  interface Record {
    a: number;
    b: number;
    c: number;
    d: boolean;
    label: string;
    items: readonly number[];
  }

  const schema: SchemaDescriptor<Record> = [
    { key: 'a', type: uint8 },
    { key: 'b', type: uint16 },
    { key: 'c', type: uint32 },
    { key: 'd', type: boolean },
    { key: 'label', type: fixedString(32) },
    { key: 'items', type: array(uint16) },
  ];

  it('reproduces a deeply-equal object for arbitrary values', () => {
    const codec = createCodec(schema);
    const arb = fc.record<Record>({
      a: fc.integer({ min: 0, max: 255 }),
      b: fc.integer({ min: 0, max: 65535 }),
      c: fc.integer({ min: 0, max: 0xffff_ffff }),
      d: fc.boolean(),
      // Avoid NUL (trimmed as padding) and keep UTF-8 within the 32-byte field.
      label: fc.string({ maxLength: 8 }).filter((s) => !s.includes('\u0000')),
      items: fc.array(fc.integer({ min: 0, max: 65535 }), { maxLength: 20 }),
    });

    fc.assert(
      fc.property(arb, (value) => {
        const decoded = codec.decode(codec.encode(value));
        expect(decoded).toEqual(value);
      }),
      { numRuns: 1000 },
    );
  });
});
