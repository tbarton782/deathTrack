/**
 * Starting-grid builder for a single-player race.
 *
 * Assembles the {@link CarRaceState}[] starting field, the parallel
 * {@link PhysicsCarStats} map, and the {@link RaceParticipant}[] control
 * profiles that {@link RaceLoop} consumes, from a human loadout plus a set of
 * named AI opponents.
 *
 * **Invented layout (documented):** the original game's exact starting-line
 * geometry is not recovered, so cars are placed on a simple back-to-front grid
 * anchored at the track's first road segment, spaced {@link GRID_SPACING} units
 * apart along the road direction with a small lateral stagger. This is a
 * gameplay layout choice, not decoded data.
 *
 * Requirements: 4.5, 5.7
 */

import { confirmLoadout } from '../loadout/LoadoutService.js';
import { CHASSIS_CATALOGUE, COMPONENT_CATALOGUE, WEAPON_CATALOGUE } from '../catalogue/GameCatalogue.js';
import { AI_CHARACTER_ORDER, aiProfileFor } from './aiProfiles.js';
import type { RaceParticipant } from './RaceLoop.js';
import type { PhysicsCarStats } from '../physics/stepPhysics.js';
import type { Loadout, CarRaceState, ComponentDef } from '../types/car.js';
import type { TrackDef } from '../types/track.js';
import type { ParticipantId, ComponentId, WeaponId } from '../types/primitives.js';
import type { AICharacter } from '../types/ai.js';

/** Distance between consecutive grid rows, in track units. */
export const GRID_SPACING = 6;

/** Lateral stagger between adjacent grid slots, in track units. */
const GRID_STAGGER = 3;

