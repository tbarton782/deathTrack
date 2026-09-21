/**
 * Authoritative server-side network manager for the Deathtrack Multiplayer
 * server.
 *
 * Bridges the transport layer (WebSocket connections in production) and the
 * authoritative game/session state. It owns three responsibilities:
 *
 *   - {@link ServerNetworkManager.receiveInput} — accept a client input frame,
 *     validate its timestamp (reject stale / out-of-order frames), and store it
 *     in a bounded per-participant ring buffer (Requirements: 8.1, 8.5).
 *   - {@link ServerNetworkManager.broadcastSnapshot} — encode an authoritative
 *     {@link StateSnapshot} via {@link StateSnapshotCodec} and send the binary
 *     frame to every connected client at the 20 Hz authority cadence
 *     (Requirements: 8.1).
 *   - {@link ServerNetworkManager.onDisconnect} / {@link ServerNetworkManager.tick}
 *     — detect a participant that has been silent for more than 3 seconds
 *     (> 60 missed 60 Hz frames), freeze then remove its car, emit a
 *     {@link ParticipantLeftEvent}, and trigger a host transfer when the
 *     departing participant was the host (Requirements: 7.6, 7.8).
 *
 * ## Testability
 *
 * The concrete `ws` wiring is intentionally *not* referenced here. Instead the
 * transport is abstracted behind the minimal {@link ClientConnection} interface
 * ({@link ClientConnection.send} + {@link ClientConnection.id}), and the wall
 * clock is injected as {@link ServerNetworkManagerDeps.now}. This keeps the
 * manager unit-testable without opening real sockets and fully deterministic.
 * The concrete `ws` adapter is assembled in `index.ts` (task 12.8).
 *
 * Requirements: 7.6, 8.1, 8.5
 */

import type {
  InputFrame,
  ParticipantId,
  ParticipantLeftEvent,
  SessionId,
  StateSnapshot,
} from '@deathtrack/shared';
import { StateSnapshotCodec } from '@deathtrack/shared';
import { SessionManager } from '../session/SessionManager.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Simulation tick rate in Hz. Clients dispatch one {@link InputFrame} per tick
 * (Requirements: 8.1).
 */
export const SIMULATION_HZ = 60;

/**
 * Silence threshold, in milliseconds, after which a participant is treated as
 * disconnected: 3 seconds, i.e. more than 60 missed 60 Hz frames
 * (Requirements: 7.6).
 */
export const DISCONNECT_SILENCE_MS = 3000;

/**
 * Missed-frame equivalent of {@link DISCONNECT_SILENCE_MS} at
 * {@link SIMULATION_HZ}. A participant silent for more than this many frames
 * (> 60) is disconnected (Requirements: 7.6).
 */
export const DISCONNECT_MISSED_FRAMES = (DISCONNECT_SILENCE_MS / 1000) * SIMULATION_HZ;

/**
 * Capacity of each participant's input ring buffer. Holds 0.5 s of 60 Hz frames
 * (30 frames), matching the client-side prediction buffer window described in
 * the design.
 */
export const INPUT_RING_CAPACITY = 30;

// ---------------------------------------------------------------------------
// Transport abstraction
// ---------------------------------------------------------------------------

/**
 * Minimal transport handle for a single connected client, abstracting away the
 * concrete `ws` WebSocket so {@link ServerNetworkManager} stays unit-testable.
 *
 * The production adapter (task 12.8) wraps a `ws` socket; tests supply a fake
 * that records the bytes passed to {@link send}.
 */
export interface ClientConnection {
  /** Participant slot this connection belongs to. */
  readonly participantId: ParticipantId;
  /** Sends an encoded binary frame to the client. */
  send(bytes: Uint8Array): void;
}

/**
 * Injectable, non-deterministic dependencies. Defaults use the real wall clock;
 * tests override {@link now} to drive silence detection deterministically.
 */
export interface ServerNetworkManagerDeps {
  /** Returns the current time in milliseconds. Defaults to `Date.now`. */
  now: () => number;
}

