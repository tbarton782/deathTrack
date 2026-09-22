/**
 * Best-effort loader that turns the converted car sprite sheets into a drawable
 * {@link RaceSprites} bundle (a packed atlas + a PixiJS texture + a per-car
 * frame resolver), for the in-race renderer (task 25 — real car sprites).
 *
 * The converted assets (produced by `deathtrack-tools --real`) ship one sprite
 * container per real competitor (`assets/sprites/SLY.dtasset`, `ANGEL.dtasset`,
 * …), each a {@link SpriteSheetBundle} of 4-bpp palette-index blocks named
 * `<STEM>_<i>`, plus the recovered 16-colour EGA palette
 * (`assets/palette/ACTIVISI.dtasset`). This module:
 *
 *   1. loads the palette + each available competitor sheet through the runtime
 *      {@link BinaryAssetLoader};
 *   2. concatenates every sheet's blocks and packs them into one atlas with the
 *      shared {@link loadSpriteSheet} (which also expands the palette indices to
 *      RGBA);
 *   3. builds a single PixiJS {@link Texture} over the packed RGBA buffer;
 *   4. returns a `spriteIdFor(participantId)` that maps each grid slot to a real
 *      competitor's first frame (`<STEM>_0`), so the field draws real art.
 *
 * Everything is best-effort: any missing/unservable asset (the assets are
 * git-ignored and generated locally) is skipped, and if no sheet loads the
 * function returns `null` so the caller keeps the renderer's placeholder path.
 * Nothing here throws to the caller.
 */

import { BufferImageSource, Texture } from 'pixi.js';
import {
  BinaryAssetLoader,
  loadSpriteSheet,
  AI_CHARACTER_ORDER,
  type SpritePalette,
  type SpriteSheetBundle,
} from '@deathtrack/shared';
import type { AssetSource } from '@deathtrack/shared';
import type { ParticipantId } from '@deathtrack/shared';
import type { RaceSprites } from './RaceSession.js';
import { HUMAN_PARTICIPANT_ID } from './RaceSession.js';

/**
 * The competitor sheets to try to load, keyed by the real DOS stem (uppercase),
 * one per AI character. The human reuses the first available sheet as a stand-in
 * (the recreation defines no player-car art of its own).
 */
const COMPETITOR_STEMS: readonly string[] = AI_CHARACTER_ORDER.map((c) => c.toUpperCase());

/** Expand a `{ rgb: number[] }` palette to a full 256×3 {@link SpritePalette}. */
function toSpritePalette(raw: { rgb: number[] }): SpritePalette {
  const rgb = new Uint8Array(256 * 3);
  rgb.set(raw.rgb.slice(0, rgb.length));
  return { rgb };
}

/**
 * Attempt to build the race car-sprite atlas from the converted assets. Returns
 * `null` (and logs a warning) when no sprite sheet could be loaded, so the race
 * renders with placeholder cars.
 */
export async function loadRaceSprites(source: AssetSource): Promise<RaceSprites | null> {
  const loader = new BinaryAssetLoader(source);

  // 1. Palette (best-effort; without it we cannot colourise, so bail to null).
  let palette: SpritePalette;
  try {
    palette = toSpritePalette(await loader.loadPalette('ACTIVISI'));
  } catch (err) {
    console.warn(
      `[client] car sprites skipped: palette unavailable (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return null;
  }

  // 2. Load each competitor sheet; concatenate all blocks into one bundle.
  //    Track the first frame name per stem so cars can be mapped to real art.
  const blocks: SpriteSheetBundle['blocks'] = [];
  const firstFrameByStem = new Map<string, string>();
  for (const stem of COMPETITOR_STEMS) {
    try {
      const sheet = (await loader.loadSpriteSheetByStem(stem)) as unknown as SpriteSheetBundle;
      if (!sheet || !Array.isArray(sheet.blocks) || sheet.blocks.length === 0) continue;
      const firstBlock = sheet.blocks[0];
      if (firstBlock?.name) firstFrameByStem.set(stem, firstBlock.name);
      blocks.push(...sheet.blocks);
    } catch {
      // Missing sheet: skip this competitor.
    }
  }

  if (blocks.length === 0) {
    console.warn('[client] car sprites skipped: no competitor sheets available');
    return null;
  }

  // 3. Pack into a single atlas + RGBA buffer, then a PixiJS texture.
  let atlas: RaceSprites['atlas'];
  let atlasTexture: RaceSprites['atlasTexture'];
  try {
    const packed = loadSpriteSheet({ blocks }, palette, { app: 'deathtrack-race' });
    atlas = packed.atlas;
    atlasTexture = new Texture({
      source: new BufferImageSource({
        resource: packed.pixels,
        width: packed.atlas.meta.size.w,
        height: packed.atlas.meta.size.h,
      }),
    });
  } catch (err) {
    console.warn(
      `[client] car sprites skipped: packing failed (${
        err instanceof Error ? err.message : String(err)
      })`,
    );
    return null;
  }

  // 4. Map each grid slot to a real competitor's first frame. The human (slot 0)
  //    reuses the first available competitor sheet as a stand-in; each AI slot
  //    uses its own character's sheet when present, else the first available.
  const orderedStems = COMPETITOR_STEMS.filter((s) => firstFrameByStem.has(s));
  const fallbackFrame = orderedStems.length > 0 ? firstFrameByStem.get(orderedStems[0]!)! : undefined;

  const spriteIdFor = (participantId: ParticipantId): string | undefined => {
    if (participantId === HUMAN_PARTICIPANT_ID) return fallbackFrame;
    // AI slots are 1-based into the character order.
    const stem = COMPETITOR_STEMS[participantId - 1];
    const frame = stem ? firstFrameByStem.get(stem) : undefined;
    return frame ?? fallbackFrame;
  };

  return { atlas, atlasTexture, spriteIdFor };
}
