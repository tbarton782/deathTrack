import { describe, it, expect } from 'vitest';

import {
  buildChunkReport,
  reportFile,
  formatChunkReport,
} from '../chunkProbe.js';
import { parseChunks } from '../parsers/ChunkReader.js';

/** Build one Dynamix chunk: 3-char id + ':' , uint32 length (bit31=container), data. */
function chunk(id: string, isContainer: boolean, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length);
  out[0] = id.charCodeAt(0);
  out[1] = id.charCodeAt(1);
  out[2] = id.charCodeAt(2);
  out[3] = 0x3a; // ':'
  const word = (data.length & 0x7fffffff) | (isContainer ? 0x80000000 : 0);
  out[4] = word & 0xff;
  out[5] = (word >>> 8) & 0xff;
  out[6] = (word >>> 16) & 0xff;
  out[7] = (word >>> 24) & 0xff;
  out.set(data, 8);
  return out;
}

/** Concatenate byte arrays. */
function cat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

describe('chunkProbe.buildChunkReport', () => {
  it('flattens a nested chunk tree depth-first with depth, kind, length, offset', () => {
    // A container "PAL:" holding a leaf "VGA:" of 6 bytes, then a top-level leaf "BIN:".
    const vga = chunk('VGA', false, new Uint8Array(6));
    const pal = chunk('PAL', true, vga);
    const bin = chunk('BIN', false, new Uint8Array(4));
    const bytes = cat(pal, bin);

    const nodes = parseChunks(bytes);
    const report = buildChunkReport(nodes);

    expect(report).toEqual([
      { depth: 0, id: 'PAL', isContainer: true, length: vga.length, offset: 0 },
      { depth: 1, id: 'VGA', isContainer: false, length: 6, offset: 8 },
      { depth: 0, id: 'BIN', isContainer: false, length: 4, offset: pal.length },
    ]);
  });
});

describe('chunkProbe.reportFile', () => {
  it('reports a valid chunk file with no parse error', () => {
    const bytes = chunk('BIN', false, new Uint8Array([1, 2, 3]));
    const r = reportFile('OK.BIN', bytes);
    expect(r.parseError).toBeNull();
    expect(r.byteLength).toBe(bytes.length);
    expect(r.nodes).toHaveLength(1);
    expect(r.nodes[0]!.id).toBe('BIN');
  });

  it('records a parse error for a non-chunk (raw) file instead of throwing', () => {
    // Raw .TRK-like payload: leading "TRK:" then binary — the length word is not
    // a valid chunk boundary, so it is reported as a non-chunk file.
    const bytes = new Uint8Array([0x54, 0x52, 0x4b, 0x3a, 0xff, 0xff, 0xff, 0x7f, 0x00]);
    const r = reportFile('BAY_AREA.TRK', bytes);
    expect(r.parseError).not.toBeNull();
    expect(r.nodes).toHaveLength(0);
  });
});

describe('chunkProbe.formatChunkReport', () => {
  it('renders indented text for containers, leaves, and non-chunk files', () => {
    const vga = chunk('VGA', false, new Uint8Array(6));
    const pal = chunk('PAL', true, vga);
    const good = reportFile('ACTIVISI', pal);
    const raw = reportFile('RAW.TRK', new Uint8Array([0x54, 0x52, 0x4b, 0x3a, 0, 0, 0, 0x40]));

    const text = formatChunkReport([good, raw]);
    expect(text).toContain('ACTIVISI');
    expect(text).toContain('PAL: container');
    expect(text).toContain('VGA: leaf');
    expect(text).toContain('[not a chunk tree]');
  });
});
