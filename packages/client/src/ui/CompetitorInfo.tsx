import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { TextStyleOptions } from 'pixi.js';
import type { AICharacter } from '@deathtrack/shared';

/**
 * Competitor Info screen (task 17.6).
 *
 * Requirement 11.6: the game displays portraits and biographical text for all
 * nine named AI Driver characters in a Competitor Info screen reachable from
 * the Career Mode menu.
 *
 * Following the established client UI convention (see MainMenu.tsx,
 * RaceResults.tsx, HUD.tsx, Settings.tsx, PauseMenu.tsx), the on-screen game UI
 * is built from PixiJS {@link Container} scene graphs rather than DOM/React
 * trees. The `.tsx` extension is retained for consistency with the spec naming;
 * no JSX is used. The design separates a pure, GPU-free *info model* (the nine
 * characters' names, bios, portrait asset references, and page layout math)
 * from the GPU draw calls, so the model can be unit-tested headlessly while the
 * actual pixel drawing is validated in a browser.
 *
 * Portraits come from the original game's `.SCR` full-screen images, which the
 * `@deathtrack/tools` `ScrParser` decodes and the runtime `AssetLoader` bundles
 * as `Screen` asset containers. The screen never touches disk or the network
 * itself: portrait resolution is abstracted behind {@link PortraitSource} so a
 * browser build supplies a texture-backed source, and tests supply an in-memory
 * one. The pure model only names the portrait *asset id* per character; the
 * overlay asks the injected source to turn that id into a drawable texture.
 */

// ---------------------------------------------------------------------------
// Character roster (pure, single source of truth)
// ---------------------------------------------------------------------------

/**
 * The nine AI driver characters, in canonical display order. This mirrors the
 * shared {@link AICharacter} union and is the single source of truth for the
 * roster the Competitor Info screen presents. Exactly nine entries
 * (Requirement 11.6).
 */
export const AI_CHARACTERS: readonly AICharacter[] = [
  'sly',
  'angel',
  'crimson',
  'blaze',
  'havoc',
  'razor',
  'viper',
  'phantom',
  'wraith',
] as const;

/** The number of AI driver characters shown on the screen (Requirement 11.6). */
export const AI_CHARACTER_COUNT = AI_CHARACTERS.length;

/** Human-readable display names, keyed by {@link AICharacter}. */
export const CHARACTER_NAMES: Record<AICharacter, string> = {
  sly: 'Sly',
  angel: 'Angel',
  crimson: 'Crimson',
  blaze: 'Blaze',
  havoc: 'Havoc',
  razor: 'Razor',
  viper: 'Viper',
  phantom: 'Phantom',
  wraith: 'Wraith',
};

/**
 * Biographical text for each character, keyed by {@link AICharacter}. Short,
 * flavourful bios in the spirit of the original game's competitor dossiers.
 */
export const CHARACTER_BIOS: Record<AICharacter, string> = {
  sly: 'A calculating veteran who wins by patience, letting rivals wreck themselves before slipping past for the kill.',
  angel: 'Cold and precise, she treats every race as target practice and rarely misses her mark.',
  crimson: 'A reckless brawler who leaves a trail of burning wrecks and answers every hit with two of his own.',
  blaze: 'Fastest foot on the circuit; she would rather outrun a missile than dodge it.',
  havoc: 'A demolition specialist who seeds the track with mines and dares you to follow.',
  razor: 'Surgical and silent, he picks off stragglers with rear drops before they know he is there.',
  viper: 'Aggressive to a fault, she tailgates at full throttle and rams anything between her and first place.',
  phantom: 'An elusive tactician who vanishes into the pack and strikes from angles no one expects.',
  wraith: 'The circuit legend nobody has beaten twice; equal parts speed, armour, and menace.',
};

// ---------------------------------------------------------------------------
// Portrait resolution (injected — GPU/asset-transport agnostic)
// ---------------------------------------------------------------------------

/**
 * The prefix used to key a character's portrait within the converted `Screen`
 * asset set. The concrete `.SCR`-derived container is produced by the tool's
 * `ScrParser`; the client only needs a stable logical id to hand to its
 * {@link PortraitSource}.
 */
export const PORTRAIT_ASSET_PREFIX = 'portraits/';

/**
 * Returns the logical portrait asset id for a character (e.g. `sly` →
 * `portraits/sly`). Pure and deterministic so the info model can be built and
 * asserted on without any asset loader present.
 */
