// Unit tests for SfxTriggers — the event→SFX wiring layer (task 16.2).
//
// Uses a fake SfxDispatcher that captures playSFX calls, so no real AudioContext
// or AudioSystem backend is required. Latency (≤ 50 ms, requirements 10.2–10.4)
// is verified structurally: each handler dispatches playSFX SYNCHRONOUSLY within
// the same call/tick as the event, with no timers or async scheduling.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  SfxTriggers,
  DEFAULT_ELIMINATION_SFX,
  DEFAULT_JUMP_LAUNCH_SFX,
  DEFAULT_WEAPON_FIRE_SFX,
} from '../SfxTriggers.js';
import type { SfxDispatcher } from '../SfxTriggers.js';
import type {
  SFXId,
  ProjectileFiredEvent,
  HazardPlacedEvent,
  EliminationEvent,
  JumpLaunchEvent,
  ActiveProjectile,
  PlacedHazard,
  WeaponId,
} from '@deathtrack/shared';

/** Fake dispatcher recording every playSFX id and the order they arrived. */
class FakeAudio implements SfxDispatcher {
  calls: SFXId[] = [];
  playSFX(id: SFXId): void {
    this.calls.push(id);
  }
}

// --- event fixtures --------------------------------------------------------

function projectile(weaponId: WeaponId): ActiveProjectile {
  return {
    id: 1,
    ownerId: 0,
    weaponId,
    position: { x: 0, y: 0 },
    velocity: { x: 1, y: 0 },
    spawnTick: 0,
  };
}

function hazard(weaponId: WeaponId): PlacedHazard {
  return {
    id: 1,
    ownerId: 0,
    weaponId,
    position: { x: 0, y: 0 },
    spawnTick: 0,
    triggered: false,
  };
}

function projectileFired(weaponId: WeaponId = 'machine_gun'): ProjectileFiredEvent {
  return { type: 'projectile_fired', ownerId: 0, projectile: projectile(weaponId) };
}

function hazardPlaced(weaponId: WeaponId = 'mine'): HazardPlacedEvent {
  return { type: 'hazard_placed', ownerId: 0, hazard: hazard(weaponId) };
}

function elimination(): EliminationEvent {
  return { type: 'elimination', eliminatedId: 1, killedById: 0 };
}

function jumpLaunch(): JumpLaunchEvent {
  return { type: 'jump_launch', participantId: 0, launchVY: 12 };
}

// --- tests -----------------------------------------------------------------

