/**
 * Single-player race session wiring (task 25.13).
 *
 * Bridges the pure, headless {@link RaceLoop} from `@deathtrack/shared` to the
 * client's presentation layer: it builds the starting grid from a loaded
 * {@link TrackDef} plus the human's chosen {@link Loadout}, constructs the
 * {@link RaceLoop}, and exposes the two things the render loop needs each frame:
 *
 *   1. {@link RaceSession.stepAndSnapshot} — advance the simulation `n` fixed
 *      steps from the human's sampled {@link CarInputs} and return a fresh
 *      {@link RenderState} snapshot of the field (plus this frame's elimination
 *      events, so the renderer can spawn explosions).
 *   2. {@link RaceSession.finished} / {@link RaceSession.outcomes} — the race
 *      completion flag and, once finished, the per-car finishing order for the
 *      results screen and career payout.
 *
 * The {@link RenderState} assembly ({@link buildRaceRenderState}) is a pure,
 * PixiJS-free function so it can be unit-tested headlessly; the class itself is
 * a thin stateful driver that owns the {@link RaceLoop} and the human input
 * source. Nothing here touches WebGL or the DOM.
 *
 * Requirements: 1.1, 2.1, 5.1, 5.2, 5.8, 6.x
 */

import {
  RaceLoop,
  buildStartingGrid,
  WEAPON_CATALOGUE,
  type ParticipantRaceOutcome,
  type CarRaceState,
  type CarInputs,
  type Loadout,
  type TrackDef,
  type WeaponConfig,
  type WeaponId,
  type ParticipantId,
} from '@deathtrack/shared';
import type { EliminationEvent } from '@deathtrack/shared';
import type { RenderCar, RenderState } from '../renderer/renderState.js';

/** The human always occupies participant slot 0 in the starting grid. */
export const HUMAN_PARTICIPANT_ID: ParticipantId = 0;

/** Weapon catalogue indexed by id, shared by every race. */
const WEAPON_CONFIGS: ReadonlyMap<WeaponId, WeaponConfig> = new Map(
  WEAPON_CATALOGUE.map((w) => [w.id, w] as const),
);

/** A minimal source of the human's per-frame control inputs. */
export interface HumanInputSource {
  /** Sample the current control state (throttle/brake/steer/fire). */
  sampleInputs(): CarInputs;
}

/**
 * Real car-sprite assets for a race. When supplied, cars draw from the packed
 * sprite atlas (real converted art); when absent, the renderer falls back to
 * placeholder rectangles. All fields are required together.
 */
export interface RaceSprites {
  /** The packed sprite atlas (frame table). */
  readonly atlas: NonNullable<RenderState['atlas']>;
  /** The PixiJS texture backing {@link atlas}. */
  readonly atlasTexture: NonNullable<RenderState['atlasTexture']>;
  /**
   * Resolve the atlas frame key for a car by participant slot. Returning
   * `undefined` leaves that car on the placeholder path.
   */
  readonly spriteIdFor: (participantId: ParticipantId) => string | undefined;
}

/** Options for constructing a {@link RaceSession}. */
export interface RaceSessionOptions {
  /** The decoded track being raced (supplies grid + waypoint graph). */
  readonly track: TrackDef;
  /** The human player's chosen loadout, captured from the car-config screen. */
  readonly humanLoadout: Loadout;
  /** The human player's display name. */
  readonly humanName: string;
  /** Source of the human's per-frame inputs (e.g. the InputHandler). */
  readonly inputSource: HumanInputSource;
  /** Laps required to finish; defaults to the track's own `lapCount`. */
  readonly lapCount?: number;
  /** Deterministic RNG seed for the race. */
  readonly seed?: number;
  /** Optional real car-sprite atlas; omitted → placeholder cars. */
  readonly sprites?: RaceSprites;
}

/**
 * Build a renderer {@link RenderState} from the current race field.
 *
 * Pure and PixiJS-free. Maps every {@link CarRaceState} to a {@link RenderCar}
 * (position/heading/airborne height + eliminated flag) and picks the camera
 * target: the leading non-eliminated car (lowest `placement`), falling back to
 * the human's car, then the first car. Scenery/hazards/projectiles that the
 * renderer also draws are supplied by the caller since they live outside the
 * car list; here we pass through only what the field determines.
 *
 * @param cars - The race field this frame (from {@link RaceLoop.cars}).
 * @param options - Optional passthrough scene data + this frame's eliminations.
 */
