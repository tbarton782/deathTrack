import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import {
  computeEffectiveStats,
  previewComponent,
  type ChassisDef,
  type ChassisId,
  type ComponentDef,
  type ComponentId,
  type ComponentSlot,
  type EffectiveCarStats,
  type Loadout,
  type WeaponDef,
  type WeaponId,
  type WeaponSlot,
} from '@deathtrack/shared';

/**
 * Car & loadout configuration screen (task 17.7).
 *
 * Requirement 4: the player picks a chassis, equips one component per upgrade
 * slot, and fits weapons into the four weapon slots before a race. Every
 * candidate component preview shows both the per-stat delta and the resulting
 * effective stat it would produce if equipped (Req 4.7), and weapon slot
 * pickers only offer weapons the player has actually purchased (Req 4.6, owned
 * list supplied from {@link CareerState.ownedWeapons}).
 *
 * Following the established client UI convention (see {@link Settings},
 * {@link RaceResults}, {@link MainMenu}, {@link HUD}), the on-screen game UI is
 * built from PixiJS {@link Container} scene graphs rather than DOM/React trees;
 * the `.tsx` extension is retained only for naming consistency with the spec.
 *
 * The design deliberately separates a pure, GPU-free *view-model* — the
 * functions that build chassis options, per-slot component rows carrying
 * `{ statDeltas, effectiveStats }`, and owned-filtered weapon options — from
 * the actual GPU draw calls. All stat deltas and resulting effective stats are
 * computed by delegating to the shared {@link computeEffectiveStats} /
 * {@link previewComponent} logic rather than reimplementing the additive-clamp
 * rules here. The view-model half is fully unit-testable in a headless `node`
 * environment; the {@link CarConfig} PixiJS overlay only consumes the
 * already-computed rows to draw them. The draw path requires a WebGL context
 * and is validated in the browser, not in unit tests.
 */

// ---------------------------------------------------------------------------
// Canonical stat ordering
// ---------------------------------------------------------------------------

/**
 * The four configurable stats in display order (Req 4.7). This ordering is the
 * single source of truth shared by the pure view-model and the rendered screen.
 */
export const CONFIG_STAT_KEYS = [
  'topSpeed',
  'acceleration',
  'armor',
  'handling',
] as const;

/** One of the four configurable car stat keys. */
export type ConfigStatKey = (typeof CONFIG_STAT_KEYS)[number];

/** Human-readable labels for each configurable stat. */
export const CONFIG_STAT_LABELS: Record<ConfigStatKey, string> = {
  topSpeed: 'Top Speed',
  acceleration: 'Acceleration',
  armor: 'Armor',
  handling: 'Handling',
};

/**
 * The six component slots in display order (Req 4.2). Mirrors the shared
 * `ComponentSlot` union and the loadout's `components` shape.
 */
export const COMPONENT_SLOT_ORDER: readonly ComponentSlot[] = [
  'engine',
  'transmission',
  'brakes',
  'tires',
  'airfoil',
  'armor',
] as const;

/** The four weapon slots in display order (Req 4.4). */
export const WEAPON_SLOT_ORDER: readonly WeaponSlot[] = [
  'forward',
  'rear',
  'side_spike',
  'ram',
] as const;

/** Human-readable labels for each component slot. */
export const COMPONENT_SLOT_LABELS: Record<ComponentSlot, string> = {
  engine: 'Engine',
  transmission: 'Transmission',
  brakes: 'Brakes',
  tires: 'Tires',
  airfoil: 'Airfoil',
  armor: 'Armor Type',
};

/** Human-readable labels for each weapon slot. */
export const WEAPON_SLOT_LABELS: Record<WeaponSlot, string> = {
  forward: 'Forward Weapon',
  rear: 'Rear Weapon',
  side_spike: 'Side Spikes',
  ram: 'Ram',
};

// ---------------------------------------------------------------------------
// Catalogue helpers
// ---------------------------------------------------------------------------

/**
 * Builds a `ComponentId -> ComponentDef` map from a component catalogue list.
 * The shared loadout functions consume `ReadonlyMap`s, so this is the bridge
 * from the flat catalogue the UI receives to the shape they expect.
 */
