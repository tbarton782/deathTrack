/**
 * Server-authoritative simulation loop for the Deathtrack Multiplayer server.
 *
 * The {@link AuthorityLoop} is the beating heart of the server-authoritative
 * netcode: it advances the deterministic physics simulation at a fixed 60 Hz,
 * folds in one tick of {@link CarInputs} per car (drawn from {@link computeAIInputs}
 * for AI slots and from the {@link ServerNetworkManager}'s per-participant input
 * ring buffers for human slots), and broadcasts a compressed {@link StateSnapshot}
 * to every connected client at 20 Hz — i.e. on every third physics tick
 * (Requirements: 8.1, 8.5).
 *
 * ## Testability & determinism
 *
 * Wall-clock scheduling (`setImmediate`) and the wall clock (`Date.now`) are the
 * only sources of non-determinism, and both are kept at the edges:
 *
 *   - The per-tick work is factored into {@link AuthorityLoop.physicsTick} (a
 *     pure-ish method that advances one 1/60 s step and, on every third tick,
 *     assembles + broadcasts a snapshot). Tests drive it directly, one tick at a
 *     time, with no timers involved.
 *   - {@link AuthorityLoop.start} / {@link AuthorityLoop.stop} are a thin wrapper
 *     that repeatedly schedules `physicsTick` via `setImmediate`. They add no
 *     behaviour of their own.
 *   - The RNG is created from an injected `seed` via {@link mkRNG}, and the clock
 *     is injected as `now` (defaulting to `Date.now`), mirroring how
 *     {@link ServerNetworkManager} injects `now`. Two loops constructed with the
 *     same seed, same initial car states, and the same input stream produce
 *     byte-identical tick sequences.
 *
 * The loop never reads `Math.random()` or `Date.now()` outside these injected
 * dependencies, so a fixed seed yields a fully reproducible simulation suitable
 * for lockstep reconciliation and replay.
 *
 * Requirements: 8.1, 8.5
 */

import type {
  AIDriverConfig,
  AIDriverState,
  CarInputs,
  CarPhysicsState,
  CarRaceState,
  CompressedCarState,
  ParticipantId,
  PhysicsCarStats,
  PhysicsWorldState,
  PitLaneData,
  RNG,
  StateSnapshot,
  TrackId,
  TrackSDF,
  WaypointGraph,
  WeaponId,
} from '@deathtrack/shared';
import type { JumpRamp } from '@deathtrack/shared';
import {
  FIXED_TIMESTEP,
  computeAIInputs,
  mkRNG,
  nearestOpponentDistance,
  nextEvasive,
  stepPhysics,
} from '@deathtrack/shared';
import type { ServerNetworkManager } from './network/ServerNetworkManager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Physics simulation rate: one step every 1/60 s. Requirements: 8.1 */
export const PHYSICS_HZ = 60;

/** Authoritative broadcast rate: one snapshot every 1/20 s. Requirements: 8.1 */
export const BROADCAST_HZ = 20;

/**
 * Number of physics ticks between broadcasts. At 60 Hz physics and 20 Hz
 * broadcast this is exactly 3: a snapshot is sent on ticks 0, 3, 6, …
 * Requirements: 8.1
 */
export const TICKS_PER_BROADCAST = PHYSICS_HZ / BROADCAST_HZ;

/** Real-time interval (ms) between physics ticks; used by {@link AuthorityLoop.start}. */
export const PHYSICS_TICK_MS = 1000 / PHYSICS_HZ;

/**
 * Heading quantisation: 256 discrete steps mapped across a full turn (2π).
 * Requirements: 8.7, 8.8
 */
const HEADING_STEPS = 256;

/** Position fixed-point resolution: 0.1 units per step. Requirements: 8.7, 8.8 */
const POSITION_RESOLUTION = 0.1;

/** Speed fixed-point resolution: 0.01 units per step. Requirements: 8.7, 8.8 */
const SPEED_RESOLUTION = 0.01;

/** Largest value representable by a uint8 field. */
const UINT8_MAX = 255;

/** Largest value representable by a uint16 field. */
const UINT16_MAX = 65535;

const TAU = Math.PI * 2;

// Status bitfield masks (mirror CompressedCarState docs). Requirements: 8.8
const FLAG_ELIMINATED = 0x01;
const FLAG_AIRBORNE = 0x02;
const FLAG_ON_TRACK = 0x04;

// ---------------------------------------------------------------------------
// Track / world context
// ---------------------------------------------------------------------------

