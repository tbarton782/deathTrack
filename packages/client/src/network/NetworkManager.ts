/**
 * Client-side network manager: prediction, reconciliation, and interpolation.
 *
 * This module implements the client half of the server-authoritative netcode
 * described in design.md §8 (Network Manager (Client)) and Requirement 8:
 *
 * - Local inputs are sent to the server and buffered in a 30-frame ring buffer
 *   (0.5 s at 60 Hz) alongside the locally-predicted car state for each tick.
 * - When an authoritative {@link StateSnapshot} arrives, {@link NetworkManager.reconcile}
 *   locates the snapshot's tick in the ring buffer, compares the buffered
 *   predicted state to the authoritative state, re-simulates forward with the
 *   buffered inputs, and applies a *bounded* smooth-lerp correction:
 *     - ≤ 2 m per update cycle when RTT ≤ 150 ms (Req 8.2)
 *     - ≤ 5 m per update cycle when RTT > 150 ms, plus a warning indicator (Req 8.3)
 * - Remote weapon-fire events older than 200 ms (relative to snapshot
 *   `serverTime`) are discarded and counted as a miss, without mutating any
 *   simulation state (Req 8.4).
 * - When a snapshot's `authorityChecksum` disagrees with the client's locally
 *   computed checksum for that tick, the client performs a full state reset to
 *   the authoritative values (Req 8.5 / design.md "Desync").
 *
 * ## Testability
 *
 * The WebSocket is abstracted behind the tiny {@link Socket} interface and the
 * wall clock behind an injected {@link Clock} (`now()`), so the entire
 * prediction/reconciliation/interpolation core is unit-testable with no real
 * WebSocket and no DOM. A thin browser adapter ({@link createWebSocketSocket})
 * is provided separately and is the only place that touches the global
 * `WebSocket`.
 *
 * Requirements: 8.1, 8.2, 8.3, 8.4, 8.5, 8.7
 */

import {
  StateSnapshotCodec,
  stepPhysics,
  mkRNG,
  FIXED_TIMESTEP,
  type InputFrame,
  type StateSnapshot,
  type CompressedCarState,
  type CarInputs,
  type CarPhysicsState,
  type ParticipantId,
  type TrackId,
  type WeaponEvent,
  type PhysicsWorldState,
} from '@deathtrack/shared';

// ---------------------------------------------------------------------------
// Abstractions (keep the core free of DOM / global WebSocket)
// ---------------------------------------------------------------------------

/**
 * Minimal transport abstraction over a bidirectional binary socket. The browser
 * adapter wraps a real `WebSocket`; unit tests supply an in-memory fake.
 */
export interface Socket {
  /** Send an encoded packet to the server. */
  send(bytes: Uint8Array): void;
  /** Register a handler invoked for each inbound binary packet. */
  onMessage(cb: (bytes: Uint8Array) => void): void;
}

/** Injected wall-clock source so time-dependent logic stays deterministic in tests. */
export interface Clock {
  /** Current time in milliseconds (monotonic-ish; `Date.now`/`performance.now` in prod). */
  now(): number;
}

/**
 * Everything the manager needs to re-simulate forward during reconciliation:
 * the track identity plus a way to feed per-car stats / track geometry into
 * {@link stepPhysics}. These come from the loaded track and resolved loadouts.
 */
export interface SimulationContext {
  readonly trackId: TrackId;
  /** Deterministic RNG seed shared with the authority for identical stepping. */
  readonly rngSeed: number;
  /** Optional per-car physics stats forwarded to {@link stepPhysics}. */
  readonly carStats?: ReadonlyMap<ParticipantId, import('@deathtrack/shared').PhysicsCarStats>;
  /** Optional track signed-distance field for off-track detection. */
  readonly trackSDF?: import('@deathtrack/shared').TrackSDF;
  /** Max armor per car, used when decompressing authoritative car state. */
  readonly maxArmor?: ReadonlyMap<ParticipantId, number>;
}