export function indexComponents(
  catalogue: readonly ComponentDef[],
): ReadonlyMap<ComponentId, ComponentDef> {
  const map = new Map<ComponentId, ComponentDef>();
  for (const def of catalogue) map.set(def.id, def);
  return map;
}

/** Builds a `WeaponId -> WeaponDef` map from a weapon catalogue list. */
export function indexWeapons(
  catalogue: readonly WeaponDef[],
): ReadonlyMap<WeaponId, WeaponDef> {
  const map = new Map<WeaponId, WeaponDef>();
  for (const def of catalogue) map.set(def.id, def);
  return map;
}

// ---------------------------------------------------------------------------
// Chassis picker view-model
// ---------------------------------------------------------------------------

/** One row in the chassis picker. */
export interface ChassisOption {
  readonly id: ChassisId;
  readonly name: string;
  /** `true` when this is the currently selected chassis in the loadout. */
  readonly selected: boolean;
  /** The chassis's factory base stats, for a compact preview. */
  readonly baseStats: ChassisDef['baseStats'];
}

/**
 * Builds the chassis picker options from the chassis catalogue and the current
 * loadout, marking the selected chassis. Pure and GPU-free. Requirement 4.1.
 */
export function buildChassisOptions(
  chassisCatalogue: readonly ChassisDef[],
  loadout: Loadout,
): ChassisOption[] {
  return chassisCatalogue.map((chassis) => ({
    id: chassis.id,
    name: chassis.name,
    selected: chassis.id === loadout.chassisId,
    baseStats: chassis.baseStats,
  }));
}

// ---------------------------------------------------------------------------
// Component slot view-model
// ---------------------------------------------------------------------------

/** Per-stat preview for one candidate component. Requirement 4.7. */
export interface StatDeltaCell {
  readonly stat: ConfigStatKey;
  /** The delta this component would apply (0 when it does not touch the stat). */
  readonly delta: number;
  /** The resulting clamped effective stat value if the component were equipped. */
  readonly effective: number;
}

/** One candidate component within a component slot. */
export interface ComponentCandidateRow {
  readonly id: ComponentId;
  readonly name: string;
  readonly price: number;
  /** `true` when this candidate is the one currently equipped in the slot. */
  readonly equipped: boolean;
  /** `true` when the player owns this component and may equip it (Req 4.6). */
  readonly owned: boolean;
  /**
   * The four per-stat preview cells, in {@link CONFIG_STAT_KEYS} order, showing
   * the delta the component applies and the resulting effective stat. Computed
   * via the shared {@link previewComponent} — never reimplemented here.
   */
  readonly stats: readonly StatDeltaCell[];
}

/** One component slot with its candidate components. */
export interface ComponentSlotRow {
  readonly slot: ComponentSlot;
  readonly label: string;
  /** The component currently equipped in this slot, or `null` when empty. */
  readonly equippedId: ComponentId | null;
  /** All catalogue components eligible for this slot, with per-stat previews. */
  readonly candidates: readonly ComponentCandidateRow[];
}

/**
 * Builds the per-stat delta / effective-stat cells for a single candidate
 * component by delegating to the shared {@link previewComponent}. Returns
 * `null` if the component is not in the catalogue.
 */
function buildStatCells(
  loadout: Loadout,
  chassis: ChassisDef,
  components: ReadonlyMap<ComponentId, ComponentDef>,
  componentId: ComponentId,
): StatDeltaCell[] | null {
  const preview = previewComponent(loadout, chassis, components, componentId);
  if (!preview.ok) return null;
  const p = preview.value;
  return [
    { stat: 'topSpeed', delta: p.topSpeed.delta, effective: p.topSpeed.effective },
    {
      stat: 'acceleration',
      delta: p.acceleration.delta,
      effective: p.acceleration.effective,
    },
    { stat: 'armor', delta: p.armor.delta, effective: p.armor.effective },
    { stat: 'handling', delta: p.handling.delta, effective: p.handling.effective },
  ];
}

/**
 * Builds one component slot's row: its label, the currently-equipped component,
 * and every catalogue component eligible for the slot with its per-stat delta
 * and resulting effective stat (Req 4.7). Ownership is annotated per candidate
 * so the overlay can gate equipping unowned components (Req 4.6).
 *
 * Pure and GPU-free; all stat math flows through {@link previewComponent}.
 */
