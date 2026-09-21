/**
 * Headless multiplayer session-flow controller (task 22.1).
 *
 * Orchestrates the two client-side entry paths into a multiplayer race and the
 * shared lobby that both funnel into:
 *
 * - **Host path** (Requirements 7.1, 7.4): create a named session via
 *   `POST /sessions`, wait in the lobby, and start the race once every
 *   participant is ready and the minimum player count is met.
 * - **Join path** (Requirements 7.2, 7.3, 7.5): browse open sessions via
 *   `GET /sessions`, refuse full sessions, supply a password when the session
 *   is protected, synchronise the full session state within a 2 second budget,
 *   then enter the lobby.
 *
 * ## Design
 *
 * This controller is a *pure state machine*: it holds no PixiJS/DOM references
 * and performs no wall-clock waits. Everything time- or transport-dependent is
 * injected:
 *
 * - a {@link MatchmakingClient} (an extension of the session browser's
 *   `SessionBrowserClient`) issues the four REST calls, so tests drive the flow
 *   with an in-memory fake and never touch a real server;
 * - a {@link Clock} supplies "now" so the 2 second sync budget (Requirement
 *   7.5) is asserted deterministically rather than by sleeping; and
 * - a {@link StateSyncHook} models the NetworkManager-backed state
 *   synchronisation as an injectable async step, so tests can make it resolve
 *   instantly, slowly, or never.
 *
 * The start-race predicate reuses {@link computeCanStartRace} from the lobby UI
 * so the "host + all ready + minimum count" rule stays in one place.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */

import type {
  Session,
  SessionConfig,
  SessionSummary,
  SessionId,
  JoinResult,
  ParticipantId,
  StateSnapshot,
  NetworkEvent,
  ParticipantLeftEvent,
  HostTransferredEvent,
  PausedEvent,
  ResumedEvent,
} from '@deathtrack/shared';
import {
  computeCanStartRace,
  MIN_SESSION_PLAYERS,
} from '../ui/Lobby.js';
import type {
  SessionBrowserClient,
  ListSessionsResponse,
  JoinRequestBody,
} from '../ui/SessionBrowser.js';

// ---------------------------------------------------------------------------
// Injected collaborators
// ---------------------------------------------------------------------------

/**
 * Body accepted by `POST /sessions`, matching the server's
 * `MatchmakingRouter.createSession` / `extractSessionConfig` + `extractHost`: a
 * session config plus the host's display name.
 */
export interface CreateSessionRequestBody extends SessionConfig {
  /** The host player's display name (1–20 characters). */
  readonly displayName: string;
}

/**
 * The transport the controller depends on for all four matchmaking endpoints.
 *
 * It extends the session browser's {@link SessionBrowserClient} (which already
 * covers `GET /sessions` and `POST /sessions/:id/join`) with the host-only
 * `POST /sessions` (create) and `DELETE /sessions/:id` (close) calls, so the
 * client interface stays unified rather than forking a parallel one.
 */
export interface MatchmakingClient extends SessionBrowserClient {
  /**
   * Creates a session via `POST /sessions`, returning the newly created
   * {@link Session}. Rejects on non-2xx responses.
   */
  createSession(body: CreateSessionRequestBody): Promise<Session>;
  /**
   * Closes a session the local player hosts via `DELETE /sessions/:id`.
   */
  closeSession(sessionId: SessionId): Promise<void>;
}

/** Injected wall-clock source so the 2 s sync budget is deterministic in tests. */
export interface Clock {
  /** Current time in milliseconds. */
  now(): number;
}

/**
 * Models the NetworkManager-backed synchronisation of the full session state to
 * a newly-joined participant (Requirement 7.5). Injected so tests can control
 * how long the sync takes without a real network. Implementations resolve once
 * the joining client holds the authoritative session state (track selection,
 * all participant loadouts, ready status).
 *
 * @param session - The session record returned by the join call.
 * @param participantId - The slot assigned to the local (joining) player.
 * @returns The synchronised session state once sync completes.
 */
export type StateSyncHook = (
  session: Session,
  participantId: ParticipantId,
) => Promise<StateSnapshot>;