export function buildRaceRenderState(
  cars: readonly CarRaceState[],
  options: {
    readonly eliminations?: readonly EliminationEvent[];
    readonly scenery?: RenderState['scenery'];
    readonly hazards?: RenderState['hazards'];
    readonly projectiles?: RenderState['projectiles'];
    readonly palette?: RenderState['palette'];
    readonly atlas?: RenderState['atlas'];
    readonly atlasTexture?: RenderState['atlasTexture'];
    /**
     * Resolve the atlas frame key for a car, so each car draws its real sprite.
     * Returns `undefined` to leave a car on the renderer's placeholder path.
     */
    readonly spriteIdFor?: (participantId: ParticipantId) => string | undefined;
  } = {},
): RenderState {
  const renderCars: RenderCar[] = cars.map((car) => {
    const spriteId = options.spriteIdFor?.(car.participantId);
    const rc: RenderCar = {
      id: car.participantId,
      position: { x: car.physics.position.x, y: car.physics.position.y },
      heading: car.physics.heading,
      airborneHeight: car.physics.airborneHeight,
      eliminated: car.eliminated,
      ...(spriteId !== undefined ? { spriteId } : {}),
    };
    return rc;
  });

  const leader = pickCameraCar(cars);
  const cameraTarget = {
    position: { x: leader.physics.position.x, y: leader.physics.position.y },
    heading: leader.physics.heading,
    airborneHeight: leader.physics.airborneHeight,
  };

  // Only attach optional fields when defined: the renderer's RenderState uses
  // `exactOptionalPropertyTypes`, so an explicit `undefined` is not assignable.
  const state: {
    -readonly [K in keyof RenderState]: RenderState[K];
  } = {
    cameraTarget,
    cars: renderCars,
    scenery: options.scenery ?? [],
    hazards: options.hazards ?? [],
    projectiles: options.projectiles ?? [],
  };
  if (options.eliminations !== undefined) state.eliminations = options.eliminations;
  if (options.palette !== undefined) state.palette = options.palette;
  if (options.atlas !== undefined) state.atlas = options.atlas;
  if (options.atlasTexture !== undefined) state.atlasTexture = options.atlasTexture;
  return state;
}

/** Pick the car the camera should follow: race leader, else human, else first. */
function pickCameraCar(cars: readonly CarRaceState[]): CarRaceState {
  const active = cars.filter((c) => !c.eliminated);
  const pool = active.length > 0 ? active : cars;
  let best = pool[0]!;
  for (const car of pool) {
    if (car.placement < best.placement) best = car;
  }
  return best;
}

/**
 * A running single-player race: owns the headless {@link RaceLoop}, feeds it the
 * human's inputs each fixed step, and snapshots the field for rendering.
 */
export class RaceSession {
  private readonly loop: RaceLoop;
  private readonly inputSource: HumanInputSource;
  private readonly loadout: Loadout;
  private readonly sprites: RaceSprites | undefined;
  /** The weapon catalogue used this race (exposed for HUD model building). */
  readonly weaponConfigs = WEAPON_CONFIGS;
  /** Laps required to finish this race. */
  readonly lapCount: number;

  constructor(options: RaceSessionOptions) {
    this.inputSource = options.inputSource;
    this.loadout = options.humanLoadout;
    this.sprites = options.sprites;
    this.lapCount = Math.max(1, options.lapCount ?? options.track.lapCount);

    const grid = buildStartingGrid({
      track: options.track,
      humanLoadout: options.humanLoadout,
      humanName: options.humanName,
    });

    this.loop = new RaceLoop({
      cars: grid.cars,
      carStats: grid.carStats,
      participants: grid.participants,
      waypointGraph: options.track.waypointGraph,
      weaponConfigs: WEAPON_CONFIGS,
      lapCount: this.lapCount,
      seed: options.seed ?? 1,
    });
  }

  /** The human player's loadout (for {@link buildHudModel}). */
  get humanLoadout(): Loadout {
    return this.loadout;
  }

  /** Whether the race has finished. */
  get finished(): boolean {
    return this.loop.finished;
  }

  /** The current simulation tick. */
  get tick(): number {
    return this.loop.tick;
  }

  /** The human player's live car state (for the HUD), if present. */
  get humanCar(): CarRaceState | undefined {
    return this.loop.getCar(HUMAN_PARTICIPANT_ID);
  }

  /**
   * Advance the race `steps` fixed ticks using the human's freshly-sampled
   * inputs, then return a {@link RenderState} snapshot of the field. Sampling
   * once per frame (not per sub-step) keeps input latency to one frame while the
   * sim still advances at the fixed rate.
   *
   * @param steps - Number of fixed simulation steps to run this frame (>= 0).
   */
  stepAndSnapshot(steps: number): RenderState {
    const inputs: ReadonlyMap<ParticipantId, CarInputs> = new Map([
      [HUMAN_PARTICIPANT_ID, this.inputSource.sampleInputs()],
    ]);
    for (let i = 0; i < steps && !this.loop.finished; i++) {
      this.loop.step(inputs);
    }
    return this.buildSnapshot();
  }

  /** A snapshot of the current field without advancing the simulation. */
  snapshot(): RenderState {
    return this.buildSnapshot();
  }

  /** Build a RenderState snapshot, attaching the real sprite atlas when present. */
  private buildSnapshot(): RenderState {
    if (this.sprites) {
      return buildRaceRenderState(this.loop.cars, {
        atlas: this.sprites.atlas,
        atlasTexture: this.sprites.atlasTexture,
        spriteIdFor: this.sprites.spriteIdFor,
      });
    }
    return buildRaceRenderState(this.loop.cars);
  }

  /** The per-car finishing outcomes (valid once {@link finished}). */
  outcomes(): ParticipantRaceOutcome[] {
    return this.loop.outcomes();
  }

  /** The human player's finishing outcome, if the race produced one. */
  humanOutcome(): ParticipantRaceOutcome | undefined {
    return this.loop.outcomes().find((o) => o.id === HUMAN_PARTICIPANT_ID);
  }
}