export function buildComponentSlotRow(
  slot: ComponentSlot,
  loadout: Loadout,
  chassis: ChassisDef,
  components: ReadonlyMap<ComponentId, ComponentDef>,
  ownedComponents: readonly ComponentId[],
): ComponentSlotRow {
  const equippedId = loadout.components[slot];
  const ownedSet = new Set(ownedComponents);

  const candidates: ComponentCandidateRow[] = [];
  for (const def of components.values()) {
    if (def.slot !== slot) continue;
    const stats = buildStatCells(loadout, chassis, components, def.id);
    if (stats === null) continue;
    candidates.push({
      id: def.id,
      name: def.name,
      price: def.price,
      equipped: def.id === equippedId,
      owned: ownedSet.has(def.id),
      stats,
    });
  }

  return {
    slot,
    label: COMPONENT_SLOT_LABELS[slot],
    equippedId,
    candidates,
  };
}

/**
 * Builds every component slot row in {@link COMPONENT_SLOT_ORDER}. Pure.
 */
export function buildComponentSlotRows(
  loadout: Loadout,
  chassis: ChassisDef,
  components: ReadonlyMap<ComponentId, ComponentDef>,
  ownedComponents: readonly ComponentId[],
): ComponentSlotRow[] {
  return COMPONENT_SLOT_ORDER.map((slot) =>
    buildComponentSlotRow(slot, loadout, chassis, components, ownedComponents),
  );
}

// ---------------------------------------------------------------------------
// Weapon slot view-model (owned-only filtering — Req 4.6)
// ---------------------------------------------------------------------------

/** One candidate weapon within a weapon slot picker. */
export interface WeaponCandidateRow {
  readonly id: WeaponId;
  readonly name: string;
  readonly price: number;
  /** `true` when this weapon is the one currently fitted in the slot. */
  readonly equipped: boolean;
}

/** One weapon slot with its owned-only candidate weapons. */
export interface WeaponSlotRow {
  readonly slot: WeaponSlot;
  readonly label: string;
  /** The weapon currently fitted in this slot, or `null` when empty. */
  readonly equippedId: WeaponId | null;
  /**
   * The candidate weapons offered for this slot. Only weapons the player owns
   * AND whose declared slot matches are included (Req 4.4, 4.6). Non-owned
   * weapons never appear here.
   */
  readonly candidates: readonly WeaponCandidateRow[];
}

/**
 * Builds one weapon slot's picker, filtered to weapons the player owns whose
 * declared slot matches `slot`. Non-owned weapons are excluded entirely
 * (Req 4.6). Pure and GPU-free.
 */
export function buildWeaponSlotRow(
  slot: WeaponSlot,
  loadout: Loadout,
  weapons: ReadonlyMap<WeaponId, WeaponDef>,
  ownedWeapons: readonly WeaponId[],
): WeaponSlotRow {
  const equippedId = loadout.weapons[slot];
  const candidates: WeaponCandidateRow[] = [];

  for (const weaponId of ownedWeapons) {
    const def = weapons.get(weaponId);
    if (def === undefined) continue;
    if (def.slot !== slot) continue;
    candidates.push({
      id: def.id,
      name: def.name,
      price: def.price,
      equipped: def.id === equippedId,
    });
  }

  return {
    slot,
    label: WEAPON_SLOT_LABELS[slot],
    equippedId,
    candidates,
  };
}

/**
 * Builds every weapon slot row in {@link WEAPON_SLOT_ORDER}, each filtered to
 * owned weapons only. Pure. Requirement 4.4, 4.6.
 */
export function buildWeaponSlotRows(
  loadout: Loadout,
  weapons: ReadonlyMap<WeaponId, WeaponDef>,
  ownedWeapons: readonly WeaponId[],
): WeaponSlotRow[] {
  return WEAPON_SLOT_ORDER.map((slot) =>
    buildWeaponSlotRow(slot, loadout, weapons, ownedWeapons),
  );
}

// ---------------------------------------------------------------------------
// Full config view-model
// ---------------------------------------------------------------------------

/** The catalogues and ownership the config screen is built from. */
export interface CarConfigInput {
  readonly loadout: Loadout;
  readonly chassisCatalogue: readonly ChassisDef[];
  readonly componentCatalogue: readonly ComponentDef[];
  readonly weaponCatalogue: readonly WeaponDef[];
  readonly ownedComponents: readonly ComponentId[];
  readonly ownedWeapons: readonly WeaponId[];
}

