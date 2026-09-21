import { describe, expect, it } from 'vitest';
import type { AICharacter } from '@deathtrack/shared';
import {
  AI_CHARACTERS,
  AI_CHARACTER_COUNT,
  CHARACTER_BIOS,
  CHARACTER_NAMES,
  PORTRAIT_ASSET_PREFIX,
  buildCompetitorInfoModel,
  paginateCompetitors,
  portraitAssetId,
  type CompetitorEntry,
} from '../CompetitorInfo';

/**
 * These tests exercise only the GPU-free competitor info model: the nine-
 * character roster, each entry's name / bio / portrait asset reference, and the
 * page layout math. They run in the headless `node` vitest environment.
 *
 * The PixiJS `CompetitorInfo` overlay draw path requires a WebGL context and is
 * validated in the browser, not here.
 *
 * Validates: Requirements 11.6 (Competitor Info screen displays portraits and
 * biographical text for all nine named AI Driver characters).
 */

describe('AI_CHARACTERS roster', () => {
  it('contains exactly nine characters', () => {
    expect(AI_CHARACTERS).toHaveLength(9);
    expect(AI_CHARACTER_COUNT).toBe(9);
  });

  it('has no duplicate characters', () => {
    expect(new Set(AI_CHARACTERS).size).toBe(9);
  });
});

describe('portraitAssetId', () => {
  it('derives a prefixed, deterministic asset id per character', () => {
    expect(portraitAssetId('sly')).toBe(`${PORTRAIT_ASSET_PREFIX}sly`);
    expect(portraitAssetId('wraith')).toBe(`${PORTRAIT_ASSET_PREFIX}wraith`);
  });
});

describe('buildCompetitorInfoModel', () => {
  const model = buildCompetitorInfoModel();

  it('emits exactly nine entries in roster order', () => {
    expect(model).toHaveLength(9);
    expect(model.map((e) => e.character)).toEqual([...AI_CHARACTERS]);
  });

  it('gives every entry a non-empty name, bio, and portrait reference', () => {
    for (const entry of model) {
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.bio.length).toBeGreaterThan(0);
      expect(entry.portraitAssetId.length).toBeGreaterThan(0);
    }
  });

  it('resolves name, bio, and portrait id consistently with the source tables', () => {
    for (const entry of model) {
      expect(entry.name).toBe(CHARACTER_NAMES[entry.character]);
      expect(entry.bio).toBe(CHARACTER_BIOS[entry.character]);
      expect(entry.portraitAssetId).toBe(portraitAssetId(entry.character));
    }
  });

  it('produces a distinct portrait reference for each character', () => {
    const ids = model.map((e) => e.portraitAssetId);
    expect(new Set(ids).size).toBe(9);
  });

  it('covers every character in the shared AICharacter union', () => {
    // A compile-time exhaustiveness anchor plus a runtime check that the name
    // and bio tables have an entry for each rostered character.
    for (const character of AI_CHARACTERS) {
      const c: AICharacter = character;
      expect(CHARACTER_NAMES[c]).toBeDefined();
      expect(CHARACTER_BIOS[c]).toBeDefined();
    }
  });
});

describe('paginateCompetitors', () => {
  const model = buildCompetitorInfoModel();

  it('splits the nine entries into pages of the requested size', () => {
    const pages = paginateCompetitors(model, 3);
    expect(pages).toHaveLength(3);
    expect(pages.every((p) => p.length === 3)).toBe(true);
    // Order is preserved across pages.
    expect(pages.flat().map((e) => e.character)).toEqual([...AI_CHARACTERS]);
  });

  it('puts the remainder on a final shorter page', () => {
    const pages = paginateCompetitors(model, 4);
    expect(pages.map((p) => p.length)).toEqual([4, 4, 1]);
  });

  it('clamps a non-positive page size to one', () => {
    const pages = paginateCompetitors(model, 0);
    expect(pages).toHaveLength(9);
    expect(pages.every((p) => p.length === 1)).toBe(true);
  });

  it('returns an empty array for empty input', () => {
    const empty: CompetitorEntry[] = [];
    expect(paginateCompetitors(empty, 3)).toEqual([]);
  });

  it('does not lose or duplicate any entry', () => {
    const pages = paginateCompetitors(model, 2);
    expect(pages.flat()).toHaveLength(model.length);
    expect(new Set(pages.flat().map((e) => e.character)).size).toBe(9);
  });
});
