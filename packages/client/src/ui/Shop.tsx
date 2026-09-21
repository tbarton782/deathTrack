import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import {
  purchaseItem,
  type CareerState,
  type CareerResult,
  type ComponentDef,
  type WeaponDef,
} from '@deathtrack/shared';

/**
 * Shop screen (task 17.8).
 *
 * The shop lets the player spend earned career money on components and weapons
 * from the catalogue. Every catalogue entry shows its name, an effect
 * description, and its price in whole currency units (Requirement 5.3). When
 * the player cannot afford an item the screen surfaces the *exact* shortfall
 * (`price − money`) and the purchase is blocked (Requirement 5.4); the actual
 * balance deduction is delegated to the shared {@link purchaseItem} rule.
 *
 * As with the other UI files in this package (see `RaceResults.tsx`,
 * `MainMenu.tsx`, `HUD.tsx`, `Settings.tsx`), the `.tsx` extension is a naming
 * convention only: these screens are PixiJS {@link Container} overlays, not
 * React component trees. The data → display-row mapping and the buy-decision
 * logic are pure, GPU-free functions ({@link buildCatalogueRows},
 * {@link attemptPurchase}) that are unit-tested headlessly, while the PixiJS
 * overlay ({@link Shop}) only consumes the already-computed rows to draw them.
 * The draw path requires a WebGL context and is verified in the browser.
 *
 * Requirements: 5.3, 5.4
 */

// ---------------------------------------------------------------------------
// Domain input
// ---------------------------------------------------------------------------

/**
 * The kind of catalogue item. Components upgrade car stats; weapons are
 * equipped into loadout slots. The tag lets the shop render the two catalogues
 * together while keeping their identity clear.
 */
export type ShopItemKind = 'component' | 'weapon';

/**
 * A single purchasable catalogue entry, normalised from either a
 * {@link ComponentDef} or a {@link WeaponDef}. This is the transport-agnostic
 * shape the shop needs; callers build it from the shared catalogues.
 */
export interface ShopCatalogueItem {
  /** Component or weapon identifier (unique within its kind). */
  readonly id: string;
  /** Whether this entry came from the component or weapon catalogue. */
  readonly kind: ShopItemKind;
  /** Display name shown in the shop. */
  readonly name: string;
  /** Human-readable effect description (e.g. "+8 top speed", "12 dmg / hit"). */
  readonly effect: string;
  /** Purchase price in whole currency units. */
  readonly price: number;
}

/**
 * A single fully-resolved catalogue row, ready to render. Each row records
 * whether the player can currently afford the item and, when they cannot, the
 * exact shortfall in whole currency units (`max(0, price − money)`).
 */
export interface ShopRow {
  readonly id: string;
  readonly kind: ShopItemKind;
  readonly name: string;
  readonly effect: string;
  readonly price: number;
  /** `true` when `money >= price`. */
  readonly affordable: boolean;
  /** `max(0, price − money)`; always 0 when {@link affordable} is `true`. */
  readonly shortfall: number;
}

// ---------------------------------------------------------------------------
// Effect description helpers (GPU-free, unit-testable)
// ---------------------------------------------------------------------------

/** Human-readable labels for each stat delta shown in a component's effect. */
const STAT_LABELS = {
  topSpeed: 'top speed',
  acceleration: 'accel',
  armor: 'armor',
  handling: 'handling',
} as const;

/**
 * Builds a component's effect description from its stat deltas, e.g.
 * `"+8 top speed, -2 handling"`. Deltas are listed in a stable stat order so
 * the description is deterministic. A component with no deltas yields
 * `"no stat change"`.
 */
export function describeComponentEffect(component: ComponentDef): string {
  const order: Array<keyof typeof STAT_LABELS> = [
    'topSpeed',
    'acceleration',
    'armor',
    'handling',
  ];
  const parts: string[] = [];
  for (const stat of order) {
    const delta = component.statDeltas[stat];
    if (delta === undefined || delta === 0) continue;
    const sign = delta > 0 ? '+' : '';
    parts.push(`${sign}${delta} ${STAT_LABELS[stat]}`);
  }
  return parts.length > 0 ? parts.join(', ') : 'no stat change';
}

/**
 * Builds a weapon's effect description, e.g. `"forward · 12 dmg/hit · 30 ammo"`
 * or `"forward · 40 dmg/s · 60 ammo"` for beam weapons.
 */