export function portraitAssetId(character: AICharacter): string {
  return `${PORTRAIT_ASSET_PREFIX}${character}`;
}

/**
 * Resolves a portrait asset id into a drawable PixiJS {@link Texture}. Injected
 * so the parsed `.SCR` decode (done by the tools `ScrParser` + runtime
 * `AssetLoader`) is decoupled from this screen and the screen stays testable:
 * a browser build backs this with real textures, tests back it with stubs.
 */
export interface PortraitSource {
  /**
   * Return the texture for `assetId`, or `undefined` if the portrait has not
   * been loaded (the overlay then draws a placeholder frame). Implementations
   * must not throw for a missing portrait.
   */
  getPortrait(assetId: string): Texture | undefined;
}

// ---------------------------------------------------------------------------
// Pure info model (unit-testable headlessly)
// ---------------------------------------------------------------------------

/**
 * A single fully-resolved competitor entry, ready to render. Contains no PixiJS
 * display objects — only the character identity, its display name, bio text,
 * and the portrait asset id to look up — so it can be built and asserted on in
 * a headless environment.
 */
export interface CompetitorEntry {
  /** The AI character identity. */
  readonly character: AICharacter;
  /** Human-readable display name. */
  readonly name: string;
  /** Biographical text. */
  readonly bio: string;
  /** Logical portrait asset id to resolve via a {@link PortraitSource}. */
  readonly portraitAssetId: string;
}

/**
 * Builds the ordered list of competitor entries for all nine AI characters.
 *
 * Pure and free of any PixiJS / asset dependency so it can be exercised
 * headlessly. Emits exactly {@link AI_CHARACTER_COUNT} (nine) entries in
 * {@link AI_CHARACTERS} order, each carrying a name, bio, and portrait asset id
 * (Requirement 11.6).
 */
export function buildCompetitorInfoModel(): CompetitorEntry[] {
  return AI_CHARACTERS.map((character) => ({
    character,
    name: CHARACTER_NAMES[character],
    bio: CHARACTER_BIOS[character],
    portraitAssetId: portraitAssetId(character),
  }));
}

/**
 * Splits the competitor entries into fixed-size pages for display. Pure layout
 * math with no rendering; used by the overlay to paginate the roster and
 * unit-tested independently.
 *
 * @param entries - The entries to paginate (typically {@link buildCompetitorInfoModel}).
 * @param perPage - Entries per page; clamped to at least 1.
 * @returns An array of pages, each a non-empty slice of `entries` in order. An
 *   empty input yields an empty array.
 */
export function paginateCompetitors(
  entries: readonly CompetitorEntry[],
  perPage: number,
): CompetitorEntry[][] {
  const size = Math.max(1, Math.trunc(perPage));
  const pages: CompetitorEntry[][] = [];
  for (let i = 0; i < entries.length; i += size) {
    pages.push(entries.slice(i, i + size));
  }
  return pages;
}

// ---------------------------------------------------------------------------
// PixiJS overlay (browser-only draw path)
// ---------------------------------------------------------------------------

/** Layout constants for the competitor cards. */
const PADDING = 20;
const CARD_WIDTH = 380;
const CARD_HEIGHT = 120;
const CARD_GAP = 12;
const PORTRAIT_SIZE = 96;
const DEFAULT_PER_PAGE = 3;

const TITLE_STYLE: TextStyleOptions = {
  fill: 0xffcc33,
  fontFamily: 'monospace',
  fontSize: 24,
  fontWeight: 'bold',
};

const NAME_STYLE: TextStyleOptions = {
  fill: 0xffffff,
  fontFamily: 'monospace',
  fontSize: 18,
  fontWeight: 'bold',
};

const BIO_STYLE: TextStyleOptions = {
  fill: 0xc8d0e0,
  fontFamily: 'monospace',
  fontSize: 13,
  wordWrap: true,
  wordWrapWidth: CARD_WIDTH - PORTRAIT_SIZE - PADDING * 3,
};

/**
 * The PixiJS Competitor Info screen. Construct it with a {@link PortraitSource}
 * (and optional per-page override), add {@link CompetitorInfo.view} to a stage,
 * and it draws a card per AI character showing the portrait, name, and bio.
 *
 * The container and all child display objects (Graphics, Text, Sprite)
 * construct without a WebGL context; only actually rendering them to the screen
 * requires a GPU, which is exercised in the browser rather than in unit tests.
 */