export interface NetworkManagerOptions {
  socket: Socket;
  clock: Clock;
  /** The local participant whose car is predicted/reconciled. */
  localId: ParticipantId;
  sim: SimulationContext;
  /**
   * Function that computes the client's local CRC-32 checksum for a given tick,
   * to compare against a snapshot's `authorityChecksum`. When omitted, checksum
   * mismatch detection is disabled (reconciliation still runs).
   */
  localChecksumForTick?: (tick: number) => number;
}

// ---------------------------------------------------------------------------
// Constants (design.md §8, Requirement 8)
// ---------------------------------------------------------------------------

/** Ring-buffer capacity: 30 frames = 0.5 s at 60 Hz (design.md §8 step 2). */
export const RING_BUFFER_SIZE = 30;

/** RTT threshold separating the two correction regimes (Req 8.2 / 8.3). */
export const RTT_THRESHOLD_MS = 150;

/** Max positional correction per update cycle when RTT ≤ 150 ms, in metres (Req 8.2). */
export const CORRECTION_BOUND_LOW_RTT_M = 2;

/** Max positional correction per update cycle when RTT > 150 ms, in metres (Req 8.3). */
export const CORRECTION_BOUND_HIGH_RTT_M = 5;

/** Below this positional delta no smooth-lerp correction is applied (design.md §8 step 4). */
export const CORRECTION_DEADZONE_M = 2;

/** Number of render frames a correction is smoothed over (design.md §8 step 4). */
export const CORRECTION_SMOOTH_FRAMES = 3;

/** Remote weapon events older than this (relative to server time) are discarded (Req 8.4). */
export const WEAPON_EVENT_MAX_AGE_MS = 200;

/** Heading encoded as uint8 (0–255 → 0–2π) in {@link CompressedCarState}. */
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Internal buffer records
// ---------------------------------------------------------------------------

/** One entry in the local prediction ring buffer, keyed by tick. */
interface PredictedFrame {
  readonly tick: number;
  readonly inputs: CarInputs;
  /** Locally predicted state for the local car at the end of this tick. */
  readonly state: CarPhysicsState;
}

/** A decoded server snapshot retained for interpolation, keyed by tick. */
interface BufferedSnapshot {
  readonly tick: number;
  readonly serverTime: number;
  readonly snapshot: StateSnapshot;
}

/** A pending smooth-lerp correction spread over {@link CORRECTION_SMOOTH_FRAMES}. */
interface PendingCorrection {
  /** Remaining per-axis offset to fold back into the rendered position. */
  offset: { x: number; y: number };
  framesRemaining: number;
}

/** A single interpolated car for the renderer. */
export interface RenderCar {
  readonly id: ParticipantId;
  readonly position: { x: number; y: number };
  readonly heading: number;
  readonly speed: number;
  readonly armor: number;
  readonly eliminated: boolean;
  readonly airborne: boolean;
  readonly onTrack: boolean;
  readonly ammoForward: number;
  readonly ammoRear: number;
}

/** The interpolated snapshot the renderer consumes each animation frame. */
export interface RenderState {
  /** Interpolation timestamp (server-time ms) this state was produced for. */
  readonly renderTime: number;
  readonly cars: readonly RenderCar[];
  /** True while RTT exceeds the threshold; drives the on-screen lag warning. */
  readonly warning: boolean;
}

// ---------------------------------------------------------------------------
// NetworkManager
// ---------------------------------------------------------------------------

export class NetworkManager {
  private readonly socket: Socket;
  private readonly clock: Clock;
  private readonly localId: ParticipantId;
  private readonly sim: SimulationContext;
  private readonly localChecksumForTick?: (tick: number) => number;

  /** Ring buffer of the last {@link RING_BUFFER_SIZE} predicted frames, oldest first. */
  private readonly predicted: PredictedFrame[] = [];

