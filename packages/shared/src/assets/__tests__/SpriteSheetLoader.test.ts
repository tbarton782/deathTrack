/**
 * Unit and property tests for {@link loadSpriteSheet}.
 *
 * Verifies that blocks are packed into an atlas with correct frame rectangles,
 * that RGBA expansion applies the palette with opaque alpha, that `meta.size`
 * matches the packed dimensions, and that malformed inputs are rejected.
 *
 * Requirements: 2.6, 9.1
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  loadSpriteSheet,
  SpriteSheetLoader,
  SpriteSheetLoadError,
  PALETTE_RGB_BYTE_LENGTH,
  DEFAULT_MAX_ATLAS_WIDTH,
  type SpriteSheetBundle,
  type SpritePalette,
} from '../SpriteSheetLoader.js';

/** Build a 256-colour palette where index i -> (r,g,b) via `fn`. */
function buildPalette(fn: (i: number) => [number, number, number]): SpritePalette {
  const rgb = new Uint8Array(PALETTE_RGB_BYTE_LENGTH);
  for (let i = 0; i < 256; i += 1) {
    const [r, g, b] = fn(i);
    rgb[i * 3] = r;
    rgb[i * 3 + 1] = g;
    rgb[i * 3 + 2] = b;
  }
  return { rgb };
}

/** Palette: index i -> (i, (2*i)&255, (3*i)&255). */
const rampPalette = buildPalette((i) => [i, (2 * i) & 255, (3 * i) & 255]);

/** Read the RGBA quad at (x,y) from a packed buffer of width `w`. */
function pixelAt(
  pixels: Uint8ClampedArray,
  w: number,
  x: number,
  y: number,
): [number, number, number, number] {
  const o = (y * w + x) * 4;
  return [pixels[o]!, pixels[o + 1]!, pixels[o + 2]!, pixels[o + 3]!];
}

describe('loadSpriteSheet packing', () => {
  it('packs a single block into a 1-shelf atlas with a matching frame rect', () => {
    const bundle: SpriteSheetBundle = {
      blocks: [{ width: 2, height: 3, pixels: new Uint8Array([1, 2, 3, 4, 5, 6]) }],
    };

    const { atlas, pixels } = loadSpriteSheet(bundle, rampPalette);

    expect(atlas.meta.size).toEqual({ w: 2, h: 3 });
    expect(pixels.length).toBe(2 * 3 * 4);
    const f0 = atlas.frames.block_0!;
    expect(f0.frame).toEqual({ x: 0, y: 0, w: 2, h: 3 });
    expect(f0.sourceSize).toEqual({ w: 2, h: 3 });
    expect(f0.spriteSourceSize).toEqual({ x: 0, y: 0, w: 2, h: 3 });
    expect(f0.trimmed).toBe(false);
    expect(f0.rotated).toBe(false);
  });

  it('places blocks left-to-right on one shelf until maxWidth is exceeded', () => {
    const bundle: SpriteSheetBundle = {
      blocks: [
        { width: 4, height: 2, pixels: new Uint8Array(8) },
        { width: 4, height: 3, pixels: new Uint8Array(12) },
        { width: 4, height: 1, pixels: new Uint8Array(4) },
      ],
    };

    // maxWidth 8 fits two blocks per shelf; the third wraps.
    const { atlas } = loadSpriteSheet(bundle, rampPalette, { maxWidth: 8 });

    expect(atlas.frames.block_0!.frame).toMatchObject({ x: 0, y: 0 });
    expect(atlas.frames.block_1!.frame).toMatchObject({ x: 4, y: 0 });
    // Shelf 0 height is max(2, 3) = 3, so the third block starts at y = 3.
    expect(atlas.frames.block_2!.frame).toMatchObject({ x: 0, y: 3 });
    // Packed width is the widest used row (8); height is 3 + 1 = 4.
    expect(atlas.meta.size).toEqual({ w: 8, h: 4 });
  });

  it('places a block wider than maxWidth on its own shelf and grows the width', () => {
    const bundle: SpriteSheetBundle = {
      blocks: [
        { width: 3, height: 2, pixels: new Uint8Array(6) },
        { width: 10, height: 2, pixels: new Uint8Array(20) },
      ],
    };

    const { atlas } = loadSpriteSheet(bundle, rampPalette, { maxWidth: 8 });

    expect(atlas.frames.block_0!.frame).toMatchObject({ x: 0, y: 0 });
    expect(atlas.frames.block_1!.frame).toMatchObject({ x: 0, y: 2 });
    expect(atlas.meta.size).toEqual({ w: 10, h: 4 });
  });

  it('honours explicit block names and stamps meta.app', () => {
    const bundle: SpriteSheetBundle = {
      blocks: [{ width: 1, height: 1, pixels: new Uint8Array([0]), name: 'hellcat_0' }],
    };

    const { atlas } = loadSpriteSheet(bundle, rampPalette, { app: 'unit-test' });

    expect(Object.keys(atlas.frames)).toEqual(['hellcat_0']);
    expect(atlas.meta.app).toBe('unit-test');
    expect(atlas.meta.scale).toBe('1');
  });

  it('returns a 0×0 atlas and empty pixels for an empty bundle', () => {
    const { atlas, pixels } = loadSpriteSheet({ blocks: [] }, rampPalette);
    expect(atlas.meta.size).toEqual({ w: 0, h: 0 });
    expect(atlas.frames).toEqual({});
    expect(pixels.length).toBe(0);
  });

  it('exposes the SpriteSheetLoader facade', () => {
    const result = SpriteSheetLoader.load({ blocks: [] }, rampPalette);
    expect(result.atlas.meta.size).toEqual({ w: 0, h: 0 });
  });
});

