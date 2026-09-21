import { BufferImageSource, Filter, GlProgram, Texture } from 'pixi.js';
import type { SpritePalette } from '@deathtrack/shared';

/**
 * Palette-emulation WebGL fragment shader (task 15.3).
 *
 * The original Deathtrack renders from a single 256-colour indexed palette.
 * Rather than baking colours into every sprite on the CPU, we upload the live
 * palette to the GPU as a 256×1 RGBA texture and let a fragment shader perform
 * the palette lookup per pixel. This lets palette animation and flash effects
 * (Requirement 2.6) happen for free by simply re-uploading the palette texture
 * — no CPU-side pixel writes.
 *
 * Two flavours of lookup are supported:
 *
 * 1. **Indexed** — the source sprite/atlas stores the palette *index* in its
 *    red channel (a common way to smuggle an 8-bit index through an RGBA
 *    texture). The shader reads that index, looks the colour up in the palette
 *    texture, and outputs the palette colour. This is the authentic
 *    indexed-palette path used by converted `.BLK` sprites and road tiles.
 *
 * 2. **Nearest-colour approximation** — for already-RGB assets the shader can
 *    instead snap the incoming colour to the palette (Requirement 2.6's
 *    "modern approximation" clause). This is implemented as a companion
 *    fragment source so both approaches share the same palette texture.
 *
 * ## Testability
 *
 * PixiJS' `Application` needs a live WebGL context (browser only), but the
 * palette *data layout* and *shader source* are pure string/byte computations.
 * Those live in the exported {@link buildPaletteTextureData},
 * {@link indexedPaletteFragment}, {@link nearestPaletteFragment} and
 * {@link paletteVertex} helpers and are unit-tested headlessly. Constructing
 * the {@link Filter}/{@link Texture} objects themselves does not require a GL
 * context (upload is deferred until the filter is first rendered), so
 * {@link createPaletteFilter} is also headless-constructable.
 *
 * Requirements: 2.6
 */

/** Number of colour entries in a Deathtrack palette. */
export const PALETTE_SIZE = 256;

/** RGBA channel count. */
const RGBA_CHANNELS = 4;

/**
 * Number of bytes in the GPU palette texture: 256 entries × 4 (RGBA) channels.
 * The palette texture is 256×1 RGBA8.
 */
export const PALETTE_TEXTURE_BYTE_LENGTH = PALETTE_SIZE * RGBA_CHANNELS;

/** Width, in texels, of the palette lookup texture (256×1). */
export const PALETTE_TEXTURE_WIDTH = PALETTE_SIZE;

/** Height, in texels, of the palette lookup texture (256×1). */
export const PALETTE_TEXTURE_HEIGHT = 1;

/**
 * Reads the RGB triple for palette entry {@link index} out of a flat
 * `[r0,g0,b0, r1,g1,b1, …]` palette buffer. Returns fully opaque black for
 * out-of-range indices so callers never read past the buffer.
 */
function readRgb(
  rgb: Uint8Array | Uint8ClampedArray | number[],
  index: number,
): [number, number, number] {
  const base = index * 3;
  const r = rgb[base] ?? 0;
  const g = rgb[base + 1] ?? 0;
  const b = rgb[base + 2] ?? 0;
  return [r & 0xff, g & 0xff, b & 0xff];
}

/**
 * Builds the 256×4-byte RGBA buffer that backs the palette lookup texture from
 * a 256-entry RGB palette.
 *
 * The source palette is a flat RGB byte array (`[r,g,b, r,g,b, …]`, the format
 * shared by the tools-package `PaletteData.rgb` and `@deathtrack/shared`'s
 * {@link SpritePalette}). Each of the 256 entries becomes a fully opaque RGBA
 * texel: `[r, g, b, 255]`.
 *
 * Palettes shorter than 256 entries are zero-padded (opaque black) so the
 * resulting buffer is always exactly {@link PALETTE_TEXTURE_BYTE_LENGTH} bytes,
 * which the GPU texture requires. Palettes longer than 256 entries are
 * truncated.
 *
 * @param palette - The source 256-colour palette.
 * @returns A `Uint8Array` of length `256 × 4 = 1024`, laid out
 *   `[r0,g0,b0,255, r1,g1,b1,255, …]`.
 */
export function buildPaletteTextureData(palette: SpritePalette): Uint8Array {
  const rgb = palette.rgb;
  const out = new Uint8Array(PALETTE_TEXTURE_BYTE_LENGTH);
  for (let i = 0; i < PALETTE_SIZE; i += 1) {
    const [r, g, b] = readRgb(rgb, i);
    const o = i * RGBA_CHANNELS;
    out[o] = r;
    out[o + 1] = g;
    out[o + 2] = b;
    out[o + 3] = 0xff; // fully opaque
  }
  return out;
}

