/**
 * Unit tests for the Dynamix decompressors, focused on LZW (method 0x02) since
 * it is the codec the SCR/BMP/FNT pipeline depends on and the one most likely
 * to hide a subtle bit-packing or dictionary bug.
 *
 * Strategy:
 *  - Structural checks on the little-endian bit reader/writer so the round-trip
 *    below is not merely two mirror-image bugs cancelling out.
 *  - encode -> decode -> original round-trips over hand-picked and randomised
 *    inputs, including highly repetitive data that forces dictionary growth
 *    past 9-bit into 10/11/12-bit widths.
 *  - RLE spot checks (repeat + copy).
 */

import { describe, it, expect } from 'vitest';

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import {
  lzwDecompress,
  rleDecompress,
  decompress,
  parseCompressedLeaf,
  CompressionType,
  DecompressError,
} from '../decompress.js';
import { parseChunks, findChunk } from '../ChunkReader.js';
import { lzwEncode, LittleEndianBitWriter } from './lzwEncode.js';

/** Read `width`-bit LSB-first codes back from a buffer, mirroring the decoder. */
function readCodes(bytes: Uint8Array, widths: number[]): number[] {
  let bitPos = 0;
  const codes: number[] = [];
  for (const width of widths) {
    let value = 0;
    for (let i = 0; i < width; i += 1) {
      const bit = ((bytes[bitPos >> 3] as number) >> (bitPos & 7)) & 1;
      value |= bit << i;
      bitPos += 1;
    }
    codes.push(value >>> 0);
  }
  return codes;
}

/** Directory holding the original Death Track files, if present on this host. */
const DTRACK_DIR = 'C:\\Users\\tbart\\OneDrive\\1Projects\\Games\\dtrack';

/** Prepend the 5-byte leaf header (method + uint32 decompressedSize). */
function withHeader(type: CompressionType, decompressedSize: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(5 + body.length);
  out[0] = type;
  out[1] = decompressedSize & 0xff;
  out[2] = (decompressedSize >>> 8) & 0xff;
  out[3] = (decompressedSize >>> 16) & 0xff;
  out[4] = (decompressedSize >>> 24) & 0xff;
  out.set(body, 5);
  return out;
}

describe('LittleEndianBitWriter / reader', () => {
  it('round-trips values LSB-first across byte boundaries', () => {
    const w = new LittleEndianBitWriter();
    // 9-bit codes: 0x101 (257), 0x0FF (255), 0x100 (256)
    w.write(257, 9);
    w.write(255, 9);
    w.write(256, 9);
    const bytes = w.finish();
    expect(readCodes(bytes, [9, 9, 9])).toEqual([257, 255, 256]);
  });

  it('packs a single 9-bit value with the low byte first', () => {
    const w = new LittleEndianBitWriter();
    w.write(0x1ab, 9); // binary 1_1010_1011
    const bytes = w.finish();
    // LSB-first: byte0 = low 8 bits = 0xAB, byte1 bit0 = 9th bit = 1
    expect(bytes[0]).toBe(0xab);
    expect((bytes[1] as number) & 1).toBe(1);
  });
});

describe('lzwDecompress (round-trip against reference encoder)', () => {
  const roundTrip = (input: Uint8Array): void => {
    const encoded = lzwEncode(input);
    const decoded = lzwDecompress(encoded, input.length);
    expect(Array.from(decoded)).toEqual(Array.from(input));
  };

  it('handles an empty input', () => {
    roundTrip(new Uint8Array(0));
  });

  it('handles a single byte', () => {
    roundTrip(Uint8Array.of(0x42));
  });

  it('handles a short ASCII string', () => {
    roundTrip(new TextEncoder().encode('TOBEORNOTTOBEORTOBEORNOT'));
  });

  it('handles the classic LZW KwKwK case (aaaaa...)', () => {
    roundTrip(new Uint8Array(64).fill(0x61));
  });

  it('handles long repetitive data that forces width growth past 9 bits', () => {
    // A repeating pattern quickly fills the dictionary beyond 512 entries,
    // forcing 10/11/12-bit code widths.
    const input = new Uint8Array(20000);
    for (let i = 0; i < input.length; i += 1) input[i] = (i * 7 + (i >> 3)) & 0xff;
    roundTrip(input);
  });

  it('handles input large enough to fill the 12-bit dictionary ceiling', () => {
    // >64 KB of varied data drives the dictionary to 4096 entries so the
    // ceiling-freeze path (no reset emitted) is exercised end-to-end.
    const input = new Uint8Array(70000);
    for (let i = 0; i < input.length; i += 1) input[i] = (i * 7 + (i >> 3)) & 0xff;
    roundTrip(input);
  });

  it('handles all 256 byte values in sequence, repeated', () => {
    const input = new Uint8Array(256 * 20);
    for (let i = 0; i < input.length; i += 1) input[i] = i & 0xff;
    roundTrip(input);
  });

  it('handles pseudo-random data of varied lengths', () => {
    let seed = 0x1234abcd;
    const rand = (): number => {
      // xorshift32
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) & 0xff;
    };
    for (const len of [2, 3, 7, 100, 513, 1024, 5000]) {
      const input = new Uint8Array(len);
      for (let i = 0; i < len; i += 1) input[i] = rand();
      roundTrip(input);
    }
  });

  it('throws with a byte offset when the stream ends before output is filled', () => {
    const encoded = lzwEncode(new TextEncoder().encode('hello'));
    // Ask for more output than the stream encodes.
    expect(() => lzwDecompress(encoded, 1000)).toThrowError(DecompressError);
  });
});

