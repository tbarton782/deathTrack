/**
 * Minimal PNG encoder for emitting decoded Death Track images so they can be
 * inspected. Produces a standard 8-bit RGBA PNG using Node's built-in `zlib`
 * for the IDAT deflate stream.
 *
 * This is a diagnostic/output helper for the asset pipeline, not a general PNG
 * library.
 */

import { deflateSync } from 'node:zlib';

/** CRC-32 table for PNG chunk CRCs (IEEE polynomial). */
const CRC_TABLE = (() => {
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

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = (CRC_TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Write a big-endian uint32 into `buf` at `offset`. */
function writeUint32BE(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

/** Assemble a single PNG chunk: length + type + data + CRC. */
function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new Uint8Array(4);
  for (let i = 0; i < 4; i += 1) typeBytes[i] = type.charCodeAt(i);
  const out = new Uint8Array(12 + data.length);
  writeUint32BE(out, 0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  const crc = crc32(out.subarray(4, 8 + data.length));
  writeUint32BE(out, 8 + data.length, crc);
  return out;
}

/**
 * Encode an RGBA pixel buffer into a PNG file.
 *
 * @param width   Image width in pixels.
 * @param height  Image height in pixels.
 * @param rgba    Row-major RGBA bytes, length = width * height * 4.
 * @returns The PNG file bytes.
 */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (rgba.length !== width * height * 4) {
    throw new Error(`rgba length ${rgba.length} != ${width}*${height}*4`);
  }

  // IHDR: width, height, bit depth 8, colour type 6 (RGBA), no interlace.
  const ihdr = new Uint8Array(13);
  writeUint32BE(ihdr, 0, width);
  writeUint32BE(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Raw image data with a per-row filter byte (0 = none).
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type
    raw.set(rgba.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const idatData = new Uint8Array(deflateSync(raw));

  const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const parts = [
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idatData),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