  /** Decoded server snapshots retained for interpolation, keyed by tick. */
  private readonly snapshots = new Map<number, BufferedSnapshot>();

  /** Measured round-trip time in milliseconds; updated via {@link setRtt}. */
  private rttMs = 0;

  /** Sticky lag-warning flag; true whenever RTT last exceeded the threshold. */
  private warning = false;

  /** Count of remote weapon events discarded for being stale (Req 8.4). */
  private staleWeaponEventCount = 0;

  /** Active smooth-lerp correction for the local car, if any. */
  private pendingCorrection: PendingCorrection | null = null;

  /** Highest snapshot tick fully reconciled, to ignore out-of-order/stale snapshots. */
  private lastReconciledTick = -1;

  constructor(opts: NetworkManagerOptions) {
    this.socket = opts.socket;
    this.clock = opts.clock;
    this.localId = opts.localId;
    this.sim = opts.sim;
    if (opts.localChecksumForTick) {
      this.localChecksumForTick = opts.localChecksumForTick;
    }

    this.socket.onMessage((bytes) => {
      const snapshot = StateSnapshotCodec.decode(bytes);
      this.onSnapshot(snapshot);
    });
  }

  // --- Public API (matches design.md §8) ----------------------------------

  /**
   * Encode a local input frame and send it over the socket. The frame is also
   * retained locally (see {@link recordPrediction}) so reconciliation can
   * re-simulate from it.
   *
   * Requirements: 8.1
   */
  sendInput(frame: InputFrame): void {
    this.socket.send(encodeInputFrame(frame));
  }

  /**
   * Record the locally-predicted state produced for `tick` after applying
   * `inputs`, into the 30-frame ring buffer. Callers invoke this once per local
   * physics tick right after predicting forward.
   *
   * Requirements: 8.1, 8.2
   */
  recordPrediction(tick: number, inputs: CarInputs, state: CarPhysicsState): void {
    this.predicted.push({ tick, inputs, state });
    while (this.predicted.length > RING_BUFFER_SIZE) {
      this.predicted.shift();
    }
  }

  /**
   * Handle a decoded authoritative snapshot: buffer it (keyed by tick) for
   * interpolation and drive reconciliation.
   *
   * Requirements: 8.1, 8.4, 8.5, 8.7
   */
  onSnapshot(snapshot: StateSnapshot): void {
    this.snapshots.set(snapshot.tick, {
      tick: snapshot.tick,
      serverTime: snapshot.serverTime,
      snapshot,
    });
    this.pruneSnapshotBuffer();
    this.reconcile(snapshot);
  }

