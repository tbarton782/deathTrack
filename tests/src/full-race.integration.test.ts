/**
 * Integration test: full 2-lap race simulation, server authority + 2 clients.
 *
 * This test stands up the real server-authoritative netcode and two real client
 * network managers entirely in-process, with NO real WebSocket and NO timers,
 * then drives a deterministic 2-lap race to completion and asserts the two cars
 * finish ranked (placements 1 and 2) with prize money computed by the shared
 * `CareerService.computePrizeMoney` formula (placement prize + elimination
 * bonus).
 *
 * ## What is exercised (all consumed from BUILT package output)
 *
 *  - `@deathtrack/server` (built `dist/`): `SessionManager`, `ServerNetworkManager`,
 *    and `AuthorityLoop`. The server abstracts its transport behind the
 *    `ClientConnection` interface and injects its clock (`now`); `AuthorityLoop`
 *    exposes a drivable `physicsTick()` plus `start()`/`stop()`.
 *  - `@deathtrack/client` (built `dist/network/NetworkManager.js`): the client
 *    `NetworkManager`, which abstracts its socket behind the `Socket` interface
 *    + an injected `Clock`, and exposes `sendInput` / `getInterpolatedState` /
 *    `reconcile`.
 *  - `@deathtrack/shared` (built `dist/`): `stepPhysics` (indirectly, via the
 *    authority loop and client prediction), the physics/domain types, and
 *    `CareerService.computePrizeMoney` for the prize assertion.
 *
 * ## In-process wiring (no sockets)
 *
 * Each client owns an in-memory `Socket` fake. The server owns one
 * `ClientConnection` per participant. They are cross-connected directly:
 *
 *   - server → client: `ClientConnection.send(bytes)` (the encoded 20 Hz
 *     `StateSnapshot`) is handed straight to that client's `Socket.onMessage`
 *     handler, so the client decodes + reconciles the authoritative snapshot;
 *   - client → server: `Socket.send(bytes)` (an encoded `InputFrame`) is decoded
 *     and delivered to `ServerNetworkManager.receiveInput(id, frame)`.
 *
 * No WebSocket, no HTTP server, no `ws` — packets pass by direct function call.
 * The simulation is advanced deterministically by calling
 * `AuthorityLoop.physicsTick()` in a loop (driving the injected clock forward
 * ourselves) rather than relying on real timers.
 *
 * ## Modelling "a 2-lap race to completion" faithfully but deterministically
 *
 * The built packages expose server-authoritative *physics* and the client
 * prediction/interpolation core, but they do not expose a race-orchestration
 * object that counts laps, detects finish-line crossings, or assigns final
 * placements (see the report accompanying this task). We therefore model the
 * race honestly on top of the authoritative simulation: both cars drive a
 * closed circular circuit (constant throttle + constant steer), and we count a
 * completed lap each time a car's authoritative heading wraps back through its
 * start reference. When a car completes its 2nd lap it is recorded as finished;
 * finish *order* determines final placement. Car 0 is given a faster stat
 * profile than car 1, so the finish order is deterministic (car 0 → 1st,
 * car 1 → 2nd) rather than a coin-flip on floating-point ties.
 *
 * The lap/finish bookkeeping reads only the *authoritative* car state owned by
 * the `AuthorityLoop` (`getCar`), so it reflects exactly what the server
 * simulated; the two clients are genuinely wired in and are asserted to have
 * received and interpolated the broadcast snapshots for both cars.
 *
 * Validates: Requirements 5.2, 8.1
 */

import { describe, expect, it } from 'vitest';
import {
  computePrizeMoney,
  FIXED_TIMESTEP,
  type CarInputs,
  type CarPhysicsState,
  type CarRaceState,
  type InputFrame,
  type ParticipantId,
  type PhysicsCarStats,
  type PrizeTable,
  type WaypointGraph,
} from '@deathtrack/shared';
import {
  AuthorityLoop,
  type AuthorityTrackContext,
  type ParticipantControl,
} from '@deathtrack/server/dist/AuthorityLoop.js';
import { ServerNetworkManager } from '@deathtrack/server/dist/network/ServerNetworkManager.js';
import { SessionManager } from '@deathtrack/server/dist/session/SessionManager.js';
import {
  NetworkManager,
  decodeInputFrame,
  type Clock,
  type Socket,
  type SimulationContext,
} from '@deathtrack/client/dist/network/NetworkManager.js';

