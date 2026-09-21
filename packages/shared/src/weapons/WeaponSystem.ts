/**
 * Pure, deterministic weapon step for the Deathtrack Multiplayer Recreation.
 *
 * `stepWeapons` advances the whole weapon world by a single fixed simulation
 * tick. Like {@link stepPhysics} it is a pure function of its arguments: it
 * never reads `Math.random()`, `Date.now()`, or any ambient mutable state, and
 * it never mutates the inputs it is given. Determinism is what makes the weapon
 * simulation safe for lockstep client/server reconciliation and replay — the
 * same inputs always yield byte-identical output.
 *
 * One `stepWeapons` invocation resolves, in this fixed order:
 *
 *   1. **Fire inputs** — for every car whose control frame requests a shot, a
 *      forward weapon spawns a projectile at the car's front (Req 3.2) and a
 *      rear-drop weapon places a hazard at the car's rear (Req 3.3). Firing is
 *      blocked and consumes nothing when ammo is 0 (Req 3.7); a successful fire
 *      deducts exactly one round, clamped into `[0, ammoMax]` (Req 3.7).
 *   2. **Beam damage** — every car with an active beam/laser weapon applies
 *      `beamDPS × dt` to its target this tick (Req 3.6).
 *   3. **Projectile advance & contact** — projectiles integrate forward by
 *      `velocity × dt`, are dropped when they exceed their weapon's range, and
 *      on contacting an opponent car deduct exactly `weaponDef.damage`
 *      (Req 3.4) then despawn.
 *   4. **Hazard contact** — a placed hazard contacted by *any* car, including
 *      its owner, deducts exactly `weaponDef.damage` and is removed (Req 3.8).
 *   5. **Elimination** — any car whose armor reaches zero or below this tick
 *      emits a single {@link EliminationEvent} (Req 3.5).
 *
 * Armor and ammo live in {@link CarRaceState}, not in `CarPhysicsState`, so the
 * step reads and returns car race states. It never mutates the array it is
 * handed: {@link WeaponStepResult.updatedCars} is a fresh array of fresh states
 * with cloned `ammo` maps, and `updatedState` is a fresh {@link WeaponSystemState}.
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9
 */

import type {
  ParticipantId,
  ProjectileId,
  HazardId,
  Vec2,
  WeaponId,
} from '../types/primitives.js';
import type { CarRaceState } from '../types/car.js';
import type {
  ActiveProjectile,
  PlacedHazard,
  WeaponConfig,
  WeaponEvent,
  WeaponSystemState,
  WeaponStepResult,
} from '../types/weapons.js';

// ---------------------------------------------------------------------------
// Supporting types
// ---------------------------------------------------------------------------

/**
 * A single car's fire intent for this tick, mirroring the weapon-relevant
 * fields of `CarInputs` plus which weapon occupies each firing slot. Supplied
 * per car so the step stays a pure function of explicit inputs.
 *
 * Requirements: 3.2, 3.3, 3.6
 */
export interface WeaponFireInput {
  /** The car issuing the fire commands. */
  readonly participantId: ParticipantId;
  /** Fire the forward-slot weapon this tick. Requirements: 3.2 */
  readonly fireForward: boolean;
  /** Deploy the rear-slot hazard this tick. Requirements: 3.3 */
  readonly fireRear: boolean;
  /** Weapon equipped in the forward slot, or `null` if none. */
  readonly forwardWeaponId: WeaponId | null;
  /** Weapon equipped in the rear slot, or `null` if none. */
  readonly rearWeaponId: WeaponId | null;
  /**
   * Target of an active beam/laser weapon this tick, if the forward weapon is a
   * beam and is being held. `null` means no beam target this tick.
   * Requirements: 3.6
   */
  readonly beamTargetId?: ParticipantId | null;
}

/**
 * Everything `stepWeapons` needs beyond the mutable {@link WeaponSystemState}
 * and car states: the static weapon catalogue, per-car fire intents, the
 * current tick, and monotonic id counters for freshly-spawned projectiles and
 * hazards. All optional collections default to empty so a caller with no fire
 * activity this tick can omit them.
 */