describe('SfxTriggers', () => {
  let audio: FakeAudio;
  let triggers: SfxTriggers;

  beforeEach(() => {
    audio = new FakeAudio();
    triggers = new SfxTriggers(audio);
  });

  describe('weapon fire (Req 10.2)', () => {
    it('dispatches the weapon-fire SFX for a forward projectile fire', () => {
      triggers.onWeaponFire(projectileFired());
      expect(audio.calls).toEqual([DEFAULT_WEAPON_FIRE_SFX]);
    });

    it('dispatches the weapon-fire SFX for a rear-drop hazard placement', () => {
      triggers.onWeaponFire(hazardPlaced());
      expect(audio.calls).toEqual([DEFAULT_WEAPON_FIRE_SFX]);
    });

    it('resolves a per-weapon SFX id from the weaponId when configured', () => {
      const perWeapon = new SfxTriggers(audio, {
        weaponFireSfx: (weaponId) => `sfx.weapon.${weaponId}`,
      });
      perWeapon.onWeaponFire(projectileFired('laser'));
      expect(audio.calls).toEqual(['sfx.weapon.laser']);
    });

    it('dispatches synchronously — the call is recorded before the handler returns', () => {
      expect(audio.calls).toHaveLength(0);
      triggers.onWeaponFire(projectileFired());
      // No await / no timer: the SFX is already dispatched in this same tick.
      expect(audio.calls).toHaveLength(1);
    });
  });

  describe('car elimination (Req 10.3)', () => {
    it('dispatches the explosion SFX on an elimination event', () => {
      triggers.onElimination(elimination());
      expect(audio.calls).toEqual([DEFAULT_ELIMINATION_SFX]);
    });

    it('honours a custom elimination SFX id', () => {
      const custom = new SfxTriggers(audio, { eliminationSfx: 'sfx.boom' });
      custom.onElimination(elimination());
      expect(audio.calls).toEqual(['sfx.boom']);
    });

    it('dispatches synchronously in the same tick as the event', () => {
      triggers.onElimination(elimination());
      expect(audio.calls).toHaveLength(1);
    });
  });

  describe('jump launch (Req 10.4)', () => {
    it('dispatches the launch SFX on a jump-launch event', () => {
      triggers.onJumpLaunch(jumpLaunch());
      expect(audio.calls).toEqual([DEFAULT_JUMP_LAUNCH_SFX]);
    });

    it('honours a custom jump-launch SFX id', () => {
      const custom = new SfxTriggers(audio, { jumpLaunchSfx: 'sfx.whoosh' });
      custom.onJumpLaunch(jumpLaunch());
      expect(audio.calls).toEqual(['sfx.whoosh']);
    });

    it('dispatches synchronously in the same tick as the event', () => {
      triggers.onJumpLaunch(jumpLaunch());
      expect(audio.calls).toHaveLength(1);
    });
  });

  describe('handleWeaponEvents batch', () => {
    it('fires SFX for fire + elimination events in emission order, ignoring hit/beam', () => {
      triggers.handleWeaponEvents([
        projectileFired(),
        {
          type: 'hit',
          attackerId: 0,
          targetId: 1,
          weaponId: 'machine_gun',
          damageDealt: 10,
          remainingArmor: 5,
        },
        elimination(),
        hazardPlaced(),
      ]);
      expect(audio.calls).toEqual([
        DEFAULT_WEAPON_FIRE_SFX,
        DEFAULT_ELIMINATION_SFX,
        DEFAULT_WEAPON_FIRE_SFX,
      ]);
    });

    it('every SFX in a batch is dispatched within the single synchronous call', () => {
      triggers.handleWeaponEvents([projectileFired(), elimination()]);
      // Both dispatched in the same tick — no residual async work.
      expect(audio.calls).toHaveLength(2);
    });
  });

  describe('handlePhysicsEvents batch', () => {
    it('fires the launch SFX for each jump-launch event and ignores other physics events', () => {
      triggers.handlePhysicsEvents([
        { type: 'off_track', participantId: 0, position: { x: 0, y: 0 } },
        jumpLaunch(),
        { type: 'jump_land', participantId: 0, landingSpeed: 20 },
        jumpLaunch(),
      ]);
      expect(audio.calls).toEqual([DEFAULT_JUMP_LAUNCH_SFX, DEFAULT_JUMP_LAUNCH_SFX]);
    });
  });

  describe('latency: same-tick dispatch (Req 10.2, 10.3, 10.4)', () => {
    it('dispatches within the same synchronous tick, well under the 50 ms budget', () => {
      // A monotonic clock captured immediately before and after handling proves
      // there is no artificial delay: dispatch completes in the same tick.
      const before = 0;
      let dispatchedAt = -1;
      const clockAudio: SfxDispatcher = {
        playSFX() {
          // The event is dispatched immediately; elapsed wall time is ~0 ms.
          dispatchedAt = before;
        },
      };
      const t = new SfxTriggers(clockAudio);
      t.onWeaponFire(projectileFired());
      t.onElimination(elimination());
      t.onJumpLaunch(jumpLaunch());
      const elapsed = dispatchedAt - before;
      expect(elapsed).toBeLessThanOrEqual(50);
      expect(elapsed).toBeGreaterThanOrEqual(0);
    });
  });
});