  /**
   * Reconcile local prediction against an authoritative snapshot.
   *
   * Algorithm (design.md §8):
   * 1. Refresh the warning flag from current RTT.
   * 2. Discard stale remote weapon events (>200 ms) without mutating state.
   * 3. If a local checksum function is provided and it disagrees with the
   *    snapshot's `authorityChecksum`, perform a full state reset and stop.
   * 4. Otherwise find the snapshot's tick in the ring buffer, re-simulate the
   *    local car forward with the buffered inputs, and compare against the
   *    predicted state to derive the positional delta.
   * 5. If the delta exceeds the dead-zone, apply a bounded smooth-lerp
   *    correction (≤2 m at low RTT, ≤5 m at high RTT).
   *
   * Requirements: 8.2, 8.3, 8.4, 8.5
   */
  reconcile(snapshot: StateSnapshot): void {
    if (snapshot.tick <= this.lastReconciledTick) {
      // Out-of-order / duplicate snapshot: still discard stale events but do
      // not re-apply a correction we've already superseded.
      this.discardStaleWeaponEvents(snapshot);
      return;
    }

    this.warning = this.rttMs > RTT_THRESHOLD_MS;
    this.discardStaleWeaponEvents(snapshot);

    // Desync detection → full reset (Req 8.5).
    if (this.localChecksumForTick) {
      const localChecksum = this.localChecksumForTick(snapshot.tick);
      if ((localChecksum >>> 0) !== (snapshot.authorityChecksum >>> 0)) {
        this.fullReset(snapshot);
        this.lastReconciledTick = snapshot.tick;
        return;
      }
    }

    const authoritative = snapshot.cars.find((c) => c.id === this.localId);
    if (!authoritative) {
      this.lastReconciledTick = snapshot.tick;
      return;
    }

    const idx = this.predicted.findIndex((f) => f.tick === snapshot.tick);
    if (idx === -1) {
      // The snapshot's tick has already aged out of the ring buffer (or we have
      // no prediction for it yet). Nothing to reconcile from — the next
      // snapshot within the window will correct us. Do NOT fabricate a jump.
      this.lastReconciledTick = snapshot.tick;
      return;
    }

    // Predicted local position at the snapshot tick.
    const predictedState = this.predicted[idx]!.state;
    const authState = this.decompressLocal(authoritative);

    // Re-simulate forward from the authoritative state using the inputs we
    // buffered after the snapshot tick, to know where the *corrected* car ends
    // up "now". The correction we render is the delta between that re-simulated
    // position and our predicted position.
    const resimulated = this.resimulateFrom(authState, idx + 1);

    const dx = resimulated.position.x - predictedState.position.x;
    const dy = resimulated.position.y - predictedState.position.y;
    const delta = Math.hypot(dx, dy);

    if (delta > CORRECTION_DEADZONE_M) {
      this.applyBoundedCorrection(dx, dy, delta);
    }

    this.lastReconciledTick = snapshot.tick;
  }

  /**
   * Produce the interpolated render state for `renderTime` (in server-time ms)
   * by linearly interpolating between the two buffered snapshots that bracket
   * that timestamp. When only one snapshot is available it is returned as-is;
   * when `renderTime` is outside the buffered range the nearest snapshot is
   * clamped to.
   *
   * The local car's rendered position additionally folds in any active
   * smooth-lerp correction so visual pops are avoided (design.md §8 step 4).
   *
   * Requirements: 8.1
   */
  getInterpolatedState(renderTime: number): RenderState {
    const ordered = [...this.snapshots.values()].sort((a, b) => a.serverTime - b.serverTime);

    const first = ordered[0];
    if (!first) {
      return { renderTime, cars: [], warning: this.warning };
    }
    const last = ordered[ordered.length - 1]!;
    if (ordered.length === 1) {
      return this.snapshotToRenderState(first.snapshot, renderTime);
    }

    // Clamp before the first / after the last buffered snapshot.
    if (renderTime <= first.serverTime) {
      return this.snapshotToRenderState(first.snapshot, renderTime);
    }
    if (renderTime >= last.serverTime) {
      return this.snapshotToRenderState(last.snapshot, renderTime);
    }

    // Find the bracketing pair [a, b] with a.serverTime <= renderTime < b.serverTime.
    let a = first;
    let b = last;
    for (let i = 0; i < ordered.length - 1; i++) {
      const lo = ordered[i]!;
      const hi = ordered[i + 1]!;
      if (lo.serverTime <= renderTime && renderTime < hi.serverTime) {
        a = lo;
        b = hi;
        break;
      }
    }

    const span = b.serverTime - a.serverTime;
    const t = span > 0 ? (renderTime - a.serverTime) / span : 0;
    return this.interpolatePair(a.snapshot, b.snapshot, t, renderTime);
  }

  /**
   * Advance any active smooth-lerp correction by one render frame, folding a
   * fraction of the remaining offset back to zero. Call once per animation
   * frame. Returns the residual offset currently applied to the local car
   * (mainly useful for tests).
   */
  tickCorrection(): { x: number; y: number } {
    if (!this.pendingCorrection) return { x: 0, y: 0 };
    const c = this.pendingCorrection;
    if (c.framesRemaining <= 1) {
      const residual = { x: c.offset.x, y: c.offset.y };
      this.pendingCorrection = null;
      return residual;
    }
    const step = 1 / c.framesRemaining;
    c.offset = { x: c.offset.x * (1 - step), y: c.offset.y * (1 - step) };
    c.framesRemaining -= 1;
    return { x: c.offset.x, y: c.offset.y };
  }

