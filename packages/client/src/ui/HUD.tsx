import { Container, Text, TextStyle } from 'pixi.js';
import type {
  CarRaceState,
  Loadout,
  WeaponConfig,
  WeaponId,
  WeaponSlot,
} from '@deathtrack/shared';

/**
 * In-race Heads-Up Display (task 17.1).
 *
 * During a race the game overlays the local player's live status: current
 * speed, remaining armor, per-weapon ammunition, the current lap, the player's
 * placement, and a warning when a homing weapon has locked onto the player's
 * car (Requirement 11.1).
 *
 * This module follows the same convention as {@link MainMenu} and
 * {@link RaceResults}: all GPU-free logic — formatting, the ammo-row model, the
 * homing-warning decision, and the aggregate HUD model — lives in pure,
 * exported functions that are unit-tested headlessly. The PixiJS
 * {@link Container} overlay ({@link HUD}) only consumes an already-computed
 * {@link HudModel} to draw text and indicators. The `.tsx` extension matches
 * the established UI convention for this package: these files are PixiJS
 * overlays, not React component trees. The pixel draw path requires a WebGL
 * context and is verified in the browser, not in the headless tests.
 */

// ---------------------------------------------------------------------------
// Homing weapons
// ---------------------------------------------------------------------------

/**
 * The weapon types that home in on / acquire a target and therefore trigger the
 * HUD's incoming-threat warning (Requirement 11.1). In Deathtrack the guided
 * forward weapons are the missile and the terminator.
 */
export const HOMING_WEAPON_IDS: readonly WeaponId[] = ['missile', 'terminator'];

/** Returns `true` if `weaponId` is a homing weapon that can acquire a target. */
export function isHomingWeapon(weaponId: WeaponId): boolean {
  return HOMING_WEAPON_IDS.includes(weaponId);
}

/**
 * A homing threat currently tracking a car. The renderer / simulation supplies
 * one of these for every in-flight homing projectile that has acquired a lock,
 * along with the participant it is chasing.
 */
export interface IncomingHomingThreat {
  /** The homing weapon that produced the tracking projectile. */
  readonly weaponId: WeaponId;
  /** The participant slot the projectile has acquired as its target. */
  readonly targetId: number;
}

/**
 * Decides whether the homing-weapon warning indicator should be shown for the
 * local player.
 *
 * The warning is active when at least one incoming threat is (a) a homing
 * weapon and (b) has acquired the local player's car (`targetId ===
 * playerId`). Non-homing entries and threats aimed at other participants are
 * ignored, so a stray malformed entry never falsely arms the warning.
 *
 * Pure and GPU-free.
 *
 * @param threats - All currently-tracking homing projectiles.
 * @param playerId - The local player's participant slot.
 */
export function isHomingWarningActive(
  threats: readonly IncomingHomingThreat[],
  playerId: number,
): boolean {
  return threats.some(
    (t) => t.targetId === playerId && isHomingWeapon(t.weaponId),
  );
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure, GPU-free, unit-testable)
// ---------------------------------------------------------------------------

/**
 * Formats a scalar speed (track-space units/second) for display. The value is
 * rounded to the nearest whole unit and suffixed with the mph-style unit label
 * the HUD uses. Negative inputs are clamped to zero (speed is always ≥ 0).
 */
export function formatSpeed(speed: number): string {
  const rounded = Math.max(0, Math.round(speed));
  return `${rounded} MPH`;
}

/**
 * Formats the current armor for display as a whole number, clamped to be
 * non-negative (a destroyed car reads `0`, never a negative value).
 */
export function formatArmor(armor: number): string {
  return String(Math.max(0, Math.round(armor)));
}

/**
 * Formats the current lap. When the total number of laps is known it renders
 * `LAP n/total`; otherwise just `LAP n`. The lap number is clamped to at least
 * 1 (laps are 1-indexed).
 */
