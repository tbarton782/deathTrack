/**
 * Unit tests for the client {@link NetworkManager} netcode core.
 *
 * These exercise the pure prediction/reconciliation/interpolation logic with an
 * in-memory {@link Socket} fake and an injected clock — no real WebSocket, no
 * DOM. Covers: input encode+send, snapshot buffering by tick, interpolation
 * between two snapshots, RTT-bounded reconciliation correction + warning flag,
 * stale weapon-event discard (>200 ms), and full reset on checksum mismatch.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.7
 */

import { describe, it, expect } from 'vitest';
import {
  StateSnapshotCodec,
  type CarInputs,
  type CarPhysicsState,
  type CompressedCarState,
  type StateSnapshot,
  type InputFrame,
  type ParticipantId,
} from '@deathtrack/shared';
import {
  NetworkManager,
  encodeInputFrame,
  decodeInputFrame,
  CORRECTION_BOUND_LOW_RTT_M,
  CORRECTION_BOUND_HIGH_RTT_M,
  RING_BUFFER_SIZE,
  type Socket,
  type Clock,
  type NetworkManagerOptions,
  type StateSnapshotWithWeapons,
  type TimestampedWeaponEvent,
} from './NetworkManager.js';

// --- Test doubles ----------------------------------------------------------

class FakeSocket implements Socket {
  readonly sent: Uint8Array[] = [];
  private handler: ((bytes: Uint8Array) => void) | null = null;

  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }
  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.handler = cb;
  }
  /** Simulate an inbound packet from the server. */
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

function makeManager(overrides: Partial<NetworkManagerOptions> = {}): {
  mgr: NetworkManager;
  socket: FakeSocket;
  clock: FakeClock;
} {
  const socket = new FakeSocket();
  const clock = new FakeClock();
  const mgr = new NetworkManager({
    socket,
    clock,
    localId: LOCAL,
    sim: { trackId: 'bay-area' as never, rngSeed: 1 },
    ...overrides,
  });
  return { mgr, socket, clock };
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

function compressed(id: ParticipantId, x: number, y: number, extra: Partial<CompressedCarState> = {}): CompressedCarState {
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
    ...extra,
  };
}

function snapshot(
  tick: number,
  serverTime: number,
  cars: CompressedCarState[],
  authorityChecksum = 0,
): StateSnapshot {
  return { tick, serverTime, cars, events: [], authorityChecksum };
}

const IDLE: CarInputs = { throttle: 0, brake: 0, steer: 0, fireForward: false, fireRear: false };

// ---------------------------------------------------------------------------

describe('encodeInputFrame / decodeInputFrame', () => {
  it('round-trips an input frame', () => {
    const frame: InputFrame = {
      tick: 42,
      inputs: { throttle: 1, brake: 0, steer: -0.5, fireForward: true, fireRear: false },
      checksum: 0xdeadbeef,
    };
    expect(decodeInputFrame(encodeInputFrame(frame))).toEqual(frame);
  });
});

describe('sendInput', () => {
  it('encodes and sends the input frame over the socket', () => {
    const { mgr, socket } = makeManager();
    const frame: InputFrame = { tick: 7, inputs: IDLE, checksum: 123 };

    mgr.sendInput(frame);

    expect(socket.sent).toHaveLength(1);
    expect(decodeInputFrame(socket.sent[0]!)).toEqual(frame);
  });
});

describe('onSnapshot buffering', () => {
  it('decodes inbound packets and buffers snapshots keyed by tick', () => {
    const { mgr, socket } = makeManager();
    const snap = snapshot(10, 500, [compressed(LOCAL, 100, 200)]);

    socket.deliver(StateSnapshotCodec.encode(snap));

    // Buffered snapshot is available for interpolation at its own serverTime.
    const rs = mgr.getInterpolatedState(500);
    const car = rs.cars.find((c) => c.id === LOCAL)!;
    expect(car.position.x).toBeCloseTo(100);
    expect(car.position.y).toBeCloseTo(200);
  });

  it('caps the snapshot buffer to the ring-buffer size', () => {
    const { mgr } = makeManager();
    for (let i = 0; i < RING_BUFFER_SIZE + 10; i++) {
      mgr.onSnapshot(snapshot(i, i * 50, [compressed(LOCAL, i, 0)]));
    }
    // The very first snapshot should have been pruned; interpolating at its
    // time clamps to the oldest retained snapshot rather than tick 0.
    const rs = mgr.getInterpolatedState(0);
    const car = rs.cars.find((c) => c.id === LOCAL)!;
    expect(car.position.x).toBeGreaterThan(0);
  });
});