describe('loadSpriteSheet palette application', () => {
  it('expands palette indices to opaque RGBA at the correct atlas position', () => {
    // 2x2 block, indices [10, 20, 30, 40] row-major.
    const bundle: SpriteSheetBundle = {
      blocks: [{ width: 2, height: 2, pixels: new Uint8Array([10, 20, 30, 40]) }],
    };
    const { atlas, pixels } = loadSpriteSheet(bundle, rampPalette);
    const w = atlas.meta.size.w;

    expect(pixelAt(pixels, w, 0, 0)).toEqual([10, 20, 30, 255]);
    expect(pixelAt(pixels, w, 1, 0)).toEqual([20, 40, 60, 255]);
    expect(pixelAt(pixels, w, 0, 1)).toEqual([30, 60, 90, 255]);
    expect(pixelAt(pixels, w, 1, 1)).toEqual([40, 80, 120, 255]);
  });

  it('applies index 255 (top palette entry) correctly', () => {
    const palette = buildPalette((i) => (i === 255 ? [7, 8, 9] : [0, 0, 0]));
    const bundle: SpriteSheetBundle = {
      blocks: [{ width: 1, height: 1, pixels: new Uint8Array([255]) }],
    };
    const { pixels } = loadSpriteSheet(bundle, palette);
    expect(Array.from(pixels)).toEqual([7, 8, 9, 255]);
  });

  it('leaves uncovered packed pixels fully transparent', () => {
    // Two blocks of differing heights on one shelf leave a gap under the
    // shorter one that must stay transparent (all-zero RGBA).
    const bundle: SpriteSheetBundle = {
      blocks: [
        { width: 1, height: 1, pixels: new Uint8Array([100]) },
        { width: 1, height: 2, pixels: new Uint8Array([50, 60]) },
      ],
    };
    const { atlas, pixels } = loadSpriteSheet(bundle, rampPalette, { maxWidth: 8 });
    const w = atlas.meta.size.w;

    // Block 0 covers (0,0); (0,1) below it is uncovered.
    expect(pixelAt(pixels, w, 0, 0)[3]).toBe(255);
    expect(pixelAt(pixels, w, 0, 1)).toEqual([0, 0, 0, 0]);
  });
});

