/**
 * Headless single-player race loop.
 *
 * Composes the shared, pure simulation primitives into one deterministic
 * per-tick step for an N-car race (one human + AI opponents), the piece the
 * client needs to actually run a race locally:
 *
 *   1. gather one {@link CarInputs} per car — the human's are passed in, each
 *      AI's come from {@link computeAIInputs} (with the {@link nextEvasive}
 *      transition resolved first so the shared RNG stream stays deterministic);
 *   2. {@link stepPhysics} advances all cars one 1/60 s step;
 *   3. {@link stepWeapons} resolves fire → damage → ammo → elimination for all
 *      cars, threading the projectile/hazard id counters and weapon state;
 *   4. lap/placement bookkeeping: each car's progress around the
 *      {@link WaypointGraph} is tracked so laps increment on a full loop and
 *      `placement` reflects race order;
 *   5. race-completion detection: the race finishes when every non-eliminated
 *      car has completed `lapCount` laps, or at most one car remains.
 *
 * It owns `CarRaceState[]` (physics + armor + ammo + lap + placement) and is
 * pure of PixiJS/DOM — the client drives it from its render loop and renders
 * the exposed car states each frame. Deterministic for a fixed seed.
 *
 * Requirements: 1.1, 3.x, 5.1, 5.2, 5.8, 6.x
 */

import { stepPhysics, FIXED_TIMESTEP, type PhysicsCarStats } from '../physics/stepPhysics.js';
import { mkRNG } from '../physics/rng.js';
import { stepWeapons, type WeaponFireInput } from '../weapons/WeaponSystem.js';
import { computeAIInputs, nextEvasive, nearestOpponentDistance } from '../ai/AIBrain.js';
import { nearestNode } from '../ai/WaypointNavigator.js';
import type { CarInputs, CarPhysicsState, RNG } from '../types/physics.js';
import type { CarRaceState } from '../types/car.js';
import type { WaypointGraph } from '../types/track.js';
import type { WeaponConfig, WeaponSystemState } from '../types/weapons.js';
import type { ParticipantId, WeaponId, ProjectileId, HazardId } from '../types/primitives.js';
import type { AIDriverConfig, AIDriverState } from '../types/ai.js';

/** Idle inputs used for eliminated cars and any missing human frame. */
const IDLE_INPUTS: CarInputs = {
  throttle: 0,
  brake: 0,
  steer: 0,
  fireForward: false,
  fireRear: false,
};

/** Per-participant control profile for the race (human or AI + weapon slots). */
export interface RaceParticipant {
  readonly participantId: ParticipantId;
  /** Human-readable name for the results table. */
  readonly displayName: string;
  /** `true` for AI-driven slots. */
  readonly isAI: boolean;
  /** AI configuration; present iff {@link isAI}. */
  readonly aiConfig?: AIDriverConfig;
  /** Weapon id in the forward slot (for firing + AI range), or `null`. */
  readonly forwardWeaponId: WeaponId | null;
  /** Weapon id in the rear slot, or `null`. */
  readonly rearWeaponId: WeaponId | null;
  /** Forward weapon effective range for the AI fire decision, or `null`. */
  readonly forwardWeaponRange: number | null;
}

/** Everything needed to construct a {@link RaceLoop}. */
export interface RaceLoopConfig {
  /** The starting grid — one entry per car. */
  readonly cars: readonly CarRaceState[];
  /** Per-car physics stats keyed by participant. */
  readonly carStats: ReadonlyMap<ParticipantId, PhysicsCarStats>;
  /** Per-car control profiles keyed by participant. */
  readonly participants: readonly RaceParticipant[];
  /** The track's AI navigation graph (also used for lap/progress tracking). */
  readonly waypointGraph: WaypointGraph;
  /** Static weapon catalogue keyed by id. */
  readonly weaponConfigs: ReadonlyMap<WeaponId, WeaponConfig>;
  /** Laps required to finish (Req 5.1). */
  readonly lapCount: number;
  /** Deterministic RNG seed. */
  readonly seed: number;
}

/** One car's finishing result (all cars). */
export interface ParticipantRaceOutcome {
  readonly id: ParticipantId;
  readonly displayName: string;
  readonly isAI: boolean;
  /** 1-based finishing placement (1 = winner). */
  readonly placement: number;
  /** Number of opponents this car eliminated during the race. */
  readonly eliminationCount: number;
}

/**
 * The deterministic single-player race simulation. Advance it one tick at a
 * time with {@link tick}; read {@link cars}/{@link finished}; and, once
 * finished, read {@link outcomes} for the results screen.
 */