/**
 * The static, per-race world context the loop needs to step physics and drive
 * AI navigation. Supplied once at construction; never mutated by the loop.
 */
export interface AuthorityTrackContext {
  /** The track being raced on. */
  readonly trackId: TrackId;
  /** Resolved per-car physics stats keyed by participant slot. */
  readonly carStats: ReadonlyMap<ParticipantId, PhysicsCarStats>;
  /** Signed-distance field for off-track detection. Optional. */
  readonly trackSDF?: TrackSDF;
  /** Jump ramps on the track. Optional. */
  readonly jumpRamps?: readonly JumpRamp[];
  /** Pit-lane geometry (armor/ammo restoration trigger). Optional. */
  readonly pitLane?: PitLaneData;
  /** Waypoint navigation graph used by AI steering. */
  readonly waypointGraph: WaypointGraph;
}

/**
 * Per-participant control profile: whether the slot is AI-driven (and its
 * config) plus the weapon parameters the AI brain and snapshot assembly read.
 */
export interface ParticipantControl {
  /** `true` for AI-controlled slots; `false` for human slots. */
  readonly isAI: boolean;
  /** AI configuration; present iff {@link isAI} is `true`. */
  readonly aiConfig?: AIDriverConfig;
  /** Forward-weapon effective range (units) for the AI fire decision, or `null`. */
  readonly forwardWeaponRange?: number | null;
  /** Weapon id occupying the forward slot, used to read ammo for the snapshot. */
  readonly forwardWeaponId?: WeaponId | null;
  /** Weapon id occupying the rear slot, used to read ammo for the snapshot. */
  readonly rearWeaponId?: WeaponId | null;
}

/**
 * Injectable, non-deterministic dependencies. Defaults use the real wall clock
 * and a zero seed; tests override both to drive the loop deterministically.
 */
export interface AuthorityLoopDeps {
  /** RNG seed threaded into {@link mkRNG}. Defaults to `0`. */
  seed: number;
  /** Current time in milliseconds. Defaults to `Date.now`. */
  now: () => number;
  /** Schedules the next physics tick. Defaults to `setImmediate`. */
  schedule: (fn: () => void) => void;
}

// ---------------------------------------------------------------------------
// Fixed-point quantisation (float car state -> CompressedCarState)
// ---------------------------------------------------------------------------

/** Clamps `value` into the inclusive range `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Quantises a world position component to the on-wire uint16 fixed-point scheme
 * (0.1-unit resolution). Negative and overflowing values are clamped into the
 * representable range. Requirements: 8.7, 8.8
 */
export function quantizePosition(value: number): number {
  const q = Math.round(value / POSITION_RESOLUTION);
  return clamp(q, 0, UINT16_MAX);
}

/**
 * Quantises a heading in radians to a uint8 step (0–255 across 0–2π), wrapping
 * so any real heading maps into range. Requirements: 8.7, 8.8
 */
export function quantizeHeading(radians: number): number {
  const wrapped = ((radians % TAU) + TAU) % TAU;
  const step = Math.round((wrapped / TAU) * HEADING_STEPS);
  // 256 wraps back to 0 (a full turn == no turn).
  return step % HEADING_STEPS;
}

/**
 * Quantises a scalar speed to the on-wire uint16 fixed-point scheme
 * (0.01-unit resolution). Requirements: 8.7, 8.8
 */
export function quantizeSpeed(value: number): number {
  const q = Math.round(value / SPEED_RESOLUTION);
  return clamp(q, 0, UINT16_MAX);
}

/**
 * Quantises current armor to a uint8 (0–255) linearly mapped from `[0, maxArmor]`.
 * A non-positive `maxArmor` yields 0. Requirements: 8.7, 8.8
 */
export function quantizeArmor(currentArmor: number, maxArmor: number): number {
  if (maxArmor <= 0) return 0;
  const fraction = clamp(currentArmor / maxArmor, 0, 1);
  return clamp(Math.round(fraction * UINT8_MAX), 0, UINT8_MAX);
}

/** Clamps an ammo count into the representable uint8 range. Requirements: 8.8 */
function quantizeAmmo(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return 0;
  return clamp(Math.round(value), 0, UINT8_MAX);
}

/** Assembles the uint8 status bitfield for a car. Requirements: 8.8 */
function packFlags(race: CarRaceState): number {
  let flags = 0;
  if (race.eliminated) flags |= FLAG_ELIMINATED;
  if (race.physics.airborne) flags |= FLAG_AIRBORNE;
  if (race.physics.onTrack) flags |= FLAG_ON_TRACK;
  return flags;
}