// ---------------------------------------------------------------------------
// Input ring buffer
// ---------------------------------------------------------------------------

/**
 * Bounded FIFO ring buffer of {@link InputFrame}s for one participant. Retains
 * at most {@link INPUT_RING_CAPACITY} most-recent frames; older frames are
 * overwritten. Frames are stored in arrival order (which the manager guarantees
 * is monotonically increasing by `tick` — see {@link ServerNetworkManager.receiveInput}).
 */
export class InputRingBuffer {
  private readonly frames: InputFrame[] = [];

  constructor(private readonly capacity: number = INPUT_RING_CAPACITY) {}

  /** Appends a frame, evicting the oldest when at capacity. */
  push(frame: InputFrame): void {
    if (this.frames.length >= this.capacity) {
      this.frames.shift();
    }
    this.frames.push(frame);
  }

  /** The most-recently pushed frame, or `undefined` when empty. */
  latest(): InputFrame | undefined {
    return this.frames[this.frames.length - 1];
  }

  /** Number of frames currently buffered. */
  get size(): number {
    return this.frames.length;
  }

  /** Snapshot copy of the buffered frames in arrival (oldest-first) order. */
  toArray(): InputFrame[] {
    return [...this.frames];
  }
}

// ---------------------------------------------------------------------------
// Per-participant tracking record
// ---------------------------------------------------------------------------

interface ParticipantTrack {
  readonly ring: InputRingBuffer;
  /** Highest `tick` accepted so far; used to reject stale/out-of-order frames. */
  lastAcceptedTick: number;
  /** Wall-clock time (ms) of the last accepted frame; drives silence detection. */
  lastInputAt: number;
  /** `true` once the car has been frozen pending removal (Requirements: 7.6). */
  frozen: boolean;
}

// ---------------------------------------------------------------------------
// ServerNetworkManager
// ---------------------------------------------------------------------------

export class ServerNetworkManager {
  private readonly now: () => number;
  private readonly sessionManager: SessionManager;
  private readonly sessionId: SessionId;

  /** Connected transports keyed by participant slot. */
  private readonly connections = new Map<ParticipantId, ClientConnection>();
  /** Per-participant input/liveness tracking. */
  private readonly tracks = new Map<ParticipantId, ParticipantTrack>();
  /** Participant ids that have been removed (freeze completed). */
  private readonly removed = new Set<ParticipantId>();

