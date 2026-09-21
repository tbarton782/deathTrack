/**
 * Unit tests for the AIBrain module (`computeAIInputs` and its helpers).
 *
 * Covers each Requirement 6 behaviour with focused examples: racing-line
 * steering, tier-gated forward fire via a controllable RNG, evasive
 * enter/exit hysteresis, hazard avoidance, rear-drop cone/distance, per-lap
 * throttle jitter band, and end-to-end determinism.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6
 */

import { describe, it, expect } from 'vitest';
import type { Vec2 } from '../../types/primitives.js';
import type { CarInputs, CarPhysicsState, RNG } from '../../types/physics.js';
import type { AIDriverConfig, AIDriverState, SkillTier } from '../../types/ai.js';
import type { PlacedHazard } from '../../types/weapons.js';
import type { WaypointGraph } from '../../types/track.js';
import { mkRNG } from '../../physics/rng.js';
import {
  computeAIInputs,
  nextEvasive,
  steerToward,
  steerAwayFrom,
  detectHazardAhead,
  nearestOpponentDistance,
  decideForwardFire,
  decideRearDrop,
  sampleLapThrottleJitter,
  FIRE_PROBABILITY_BY_TIER,
  HAZARD_RADIUS_BY_TIER,
  LAP_JITTER_MIN,
  LAP_JITTER_MAX,
  type AIBrainWorld,
} from '../AIBrain.js';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

/**
 * A deterministic RNG stub that replays a fixed queue of `next()` values.
 * Lets tests force fire draws above/below the tier probability precisely.
 */
function stubRNG(values: number[]): RNG {
  let i = 0;
  return {
    seed: 0,
    next(): number {
      const v = values[i % values.length]!;
      i += 1;
      return v;
    },
    nextInt(min: number, max: number): number {
      const v = values[i % values.length]!;
      i += 1;
      return min + Math.floor(v * (max - min + 1));
    },
  };
}

function car(
  overrides: Partial<CarPhysicsState> & { position: Vec2 },
): CarPhysicsState {
  return {
    id: 0,
    velocity: { x: 0, y: 0 },
    heading: 0,
    speed: 0,
    angularVelocity: 0,
    onTrack: true,
    airborne: false,
    airborneHeight: 0,
    airborneVY: 0,
    ...overrides,
  };
}

function hazard(id: number, position: Vec2): PlacedHazard {
  return {
    id,
    ownerId: 1,
    weaponId: 'mine',
    position,
    spawnTick: 0,
    triggered: false,
  };
}

/** A straight two-node graph heading north (+Y). */
function straightGraph(): WaypointGraph {
  return {
    nodes: [
      { id: 0, position: { x: 0, y: 0 }, width: 20 },
      { id: 1, position: { x: 0, y: 100 }, width: 20 },
    ],
    edges: [{ from: 0, to: 1, distance: 100 }],
  };
}

function driverState(
  overrides: Partial<AIDriverState> = {},
): AIDriverState {
  return {
    config: { character: 'sly', skillTier: 'standard', aggression: 3 },
    currentWaypointIndex: 0,
    evasive: false,
    lapThrottleJitter: 1,
    ...overrides,
  };
}

function config(overrides: Partial<AIDriverConfig> = {}): AIDriverConfig {
  return { character: 'sly', skillTier: 'standard', aggression: 3, ...overrides };
}

