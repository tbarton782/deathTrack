// packages/client/src/audio/SfxTriggers.ts
//
// SFX event wiring — maps game/physics/weapon events to sound-effect playback.
//
// Design (see design.md "Audio System" and requirements 10.2, 10.3, 10.4):
//   - Weapon fire  → play the weapon's firing SFX within 50 ms of the event (Req 10.2).
//   - Car elimination → play the explosion SFX within 50 ms of the event (Req 10.3).
//   - Jump launch  → play the launch SFX within 50 ms of the event (Req 10.4).
//
// The "≤ 50 ms" latency requirement is met by dispatching `playSFX` SYNCHRONOUSLY
// on the tick the event is observed — there is no timer, microtask, or artificial
// delay between receiving an event and calling `playSFX`. This module is a thin,
// pure mapping layer that consumes the AudioSystem's public `playSFX` API; it does
// not touch the Web Audio backend or the AudioSystem's internals, so it stays
// decoupled from concurrent work on AudioSystem's toggle/channel logic.
//
// It is headlessly unit-testable: the only dependency is the narrow
// {@link SfxDispatcher} interface (satisfied by {@link AudioSystem}), which can be
// replaced by a fake that records `playSFX` calls — no real AudioContext needed.

import type {
  SFXId,
  WeaponEvent,
  ProjectileFiredEvent,
  HazardPlacedEvent,
  EliminationEvent,
  PhysicsEvent,
  JumpLaunchEvent,
  WeaponId,
} from '@deathtrack/shared';

/**
 * The minimal slice of the AudioSystem this module needs: the ability to start a
 * sound effect by id. {@link AudioSystem} satisfies this structurally, and tests
 * substitute a fake that captures calls.
 */
export interface SfxDispatcher {
  playSFX(id: SFXId): void;
}

/**
 * Default SFX identifiers for the three wired triggers. These are stable string
 * keys the audio backend resolves to loaded buffers; the elimination and jump
 * sounds are shared across all cars, while the weapon-fire sound is normally
 * resolved per weapon (see {@link SfxTriggerOptions.weaponFireSfx}).
 */
export const DEFAULT_ELIMINATION_SFX: SFXId = 'sfx.explosion';
export const DEFAULT_JUMP_LAUNCH_SFX: SFXId = 'sfx.jump_launch';
export const DEFAULT_WEAPON_FIRE_SFX: SFXId = 'sfx.weapon_fire';

/**
 * Options controlling how events map to SFX ids.
 */
export interface SfxTriggerOptions {
  /**
   * Resolve the firing SFX for a given weapon. When omitted, every weapon fire
   * uses {@link DEFAULT_WEAPON_FIRE_SFX}. A real game wires this to the weapon
   * catalogue so each weapon plays its configured sound.
   */
  weaponFireSfx?: (weaponId: WeaponId) => SFXId;
  /** SFX id played on car elimination. Defaults to {@link DEFAULT_ELIMINATION_SFX}. */
  eliminationSfx?: SFXId;
  /** SFX id played on jump launch. Defaults to {@link DEFAULT_JUMP_LAUNCH_SFX}. */
  jumpLaunchSfx?: SFXId;
}

/**
 * Wires simulation events to sound-effect playback on an {@link SfxDispatcher}.
 *
 * All handlers dispatch `playSFX` synchronously — the SFX for an event is
 * requested in the same call (same tick) the event is handed to this class, with
 * no scheduling in between. This is what satisfies the ≤ 50 ms latency budget for
 * requirements 10.2–10.4: the only delay is the caller's own frame cadence.
 */
export class SfxTriggers {
  private readonly audio: SfxDispatcher;
  private readonly weaponFireSfx: (weaponId: WeaponId) => SFXId;
  private readonly eliminationSfx: SFXId;
  private readonly jumpLaunchSfx: SFXId;

  constructor(audio: SfxDispatcher, options: SfxTriggerOptions = {}) {
    this.audio = audio;
    this.weaponFireSfx = options.weaponFireSfx ?? (() => DEFAULT_WEAPON_FIRE_SFX);
    this.eliminationSfx = options.eliminationSfx ?? DEFAULT_ELIMINATION_SFX;
    this.jumpLaunchSfx = options.jumpLaunchSfx ?? DEFAULT_JUMP_LAUNCH_SFX;
  }

  /**
   * Play the firing SFX for a weapon-fire event. Both forward projectile fires
   * and rear-drop hazard placements count as "a weapon is fired" (Req 10.2).
   * Dispatched synchronously.
   */
  onWeaponFire(event: ProjectileFiredEvent | HazardPlacedEvent): void {
    let weaponId: WeaponId;
    if (event.type === 'projectile_fired') {
      weaponId = event.projectile.weaponId;
    } else {
      weaponId = event.hazard.weaponId;
    }
    this.audio.playSFX(this.weaponFireSfx(weaponId));
  }

  /**
   * Play the explosion SFX for a car-elimination event (Req 10.3).
   * Dispatched synchronously.
   */
  onElimination(_event: EliminationEvent): void {
    this.audio.playSFX(this.eliminationSfx);
  }

  /**
   * Play the launch SFX for a jump-launch event (Req 10.4).
   * Dispatched synchronously.
   */
  onJumpLaunch(_event: JumpLaunchEvent): void {
    this.audio.playSFX(this.jumpLaunchSfx);
  }

  /**
   * Fan out a batch of weapon events emitted by the Weapon System in a single
   * tick, dispatching SFX for the fire and elimination events. Events are handled
   * in emission order and each `playSFX` call happens synchronously within this
   * call, so every triggered sound is requested in the same tick the events
   * arrive (Req 10.2, 10.3).
   */
  handleWeaponEvents(events: ReadonlyArray<WeaponEvent>): void {
    for (const event of events) {
      switch (event.type) {
        case 'projectile_fired':
        case 'hazard_placed':
          this.onWeaponFire(event);
          break;
        case 'elimination':
          this.onElimination(event);
          break;
        // 'hit' and 'beam_damage' have no wired trigger in task 16.2.
        default:
          break;
      }
    }
  }

  /**
   * Fan out a batch of physics events emitted in a single tick, dispatching the
   * launch SFX for each jump-launch event synchronously (Req 10.4).
   */
  handlePhysicsEvents(events: ReadonlyArray<PhysicsEvent>): void {
    for (const event of events) {
      if (event.type === 'jump_launch') {
        this.onJumpLaunch(event);
      }
    }
  }
}