export interface WeaponStepConfig {
  /** Static weapon definitions keyed by id. Requirements: 3.1 */
  readonly weaponConfigs: ReadonlyMap<WeaponId, WeaponConfig>;
  /** Per-car fire intents this tick, in any order. */
  readonly fireInputs?: ReadonlyArray<WeaponFireInput>;
  /** The current simulation tick; recorded on spawned projectiles/hazards. */
  readonly tick: number;
  /**
   * The next projectile id to allocate. Ids are assigned sequentially in
   * deterministic (sorted-participant) fire order and the used-up counter is
   * returned in {@link WeaponStepResult.nextProjectileId}. Defaults to 0.
   */
  readonly nextProjectileId?: ProjectileId;
  /**
   * The next hazard id to allocate. Same sequential scheme as
   * {@link nextProjectileId}; the used-up counter is returned in
   * {@link WeaponStepResult.nextHazardId}. Defaults to 0.
   */
  readonly nextHazardId?: HazardId;
  /**
   * Contact radius (track units) used for projectile→car and hazard→car overlap
   * tests. Defaults to {@link DEFAULT_CONTACT_RADIUS}.
   */
  readonly contactRadius?: number;
  /**
   * Distance (track units) from a car's centre to its front/rear where a
   * projectile spawns / a hazard is dropped. Defaults to
   * {@link DEFAULT_MUZZLE_OFFSET}.
   */
  readonly muzzleOffset?: number;
}

/**
 * Extends {@link WeaponStepResult} with the updated car race states and the
 * advanced id counters. Because armor/ammo live in `CarRaceState`, the step
 * must return the mutated cars; the base `WeaponStepResult` (events +
 * `updatedState`) is preserved so the design contract still holds.
 */