describe('getInterpolatedState', () => {
  it('interpolates position linearly between two bracketing snapshots', () => {
    const { mgr } = makeManager();
    mgr.onSnapshot(snapshot(1, 1000, [compressed(LOCAL, 0, 0)]));
    mgr.onSnapshot(snapshot(2, 1050, [compressed(LOCAL, 100, 200)]));

    const mid = mgr.getInterpolatedState(1025); // halfway between 1000 and 1050
    const car = mid.cars.find((c) => c.id === LOCAL)!;
    expect(car.position.x).toBeCloseTo(50);
    expect(car.position.y).toBeCloseTo(100);
  });

  it('clamps to the nearest snapshot outside the buffered range', () => {
    const { mgr } = makeManager();
    mgr.onSnapshot(snapshot(1, 1000, [compressed(LOCAL, 0, 0)]));
    mgr.onSnapshot(snapshot(2, 1050, [compressed(LOCAL, 100, 0)]));

    const before = mgr.getInterpolatedState(500).cars.find((c) => c.id === LOCAL)!;
    expect(before.position.x).toBeCloseTo(0);

    const after = mgr.getInterpolatedState(9999).cars.find((c) => c.id === LOCAL)!;
    expect(after.position.x).toBeCloseTo(100);
  });
});

describe('reconcile — RTT-bounded correction', () => {
  it('applies no correction when the delta is within the dead-zone', () => {
    const { mgr } = makeManager();
    mgr.setRtt(50);
    // Predicted local state at tick 5.
    mgr.recordPrediction(5, IDLE, carState(LOCAL, 100, 100));
    // Authoritative agrees (same position) → no correction.
    mgr.onSnapshot(snapshot(5, 250, [compressed(LOCAL, 100, 100)]));

    expect(mgr.getPendingCorrection()).toEqual({ x: 0, y: 0 });
    expect(mgr.isWarningActive()).toBe(false);
  });

  it('caps correction to 2 m and shows no warning when RTT <= 150 ms', () => {
    const { mgr } = makeManager();
    mgr.setRtt(100);
    mgr.recordPrediction(5, IDLE, carState(LOCAL, 0, 0));
    // Authoritative is 100 m away → correction must be clamped to 2 m.
    mgr.onSnapshot(snapshot(5, 250, [compressed(LOCAL, 100, 0)]));

    const c = mgr.getPendingCorrection();
    expect(Math.hypot(c.x, c.y)).toBeLessThanOrEqual(CORRECTION_BOUND_LOW_RTT_M + 1e-9);
    expect(Math.hypot(c.x, c.y)).toBeGreaterThan(0);
    expect(mgr.isWarningActive()).toBe(false);
  });

  it('caps correction to 5 m and shows warning when RTT > 150 ms', () => {
    const { mgr } = makeManager();
    mgr.setRtt(200);
    mgr.recordPrediction(5, IDLE, carState(LOCAL, 0, 0));
    mgr.onSnapshot(snapshot(5, 250, [compressed(LOCAL, 100, 0)]));

    const c = mgr.getPendingCorrection();
    const mag = Math.hypot(c.x, c.y);
    expect(mag).toBeLessThanOrEqual(CORRECTION_BOUND_HIGH_RTT_M + 1e-9);
    expect(mag).toBeGreaterThan(CORRECTION_BOUND_LOW_RTT_M); // uses the wider bound
    expect(mgr.isWarningActive()).toBe(true);
  });

  it('smoothly decays the correction to zero over the smoothing frames', () => {
    const { mgr } = makeManager();
    mgr.setRtt(100);
    mgr.recordPrediction(5, IDLE, carState(LOCAL, 0, 0));
    mgr.onSnapshot(snapshot(5, 250, [compressed(LOCAL, 100, 0)]));

    const startC = mgr.getPendingCorrection();
    expect(Math.hypot(startC.x, startC.y)).toBeGreaterThan(0);

    mgr.tickCorrection();
    mgr.tickCorrection();
    mgr.tickCorrection();

    expect(mgr.getPendingCorrection()).toEqual({ x: 0, y: 0 });
  });

  it('ignores out-of-order (older) snapshots without re-correcting', () => {
    const { mgr } = makeManager();
    mgr.setRtt(50);
    mgr.recordPrediction(5, IDLE, carState(LOCAL, 0, 0));
    mgr.recordPrediction(6, IDLE, carState(LOCAL, 0, 0));

    mgr.onSnapshot(snapshot(6, 300, [compressed(LOCAL, 0, 0)]));
    // A stale snapshot for an earlier tick arrives late — must not fabricate a jump.
    mgr.onSnapshot(snapshot(5, 250, [compressed(LOCAL, 100, 0)]));

    expect(mgr.getPendingCorrection()).toEqual({ x: 0, y: 0 });
  });
});