// ---------------------------------------------------------------------------
// In-memory transport fakes
// ---------------------------------------------------------------------------

/**
 * An in-memory client `Socket`. Outbound packets (input frames) are forwarded to
 * an `onSend` callback the harness sets to `ServerNetworkManager.receiveInput`.
 * Inbound packets (snapshots) are delivered by the harness calling `deliver`,
 * which invokes the handler the `NetworkManager` registered via `onMessage`.
 */
class InMemoryClientSocket implements Socket {
  private handler: ((bytes: Uint8Array) => void) | null = null;
  /** Set by the harness: where outbound (client → server) bytes go. */
  onSend: ((bytes: Uint8Array) => void) | null = null;
  /** Count of snapshots delivered to this client (for assertions). */
  received = 0;

  send(bytes: Uint8Array): void {
    this.onSend?.(bytes);
  }

  onMessage(cb: (bytes: Uint8Array) => void): void {
    this.handler = cb;
  }

  /** Harness-side: deliver an inbound server → client packet to the manager. */
  deliver(bytes: Uint8Array): void {
    this.received += 1;
    this.handler?.(bytes);
  }
}

/** A manually-advanced clock so the whole test is deterministic (no timers). */
class ManualClock implements Clock {
  constructor(private t = 0) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}

// ---------------------------------------------------------------------------
// Race fixtures
// ---------------------------------------------------------------------------

/**
 * Stat profiles for the two cars driving the closed circular circuit.
 *
 * In this physics model the steering rate is proportional to `handling` and
 * *inversely* proportional to speed (`angularVelocity = (handling/100) / speed`,
 * per `stepPhysics`). Both cars share the same low top speed, so — after a brief
 * throttle warm-up — they coast at the same constant speed and their lap time is
 * governed purely by `handling`. Car 0 has the higher handling, so it turns
 * tighter, laps faster, and finishes its two laps first: this makes the finish
 * order (and therefore the final placements) deterministic rather than a
 * floating-point tie.
 *
 * The low `topSpeed` also keeps each car's circular path comfortably inside the
 * wire's uint16 fixed-point position range, so the broadcast snapshots the
 * clients receive stay well-formed.
 */
const FAST_STATS: PhysicsCarStats = {
  topSpeed: 3,
  acceleration: 45,
  brake: 40,
  handling: 100,
  armor: 200,
};
const SLOW_STATS: PhysicsCarStats = {
  topSpeed: 3,
  acceleration: 45,
  brake: 40,
  handling: 70,
  armor: 200,
};

/** A minimal 2-node waypoint graph (unused by human slots but required by ctx). */
const GRAPH: WaypointGraph = {
  nodes: [
    { id: 0, position: { x: 500, y: 600 }, width: 20 },
    { id: 1, position: { x: 500, y: 400 }, width: 20 },
  ],
  edges: [
    { from: 0, to: 1, distance: 200 },
    { from: 1, to: 0, distance: 200 },
  ],
};

function physics(id: ParticipantId, x: number, y: number): CarPhysicsState {
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
    physics: physics(id, x, y),
    currentArmor: 200,
    ammo: new Map(),
    eliminated: false,
    lap: 1,
    placement: 0,
    waypointIndex: 0,
  };
}

/** Constant driving input: full throttle, steady right-hand steer → a circle. */
const DRIVE: CarInputs = {
  throttle: 1,
  brake: 0,
  steer: 1,
  fireForward: false,
  fireRear: false,
};

function trackContext(
  statsById: ReadonlyMap<ParticipantId, PhysicsCarStats>,
): AuthorityTrackContext {
  return {
    trackId: 'bay_area',
    carStats: statsById,
    waypointGraph: GRAPH,
  };
}

const HUMAN: ParticipantControl = { isAI: false };

