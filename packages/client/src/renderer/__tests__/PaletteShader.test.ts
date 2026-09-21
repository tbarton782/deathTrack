import { describe, expect, it } from 'vitest';
import { Texture } from 'pixi.js';
import type { SpritePalette } from '@deathtrack/shared';
import {
  buildPaletteFilterOptions,
  buildPaletteTextureData,
  createPaletteTexture,
  indexedPaletteFragment,
  nearestPaletteFragment,
  paletteFragmentSource,
  paletteVertex,
  uploadPaletteInto,
  PALETTE_SIZE,
  PALETTE_TEXTURE_BYTE_LENGTH,
  PALETTE_TEXTURE_HEIGHT,
  PALETTE_TEXTURE_WIDTH,
} from '../PaletteShader';

/**
 * These tests exercise only the GPU-free parts of the palette shader: the
 * palette texture byte layout, the shader source generation, and the fact that
 * the PixiJS Filter/Texture objects construct without a live WebGL context
 * (upload is deferred until first render). The actual per-pixel palette lookup
 * runs on the GPU and is validated in the browser.
 *
 * Validates: Requirements 2.6 (256-colour indexed palette / nearest
 * approximation).
 */

/** A recognisable 256-entry RGB palette: entry i = (i, 255-i, i/2). */
function makePalette(): SpritePalette {
  const rgb = new Uint8Array(PALETTE_SIZE * 3);
  for (let i = 0; i < PALETTE_SIZE; i += 1) {
    rgb[i * 3] = i & 0xff;
    rgb[i * 3 + 1] = (255 - i) & 0xff;
    rgb[i * 3 + 2] = (i >> 1) & 0xff;
  }
  return { rgb };
}