function world(overrides: Partial<AIBrainWorld> = {}): AIBrainWorld {
  return {
    self: car({ position: { x: 0, y: 0 }, heading: 0 }),
    selfArmor: 100,
    selfMaxArmor: 100,
    opponents: [],
    hazards: [],
    waypointGraph: straightGraph(),
    forwardWeaponRange: 50,
    rearWeaponLoaded: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Steering toward racing line (Req 6.1)
// ---------------------------------------------------------------------------

describe('steerToward (Req 6.1)', () => {
  it('returns ~0 when the target is straight ahead', () => {
    // Heading 0 = north (+Y). Target directly ahead.
    const s = steerToward({ x: 0, y: 0 }, 0, { x: 0, y: 10 });
    expect(Math.abs(s)).toBeLessThan(1e-6);
  });

  it('steers one way for a target to one side and the opposite for the other', () => {
    const left = steerToward({ x: 0, y: 0 }, 0, { x: -10, y: 0 });
    const right = steerToward({ x: 0, y: 0 }, 0, { x: 10, y: 0 });
    expect(Math.sign(left)).toBe(-Math.sign(right));
    expect(left).not.toBe(0);
  });

  it('clamps to [-1, 1]', () => {
    // Target directly behind -> ±180°, saturates.
    const s = steerToward({ x: 0, y: 0 }, 0, { x: 0.0001, y: -10 });
    expect(s).toBeGreaterThanOrEqual(-1);
    expect(s).toBeLessThanOrEqual(1);
  });

  it('computeAIInputs follows the racing line with no hazards', () => {
    // Car sits left of a straight north track; should steer toward the line.
    const w = world({ self: car({ position: { x: -5, y: 10 }, heading: 0 }) });
    const inputs = computeAIInputs(driverState(), w, config(), mkRNG(1));
    expect(inputs.steer).toBeGreaterThanOrEqual(-1);
    expect(inputs.steer).toBeLessThanOrEqual(1);
    expect(inputs.fireForward).toBe(false);
    expect(inputs.fireRear).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Forward-fire probability by tier (Req 6.2)
// ---------------------------------------------------------------------------

describe('decideForwardFire (Req 6.2)', () => {
  const opp = [car({ position: { x: 0, y: 10 } })]; // within range 50

  it('fires when the draw is below the tier probability', () => {
    for (const tier of ['novice', 'standard', 'expert'] as SkillTier[]) {
      const p = FIRE_PROBABILITY_BY_TIER[tier];
      const rng = stubRNG([p - 0.01]);
      expect(
        decideForwardFire({ x: 0, y: 0 }, opp, 50, tier, false, rng),
      ).toBe(true);
    }
  });

  it('does not fire when the draw is at/above the tier probability', () => {
    for (const tier of ['novice', 'standard', 'expert'] as SkillTier[]) {
      const p = FIRE_PROBABILITY_BY_TIER[tier];
      const rng = stubRNG([p]); // next() < p is false at exactly p
      expect(
        decideForwardFire({ x: 0, y: 0 }, opp, 50, tier, false, rng),
      ).toBe(false);
    }
  });

  it('does not fire when no opponent is within range', () => {
    const far = [car({ position: { x: 0, y: 1000 } })];
    const rng = stubRNG([0]); // would always fire if range passed
    expect(decideForwardFire({ x: 0, y: 0 }, far, 50, 'expert', false, rng)).toBe(
      false,
    );
  });

  it('does not fire while evasive', () => {
    const rng = stubRNG([0]);
    expect(decideForwardFire({ x: 0, y: 0 }, opp, 50, 'expert', true, rng)).toBe(
      false,
    );
  });

  it('does not fire when no forward weapon range is defined', () => {
    const rng = stubRNG([0]);
    expect(decideForwardFire({ x: 0, y: 0 }, opp, null, 'expert', false, rng)).toBe(
      false,
    );
  });

  it('produces roughly the tier probability over many draws with a real RNG', () => {
    const rng = mkRNG(42);
    let fires = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      if (decideForwardFire({ x: 0, y: 0 }, opp, 50, 'standard', false, rng)) {
        fires += 1;
      }
    }
    // Expect ~0.6; allow generous slack for the finite sample.
    expect(fires / N).toBeGreaterThan(0.55);
    expect(fires / N).toBeLessThan(0.65);
  });
});

// ---------------------------------------------------------------------------
// Evasive enter/exit thresholds (Req 6.3)
// ---------------------------------------------------------------------------

describe('nextEvasive (Req 6.3)', () => {
  it('enters evasive when armor drops below 25% of max', () => {
    expect(nextEvasive(false, 24, 100, 10)).toBe(true);
    expect(nextEvasive(false, 25, 100, 10)).toBe(false); // exactly 25% not below
  });

  it('stays evasive while armor is between 25% and 40% and a threat is near', () => {
    expect(nextEvasive(true, 30, 100, 50)).toBe(true);
  });

  it('exits evasive once armor recovers to 40% of max', () => {
    expect(nextEvasive(true, 40, 100, 10)).toBe(false);
  });

  it('exits evasive when no opponent is within 200 units even below 40%', () => {
    expect(nextEvasive(true, 30, 100, 201)).toBe(false);
    expect(nextEvasive(true, 30, 100, 200)).toBe(true); // exactly 200 still a threat
  });

  it('never evades when there is no armor system (maxArmor <= 0)', () => {
    expect(nextEvasive(true, 0, 0, 10)).toBe(false);
  });

  it('computeAIInputs ceases forward fire while evasive', () => {
    const w = world({
      selfArmor: 10, // 10% -> evasive
      selfMaxArmor: 100,
      opponents: [car({ position: { x: 0, y: 5 } })],
      forwardWeaponRange: 50,
    });
    // RNG would fire if allowed.
    const inputs = computeAIInputs(driverState(), w, config(), stubRNG([0]));
    expect(inputs.fireForward).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hazard avoidance (Req 6.4)
// ---------------------------------------------------------------------------

describe('hazard avoidance (Req 6.4)', () => {
  it('detects a hazard ahead within the tier radius', () => {
    // Heading north; hazard 40 units ahead.
    const h = [hazard(1, { x: 0, y: 40 })];
    expect(detectHazardAhead({ x: 0, y: 0 }, 0, h, 50)).toBeDefined();
    // Outside novice radius (50) at 60 units.
    const far = [hazard(1, { x: 0, y: 60 })];
    expect(detectHazardAhead({ x: 0, y: 0 }, 0, far, 50)).toBeUndefined();
  });

  it('ignores hazards behind the car', () => {
    const behind = [hazard(1, { x: 0, y: -40 })];
    expect(detectHazardAhead({ x: 0, y: 0 }, 0, behind, 50)).toBeUndefined();
  });

  it('ignores triggered hazards', () => {
    const h = [{ ...hazard(1, { x: 0, y: 40 }), triggered: true }];
    expect(detectHazardAhead({ x: 0, y: 0 }, 0, h, 50)).toBeUndefined();
  });

  it('radius scales by tier: expert sees a hazard a novice would miss', () => {
    const h = [hazard(1, { x: 0, y: 120 })];
    expect(detectHazardAhead({ x: 0, y: 0 }, 0, h, HAZARD_RADIUS_BY_TIER.novice)).toBeUndefined();
    expect(detectHazardAhead({ x: 0, y: 0 }, 0, h, HAZARD_RADIUS_BY_TIER.expert)).toBeDefined();
  });

  it('steers away from a hazard to one side', () => {
    // Hazard slightly to the right (x>0) while heading north -> steer left (negative).
    const s = steerAwayFrom({ x: 0, y: 0 }, 0, { x: 5, y: 20 });
    expect(s).toBeLessThan(0);
    // Hazard to the left -> steer right (positive).
    const s2 = steerAwayFrom({ x: 0, y: 0 }, 0, { x: -5, y: 20 });
    expect(s2).toBeGreaterThan(0);
  });

  it('computeAIInputs overrides racing line with avoidance when a hazard is ahead', () => {
    const w = world({
      self: car({ position: { x: 0, y: 0 }, heading: 0 }),
      hazards: [hazard(1, { x: 3, y: 20 })],
    });
    const inputs = computeAIInputs(driverState(), w, config({ skillTier: 'expert' }), mkRNG(1));
    // Hazard is to the right, so avoidance steers left (negative).
    expect(inputs.steer).toBeLessThan(0);
  });
});

// ---------------------------------------------------------------------------
// Rear-drop condition (Req 6.5)
// ---------------------------------------------------------------------------

describe('decideRearDrop (Req 6.5)', () => {
  // Self heading north (+Y); "behind" is south (-Y).
  const self = car({ position: { x: 0, y: 0 }, heading: 0 });

  it('drops when an opponent is within 10 units directly behind and loaded', () => {
    const opp = [car({ position: { x: 0, y: -8 } })];
    expect(decideRearDrop(self, opp, true, false)).toBe(true);
  });

  it('does not drop when the trailing opponent is beyond 10 units', () => {
    const opp = [car({ position: { x: 0, y: -11 } })];
    expect(decideRearDrop(self, opp, true, false)).toBe(false);
  });

  it('does not drop when the opponent is ahead, not behind', () => {
    const opp = [car({ position: { x: 0, y: 8 } })];
    expect(decideRearDrop(self, opp, true, false)).toBe(false);
  });

  it('does not drop when no rear weapon is loaded', () => {
    const opp = [car({ position: { x: 0, y: -8 } })];
    expect(decideRearDrop(self, opp, false, false)).toBe(false);
  });

  it('does not drop while evasive', () => {
    const opp = [car({ position: { x: 0, y: -8 } })];
    expect(decideRearDrop(self, opp, true, true)).toBe(false);
  });

  it('does not drop for an opponent outside the rear cone', () => {
    // Directly to the side at 5 units: within distance but not behind.
    const opp = [car({ position: { x: 5, y: 0 } })];
    expect(decideRearDrop(self, opp, true, false)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Lap throttle jitter band (Req 6.6)
// ---------------------------------------------------------------------------

describe('sampleLapThrottleJitter (Req 6.6)', () => {
  it('produces a multiplier within the ±2%..±10% band', () => {
    const rng = mkRNG(7);
    for (let i = 0; i < 500; i++) {
      const j = sampleLapThrottleJitter(rng);
      const mag = Math.abs(j - 1);
      expect(mag).toBeGreaterThanOrEqual(LAP_JITTER_MIN - 1e-9);
      expect(mag).toBeLessThanOrEqual(LAP_JITTER_MAX + 1e-9);
    }
  });

  it('produces both positive and negative jitter over many samples', () => {
    const rng = mkRNG(99);
    let up = 0;
    let down = 0;
    for (let i = 0; i < 200; i++) {
      const j = sampleLapThrottleJitter(rng);
      if (j > 1) up += 1;
      else if (j < 1) down += 1;
    }
    expect(up).toBeGreaterThan(0);
    expect(down).toBeGreaterThan(0);
  });

  it('computeAIInputs applies the carried lap jitter to throttle', () => {
    const w = world();
    const jittered = computeAIInputs(
      driverState({ lapThrottleJitter: 0.93 }),
      w,
      config(),
      mkRNG(1),
    );
    // Base throttle 1 * 0.93 clamped to [0,1] -> 0.93.
    expect(jittered.throttle).toBeCloseTo(0.93, 6);
  });
});

// ---------------------------------------------------------------------------
// Determinism (Req 6.1–6.6)
// ---------------------------------------------------------------------------

describe('computeAIInputs determinism', () => {
  it('yields identical inputs for identical args and RNG seed', () => {
    const w = world({
      self: car({ position: { x: -5, y: 10 }, heading: 0.2 }),
      opponents: [car({ position: { x: 0, y: 5 } })],
      forwardWeaponRange: 50,
      rearWeaponLoaded: true,
    });
    const run = (): CarInputs =>
      computeAIInputs(driverState(), w, config(), mkRNG(12345));
    expect(run()).toEqual(run());
  });

  it('does not mutate its inputs', () => {
    const driver = driverState();
    const w = world();
    const frozenDriver = JSON.parse(JSON.stringify(driver));
    computeAIInputs(driver, w, config(), mkRNG(1));
    expect(JSON.parse(JSON.stringify(driver))).toEqual(frozenDriver);
  });

  it('nearestOpponentDistance returns Infinity with no opponents', () => {
    expect(nearestOpponentDistance({ x: 0, y: 0 }, [])).toBe(Infinity);
  });
});
