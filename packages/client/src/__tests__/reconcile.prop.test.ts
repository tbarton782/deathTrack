/**
 * Property-based test for client reconciliation correction bounding.
 *
 * Property 20: Client reconciliation correction is bounded by the latency
 * regime. For an arbitrary predicted local position, an arbitrary authoritative
 * position (any divergence magnitude, including very large jumps), and an
 * arbitrary RTT, after {@link NetworkManager.onSnapshot} the magnitude of the
 * pending correction (from {@link NetworkManager.getPendingCorrection}) never
 * exceeds the RTT-appropriate bound:
 *   - <= 2 m when RTT <= 150 ms (Req 8.2)
 *   - <= 5 m when RTT >  150 ms (Req 8.3)
 * Additionally the warning indicator is active if and only if RTT > 150 ms.
 *
 * Validates: Requirements 8.2, 8.3
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  type CarInputs,
  type CarPhysicsState,
  type CompressedCarState,
  type StateSnapshot,
  type ParticipantId,
} from '@deathtrack/shared';
import {
  NetworkManager,
  RTT_THRESHOLD_MS,
  CORRECTION_BOUND_LOW_RTT_M,
  CORRECTION_BOUND_HIGH_RTT_M,
  type Socket,
  type Clock,
} from '../network/NetworkManager.js';

// --- Minimal test doubles (mirrors NetworkManager.test.ts) -----------------

class FakeSocket implements Socket {
  readonly sent: Uint8Array[] = [];
  private handler: ((bytes: Uint8Array) => void) | null = null;
  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }
  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.handler = cb;
  }
  deliver(bytes: Uint8Array): void {
    this.handler?.(bytes);
  }
}

class FakeClock implements Clock {
  constructor(public t = 0) {}
  now(): number {
    return this.t;
  }
}

const LOCAL: ParticipantId = 0 as ParticipantId;
const IDLE: CarInputs = { throttle: 0, brake: 0, steer: 0, fireForward: false, fireRear: false };

function makeManager(): NetworkManager {
  return new NetworkManager({
    socket: new FakeSocket(),
    clock: new FakeClock(),
    localId: LOCAL,
    sim: { trackId: 'bay-area' as never, rngSeed: 1 },
  });
}

function carState(id: ParticipantId, x: number, y: number): CarPhysicsState {
  return {
    id,
    position: { x, y },
    velocity: { x: 0, y: 0 },
    heading: 0,
    speed: 0,
    angularVelocity: 0,
    onTrack: true,
    airborne: false,
    airborneHeight: 0,
    airborneVY: 0,
  };
}

function compressed(id: ParticipantId, x: number, y: number): CompressedCarState {
  return {
    id,
    x,
    y,
    heading: 0,
    speed: 0,
    armor: 100,
    flags: 0x04, // onTrack
    ammoForward: 5,
    ammoRear: 2,
  };
}

function snapshot(tick: number, serverTime: number, cars: CompressedCarState[]): StateSnapshot {
  return { tick, serverTime, cars, events: [], authorityChecksum: 0 };
}

// A finite coordinate covering both tiny and huge divergences.
const coord = fc.double({ min: -100_000, max: 100_000, noNaN: true, noDefaultInfinity: true });
// RTT spanning both regimes, including the boundary at 150 ms.
const rtt = fc.double({ min: 0, max: 2_000, noNaN: true, noDefaultInfinity: true });

describe('Property 20: reconciliation correction is bounded by the latency regime', () => {
  it('caps the pending correction to the RTT-appropriate bound and toggles the warning at the threshold', () => {
    // Validates: Requirements 8.2, 8.3
    fc.assert(
      fc.property(coord, coord, coord, coord, rtt, (px, py, ax, ay, rttMs) => {
        const mgr = makeManager();
        mgr.setRtt(rttMs);

        const tick = 5;
        mgr.recordPrediction(tick, IDLE, carState(LOCAL, px, py));
        mgr.onSnapshot(snapshot(tick, 250, [compressed(LOCAL, ax, ay)]));

        const c = mgr.getPendingCorrection();
        const mag = Math.hypot(c.x, c.y);

        const bound = rttMs > RTT_THRESHOLD_MS ? CORRECTION_BOUND_HIGH_RTT_M : CORRECTION_BOUND_LOW_RTT_M;

        // The correction never exceeds the regime bound (small epsilon for FP).
        expect(mag).toBeLessThanOrEqual(bound + 1e-6);

        // Warning is active iff RTT strictly exceeds the threshold.
        expect(mgr.isWarningActive()).toBe(rttMs > RTT_THRESHOLD_MS);
      }),
      { numRuns: 1000 },
    );
  });

  it('never exceeds the high-RTT bound (5 m) regardless of regime', () => {
    // Validates: Requirements 8.2, 8.3
    fc.assert(
      fc.property(coord, coord, coord, coord, rtt, (px, py, ax, ay, rttMs) => {
        const mgr = makeManager();
        mgr.setRtt(rttMs);
        mgr.recordPrediction(5, IDLE, carState(LOCAL, px, py));
        mgr.onSnapshot(snapshot(5, 250, [compressed(LOCAL, ax, ay)]));

        const c = mgr.getPendingCorrection();
        expect(Math.hypot(c.x, c.y)).toBeLessThanOrEqual(CORRECTION_BOUND_HIGH_RTT_M + 1e-6);
      }),
      { numRuns: 500 },
    );
  });
});