// ---------------------------------------------------------------------------
// AuthorityLoop
// ---------------------------------------------------------------------------

export class AuthorityLoop {
  private readonly network: ServerNetworkManager;
  private readonly track: AuthorityTrackContext;
  private readonly controls: ReadonlyMap<ParticipantId, ParticipantControl>;
  private readonly now: () => number;
  private readonly schedule: (fn: () => void) => void;
  private readonly rng: RNG;

  /** Authoritative mutable car race state keyed by participant slot. */
  private readonly cars = new Map<ParticipantId, CarRaceState>();
  /** Per-AI-driver mutable runtime state (evasive flag, lap jitter, …). */
  private readonly aiState = new Map<ParticipantId, AIDriverState>();
  /** Configured maximum armor per car (the pit-lane restoration target). */
  private readonly maxArmor = new Map<ParticipantId, number>();
  /** Participants currently inside the pit lane, threaded across ticks. */
  private pitLaneOccupants: ReadonlySet<ParticipantId> = new Set();

  /** Server authoritative physics tick counter; increments once per tick. */
  private tickCount = 0;
  /** Wall-clock time (ms) captured at {@link start}; anchors `serverTime`. */
  private raceStartMs = 0;
  /** `true` between {@link start} and {@link stop}. */
  private running = false;

  constructor(
    network: ServerNetworkManager,
    track: AuthorityTrackContext,
    initialCars: readonly CarRaceState[],
    controls: ReadonlyMap<ParticipantId, ParticipantControl>,
    deps: Partial<AuthorityLoopDeps> = {},
  ) {
    this.network = network;
    this.track = track;
    this.controls = controls;
    this.now = deps.now ?? (() => Date.now());
    this.schedule = deps.schedule ?? ((fn) => void setImmediate(fn));
    this.rng = mkRNG(deps.seed ?? 0);

    for (const car of initialCars) {
      // Defensive copy so external mutation of the caller's array cannot leak in.
      this.cars.set(car.participantId, cloneRaceState(car));
      this.maxArmor.set(car.participantId, car.currentArmor);

      const control = controls.get(car.participantId);
      if (control?.isAI && control.aiConfig) {
        this.aiState.set(car.participantId, {
          config: control.aiConfig,
          currentWaypointIndex: car.waypointIndex,
          evasive: false,
          lapThrottleJitter: 1,
        });
      }
    }
    this.raceStartMs = this.now();
  }

  // -------------------------------------------------------------------------
  // Scheduling wrapper (start / stop)
  // -------------------------------------------------------------------------

  /**
   * Begins driving the loop in real time: schedules {@link physicsTick} via the
   * injected `schedule` (`setImmediate` in production) and re-schedules itself
   * after each tick. Anchors `serverTime` to the current clock. Idempotent.
   *
   * This wrapper deliberately contains no simulation logic; all behaviour lives
   * in {@link physicsTick} so it can be unit-tested without timers.
   */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.raceStartMs = this.now();

