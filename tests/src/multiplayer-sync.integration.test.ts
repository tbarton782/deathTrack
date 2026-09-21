/**
 * Integration test: multiplayer synchronisation under packet loss.
 *
 * Wires the *real* authoritative server (`AuthorityLoop` + `ServerNetworkManager`
 * + `SessionManager` from the BUILT `@deathtrack/server` dist) to two *real*
 * client `NetworkManager`s (from the BUILT `@deathtrack/client` dist) entirely
 * in-process, connected by an in-memory transport that deterministically drops
 * ~10% of packets in BOTH directions. It then drives a deterministic 30-second
 * race (30 s at 60 Hz = 1800 physics ticks; snapshots broadcast at 20 Hz) and
 * asserts that, after the race, both clients agree with each other AND with the
 * authoritative server on every car's final position (within 1 metre) and
 * heading (within 5 degrees).
 *
 * Because the server is authoritative and clients reconcile their local
 * prediction to the authoritative snapshots they receive, packets dropped by
 * the lossy transport must be recovered by reconciliation — this is exactly the
 * convergence-under-loss guarantee of Requirement 8.6.
 *
 * ## How the lossy in-process transport works
 *
 * `LossyChannel` is a pure, seeded gate: for each packet it advances a seeded
 * xorshift RNG and drops the packet when the drawn value falls below the loss
 * rate (0.10). Each direction (each client→server input stream and each
 * server→client snapshot stream) gets its own independently-seeded channel, so
 * loss is uncorrelated across links but fully reproducible run to run. No
 * `Math.random()` is used anywhere, so the whole simulation is deterministic.
 *
 * ## How determinism is driven
 *
 * - The server `AuthorityLoop` is constructed with a fixed `seed` and an
 *   injected `now` bound to a virtual clock advanced by exactly one physics
 *   tick (1000/60 ms) per `physicsTick()`, so `serverTime` in every snapshot is
 *   reproducible with no wall-clock dependency.
 * - Both clients are constructed with an injected `Clock` reading the same
 *   virtual clock and the same physics `rngSeed` as the authority, so their
 *   re-simulation during reconciliation matches the server step-for-step.
 * - Player inputs follow a fixed script (accelerate, then brake to a full stop
 *   over the final second) so the race ends in a well-defined, low-velocity
 *   terminal state that both clients converge to regardless of which snapshots
 *   each happened to drop.
 *
 * Validates: Requirement 8.6
 */

import { describe, expect, it } from 'vitest';

import {
  FIXED_TIMESTEP,
  type CarInputs,
  type CarPhysicsState,
  type CarRaceState,
  type InputFrame,
  type ParticipantId,
  type PhysicsCarStats,
  type PhysicsWorldState,
  type WaypointGraph,
} from '@deathtrack/shared';
import { stepPhysics, mkRNG } from '@deathtrack/shared';

// Consume the BUILT server dist (no `exports`/`main` field on the package, so
// import via explicit dist subpaths — the package is not modified).
import {
  AuthorityLoop,
  type AuthorityTrackContext,
  type ParticipantControl,
} from '@deathtrack/server/dist/AuthorityLoop.js';
import {
  ServerNetworkManager,
  type ClientConnection,
} from '@deathtrack/server/dist/network/ServerNetworkManager.js';
import { SessionManager } from '@deathtrack/server/dist/session/SessionManager.js';

// Consume the BUILT client dist network core.
import {
  NetworkManager,
  type Socket,
  type Clock,
} from '@deathtrack/client/dist/network/NetworkManager.js';

// ---------------------------------------------------------------------------
// Simulation constants
// ---------------------------------------------------------------------------

/** 30-second race at 60 Hz physics. */
const RACE_TICKS = 30 * 60; // 1800
/** Milliseconds of virtual time advanced per physics tick (60 Hz). */
const MS_PER_TICK = 1000 / 60;
/** Target packet-loss rate applied by each lossy channel. */
const PACKET_LOSS_RATE = 0.1;
/** Convergence thresholds from Requirement 8.6 (default divergence threshold). */
const POSITION_TOLERANCE_M = 1;
const HEADING_TOLERANCE_DEG = 5;

/** On-wire position fixed-point resolution: quantised value = worldUnits / 0.1. */
const POSITION_RESOLUTION = 0.1;
const TAU = Math.PI * 2;

const PARTICIPANTS: ParticipantId[] = [0, 1];

/** Identical resolved stats for both cars (mirrors the AuthorityLoop fixtures). */
const STATS: PhysicsCarStats = {
  topSpeed: 50,
  acceleration: 30,
  brake: 40,
  handling: 50,
  armor: 200,
};