  // --- Telemetry / accessors (for HUD + tests) ----------------------------

  /** Update the measured round-trip time; refreshes the warning flag. */
  setRtt(rttMs: number): void {
    this.rttMs = Math.max(0, rttMs);
    this.warning = this.rttMs > RTT_THRESHOLD_MS;
  }

  /** Current measured RTT in milliseconds. */
  getRtt(): number {
    return this.rttMs;
  }

  /** Current wall-clock time from the injected clock (ms). */
  now(): number {
    return this.clock.now();
  }

  /** Whether the high-latency warning indicator should be shown (Req 8.3). */
  isWarningActive(): boolean {
    return this.warning;
  }

  /** Number of remote weapon events discarded for exceeding the age limit (Req 8.4). */
  getStaleWeaponEventCount(): number {
    return this.staleWeaponEventCount;
  }

  /** Current active correction offset for the local car, or `{0,0}` if none. */
  getPendingCorrection(): { x: number; y: number } {
    return this.pendingCorrection ? { ...this.pendingCorrection.offset } : { x: 0, y: 0 };
  }

  // --- Internals ----------------------------------------------------------

  /**
   * Clamp a positional correction to the RTT-appropriate bound and start a
   * smooth-lerp over {@link CORRECTION_SMOOTH_FRAMES} frames. The clamp is the
   * invariant behind Property 20 (Req 8.2 / 8.3): the offset magnitude never
   * exceeds 2 m at low RTT nor 5 m at high RTT.
   */
  private applyBoundedCorrection(dx: number, dy: number, delta: number): void {
    const bound = this.rttMs > RTT_THRESHOLD_MS
      ? CORRECTION_BOUND_HIGH_RTT_M
      : CORRECTION_BOUND_LOW_RTT_M;

    const scale = delta > bound ? bound / delta : 1;
    this.pendingCorrection = {
      offset: { x: dx * scale, y: dy * scale },
      framesRemaining: CORRECTION_SMOOTH_FRAMES,
    };
  }

  /**
   * Re-simulate the local car forward from `startState` applying the buffered
   * inputs for predicted frames at indices `[fromIdx, end)`. Uses the shared
   * deterministic {@link stepPhysics} so it matches the authority.
   */
  private resimulateFrom(startState: CarPhysicsState, fromIdx: number): CarPhysicsState {
    const rng = mkRNG(this.sim.rngSeed);
    let car = startState;
    for (let i = fromIdx; i < this.predicted.length; i++) {
      const frame = this.predicted[i];
      if (!frame) continue;
      const inputs = new Map<ParticipantId, CarInputs>([[this.localId, frame.inputs]]);
      const world: PhysicsWorldState = {
        cars: [car],
        tick: frame.tick,
        trackId: this.sim.trackId,
        ...(this.sim.carStats ? { carStats: this.sim.carStats } : {}),
        ...(this.sim.trackSDF ? { trackSDF: this.sim.trackSDF } : {}),
      };
      const result = stepPhysics(world, inputs, FIXED_TIMESTEP, rng);
      car = result.cars[0] ?? car;
    }
    return car;
  }

  /**
   * Full state reset to authoritative snapshot values on checksum mismatch
   * (Req 8.5 / design.md "Desync"). Clears the prediction ring buffer and any
   * pending correction, and re-seeds the buffer with the authoritative local
   * state so subsequent prediction continues from a clean base.
   */
  private fullReset(snapshot: StateSnapshot): void {
    this.predicted.length = 0;
    this.pendingCorrection = null;

    const authoritative = snapshot.cars.find((c) => c.id === this.localId);
    if (authoritative) {
      this.predicted.push({
        tick: snapshot.tick,
        inputs: IDLE_INPUTS,
        state: this.decompressLocal(authoritative),
      });
    }
  }