export function formatLap(lap: number, totalLaps?: number): string {
  const current = Math.max(1, Math.trunc(lap));
  if (totalLaps !== undefined && totalLaps > 0) {
    return `LAP ${current}/${Math.trunc(totalLaps)}`;
  }
  return `LAP ${current}`;
}

/** Renders a placement as an ordinal string (1 → "1st", 2 → "2nd", ...). */
export function formatPlacement(placement: number): string {
  const abs = Math.abs(placement);
  const mod100 = abs % 100;
  const mod10 = abs % 10;
  let suffix = 'th';
  if (mod100 < 11 || mod100 > 13) {
    if (mod10 === 1) suffix = 'st';
    else if (mod10 === 2) suffix = 'nd';
    else if (mod10 === 3) suffix = 'rd';
  }
  return `${placement}${suffix}`;
}

// ---------------------------------------------------------------------------
// Ammo row model (pure, GPU-free, unit-testable)
// ---------------------------------------------------------------------------

/** The four weapon slots, in the fixed top-to-bottom HUD display order. */
export const WEAPON_SLOT_ORDER: readonly WeaponSlot[] = [
  'forward',
  'rear',
  'side_spike',
  'ram',
];

/** A single ammo readout row: one per equipped weapon, in slot order. */
export interface AmmoRow {
  /** The slot this weapon occupies. */
  readonly slot: WeaponSlot;
  /** The equipped weapon's identifier. */
  readonly weaponId: WeaponId;
  /** Human-readable weapon name (from the weapon config). */
  readonly name: string;
  /** Live ammo remaining. Zero when the weapon is out of ammo. */
  readonly ammo: number;
  /** Configured maximum ammo capacity for this weapon. */
  readonly ammoMax: number;
}

/**
 * Builds the ordered list of ammo rows for the local player's HUD.
 *
 * Pure and GPU-free. For every weapon slot that has a weapon equipped in
 * `loadout.weapons` (in {@link WEAPON_SLOT_ORDER}), a row is produced pairing
 * the weapon's config-supplied display name and capacity with the car's live
 * ammo count. Empty slots are skipped. A weapon absent from `weaponConfigs` is
 * skipped (the HUD only shows weapons it can describe). Live ammo missing from
 * `ammo` is treated as zero.
 *
 * @param loadout - The player's equipped weapons per slot.
 * @param ammo - Live ammo counts keyed by weapon id (from `CarRaceState.ammo`).
 * @param weaponConfigs - Weapon definitions keyed by weapon id, used for the
 *   display name and configured `ammoMax`.
 */
export function buildAmmoRows(
  loadout: Loadout,
  ammo: ReadonlyMap<WeaponId, number>,
  weaponConfigs: ReadonlyMap<WeaponId, WeaponConfig>,
): AmmoRow[] {
  const rows: AmmoRow[] = [];
  for (const slot of WEAPON_SLOT_ORDER) {
    const weaponId = loadout.weapons[slot];
    if (weaponId === null) continue;
    const config = weaponConfigs.get(weaponId);
    if (config === undefined) continue;
    rows.push({
      slot,
      weaponId,
      name: config.name,
      ammo: ammo.get(weaponId) ?? 0,
      ammoMax: config.ammoMax,
    });
  }
  return rows;
}

/** Formats a single ammo row's count as `current/max`. */
export function formatAmmo(row: AmmoRow): string {
  return `${Math.max(0, Math.trunc(row.ammo))}/${Math.trunc(row.ammoMax)}`;
}

// ---------------------------------------------------------------------------
// Aggregate HUD model (pure, GPU-free, unit-testable)
// ---------------------------------------------------------------------------

/**
 * The complete, already-resolved data the HUD overlay needs to draw. Produced
 * by {@link buildHudModel} from live race state so the overlay itself performs
 * no domain logic.
 */
