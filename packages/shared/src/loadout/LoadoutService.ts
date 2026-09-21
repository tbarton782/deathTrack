/**
 * Loadout configuration service for the Deathtrack Multiplayer Recreation.
 *
 * This module owns the pure business rules governing how a player configures a
 * car before a race:
 *
 *   - one weapon per weapon slot (Req 4.4), one component per component slot
 *     (Req 4.2), both drawn only from the available catalogue;
 *   - components may only be equipped if the player owns them (Req 4.6);
 *   - effective stats are the additive sum of chassis base stats plus every
 *     equipped component's deltas, clamped to each stat's defined maximum
 *     (Req 4.3);
 *   - confirming a loadout produces an immutable {@link ResolvedLoadout} and
 *     locks out further changes for the duration of the race (Req 4.5).
 *
 * Every function here is pure: inputs are never mutated, and each mutating
 * operation returns a fresh {@link Loadout}. This keeps the service safe for
 * use on both client and server and trivially testable.
 *
 * Requirements: 4.2, 4.3, 4.4, 4.5, 4.6, 4.7
 */

import type {
  ChassisId,
  ComponentId,
  ComponentSlot,
  WeaponId,
  WeaponSlot,
} from '../types/primitives.js';
import type {
  CarBaseStats,
  ChassisDef,
  ComponentDef,
  EffectiveCarStats,
  Loadout,
  ResolvedLoadout,
} from '../types/car.js';
import type { WeaponDef } from '../types/weapons.js';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * A minimal success/failure result used by the loadout operations that can be
 * rejected (equipping a weapon into an occupied slot, equipping an unowned or
 * unknown component, etc.).
 *
 * `ok: true` carries the produced `value`; `ok: false` carries a machine
 * readable `error` code plus a human-readable `message` suitable for display.
 */
export type Result<T, E = LoadoutError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E; readonly message: string };

/** Machine-readable rejection codes for loadout operations. */
export type LoadoutError =
  /** The target weapon slot already holds a weapon. Requirements: 4.4 */
  | 'slot_occupied'
  /** The weapon id is not present in the supplied catalogue. Requirements: 4.4 */
  | 'weapon_not_in_catalogue'
  /** The weapon's declared slot does not match the requested slot. Requirements: 4.4 */
  | 'weapon_slot_mismatch'
  /** The component id is not present in the supplied catalogue. Requirements: 4.2 */
  | 'component_not_in_catalogue'
  /** The component's declared slot does not match the requested slot. Requirements: 4.2 */
  | 'component_slot_mismatch'
  /** The player has not purchased the component. Requirements: 4.6 */
  | 'component_not_owned';

function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

function err<T>(error: LoadoutError, message: string): Result<T> {
  return { ok: false, error, message };
}

// ---------------------------------------------------------------------------
// Stat maxima
// ---------------------------------------------------------------------------

/**
 * The upper bound applied to each effective stat, per the design's stat ranges
 * (top-speed / acceleration / handling are 1–100; armor is 1–200). Effective
 * stats are clamped to `[0, max]`.
 *
 * Requirements: 4.3
 */
export const STAT_MAXIMA: Readonly<CarBaseStats> = {
  topSpeed: 100,
  acceleration: 100,
  armor: 200,
  handling: 100,
};

/**
 * Base mass added to every car before the armor contribution. `mass` is a
 * derived stat (not stored in the loadout) used by collision impulse math.
 */
export const CHASSIS_BASE_MASS = 1000;

/** Mass added per point of effective armor. */
export const MASS_PER_ARMOR = 5;

// ---------------------------------------------------------------------------
// Weapon equipping
// ---------------------------------------------------------------------------

/**
 * Equip a weapon into a weapon slot, enforcing the one-weapon-per-slot rule.
 *
 * Rejects when:
 *   - the target slot is already occupied (`slot_occupied`);
 *   - the weapon is not in the supplied catalogue (`weapon_not_in_catalogue`);
 *   - the weapon's own declared slot differs from `slot` (`weapon_slot_mismatch`).
 *
 * On success returns a new {@link Loadout} with the weapon placed; the input
 * loadout is never mutated.
 *
 * Requirements: 4.4
 */