/**
 * The two-decimal-place prize schedule used for the assertion. `computePrizeMoney`
 * reads `placementPrizes[placement]` (1-based) and adds `eliminationCount ×
 * eliminationBonus`. Values are arbitrary but fixed so the expected number is
 * unambiguous.
 */
const PRIZE_TABLE: PrizeTable = {
  // index 0 unused (placement is 1-based); 1st = 5000, 2nd = 2500.
  placementPrizes: [0, 5000, 2500],
  eliminationBonus: 750,
};

// ---------------------------------------------------------------------------
// Lap / finish tracking (built on authoritative state)
// ---------------------------------------------------------------------------

/**
 * Tracks lap completions for one car by watching its authoritative heading wrap
 * through the start reference (0 rad). With a constant right-hand steer the
 * heading increases monotonically modulo 2π; each wrap from "just below 2π" back
 * to "just above 0" is one completed lap.
 */
class LapCounter {
  laps = 0;
  finishedAtTick: number | null = null;
  private prevHeading: number;

  constructor(startHeading: number) {
    this.prevHeading = startHeading;
  }

  /** Feed the current authoritative heading; returns true once 2 laps are done. */
  update(heading: number, tick: number, lapsToFinish: number): void {
    // A wrap is detected when the heading drops sharply (crossed 2π → 0).
    if (heading + Math.PI < this.prevHeading) {
      this.laps += 1;
      if (this.laps >= lapsToFinish && this.finishedAtTick === null) {
        this.finishedAtTick = tick;
      }
    }
    this.prevHeading = heading;
  }
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

describe('full 2-lap race simulation (server authority + 2 in-process clients)', () => {
  it('runs a 2-lap race to completion, ranks both cars 1 & 2, and prize money matches the formula', () => {
    const ids: ParticipantId[] = [0, 1];
    const statsById = new Map<ParticipantId, PhysicsCarStats>([
      [0, FAST_STATS],
      [1, SLOW_STATS],
    ]);

    // --- Server side ------------------------------------------------------
    const serverClock = new ManualClock(0);
    const sessions = new SessionManager({ now: () => serverClock.now(), generateId: () => 'race-1' });
    const serverNet = new ServerNetworkManager(sessions, 'race-1', { now: () => serverClock.now() });

    // Cars start apart so they never collide (which would perturb the circles).
    const initialCars: CarRaceState[] = [
      raceState(0, 500, 600),
      raceState(1, 1500, 600),
    ];
    const controls = new Map<ParticipantId, ParticipantControl>([
      [0, HUMAN],
      [1, HUMAN],
    ]);
    const loop = new AuthorityLoop(serverNet, trackContext(statsById), initialCars, controls, {
      seed: 7,
      now: () => serverClock.now(),
    });

    // --- Client side ------------------------------------------------------
    const clientClock = new ManualClock(0);
    const clients = new Map<ParticipantId, { mgr: NetworkManager; socket: InMemoryClientSocket }>();

    for (const id of ids) {
      const socket = new InMemoryClientSocket();
      const sim: SimulationContext = {
        trackId: 'bay_area',
        rngSeed: 7,
        carStats: statsById,
        maxArmor: new Map(ids.map((i) => [i, 200])),
      };
      const mgr = new NetworkManager({
        socket,
        clock: { now: () => clientClock.now() },
        localId: id,
        sim,
      });
      // client → server: decode the input frame and hand it to the server manager.
      socket.onSend = (bytes) => {
        const frame = decodeInputFrame(bytes);
        serverNet.receiveInput(id, frame);
      };
      clients.set(id, { mgr, socket });

      // server → client: register a ClientConnection whose send() feeds the
      // matching client's socket. This is the whole "no real WebSocket" bridge.
      serverNet.addConnection({
        participantId: id,
        send: (bytes: Uint8Array) => socket.deliver(bytes),
      });
    }

    // --- Drive the deterministic 2-lap race -------------------------------
    const LAPS_TO_FINISH = 2;
    const MS_PER_TICK = 1000 * FIXED_TIMESTEP; // 16.667 ms

    const counters = new Map<ParticipantId, LapCounter>(
      ids.map((id) => [id, new LapCounter(loop.getCar(id)!.physics.heading)]),
    );
    const finishOrder: ParticipantId[] = [];

    // A generous tick budget: the slower car's circle at ~42 u/s top speed still
    // closes a lap well within a few hundred ticks; 20000 ticks (~5.5 min of
    // sim time) is far more than enough and bounds the loop.
    const MAX_TICKS = 20000;

    for (let tick = 0; tick < MAX_TICKS; tick++) {
      // Each client predicts + sends its input for this tick BEFORE the server
      // steps, so the authority applies the latest buffered frame this tick.
      for (const id of ids) {
        const client = clients.get(id)!;
        const frame: InputFrame = { tick, inputs: DRIVE, checksum: 0 };
        // Record the local prediction (mirrors the real client game loop) then
        // send — exercising the client's public prediction + send path.
        const car = loop.getCar(id)!;
        client.mgr.recordPrediction(tick, DRIVE, car.physics);
        client.mgr.sendInput(frame);
      }

      // Advance the authoritative simulation one fixed step (broadcasts at 20 Hz).
      loop.physicsTick();

      // Advance both clocks by one physics tick so server time progresses.
      serverClock.advance(MS_PER_TICK);
      clientClock.advance(MS_PER_TICK);

      // Update lap bookkeeping from authoritative state and record finish order.
      for (const id of ids) {
        const counter = counters.get(id)!;
        const before = counter.finishedAtTick;
        counter.update(loop.getCar(id)!.physics.heading, tick, LAPS_TO_FINISH);
        if (before === null && counter.finishedAtTick !== null) {
          finishOrder.push(id);
        }
      }

      if (finishOrder.length === ids.length) break;
    }

    // --- The race completed for both cars ---------------------------------
    expect(finishOrder).toHaveLength(2);
    for (const id of ids) {
      expect(counters.get(id)!.laps).toBeGreaterThanOrEqual(LAPS_TO_FINISH);
      expect(counters.get(id)!.finishedAtTick).not.toBeNull();
    }

    // The faster car (0) crosses its 2nd lap first → 1st place; car 1 → 2nd.
    expect(finishOrder[0]).toBe(0);
    expect(finishOrder[1]).toBe(1);

    // --- Assign final placements from finish order (1-based, ranked) ------
    const placement = new Map<ParticipantId, number>();
    finishOrder.forEach((id, i) => placement.set(id, i + 1));
    expect(placement.get(0)).toBe(1);
    expect(placement.get(1)).toBe(2);
    // Placements are exactly {1, 2} — both cars finished ranked.
    expect([...placement.values()].sort((a, b) => a - b)).toEqual([1, 2]);

    // --- Prize money matches the shared formula for each placement --------
    // No weapons were fired, so nobody caused an elimination this race.
    const eliminations = 0;
    for (const id of ids) {
      const p = placement.get(id)!;
      const prize = computePrizeMoney(p, eliminations, PRIZE_TABLE);
      // Independently recompute the expected value from the formula:
      // placementPrize(p) + eliminationCount × eliminationBonus.
      const expected = PRIZE_TABLE.placementPrizes[p]! + eliminations * PRIZE_TABLE.eliminationBonus;
      expect(prize).toBe(expected);
    }
    // Concretely: 1st place = 5000, 2nd place = 2500 with zero eliminations.
    expect(computePrizeMoney(placement.get(0)!, eliminations, PRIZE_TABLE)).toBe(5000);
    expect(computePrizeMoney(placement.get(1)!, eliminations, PRIZE_TABLE)).toBe(2500);

    // --- Both clients were genuinely wired to server authority ------------
    // Every broadcast (20 Hz) reached both clients' sockets over the in-process
    // bridge, and each client can produce an interpolated render state carrying
    // both cars — proving the 2-client authority sync ran end to end.
    for (const id of ids) {
      const client = clients.get(id)!;
      expect(client.socket.received).toBeGreaterThan(0);
      const render = client.mgr.getInterpolatedState(clientClock.now());
      const renderedIds = render.cars.map((c) => c.id).sort((a, b) => a - b);
      expect(renderedIds).toEqual([0, 1]);
    }
  });
});