describe('lzwDecompress against a real Death Track file', () => {
  // This is the ground-truth check: the round-trip tests above only prove the
  // decoder is self-consistent with our reference encoder. Decoding an actual
  // game file proves the decoder matches the real Dynamix stream format.
  it('decodes the CAR1.SCR BIN: leaf to exactly its declared size', async () => {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await fs.readFile(path.join(DTRACK_DIR, 'CAR1.SCR')));
    } catch {
      // The real files are not in source control; skip when absent.
      return;
    }
    const chunks = parseChunks(bytes);
    const bin = findChunk(chunks, 'BIN');
    expect(bin).toBeDefined();
    const leaf = parseCompressedLeaf(bin!.data);
    expect(leaf.type).toBe(CompressionType.Lzw);

    const out = lzwDecompress(leaf.data, leaf.decompressedSize);
    // A well-formed decode fills exactly the declared output length with no
    // "invalid code" or "input exhausted" error.
    expect(out.length).toBe(leaf.decompressedSize);
    // The screen plane should not be a single flat value.
    const distinct = new Set(out).size;
    expect(distinct).toBeGreaterThan(1);
  });

  it('decodes CITYPIC.SCR, which triggers a dictionary-full reset (divisible-by-8 skip rule)', async () => {
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await fs.readFile(path.join(DTRACK_DIR, 'CITYPIC.SCR')));
    } catch {
      return; // real file not present; skip
    }
    const bin = findChunk(parseChunks(bytes), 'BIN');
    const leaf = parseCompressedLeaf(bin!.data);
    // This stream fills the 4096-entry dictionary and emits a reset (code 256)
    // mid-stream; without the skip rule the decode derails partway through.
    const out = lzwDecompress(leaf.data, leaf.decompressedSize);
    expect(out.length).toBe(leaf.decompressedSize);
  });
});

describe('rleDecompress', () => {
  it('expands a repeat code (high bit set)', () => {
    // 0x83 = repeat count 3; value 0xAA
    const out = rleDecompress(Uint8Array.of(0x83, 0xaa), 3);
    expect(Array.from(out)).toEqual([0xaa, 0xaa, 0xaa]);
  });

  it('copies verbatim bytes (high bit clear)', () => {
    // 0x03 = copy 3 bytes
    const out = rleDecompress(Uint8Array.of(0x03, 1, 2, 3), 3);
    expect(Array.from(out)).toEqual([1, 2, 3]);
  });

  it('mixes repeat and copy runs', () => {
    const body = Uint8Array.of(0x02, 9, 8, 0x84, 0x00);
    const out = rleDecompress(body, 6);
    expect(Array.from(out)).toEqual([9, 8, 0, 0, 0, 0]);
  });
});

describe('decompress dispatcher', () => {
  it('parses the 5-byte leaf header', () => {
    const leaf = withHeader(CompressionType.None, 4, Uint8Array.of(1, 2, 3, 4));
    const parsed = parseCompressedLeaf(leaf);
    expect(parsed.type).toBe(CompressionType.None);
    expect(parsed.decompressedSize).toBe(4);
    expect(Array.from(parsed.data)).toEqual([1, 2, 3, 4]);
  });

  it('copies an uncompressed (0x00) leaf', () => {
    const leaf = withHeader(CompressionType.None, 4, Uint8Array.of(1, 2, 3, 4, 99));
    expect(Array.from(decompress(leaf))).toEqual([1, 2, 3, 4]);
  });

  it('routes LZW leaves through the LZW decoder', () => {
    const input = new TextEncoder().encode('DEATHTRACKDEATHTRACK');
    const leaf = withHeader(CompressionType.Lzw, input.length, lzwEncode(input));
    expect(Array.from(decompress(leaf))).toEqual(Array.from(input));
  });

  it('rejects a leaf shorter than the header', () => {
    expect(() => parseCompressedLeaf(Uint8Array.of(1, 2))).toThrowError(DecompressError);
  });
});