/** Display names for the nine AI characters (title-cased). */
const AI_DISPLAY_NAMES: Readonly<Record<AICharacter, string>> = {
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

/** The assembled starting grid a {@link RaceLoop} is constructed from. */
export interface StartingGrid {
  cars: CarRaceState[];
  carStats: Map<ParticipantId, PhysicsCarStats>;
  participants: RaceParticipant[];
}

/** Options for {@link buildStartingGrid}. */
export interface BuildGridOptions {
  /** The track being raced (provides start position + waypoint graph). */
  readonly track: TrackDef;
  /** The human player's confirmed loadout. */
  readonly humanLoadout: Loadout;
  /** The human's chosen display name. */
  readonly humanName: string;
  /**
   * Which AI characters to field. Defaults to all nine (Req 5.7). The human is
   * always participant 0; AI take the remaining slots in order.
   */
  readonly aiCharacters?: readonly AICharacter[];
}

/** Component catalogue indexed by id, for {@link confirmLoadout}. */
function componentIndex(): Map<ComponentId, ComponentDef> {
  const map = new Map<ComponentId, ComponentDef>();
  for (const c of COMPONENT_CATALOGUE) map.set(c.id, c);
  return map;
}

/** Weapon catalogue indexed by id. */
function weaponIndex(): Map<WeaponId, (typeof WEAPON_CATALOGUE)[number]> {
  const map = new Map<WeaponId, (typeof WEAPON_CATALOGUE)[number]>();
  for (const w of WEAPON_CATALOGUE) map.set(w.id, w);
  return map;
}

/** Build a physics stats record from a resolved loadout's effective stats. */
function statsFromEffective(eff: {
  topSpeed: number;
  acceleration: number;
  handling: number;
  armor: number;
  mass: number;
}): PhysicsCarStats {
  return {
    // Scale the design-scale (1..100) stats into physics units. The physics
    // step treats topSpeed/acceleration/brake as unit/s and unit/s²; a modest
    // scale keeps races readable at the 1/60 s step.
    topSpeed: eff.topSpeed,
    acceleration: eff.acceleration,
    brake: Math.max(20, eff.handling),
    handling: eff.handling,
    mass: eff.mass,
    armor: eff.armor,
  };
}

/**
 * Assemble a starting grid: the human (participant 0) plus AI opponents, each
 * with a resolved loadout, a start-line position, and a control profile.
 */
export function buildStartingGrid(options: BuildGridOptions): StartingGrid {
  const { track, humanLoadout, humanName } = options;
  const aiChars = options.aiCharacters ?? AI_CHARACTER_ORDER;

  const chassisById = new Map(CHASSIS_CATALOGUE.map((c) => [c.id, c]));
  const components = componentIndex();
  const weapons = weaponIndex();

  // The grid anchor: the first road segment's centre, or the origin.
  const anchor = track.roadSegments[0]?.centre ?? { x: 0, y: 0 };
  const dir = firstSegmentDirection(track);

  const cars: CarRaceState[] = [];
  const carStats = new Map<ParticipantId, PhysicsCarStats>();
  const participants: RaceParticipant[] = [];

  const place = (
    id: ParticipantId,
    loadout: Loadout,
    displayName: string,
    isAI: boolean,
    character: AICharacter | null,
  ): void => {
    const chassis = chassisById.get(loadout.chassisId) ?? CHASSIS_CATALOGUE[0]!;
    const resolved = confirmLoadout(loadout, chassis, components, weapons);

    // Back-to-front grid: row `id` sits `id * GRID_SPACING` behind the anchor
    // along the reverse road direction, with an alternating lateral stagger.
    const back = id * GRID_SPACING;
    const lateral = (id % 2 === 0 ? 1 : -1) * GRID_STAGGER;
    const px = anchor.x - dir.x * back + -dir.y * lateral;
    const py = anchor.y - dir.y * back + dir.x * lateral;
    const heading = Math.atan2(dir.x, dir.y); // heading 0 = +Y, clockwise

    const forwardWeaponId = loadout.weapons.forward;
    const rearWeaponId = loadout.weapons.rear;
    const forwardDef = forwardWeaponId ? weapons.get(forwardWeaponId) : undefined;

    cars.push({
      participantId: id,
      physics: {
        id,
        position: { x: px, y: py },
        velocity: { x: 0, y: 0 },
        heading,
        speed: 0,
        angularVelocity: 0,
        onTrack: true,
        airborne: false,
        airborneHeight: 0,
        airborneVY: 0,
      },
      currentArmor: resolved.effectiveStats.armor,
      ammo: new Map(resolved.initialAmmo),
      eliminated: false,
      lap: 1,
      placement: id + 1,
      waypointIndex: 0,
    });

    carStats.set(id, statsFromEffective(resolved.effectiveStats));

    participants.push({
      participantId: id,
      displayName,
      isAI,
      ...(isAI && character ? { aiConfig: aiProfileFor(character) } : {}),
      forwardWeaponId: forwardWeaponId ?? null,
      rearWeaponId: rearWeaponId ?? null,
      forwardWeaponRange: forwardDef?.rangeUnits ?? null,
    });
  };

  // Human is participant 0.
  place(0, humanLoadout, humanName, false, null);

  // AI opponents take slots 1..N. Each AI drives the default chassis with the
  // starter forward weapon so the field is armed (design choice — the original
  // per-driver loadouts are not recoverable).
  aiChars.forEach((character, i) => {
    const aiLoadout: Loadout = {
      chassisId: 'crusher',
      components: { engine: null, brakes: null, transmission: null, tires: null, airfoil: null, armor: null },
      weapons: { forward: 'machine_gun', rear: 'mine', side_spike: null, ram: null },
    };
    place(i + 1, aiLoadout, AI_DISPLAY_NAMES[character], true, character);
  });

  return { cars, carStats, participants };
}

/** Unit direction along the track's first segment (toward the next segment). */
function firstSegmentDirection(track: TrackDef): { x: number; y: number } {
  const a = track.roadSegments[0]?.centre;
  const b = track.roadSegments[1]?.centre;
  if (!a || !b) return { x: 0, y: 1 };
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}