  constructor(
    sessionManager: SessionManager,
    sessionId: SessionId,
    deps: Partial<ServerNetworkManagerDeps> = {},
  ) {
    this.sessionManager = sessionManager;
    this.sessionId = sessionId;
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Registers a client transport for a participant. Establishing a connection
   * also seeds the participant's liveness clock so it is not immediately
   * considered silent.
   */
  addConnection(connection: ClientConnection): void {
    const id = connection.participantId;
    this.connections.set(id, connection);
    if (!this.tracks.has(id)) {
      this.tracks.set(id, {
        ring: new InputRingBuffer(),
        lastAcceptedTick: -1,
        lastInputAt: this.now(),
        frozen: false,
      });
    }
    this.removed.delete(id);
  }

  /**
   * Accepts an input frame from a client. The frame's timestamp (`tick`) is
   * validated against the highest tick accepted so far for that participant:
   * frames whose tick is not strictly greater are rejected as stale or
   * out-of-order and are neither buffered nor counted toward liveness. Accepted
   * frames are stored in the per-participant ring buffer and refresh the
   * liveness clock.
   *
   * Returns `true` when the frame was accepted, `false` when rejected.
   *
   * Requirements: 8.1, 8.5
   */
  receiveInput(participantId: ParticipantId, frame: InputFrame): boolean {
    if (this.removed.has(participantId)) return false;

    let track = this.tracks.get(participantId);
    if (!track) {
      track = {
        ring: new InputRingBuffer(),
        lastAcceptedTick: -1,
        lastInputAt: this.now(),
        frozen: false,
      };
      this.tracks.set(participantId, track);
    }

    // Reject stale / out-of-order frames: tick must strictly advance.
    if (!Number.isFinite(frame.tick) || frame.tick <= track.lastAcceptedTick) {
      return false;
    }

    track.ring.push(frame);
    track.lastAcceptedTick = frame.tick;
    track.lastInputAt = this.now();
    // A late frame from a previously-frozen-but-not-removed car revives it.
    track.frozen = false;
    return true;
  }

  /**
   * Encodes the authoritative snapshot with {@link StateSnapshotCodec} and sends
   * the resulting binary frame to every connected client. The `tick` argument
   * overrides `snapshot.tick` so callers (the 20 Hz authority loop) can stamp
   * the broadcast with the current authoritative tick.
   *
   * Requirements: 8.1
   */
  broadcastSnapshot(snapshot: StateSnapshot, tick: number): void {
    const stamped: StateSnapshot = { ...snapshot, tick };
    const bytes = StateSnapshotCodec.encode(stamped);
    for (const connection of this.connections.values()) {
      connection.send(bytes);
    }
  }

  /**
   * Advances liveness detection to the current time and disconnects every
   * participant that has been silent for more than {@link DISCONNECT_SILENCE_MS}
   * (> {@link DISCONNECT_MISSED_FRAMES} missed frames). Intended to be called
   * once per authority cycle.
   *
   * Returns the {@link ParticipantLeftEvent}s emitted this cycle so the caller
   * can attach them to the next outgoing snapshot.
   *
   * Requirements: 7.6
   */
  tick(): ParticipantLeftEvent[] {
    const now = this.now();
    const events: ParticipantLeftEvent[] = [];
    for (const [id, track] of this.tracks) {
      if (this.removed.has(id)) continue;
      if (now - track.lastInputAt > DISCONNECT_SILENCE_MS) {
        const event = this.onDisconnect(id);
        if (event) events.push(event);
      }
    }
    return events;
  }

  /**
   * Handles a participant disconnection: freezes the car, removes it from the
   * simulation via the {@link SessionManager} (which triggers a host transfer
   * when the departing participant was the host), drops any transport, and
   * returns a {@link ParticipantLeftEvent} for broadcast. Idempotent — a second
   * call for an already-removed participant returns `null`.
   *
   * Requirements: 7.6, 7.8
   */
  onDisconnect(participantId: ParticipantId): ParticipantLeftEvent | null {
    if (this.removed.has(participantId)) return null;

    // 1. Freeze the car (clients stop extrapolating its motion) then remove it.
    const track = this.tracks.get(participantId);
    if (track) track.frozen = true;

    // 2. Remove from the session; SessionManager.removeParticipant transfers
    //    host status when needed and closes the session when empty.
    this.sessionManager.removeParticipant(this.sessionId, participantId);

    // 3. Drop transport + tracking state.
    this.connections.delete(participantId);
    this.tracks.delete(participantId);
    this.removed.add(participantId);

    // 4. Notify remaining participants.
    return { type: 'participant_left', participantId, reason: 'disconnect' };
  }

  // -------------------------------------------------------------------------
  // Introspection helpers (used by the authority loop and tests)
  // -------------------------------------------------------------------------

  /** Number of currently connected transports. */
  get connectionCount(): number {
    return this.connections.size;
  }

  /** Returns the buffered input frames for a participant (oldest-first). */
  getInputs(participantId: ParticipantId): InputFrame[] {
    return this.tracks.get(participantId)?.ring.toArray() ?? [];
  }

  /** Returns the most recent accepted input frame for a participant. */
  latestInput(participantId: ParticipantId): InputFrame | undefined {
    return this.tracks.get(participantId)?.ring.latest();
  }

  /** Whether a participant's car is currently frozen pending removal. */
  isFrozen(participantId: ParticipantId): boolean {
    return this.tracks.get(participantId)?.frozen ?? false;
  }
}
