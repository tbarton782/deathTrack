/**
 * Authored gameplay catalogue for the Death Track recreation.
 *
 * **This is intentional design data, NOT reverse-engineered from the original
 * game.** The original Death Track's numeric car/weapon balance is not present
 * in its shipped asset files (the `.TBL` files are 3D vector meshes, not stat
 * tables — see tasks.md §25.8), so these values are defined here as the
 * recreation's own balance. They satisfy the spec's structural requirements:
 *
 * - Req 4.1: three selectable chassis, each with independently-defined base
 *   stats where no two chassis share identical values across all four base
 *   stats (top-speed, acceleration, armor, handling).
 * - Req 4.2/4.3: one purchasable component per upgrade slot (engine, brakes,
 *   transmission, tires, airfoil, armor), each with additive stat deltas.
 * - Req 3.1/3.9/4.4: a weapon per `WeaponId`, each assigned to the correct
 *   loadout slot with damage / beam-DPS / projectile-speed / ammo / range /
 *   price.
 *
 * All stats stay within the ranges the shared services clamp to
 * ({@link STAT_MAXIMA}: top-speed/acceleration/handling ≤ 100, armor ≤ 200).
 * These arrays are the source the `CarConfig`/`Shop` overlays and the career
 * runtime consume; the loader's `loadWeaponTable()` may later override the
 * weapon list from a converted asset if one is ever produced.
 *
 * Requirements: 3.1, 4.1, 4.2, 4.3
 */

import type { ChassisDef, ComponentDef } from '../types/car.js';
import type { WeaponDef } from '../types/weapons.js';

/**
 * The three selectable chassis. Base stats are deliberately distinct across the
 * four axes so no two chassis are identical on all four (Req 4.1): the Hellcat
 * is a balanced all-rounder, the Crusher trades speed/handling for heavy armor,
 * and the Pitbull is a light, fast, nimble glass cannon.
 */
export const CHASSIS_CATALOGUE: readonly ChassisDef[] = [
  {
    id: 'hellcat',
    name: 'Hellcat',
    baseStats: { topSpeed: 70, acceleration: 65, armor: 100, handling: 70 },
    spriteSheet: { path: 'assets/sprites/MYCAR0.dtasset' },
  },
  {
    id: 'crusher',
    name: 'Crusher',
    baseStats: { topSpeed: 55, acceleration: 50, armor: 160, handling: 45 },
    spriteSheet: { path: 'assets/sprites/MYCAR1.dtasset' },
  },
  {
    id: 'pitbull',
    name: 'Pitbull',
    baseStats: { topSpeed: 85, acceleration: 80, armor: 70, handling: 85 },
    spriteSheet: { path: 'assets/sprites/MYCAR2.dtasset' },
  },
];

/**
 * Purchasable upgrade components — one per {@link ComponentSlot}. Each applies
 * additive deltas on top of the chassis base stats; the shared
 * `computeEffectiveStats` clamps the result into `[0, STAT_MAXIMA]`. Prices are
 * in whole career-currency units. Each slot offers a single tier here; more
 * tiers can be appended without touching the consumers.
 */
export const COMPONENT_CATALOGUE: readonly ComponentDef[] = [
  {
    id: 'engine_v8',
    slot: 'engine',
    name: 'V8 Engine',
    price: 1200,
    statDeltas: { topSpeed: 15 },
  },
  {
    id: 'brakes_sport',
    slot: 'brakes',
    name: 'Sport Brakes',
    price: 700,
    statDeltas: { handling: 8 },
  },
  {
    id: 'transmission_close',
    slot: 'transmission',
    name: 'Close-Ratio Transmission',
    price: 900,
    statDeltas: { acceleration: 15 },
  },
  {
    id: 'tires_racing',
    slot: 'tires',
    name: 'Racing Tires',
    price: 800,
    statDeltas: { handling: 12, topSpeed: 3 },
  },
  {
    id: 'airfoil_downforce',
    slot: 'airfoil',
    name: 'Downforce Airfoil',
    price: 600,
    statDeltas: { handling: 10, topSpeed: -2 },
  },
  {
    id: 'armor_reinforced',
    slot: 'armor',
    name: 'Reinforced Armor Plating',
    price: 1500,
    statDeltas: { armor: 40, topSpeed: -3 },
  },
];