export class RaceLoop {
  private readonly carStats: ReadonlyMap<ParticipantId, PhysicsCarStats>;
  private readonly participants: Map<ParticipantId, RaceParticipant>;
  private readonly waypointGraph: WaypointGraph;
  private readonly weaponConfigs: ReadonlyMap<WeaponId, WeaponConfig>;
  private readonly lapCount: number;
  private readonly rng: RNG;

  private readonly raceCars: Map<ParticipantId, CarRaceState>;
  private readonly aiState = new Map<ParticipantId, AIDriverState>();
  private readonly maxArmor = new Map<ParticipantId, number>();
  /** Monotonic progress index (laps * nodeCount + nearest node index) per car. */
  private readonly progress = new Map<ParticipantId, number>();
  /** Completed-lap count per car (0-based); car finishes when this reaches lapCount. */
  private readonly lapsCompleted = new Map<ParticipantId, number>();
  /** Nearest waypoint node index reached last tick, per car (for lap detection). */
  private readonly lastNodeIndex = new Map<ParticipantId, number>();
  /** Elimination tally by killer participant. */
  private readonly eliminationsBy = new Map<ParticipantId, number>();
  /** Finishing order captured as cars complete the race or are eliminated. */
  private readonly finishOrder: ParticipantId[] = [];

  private weaponState: WeaponSystemState = {
    projectiles: [],
    hazards: [],
    weaponStates: new Map(),
  };
  private nextProjectileId: ProjectileId = 0;
  private nextHazardId: HazardId = 0;
  private tickCount = 0;
  private done = false;

  constructor(config: RaceLoopConfig) {
    this.carStats = config.carStats;
    this.waypointGraph = config.waypointGraph;
    this.weaponConfigs = config.weaponConfigs;
    this.lapCount = Math.max(1, config.lapCount);
    this.rng = mkRNG(config.seed);

    this.participants = new Map(config.participants.map((p) => [p.participantId, p]));
    this.raceCars = new Map();
    for (const car of config.cars) {
      // Defensive deep-ish copy so external mutation cannot leak in.
      this.raceCars.set(car.participantId, {
        ...car,
        physics: { ...car.physics, position: { ...car.physics.position }, velocity: { ...car.physics.velocity } },
        ammo: new Map(car.ammo),
      });
      this.maxArmor.set(car.participantId, car.currentArmor);
      this.progress.set(car.participantId, 0);
      this.lapsCompleted.set(car.participantId, 0);
      this.lastNodeIndex.set(car.participantId, this.nodeIndexAt(car.physics.position));

      const p = this.participants.get(car.participantId);
      if (p?.isAI && p.aiConfig) {
        this.aiState.set(car.participantId, {
          config: p.aiConfig,
          currentWaypointIndex: car.waypointIndex,
          evasive: false,
          lapThrottleJitter: 1,
        });
      }
    }
  }

  /** The current car race states, in participant-slot order. */
  get cars(): CarRaceState[] {
    return this.sortedIds().map((id) => this.raceCars.get(id)!);
  }

  /** The current simulation tick. */
  get tick(): number {
    return this.tickCount;
  }

  /** Whether the race has completed. */
  get finished(): boolean {
    return this.done;
  }

  /** Look up one car's current state. */
  getCar(id: ParticipantId): CarRaceState | undefined {
    return this.raceCars.get(id);
  }

  // -------------------------------------------------------------------------
  // Per-tick step
  // -------------------------------------------------------------------------

  /**
   * Advance the race one 1/60 s tick. `humanInputs` supplies the control state
   * for every human participant this tick (keyed by id); AI inputs are computed
   * internally. Returns nothing; read {@link cars}/{@link finished} after.
   */
  step(humanInputs: ReadonlyMap<ParticipantId, CarInputs>): void {
    if (this.done) return;

    const inputs = this.gatherInputs(humanInputs);

    // 1. Physics for all cars.
    const physicsResult = stepPhysics(
      {
        cars: this.orderedPhysics(),
        tick: this.tickCount,
        trackId: 'bay_area',
        carStats: this.carStats,
      },
      inputs,
      FIXED_TIMESTEP,
      this.rng,
    );
    for (const physics of physicsResult.cars) {
      const race = this.raceCars.get(physics.id);
      if (race) race.physics = physics;
    }

    // 2. Weapons for all cars (fire -> damage -> ammo -> elimination).
    const fireInputs = this.buildFireInputs(inputs);
    const weaponResult = stepWeapons(this.weaponState, this.cars, FIXED_TIMESTEP, {
      weaponConfigs: this.weaponConfigs,
      fireInputs,
      tick: this.tickCount,
      nextProjectileId: this.nextProjectileId,
      nextHazardId: this.nextHazardId,
    });
    this.weaponState = weaponResult.updatedState;
    this.nextProjectileId = weaponResult.nextProjectileId;
    this.nextHazardId = weaponResult.nextHazardId;
    for (const updated of weaponResult.updatedCars) {
      this.raceCars.set(updated.participantId, updated);
    }
    // Tally eliminations by killer and record eliminated cars' finish order.
    for (const event of weaponResult.events) {
      if (event.type === 'elimination') {
        if (event.killedById !== null) {
          this.eliminationsBy.set(
            event.killedById,
            (this.eliminationsBy.get(event.killedById) ?? 0) + 1,
          );
        }
        this.recordFinish(event.eliminatedId);
      }
    }

    // 3. Lap / progress bookkeeping and placement.
    this.updateProgressAndLaps();
    this.updatePlacements();

    this.tickCount++;

    // 4. Completion: every car has either finished its laps or been eliminated,
    //    or only one car remains un-eliminated.
    this.updateDone();
  }

