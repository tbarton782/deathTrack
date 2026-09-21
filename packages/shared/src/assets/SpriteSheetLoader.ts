/**
 * Sprite-sheet loader for the Deathtrack asset pipeline.
 *
 * The original game stores sprites in `.BLK` files: many small indexed-colour
 * "blocks" (car frames, scenery tiles, HUD glyphs, …) whose pixel bytes index
 * into a 256-colour palette (see the tools-package `BlkParser` / `PalParser`).
 * The build-time asset pipeline decodes those files into a plain binary bundle
 * and ships it with the web build. This loader takes such a bundle plus a
 * palette and produces the two artefacts the client renderer needs:
 *
 *  1. A **PixiJS-compatible atlas JSON** ({@link SpriteAtlas}). Its shape mirrors
 *     the object PixiJS v8's `Spritesheet` accepts: a `frames` map keyed by
 *     block name, each with a `frame` rectangle, `sourceSize`, and
 *     `spriteSourceSize`, plus a `meta` block carrying the packed texture size.
 *     The client hands this object — together with a `PIXI.Texture` built from
 *     the pixel buffer below — to `new PIXI.Spritesheet(...)`.
 *
 *  2. A packed **RGBA pixel buffer** (`Uint8ClampedArray`, length `w × h × 4`)
 *     with the palette applied (opaque `alpha = 255`), laid out row-major to
 *     match the DOM `ImageData` constructor and WebGL `RGBA`/`UNSIGNED_BYTE`
 *     texture uploads.
 *
 * This module is deliberately framework-light: it does **not** import
 * `pixi.js`, keeping `@deathtrack/shared` runtime-agnostic. It emits plain data
 * that the client wires into PixiJS.
 *
 * ## Packing strategy
 *
 * Blocks are packed into a single texture using a deterministic shelf (row)
 * layout: blocks are placed left-to-right in the file order emitted by the
 * pipeline; when the next block would exceed `maxWidth`, a new shelf begins
 * below the tallest block of the previous shelf. The packed texture width is
 * the widest row actually used, and the height is the sum of shelf heights.
 * A 0-block bundle yields a 0×0 atlas. This layout is stable across runs, which
 * keeps the emitted atlas reproducible.
 *
 * Requirements: 2.6, 9.1
 */

// ---------------------------------------------------------------------------
// Input shape (the pipeline's `.BLK`-derived bundle)
// ---------------------------------------------------------------------------

/**
 * A single decoded sprite block from the asset bundle.
 *
 * Mirrors the `SpriteBlock` shape produced by the tools-package `BlkParser`
 * without importing from `tools` (shared must not depend on tools). `pixels`
 * is a row-major array of palette indices, length `width × height`.
 */
export interface SpriteSheetBlock {
  /** Block width in pixels (>= 1). */
  width: number;
  /** Block height in pixels (>= 1). */
  height: number;
  /** Row-major palette indices, length `width × height`. */
  pixels: Uint8Array | Uint8ClampedArray | number[];
  /**
   * Optional stable name for the block's atlas frame. When omitted, the frame
   * is named `block_<i>` using the block's position in the bundle.
   */
  name?: string;
}

/**
 * The `.BLK`-derived sprite bundle the asset pipeline emits: an ordered list of
 * blocks. This is a plain data shape, intentionally decoupled from the parser.
 */
export interface SpriteSheetBundle {
  /** All blocks, in bundle (file) order. */
  blocks: SpriteSheetBlock[];
}

/**
 * A 256-colour palette. `rgb` is a flat byte array laid out
 * `[r0, g0, b0, r1, g1, b1, …]`, matching the tools-package `PaletteData.rgb`
 * and the palette-lookup shader's expected format. At least `256 × 3 = 768`
 * bytes must be present.
 */
export interface SpritePalette {
  /** Flat RGB byte array, length >= `256 × 3 = 768`, channels in 0–255. */
  rgb: Uint8Array | Uint8ClampedArray | number[];
}

// ---------------------------------------------------------------------------
// Output shape (PixiJS-compatible atlas + packed pixels)
// ---------------------------------------------------------------------------

/** An axis-aligned rectangle within the packed texture. */
export interface AtlasRect {
  /** Left edge, in packed-texture pixels. */
  x: number;
  /** Top edge, in packed-texture pixels. */
  y: number;
  /** Width in pixels. */
  w: number;
  /** Height in pixels. */
  h: number;
}

/** A width/height size pair. */
export interface AtlasSize {
  w: number;
  h: number;
}