describe('loadSpriteSheet validation', () => {
  it('rejects a palette smaller than 256×3 bytes', () => {
    const small: SpritePalette = { rgb: new Uint8Array(PALETTE_RGB_BYTE_LENGTH - 1) };
    expect(() => loadSpriteSheet({ blocks: [] }, small)).toThrow(SpriteSheetLoadError);
  });

  it('rejects a block whose pixel length disagrees with its dimensions', () => {
    const bundle: SpriteSheetBundle = {
      blocks: [{ width: 2, height: 2, pixels: new Uint8Array(3) }],
    };
    expect(() => loadSpriteSheet(bundle, rampPalette)).toThrow(/pixel count/);
  });

  it('rejects invalid dimensions', () => {
    expect(() =>
      loadSpriteSheet({ blocks: [{ width: 0, height: 1, pixels: new Uint8Array(0) }] }, rampPalette),
    ).toThrow(SpriteSheetLoadError);
  });

  it('rejects duplicate frame names', () => {
    const bundle: SpriteSheetBundle = {
      blocks: [
        { width: 1, height: 1, pixels: new Uint8Array([0]), name: 'dup' },
        { width: 1, height: 1, pixels: new Uint8Array([0]), name: 'dup' },
      ],
    };
    expect(() => loadSpriteSheet(bundle, rampPalette)).toThrow(/duplicate frame/);
  });

  it('rejects a non-positive maxWidth', () => {
    expect(() => loadSpriteSheet({ blocks: [] }, rampPalette, { maxWidth: 0 })).toThrow(
      SpriteSheetLoadError,
    );
  });
});

describe('loadSpriteSheet properties', () => {
  it('every packed pixel is opaque and equals its source palette colour', () => {
    fc.assert(
      fc.property(
        // Up to 6 blocks, each up to 5x5, palette indices 0..255.
        fc.array(
          fc.record({
            width: fc.integer({ min: 1, max: 5 }),
            height: fc.integer({ min: 1, max: 5 }),
          }),
          { minLength: 1, maxLength: 6 },
        ),
        fc.integer({ min: 1, max: 16 }),
        (dims, maxWidth) => {
          const blocks = dims.map((d) => {
            const pixels = new Uint8Array(d.width * d.height);
            for (let i = 0; i < pixels.length; i += 1) pixels[i] = (i * 7) & 255;
            return { width: d.width, height: d.height, pixels };
          });

          const { atlas, pixels } = loadSpriteSheet({ blocks }, rampPalette, { maxWidth });
          const w = atlas.meta.size.w;

          // Frames never exceed the packed texture bounds.
          for (const name of Object.keys(atlas.frames)) {
            const f = atlas.frames[name]!.frame;
            expect(f.x + f.w).toBeLessThanOrEqual(atlas.meta.size.w);
            expect(f.y + f.h).toBeLessThanOrEqual(atlas.meta.size.h);
          }

          // Each block's covered pixels are opaque and palette-correct.
          blocks.forEach((block, bi) => {
            const f = atlas.frames[`block_${bi}`]!.frame;
            for (let row = 0; row < block.height; row += 1) {
              for (let col = 0; col < block.width; col += 1) {
                const idx = block.pixels[row * block.width + col]!;
                const [r, g, b, a] = pixelAt(pixels, w, f.x + col, f.y + row);
                expect(r).toBe(idx);
                expect(g).toBe((2 * idx) & 255);
                expect(b).toBe((3 * idx) & 255);
                expect(a).toBe(255);
              }
            }
          });
        },
      ),
    );
  });

  it('packed buffer length always equals meta.size w*h*4', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            width: fc.integer({ min: 1, max: 8 }),
            height: fc.integer({ min: 1, max: 8 }),
          }),
          { maxLength: 8 },
        ),
        (dims) => {
          const blocks = dims.map((d) => ({
            width: d.width,
            height: d.height,
            pixels: new Uint8Array(d.width * d.height),
          }));
          const { atlas, pixels } = loadSpriteSheet({ blocks }, rampPalette);
          expect(pixels.length).toBe(atlas.meta.size.w * atlas.meta.size.h * 4);
        },
      ),
    );
  });
});

describe('constants', () => {
  it('exposes palette + default width constants', () => {
    expect(PALETTE_RGB_BYTE_LENGTH).toBe(768);
    expect(DEFAULT_MAX_ATLAS_WIDTH).toBeGreaterThan(0);
  });
});