/** The complete GPU-free view-model rendered by the config screen. */
export interface CarConfigViewModel {
  readonly chassisOptions: readonly ChassisOption[];
  /** The currently selected chassis, or `null` when the loadout references an unknown chassis. */
  readonly selectedChassis: ChassisDef | null;
  /** The effective stats of the current loadout, computed via the shared service. */
  readonly effectiveStats: EffectiveCarStats | null;
  readonly componentSlots: readonly ComponentSlotRow[];
  readonly weaponSlots: readonly WeaponSlotRow[];
}

/**
 * Builds the entire car-config view-model: chassis options, the resolved
 * effective stats of the current loadout, per-slot component rows carrying
 * `{ delta, effective }` cells, and owned-filtered weapon slot pickers.
 *
 * All stat math delegates to the shared {@link computeEffectiveStats} /
 * {@link previewComponent}. Pure and GPU-free — the single entry point the unit
 * tests and the overlay both consume. Requirements 4.1–4.7.
 */
export function buildCarConfigViewModel(input: CarConfigInput): CarConfigViewModel {
  const componentMap = indexComponents(input.componentCatalogue);
  const weaponMap = indexWeapons(input.weaponCatalogue);

  const selectedChassis =
    input.chassisCatalogue.find((c) => c.id === input.loadout.chassisId) ?? null;

  const chassisOptions = buildChassisOptions(input.chassisCatalogue, input.loadout);

  const effectiveStats =
    selectedChassis === null
      ? null
      : computeEffectiveStats(input.loadout, selectedChassis, componentMap);

  const componentSlots =
    selectedChassis === null
      ? []
      : buildComponentSlotRows(
          input.loadout,
          selectedChassis,
          componentMap,
          input.ownedComponents,
        );

  const weaponSlots = buildWeaponSlotRows(input.loadout, weaponMap, input.ownedWeapons);

  return {
    chassisOptions,
    selectedChassis,
    effectiveStats,
    componentSlots,
    weaponSlots,
  };
}

