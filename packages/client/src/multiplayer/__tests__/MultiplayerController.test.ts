/**
 * Unit + property tests for the headless {@link MultiplayerController} (task 22.1).
 *
 * These exercise the host and join flows entirely offline: an in-memory
 * {@link FakeMatchmakingClient} stands in for the REST transport, an injected
 * clock makes the 2 second sync budget deterministic, and an injectable
 * state-sync hook models NetworkManager-backed synchronisation. No real server,
 * no PixiJS, no DOM.
 *
 * Coverage:
 * - host creates a session and can start only when all ready + minimum count
 *   (Requirements 7.1, 7.4);
 * - join browses, supplies a password for a protected session, completes state
 *   sync within the 2 s budget, then enters the lobby (Requirements 7.2, 7.3,
 *   7.5);
 * - join to a full session is refused (Requirement 7.2);
 * - a sync that overruns the 2 s budget is rejected (Requirement 7.5).
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type {
  Session,
  SessionConfig,
  SessionSummary,
  SessionId,
  JoinResult,
  ParticipantInfo,
  ParticipantId,
  StateSnapshot,
  Loadout,
} from '@deathtrack/shared';
import {
  MultiplayerController,
  MultiplayerFlowError,
  StateSyncTimeoutError,
  STATE_SYNC_BUDGET_MS,
  DISCONNECT_NOTIFY_BUDGET_MS,
  isSessionFull,
  createFetchMatchmakingClient,
  type MatchmakingClient,
  type CreateSessionRequestBody,
  type Clock,
  type FetchLike,
  type MultiplayerNotification,
  type PauseBannerState,
} from '../MultiplayerController.js';
import type {
  ListSessionsResponse,
  JoinRequestBody,
} from '../../ui/SessionBrowser.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LOADOUT: Loadout = {
  chassisId: 'hellcat',
  components: {
    engine: null,
    brakes: null,
    transmission: null,
    tires: null,
    airfoil: null,
    armor: null,
  },
  weapons: {
    forward: null,
    rear: null,
    side_spike: null,
    ram: null,
  },
};

function participant(
  id: ParticipantId,
  ready: boolean,
  overrides: Partial<ParticipantInfo> = {},
): ParticipantInfo {
  return {
    id,
    displayName: `player-${id}`,
    loadout: LOADOUT,
    ready,
    isAI: false,
    joinedAt: 1000 + id,
    ...overrides,
  };
}

function makeSession(
  id: SessionId,
  participants: ParticipantInfo[],
  overrides: Partial<Session> = {},
): Session {
  const config: SessionConfig = {
    name: 'Test Session',
    trackId: 'chicago',
    maxPlayers: 8,
    password: null,
    fillWithAI: false,
  };
  return {
    id,
    config,
    hostParticipantId: participants[0]?.id ?? 0,
    participants: new Map(participants.map((p) => [p.id, p])),
    state: 'lobby',
    createdAt: 1000,
    ...overrides,
  };
}

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    name: 'Test Session',
    trackId: 'chicago',
    currentPlayers: 2,
    maxPlayers: 8,
    hasPassword: false,
    state: 'lobby',
    ...overrides,
  };
}

/** A clock that returns caller-scripted values in sequence, holding the last. */
function scriptedClock(times: number[]): Clock {
  let i = 0;
  return {
    now(): number {
      const t = times[Math.min(i, times.length - 1)] ?? 0;
      i += 1;
      return t;
    },
  };
}

// ---------------------------------------------------------------------------
// In-memory matchmaking client
// ---------------------------------------------------------------------------

interface FakeClientOptions {
  readonly listResponse?: readonly SessionSummary[];
  readonly createResponse?: Session;
  readonly joinResponse?: JoinResult;
  /** Force joinSession to throw (e.g. server 4xx). */
  readonly joinThrows?: boolean;
}

class FakeMatchmakingClient implements MatchmakingClient {
  readonly createCalls: CreateSessionRequestBody[] = [];
  readonly joinCalls: Array<{ id: SessionId; body: JoinRequestBody }> = [];
  readonly closeCalls: SessionId[] = [];
  listCalls = 0;