/**
 * The weapon catalogue — one entry per {@link WeaponId}, each assigned to its
 * loadout slot (forward guns, rear-drop hazards, side spike, ram). `beamDPS` is
 * set for the continuous laser/beam weapons (`damage` ignored there);
 * `projectileSpeed`/`rangeUnits` are `null` for contact/hazard weapons.
 */
export const WEAPON_CATALOGUE: readonly WeaponDef[] = [
  {
    id: 'machine_gun',
    name: 'Machine Gun',
    category: 'forward',
    damage: 4,
    beamDPS: null,
    projectileSpeed: 400,
    ammoMax: 300,
    rangeUnits: 300,
    price: 500,
    slot: 'forward',
  },
  {
    id: 'laser',
    name: 'Laser',
    category: 'forward',
    damage: 0,
    beamDPS: 40,
    projectileSpeed: null,
    ammoMax: 120,
    rangeUnits: 250,
    price: 1400,
    slot: 'forward',
  },
  {
    id: 'beam_cannon',
    name: 'Beam Cannon',
    category: 'forward',
    damage: 0,
    beamDPS: 70,
    projectileSpeed: null,
    ammoMax: 60,
    rangeUnits: null,
    price: 2600,
    slot: 'forward',
  },
  {
    id: 'missile',
    name: 'Missile',
    category: 'forward',
    damage: 45,
    beamDPS: null,
    projectileSpeed: 300,
    ammoMax: 20,
    rangeUnits: 500,
    price: 1800,
    slot: 'forward',
  },
  {
    id: 'terminator',
    name: 'Terminator',
    category: 'forward',
    damage: 80,
    beamDPS: null,
    projectileSpeed: 260,
    ammoMax: 8,
    rangeUnits: 450,
    price: 3500,
    slot: 'forward',
  },
  {
    id: 'mine',
    name: 'Mine',
    category: 'rear_drop',
    damage: 60,
    beamDPS: null,
    projectileSpeed: null,
    ammoMax: 12,
    rangeUnits: null,
    price: 900,
    slot: 'rear',
  },
  {
    id: 'caltrop',
    name: 'Caltrop',
    category: 'rear_drop',
    damage: 20,
    beamDPS: null,
    projectileSpeed: null,
    ammoMax: 30,
    rangeUnits: null,
    price: 400,
    slot: 'rear',
  },
  {
    id: 'wheel_spike',
    name: 'Wheel Spike',
    category: 'spike',
    damage: 15,
    beamDPS: null,
    projectileSpeed: null,
    ammoMax: 999,
    rangeUnits: null,
    price: 600,
    slot: 'side_spike',
  },
  {
    id: 'ram',
    name: 'Ram Plate',
    category: 'ram',
    damage: 25,
    beamDPS: null,
    projectileSpeed: null,
    ammoMax: 999,
    rangeUnits: null,
    price: 1000,
    slot: 'ram',
  },
];

/** Look up a chassis definition by id, or `undefined` if unknown. */
export function findChassis(id: string): ChassisDef | undefined {
  return CHASSIS_CATALOGUE.find((c) => c.id === id);
}

/**
 * The fixed starting money balance for a new career (Req 5.10). Authored design
 * data — the original game's economy is not recoverable from its assets. Chosen
 * so a fresh player can afford one or two of the cheaper components/weapons but
 * must earn prize money for the higher tiers (the machine gun is 500, the
 * terminator 3500 — see {@link WEAPON_CATALOGUE}).
 */
export const INITIAL_CAREER_MONEY = 2000;
