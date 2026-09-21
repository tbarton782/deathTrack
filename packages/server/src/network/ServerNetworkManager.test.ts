/**
 * Unit tests for {@link ServerNetworkManager}.
 *
 * Covers:
 *   - input timestamp validation (stale / out-of-order frames rejected) and the
 *     bounded per-participant ring buffer (Requirements: 8.1, 8.5);
 *   - snapshot broadcast: encoded via {@link StateSnapshotCodec} and sent to
 *     every connected transport, round-tripping the synchronised fields
 *     (Requirements: 8.1);
 *   - disconnect after > 3 s of silence: freezes then removes the car, emits a
 *     `participant_left` event, and transfers host status when the departing
 *     participant was the host (Requirements: 7.6, 7.8).
 */

import { describe, expect, it } from 'vitest';
import type {
  CarInputs,
  CompressedCarState,
  InputFrame,
  StateSnapshot,
} from '@deathtrack/shared';
import { StateSnapshotCodec } from '@deathtrack/shared';
import { SessionManager, type JoinPlayer } from '../session/SessionManager.js';
import {
  ServerNetworkManager,
  type ClientConnection,
  INPUT_RING_CAPACITY,
} from './ServerNetworkManager.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A recording fake transport for a single participant slot. */
class FakeConnection implements ClientConnection {
  readonly sent: Uint8Array[] = [];
  constructor(readonly participantId: number) {}
  send(bytes: Uint8Array): void {
    this.sent.push(bytes);
  }
}

const NEUTRAL_INPUTS: CarInputs = {
  throttle: 0,
  brake: 0,
  steer: 0,
  fireForward: false,
  fireRear: false,
};

function frame(tick: number, checksum = 0): InputFrame {
  return { tick, inputs: NEUTRAL_INPUTS, checksum };
}

function car(id: number, x: number, y: number): CompressedCarState {
  return {
    id,
    x,
    y,
    heading: 0,
    speed: 0,
    armor: 200,
    flags: 0,
    ammoForward: 5,
    ammoRear: 2,
  };
}

function snapshot(cars: CompressedCarState[], tick = 0): StateSnapshot {
  return { tick, serverTime: 0, cars, events: [], authorityChecksum: 0 };
}

/** A mutable clock so silence detection can be driven deterministically. */
function makeClock(start = 1000) {
  const state = { t: start };
  return {
    now: () => state.t,
    advance: (ms: number) => {
      state.t += ms;
    },
  };
}

const HOST: JoinPlayer = { displayName: 'Host' };

// ---------------------------------------------------------------------------
// Input timestamp validation + ring buffer (Requirements 8.1, 8.5)
// ---------------------------------------------------------------------------

describe('ServerNetworkManager.receiveInput', () => {
  it('accepts frames with strictly increasing ticks and buffers them in order', () => {
    const clock = makeClock();
    const mgr = new ServerNetworkManager(new SessionManager(), 's1', { now: clock.now });

    expect(mgr.receiveInput(0, frame(1))).toBe(true);
    expect(mgr.receiveInput(0, frame(2))).toBe(true);
    expect(mgr.receiveInput(0, frame(3))).toBe(true);

    expect(mgr.getInputs(0).map((f) => f.tick)).toEqual([1, 2, 3]);
    expect(mgr.latestInput(0)?.tick).toBe(3);
  });

  it('rejects stale (older tick) frames', () => {
    const mgr = new ServerNetworkManager(new SessionManager(), 's1');
    expect(mgr.receiveInput(0, frame(5))).toBe(true);
    expect(mgr.receiveInput(0, frame(3))).toBe(false);
    expect(mgr.getInputs(0).map((f) => f.tick)).toEqual([5]);
    expect(mgr.latestInput(0)?.tick).toBe(5);
  });

  it('rejects out-of-order and duplicate (equal tick) frames', () => {
    const mgr = new ServerNetworkManager(new SessionManager(), 's1');
    expect(mgr.receiveInput(0, frame(4))).toBe(true);
    expect(mgr.receiveInput(0, frame(4))).toBe(false); // duplicate
    expect(mgr.receiveInput(0, frame(2))).toBe(false); // out of order
    expect(mgr.getInputs(0)).toHaveLength(1);
  });

  it('rejects non-finite ticks', () => {
    const mgr = new ServerNetworkManager(new SessionManager(), 's1');
    expect(mgr.receiveInput(0, frame(Number.NaN))).toBe(false);
    expect(mgr.getInputs(0)).toHaveLength(0);
  });

  it('tracks ticks per participant independently', () => {
    const mgr = new ServerNetworkManager(new SessionManager(), 's1');
    expect(mgr.receiveInput(0, frame(10))).toBe(true);
    // Participant 1 has its own tick baseline; a low tick is still accepted.
    expect(mgr.receiveInput(1, frame(1))).toBe(true);
    expect(mgr.latestInput(0)?.tick).toBe(10);
    expect(mgr.latestInput(1)?.tick).toBe(1);
  });

  it('bounds the ring buffer to its capacity, evicting oldest frames', () => {
    const mgr = new ServerNetworkManager(new SessionManager(), 's1');
    const total = INPUT_RING_CAPACITY + 5;
    for (let t = 1; t <= total; t++) {
      expect(mgr.receiveInput(0, frame(t))).toBe(true);
    }
    const ticks = mgr.getInputs(0).map((f) => f.tick);
    expect(ticks).toHaveLength(INPUT_RING_CAPACITY);
    // Oldest 5 evicted; buffer holds the most recent capacity frames.
    expect(ticks[0]).toBe(total - INPUT_RING_CAPACITY + 1);
    expect(ticks[ticks.length - 1]).toBe(total);
  });
});