  constructor(private readonly opts: FakeClientOptions = {}) {}

  async listSessions(): Promise<ListSessionsResponse> {
    this.listCalls += 1;
    return { sessions: this.opts.listResponse ?? [] };
  }

  async joinSession(sessionId: SessionId, body: JoinRequestBody): Promise<unknown> {
    this.joinCalls.push({ id: sessionId, body });
    if (this.opts.joinThrows) {
      throw new Error('server rejected join');
    }
    return this.opts.joinResponse ?? { success: false, error: 'not_found' };
  }

  async createSession(body: CreateSessionRequestBody): Promise<Session> {
    this.createCalls.push(body);
    if (!this.opts.createResponse) throw new Error('no create response configured');
    return this.opts.createResponse;
  }

  async closeSession(sessionId: SessionId): Promise<void> {
    this.closeCalls.push(sessionId);
  }
}

const NOOP_CLOCK: Clock = { now: () => 0 };

// ---------------------------------------------------------------------------
// isSessionFull
// ---------------------------------------------------------------------------

describe('isSessionFull (Requirement 7.2)', () => {
  it('is true when current reaches max', () => {
    expect(isSessionFull(summary({ currentPlayers: 8, maxPlayers: 8 }))).toBe(true);
    expect(isSessionFull(summary({ currentPlayers: 9, maxPlayers: 8 }))).toBe(true);
  });

  it('is false when there is room', () => {
    expect(isSessionFull(summary({ currentPlayers: 3, maxPlayers: 8 }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Host path (Requirements 7.1, 7.4)
// ---------------------------------------------------------------------------

describe('MultiplayerController host path', () => {
  it('creates a session via REST and enters the lobby as host (Req 7.1)', async () => {
    const created = makeSession('host-sess', [participant(0, false)], {
      hostParticipantId: 0,
    });
    const client = new FakeMatchmakingClient({ createResponse: created });
    const controller = new MultiplayerController({ client, clock: NOOP_CLOCK });

    const config: SessionConfig = {
      name: 'My Race',
      trackId: 'boston',
      maxPlayers: 4,
      password: null,
      fillWithAI: false,
    };
    const session = await controller.hostSession(config, 'HostName');

    expect(session.id).toBe('host-sess');
    expect(controller.getPhase()).toBe('lobby');
    expect(controller.isHost()).toBe(true);
    expect(controller.getLocalParticipantId()).toBe(0);
    // The create call forwards config + host display name.
    expect(client.createCalls).toHaveLength(1);
    expect(client.createCalls[0]).toMatchObject({ name: 'My Race', displayName: 'HostName' });
  });

  it('cannot start the race until all participants are ready (Req 7.4)', async () => {
    const created = makeSession('s', [participant(0, true), participant(1, false)], {
      hostParticipantId: 0,
    });
    const client = new FakeMatchmakingClient({ createResponse: created });
    const controller = new MultiplayerController({ client, clock: NOOP_CLOCK });
    await controller.hostSession(created.config, 'Host');

    expect(controller.canStartRace()).toBe(false);
    expect(() => controller.startRace()).toThrow(MultiplayerFlowError);
    expect(controller.getPhase()).toBe('lobby');

    // Once everyone is ready, the host may start.
    controller.updateSession(
      makeSession('s', [participant(0, true), participant(1, true)], { hostParticipantId: 0 }),
    );
    expect(controller.canStartRace()).toBe(true);
    controller.startRace();
    expect(controller.getPhase()).toBe('racing');
  });

  it('cannot start below the minimum player count even when all are ready (Req 7.4)', async () => {
    const created = makeSession('s', [participant(0, true)], { hostParticipantId: 0 });
    const client = new FakeMatchmakingClient({ createResponse: created });
    const controller = new MultiplayerController({ client, clock: NOOP_CLOCK, minPlayers: 2 });
    await controller.hostSession(created.config, 'Host');

    // Single ready participant is below the minimum of 2.
    expect(controller.canStartRace()).toBe(false);
    expect(() => controller.startRace()).toThrow(MultiplayerFlowError);
  });

  it('a non-host cannot start the race (Req 7.4)', async () => {
    // Join a session where the local player is participant 1, host is 0.
    const joined = makeSession('s', [participant(0, true), participant(1, true)], {
      hostParticipantId: 0,
    });
    const client = new FakeMatchmakingClient({
      joinResponse: { success: true, participantId: 1, session: joined },
    });
    const controller = new MultiplayerController({ client, clock: NOOP_CLOCK });
    await controller.joinSession(summary({ id: 's' }), 'Guest');

    expect(controller.isHost()).toBe(false);
    expect(controller.canStartRace()).toBe(false);
    expect(() => controller.startRace()).toThrow(MultiplayerFlowError);
  });

  it('closing a hosted session issues DELETE and resets to idle', async () => {
    const created = makeSession('host-sess', [participant(0, false)], { hostParticipantId: 0 });
    const client = new FakeMatchmakingClient({ createResponse: created });
    const controller = new MultiplayerController({ client, clock: NOOP_CLOCK });
    await controller.hostSession(created.config, 'Host');

    await controller.leaveSession();
    expect(client.closeCalls).toEqual(['host-sess']);
    expect(controller.getPhase()).toBe('idle');
    expect(controller.getSession()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Join path (Requirements 7.2, 7.3, 7.5)
// ---------------------------------------------------------------------------

describe('MultiplayerController join path', () => {
  it('browses open sessions via GET /sessions (Req 7.2)', async () => {
    const sessions = [summary({ id: 'a' }), summary({ id: 'b', currentPlayers: 8, maxPlayers: 8 })];
    const client = new FakeMatchmakingClient({ listResponse: sessions });
    const controller = new MultiplayerController({ client, clock: NOOP_CLOCK });

    const listed = await controller.browseSessions();
    expect(client.listCalls).toBe(1);
    expect(listed.map((s) => s.id)).toEqual(['a', 'b']);
  });

  it('supplies the password for a protected session and syncs within budget then enters lobby (Req 7.3, 7.5)', async () => {
    const joined = makeSession('locked', [participant(0, false), participant(1, false)], {
      hostParticipantId: 0,
      config: {
        name: 'Locked',
        trackId: 'chicago',
        maxPlayers: 8,
        password: 'secret',
        fillWithAI: false,
      },
    });
    const client = new FakeMatchmakingClient({
      joinResponse: { success: true, participantId: 1, session: joined },
    });

    // Sync advances the clock by 1500 ms — within the 2 s budget.
    const clock = scriptedClock([0, 1500]);
    const snapshot = { tick: 0 } as unknown as StateSnapshot;
    const controller = new MultiplayerController({
      client,
      clock,
      stateSync: async () => snapshot,
    });

    const protectedSummary = summary({ id: 'locked', hasPassword: true });
    const session = await controller.joinSession(protectedSummary, 'Guest', 'secret');

    // Password was forwarded on the join call.
    expect(client.joinCalls).toHaveLength(1);
    expect(client.joinCalls[0]!.body).toEqual({ displayName: 'Guest', password: 'secret' });
    expect(session.id).toBe('locked');
    expect(controller.getPhase()).toBe('lobby');
    expect(controller.getLocalParticipantId()).toBe(1);
    expect(controller.isHost()).toBe(false);
  });

  it('omits the password for an open session (Req 7.3)', async () => {
    const joined = makeSession('open', [participant(0, false), participant(1, false)]);
    const client = new FakeMatchmakingClient({
      joinResponse: { success: true, participantId: 1, session: joined },
    });
    const controller = new MultiplayerController({ client, clock: NOOP_CLOCK });

    await controller.joinSession(summary({ id: 'open', hasPassword: false }), 'Guest');
    expect(client.joinCalls[0]!.body).toEqual({ displayName: 'Guest' });
  });

  it('refuses to join a full session without a network call (Req 7.2)', async () => {
    const client = new FakeMatchmakingClient({});
    const controller = new MultiplayerController({ client, clock: NOOP_CLOCK });

    const full = summary({ id: 'full', currentPlayers: 8, maxPlayers: 8 });
    await expect(controller.joinSession(full, 'Guest')).rejects.toBeInstanceOf(
      MultiplayerFlowError,
    );
    expect(client.joinCalls).toHaveLength(0);
    expect(controller.getPhase()).toBe('error');
  });

  it('surfaces a server-side join rejection (wrong password) as a flow error (Req 7.3)', async () => {
    const client = new FakeMatchmakingClient({
      joinResponse: { success: false, error: 'wrong_password' },
    });
    const controller = new MultiplayerController({ client, clock: NOOP_CLOCK });

    await expect(
      controller.joinSession(summary({ hasPassword: true }), 'Guest', 'nope'),
    ).rejects.toBeInstanceOf(MultiplayerFlowError);
    expect(controller.getPhase()).toBe('error');
  });

  it('rejects a state sync that overruns the 2 s budget (Req 7.5)', async () => {
    const joined = makeSession('slow', [participant(0, false), participant(1, false)]);
    const client = new FakeMatchmakingClient({
      joinResponse: { success: true, participantId: 1, session: joined },
    });
    // Sync takes 2500 ms — over the budget.
    const clock = scriptedClock([0, STATE_SYNC_BUDGET_MS + 500]);
    const controller = new MultiplayerController({
      client,
      clock,
      stateSync: async () => ({ tick: 0 } as unknown as StateSnapshot),
    });

    await expect(controller.joinSession(summary({ id: 'slow' }), 'Guest')).rejects.toBeInstanceOf(
      StateSyncTimeoutError,
    );
    expect(controller.getPhase()).toBe('error');
  });
});

// ---------------------------------------------------------------------------
// Property: sync completing within the budget always reaches the lobby (Req 7.5)
// ---------------------------------------------------------------------------

describe('MultiplayerController sync-budget property (Req 7.5)', () => {
  it('enters the lobby iff sync completes within the 2 s budget', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 4000 }), async (elapsed) => {
        const joined = makeSession('p', [participant(0, false), participant(1, false)]);
        const client = new FakeMatchmakingClient({
          joinResponse: { success: true, participantId: 1, session: joined },
        });
        const clock = scriptedClock([0, elapsed]);
        const controller = new MultiplayerController({
          client,
          clock,
          stateSync: async () => ({ tick: 0 } as unknown as StateSnapshot),
        });

        if (elapsed <= STATE_SYNC_BUDGET_MS) {
          await controller.joinSession(summary({ id: 'p' }), 'Guest');
          expect(controller.getPhase()).toBe('lobby');
        } else {
          await expect(
            controller.joinSession(summary({ id: 'p' }), 'Guest'),
          ).rejects.toBeInstanceOf(StateSyncTimeoutError);
          expect(controller.getPhase()).toBe('error');
        }
      }),
      { numRuns: 50 },
    );
  });
});

// ---------------------------------------------------------------------------
// fetch-backed client wiring
// ---------------------------------------------------------------------------

describe('createFetchMatchmakingClient', () => {
  it('maps the four endpoints onto fetch calls', async () => {
    const calls: Array<{ url: string; method: string; body: string | undefined }> = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
      if (url.endsWith('/sessions') && init?.method === 'GET') {
        return { ok: true, status: 200, json: async () => ({ sessions: [] }) };
      }
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    };
    const client = createFetchMatchmakingClient(fetchImpl, 'http://localhost:8080/');

    await client.listSessions();
    await client.createSession({
      name: 'N',
      trackId: 'chicago',
      maxPlayers: 4,
      password: null,
      fillWithAI: false,
      displayName: 'Host',
    });
    await client.joinSession('abc', { displayName: 'Guest' });
    await client.closeSession('abc');

    expect(calls[0]).toMatchObject({ url: 'http://localhost:8080/sessions', method: 'GET' });
    expect(calls[1]).toMatchObject({ url: 'http://localhost:8080/sessions', method: 'POST' });
    expect(calls[2]).toMatchObject({ url: 'http://localhost:8080/sessions/abc/join', method: 'POST' });
    expect(calls[3]).toMatchObject({ url: 'http://localhost:8080/sessions/abc', method: 'DELETE' });
  });

  it('throws on a non-ok response', async () => {
    const fetchImpl: FetchLike = async () => ({ ok: false, status: 403, json: async () => ({}) });
    const client = createFetchMatchmakingClient(fetchImpl);
    await expect(client.listSessions()).rejects.toThrow(/403/);
  });
});

// ---------------------------------------------------------------------------
// Network event handling — disconnection, host transfer, pause (task 22.2)
// Requirements 7.6, 7.8, 11.5
// ---------------------------------------------------------------------------

/** A clock that advances by a fixed step on each read, starting from `start`. */
function steppingClock(start = 0, step = 10): Clock {
  let t = start;
  return {
    now(): number {
      const cur = t;
      t += step;
      return cur;
    },
  };
}

/**
 * Builds a controller already sitting in a lobby/racing session hosted by
 * participant 0, with the local player at `localId`, plus captured notification
 * and pause-banner sinks.
 */
async function seatedController(
  localId: ParticipantId,
  participants: ParticipantInfo[] = [participant(0, true), participant(1, true)],
) {
  const notifications: MultiplayerNotification[] = [];
  const banners: Array<PauseBannerState | null> = [];
  const joined = makeSession('evt', participants, { hostParticipantId: 0 });
  const client = new FakeMatchmakingClient({
    createResponse: joined,
    joinResponse: { success: true, participantId: localId, session: joined },
  });
  const clock = steppingClock(0, 5);
  const controller = new MultiplayerController({
    client,
    clock,
    onNotification: (n) => notifications.push(n),
    onPauseBanner: (b) => banners.push(b),
  });
  if (localId === 0) {
    // Host path so isHost() is true when localId is the host slot.
    await controller.hostSession(joined.config, 'Host');
    controller.updateSession(joined);
  } else {
    await controller.joinSession(summary({ id: 'evt' }), 'Guest');
  }
  return { controller, notifications, banners, clock };
}

describe('MultiplayerController participant-left handling (Req 7.6)', () => {
  it('removes the participant and notifies within the 3 s budget', async () => {
    // Dedicated clock: the disconnection is detected at t=5000; the controller
    // stamps the notification with the same clock, so we can assert the notify
    // latency against the 3 s budget deterministically.
    const eventAt = 5000;
    const clock = scriptedClock([eventAt]);
    const joined = makeSession(
      'evt',
      [participant(0, true), participant(1, true), participant(2, true)],
      { hostParticipantId: 0 },
    );
    const client = new FakeMatchmakingClient({ createResponse: joined });
    const notifications: MultiplayerNotification[] = [];
    const controller = new MultiplayerController({
      client,
      clock,
      onNotification: (n) => notifications.push(n),
    });
    await controller.hostSession(joined.config, 'Host');
    controller.updateSession(joined);
    const before = controller.getSession()!;

    controller.handleNetworkEvent({
      type: 'participant_left',
      participantId: 2,
      reason: 'disconnect',
    });

    // Participant removed from the tracked session (copy, not mutation).
    const after = controller.getSession()!;
    expect(after.participants.has(2)).toBe(false);
    expect(before.participants.has(2)).toBe(true);
    expect(after.participants.has(0)).toBe(true);

    // A notification was surfaced to remaining players.
    expect(notifications).toHaveLength(1);
    const n = notifications[0]!;
    expect(n.kind).toBe('participant_left');
    if (n.kind === 'participant_left') {
      expect(n.participantId).toBe(2);
      expect(n.reason).toBe('disconnect');
      // Emitted well within the 3 s budget of the disconnection being observed.
      expect(n.at - eventAt).toBeLessThan(DISCONNECT_NOTIFY_BUDGET_MS);
    }
    expect(controller.getLastNotification()).toBe(n);
  });

  it('describes the quit and eliminated reasons distinctly', async () => {
    const { controller, notifications } = await seatedController(0);
    controller.handleNetworkEvent({ type: 'participant_left', participantId: 1, reason: 'quit' });
    expect(notifications[0]!.message).toMatch(/left the session/);

    controller.handleNetworkEvent({
      type: 'participant_left',
      participantId: 1,
      reason: 'eliminated',
    });
    expect(notifications[1]!.message).toMatch(/eliminated/);
  });
});

describe('MultiplayerController host-transfer handling (Req 7.8)', () => {
  it('updates the tracked host and makes the local player host when targeted', async () => {
    // Local player is participant 1; host 0 leaves and host transfers to 1.
    const { controller, notifications } = await seatedController(1);
    expect(controller.isHost()).toBe(false);

    controller.handleNetworkEvent({
      type: 'host_transferred',
      previousHostId: 0,
      newHostId: 1,
    });

    expect(controller.isHost()).toBe(true);
    expect(controller.getSession()!.hostParticipantId).toBe(1);
    const n = notifications.at(-1)!;
    expect(n.kind).toBe('host_transferred');
    if (n.kind === 'host_transferred') {
      expect(n.localBecameHost).toBe(true);
      expect(n.newHostId).toBe(1);
    }
  });

  it('updates the host without promoting a non-targeted local player', async () => {
    // Local player is participant 2; host transfers 0 -> 1.
    const { controller, notifications } = await seatedController(2, [
      participant(0, true),
      participant(1, true),
      participant(2, true),
    ]);

    controller.handleNetworkEvent({
      type: 'host_transferred',
      previousHostId: 0,
      newHostId: 1,
    });

    expect(controller.isHost()).toBe(false);
    expect(controller.getSession()!.hostParticipantId).toBe(1);
    const n = notifications.at(-1)!;
    if (n.kind === 'host_transferred') {
      expect(n.localBecameHost).toBe(false);
    }
  });
});

describe('MultiplayerController pause banner (Req 11.5)', () => {
  it('raises a "host has paused" banner and clears it on resume', async () => {
    const { controller, banners } = await seatedController(1);

    controller.handleNetworkEvent({ type: 'paused', participantId: 0 });
    const raised = controller.getPauseBanner();
    expect(raised).not.toBeNull();
    expect(raised!.participantId).toBe(0);
    expect(raised!.message).toMatch(/[Hh]ost has paused/);
    expect(banners.at(-1)).toEqual(raised);

    controller.handleNetworkEvent({ type: 'resumed', participantId: 0 });
    expect(controller.getPauseBanner()).toBeNull();
    expect(banners.at(-1)).toBeNull();
  });

  it('names a non-host participant that paused', async () => {
    const { controller } = await seatedController(0, [
      participant(0, true),
      participant(1, true),
      participant(2, true),
    ]);
    controller.handleNetworkEvent({ type: 'paused', participantId: 2 });
    const banner = controller.getPauseBanner();
    expect(banner!.participantId).toBe(2);
    expect(banner!.message).toMatch(/Player 2 paused/);
  });

  it('ignores the local player pausing (no remote banner)', async () => {
    const { controller, banners } = await seatedController(1);
    controller.handleNetworkEvent({ type: 'paused', participantId: 1 });
    expect(controller.getPauseBanner()).toBeNull();
    expect(banners).toHaveLength(0);
  });

  it('leaves the banner intact when a different participant resumes', async () => {
    const { controller } = await seatedController(0, [
      participant(0, true),
      participant(1, true),
      participant(2, true),
    ]);
    controller.handleNetworkEvent({ type: 'paused', participantId: 1 });
    controller.handleNetworkEvent({ type: 'resumed', participantId: 2 });
    expect(controller.getPauseBanner()).not.toBeNull();
    expect(controller.getPauseBanner()!.participantId).toBe(1);
  });
});