export interface WeaponStepOutput extends WeaponStepResult {
  /** Fresh car race states after damage and ammo deduction. */
  readonly updatedCars: ReadonlyArray<CarRaceState>;
  /** The next unused projectile id after this step. */
  readonly nextProjectileId: ProjectileId;
  /** The next unused hazard id after this step. */
  readonly nextHazardId: HazardId;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default projectile/hazard→car contact radius in track units. */
export const DEFAULT_CONTACT_RADIUS = 1;

/** Default distance from a car centre to its muzzle/rear drop point. */
export const DEFAULT_MUZZLE_OFFSET = 1;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Clamps `value` into the inclusive range `[min, max]`. */
function clamp(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/** Squared distance between two points — avoids a sqrt in contact tests. */
function dist2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/**
 * Unit forward direction for a heading. Heading 0 = north (+Y), increasing
 * clockwise, matching `CarPhysicsState.heading`.
 */
function forwardDir(heading: number): Vec2 {
  return { x: Math.sin(heading), y: Math.cos(heading) };
}

/** Shallow-clones a car race state with a copied ammo map. */
function cloneCar(car: CarRaceState): CarRaceState {
  return {
    participantId: car.participantId,
    physics: car.physics,
    currentArmor: car.currentArmor,
    ammo: new Map(car.ammo),
    eliminated: car.eliminated,
    lap: car.lap,
    placement: car.placement,
    waypointIndex: car.waypointIndex,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Advances the weapon system by a single fixed timestep.
 *
 * @param state      Current weapon world (projectiles, hazards, per-car weapon state).
 * @param carStates  Current car race states (position/heading + armor + ammo).
 * @param dt         The fixed timestep in seconds (typically 1/60).
 * @param config     Weapon catalogue, fire intents, tick, and id counters.
 * @returns A {@link WeaponStepOutput}: emitted events, the updated weapon state,
 *   the updated car states, and the advanced id counters. Never mutates inputs.
 */
export function stepWeapons(
  state: Readonly<WeaponSystemState>,
  carStates: ReadonlyArray<CarRaceState>,
  dt: number,
  config: WeaponStepConfig,
): WeaponStepOutput {
  const {
    weaponConfigs,
    fireInputs = [],
    tick,
    contactRadius = DEFAULT_CONTACT_RADIUS,
    muzzleOffset = DEFAULT_MUZZLE_OFFSET,
  } = config;

  let nextProjectileId = config.nextProjectileId ?? 0;
  let nextHazardId = config.nextHazardId ?? 0;

  const events: WeaponEvent[] = [];

  // Working copies. Cars are cloned into a lookup keyed by participant so damage
  // and ammo deduction accumulate deterministically across all passes.
  const cars = new Map<ParticipantId, CarRaceState>();
  for (const car of carStates) {
    cars.set(car.participantId, cloneCar(car));
  }

  const projectiles: ActiveProjectile[] = [];
  const hazards: PlacedHazard[] = [];

  // Fire intents indexed by participant, processed in sorted order below.
  const fireByParticipant = new Map<ParticipantId, WeaponFireInput>();
  for (const fire of fireInputs) {
    fireByParticipant.set(fire.participantId, fire);
  }

  // Deterministic participant iteration order for every pass.
  const orderedIds = [...cars.keys()].sort((a, b) => a - b);

  // -------------------------------------------------------------------------
  // Pass 1: fire inputs — spawn projectiles / place hazards (Req 3.2, 3.3, 3.7)
  // -------------------------------------------------------------------------
  for (const id of orderedIds) {
    const fire = fireByParticipant.get(id);
    if (!fire) continue;
    const car = cars.get(id)!;
    if (car.eliminated) continue;

    // --- Forward weapon: spawn a projectile at the car's front. -----------
    if (fire.fireForward && fire.forwardWeaponId != null) {
      const def = weaponConfigs.get(fire.forwardWeaponId);
      if (def && def.category === 'forward' && def.beamDPS == null) {
        const ammo = car.ammo.get(def.id) ?? 0;
        // Block firing at zero ammo; never spend below zero (Req 3.7).
        if (ammo > 0) {
          car.ammo.set(def.id, clamp(ammo - 1, 0, def.ammoMax));

          const dir = forwardDir(car.physics.heading);
          const speed = def.projectileSpeed ?? 0;
          const projectile: ActiveProjectile = {
            id: nextProjectileId++,
            ownerId: id,
            weaponId: def.id,
            position: {
              x: car.physics.position.x + dir.x * muzzleOffset,
              y: car.physics.position.y + dir.y * muzzleOffset,
            },
            velocity: { x: dir.x * speed, y: dir.y * speed },
            spawnTick: tick,
          };
          projectiles.push(projectile);
          events.push({ type: 'projectile_fired', ownerId: id, projectile });
        }
      }
    }

    // --- Rear weapon: place a hazard at the car's rear. -------------------
    if (fire.fireRear && fire.rearWeaponId != null) {
      const def = weaponConfigs.get(fire.rearWeaponId);
      if (def && def.category === 'rear_drop') {
        const ammo = car.ammo.get(def.id) ?? 0;
        if (ammo > 0) {
          car.ammo.set(def.id, clamp(ammo - 1, 0, def.ammoMax));

          const dir = forwardDir(car.physics.heading);
          const hazard: PlacedHazard = {
            id: nextHazardId++,
            ownerId: id,
            weaponId: def.id,
            // Rear position = behind the car (opposite the forward direction).
            position: {
              x: car.physics.position.x - dir.x * muzzleOffset,
              y: car.physics.position.y - dir.y * muzzleOffset,
            },
            spawnTick: tick,
            triggered: false,
          };
          hazards.push(hazard);
          events.push({ type: 'hazard_placed', ownerId: id, hazard });
        }
      }
    }
  }

  // Track who dealt the last damage to each car so elimination can attribute a
  // killer, and which cars newly reached zero armor this tick.
  const lastAttacker = new Map<ParticipantId, ParticipantId | null>();

  /** Applies `amount` damage to `target` from `attacker`; returns remaining armor. */
  function applyDamage(
    targetId: ParticipantId,
    attackerId: ParticipantId | null,
    amount: number,
  ): number | null {
    const target = cars.get(targetId);
    if (!target || target.eliminated) return null;
    target.currentArmor = target.currentArmor - amount;
    lastAttacker.set(targetId, attackerId);
    return target.currentArmor;
  }

  // -------------------------------------------------------------------------
  // Pass 2: beam/laser continuous damage (Req 3.6)
  // -------------------------------------------------------------------------
  for (const id of orderedIds) {
    const fire = fireByParticipant.get(id);
    if (!fire || !fire.fireForward || fire.forwardWeaponId == null) continue;
    const attacker = cars.get(id)!;
    if (attacker.eliminated) continue;

    const def = weaponConfigs.get(fire.forwardWeaponId);
    if (!def || def.beamDPS == null) continue;

    const targetId = fire.beamTargetId ?? null;
    if (targetId == null) continue;
    const target = cars.get(targetId);
    if (!target || target.eliminated) continue;

    const damageDealt = def.beamDPS * dt;
    const remainingArmor = applyDamage(targetId, id, damageDealt);
    if (remainingArmor == null) continue;
    events.push({
      type: 'beam_damage',
      attackerId: id,
      targetId,
      weaponId: def.id,
      damageDealt,
      remainingArmor,
    });
  }

  // -------------------------------------------------------------------------
  // Pass 3: advance existing projectiles, resolve contacts (Req 3.4)
  // -------------------------------------------------------------------------
  const contactR2 = contactRadius * contactRadius;

  for (const proj of state.projectiles) {
    const def = weaponConfigs.get(proj.weaponId);

    // Integrate the projectile forward by one tick.
    const moved: ActiveProjectile = {
      ...proj,
      position: {
        x: proj.position.x + proj.velocity.x * dt,
        y: proj.position.y + proj.velocity.y * dt,
      },
    };

    // Find the first opponent car (deterministic order) the projectile now
    // overlaps. Projectiles never hit their owner.
    let hitTargetId: ParticipantId | null = null;
    for (const id of orderedIds) {
      if (id === proj.ownerId) continue;
      const target = cars.get(id)!;
      if (target.eliminated) continue;
      if (dist2(moved.position, target.physics.position) <= contactR2) {
        hitTargetId = id;
        break;
      }
    }

    if (hitTargetId != null && def) {
      const remainingArmor = applyDamage(hitTargetId, proj.ownerId, def.damage);
      if (remainingArmor != null) {
        events.push({
          type: 'hit',
          attackerId: proj.ownerId,
          targetId: hitTargetId,
          weaponId: def.id,
          damageDealt: def.damage,
          remainingArmor,
        });
      }
      // Projectile is consumed on contact; do not carry it forward.
      continue;
    }

    // Range check: drop the projectile once it has travelled past its maximum
    // effective range. Distance travelled is (elapsed ticks) × speed, where
    // speed is the projectile's constant velocity magnitude. `null` range means
    // unlimited (e.g. beam cannon) — the projectile is always retained.
    if (def && def.rangeUnits != null) {
      const speed = Math.hypot(moved.velocity.x, moved.velocity.y);
      const elapsedTicks = tick - moved.spawnTick + 1;
      const travelled = speed * dt * elapsedTicks;
      if (travelled > def.rangeUnits) {
        continue; // exceeded range: despawn.
      }
    }

    projectiles.push(moved);
  }

  // -------------------------------------------------------------------------
  // Pass 4: hazard contacts — any car including owner triggers (Req 3.8)
  // -------------------------------------------------------------------------
  for (const hazard of state.hazards) {
    if (hazard.triggered) continue; // already consumed in a prior tick
    const def = weaponConfigs.get(hazard.weaponId);

    let contactedId: ParticipantId | null = null;
    for (const id of orderedIds) {
      const car = cars.get(id)!;
      if (car.eliminated) continue;
      if (dist2(hazard.position, car.physics.position) <= contactR2) {
        contactedId = id;
        break;
      }
    }

    if (contactedId != null && def) {
      const remainingArmor = applyDamage(contactedId, hazard.ownerId, def.damage);
      if (remainingArmor != null) {
        events.push({
          type: 'hit',
          attackerId: hazard.ownerId,
          targetId: contactedId,
          weaponId: def.id,
          damageDealt: def.damage,
          remainingArmor,
        });
      }
      // Remove the hazard from the world this tick (Req 3.8): do not carry it.
      continue;
    }

    hazards.push(hazard);
  }

  // -------------------------------------------------------------------------
  // Pass 5: elimination — armor at or below zero this tick (Req 3.5)
  // -------------------------------------------------------------------------
  for (const id of orderedIds) {
    const car = cars.get(id)!;
    if (car.eliminated) continue;
    if (car.currentArmor <= 0) {
      car.eliminated = true;
      events.push({
        type: 'elimination',
        eliminatedId: id,
        killedById: lastAttacker.get(id) ?? null,
      });
    }
  }

  // Rebuild the updated car array in the original input order.
  const updatedCars = carStates.map((c) => cars.get(c.participantId)!);

  const updatedState: WeaponSystemState = {
    projectiles,
    hazards,
    weaponStates: state.weaponStates,
  };

  return {
    events,
    updatedState,
    updatedCars,
    nextProjectileId,
    nextHazardId,
  };
}