  // -------------------------------------------------------------------------
  // Outcomes
  // -------------------------------------------------------------------------

  /**
   * The finishing outcome for every car, ordered by placement. Cars that
   * finished the race (or were eliminated) earlier place ahead; a car eliminated
   * mid-race places behind everyone who finished but ahead of those eliminated
   * later. Placement is 1-based.
   */
  outcomes(): ParticipantRaceOutcome[] {
    const order = this.finishingOrder();
    return order.map((id, i) => {
      const p = this.participants.get(id);
      return {
        id,
        displayName: p?.displayName ?? `Car ${id}`,
        isAI: p?.isAI ?? false,
        placement: i + 1,
        eliminationCount: this.eliminationsBy.get(id) ?? 0,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private sortedIds(): ParticipantId[] {
    return [...this.raceCars.keys()].sort((a, b) => a - b);
  }

  private orderedPhysics(): CarPhysicsState[] {
    return this.sortedIds().map((id) => this.raceCars.get(id)!.physics);
  }

  /** Build the per-participant input map for this tick (human passed in, AI computed). */
  private gatherInputs(humanInputs: ReadonlyMap<ParticipantId, CarInputs>): Map<ParticipantId, CarInputs> {
    const inputs = new Map<ParticipantId, CarInputs>();
    for (const id of this.sortedIds()) {
      const race = this.raceCars.get(id)!;
      if (race.eliminated) {
        inputs.set(id, IDLE_INPUTS);
        continue;
      }
      const p = this.participants.get(id);
      if (p?.isAI && p.aiConfig) {
        inputs.set(id, this.computeAI(id, race, p));
      } else {
        inputs.set(id, humanInputs.get(id) ?? IDLE_INPUTS);
      }
    }
    return inputs;
  }

  /** Run the AI brain for one AI slot (RNG-deterministic). */
  private computeAI(id: ParticipantId, race: CarRaceState, p: RaceParticipant): CarInputs {
    const driver = this.aiState.get(id)!;
    const opponents: CarPhysicsState[] = [];
    for (const otherId of this.sortedIds()) {
      if (otherId === id) continue;
      const other = this.raceCars.get(otherId)!;
      if (other.eliminated) continue;
      opponents.push(other.physics);
    }
    const rearId = p.rearWeaponId;
    const world = {
      self: race.physics,
      selfArmor: race.currentArmor,
      selfMaxArmor: this.maxArmor.get(id) ?? race.currentArmor,
      opponents,
      hazards: this.weaponState.hazards,
      waypointGraph: this.waypointGraph,
      forwardWeaponRange: p.forwardWeaponRange,
      rearWeaponLoaded: rearId !== null && (race.ammo.get(rearId) ?? 0) > 0,
    };
    // Resolve the evasive transition before computeAIInputs draws from the RNG.
    const oppDist = nearestOpponentDistance(race.physics.position, opponents);
    driver.evasive = nextEvasive(driver.evasive, world.selfArmor, world.selfMaxArmor, oppDist);
    return computeAIInputs(driver, world, p.aiConfig!, this.rng);
  }

  /** Translate control inputs + weapon slots into weapon fire intents. */
  private buildFireInputs(inputs: ReadonlyMap<ParticipantId, CarInputs>): WeaponFireInput[] {
    const fires: WeaponFireInput[] = [];
    for (const id of this.sortedIds()) {
      const race = this.raceCars.get(id)!;
      if (race.eliminated) continue;
      const input = inputs.get(id);
      const p = this.participants.get(id);
      if (!input || !p) continue;
      if (!input.fireForward && !input.fireRear) continue;
      fires.push({
        participantId: id,
        fireForward: input.fireForward,
        fireRear: input.fireRear,
        forwardWeaponId: p.forwardWeaponId,
        rearWeaponId: p.rearWeaponId,
      });
    }
    return fires;
  }

  /** Index of the waypoint-graph node nearest to a position (0 for empty graph). */
  private nodeIndexAt(position: CarPhysicsState['position']): number {
    const node = nearestNode(this.waypointGraph, { x: position.x, y: position.y });
    if (node === undefined) return 0;
    const idx = this.waypointGraph.nodes.findIndex((n) => n.id === node.id);
    return idx < 0 ? 0 : idx;
  }

  /**
   * Update each car's cumulative progress and lap count. A lap completes when a
   * car's nearest node wraps from near the end of the ordered node list back to
   * the start (crossing the start/finish line).
   */
  private updateProgressAndLaps(): void {
    const nodeCount = this.waypointGraph.nodes.length || 1;
    for (const id of this.sortedIds()) {
      const race = this.raceCars.get(id)!;
      if (race.eliminated) continue;

      const idx = this.nodeIndexAt(race.physics.position);
      const prev = this.lastNodeIndex.get(id) ?? idx;
      let completed = this.lapsCompleted.get(id) ?? 0;

      // Detect a wrap from the last third of the loop back into the first third
      // as a lap completion (robust to small back-and-forth jitter near nodes).
      const wrapped = prev >= nodeCount * (2 / 3) && idx <= nodeCount / 3;
      if (wrapped && completed < this.lapCount) {
        completed += 1;
        this.lapsCompleted.set(id, completed);
        // Displayed lap is 1-based and capped at lapCount.
        race.lap = Math.min(this.lapCount, completed + 1);
        if (completed >= this.lapCount) {
          // Crossed the start/finish line having completed the final lap.
          this.recordFinish(id);
        }
      }
      this.lastNodeIndex.set(id, idx);

      // Cumulative progress = completed laps * nodeCount + current node index.
      this.progress.set(id, completed * nodeCount + idx);
      race.waypointIndex = idx;
    }
  }

  /** Assign 1-based placements by descending progress among active cars. */
  private updatePlacements(): void {
    const active = this.sortedIds()
      .map((id) => this.raceCars.get(id)!)
      .filter((c) => !c.eliminated);
    active.sort((a, b) => (this.progress.get(b.participantId) ?? 0) - (this.progress.get(a.participantId) ?? 0));
    active.forEach((car, i) => {
      car.placement = i + 1;
    });
  }

  /** Record a car in the finishing order exactly once. */
  private recordFinish(id: ParticipantId): void {
    if (!this.finishOrder.includes(id)) this.finishOrder.push(id);
  }

  /**
   * The full finishing order (best first): cars that finished/were eliminated
   * in recorded order, then any still-running cars by current progress, then
   * eliminated cars are placed by when they were eliminated. Finishers (reached
   * lapCount) rank ahead of survivors, who rank ahead of the eliminated.
   */
  private finishingOrder(): ParticipantId[] {
    const finishers: ParticipantId[] = [];
    const eliminated: ParticipantId[] = [];
    for (const id of this.finishOrder) {
      const car = this.raceCars.get(id);
      if (car?.eliminated) eliminated.push(id);
      else finishers.push(id);
    }
    // Remaining cars (neither finished nor eliminated) ranked by progress desc.
    const remaining = this.sortedIds()
      .filter((id) => !this.finishOrder.includes(id))
      .sort((a, b) => (this.progress.get(b) ?? 0) - (this.progress.get(a) ?? 0));
    // Eliminated cars: reverse so the LATEST elimination places best among them.
    return [...finishers, ...remaining, ...eliminated.reverse()];
  }

  /** The race is done when at most one car is still racing (not finished/eliminated). */
  private updateDone(): void {
    let stillRacing = 0;
    for (const id of this.sortedIds()) {
      const car = this.raceCars.get(id)!;
      // A car is out of contention once it is eliminated or has crossed the
      // line on its final lap (recorded in the finish order as a finisher).
      const doneCar = car.eliminated || this.finishOrder.includes(id);
      if (!doneCar) stillRacing += 1;
    }
    if (stillRacing <= 1) {
      // Record any final still-racing car so the finishing order is complete.
      // The lone survivor (or the leader) is appended ahead of anyone not yet
      // recorded, preserving best-first order.
      for (const id of this.leaderOrder()) this.recordFinish(id);
      this.done = true;
    }
  }

  /** Still-racing cars ordered best-first by current progress (for final placement). */
  private leaderOrder(): ParticipantId[] {
    return this.sortedIds()
      .filter((id) => !this.raceCars.get(id)!.eliminated && !this.finishOrder.includes(id))
      .sort((a, b) => (this.progress.get(b) ?? 0) - (this.progress.get(a) ?? 0));
  }
}