export interface HudModel {
  /** Formatted speed string, e.g. "72 MPH". */
  readonly speed: string;
  /** Formatted armor string, e.g. "134". */
  readonly armor: string;
  /** Formatted lap string, e.g. "LAP 2/5". */
  readonly lap: string;
  /** Formatted placement string, e.g. "3rd". */
  readonly placement: string;
  /** Ammo rows in slot order. */
  readonly ammoRows: AmmoRow[];
  /** Whether the incoming homing-weapon warning is active. */
  readonly homingWarning: boolean;
}

/** Optional context for {@link buildHudModel}. */
export interface HudModelOptions {
  /** Total laps in the race, used to render `LAP n/total`. */
  readonly totalLaps?: number;
  /** Incoming homing threats currently tracking any car. */
  readonly homingThreats?: readonly IncomingHomingThreat[];
}

/**
 * Builds the aggregate {@link HudModel} for the local player from their live
 * {@link CarRaceState}, equipped {@link Loadout}, and weapon configs.
 *
 * Pure and GPU-free: it combines the individual formatting helpers,
 * {@link buildAmmoRows}, and {@link isHomingWarningActive} into a single value
 * the overlay renders directly. The player's participant slot is read from
 * `car.participantId`, so the homing warning arms only for threats that have
 * acquired the local car.
 *
 * @param car - The local player's live race state.
 * @param loadout - The player's equipped weapons.
 * @param weaponConfigs - Weapon definitions keyed by weapon id.
 * @param options - Optional total-lap count and incoming homing threats.
 */
export function buildHudModel(
  car: CarRaceState,
  loadout: Loadout,
  weaponConfigs: ReadonlyMap<WeaponId, WeaponConfig>,
  options: HudModelOptions = {},
): HudModel {
  return {
    speed: formatSpeed(car.physics.speed),
    armor: formatArmor(car.currentArmor),
    lap: formatLap(car.lap, options.totalLaps),
    placement: formatPlacement(car.placement),
    ammoRows: buildAmmoRows(loadout, car.ammo, weaponConfigs),
    homingWarning: isHomingWarningActive(
      options.homingThreats ?? [],
      car.participantId,
    ),
  };
}

// ---------------------------------------------------------------------------
// PixiJS overlay (browser-only draw path)
// ---------------------------------------------------------------------------

/** Layout constants for the HUD draw, in logical pixels. */
const MARGIN = 16;
const LINE_HEIGHT = 22;
const AMMO_ROW_HEIGHT = 18;

const LABEL_COLOR = 0x88ccff;
const VALUE_COLOR = 0xffffff;
const WARNING_COLOR = 0xff3322;

function labelStyle(): TextStyle {
  return new TextStyle({
    fill: LABEL_COLOR,
    fontFamily: 'monospace',
    fontSize: 13,
    fontWeight: 'bold',
  });
}

function valueStyle(): TextStyle {
  return new TextStyle({
    fill: VALUE_COLOR,
    fontFamily: 'monospace',
    fontSize: 18,
    fontWeight: 'bold',
  });
}

function ammoStyle(): TextStyle {
  return new TextStyle({
    fill: VALUE_COLOR,
    fontFamily: 'monospace',
    fontSize: 13,
  });
}

/**
 * In-race HUD overlay. A self-contained PixiJS {@link Container} that draws the
 * local player's speed, armor, per-weapon ammo, lap, placement, and the homing
 * warning indicator.
 *
 * Construction is GPU-free (PixiJS display objects instantiate without a WebGL
 * context); only attaching the container to a live stage and presenting it
 * requires a renderer. Call {@link HUD.update} each frame with a freshly-built
 * {@link HudModel} (from {@link buildHudModel}) to refresh the readouts.
 */
export class HUD extends Container {
  private model: HudModel;

  /** Screen width used to right-align the placement/lap column. */
  private readonly screenWidth: number;

  private readonly speedText: Text;
  private readonly armorText: Text;
  private readonly lapText: Text;
  private readonly placementText: Text;
  private readonly ammoContainer: Container;
  private readonly warningText: Text;