describe('reconcile — stale weapon event discard (Req 8.4)', () => {
  it('discards weapon events older than 200 ms without mutating state', () => {
    const { mgr } = makeManager();
    mgr.recordPrediction(5, IDLE, carState(LOCAL, 10, 10));

    const staleEvent: TimestampedWeaponEvent = {
      timestamp: 1000 - 250, // 250 ms before server time → stale
      event: { type: 'hit' } as never,
    };
    const freshEvent: TimestampedWeaponEvent = {
      timestamp: 1000 - 50, // 50 ms before server time → fresh
      event: { type: 'hit' } as never,
    };

    const snap: StateSnapshotWithWeapons = {
      ...snapshot(5, 1000, [compressed(LOCAL, 10, 10)]),
      weaponEvents: [staleEvent, freshEvent],
    };

    mgr.onSnapshot(snap);

    expect(mgr.getStaleWeaponEventCount()).toBe(1);
    // State untouched: no correction pending from a matching position snapshot.
    expect(mgr.getPendingCorrection()).toEqual({ x: 0, y: 0 });
  });
});

describe('reconcile — full reset on authorityChecksum mismatch (Req 8.5)', () => {
  it('resets local prediction to authoritative state on checksum mismatch', () => {
    const socket = new FakeSocket();
    const clock = new FakeClock();
    const mgr = new NetworkManager({
      socket,
      clock,
      localId: LOCAL,
      sim: { trackId: 'bay-area' as never, rngSeed: 1 },
      // Local checksum deliberately disagrees with the snapshot's.
      localChecksumForTick: () => 0x11111111,
    });

    // Build a diverged predicted buffer.
    for (let i = 0; i < 10; i++) {
      mgr.recordPrediction(i, IDLE, carState(LOCAL, i * 10, 0));
    }

    mgr.onSnapshot(snapshot(9, 450, [compressed(LOCAL, 500, 500)], 0x22222222));

    // Full reset clears pending correction; buffer is re-seeded from authority.
    expect(mgr.getPendingCorrection()).toEqual({ x: 0, y: 0 });

    // After reset, interpolation reflects the authoritative snapshot values.
    const car = mgr.getInterpolatedState(450).cars.find((c) => c.id === LOCAL)!;
    expect(car.position.x).toBeCloseTo(500);
    expect(car.position.y).toBeCloseTo(500);
  });

  it('does NOT reset when checksum matches', () => {
    const socket = new FakeSocket();
    const clock = new FakeClock();
    const mgr = new NetworkManager({
      socket,
      clock,
      localId: LOCAL,
      sim: { trackId: 'bay-area' as never, rngSeed: 1 },
      localChecksumForTick: () => 0x22222222,
    });
    mgr.setRtt(50);
    mgr.recordPrediction(5, IDLE, carState(LOCAL, 0, 0));

    // Matching checksum → normal reconciliation path (position agrees → no jump).
    mgr.onSnapshot(snapshot(5, 250, [compressed(LOCAL, 0, 0)], 0x22222222));
    expect(mgr.getPendingCorrection()).toEqual({ x: 0, y: 0 });
  });
});
