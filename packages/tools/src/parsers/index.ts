/**
 * Public API surface for the Deathtrack asset parsers in `@deathtrack/tools`.
 *
 * Re-exports each dedicated original-file parser so consumers can import from a
 * single entry point.
 *
 * Requirements: 10.1
 */

export {
  parseMus,
  toOggStub,
  convertMusToOggStub,
  MusParseError,
} from './MusParser.js';

export type {
  OplEvent,
  MusSequence,
  MusParseOptions,
  OggStub,
} from './MusParser.js';

export { parseTrack, TrkParseError, TRK_MAGIC, TRK_VERSION } from './TrkParser.js';

export type { TrackData } from './TrkParser.js';

export { parseScr, applyPalette, parseScrToRgba, ScreenParseError } from './ScrParser.js';

export type { ScreenImage } from './ScrParser.js';

// --- Section 25: real Dynamix RES format decoders (verified against dtrack) ---

export { parseChunks, findChunk, ChunkParseError, CHUNK_HEADER_SIZE } from './ChunkReader.js';
export type { ChunkNode } from './ChunkReader.js';

export {
  decompress,
  parseCompressedLeaf,
  rleDecompress,
  lzwDecompress,
  lh1Decompress,
  CompressionType,
  DecompressError,
} from './decompress.js';
export type { CompressedLeaf } from './decompress.js';

export {
  decodePalContainer,
  decodeVgaPalette,
  decodeEgaRemapPalette,
  egaPalette16,
  scale6to8,
  PaletteDecodeError,
} from './PaletteDecoder.js';
export type { Palette, PalContainer } from './PaletteDecoder.js';

export {
  decodeScr,
  decodeScreenBytes,
  decompressScrBin,
  doublePixelsHorizontally,
  grayscalePalette,
  ScrDecodeError,
  SCREEN_WIDTH as SCR_WIDTH,
  SCREEN_HEIGHT as SCR_HEIGHT,
  SCREEN_PIXELS as SCR_PIXELS,
  DISPLAY_WIDTH as SCR_DISPLAY_WIDTH,
} from './ScrDecoder.js';

export {
  decodeFnt,
  decodeFonts,
  glyphForCode,
  FntDecodeError,
  FNT_HEADER_SIZE,
} from './FntDecoder.js';
export type { Font, Glyph } from './FntDecoder.js';

export {
  decodeBmp,
  decodeBmpFile,
  parseInf,
  subImageToRgba,
  BmpDecodeError,
} from './BmpDecoder.js';
export type { SpriteSheet, SubImage, BmpInfo } from './BmpDecoder.js';

export {
  decodeTrk,
  trackIdForFilename,
  TRK_TAG,
  TRACK_ID_BY_FILENAME,
  TrkDecodeError,
} from './TrkDecoder.js';
// `TrackData` and `CenterlinePoint` are exported under aliases to avoid a clash
// with the legacy section-4 `TrkParser` `TrackData` type.
export type {
  TrackData as TrkTrackData,
  CenterlinePoint,
} from './TrkDecoder.js';

export { encodePng } from './png.js';