/** Formats a stat delta with an explicit sign, e.g. `+8`, `-4`, `0`. */
export function formatDelta(delta: number): string {
  if (delta > 0) return `+${delta}`;
  return String(delta);
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Callbacks the config screen invokes as the player edits the loadout.
 * Injecting these decouples the screen from application state and keeps the
 * wiring testable. Equip attempts are surfaced as intents; the host applies the
 * shared `equipComponent` / `equip` rules and re-renders via {@link CarConfig.setInput}.
 */
export interface CarConfigHandlers {
  onSelectChassis?: (chassisId: ChassisId) => void;
  onEquipComponent?: (slot: ComponentSlot, componentId: ComponentId) => void;
  onEquipWeapon?: (slot: WeaponSlot, weaponId: WeaponId) => void;
  onConfirm?: () => void;
  onClose?: () => void;
}

// ---------------------------------------------------------------------------
// PixiJS overlay (browser-only draw path)
// ---------------------------------------------------------------------------

const PANEL_WIDTH = 640;
const PADDING = 24;
const HEADER_HEIGHT = 44;
const ROW_HEIGHT = 26;

/**
 * The PixiJS car-config screen. A self-contained {@link Container} that draws
 * the chassis picker, component slots (each candidate showing per-stat delta
 * and resulting effective stat), and owned-only weapon pickers derived from a
 * {@link CarConfigInput} via {@link buildCarConfigViewModel}.
 *
 * Construction is GPU-free — PixiJS display objects instantiate without a WebGL
 * context — so the overlay can be created headlessly; only attaching it to a
 * live stage and presenting it requires a renderer. Loadout mutation happens
 * through the injected handlers; call {@link CarConfig.setInput} to re-render.
 */
export class CarConfig extends Container {
  private input: CarConfigInput;
  private readonly handlers: CarConfigHandlers;
  private readonly body: Container;

  constructor(input: CarConfigInput, handlers: CarConfigHandlers = {}) {
    super();
    this.label = 'car-config';
    this.input = input;
    this.handlers = handlers;
    this.body = new Container();
    this.body.label = 'car-config:body';
    this.addChild(this.body);
    this.draw();
  }

  /** The current config input (read-only view). */
  getInput(): CarConfigInput {
    return this.input;
  }

  /** The injected handlers, exposed so a host input layer can dispatch intents. */
  getHandlers(): CarConfigHandlers {
    return this.handlers;
  }

  /** Replaces the config input and re-renders. */
  setInput(next: CarConfigInput): void {
    this.input = next;
    this.draw();
  }

  private draw(): void {
    this.body.removeChildren().forEach((child) => child.destroy({ children: true }));

    const vm = buildCarConfigViewModel(this.input);

    const titleStyle = new TextStyle({
      fill: 0xffcc33,
      fontFamily: 'monospace',
      fontSize: 22,
      fontWeight: 'bold',
    });
    const sectionStyle = new TextStyle({
      fill: 0xffaa33,
      fontFamily: 'monospace',
      fontSize: 16,
      fontWeight: 'bold',
    });
    const labelStyle = new TextStyle({
      fill: 0xffffff,
      fontFamily: 'monospace',
      fontSize: 13,
    });
    const dimStyle = new TextStyle({
      fill: 0x778899,
      fontFamily: 'monospace',
      fontSize: 13,
    });
    const valueStyle = new TextStyle({
      fill: 0x88ccff,
      fontFamily: 'monospace',
      fontSize: 13,
    });

    // Estimate panel height from the number of rows we will draw.
    let rowCount = 1 + vm.chassisOptions.length + 1;
    for (const slot of vm.componentSlots) rowCount += 1 + slot.candidates.length;
    rowCount += 1;
    for (const slot of vm.weaponSlots) rowCount += 1 + Math.max(1, slot.candidates.length);
    const panelHeight = HEADER_HEIGHT + rowCount * ROW_HEIGHT + PADDING * 2;

    const panel = new Graphics();
    panel
      .roundRect(0, 0, PANEL_WIDTH, panelHeight, 8)
      .fill({ color: 0x0a0a12, alpha: 0.92 })
      .stroke({ color: 0x3355aa, width: 2 });
    this.body.addChild(panel);

    const title = new Text({ text: 'CAR CONFIGURATION', style: titleStyle });
    title.position.set(PADDING, PADDING - 6);
    this.body.addChild(title);

    let y = PADDING + HEADER_HEIGHT;

    const addLine = (text: string, x: number, style: TextStyle): void => {
      const t = new Text({ text, style });
      t.position.set(PADDING + x, y);
      this.body.addChild(t);
    };

    // Chassis picker.
    addLine('CHASSIS', 0, sectionStyle);
    y += ROW_HEIGHT;
    for (const opt of vm.chassisOptions) {
      const marker = opt.selected ? '> ' : '  ';
      addLine(`${marker}${opt.name}`, 12, opt.selected ? valueStyle : labelStyle);
      y += ROW_HEIGHT;
    }

    // Component slots.
    addLine('COMPONENTS', 0, sectionStyle);
    y += ROW_HEIGHT;
    for (const slot of vm.componentSlots) {
      addLine(slot.label, 12, labelStyle);
      y += ROW_HEIGHT;
      for (const cand of slot.candidates) {
        const marker = cand.equipped ? '* ' : cand.owned ? '  ' : 'x ';
        const deltas = cand.stats
          .filter((s) => s.delta !== 0)
          .map((s) => `${CONFIG_STAT_LABELS[s.stat]} ${formatDelta(s.delta)}→${s.effective}`)
          .join('  ');
        addLine(`${marker}${cand.name}`, 24, cand.owned ? labelStyle : dimStyle);
        addLine(deltas || '(no change)', 220, cand.owned ? valueStyle : dimStyle);
        y += ROW_HEIGHT;
      }
    }

    // Weapon slots (owned only).
    addLine('WEAPONS', 0, sectionStyle);
    y += ROW_HEIGHT;
    for (const slot of vm.weaponSlots) {
      addLine(slot.label, 12, labelStyle);
      y += ROW_HEIGHT;
      if (slot.candidates.length === 0) {
        addLine('(none owned)', 24, dimStyle);
        y += ROW_HEIGHT;
        continue;
      }
      for (const cand of slot.candidates) {
        const marker = cand.equipped ? '* ' : '  ';
        addLine(`${marker}${cand.name}`, 24, labelStyle);
        y += ROW_HEIGHT;
      }
    }
  }
}