/**
 * A single frame entry in the atlas, matching the fields PixiJS reads from a
 * spritesheet-data `frames[name]` object.
 */
export interface AtlasFrame {
  /** The frame's rectangle within the packed texture. */
  frame: AtlasRect;
  /** Whether the source sprite was trimmed. Always `false` here. */
  trimmed: boolean;
  /** Whether the frame is rotated 90° in the atlas. Always `false` here. */
  rotated: boolean;
  /** The frame's position/size within its (untrimmed) source sprite. */
  spriteSourceSize: AtlasRect;
  /** The original source sprite size. */
  sourceSize: AtlasSize;
}

/**
 * Atlas metadata, matching the `meta` block PixiJS reads from spritesheet data.
 */
export interface AtlasMeta {
  /** Packed-texture size; equals the packed RGBA buffer's dimensions. */
  size: AtlasSize;
  /** Texture scale factor as a string, per the PixiJS convention. */
  scale: string;
  /** App identifier stamped into the emitted atlas. */
  app: string;
}

/**
 * A PixiJS-`Spritesheet`-compatible atlas description. Pass this object as the
 * `data` argument to `new PIXI.Spritesheet(texture, data)` on the client, where
 * `texture` is built from {@link SpriteSheetLoadResult.pixels}.
 */
export interface SpriteAtlas {
  /** Frame table keyed by block name. */
  frames: Record<string, AtlasFrame>;
  /** Packed-texture metadata. */
  meta: AtlasMeta;
}

/** The pair of artefacts produced by {@link loadSpriteSheet}. */
export interface SpriteSheetLoadResult {
  /** PixiJS-compatible atlas JSON (frames + meta). */
  atlas: SpriteAtlas;
  /**
   * Packed RGBA pixels with the palette applied (opaque). Row-major, length
   * `meta.size.w × meta.size.h × 4`. For an empty bundle this is a length-0
   * array.
   */
  pixels: Uint8ClampedArray;
}

/** Options controlling atlas packing. */
export interface SpriteSheetLoadOptions {
  /**
   * Maximum packed-texture width in pixels before wrapping to a new shelf.
   * Defaults to {@link DEFAULT_MAX_ATLAS_WIDTH}. A single block wider than this
   * value is still placed on its own shelf (the packed width then grows to fit
   * it).
   */
  maxWidth?: number;
  /** Value stamped into `meta.app`. Defaults to `'deathtrack'`. */
  app?: string;
}

/** Number of RGB bytes required for a full 256-colour palette. */
export const PALETTE_RGB_BYTE_LENGTH = 256 * 3;

/** Default maximum packed-texture width. A power of two suits GPU textures. */
export const DEFAULT_MAX_ATLAS_WIDTH = 1024;

/**
 * Raised when a sprite bundle or palette cannot be turned into an atlas.
 */
export class SpriteSheetLoadError extends Error {
  constructor(message: string) {
    super(`SpriteSheetLoader: ${message}`);
    this.name = 'SpriteSheetLoadError';
  }
}

/** A block plus its resolved placement within the packed texture. */
interface Placement {
  block: SpriteSheetBlock;
  name: string;
  x: number;
  y: number;
}

/**
 * Compute deterministic shelf placements for every block and the resulting
 * packed-texture size.
 */
function packBlocks(
  blocks: SpriteSheetBlock[],
  maxWidth: number,
): { placements: Placement[]; size: AtlasSize } {
  const placements: Placement[] = [];

  let cursorX = 0;
  let shelfY = 0;
  let shelfHeight = 0;
  let usedWidth = 0;

  blocks.forEach((block, i) => {
    // Wrap to a new shelf when this block would overflow the current row.
    // A block placed at x = 0 never wraps, so blocks wider than maxWidth still
    // fit on their own shelf (and grow the packed width).
    if (cursorX > 0 && cursorX + block.width > maxWidth) {
      shelfY += shelfHeight;
      cursorX = 0;
      shelfHeight = 0;
    }

    const name = block.name ?? `block_${i}`;
    placements.push({ block, name, x: cursorX, y: shelfY });

    cursorX += block.width;
    if (cursorX > usedWidth) usedWidth = cursorX;
    if (block.height > shelfHeight) shelfHeight = block.height;
  });

  const totalHeight = shelfY + shelfHeight;
  return { placements, size: { w: usedWidth, h: totalHeight } };
}

/**
 * Validate a block's shape and return its expected pixel count.
 * @throws {SpriteSheetLoadError} If dimensions or pixel length are invalid.
 */