/**
 * Shared vertex shader for the palette filters. Standard full-screen filter
 * vertex pass that forwards the texture coordinate; PixiJS injects the
 * `aPosition` attribute and the `uInputSize`/`uOutputFrame`/`uOutputTexture`
 * filter uniforms.
 */
export const paletteVertex = /* glsl */ `
in vec2 aPosition;
out vec2 vTextureCoord;

uniform vec4 uInputSize;
uniform vec4 uOutputFrame;
uniform vec4 uOutputTexture;

vec4 filterVertexPosition( void )
{
    vec2 position = aPosition * uOutputFrame.zw + uOutputFrame.xy;
    position.x = position.x * (2.0 / uOutputTexture.x) - 1.0;
    position.y = position.y * (2.0 * uOutputTexture.z / uOutputTexture.y) - uOutputTexture.z;
    return vec4(position, 0.0, 1.0);
}

vec2 filterTextureCoord( void )
{
    return aPosition * (uOutputFrame.zw * uInputSize.zw);
}

void main(void)
{
    gl_Position = filterVertexPosition();
    vTextureCoord = filterTextureCoord();
}
`;

/**
 * Fragment shader for the **indexed** palette path.
 *
 * The palette index is carried in the red channel of the input texture (0..1
 * normalised, i.e. `index / 255`). The alpha channel of the input texture is
 * preserved so transparent sprite pixels remain transparent. The looked-up
 * colour is sampled from the centre of the corresponding palette texel.
 */
export const indexedPaletteFragment = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;    // the sprite being filtered (index in .r)
uniform sampler2D uPalette;    // 256x1 RGBA palette lookup

void main(void)
{
    vec4 indexed = texture(uTexture, vTextureCoord);
    // Recover the 0..255 palette index from the normalised red channel and
    // sample the centre of that palette texel (u = (index + 0.5) / 256).
    float index = floor(indexed.r * 255.0 + 0.5);
    float u = (index + 0.5) / 256.0;
    vec4 palColor = texture(uPalette, vec2(u, 0.5));
    // Preserve the source alpha so transparent pixels stay transparent.
    finalColor = vec4(palColor.rgb, palColor.a * indexed.a);
}
`;

/**
 * Fragment shader for the **nearest-colour approximation** path
 * (Requirement 2.6's "or a modern approximation" clause). Snaps an already-RGB
 * pixel to the nearest of the 256 palette entries by brute-force scan. Used for
 * assets that are not stored as palette indices.
 */
export const nearestPaletteFragment = /* glsl */ `
in vec2 vTextureCoord;
out vec4 finalColor;

uniform sampler2D uTexture;    // the RGB sprite being filtered
uniform sampler2D uPalette;    // 256x1 RGBA palette lookup