describe('buildPaletteTextureData', () => {
  it('produces exactly 256*4 = 1024 RGBA bytes', () => {
    const data = buildPaletteTextureData(makePalette());
    expect(data).toBeInstanceOf(Uint8Array);
    expect(data.length).toBe(PALETTE_TEXTURE_BYTE_LENGTH);
    expect(PALETTE_TEXTURE_BYTE_LENGTH).toBe(256 * 4);
  });

  it('maps each palette index to its RGB triple with opaque alpha', () => {
    const data = buildPaletteTextureData(makePalette());
    for (let i = 0; i < PALETTE_SIZE; i += 1) {
      const o = i * 4;
      expect(data[o]).toBe(i & 0xff); // R
      expect(data[o + 1]).toBe((255 - i) & 0xff); // G
      expect(data[o + 2]).toBe((i >> 1) & 0xff); // B
      expect(data[o + 3]).toBe(255); // A (opaque)
    }
  });

  it('zero-pads (opaque black) palettes shorter than 256 entries', () => {
    const rgb = new Uint8Array(3 * 4); // only 4 entries
    rgb.set([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
    const data = buildPaletteTextureData({ rgb });
    expect(data.length).toBe(PALETTE_TEXTURE_BYTE_LENGTH);
    // First entry preserved.
    expect([data[0], data[1], data[2], data[3]]).toEqual([10, 20, 30, 255]);
    // A late, missing entry is opaque black.
    const o = 200 * 4;
    expect([data[o], data[o + 1], data[o + 2], data[o + 3]]).toEqual([0, 0, 0, 255]);
  });

  it('truncates palettes longer than 256 entries', () => {
    const rgb = new Uint8Array(300 * 3).fill(7);
    const data = buildPaletteTextureData({ rgb });
    expect(data.length).toBe(PALETTE_TEXTURE_BYTE_LENGTH);
  });

  it('accepts number[] and Uint8ClampedArray palettes', () => {
    const arr = Array.from({ length: 256 * 3 }, (_, i) => i & 0xff);
    const fromArray = buildPaletteTextureData({ rgb: arr });
    const fromClamped = buildPaletteTextureData({
      rgb: Uint8ClampedArray.from(arr),
    });
    expect(fromArray).toEqual(fromClamped);
    expect(fromArray[0]).toBe(0);
    expect(fromArray[4]).toBe(3); // second entry R = index 3 in flat rgb
  });
});

describe('palette dimensions', () => {
  it('describes a 256x1 lookup texture', () => {
    expect(PALETTE_TEXTURE_WIDTH).toBe(256);
    expect(PALETTE_TEXTURE_HEIGHT).toBe(1);
    expect(PALETTE_SIZE).toBe(256);
  });
});

describe('shader sources', () => {
  it('shares a full-screen filter vertex shader', () => {
    expect(paletteVertex).toContain('aPosition');
    expect(paletteVertex).toContain('vTextureCoord');
    expect(paletteVertex).toContain('gl_Position');
  });

  it('indexed fragment samples the palette by red-channel index', () => {
    expect(indexedPaletteFragment).toContain('uPalette');
    expect(indexedPaletteFragment).toContain('uTexture');
    // Index recovered from normalised red channel.
    expect(indexedPaletteFragment).toContain('indexed.r * 255.0');
    // Preserves source alpha.
    expect(indexedPaletteFragment).toContain('indexed.a');
  });

  it('nearest fragment scans all 256 palette entries', () => {
    expect(nearestPaletteFragment).toContain('uPalette');
    expect(nearestPaletteFragment).toContain('i < 256');
  });

  it('paletteFragmentSource selects source by mode', () => {
    expect(paletteFragmentSource('indexed')).toBe(indexedPaletteFragment);
    expect(paletteFragmentSource('nearest')).toBe(nearestPaletteFragment);
    // Default (via createPaletteFilter) is indexed.
    expect(paletteFragmentSource('indexed')).not.toBe(nearestPaletteFragment);
  });
});

describe('createPaletteTexture', () => {
  it('constructs a Texture without a WebGL context', () => {
    const tex = createPaletteTexture(makePalette());
    expect(tex).toBeInstanceOf(Texture);
    // The backing buffer holds the palette bytes.
    const resource = tex.source.resource as Uint8Array;
    expect(resource.length).toBe(PALETTE_TEXTURE_BYTE_LENGTH);
    expect(tex.source.width).toBe(256);
    expect(tex.source.height).toBe(1);
  });
});

describe('buildPaletteFilterOptions', () => {
  it('produces GLSL sources and a palette texture without a WebGL context', () => {
    const options = buildPaletteFilterOptions(makePalette());
    expect(options.paletteTexture).toBeInstanceOf(Texture);
    expect(options.glProgram.vertex).toBe(paletteVertex);
    expect(typeof options.glProgram.name).toBe('string');
  });

  it('binds the palette texture source as the uPalette resource', () => {
    const options = buildPaletteFilterOptions(makePalette());
    expect(options.resources.uPalette).toBe(options.paletteTexture.source);
  });

  it('defaults to the indexed lookup program', () => {
    const options = buildPaletteFilterOptions(makePalette());
    expect(options.glProgram.fragment).toBe(indexedPaletteFragment);
    expect(options.glProgram.name).toBe('palette-indexed');
  });

  it('supports the nearest-approximation program', () => {
    const options = buildPaletteFilterOptions(makePalette(), 'nearest');
    expect(options.glProgram.fragment).toBe(nearestPaletteFragment);
    expect(options.glProgram.name).toBe('palette-nearest');
  });
});

describe('uploadPaletteInto', () => {
  it('re-uploads into the same texture buffer without reallocating', () => {
    const texture = createPaletteTexture(makePalette());
    const resource = texture.source.resource as Uint8Array;
    // Original entry 1 R channel = 1.
    expect(resource[4]).toBe(1);

    const solid: SpritePalette = { rgb: new Uint8Array(256 * 3).fill(99) };
    uploadPaletteInto(texture, solid);

    // Same buffer instance (no reallocation), contents updated.
    expect(texture.source.resource).toBe(resource);
    expect(resource[0]).toBe(99);
    expect(resource[4]).toBe(99);
    // Alpha channel remains opaque.
    expect(resource[3]).toBe(255);
  });
});