export function describeWeaponEffect(weapon: WeaponDef): string {
  const dmg =
    weapon.beamDPS !== null
      ? `${weapon.beamDPS} dmg/s`
      : `${weapon.damage} dmg/hit`;
  return `${weapon.category} · ${dmg} · ${weapon.ammoMax} ammo`;
}

/** Normalises a {@link ComponentDef} into a {@link ShopCatalogueItem}. */
export function componentToCatalogueItem(
  component: ComponentDef,
): ShopCatalogueItem {
  return {
    id: component.id,
    kind: 'component',
    name: component.name,
    effect: describeComponentEffect(component),
    price: component.price,
  };
}

/** Normalises a {@link WeaponDef} into a {@link ShopCatalogueItem}. */
export function weaponToCatalogueItem(weapon: WeaponDef): ShopCatalogueItem {
  return {
    id: weapon.id,
    kind: 'weapon',
    name: weapon.name,
    effect: describeWeaponEffect(weapon),
    price: weapon.price,
  };
}

// ---------------------------------------------------------------------------
// Pure row model (GPU-free, unit-testable)
// ---------------------------------------------------------------------------

/**
 * Builds the catalogue rows for the shop from the component and weapon
 * catalogues, resolving affordability against the player's current money.
 *
 * Pure and free of any PixiJS / WebGL dependency so it can be exercised
 * headlessly. For each item:
 *
 * - `affordable` is `money >= price`.
 * - `shortfall` is `max(0, price − money)` — the exact number of additional
 *   whole currency units the player needs (Requirement 5.4). It is always 0 for
 *   an affordable item.
 *
 * Components are listed before weapons; within each kind the input order is
 * preserved. Neither input catalogue is mutated.
 *
 * @param components - Component catalogue entries.
 * @param weapons - Weapon catalogue entries.
 * @param money - The player's current career money balance.
 * @returns One resolved row per catalogue entry, components first.
 */
export function buildCatalogueRows(
  components: readonly ComponentDef[],
  weapons: readonly WeaponDef[],
  money: number,
): ShopRow[] {
  const items: ShopCatalogueItem[] = [
    ...components.map(componentToCatalogueItem),
    ...weapons.map(weaponToCatalogueItem),
  ];

  return items.map((item) => {
    const affordable = money >= item.price;
    return {
      id: item.id,
      kind: item.kind,
      name: item.name,
      effect: item.effect,
      price: item.price,
      affordable,
      shortfall: affordable ? 0 : item.price - money,
    };
  });
}

/** Formats a money amount in whole currency units with thousands separators. */
export function formatMoney(amount: number): string {
  return `$${Math.trunc(amount).toLocaleString('en-US')}`;
}

// ---------------------------------------------------------------------------
// Purchase decision (GPU-free, unit-testable)
// ---------------------------------------------------------------------------

/**
 * Attempt to purchase a catalogue item, delegating the atomic balance rule to
 * the shared {@link purchaseItem}. This keeps the shop's buy action consistent
 * with `CareerService`: an affordable item deducts exactly its price; an
 * unaffordable one is rejected with the exact shortfall and leaves the balance
 * unchanged (Requirements 5.3, 5.4).
 *
 * The result is the shared {@link CareerResult}: on success `value` is the new
 * career state with the item's price deducted; on failure `shortfall` carries
 * the exact deficit.
 *
 * @param career - The player's current career state.
 * @param item - The catalogue item the player is trying to buy.
 * @returns The shared career result of the purchase attempt.
 */
export function attemptPurchase(
  career: CareerState,
  item: ShopCatalogueItem,
): CareerResult<CareerState> {
  return purchaseItem(career, item.price);
}

// ---------------------------------------------------------------------------
// PixiJS overlay (browser-only draw path)
// ---------------------------------------------------------------------------

/** Layout constants for the shop table draw. */
const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 52;
const PADDING = 24;
const PANEL_WIDTH = 620;

/** Column x-offsets (relative to the panel's left padding). */
const COL_NAME = 0;
const COL_EFFECT = 200;
const COL_PRICE = 470;
const COL_STATUS = 560;

/**
 * Callback invoked by the shop overlay when the player activates the buy action
 * for a row. Injecting the purchase side effect behind a callback keeps the
 * overlay testable and decoupled from the career controller: the overlay itself
 * performs no persistence and no direct state mutation.
 *
 * Implementations typically call {@link attemptPurchase} and, on success, apply
 * the returned {@link CareerState}.
 */