// ---------------------------------------------------------------------------
// Controller configuration + phases
// ---------------------------------------------------------------------------

/** The maximum time a join-time state sync may take (Requirement 7.5), in ms. */
export const STATE_SYNC_BUDGET_MS = 2000;

/**
 * The maximum time within which remaining participants must be notified of a
 * disconnection (Requirement 7.6), in ms. The controller surfaces the
 * notification synchronously on the event, so the elapsed time recorded against
 * the injected clock is asserted to fall well within this budget.
 */
export const DISCONNECT_NOTIFY_BUDGET_MS = 3000;

// ---------------------------------------------------------------------------
// Notifications + pause banner
// ---------------------------------------------------------------------------

/**
 * A transient notification surfaced to the local player in response to a
 * session-lifecycle network event (a participant leaving, or host transfer).
 * Kept UI-agnostic so the controller stays headless: the injected
 * {@link NotificationSink} decides how (and whether) to render it.
 */
export type MultiplayerNotification =
  | {
      /** A participant left the session (Requirement 7.6). */
      readonly kind: 'participant_left';
      /** The slot that departed. */
      readonly participantId: ParticipantId;
      /** Why they left, mirrored from {@link ParticipantLeftEvent}. */
      readonly reason: ParticipantLeftEvent['reason'];
      /** Human-readable message for display. */
      readonly message: string;
      /** Clock timestamp (ms) at which the notification was emitted. */
      readonly at: number;
    }
  | {
      /** The session host changed (Requirement 7.8). */
      readonly kind: 'host_transferred';
      /** The previous host's slot. */
      readonly previousHostId: ParticipantId;
      /** The new host's slot. */
      readonly newHostId: ParticipantId;
      /** `true` when the local player became the new host. */
      readonly localBecameHost: boolean;
      /** Human-readable message for display. */
      readonly message: string;
      /** Clock timestamp (ms) at which the notification was emitted. */
      readonly at: number;
    };

/** Callback invoked with each {@link MultiplayerNotification} the controller raises. */
export type NotificationSink = (notification: MultiplayerNotification) => void;

/**
 * State of the "a participant has paused" banner (Requirement 11.5). `null`
 * means no banner is shown. When a remote participant pauses, the banner names
 * them; it clears when the matching resume arrives.
 */
export interface PauseBannerState {
  /** The participant that paused. */
  readonly participantId: ParticipantId;
  /** Human-readable banner text (e.g. "host has paused"). */
  readonly message: string;
}

/** Callback invoked whenever the pause banner appears or clears (`null` = cleared). */
export type PauseBannerSink = (banner: PauseBannerState | null) => void;

/**
 * The lifecycle phase of the controller. Both the host and join paths converge
 * on `'lobby'` and then `'racing'`.
 */
export type MultiplayerPhase =
  | 'idle'
  | 'creating'
  | 'browsing'
  | 'joining'
  | 'syncing'
  | 'lobby'
  | 'racing'
  | 'error';

export interface MultiplayerControllerOptions {
  /** REST transport for all four matchmaking endpoints. */
  readonly client: MatchmakingClient;
  /** Wall-clock source for the sync budget. */
  readonly clock: Clock;
  /**
   * State-sync step invoked on join. When omitted, join treats sync as
   * instantaneous (used by the host path, which is already authoritative).
   */
  readonly stateSync?: StateSyncHook;
  /**
   * Minimum number of ready participants required to start the race
   * (Requirement 7.4). Defaults to {@link MIN_SESSION_PLAYERS}.
   */
  readonly minPlayers?: number;
  /**
   * Sink for participant-left / host-transfer notifications (Requirements 7.6,
   * 7.8). Optional — omit to ignore notifications; state is still queryable via
   * {@link MultiplayerController.getLastNotification}.
   */
  readonly onNotification?: NotificationSink;
  /**
   * Sink for pause-banner changes (Requirement 11.5). Optional — omit to ignore
   * banner updates; state is still queryable via
   * {@link MultiplayerController.getPauseBanner}.
   */
  readonly onPauseBanner?: PauseBannerSink;
}