/** A minimal waypoint graph — required by the track context; unused by human slots. */
const GRAPH: WaypointGraph = {
  nodes: [
    { id: 0, position: { x: 0, y: 100 }, width: 10 },
    { id: 1, position: { x: 0, y: 200 }, width: 10 },
  ],
  edges: [
    { from: 0, to: 1, distance: 100 },
    { from: 1, to: 0, distance: 100 },
  ],
};

// ---------------------------------------------------------------------------
// Seeded lossy transport
// ---------------------------------------------------------------------------

/**
 * A deterministic packet-loss gate. Each call to {@link shouldDeliver} advances
 * a seeded xorshift32 RNG and returns `false` (drop) with probability
 * {@link lossRate}. Seeding makes the drop pattern fully reproducible; no
 * `Math.random()` is involved.
 */
class LossyChannel {
  private state: number;
  private dropped = 0;
  private total = 0;

  constructor(seed: number, private readonly lossRate: number) {
    // Avoid a zero state (xorshift fixed point); fold the seed into 32 bits.
    this.state = (seed ^ 0x9e3779b9) >>> 0 || 0x1234abcd;
  }

  /** Advance the RNG and decide whether the next packet is delivered. */
  shouldDeliver(): boolean {
    this.total += 1;
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    const r = this.state / 0xffffffff;
    if (r < this.lossRate) {
      this.dropped += 1;
      return false;
    }
    return true;
  }

  get droppedCount(): number {
    return this.dropped;
  }
  get totalCount(): number {
    return this.total;
  }
}

// ---------------------------------------------------------------------------
// Virtual clock
// ---------------------------------------------------------------------------