export type ShopPurchaseHandler = (item: ShopCatalogueItem) => void;

/**
 * Shop overlay. A self-contained PixiJS {@link Container} that draws the
 * component and weapon catalogues, each entry showing name, effect, and price,
 * with an affordability indicator that reveals the exact shortfall for items
 * the player cannot afford.
 *
 * Construction is GPU-free (PixiJS display objects instantiate without a WebGL
 * context); only attaching the container to a live stage and presenting it
 * requires a renderer. Rows are derived via {@link buildCatalogueRows} so
 * affordability and shortfall stay consistent with the shared purchase rule.
 */
export class Shop extends Container {
  private readonly catalogueRows: ShopRow[];
  private readonly items: readonly ShopCatalogueItem[];
  private readonly onPurchase: ShopPurchaseHandler | undefined;

  /**
   * @param components - Component catalogue entries.
   * @param weapons - Weapon catalogue entries.
   * @param money - The player's current career money balance.
   * @param onPurchase - Optional callback invoked when a buy action fires.
   */
  constructor(
    components: readonly ComponentDef[],
    weapons: readonly WeaponDef[],
    money: number,
    onPurchase?: ShopPurchaseHandler,
  ) {
    super();
    this.label = 'shop';
    this.catalogueRows = buildCatalogueRows(components, weapons, money);
    this.items = [
      ...components.map(componentToCatalogueItem),
      ...weapons.map(weaponToCatalogueItem),
    ];
    this.onPurchase = onPurchase;
    this.draw();
  }

  /** The rendered catalogue rows, in display order. Exposed for inspection. */
  get rows(): readonly ShopRow[] {
    return this.catalogueRows;
  }

  /**
   * Invoke the injected purchase handler for the row at `index`. Returns `true`
   * if the item is affordable and a handler is present (the buy action fired);
   * returns `false` for an unaffordable item, which never triggers a purchase.
   */
  buy(index: number): boolean {
    const row = this.catalogueRows[index];
    const item = this.items[index];
    if (row === undefined || item === undefined) return false;
    if (!row.affordable) return false;
    this.onPurchase?.(item);
    return true;
  }

  private draw(): void {
    const bodyHeight = this.catalogueRows.length * ROW_HEIGHT;
    const panelHeight = HEADER_HEIGHT + bodyHeight + PADDING * 2;

    const panel = new Graphics();
    panel
      .roundRect(0, 0, PANEL_WIDTH, panelHeight, 8)
      .fill({ color: 0x0a0a12, alpha: 0.92 })
      .stroke({ color: 0x3355aa, width: 2 });
    this.addChild(panel);

    const titleStyle = new TextStyle({
      fill: 0xffcc33,
      fontFamily: 'monospace',
      fontSize: 22,
      fontWeight: 'bold',
    });
    const title = new Text({ text: 'SHOP', style: titleStyle });
    title.position.set(PADDING, PADDING - 6);
    this.addChild(title);

    const headerStyle = new TextStyle({
      fill: 0x8899cc,
      fontFamily: 'monospace',
      fontSize: 13,
      fontWeight: 'bold',
    });
    const headerY = PADDING + HEADER_HEIGHT - 20;
    this.addColumnLabels(headerStyle, headerY, {
      name: 'ITEM',
      effect: 'EFFECT',
      price: 'PRICE',
      status: 'STATUS',
    });

    this.catalogueRows.forEach((row, index) => {
      const y = PADDING + HEADER_HEIGHT + index * ROW_HEIGHT;
      const rowStyle = new TextStyle({
        fill: row.affordable ? 0xffffff : 0x888888,
        fontFamily: 'monospace',
        fontSize: 14,
      });
      const status = row.affordable
        ? 'BUY'
        : `NEED ${formatMoney(row.shortfall)}`;
      this.addColumnLabels(rowStyle, y, {
        name: row.name,
        effect: row.effect,
        price: formatMoney(row.price),
        status,
      });
    });
  }

  private addColumnLabels(
    style: TextStyle,
    y: number,
    values: { name: string; effect: string; price: string; status: string },
  ): void {
    const cols: Array<[number, string]> = [
      [COL_NAME, values.name],
      [COL_EFFECT, values.effect],
      [COL_PRICE, values.price],
      [COL_STATUS, values.status],
    ];
    for (const [dx, text] of cols) {
      const label = new Text({ text, style });
      label.position.set(PADDING + dx, y);
      this.addChild(label);
    }
  }
}