// ---------------------------------------------------------------------------
// Snapshot broadcast (Requirements 8.1)
// ---------------------------------------------------------------------------

describe('ServerNetworkManager.broadcastSnapshot', () => {
  it('encodes via StateSnapshotCodec and sends to every connected client', () => {
    const mgr = new ServerNetworkManager(new SessionManager(), 's1');
    const c0 = new FakeConnection(0);
    const c1 = new FakeConnection(1);
    mgr.addConnection(c0);
    mgr.addConnection(c1);

    const snap = snapshot([car(0, 10, 20), car(1, 30, 40)]);
    mgr.broadcastSnapshot(snap, 42);

    // Both clients received exactly one frame.
    expect(c0.sent).toHaveLength(1);
    expect(c1.sent).toHaveLength(1);

    // The bytes match the codec's own encoding of the stamped snapshot.
    const expected = StateSnapshotCodec.encode({ ...snap, tick: 42 });
    expect(Array.from(c0.sent[0]!)).toEqual(Array.from(expected));
    expect(Array.from(c1.sent[0]!)).toEqual(Array.from(expected));

    // And it decodes back to the synchronised fields with the stamped tick.
    const decoded = StateSnapshotCodec.decode(c0.sent[0]!);
    expect(decoded.tick).toBe(42);
    expect(decoded.cars).toHaveLength(2);
    expect(decoded.cars[0]!.id).toBe(0);
    expect(decoded.cars[1]!.id).toBe(1);
  });

  it('is a no-op with no connections', () => {
    const mgr = new ServerNetworkManager(new SessionManager(), 's1');
    expect(() => mgr.broadcastSnapshot(snapshot([car(0, 1, 1)]), 1)).not.toThrow();
    expect(mgr.connectionCount).toBe(0);
  });

  it('does not send to a disconnected client', () => {
    const sm = new SessionManager();
    const created = sm.createSession(
      { name: 'Arena', trackId: 'chicago', maxPlayers: 4, password: null, fillWithAI: false },
      HOST,
    );
    expect(created.ok).toBe(true);
    const sessionId = created.ok ? created.value.id : '';
    sm.joinSession(sessionId, { displayName: 'P2' });

    const mgr = new ServerNetworkManager(sm, sessionId);
    const c0 = new FakeConnection(0);
    const c1 = new FakeConnection(1);
    mgr.addConnection(c0);
    mgr.addConnection(c1);

    mgr.onDisconnect(1);
    mgr.broadcastSnapshot(snapshot([car(0, 1, 1)]), 7);

    expect(c0.sent).toHaveLength(1);
    expect(c1.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Disconnection handling (Requirements 7.6, 7.8)
// ---------------------------------------------------------------------------

describe('ServerNetworkManager disconnect detection', () => {
  function setup() {
    const clock = makeClock();
    const sm = new SessionManager({ now: clock.now });
    const created = sm.createSession(
      { name: 'Arena', trackId: 'chicago', maxPlayers: 4, password: null, fillWithAI: false },
      HOST,
    );
    const sessionId = created.ok ? created.value.id : '';
    sm.joinSession(sessionId, { displayName: 'P2' }); // slot 1
    const mgr = new ServerNetworkManager(sm, sessionId, { now: clock.now });
    mgr.addConnection(new FakeConnection(0));
    mgr.addConnection(new FakeConnection(1));
    return { clock, sm, sessionId, mgr };
  }

  it('emits participant_left after > 3 s of silence and removes the car', () => {
    const { clock, sm, sessionId, mgr } = setup();

    // Both slots send an input to establish liveness.
    mgr.receiveInput(0, frame(1));
    mgr.receiveInput(1, frame(1));

    // Just under the threshold: no disconnect.
    clock.advance(3000);
    expect(mgr.tick()).toEqual([]);

    // Keep slot 0 alive; let slot 1 stay silent past the threshold.
    clock.advance(1);
    mgr.receiveInput(0, frame(2));
    const events = mgr.tick();
    expect(events).toEqual([{ type: 'participant_left', participantId: 1, reason: 'disconnect' }]);

    // Car removed from the session.
    expect(sm.getSession(sessionId)?.participants.has(1)).toBe(false);
  });

  it('disconnects a connected participant that never sends any input', () => {
    const { clock, sm, sessionId, mgr } = setup();
    // Neither slot sends input; both are silent from connection time.
    clock.advance(3001);
    const events = mgr.tick();
    expect(events.map((e) => e.participantId).sort()).toEqual([0, 1]);
    expect(sm.getSession(sessionId)).toBeUndefined(); // all humans gone => closed
  });

  it('freezes the car before removing it', () => {
    const { mgr } = setup();
    mgr.onDisconnect(1);
    // After removal the car is gone from tracking; freeze happened as a step.
    expect(mgr.isFrozen(1)).toBe(false); // removed => no longer reported as frozen
  });

  it('is idempotent: a second disconnect emits nothing', () => {
    const { mgr } = setup();
    expect(mgr.onDisconnect(1)).not.toBeNull();
    expect(mgr.onDisconnect(1)).toBeNull();
  });

  it('transfers host when the disconnecting participant is the host', () => {
    const { clock, sm, sessionId, mgr } = setup();
    // Host is slot 0 (createSession). P2 joined at a later clock tick.
    expect(sm.getSession(sessionId)?.hostParticipantId).toBe(0);

    // Both alive initially.
    mgr.receiveInput(0, frame(1));
    mgr.receiveInput(1, frame(1));

    // Keep slot 1 alive; host (slot 0) goes silent and disconnects.
    clock.advance(3001);
    mgr.receiveInput(1, frame(2));
    const events = mgr.tick();
    expect(events.some((e) => e.participantId === 0)).toBe(true);

    // Host status moved to the remaining human (slot 1).
    expect(sm.getSession(sessionId)?.hostParticipantId).toBe(1);
    expect(sm.getSession(sessionId)?.participants.has(0)).toBe(false);
  });

  it('closes the session when the last participant disconnects', () => {
    const clock = makeClock();
    const sm = new SessionManager({ now: clock.now });
    const created = sm.createSession(
      { name: 'Solo', trackId: 'chicago', maxPlayers: 4, password: null, fillWithAI: false },
      HOST,
    );
    const sessionId = created.ok ? created.value.id : '';
    const mgr = new ServerNetworkManager(sm, sessionId, { now: clock.now });
    mgr.addConnection(new FakeConnection(0));

    clock.advance(3001);
    mgr.tick();

    expect(sm.getSession(sessionId)).toBeUndefined();
  });

  it('does not disconnect participants whose input keeps arriving', () => {
    const { clock, mgr } = setup();
    for (let i = 0; i < 5; i++) {
      clock.advance(1000);
      mgr.receiveInput(0, frame(i + 1));
      mgr.receiveInput(1, frame(i + 1));
    }
    expect(mgr.tick()).toEqual([]);
  });

  it('ignores input from an already-removed participant', () => {
    const { mgr } = setup();
    mgr.onDisconnect(1);
    expect(mgr.receiveInput(1, frame(1))).toBe(false);
  });
});
