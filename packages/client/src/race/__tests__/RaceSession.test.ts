import { describe, it, expect } from 'vitest';

import { buildRaceRenderState, HUMAN_PARTICIPANT_ID } from '../RaceSession.js';
import type { CarRaceState } from '@deathtrack/shared';

/** Build a minimal CarRaceState at a position with a placement + eliminated flag. */
function car(
  id: number,
  x: number,
  y: number,
  placement: number,
  eliminated = false,
): CarRaceState {
  return {
    participantId: id,
    physics: {
      id,
      position: { x, y },
      velocity: { x: 0, y: 0 },
      heading: id * 0.1,
      speed: 0,
      angularVelocity: 0,
      onTrack: true,
      airborne: false,
      airborneHeight: id, // distinct per car so we can assert the mapping
      airborneVY: 0,
    },
    currentArmor: 100,
    ammo: new Map(),
    eliminated,
    lap: 1,
    placement,
    waypointIndex: 0,
  };
}

describe('buildRaceRenderState', () => {
  it('maps every car to a RenderCar preserving id/position/heading/airborne/eliminated', () => {
    const cars = [car(0, 10, 20, 2), car(1, 30, 40, 1, true)];
    const state = buildRaceRenderState(cars);

    expect(state.cars).toHaveLength(2);
    const c0 = state.cars.find((c) => c.id === 0)!;
    expect(c0.position).toEqual({ x: 10, y: 20 });
    expect(c0.heading).toBeCloseTo(0);
    expect(c0.airborneHeight).toBe(0);
    expect(c0.eliminated).toBe(false);

    const c1 = state.cars.find((c) => c.id === 1)!;
    expect(c1.position).toEqual({ x: 30, y: 40 });
    expect(c1.airborneHeight).toBe(1);
    expect(c1.eliminated).toBe(true);
  });

  it('follows the leading non-eliminated car (lowest placement) with the camera', () => {
    // Car 1 leads (placement 1) but is eliminated; camera should follow the
    // best-placed car that is still racing (car 0 at placement 2).
    const cars = [car(0, 10, 20, 2, false), car(1, 30, 40, 1, true)];
    const state = buildRaceRenderState(cars);
    expect(state.cameraTarget.position).toEqual({ x: 10, y: 20 });
  });

  it('follows the outright leader when it is still racing', () => {
    const cars = [car(0, 10, 20, 2, false), car(1, 30, 40, 1, false)];
    const state = buildRaceRenderState(cars);
    expect(state.cameraTarget.position).toEqual({ x: 30, y: 40 });
  });

  it('falls back to the field when all cars are eliminated', () => {
    const cars = [car(0, 10, 20, 2, true), car(1, 30, 40, 1, true)];
    const state = buildRaceRenderState(cars);
    // Best placement among all cars is car 1 (placement 1).
    expect(state.cameraTarget.position).toEqual({ x: 30, y: 40 });
  });

  it('defaults scene collections to empty and omits absent optional fields', () => {
    const state = buildRaceRenderState([car(0, 0, 0, 1)]);
    expect(state.scenery).toEqual([]);
    expect(state.hazards).toEqual([]);
    expect(state.projectiles).toEqual([]);
    expect('eliminations' in state).toBe(false);
    expect('palette' in state).toBe(false);
    expect('atlas' in state).toBe(false);
  });

  it('passes through supplied eliminations', () => {
    const elim = { type: 'elimination' as const, eliminatedId: 1, killedById: 0 };
    const state = buildRaceRenderState([car(0, 0, 0, 1)], { eliminations: [elim] });
    expect(state.eliminations).toEqual([elim]);
  });

  it('places the human in slot 0', () => {
    expect(HUMAN_PARTICIPANT_ID).toBe(0);
  });
});