export function equip(
  loadout: Loadout,
  slot: WeaponSlot,
  weaponId: WeaponId,
  catalogue: ReadonlyMap<WeaponId, WeaponDef>,
): Result<Loadout> {
  const def = catalogue.get(weaponId);
  if (def === undefined) {
    return err(
      'weapon_not_in_catalogue',
      `Weapon "${weaponId}" is not in the catalogue.`,
    );
  }
  if (def.slot !== slot) {
    return err(
      'weapon_slot_mismatch',
      `Weapon "${weaponId}" occupies the "${def.slot}" slot, not "${slot}".`,
    );
  }
  if (loadout.weapons[slot] !== null) {
    return err(
      'slot_occupied',
      `The "${slot}" weapon slot is already occupied by "${loadout.weapons[slot]}".`,
    );
  }

  return ok({
    ...loadout,
    weapons: { ...loadout.weapons, [slot]: weaponId },
  });
}

// ---------------------------------------------------------------------------
// Component equipping
// ---------------------------------------------------------------------------

/**
 * Equip a component into a component slot.
 *
 * Rejects when:
 *   - the component is not in the supplied catalogue (`component_not_in_catalogue`);
 *   - the component's declared slot differs from `slot` (`component_slot_mismatch`);
 *   - the player does not own the component (`component_not_owned`).
 *
 * Unlike weapons, component slots are overwrite-on-equip (a player may swap the
 * engine for a different owned engine); the one-per-slot invariant is preserved
 * because each slot holds a single `ComponentId | null`.
 *
 * On success returns a new {@link Loadout}; the input loadout is never mutated.
 *
 * Requirements: 4.2, 4.6
 */
export function equipComponent(
  loadout: Loadout,
  slot: ComponentSlot,
  componentId: ComponentId,
  catalogue: ReadonlyMap<ComponentId, ComponentDef>,
  ownedComponents: readonly ComponentId[],
): Result<Loadout> {
  const def = catalogue.get(componentId);
  if (def === undefined) {
    return err(
      'component_not_in_catalogue',
      `Component "${componentId}" is not in the catalogue.`,
    );
  }
  if (def.slot !== slot) {
    return err(
      'component_slot_mismatch',
      `Component "${componentId}" occupies the "${def.slot}" slot, not "${slot}".`,
    );
  }
  if (!ownedComponents.includes(componentId)) {
    return err(
      'component_not_owned',
      `Component "${componentId}" has not been purchased.`,
    );
  }

  return ok({
    ...loadout,
    components: { ...loadout.components, [slot]: componentId },
  });
}

// ---------------------------------------------------------------------------
// Effective stats
// ---------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Compute the effective car stats: the additive sum of the chassis base stats
 * and every equipped component's deltas, with each stat clamped to `[0, max]`.
 *
 * `components` is the resolved catalogue keyed by id; component ids in the
 * loadout that are absent from the map are ignored (defensive — a confirmed
 * loadout should never reference an unknown component).
 *
 * The derived `mass` is computed from the clamped effective armor.
 *
 * Requirements: 4.3, 4.7
 */
export function computeEffectiveStats(
  loadout: Loadout,
  chassis: ChassisDef,
  components: ReadonlyMap<ComponentId, ComponentDef>,
): EffectiveCarStats {
  let topSpeed = chassis.baseStats.topSpeed;
  let acceleration = chassis.baseStats.acceleration;
  let armor = chassis.baseStats.armor;
  let handling = chassis.baseStats.handling;

  for (const componentId of Object.values(loadout.components)) {
    if (componentId === null) continue;
    const def = components.get(componentId);
    if (def === undefined) continue;
    const d = def.statDeltas;
    if (d.topSpeed !== undefined) topSpeed += d.topSpeed;
    if (d.acceleration !== undefined) acceleration += d.acceleration;
    if (d.armor !== undefined) armor += d.armor;
    if (d.handling !== undefined) handling += d.handling;
  }

  const clampedArmor = clamp(armor, 0, STAT_MAXIMA.armor);

  return {
    topSpeed: clamp(topSpeed, 0, STAT_MAXIMA.topSpeed),
    acceleration: clamp(acceleration, 0, STAT_MAXIMA.acceleration),
    armor: clampedArmor,
    handling: clamp(handling, 0, STAT_MAXIMA.handling),
    mass: CHASSIS_BASE_MASS + clampedArmor * MASS_PER_ARMOR,
  };
}