    const pump = (): void => {
      if (!this.running) return;
      this.physicsTick();
      this.schedule(pump);
    };
    this.schedule(pump);
  }

  /** Stops the real-time pump. The loop can be resumed with {@link start}. */
  stop(): void {
    this.running = false;
  }

  /** Whether the real-time pump is currently active. */
  get isRunning(): boolean {
    return this.running;
  }

  // -------------------------------------------------------------------------
  // Per-tick step (drivable directly by tests)
  // -------------------------------------------------------------------------

  /**
   * Advances the simulation by exactly one 1/60 s physics tick and, on every
   * {@link TICKS_PER_BROADCAST}th tick (20 Hz), assembles and broadcasts a
   * {@link StateSnapshot}.
   *
   * The sequence per tick is:
   *   1. gather one {@link CarInputs} per car — AI via {@link computeAIInputs},
   *      humans via the latest buffered {@link ServerNetworkManager} frame;
   *   2. {@link stepPhysics} the whole world one step, threading the RNG and
   *      pit-lane occupancy;
   *   3. write the updated physics back into each car's race state and apply
   *      pit-lane armor/ammo restoration on any `pit_lane_enter` event;
   *   4. increment the tick counter and, when due, broadcast a snapshot.
   *
   * Returns nothing; state is mutated in place. Deterministic for a fixed seed.
   *
   * Requirements: 8.1, 8.5
   */
  physicsTick(): void {
    const inputs = this.gatherInputs();

    // Build the world snapshot, omitting optional geometry fields entirely when
    // absent (rather than setting them to `undefined`) to satisfy
    // `exactOptionalPropertyTypes`.
    const world: PhysicsWorldState = {
      cars: this.orderedPhysics(),
      tick: this.tickCount,
      trackId: this.track.trackId,
      carStats: this.track.carStats,
      pitLaneOccupants: [...this.pitLaneOccupants],
      ...(this.track.trackSDF ? { trackSDF: this.track.trackSDF } : {}),
      ...(this.track.jumpRamps ? { jumpRamps: this.track.jumpRamps } : {}),
      ...(this.track.pitLane ? { pitLane: this.track.pitLane } : {}),
    };

    const result = stepPhysics(world, inputs, FIXED_TIMESTEP, this.rng);

    // Write updated physics back into the authoritative race state.
    for (const physics of result.cars) {
      const race = this.cars.get(physics.id);
      if (race) race.physics = physics;
    }

    // Apply pit-lane restoration: on entry, restore armor to max and reload all
    // ammo. The physics step only *signals* the transition (Req 9.3, 9.4); the
    // authority loop owns CarRaceState and performs the restoration here.
    const nextOccupants = new Set<ParticipantId>(this.pitLaneOccupants);
    for (const event of result.events) {
      if (event.type === 'pit_lane_enter') {
        nextOccupants.add(event.participantId);
        this.restore(event.participantId, event.maxArmor);
      } else if (event.type === 'pit_lane_exit') {
        nextOccupants.delete(event.participantId);
      }
    }
    this.pitLaneOccupants = nextOccupants;

    this.tickCount++;

    // Broadcast at 20 Hz (every 3rd physics tick). Using the post-increment tick
    // count means the first snapshot fires after tick 0 completes.
    if ((this.tickCount - 1) % TICKS_PER_BROADCAST === 0) {
      this.network.broadcastSnapshot(this.assembleSnapshot(), this.tickCount - 1);
    }
  }

  // -------------------------------------------------------------------------
  // Input assembly
  // -------------------------------------------------------------------------

  /**
   * Builds the per-participant {@link CarInputs} map for the current tick.
   *
   * AI slots run {@link computeAIInputs} against a freshly-assembled world view
   * (advancing the shared RNG deterministically); human slots read the latest
   * accepted input frame from the {@link ServerNetworkManager}, defaulting to
   * idle inputs when none is buffered (a silent client coasts). Requirements: 8.1, 8.5
   */
  private gatherInputs(): Map<ParticipantId, CarInputs> {
    const inputs = new Map<ParticipantId, CarInputs>();

    // Deterministic iteration order (by participant slot) so RNG draws for AI
    // slots are reproducible regardless of Map insertion order.
    for (const id of this.sortedIds()) {
      const race = this.cars.get(id)!;
      if (race.eliminated) {
        inputs.set(id, IDLE_INPUTS);
        continue;
      }

      const control = this.controls.get(id);
      if (control?.isAI && control.aiConfig) {
        inputs.set(id, this.computeAI(id, race, control));
      } else {
        const frame = this.network.latestInput(id);
        inputs.set(id, frame?.inputs ?? IDLE_INPUTS);
      }
    }

    return inputs;
  }

  /** Runs the AI brain for one AI slot, assembling its world view. */
  private computeAI(
    id: ParticipantId,
    race: CarRaceState,
    control: ParticipantControl,
  ): CarInputs {
    const driver = this.aiState.get(id)!;
    const opponents: CarPhysicsState[] = [];
    for (const otherId of this.sortedIds()) {
      if (otherId === id) continue;
      const other = this.cars.get(otherId)!;
      if (other.eliminated) continue;
      opponents.push(other.physics);
    }

    const rearId = control.rearWeaponId ?? null;

    const world = {
      self: race.physics,
      selfArmor: race.currentArmor,
      selfMaxArmor: this.maxArmor.get(id) ?? race.currentArmor,
      opponents,
      hazards: [],
      waypointGraph: this.track.waypointGraph,
      forwardWeaponRange: control.forwardWeaponRange ?? null,
      rearWeaponLoaded: rearId !== null && (race.ammo.get(rearId) ?? 0) > 0,
    };

    // Resolve the evasive transition *before* computeAIInputs draws from the RNG
    // so persisting it does not perturb the shared RNG stream. This mirrors the
    // exact transition the brain applies internally (Req 6.3).
    const oppDist = nearestOpponentDistance(race.physics.position, opponents);
    driver.evasive = nextEvasive(
      driver.evasive,
      world.selfArmor,
      world.selfMaxArmor,
      oppDist,
    );

    return computeAIInputs(driver, world, control.aiConfig!, this.rng);
  }

  // -------------------------------------------------------------------------
  // Pit-lane restoration
  // -------------------------------------------------------------------------

  /**
   * Restores a car's armor to its configured maximum on pit-lane entry
   * (Req 9.4). Ammo reload is owned by the weapon system (`stepWeapons`) and
   * layered in when that pass is integrated; the loop keeps armor restoration
   * authoritative here so the guarantee holds before the matching exit event.
   */
  private restore(id: ParticipantId, maxArmor: number): void {
    const race = this.cars.get(id);
    if (!race) return;
    race.currentArmor = maxArmor;
  }

  // -------------------------------------------------------------------------
  // Snapshot assembly
  // -------------------------------------------------------------------------

  /**
   * Assembles a {@link StateSnapshot} from the current authoritative car race
   * states, quantising each car's float physics into a {@link CompressedCarState}
   * (uint16 position ×0.1, uint8 heading, uint16 speed ×0.01, uint8 armor, flags,
   * uint8 ammo). Cars are emitted in participant-slot order. Requirements: 8.1, 8.7, 8.8
   */
  assembleSnapshot(): StateSnapshot {
    const cars: CompressedCarState[] = [];
    for (const id of this.sortedIds()) {
      const race = this.cars.get(id)!;
      cars.push(this.compress(race));
    }

    return {
      tick: this.tickCount,
      serverTime: Math.max(0, Math.round(this.now() - this.raceStartMs)),
      cars,
      events: [],
      authorityChecksum: 0,
    };
  }

  /** Quantises one car's race state into a wire-ready {@link CompressedCarState}. */
  private compress(race: CarRaceState): CompressedCarState {
    const control = this.controls.get(race.participantId);
    const forwardId = control?.forwardWeaponId ?? null;
    const rearId = control?.rearWeaponId ?? null;
    const maxArmor = this.maxArmor.get(race.participantId) ?? race.currentArmor;

    return {
      id: race.participantId,
      x: quantizePosition(race.physics.position.x),
      y: quantizePosition(race.physics.position.y),
      heading: quantizeHeading(race.physics.heading),
      speed: quantizeSpeed(race.physics.speed),
      armor: quantizeArmor(race.currentArmor, maxArmor),
      flags: packFlags(race),
      ammoForward: quantizeAmmo(forwardId ? race.ammo.get(forwardId) : undefined),
      ammoRear: quantizeAmmo(rearId ? race.ammo.get(rearId) : undefined),
    };
  }

  // -------------------------------------------------------------------------
  // Introspection helpers (used by tests)
  // -------------------------------------------------------------------------

  /** Current authoritative physics tick counter. */
  get tick(): number {
    return this.tickCount;
  }

  /** Returns a copy of a car's current race state, or `undefined`. */
  getCar(id: ParticipantId): CarRaceState | undefined {
    const race = this.cars.get(id);
    return race ? cloneRaceState(race) : undefined;
  }

  /** Whether a participant is currently inside the pit lane. */
  isInPitLane(id: ParticipantId): boolean {
    return this.pitLaneOccupants.has(id);
  }

  // -------------------------------------------------------------------------
  // Internal ordering helpers
  // -------------------------------------------------------------------------

  /** Participant slots in ascending order for deterministic iteration. */
  private sortedIds(): ParticipantId[] {
    return [...this.cars.keys()].sort((a, b) => a - b);
  }

  /** Current car physics states in participant-slot order. */
  private orderedPhysics(): CarPhysicsState[] {
    return this.sortedIds().map((id) => this.cars.get(id)!.physics);
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers
// ---------------------------------------------------------------------------

/** No-op input used for eliminated cars and silent human clients. */
const IDLE_INPUTS: CarInputs = {
  throttle: 0,
  brake: 0,
  steer: 0,
  fireForward: false,
  fireRear: false,
};

/** Deep-ish copy of a {@link CarRaceState} (physics is immutable; ammo is cloned). */
function cloneRaceState(car: CarRaceState): CarRaceState {
  return {
    ...car,
    ammo: new Map(car.ammo),
  };
}


