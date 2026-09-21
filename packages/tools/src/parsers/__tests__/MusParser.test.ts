/**
 * Tests for the `MusParser` OPL2/AdLib `.MUS` sequence parser and OGG stub
 * converter.
 *
 * Requirements: 10.1
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';

import {
  parseMus,
  toOggStub,
  convertMusToOggStub,
  MusParseError,
  type OplEvent,
  type MusSequence,
} from '../MusParser.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Serialise a list of OPL events into a raw `.MUS` register stream. */
function encodeEvents(events: OplEvent[], lengthPrefix = false): Uint8Array {
  const dataSize = events.length * 4;
  const total = lengthPrefix ? dataSize + 2 : dataSize;
  const buffer = new Uint8Array(total);
  const view = new DataView(buffer.buffer);
  let offset = 0;
  if (lengthPrefix) {
    view.setUint16(0, dataSize, true);
    offset = 2;
  }
  for (const event of events) {
    view.setUint8(offset, event.register);
    view.setUint8(offset + 1, event.value);
    view.setUint16(offset + 2, event.delay, true);
    offset += 4;
  }
  return buffer;
}

/** Decode an OGG stub's base64 payload back into a `MusSequence`. */
function decodeStub(data: string): MusSequence {
  const json = Buffer.from(data, 'base64').toString('utf-8');
  return JSON.parse(json) as MusSequence;
}

// ---------------------------------------------------------------------------
// Unit tests — parsing
// ---------------------------------------------------------------------------

describe('parseMus', () => {
  it('parses a simple register stream with default tick rate', () => {
    const events: OplEvent[] = [
      { register: 0x20, value: 0x01, delay: 10 },
      { register: 0x40, value: 0x3f, delay: 5 },
      { register: 0xb0, value: 0x00, delay: 0 },
    ];
    const seq = parseMus(encodeEvents(events));

    expect(seq.events).toEqual(events);
    expect(seq.tickRate).toBe(560);
    expect(seq.totalTicks).toBe(15);
    expect(seq.durationSeconds).toBeCloseTo(15 / 560, 10);
  });

  it('returns an empty sequence for an empty buffer', () => {
    const seq = parseMus(new Uint8Array(0));
    expect(seq.events).toHaveLength(0);
    expect(seq.totalTicks).toBe(0);
    expect(seq.durationSeconds).toBe(0);
  });

  it('honours a caller-supplied tick rate', () => {
    const seq = parseMus(encodeEvents([{ register: 1, value: 2, delay: 700 }]), {
      tickRate: 700,
    });
    expect(seq.tickRate).toBe(700);
    expect(seq.durationSeconds).toBeCloseTo(1, 10);
  });

  it('parses a length-prefixed stream', () => {
    const events: OplEvent[] = [{ register: 0xa0, value: 0x81, delay: 3 }];
    const seq = parseMus(encodeEvents(events, true), { hasLengthPrefix: true });
    expect(seq.events).toEqual(events);
  });

  it('throws with byte-offset context on a misaligned stream', () => {
    // 5 bytes: one full event (4) + 1 stray byte.
    const buffer = new Uint8Array([0x20, 0x01, 0x0a, 0x00, 0xff]);
    expect(() => parseMus(buffer)).toThrowError(MusParseError);
    try {
      parseMus(buffer);
    } catch (error) {
      expect(error).toBeInstanceOf(MusParseError);
      expect((error as MusParseError).offset).toBe(4);
      expect((error as MusParseError).message).toContain('0x0004');
    }
  });

  it('throws when a length prefix overruns the buffer', () => {
    const buffer = new Uint8Array(4);
    new DataView(buffer.buffer).setUint16(0, 100, true); // claims 100 bytes
    expect(() => parseMus(buffer, { hasLengthPrefix: true })).toThrowError(MusParseError);
  });

  it('throws when a length prefix is missing', () => {
    expect(() => parseMus(new Uint8Array([0x01]), { hasLengthPrefix: true })).toThrowError(
      MusParseError,
    );
  });

  it('rejects a non-positive tick rate', () => {
    expect(() => parseMus(new Uint8Array(0), { tickRate: 0 })).toThrowError(MusParseError);
  });
});

// ---------------------------------------------------------------------------
// Unit tests — OGG stub conversion
// ---------------------------------------------------------------------------

describe('toOggStub / convertMusToOggStub', () => {
  it('produces a base64 stub that round-trips the sequence', () => {
    const events: OplEvent[] = [
      { register: 0x20, value: 0x01, delay: 4 },
      { register: 0x40, value: 0x10, delay: 6 },
    ];
    const buffer = encodeEvents(events);
    const stub = convertMusToOggStub(buffer, { context: 'race' });

    expect(stub.format).toBe('ogg-stub');
    expect(stub.version).toBe(1);
    expect(stub.context).toBe('race');
    expect(stub.eventCount).toBe(2);
    expect(stub.tickRate).toBe(560);

    const decoded = decodeStub(stub.data);
    expect(decoded.events).toEqual(events);
    expect(decoded.totalTicks).toBe(10);
  });

  it('omits context when none is supplied', () => {
    const stub = toOggStub(parseMus(new Uint8Array(0)));
    expect(stub.context).toBeUndefined();
    expect(stub.eventCount).toBe(0);
  });

  it('rethrows parse errors from convertMusToOggStub', () => {
    const buffer = new Uint8Array([0x20, 0x01, 0x0a]); // truncated event
    expect(() => convertMusToOggStub(buffer)).toThrowError(MusParseError);
  });
});

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

const eventArb: fc.Arbitrary<OplEvent> = fc.record({
  register: fc.integer({ min: 0, max: 255 }),
  value: fc.integer({ min: 0, max: 255 }),
  delay: fc.integer({ min: 0, max: 65535 }),
});

describe('parseMus properties', () => {
  it('round-trips any well-formed register stream (encode -> parse)', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 200 }), (events) => {
        const seq = parseMus(encodeEvents(events));
        expect(seq.events).toEqual(events);
        const expectedTicks = events.reduce((sum, e) => sum + e.delay, 0);
        expect(seq.totalTicks).toBe(expectedTicks);
      }),
    );
  });

  it('round-trips through the base64 OGG stub payload', () => {
    fc.assert(
      fc.property(fc.array(eventArb, { maxLength: 200 }), (events) => {
        const stub = convertMusToOggStub(encodeEvents(events));
        const decoded = decodeStub(stub.data);
        expect(decoded.events).toEqual(events);
        expect(stub.eventCount).toBe(events.length);
      }),
    );
  });

  it('rejects every misaligned (non-multiple-of-4) register stream', () => {
    fc.assert(
      fc.property(
        fc.array(eventArb, { maxLength: 50 }),
        fc.integer({ min: 1, max: 3 }),
        (events, extra) => {
          const aligned = encodeEvents(events);
          const misaligned = new Uint8Array(aligned.byteLength + extra);
          misaligned.set(aligned, 0);
          expect(() => parseMus(misaligned)).toThrowError(MusParseError);
        },
      ),
    );
  });
});