// ---------------------------------------------------------------------------
// Component preview (Requirement 4.7)
// ---------------------------------------------------------------------------

/** Per-stat preview of equipping (or considering) a component. Requirements: 4.7 */
export interface StatPreview {
  /** The stat delta the component would apply (0 when it does not touch this stat). */
  readonly delta: number;
  /** The resulting effective stat value if the component were equipped. */
  readonly effective: number;
}

/** Preview for all four canonical stats. Requirements: 4.7 */
export interface ComponentStatPreview {
  readonly topSpeed: StatPreview;
  readonly acceleration: StatPreview;
  readonly armor: StatPreview;
  readonly handling: StatPreview;
}

/**
 * Produce a per-stat preview showing both the delta a component would apply and
 * the resulting clamped effective stat if it were equipped into its slot,
 * starting from the current loadout.
 *
 * Requirements: 4.7
 */
export function previewComponent(
  loadout: Loadout,
  chassis: ChassisDef,
  components: ReadonlyMap<ComponentId, ComponentDef>,
  componentId: ComponentId,
): Result<ComponentStatPreview> {
  const def = components.get(componentId);
  if (def === undefined) {
    return err(
      'component_not_in_catalogue',
      `Component "${componentId}" is not in the catalogue.`,
    );
  }

  const withComponent: Loadout = {
    ...loadout,
    components: { ...loadout.components, [def.slot]: componentId },
  };
  const after = computeEffectiveStats(withComponent, chassis, components);

  const d = def.statDeltas;
  return ok({
    topSpeed: { delta: d.topSpeed ?? 0, effective: after.topSpeed },
    acceleration: { delta: d.acceleration ?? 0, effective: after.acceleration },
    armor: { delta: d.armor ?? 0, effective: after.armor },
    handling: { delta: d.handling ?? 0, effective: after.handling },
  });
}

// ---------------------------------------------------------------------------
// Confirming a loadout
// ---------------------------------------------------------------------------

/**
 * Confirm a loadout for a race: compute the effective stats and initial ammo
 * for every equipped weapon and return a frozen {@link ResolvedLoadout}. The
 * returned object (and its nested `components`/`weapons`) is deep-frozen so any
 * attempt to mutate it after confirmation throws in strict mode, enforcing the
 * "locked for the duration of the race" rule.
 *
 * Requirements: 4.5, 4.3
 */
export function confirmLoadout(
  loadout: Loadout,
  chassis: ChassisDef,
  components: ReadonlyMap<ComponentId, ComponentDef>,
  weaponCatalogue: ReadonlyMap<WeaponId, WeaponDef>,
): ResolvedLoadout {
  const effectiveStats = computeEffectiveStats(loadout, chassis, components);

  const initialAmmo = new Map<WeaponId, number>();
  for (const weaponId of Object.values(loadout.weapons)) {
    if (weaponId === null) continue;
    const def = weaponCatalogue.get(weaponId);
    if (def === undefined) continue;
    initialAmmo.set(weaponId, def.ammoMax);
  }

  const resolved: ResolvedLoadout = {
    chassisId: loadout.chassisId,
    components: { ...loadout.components },
    weapons: { ...loadout.weapons },
    effectiveStats: { ...effectiveStats },
    initialAmmo,
  };

  Object.freeze(resolved.components);
  Object.freeze(resolved.weapons);
  Object.freeze(resolved.effectiveStats);
  Object.freeze(resolved);
  return resolved;
}

// ---------------------------------------------------------------------------
// Race lock (Requirement 4.5)
// ---------------------------------------------------------------------------

/**
 * Returns `true` when an equip/unequip/component-change attempt must be
 * rejected because a race is currently active. Callers gate mutating loadout
 * operations on the negation of this.
 *
 * Requirements: 4.5
 */
export function rejectEquipDuringRace(isRaceActive: boolean): boolean {
  return isRaceActive;
}

// ---------------------------------------------------------------------------
// Convenience factory
// ---------------------------------------------------------------------------

/** Create an empty loadout for a chassis with all slots unequipped. */
export function emptyLoadout(chassisId: ChassisId): Loadout {
  return {
    chassisId,
    components: {
      engine: null,
      brakes: null,
      transmission: null,
      tires: null,
      airfoil: null,
      armor: null,
    },
    weapons: {
      forward: null,
      rear: null,
      side_spike: null,
      ram: null,
    },
  };
}