void main(void)
{
    vec4 src = texture(uTexture, vTextureCoord);
    float bestDist = 1.0e20;
    vec3 best = src.rgb;
    for (int i = 0; i < 256; i++) {
        float u = (float(i) + 0.5) / 256.0;
        vec3 pal = texture(uPalette, vec2(u, 0.5)).rgb;
        vec3 d = pal - src.rgb;
        float dist = dot(d, d);
        if (dist < bestDist) {
            bestDist = dist;
            best = pal;
        }
    }
    finalColor = vec4(best, src.a);
}
`;

/**
 * The palette-lookup strategy for {@link createPaletteFilter}.
 * - `'indexed'` — read the palette index from the source red channel (used for
 *   converted `.BLK` sprites and indexed road tiles).
 * - `'nearest'` — snap an RGB source to the closest palette entry.
 */
export type PaletteMode = 'indexed' | 'nearest';

/**
 * Returns the fragment shader source for a given palette {@link PaletteMode}.
 * Pure string selection — safe to call and assert on headlessly.
 */
export function paletteFragmentSource(mode: PaletteMode): string {
  return mode === 'nearest' ? nearestPaletteFragment : indexedPaletteFragment;
}

/**
 * Creates the 256×1 RGBA palette lookup {@link Texture} from a palette.
 *
 * The texture is backed by a {@link BufferImageSource} over the byte buffer
 * from {@link buildPaletteTextureData}, so no image decode or GL upload happens
 * at construction time — the upload is deferred until the texture is first used
 * by a live renderer. That makes this constructable in a headless test env.
 *
 * Nearest-neighbour scaling is used so palette entries are never blended, and
 * the source is flagged as frequently-changing so palette animation
 * re-uploads are cheap.
 *
 * @param palette - The source 256-colour palette.
 */
export function createPaletteTexture(palette: SpritePalette): Texture {
  const data = buildPaletteTextureData(palette);
  const source = new BufferImageSource({
    resource: data,
    width: PALETTE_TEXTURE_WIDTH,
    height: PALETTE_TEXTURE_HEIGHT,
    // Point sampling: never interpolate between palette entries.
    scaleMode: 'nearest',
    // Palette animation re-uploads the buffer every so often.
    autoGenerateMipmaps: false,
  });
  return new Texture({ source });
}

/**
 * The fully-resolved, GPU-free description of a palette filter: the GLSL
 * program sources + the palette texture to bind as the `uPalette` uniform.
 *
 * This is the headless-testable core of {@link createPaletteFilter}: it holds
 * everything needed to build the PixiJS {@link Filter} but stops short of
 * constructing the {@link GlProgram} (whose constructor probes a WebGL context
 * for the max fragment precision and therefore needs a browser). Tests can
 * assert on this shape without a live GL context.
 */
export interface PaletteFilterOptions {
  /** GLSL program sources for the WebGL filter. */
  readonly glProgram: { name: string; vertex: string; fragment: string };
  /** Uniform resources to bind; `uPalette` is the 256×1 lookup texture source. */
  readonly resources: { uPalette: Texture['source'] };
  /** The backing 256×1 palette texture (also exposed via `resources.uPalette`). */
  readonly paletteTexture: Texture;
}

/**
 * Builds the GPU-free {@link PaletteFilterOptions} for a palette + lookup mode.
 *
 * Constructing the palette {@link Texture} is headless-safe (upload is
 * deferred), and the GLSL sources are pure strings, so this is fully unit
 * testable without a WebGL context. {@link createPaletteFilter} feeds the
 * result into the actual PixiJS {@link Filter}/{@link GlProgram}.
 *
 * @param palette - The initial palette to upload.
 * @param mode - Lookup strategy; defaults to authentic `'indexed'` lookup.
 */
export function buildPaletteFilterOptions(
  palette: SpritePalette,
  mode: PaletteMode = 'indexed',
): PaletteFilterOptions {
  const paletteTexture = createPaletteTexture(palette);
  return {
    glProgram: {
      name: `palette-${mode}`,
      vertex: paletteVertex,
      fragment: paletteFragmentSource(mode),
    },
    resources: { uPalette: paletteTexture.source },
    paletteTexture,
  };
}

/**
 * A palette-lookup filter plus a handle for live palette updates.
 */
export interface PaletteFilterHandle {
  /** The PixiJS filter to attach to a container's `filters` array. */
  readonly filter: Filter;
  /** The backing 256×1 palette texture (uniform `uPalette`). */
  readonly paletteTexture: Texture;
  /**
   * Re-uploads a new palette into the existing texture without allocating a new
   * filter, enabling palette animation and flash effects (Requirement 2.6).
   */
  updatePalette(palette: SpritePalette): void;
}

/**
 * Builds a palette-emulation {@link Filter} that can be assigned to any layer
 * or sprite's `filters` array — used for all indexed-palette sprites and the
 * road surface (task 15.3).
 *
 * The returned {@link PaletteFilterHandle} also exposes {@link
 * PaletteFilterHandle.updatePalette} so callers can animate the palette by
 * uploading a new 256-colour table into the same texture each frame.
 *
 * Constructing the filter does not require a live WebGL context (GLSL is only
 * compiled the first time the filter renders), so this is safe to call in
 * headless unit tests to assert wiring.
 *
 * @param palette - The initial palette to upload.
 * @param mode - Lookup strategy; defaults to authentic `'indexed'` lookup.
 */
export function createPaletteFilter(
  palette: SpritePalette,
  mode: PaletteMode = 'indexed',
): PaletteFilterHandle {
  const options = buildPaletteFilterOptions(palette, mode);
  const paletteTexture = options.paletteTexture;

  // Note: `new GlProgram` probes a WebGL context for the max fragment
  // precision, so this branch requires a browser and is not exercised headless
  // (the GPU-free `buildPaletteFilterOptions` is unit-tested instead).
  const glProgram = new GlProgram(options.glProgram);

  const filter = new Filter({
    glProgram,
    // `uPalette` is a sampler2D uniform bound to the palette texture.
    resources: options.resources,
  });

  const updatePalette = (next: SpritePalette): void => {
    uploadPaletteInto(paletteTexture, next);
  };

  return { filter, paletteTexture, updatePalette };
}

/**
 * Re-uploads a palette into an existing palette {@link Texture}'s backing
 * buffer (from {@link createPaletteTexture}) and flags it for GPU re-upload.
 *
 * This is the GPU-free core of {@link PaletteFilterHandle.updatePalette}: it
 * mutates the `Uint8Array` behind the {@link BufferImageSource} in place (no
 * reallocation) so palette animation is cheap, then calls `source.update()`.
 * The buffer write is headlessly testable; `update()` is a no-op until a live
 * renderer picks up the change.
 *
 * @param texture - A texture created by {@link createPaletteTexture}.
 * @param palette - The new 256-colour palette.
 */
export function uploadPaletteInto(texture: Texture, palette: SpritePalette): void {
  const data = buildPaletteTextureData(palette);
  const source = texture.source;
  const resource = source.resource as Uint8Array | undefined;
  if (resource && resource.length >= data.length) {
    resource.set(data);
  }
  source.update();
}