function validateBlock(block: SpriteSheetBlock, index: number): number {
  const { width, height, pixels } = block;
  if (!Number.isInteger(width) || width < 1) {
    throw new SpriteSheetLoadError(`block ${index} has invalid width ${width}`);
  }
  if (!Number.isInteger(height) || height < 1) {
    throw new SpriteSheetLoadError(`block ${index} has invalid height ${height}`);
  }
  const expected = width * height;
  if (pixels.length !== expected) {
    throw new SpriteSheetLoadError(
      `block ${index} pixel count ${pixels.length} does not match ${width}×${height} = ${expected}`,
    );
  }
  return expected;
}

/**
 * Decode a `.BLK`-derived sprite bundle into a PixiJS-compatible atlas plus a
 * palette-applied RGBA pixel buffer.
 *
 * Each block's palette indices are looked up in `palette.rgb` and written into
 * the packed texture at the block's atlas rectangle with `alpha = 255`. Pixels
 * of the packed texture not covered by any block remain fully transparent
 * (all-zero RGBA).
 *
 * @param bundle  The pipeline's `.BLK`-derived sprite bundle.
 * @param palette The 256-colour palette (>= `256 × 3` RGB bytes).
 * @param options Optional packing controls.
 * @returns The {@link SpriteSheetLoadResult}: atlas JSON + packed RGBA pixels.
 * @throws {SpriteSheetLoadError} If the palette is too small, a block's
 *   dimensions are invalid, or a block's pixel length is inconsistent.
 *
 * Requirements: 2.6, 9.1
 */
export function loadSpriteSheet(
  bundle: SpriteSheetBundle,
  palette: SpritePalette,
  options: SpriteSheetLoadOptions = {},
): SpriteSheetLoadResult {
  if (palette.rgb.length < PALETTE_RGB_BYTE_LENGTH) {
    throw new SpriteSheetLoadError(
      `palette too small: expected at least ${PALETTE_RGB_BYTE_LENGTH} RGB bytes but got ${palette.rgb.length}`,
    );
  }

  const maxWidth = options.maxWidth ?? DEFAULT_MAX_ATLAS_WIDTH;
  if (!Number.isInteger(maxWidth) || maxWidth < 1) {
    throw new SpriteSheetLoadError(`maxWidth must be a positive integer, got ${maxWidth}`);
  }
  const app = options.app ?? 'deathtrack';

  const blocks = bundle.blocks;
  blocks.forEach((block, i) => validateBlock(block, i));

  const { placements, size } = packBlocks(blocks, maxWidth);

  // Allocate the packed RGBA buffer (fully transparent by default).
  const pixels = new Uint8ClampedArray(size.w * size.h * 4);
  const rgb = palette.rgb;

  const frames: Record<string, AtlasFrame> = {};

  for (const { block, name, x, y } of placements) {
    // Blit the block's palette-expanded pixels into the packed buffer.
    for (let row = 0; row < block.height; row += 1) {
      const srcRowStart = row * block.width;
      const dstRowStart = ((y + row) * size.w + x) * 4;
      for (let col = 0; col < block.width; col += 1) {
        const paletteIndex = block.pixels[srcRowStart + col] as number;
        const src = paletteIndex * 3;
        const dst = dstRowStart + col * 4;
        pixels[dst] = rgb[src] as number;
        pixels[dst + 1] = rgb[src + 1] as number;
        pixels[dst + 2] = rgb[src + 2] as number;
        pixels[dst + 3] = 255;
      }
    }

    if (frames[name] !== undefined) {
      throw new SpriteSheetLoadError(`duplicate frame name "${name}"`);
    }

    frames[name] = {
      frame: { x, y, w: block.width, h: block.height },
      trimmed: false,
      rotated: false,
      spriteSourceSize: { x: 0, y: 0, w: block.width, h: block.height },
      sourceSize: { w: block.width, h: block.height },
    };
  }

  const atlas: SpriteAtlas = {
    frames,
    meta: {
      size: { w: size.w, h: size.h },
      scale: '1',
      app,
    },
  };

  return { atlas, pixels };
}

/**
 * Namespaced facade for the sprite-sheet loader, mirroring the design's
 * `SpriteSheetLoader` reference. Prefer importing {@link loadSpriteSheet}
 * directly; this object exists for call sites that want a named handle.
 */
export const SpriteSheetLoader = {
  load: loadSpriteSheet,
} as const;