export class CompetitorInfo {
  /** Root container to add to a parent stage or menu layer. */
  readonly view: Container;

  private readonly entries: CompetitorEntry[];
  private readonly pages: CompetitorEntry[][];
  private pageIndex = 0;
  private readonly pageContainer: Container;

  constructor(
    private readonly portraits: PortraitSource,
    perPage: number = DEFAULT_PER_PAGE,
  ) {
    this.view = new Container();
    this.view.label = 'competitorInfo';
    this.entries = buildCompetitorInfoModel();
    this.pages = paginateCompetitors(this.entries, perPage);

    const title = new Text({ text: 'COMPETITORS', style: TITLE_STYLE });
    title.label = 'competitorInfo:title';
    title.x = PADDING;
    title.y = PADDING;
    this.view.addChild(title);

    this.pageContainer = new Container();
    this.pageContainer.label = 'competitorInfo:page';
    this.pageContainer.x = PADDING;
    this.pageContainer.y = PADDING + 40;
    this.view.addChild(this.pageContainer);

    this.drawPage();
  }

  /** The pure entries backing the screen (read-only view). */
  getEntries(): readonly CompetitorEntry[] {
    return this.entries;
  }

  /** Total number of pages the roster spans. */
  get pageCount(): number {
    return this.pages.length;
  }

  /** The zero-based index of the currently displayed page. */
  get currentPage(): number {
    return this.pageIndex;
  }

  /** Advance to the next page (wraps to the first). No-op with a single page. */
  nextPage(): void {
    if (this.pages.length <= 1) return;
    this.pageIndex = (this.pageIndex + 1) % this.pages.length;
    this.drawPage();
  }

  /** Go to the previous page (wraps to the last). No-op with a single page. */
  previousPage(): void {
    if (this.pages.length <= 1) return;
    this.pageIndex = (this.pageIndex - 1 + this.pages.length) % this.pages.length;
    this.drawPage();
  }

  /** Redraws the current page's cards from scratch. */
  private drawPage(): void {
    this.pageContainer.removeChildren().forEach((child) => child.destroy());
    const page = this.pages[this.pageIndex] ?? [];
    page.forEach((entry, index) => {
      const card = this.buildCard(entry);
      card.y = index * (CARD_HEIGHT + CARD_GAP);
      this.pageContainer.addChild(card);
    });
  }

  /** Builds a single competitor card (portrait + name + bio). */
  private buildCard(entry: CompetitorEntry): Container {
    const card = new Container();
    card.label = `competitorInfo:card:${entry.character}`;

    const bg = new Graphics();
    bg.roundRect(0, 0, CARD_WIDTH, CARD_HEIGHT, 6)
      .fill({ color: 0x0a0a12, alpha: 0.9 })
      .stroke({ color: 0x3355aa, width: 2 });
    card.addChild(bg);

    // Portrait: use the injected source's texture, else a placeholder frame.
    const texture = this.portraits.getPortrait(entry.portraitAssetId);
    if (texture) {
      const sprite = new Sprite(texture);
      sprite.label = `${card.label}:portrait`;
      sprite.width = PORTRAIT_SIZE;
      sprite.height = PORTRAIT_SIZE;
      sprite.x = PADDING;
      sprite.y = PADDING;
      card.addChild(sprite);
    } else {
      const placeholder = new Graphics();
      placeholder.label = `${card.label}:portraitPlaceholder`;
      placeholder
        .rect(PADDING, PADDING, PORTRAIT_SIZE, PORTRAIT_SIZE)
        .fill(0x1a1a2a)
        .stroke({ color: 0x445588, width: 1 });
      card.addChild(placeholder);
    }

    const textX = PADDING * 2 + PORTRAIT_SIZE;

    const name = new Text({ text: entry.name, style: NAME_STYLE });
    name.label = `${card.label}:name`;
    name.x = textX;
    name.y = PADDING;
    card.addChild(name);

    const bio = new Text({ text: entry.bio, style: BIO_STYLE });
    bio.label = `${card.label}:bio`;
    bio.x = textX;
    bio.y = PADDING + 28;
    card.addChild(bio);

    return card;
  }

  /** Tears down the screen and releases its display objects. */
  destroy(): void {
    this.view.destroy({ children: true });
  }
}