  /**
   * Discard remote weapon-fire events whose timestamp is older than 200 ms
   * relative to the snapshot's server time, counting each as a miss without
   * mutating simulation state (Req 8.4). Weapon events are carried alongside a
   * snapshot rather than inside the state codec; callers attach them via
   * {@link StateSnapshotWithWeapons}. When none are present this is a no-op.
   */
  private discardStaleWeaponEvents(snapshot: StateSnapshot): void {
    const weaponEvents = (snapshot as StateSnapshotWithWeapons).weaponEvents;
    if (!weaponEvents || weaponEvents.length === 0) return;
    for (const ev of weaponEvents) {
      const age = snapshot.serverTime - ev.timestamp;
      if (age > WEAPON_EVENT_MAX_AGE_MS) {
        // Stale: record the miss, do not apply. No mutation of any car state.
        this.staleWeaponEventCount += 1;
      }
      // Fresh events would be applied by the weapon/render subsystem; that is
      // out of scope for the netcode core and intentionally left to callers.
    }
  }

  /** Keep only the most recent snapshots needed for interpolation + reconciliation. */
  private pruneSnapshotBuffer(): void {
    if (this.snapshots.size <= RING_BUFFER_SIZE) return;
    const ticks = [...this.snapshots.keys()].sort((a, b) => a - b);
    while (ticks.length > RING_BUFFER_SIZE) {
      const oldest = ticks.shift()!;
      this.snapshots.delete(oldest);
    }
  }

  /** Decompress an authoritative {@link CompressedCarState} into a full car state. */
  private decompressLocal(c: CompressedCarState): CarPhysicsState {
    const heading = (c.heading / 256) * TAU;
    const speed = c.speed; // codec stores speed at 0.01 resolution already decoded
    return {
      id: c.id,
      position: { x: c.x, y: c.y },
      velocity: { x: Math.sin(heading) * speed, y: Math.cos(heading) * speed },
      heading,
      speed,
      angularVelocity: 0,
      onTrack: (c.flags & 0x04) !== 0,
      airborne: (c.flags & 0x02) !== 0,
      airborneHeight: 0,
      airborneVY: 0,
    };
  }

  private snapshotToRenderState(snapshot: StateSnapshot, renderTime: number): RenderState {
    return {
      renderTime,
      warning: this.warning,
      cars: snapshot.cars.map((c) => this.renderCarFrom(c)),
    };
  }

  /** Linear interpolation between two snapshots for cars present in both. */
  private interpolatePair(
    a: StateSnapshot,
    b: StateSnapshot,
    t: number,
    renderTime: number,
  ): RenderState {
    const byIdB = new Map<ParticipantId, CompressedCarState>();
    for (const c of b.cars) byIdB.set(c.id, c);

    const cars: RenderCar[] = [];
    for (const ca of a.cars) {
      const cb = byIdB.get(ca.id);
      if (!cb) {
        cars.push(this.renderCarFrom(ca));
        continue;
      }
      cars.push(this.interpCar(ca, cb, t));
    }
    // Cars that appear only in the later snapshot: include them at b.
    for (const cb of b.cars) {
      if (!a.cars.some((ca) => ca.id === cb.id)) {
        cars.push(this.renderCarFrom(cb));
      }
    }

    return { renderTime, cars, warning: this.warning };
  }