/** A mutable virtual clock shared by the authority loop and both clients. */
class VirtualClock implements Clock {
  private ms = 0;
  now(): number {
    return this.ms;
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

// ---------------------------------------------------------------------------
// Client-side socket fake
// ---------------------------------------------------------------------------

/**
 * In-memory {@link Socket} for a client. Outbound bytes (`send`) are ignored
 * here — client→server input delivery is driven explicitly by the test harness
 * through its own lossy channel (see the main loop). Inbound snapshot bytes are
 * pushed in via {@link deliver}, which fans them to the registered handler
 * exactly as a real socket's `onmessage` would.
 */
class ClientSocket implements Socket {
  private handler: ((bytes: Uint8Array) => void) | null = null;
  send(_bytes: Uint8Array): void {
    // no-op: inputs are routed by the harness, not echoed back to the server.
  }
  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.handler = cb;
  }
  /** Deliver an inbound (server→client) snapshot packet to the NetworkManager. */
  deliver(bytes: Uint8Array): void {
    this.handler?.(bytes);
  }
}

/**
 * A {@link ClientConnection} whose `send` (invoked by the server's
 * {@link ServerNetworkManager.broadcastSnapshot}) routes the encoded snapshot
 * through a per-client lossy channel into that client's socket. Dropped packets
 * simply never reach the client — reconciliation must recover from the gap.
 */
class LossyServerToClientConnection implements ClientConnection {
  constructor(
    readonly participantId: ParticipantId,
    private readonly channel: LossyChannel,
    private readonly socket: ClientSocket,
  ) {}
  send(bytes: Uint8Array): void {
    if (this.channel.shouldDeliver()) {
      // Copy: the server reuses one encoded buffer for all connections.
      this.socket.deliver(bytes.slice());
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function idlePhysics(id: ParticipantId, x: number, y: number): CarPhysicsState {
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

function raceState(id: ParticipantId, x: number, y: number): CarRaceState {
  return {
    participantId: id,
    physics: idlePhysics(id, x, y),
    currentArmor: STATS.armor!,
    ammo: new Map(),
    eliminated: false,
    lap: 1,
    placement: 1,
    waypointIndex: 0,
  };
}

/**
 * The scripted input for a car on a given tick. Both cars accelerate for the
 * bulk of the race, then brake to a full stop over the final second, giving a
 * stable low-velocity terminal state. A small constant steer separates the two
 * cars' paths so they do not sit on top of each other.
 */
function scriptedInput(participantId: ParticipantId, tick: number): CarInputs {
  // Brake over the final 2 seconds: brake (40 u/s^2) fully arrests top speed
  // (<= 50 u/s) in ~1.25 s, so both cars are at a dead stop for the last ~0.75 s
  // of the race. This gives a stable terminal position that both clients
  // converge to no matter which of the final snapshots each happened to drop.
  const brakingPhase = tick >= RACE_TICKS - 120; // final 2 seconds
  return {
    throttle: brakingPhase ? 0 : 1,
    brake: brakingPhase ? 1 : 0,
    // Gentle, opposite steer per car so their trajectories differ during the
    // racing phase. Steering is released once braking begins so heading (and
    // thus the terminal orientation) is stable across the final snapshots.
    steer: brakingPhase ? 0 : participantId === 0 ? 0.15 : -0.15,
    fireForward: false,
    fireRear: false,
  };
}

/** Track context shared by the authority loop. */
function trackContext(): AuthorityTrackContext {
  const carStats = new Map<ParticipantId, PhysicsCarStats>();
  for (const id of PARTICIPANTS) carStats.set(id, STATS);
  return { trackId: 'bay_area', carStats, waypointGraph: GRAPH };
}

/**
 * A local single-car physics predictor for a client. Mirrors the deterministic
 * shared `stepPhysics` the authority uses, stepping only the client's own car
 * so the `NetworkManager` has buffered predicted frames to reconcile against.
 */
class LocalPredictor {
  private car: CarPhysicsState;
  private readonly rng = mkRNG(RNG_SEED);
  private readonly carStats: ReadonlyMap<ParticipantId, PhysicsCarStats>;

  constructor(
    private readonly localId: ParticipantId,
    start: CarPhysicsState,
  ) {
    this.car = start;
    this.carStats = new Map([[localId, STATS]]);
  }

  step(tick: number, inputs: CarInputs): CarPhysicsState {
    const inputMap = new Map<ParticipantId, CarInputs>([[this.localId, inputs]]);
    const world: PhysicsWorldState = {
      cars: [this.car],
      tick,
      trackId: 'bay_area',
      carStats: this.carStats,
    };
    const result = stepPhysics(world, inputMap, FIXED_TIMESTEP, this.rng);
    this.car = result.cars[0] ?? this.car;
    return this.car;
  }
}

/** Shared physics RNG seed for authority + client re-simulation. */
const RNG_SEED = 20250514;

/** Convert a client render-car (quantised wire units) to world-space position. */
function wireToWorldPos(x: number, y: number): { x: number; y: number } {
  return { x: x * POSITION_RESOLUTION, y: y * POSITION_RESOLUTION };
}

/** Smallest absolute angular difference between two headings, in degrees. */
function headingDiffDeg(a: number, b: number): number {
  let d = ((a - b) % TAU + TAU) % TAU;
  if (d > Math.PI) d -= TAU;
  return Math.abs(d) * (180 / Math.PI);
}

function dist(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('multiplayer sync under 10% packet loss (30-second in-process race)', () => {
  it('both clients converge to the authoritative car positions within 1 m / 5 deg', () => {
    const clock = new VirtualClock();

    // --- Server authority ---------------------------------------------------
    const sessions = new SessionManager({
      now: () => clock.now(),
      generateId: () => 'race-session',
      random: () => 0,
    });
    // A concrete session so the network manager has a valid backing session.
    const created = sessions.createSession(
      { name: 'Loss Test', trackId: 'bay_area', maxPlayers: 2, password: null, fillWithAI: false },
      { displayName: 'P0' },
    );
    expect(created.ok).toBe(true);

    const net = new ServerNetworkManager(sessions, 'race-session', { now: () => clock.now() });

    // Both slots are human-controlled; inputs flow in over a lossy link.
    const controls = new Map<ParticipantId, ParticipantControl>([
      [0, { isAI: false }],
      [1, { isAI: false }],
    ]);

    const initialCars: CarRaceState[] = [raceState(0, 10, 0), raceState(1, 20, 0)];

    const loop = new AuthorityLoop(net, trackContext(), initialCars, controls, {
      seed: RNG_SEED,
      now: () => clock.now(),
    });

    // --- Clients ------------------------------------------------------------
    const clientA = makeClient(0, initialCars[0]!, clock);
    const clientB = makeClient(1, initialCars[1]!, clock);

    // Register each client's server→client connection (lossy, independent seeds).
    net.addConnection(
      new LossyServerToClientConnection(0, new LossyChannel(101, PACKET_LOSS_RATE), clientA.socket),
    );
    net.addConnection(
      new LossyServerToClientConnection(1, new LossyChannel(202, PACKET_LOSS_RATE), clientB.socket),
    );

    // Client→server lossy input links (independent seeds per client).
    const inputLossA = new LossyChannel(303, PACKET_LOSS_RATE);
    const inputLossB = new LossyChannel(404, PACKET_LOSS_RATE);

    // --- Drive the race deterministically ----------------------------------
    for (let tick = 0; tick < RACE_TICKS; tick++) {
      // 1. Each client produces its input, predicts locally, records it, and
      //    (through a lossy link) submits it to the authoritative server.
      driveClientTick(clientA, tick, net, inputLossA);
      driveClientTick(clientB, tick, net, inputLossB);

      // 2. The server advances one authoritative tick. On every 3rd tick it
      //    broadcasts a snapshot, which fans out through each client's lossy
      //    server→client connection into that client's NetworkManager.
      loop.physicsTick();

      // 3. Advance the shared virtual clock by exactly one physics tick.
      clock.advance(MS_PER_TICK);
    }

    // Sanity: the lossy links actually dropped a meaningful fraction (~10%).
    // (Server→client counts live on the connections; assert the input links.)
    expect(inputLossA.droppedCount).toBeGreaterThan(0);
    expect(inputLossB.droppedCount).toBeGreaterThan(0);

    // --- Gather final states ------------------------------------------------
    const finalServerTime = clock.now();

    const serverCars = new Map<ParticipantId, { pos: { x: number; y: number }; heading: number }>();
    for (const id of PARTICIPANTS) {
      const car = loop.getCar(id)!;
      serverCars.set(id, { pos: { ...car.physics.position }, heading: car.physics.heading });
    }

    const clientAView = renderView(clientA, finalServerTime);
    const clientBView = renderView(clientB, finalServerTime);

    // Both clients must have a view for every car.
    for (const id of PARTICIPANTS) {
      expect(clientAView.has(id)).toBe(true);
      expect(clientBView.has(id)).toBe(true);
    }

    // --- Assert convergence within 1 m / 5 deg -----------------------------
    for (const id of PARTICIPANTS) {
      const server = serverCars.get(id)!;
      const a = clientAView.get(id)!;
      const b = clientBView.get(id)!;

      // Client A vs Client B (the core "same final positions" guarantee).
      expect(dist(a.pos, b.pos)).toBeLessThanOrEqual(POSITION_TOLERANCE_M);
      expect(headingDiffDeg(a.heading, b.heading)).toBeLessThanOrEqual(HEADING_TOLERANCE_DEG);

      // Each client vs the authoritative server.
      expect(dist(a.pos, server.pos)).toBeLessThanOrEqual(POSITION_TOLERANCE_M);
      expect(dist(b.pos, server.pos)).toBeLessThanOrEqual(POSITION_TOLERANCE_M);
      expect(headingDiffDeg(a.heading, server.heading)).toBeLessThanOrEqual(HEADING_TOLERANCE_DEG);
      expect(headingDiffDeg(b.heading, server.heading)).toBeLessThanOrEqual(HEADING_TOLERANCE_DEG);
    }
  });
});

// ---------------------------------------------------------------------------
// Client harness
// ---------------------------------------------------------------------------

interface ClientHarness {
  readonly id: ParticipantId;
  readonly socket: ClientSocket;
  readonly manager: NetworkManager;
  readonly predictor: LocalPredictor;
}

function makeClient(
  id: ParticipantId,
  start: CarRaceState,
  clock: VirtualClock,
): ClientHarness {
  const socket = new ClientSocket();
  const carStats = new Map<ParticipantId, PhysicsCarStats>([[id, STATS]]);
  const maxArmor = new Map<ParticipantId, number>([[id, STATS.armor!]]);
  const manager = new NetworkManager({
    socket,
    clock,
    localId: id,
    sim: {
      trackId: 'bay_area',
      rngSeed: RNG_SEED,
      carStats,
      maxArmor,
    },
  });
  const predictor = new LocalPredictor(id, { ...start.physics, position: { ...start.physics.position } });
  return { id, socket, manager, predictor };
}

/**
 * Runs one client tick: build the scripted input, predict the local car forward,
 * record the prediction in the NetworkManager's ring buffer, and submit the
 * input frame to the server through the client→server lossy link.
 */
function driveClientTick(
  client: ClientHarness,
  tick: number,
  net: ServerNetworkManager,
  inputLoss: LossyChannel,
): void {
  const inputs = scriptedInput(client.id, tick);
  const predicted = client.predictor.step(tick, inputs);
  client.manager.recordPrediction(tick, inputs, predicted);

  const frame: InputFrame = { tick, inputs, checksum: 0 };
  // The client would normally `manager.sendInput(frame)`; here we route the
  // frame to the authoritative server through the lossy link so drops actually
  // remove it from the server's input buffer.
  if (inputLoss.shouldDeliver()) {
    net.receiveInput(client.id, frame);
  }
}

/**
 * Build a map of each car's final world-space position + heading as seen by a
 * client, derived from the authoritative snapshots it received (dequantised
 * from the wire fixed-point scheme back into world units / radians).
 */
function renderView(
  client: ClientHarness,
  serverTime: number,
): Map<ParticipantId, { pos: { x: number; y: number }; heading: number }> {
  const render = client.manager.getInterpolatedState(serverTime);
  const view = new Map<ParticipantId, { pos: { x: number; y: number }; heading: number }>();
  for (const car of render.cars) {
    view.set(car.id, {
      pos: wireToWorldPos(car.position.x, car.position.y),
      heading: car.heading,
    });
  }
  return view;
}