  /**
   * @param model - Initial HUD model to display.
   * @param screenWidth - Playfield width in logical pixels, used to position
   *   the right-aligned lap/placement column. Defaults to 640.
   */
  constructor(model: HudModel, screenWidth = 640) {
    super();
    this.label = 'hud';
    this.model = model;
    this.screenWidth = screenWidth;

    // Left column: speed + armor.
    const speedLabel = new Text({ text: 'SPEED', style: labelStyle() });
    speedLabel.position.set(MARGIN, MARGIN);
    this.addChild(speedLabel);

    this.speedText = new Text({ text: model.speed, style: valueStyle() });
    this.speedText.label = 'hud:speed';
    this.speedText.position.set(MARGIN, MARGIN + LINE_HEIGHT * 0.75);
    this.addChild(this.speedText);

    const armorLabel = new Text({ text: 'ARMOR', style: labelStyle() });
    armorLabel.position.set(MARGIN, MARGIN + LINE_HEIGHT * 2);
    this.addChild(armorLabel);

    this.armorText = new Text({ text: model.armor, style: valueStyle() });
    this.armorText.label = 'hud:armor';
    this.armorText.position.set(MARGIN, MARGIN + LINE_HEIGHT * 2.75);
    this.addChild(this.armorText);

    // Right column: lap + placement.
    this.lapText = new Text({ text: model.lap, style: valueStyle() });
    this.lapText.label = 'hud:lap';
    this.lapText.anchor.set(1, 0);
    this.lapText.position.set(this.screenWidth - MARGIN, MARGIN);
    this.addChild(this.lapText);

    this.placementText = new Text({
      text: model.placement,
      style: valueStyle(),
    });
    this.placementText.label = 'hud:placement';
    this.placementText.anchor.set(1, 0);
    this.placementText.position.set(
      this.screenWidth - MARGIN,
      MARGIN + LINE_HEIGHT,
    );
    this.addChild(this.placementText);

    // Ammo column (bottom-left).
    this.ammoContainer = new Container();
    this.ammoContainer.label = 'hud:ammo';
    this.addChild(this.ammoContainer);
    this.drawAmmoRows();

    // Homing warning indicator (centred, hidden unless active).
    this.warningText = new Text({
      text: 'MISSILE LOCK',
      style: new TextStyle({
        fill: WARNING_COLOR,
        fontFamily: 'monospace',
        fontSize: 20,
        fontWeight: 'bold',
      }),
    });
    this.warningText.label = 'hud:warning';
    this.warningText.anchor.set(0.5, 0);
    this.warningText.position.set(this.screenWidth / 2, MARGIN);
    this.warningText.visible = model.homingWarning;
    this.addChild(this.warningText);
  }

  /** The model currently rendered by the HUD (read-only view). */
  getModel(): HudModel {
    return this.model;
  }

  /** Refreshes every readout from a freshly-built {@link HudModel}. */
  update(model: HudModel): void {
    this.model = model;
    this.speedText.text = model.speed;
    this.armorText.text = model.armor;
    this.lapText.text = model.lap;
    this.placementText.text = model.placement;
    this.warningText.visible = model.homingWarning;
    this.drawAmmoRows();
  }

  /** Rebuilds the ammo-row display objects from the current model. */
  private drawAmmoRows(): void {
    this.ammoContainer.removeChildren().forEach((child) => child.destroy());
    const baseY = MARGIN + LINE_HEIGHT * 4;
    this.model.ammoRows.forEach((row, index) => {
      const y = baseY + index * AMMO_ROW_HEIGHT;
      const name = new Text({ text: row.name, style: ammoStyle() });
      name.position.set(MARGIN, y);
      this.ammoContainer.addChild(name);

      const count = new Text({ text: formatAmmo(row), style: ammoStyle() });
      count.anchor.set(1, 0);
      count.position.set(MARGIN + 180, y);
      this.ammoContainer.addChild(count);
    });
  }

  /** Tears down the overlay and releases its display objects. */
  override destroy(): void {
    super.destroy({ children: true });
  }
}