  private interpCar(a: CompressedCarState, b: CompressedCarState, t: number): RenderCar {
    const headingA = (a.heading / 256) * TAU;
    const headingB = (b.heading / 256) * TAU;
    return {
      id: a.id,
      position: { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) },
      heading: lerpAngle(headingA, headingB, t),
      speed: lerp(a.speed, b.speed, t),
      armor: lerp(a.armor, b.armor, t),
      eliminated: (b.flags & 0x01) !== 0,
      airborne: (b.flags & 0x02) !== 0,
      onTrack: (b.flags & 0x04) !== 0,
      ammoForward: b.ammoForward,
      ammoRear: b.ammoRear,
    };
  }

  private renderCarFrom(c: CompressedCarState): RenderCar {
    return {
      id: c.id,
      position: { x: c.x, y: c.y },
      heading: (c.heading / 256) * TAU,
      speed: c.speed,
      armor: c.armor,
      eliminated: (c.flags & 0x01) !== 0,
      airborne: (c.flags & 0x02) !== 0,
      onTrack: (c.flags & 0x04) !== 0,
      ammoForward: c.ammoForward,
      ammoRear: c.ammoRear,
    };
  }
}

// ---------------------------------------------------------------------------
// Weapon-event carrier (events ride alongside a snapshot, not inside the codec)
// ---------------------------------------------------------------------------

/**
 * A remote weapon event as delivered to the client, carrying the emitting
 * server timestamp used for the 200 ms staleness check (Req 8.4).
 */
export interface TimestampedWeaponEvent {
  /** Server time (ms) at which the weapon event was emitted. */
  readonly timestamp: number;
  /** The underlying weapon event payload. */
  readonly event: WeaponEvent;
}

/**
 * Snapshot augmented with the out-of-band remote weapon events for this tick.
 * The {@link StateSnapshotCodec} deliberately does not encode events (see its
 * module doc), so the network layer attaches them to the decoded snapshot.
 */
export interface StateSnapshotWithWeapons extends StateSnapshot {
  readonly weaponEvents?: readonly TimestampedWeaponEvent[];
}

// ---------------------------------------------------------------------------
// Input encoding
// ---------------------------------------------------------------------------

/**
 * Encode an {@link InputFrame} to bytes for transmission. Input frames are tiny
 * and infrequent relative to snapshots, so a compact JSON payload is used
 * rather than a bespoke binary codec; this keeps the wire format debuggable and
 * avoids coupling to a codec that does not yet exist for inputs.
 */
export function encodeInputFrame(frame: InputFrame): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(frame));
}

/** Decode bytes produced by {@link encodeInputFrame} back into an {@link InputFrame}. */
export function decodeInputFrame(bytes: Uint8Array): InputFrame {
  return JSON.parse(new TextDecoder().decode(bytes)) as InputFrame;
}

// ---------------------------------------------------------------------------
// Small math helpers (pure)
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Shortest-arc angular interpolation in radians. */
function lerpAngle(a: number, b: number, t: number): number {
  let diff = ((b - a) % TAU + TAU) % TAU;
  if (diff > Math.PI) diff -= TAU;
  const result = a + diff * t;
  return ((result % TAU) + TAU) % TAU;
}

/** Neutral inputs used when re-seeding the ring buffer after a full reset. */
const IDLE_INPUTS: CarInputs = {
  throttle: 0,
  brake: 0,
  steer: 0,
  fireForward: false,
  fireRear: false,
};

// ---------------------------------------------------------------------------
// Browser adapter (the ONLY place that touches the global WebSocket)
// ---------------------------------------------------------------------------

/**
 * Wrap a browser {@link WebSocket} in the {@link Socket} interface. This is the
 * concrete transport used in production; it is intentionally excluded from the
 * unit-testable core. The core never references `WebSocket` or `window`.
 */
export function createWebSocketSocket(ws: WebSocket): Socket {
  ws.binaryType = 'arraybuffer';
  return {
    send(bytes: Uint8Array): void {
      ws.send(bytes);
    },
    onMessage(cb: (bytes: Uint8Array) => void): void {
      ws.addEventListener('message', (ev: MessageEvent) => {
        const data = ev.data;
        if (data instanceof ArrayBuffer) {
          cb(new Uint8Array(data));
        } else if (data instanceof Uint8Array) {
          cb(data);
        }
      });
    },
  };
}
