import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  EXPLOSION_DEFAULT_DURATION_MS,
  EXPLOSION_MAX_DURATION_MS,
  EXPLOSION_MIN_DURATION_MS,
  ExplosionManager,
  advanceExplosion,
  clampExplosionDuration,
  explosionProgress,
  isExplosionActive,
  isExplosionFinished,
  spawnExplosion,
} from '../explosion';
import type { EliminationEvent, Vec2 } from '@deathtrack/shared';

/**
 * Headless unit + property tests for the PURE explosion lifetime state machine.
 * These run in the `node` vitest environment and never touch PixiJS or WebGL —
 * the AnimatedSprite draw glue in Renderer.spawnExplosion / advanceExplosions is
 * browser-only and is not covered here.
 *
 * Validates: Requirement 2.7 (explosion duration clamped to [500, 1500] ms,
 * plays at the eliminated car's last-known position, remove car sprite on
 * completion; multiple concurrent explosions tracked independently).
 */

// ---------------------------------------------------------------------------
// Duration clamping (Requirement 2.7: 500–1500 ms)
// ---------------------------------------------------------------------------

describe('clampExplosionDuration (Requirement 2.7)', () => {
  it('leaves an in-range duration unchanged', () => {
    expect(clampExplosionDuration(1000)).toBe(1000);
    expect(clampExplosionDuration(EXPLOSION_MIN_DURATION_MS)).toBe(500);
    expect(clampExplosionDuration(EXPLOSION_MAX_DURATION_MS)).toBe(1500);
  });

  it('clamps a too-short duration up to 500 ms', () => {
    expect(clampExplosionDuration(100)).toBe(EXPLOSION_MIN_DURATION_MS);
    expect(clampExplosionDuration(0)).toBe(EXPLOSION_MIN_DURATION_MS);
    expect(clampExplosionDuration(-500)).toBe(EXPLOSION_MIN_DURATION_MS);
  });

  it('clamps a too-long duration down to 1500 ms', () => {
    expect(clampExplosionDuration(2000)).toBe(EXPLOSION_MAX_DURATION_MS);
    expect(clampExplosionDuration(10_000)).toBe(EXPLOSION_MAX_DURATION_MS);
  });

  it('falls back to the default for non-finite input', () => {
    expect(clampExplosionDuration(Number.NaN)).toBe(EXPLOSION_DEFAULT_DURATION_MS);
    expect(clampExplosionDuration(Number.POSITIVE_INFINITY)).toBe(
      EXPLOSION_DEFAULT_DURATION_MS,
    );
  });

  it('always returns a value within [500, 1500] for any finite request', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e6, max: 1e6, noNaN: true }), (req) => {
        const d = clampExplosionDuration(req);
        expect(d).toBeGreaterThanOrEqual(EXPLOSION_MIN_DURATION_MS);
        expect(d).toBeLessThanOrEqual(EXPLOSION_MAX_DURATION_MS);
      }),
    );
  });

  it('spawn clamps the requested duration into range', () => {
    expect(spawnExplosion(0, { x: 0, y: 0 }, { durationMs: 50 }).durationMs).toBe(
      EXPLOSION_MIN_DURATION_MS,
    );
    expect(
      spawnExplosion(0, { x: 0, y: 0 }, { durationMs: 9999 }).durationMs,
    ).toBe(EXPLOSION_MAX_DURATION_MS);
    expect(spawnExplosion(0, { x: 0, y: 0 }).durationMs).toBe(
      EXPLOSION_DEFAULT_DURATION_MS,
    );
  });
});

// ---------------------------------------------------------------------------
// Active during lifetime, finished after (Requirement 2.7)
// ---------------------------------------------------------------------------