/** Raised when an operation is attempted from an incompatible phase. */
export class MultiplayerFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultiplayerFlowError';
  }
}

/** Raised when a join-time state sync exceeds {@link STATE_SYNC_BUDGET_MS}. */
export class StateSyncTimeoutError extends Error {
  constructor(public readonly elapsedMs: number) {
    super(
      `Session state sync exceeded the ${STATE_SYNC_BUDGET_MS} ms budget (took ${elapsedMs} ms).`,
    );
    this.name = 'StateSyncTimeoutError';
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Drives the client through the host and join multiplayer flows. Fully
 * headless and unit-testable: no PixiJS, no DOM, no wall-clock sleeps.
 */
export class MultiplayerController {
  private readonly client: MatchmakingClient;
  private readonly clock: Clock;
  private readonly stateSync: StateSyncHook | undefined;
  private readonly minPlayers: number;
  private readonly onNotification: NotificationSink | undefined;
  private readonly onPauseBanner: PauseBannerSink | undefined;

  private phase: MultiplayerPhase = 'idle';
  private session: Session | null = null;
  private localParticipantId: ParticipantId | null = null;
  private host = false;
  private lastError: Error | null = null;
  private lastNotification: MultiplayerNotification | null = null;
  private pauseBanner: PauseBannerState | null = null;

  constructor(opts: MultiplayerControllerOptions) {
    this.client = opts.client;
    this.clock = opts.clock;
    this.stateSync = opts.stateSync;
    this.minPlayers = opts.minPlayers ?? MIN_SESSION_PLAYERS;
    this.onNotification = opts.onNotification;
    this.onPauseBanner = opts.onPauseBanner;
  }

  // --- Accessors ----------------------------------------------------------

  /** The current lifecycle phase. */
  getPhase(): MultiplayerPhase {
    return this.phase;
  }

  /** The session the controller is currently attached to, or `null`. */
  getSession(): Session | null {
    return this.session;
  }

  /** The local player's assigned participant slot, or `null` before join/create. */
  getLocalParticipantId(): ParticipantId | null {
    return this.localParticipantId;
  }

  /** Whether the local player is the host of the current session. */
  isHost(): boolean {
    return this.host;
  }

  /** The most recent error, or `null`. Cleared when a new flow starts. */
  getLastError(): Error | null {
    return this.lastError;
  }

  /**
   * The most recent notification raised via {@link handleNetworkEvent}
   * (participant-left or host-transfer), or `null` if none has been raised.
   */
  getLastNotification(): MultiplayerNotification | null {
    return this.lastNotification;
  }

  /**
   * The current pause-banner state (Requirement 11.5), or `null` when no remote
   * participant is paused.
   */
  getPauseBanner(): PauseBannerState | null {
    return this.pauseBanner;
  }

  // --- Host path ----------------------------------------------------------

  /**
   * Host path step 1 (Requirement 7.1): create a named session via
   * `POST /sessions` and enter the lobby. On success the local player becomes
   * the host and the returned session is retained.
   *
   * @param config - Session configuration (name, track, slots, password, AI).
   * @param displayName - The host's display name.
   * @returns The created session.
   */
  async hostSession(
    config: SessionConfig,
    displayName: string,
  ): Promise<Session> {
    this.beginFlow('creating');
    try {
      const session = await this.client.createSession({
        ...config,
        displayName,
      });
      this.session = session;
      this.host = true;
      this.localParticipantId = session.hostParticipantId;
      this.phase = 'lobby';
      return session;
    } catch (err) {
      this.fail(err);
      throw err;
    }
  }

  /**
   * Whether the host may start the race right now (Requirement 7.4): the local
   * player is the host, every participant is ready, and the participant count
   * meets the configured minimum. Delegates to {@link computeCanStartRace} so
   * the rule stays consistent with the lobby UI.
   */
  canStartRace(): boolean {
    if (this.session === null) return false;
    return computeCanStartRace(this.session, {
      isHost: this.host,
      minPlayers: this.minPlayers,
    });
  }

  /**
   * Host path step 2 (Requirement 7.4): start the race. Only permitted from the
   * lobby when {@link canStartRace} holds; otherwise a {@link MultiplayerFlowError}
   * is thrown and the phase is left unchanged.
   */
  startRace(): void {
    if (this.phase !== 'lobby') {
      throw new MultiplayerFlowError(
        `Cannot start race from phase '${this.phase}'.`,
      );
    }
    if (!this.canStartRace()) {
      throw new MultiplayerFlowError(
        'Cannot start race: not host, not all participants ready, or below the minimum player count.',
      );
    }
    this.phase = 'racing';
  }

  /**
   * Applies an updated session record (e.g. from a `participant_joined` event
   * or a lobby refresh) so {@link canStartRace} reflects the latest roster and
   * ready statuses. No-op outside the lobby.
   */
  updateSession(session: Session): void {
    this.session = session;
  }

  // --- Network event handling (task 22.2) ---------------------------------

  /**
   * Entry point the NetworkManager calls with each {@link NetworkEvent} decoded
   * from a state snapshot. Drives the client-side reactions to session
   * lifecycle changes that occur during a race or in the lobby:
   *
   * - `participant_left` (Requirement 7.6): the departed participant is dropped
   *   from the tracked session and a "participant left" notification is
   *   surfaced to the remaining players. The notification is emitted
   *   synchronously — its {@link MultiplayerNotification.at} clock stamp is
   *   recorded so callers can assert it lands well within the
   *   {@link DISCONNECT_NOTIFY_BUDGET_MS} budget.
   * - `host_transferred` (Requirement 7.8): the tracked session's host is
   *   updated and, if the local player is the new host, {@link isHost} flips to
   *   `true`. A notification is surfaced.
   * - `paused` (Requirement 11.5): raises the "has paused" banner naming the
   *   participant that paused. A self-pause (the local player) does not raise a
   *   remote banner.
   * - `resumed` (Requirement 11.5): clears the banner when it matches the
   *   participant that had paused.
   *
   * Unhandled event types (`participant_joined`, `session_closed`) are ignored
   * here; the join/lobby flow and higher-level UI own those.
   */
  handleNetworkEvent(event: NetworkEvent): void {
    switch (event.type) {
      case 'participant_left':
        this.handleParticipantLeft(event);
        break;
      case 'host_transferred':
        this.handleHostTransferred(event);
        break;
      case 'paused':
        this.handlePaused(event);
        break;
      case 'resumed':
        this.handleResumed(event);
        break;
      default:
        // participant_joined / session_closed are handled elsewhere.
        break;
    }
  }

  /**
   * Requirement 7.6: remove the departed participant from the tracked session
   * and notify the remaining players. The tracked session's `participants` map
   * is copied so the removal does not mutate the record shared with callers.
   */
  private handleParticipantLeft(event: ParticipantLeftEvent): void {
    if (this.session) {
      const participants = new Map(this.session.participants);
      participants.delete(event.participantId);
      this.session = { ...this.session, participants };
    }

    const reasonText =
      event.reason === 'disconnect'
        ? 'disconnected'
        : event.reason === 'quit'
          ? 'left the session'
          : 'was eliminated';

    this.emitNotification({
      kind: 'participant_left',
      participantId: event.participantId,
      reason: event.reason,
      message: `Player ${event.participantId} ${reasonText}.`,
      at: this.clock.now(),
    });
  }

  /**
   * Requirement 7.8: update the tracked session's host and flip {@link isHost}
   * when the local player is the new host, then surface a notification.
   */
  private handleHostTransferred(event: HostTransferredEvent): void {
    if (this.session) {
      this.session = { ...this.session, hostParticipantId: event.newHostId };
    }

    const localBecameHost =
      this.localParticipantId !== null &&
      this.localParticipantId === event.newHostId;
    if (localBecameHost) {
      this.host = true;
    } else if (this.localParticipantId === event.previousHostId) {
      // The local player was the host and lost it (e.g. reconnect edge cases).
      this.host = false;
    }

    this.emitNotification({
      kind: 'host_transferred',
      previousHostId: event.previousHostId,
      newHostId: event.newHostId,
      localBecameHost,
      message: localBecameHost
        ? 'You are now the host.'
        : `Player ${event.newHostId} is now the host.`,
      at: this.clock.now(),
    });
  }

  /**
   * Requirement 11.5: raise the "has paused" banner for a remote pause. A pause
   * originating from the local player is ignored (that player sees their own
   * pause menu, not a remote banner).
   */
  private handlePaused(event: PausedEvent): void {
    if (this.localParticipantId === event.participantId) return;

    const session = this.session;
    const isHostPause =
      session !== null && session.hostParticipantId === event.participantId;
    const banner: PauseBannerState = {
      participantId: event.participantId,
      message: isHostPause
        ? 'Host has paused'
        : `Player ${event.participantId} paused`,
    };
    this.pauseBanner = banner;
    this.onPauseBanner?.(banner);
  }

  /**
   * Requirement 11.5: clear the pause banner when the participant that paused
   * resumes. A resume from a different participant leaves the banner intact.
   */
  private handleResumed(event: ResumedEvent): void {
    if (this.pauseBanner && this.pauseBanner.participantId === event.participantId) {
      this.pauseBanner = null;
      this.onPauseBanner?.(null);
    }
  }

  /** Records and dispatches a notification to the injected sink. */
  private emitNotification(notification: MultiplayerNotification): void {
    this.lastNotification = notification;
    this.onNotification?.(notification);
  }

  // --- Join path ----------------------------------------------------------

  /**
   * Join path step 1 (Requirement 7.2): browse open sessions via
   * `GET /sessions`. Returns the raw summaries; the caller (or the session
   * browser UI) decides which to join. Full sessions are flagged by the server
   * summary (`currentPlayers >= maxPlayers`).
   */
  async browseSessions(): Promise<readonly SessionSummary[]> {
    this.beginFlow('browsing');
    try {
      const res: ListSessionsResponse = await this.client.listSessions();
      this.phase = 'idle';
      return res.sessions;
    } catch (err) {
      this.fail(err);
      throw err;
    }
  }

  /**
   * Join path steps 2–4 (Requirements 7.2, 7.3, 7.5): join the given session,
   * supplying a password when it is protected, then synchronise the full
   * session state within the {@link STATE_SYNC_BUDGET_MS} budget and enter the
   * lobby.
   *
   * Refusals:
   * - a full session (`summary.currentPlayers >= summary.maxPlayers`) is
   *   refused locally without a network call (Requirement 7.2);
   * - the server rejects a wrong password / full / already-started join, which
   *   surfaces as a {@link MultiplayerFlowError};
   * - a sync that exceeds the 2 s budget raises {@link StateSyncTimeoutError}.
   *
   * @param summary - The session to join (as listed by {@link browseSessions}).
   * @param displayName - The joining player's display name.
   * @param password - Password for protected sessions; `null`/omitted for open ones.
   * @returns The synchronised session once the local player is in the lobby.
   */
  async joinSession(
    summary: SessionSummary,
    displayName: string,
    password: string | null = null,
  ): Promise<Session> {
    this.beginFlow('joining');

    if (isSessionFull(summary)) {
      const err = new MultiplayerFlowError(
        `Session ${summary.id} is full (${summary.currentPlayers}/${summary.maxPlayers}) and cannot be joined.`,
      );
      this.fail(err);
      throw err;
    }

    // Supply the password only when the session is protected (Requirement 7.3).
    const body: JoinRequestBody = summary.hasPassword
      ? { displayName, password }
      : { displayName };

    let result: JoinResult;
    try {
      result = (await this.client.joinSession(summary.id, body)) as JoinResult;
    } catch (err) {
      this.fail(err);
      throw err;
    }

    if (!result.success || !result.session || result.participantId === undefined) {
      const err = new MultiplayerFlowError(
        `Join refused for session ${summary.id}: ${result.error ?? 'unknown'}.`,
      );
      this.fail(err);
      throw err;
    }

    const session = result.session;
    const participantId = result.participantId;

    // Synchronise the full session state within the 2 s budget (Requirement 7.5).
    this.phase = 'syncing';
    try {
      await this.syncWithinBudget(session, participantId);
    } catch (err) {
      this.fail(err);
      throw err;
    }

    this.session = session;
    this.localParticipantId = participantId;
    this.host = session.hostParticipantId === participantId;
    this.phase = 'lobby';
    return session;
  }

  /**
   * Leaves / closes the current session. Hosts issue `DELETE /sessions/:id`;
   * non-hosts simply detach locally. Resets the controller to `idle`.
   */
  async leaveSession(): Promise<void> {
    const session = this.session;
    if (session && this.host) {
      await this.client.closeSession(session.id);
    }
    this.session = null;
    this.localParticipantId = null;
    this.host = false;
    this.phase = 'idle';
  }

  // --- Internals ----------------------------------------------------------

  /**
   * Runs the injected state-sync step and enforces the 2 s budget against the
   * injected clock. When no sync hook is configured the step is treated as
   * instantaneous. A hook that resolves after the budget — or a caller-provided
   * timing that shows more than {@link STATE_SYNC_BUDGET_MS} elapsed — raises
   * {@link StateSyncTimeoutError}.
   */
  private async syncWithinBudget(
    session: Session,
    participantId: ParticipantId,
  ): Promise<void> {
    if (!this.stateSync) return;

    const start = this.clock.now();
    await this.stateSync(session, participantId);
    const elapsed = this.clock.now() - start;

    if (elapsed > STATE_SYNC_BUDGET_MS) {
      throw new StateSyncTimeoutError(elapsed);
    }
  }

  /** Enters a new flow: records the phase and clears any prior error. */
  private beginFlow(phase: MultiplayerPhase): void {
    this.phase = phase;
    this.lastError = null;
  }

  /** Records an error and transitions to the error phase. */
  private fail(err: unknown): void {
    this.lastError = err instanceof Error ? err : new Error(String(err));
    this.phase = 'error';
  }
}

// ---------------------------------------------------------------------------
// Pure helpers (GPU-free, unit-testable)
// ---------------------------------------------------------------------------

/**
 * Whether a session summary represents a full session (Requirement 7.2): the
 * current human player count has reached the configured maximum.
 */
export function isSessionFull(summary: SessionSummary): boolean {
  return summary.currentPlayers >= summary.maxPlayers;
}

// ---------------------------------------------------------------------------
// fetch-backed matchmaking client
// ---------------------------------------------------------------------------

/** A subset of the DOM `fetch` signature the client relies on. */
export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

/**
 * Builds a {@link MatchmakingClient} backed by a `fetch`-like function and a
 * base URL, covering all four endpoints of the server's `MatchmakingRouter`.
 * Extracted as a pure factory so it can be unit-tested with a fake `fetch` — no
 * real network is touched in tests.
 *
 * @param fetchImpl - A `fetch`-compatible function.
 * @param baseUrl - Server origin, e.g. `http://localhost:8080`. A trailing
 *   slash is tolerated.
 */
export function createFetchMatchmakingClient(
  fetchImpl: FetchLike,
  baseUrl = '',
): MatchmakingClient {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

  return {
    async listSessions(): Promise<ListSessionsResponse> {
      const res = await fetchImpl(`${base}/sessions`, { method: 'GET' });
      if (!res.ok) {
        throw new Error(`GET /sessions failed with status ${res.status}`);
      }
      return (await res.json()) as ListSessionsResponse;
    },

    async joinSession(
      sessionId: SessionId,
      body: JoinRequestBody,
    ): Promise<unknown> {
      const res = await fetchImpl(
        `${base}/sessions/${encodeURIComponent(sessionId)}/join`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        throw new Error(
          `POST /sessions/${sessionId}/join failed with status ${res.status}`,
        );
      }
      return res.json();
    },

    async createSession(body: CreateSessionRequestBody): Promise<Session> {
      const res = await fetchImpl(`${base}/sessions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        throw new Error(`POST /sessions failed with status ${res.status}`);
      }
      return (await res.json()) as Session;
    },

    async closeSession(sessionId: SessionId): Promise<void> {
      const res = await fetchImpl(
        `${base}/sessions/${encodeURIComponent(sessionId)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        throw new Error(
          `DELETE /sessions/${sessionId} failed with status ${res.status}`,
        );
      }
    },
  };
}
