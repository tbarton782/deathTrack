// Vertical-slice runner for Death Track SCR images.
//
// Decodes the ACTIVISI palette container and one .SCR image from the original
// game folder through chunk -> LZW -> 160x200 indices -> palette, and writes a
// PNG so the result can be inspected. Prints diagnostics about the real chunk
// tree and decompressed size along the way.
//
// The real 256-colour palette that maps SCR indices to RGB is not present in
// the accessible data files (only 16-colour EGA/CGA blocks); until it is
// recovered (task 25.4) this renders with a faithful greyscale palette. Pass a
// 4th arg "double" to emit the 320x200 pixel-doubled display image.
//
// Usage: node slice.mjs <dtrackDir> <scrFileName> <outDir> [double]

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { parseChunks, findChunk } from './dist/parsers/ChunkReader.js';
import { parseCompressedLeaf } from './dist/parsers/decompress.js';
import { decodePalContainer } from './dist/parsers/PaletteDecoder.js';
import {
  decodeScr,
  applyPalette,
  grayscalePalette,
  SCREEN_WIDTH,
  SCREEN_HEIGHT,
} from './dist/parsers/ScrDecoder.js';
import { encodePng } from './dist/parsers/png.js';

const hex = (u8, n = 16) =>
  Array.from(u8.subarray(0, n))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');

function dumpTree(nodes, depth = 0) {
  for (const n of nodes) {
    const pad = '  '.repeat(depth);
    console.log(
      `${pad}${n.id} container=${n.isContainer} len=${n.length} off=${n.offset} first=[${hex(n.data, 8)}]`,
    );
    if (n.children.length) dumpTree(n.children, depth + 1);
  }
}

async function main() {
  const [dtrackDir, scrName, outDir, doubleArg] = process.argv.slice(2);
  if (!dtrackDir || !scrName || !outDir) {
    console.error('Usage: node slice.mjs <dtrackDir> <scrFileName> <outDir> [double]');
    process.exit(2);
  }
  const doubleWidth = doubleArg === 'double';
  await fs.mkdir(outDir, { recursive: true });

  // ---- Palette container (ACTIVISI) ----
  const activisi = new Uint8Array(await fs.readFile(path.join(dtrackDir, 'ACTIVISI')));
  console.log(`\n===== ACTIVISI (${activisi.length} bytes) =====`);
  dumpTree(parseChunks(activisi));
  const pal = decodePalContainer(activisi);
  console.log(
    `palette sub-blocks: vga=${pal.vga ? pal.vga.count : 'none'} ega=${pal.egaRaw ? pal.egaRaw.length : 'none'} cga=${pal.cgaRaw ? pal.cgaRaw.length : 'none'}`,
  );

  // ---- SCR image ----
  const scr = new Uint8Array(await fs.readFile(path.join(dtrackDir, scrName)));
  console.log(`\n===== ${scrName} (${scr.length} bytes) =====`);
  const scrTree = parseChunks(scr);
  dumpTree(scrTree);
  const bin = findChunk(scrTree, 'BIN');
  if (bin) {
    const leaf = parseCompressedLeaf(bin.data);
    console.log(
      `BIN leaf: method=0x${leaf.type.toString(16).padStart(2, '0')} decompressedSize=${leaf.decompressedSize} compressedBytes=${leaf.data.length}`,
    );
  }

  const image = decodeScr(scr, doubleWidth);
  console.log(
    `decoded ${image.width}x${image.height} (${image.indices.length} px); native ${SCREEN_WIDTH}x${SCREEN_HEIGHT}`,
  );

  // Palette: prefer a real VGA palette, then the recovered 16-colour EGA
  // palette (logical -> hardware remap from the EGA: block), then a greyscale
  // luminance preview.
  const palette = pal.vga ?? pal.ega ?? grayscalePalette();
  console.log(
    pal.vga ? '[info] using VGA: palette' : pal.ega ? '[info] using recovered EGA palette' : '[info] using greyscale preview palette',
  );

  const rgba = applyPalette(image, palette);
  const png = encodePng(image.width, image.height, rgba);
  const outName = `${path.parse(scrName).name}${doubleWidth ? '_320x200' : ''}.png`;
  const outPath = path.join(outDir, outName);
  await fs.writeFile(outPath, png);
  console.log(`\nWrote ${outPath} (${png.length} bytes, ${image.width}x${image.height})`);

  const hist = new Map();
  for (const v of image.indices) hist.set(v, (hist.get(v) ?? 0) + 1);
  console.log(`index histogram: ${hist.size} distinct values`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