describe('explosion lifetime (Requirement 2.7)', () => {
  it('is active immediately on spawn', () => {
    const e = spawnExplosion(3, { x: 10, y: 20 }, { durationMs: 1000 });
    expect(isExplosionActive(e)).toBe(true);
    expect(isExplosionFinished(e)).toBe(false);
    expect(explosionProgress(e)).toBe(0);
  });

  it('stays active while elapsed < duration', () => {
    const e = spawnExplosion(1, { x: 0, y: 0 }, { durationMs: 1000 });
    advanceExplosion(e, 400);
    expect(isExplosionActive(e)).toBe(true);
    expect(isExplosionFinished(e)).toBe(false);
    expect(explosionProgress(e)).toBeCloseTo(0.4, 10);
  });

  it('is finished once elapsed reaches the duration', () => {
    const e = spawnExplosion(1, { x: 0, y: 0 }, { durationMs: 1000 });
    const justFinished = advanceExplosion(e, 1000);
    expect(justFinished).toBe(true);
    expect(isExplosionActive(e)).toBe(false);
    expect(isExplosionFinished(e)).toBe(true);
    expect(explosionProgress(e)).toBe(1);
  });

  it('remains finished after overshooting the duration', () => {
    const e = spawnExplosion(1, { x: 0, y: 0 }, { durationMs: 500 });
    advanceExplosion(e, 5000);
    expect(isExplosionFinished(e)).toBe(true);
    expect(explosionProgress(e)).toBe(1);
  });

  it('reports the just-finished transition exactly once', () => {
    const e = spawnExplosion(1, { x: 0, y: 0 }, { durationMs: 1000 });
    expect(advanceExplosion(e, 600)).toBe(false); // still active
    expect(advanceExplosion(e, 600)).toBe(true); // crosses the finish line
    expect(advanceExplosion(e, 600)).toBe(false); // already finished before
  });

  it('ignores negative time deltas', () => {
    const e = spawnExplosion(1, { x: 0, y: 0 }, { durationMs: 1000 });
    advanceExplosion(e, 300);
    advanceExplosion(e, -1000);
    expect(e.elapsedMs).toBe(300);
    expect(isExplosionActive(e)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Spawn position matches the eliminated car's last-known position
// ---------------------------------------------------------------------------

describe('spawn position (Requirement 2.7)', () => {
  it('pins the explosion to the last-known car position', () => {
    const pos: Vec2 = { x: 123.5, y: -47.25 };
    const e = spawnExplosion(2, pos);
    expect(e.position).toEqual({ x: 123.5, y: -47.25 });
  });

  it('copies the position so later mutation does not move the explosion', () => {
    const pos: Vec2 = { x: 5, y: 6 };
    const e = spawnExplosion(2, pos);
    pos.x = 999;
    pos.y = 999;
    expect(e.position).toEqual({ x: 5, y: 6 });
  });

  it('carries the eliminated participant id through', () => {
    const event: EliminationEvent = {
      type: 'elimination',
      eliminatedId: 7,
      killedById: 2,
    };
    const e = spawnExplosion(event.eliminatedId, { x: 1, y: 2 });
    expect(e.eliminatedId).toBe(7);
  });
});

// ---------------------------------------------------------------------------
// ExplosionManager: finish schedules car removal; concurrency
// ---------------------------------------------------------------------------

describe('ExplosionManager (Requirement 2.7)', () => {
  it('schedules the car for removal exactly when its explosion finishes', () => {
    const m = new ExplosionManager();
    m.spawn(4, { x: 0, y: 0 }, { durationMs: 1000 });

    expect(m.advance(500).carsToRemove).toEqual([]); // still active
    expect(m.advance(600).carsToRemove).toEqual([4]); // crosses finish → remove car
    expect(m.advance(600).carsToRemove).toEqual([]); // already removed
    expect(m.has(4)).toBe(false);
  });

  it('tracks multiple concurrent explosions independently', () => {
    const m = new ExplosionManager();
    m.spawn(1, { x: 0, y: 0 }, { durationMs: 500 });
    m.spawn(2, { x: 10, y: 10 }, { durationMs: 1500 });
    expect(m.size).toBe(2);

    // 600 ms: the short explosion (1) finishes, the long one (2) does not.
    const r1 = m.advance(600);
    expect(r1.carsToRemove).toEqual([1]);
    expect(m.has(1)).toBe(false);
    expect(m.has(2)).toBe(true);
    expect(isExplosionActive(m.get(2)!)).toBe(true);

    // A further 1000 ms (1600 total) finishes explosion 2.
    const r2 = m.advance(1000);
    expect(r2.carsToRemove).toEqual([2]);
    expect(m.size).toBe(0);
  });

  it('keeps distinct positions per concurrent explosion', () => {
    const m = new ExplosionManager();
    m.spawn(1, { x: 1, y: 2 });
    m.spawn(2, { x: 30, y: 40 });
    expect(m.get(1)!.position).toEqual({ x: 1, y: 2 });
    expect(m.get(2)!.position).toEqual({ x: 30, y: 40 });
  });

  it('re-spawning restarts the animation for that participant', () => {
    const m = new ExplosionManager();
    m.spawn(1, { x: 0, y: 0 }, { durationMs: 500 });
    m.advance(400);
    m.spawn(1, { x: 9, y: 9 }, { durationMs: 500 }); // fresh elimination
    expect(m.get(1)!.elapsedMs).toBe(0);
    expect(m.get(1)!.position).toEqual({ x: 9, y: 9 });
    expect(m.size).toBe(1);
  });

  it('clear() drops all tracked explosions', () => {
    const m = new ExplosionManager();
    m.spawn(1, { x: 0, y: 0 });
    m.spawn(2, { x: 0, y: 0 });
    m.clear();
    expect(m.size).toBe(0);
  });

  it('each concurrent explosion finishes exactly once across many steps', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            id: fc.integer({ min: 0, max: 7 }),
            duration: fc.double({ min: 500, max: 1500, noNaN: true }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        fc.array(fc.double({ min: 1, max: 400, noNaN: true }), {
          minLength: 1,
          maxLength: 30,
        }),
        (specs, deltas) => {
          const m = new ExplosionManager();
          // De-duplicate ids (map keys), tracking the last duration spawned.
          const spawned = new Map<number, number>();
          for (const s of specs) {
            m.spawn(s.id, { x: 0, y: 0 }, { durationMs: s.duration });
            spawned.set(s.id, clampExplosionDuration(s.duration));
          }

          const removedCounts = new Map<number, number>();
          for (const d of deltas) {
            for (const id of m.advance(d).carsToRemove) {
              removedCounts.set(id, (removedCounts.get(id) ?? 0) + 1);
            }
          }
          // No car reported more than once.
          for (const count of removedCounts.values()) {
            expect(count).toBe(1);
          }
        },
      ),
    );
  });
});
