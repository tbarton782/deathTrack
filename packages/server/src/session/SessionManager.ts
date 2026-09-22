/**
 * In-process session lifecycle manager for the Deathtrack Multiplayer server.
 *
 * Owns the authoritative set of multiplayer sessions and the pure business
 * rules governing their lifecycle:
 *
 *   - creating a session from a validated {@link SessionConfig} (Req 7.1, 7.3);
 *   - joining a session with slot assignment, capacity, password, and
 *     race-in-progress checks (Req 7.2, 7.3, 7.5);
 *   - listing open (lobby-state) sessions for the session browser (Req 7.2);
 *   - transferring host status to the longest-standing participant, or closing
 *     the session when nobody remains (Req 7.8);
 *   - filling empty slots with AI drivers at race start when the config opts in
 *     (Req 7.7);
 *   - closing a session explicitly (Req 7.1).
 *
 * Sessions live in an in-process `Map<SessionId, Session>`. Non-determinism
 * (id generation and the wall clock) is injected so tests can drive the manager
 * deterministically instead of relying on `Date.now`/`Math.random`.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.7, 7.8
 */

import { AI_CHARACTER_ORDER } from '@deathtrack/shared';
import type {
  AICharacter,
  AIDriverConfig,
  JoinResult,
  ParticipantId,
  ParticipantInfo,
  Session,
  SessionConfig,
  SessionId,
  SessionSummary,
  SkillTier,
} from '@deathtrack/shared';

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

/**
 * Minimal success/failure result mirroring the shape used elsewhere in the
 * codebase (`@deathtrack/shared` loadout/career services). `ok: true` carries a
 * `value`; `ok: false` carries a machine-readable `error` code plus a
 * human-readable `message`.
 */
export type Result<T, E = SessionError> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E; readonly message: string };

/** Machine-readable rejection codes for {@link SessionManager.createSession}. */
export type SessionError =
  /** `name` is empty or exceeds 32 characters. Requirements: 7.1 */
  | 'invalid_name'
  /** `maxPlayers` is outside the inclusive range [2, 8]. Requirements: 7.1 */
  | 'invalid_max_players'
  /** `password` is a non-null string exceeding 20 characters. Requirements: 7.3 */
  | 'invalid_password';

// ---------------------------------------------------------------------------
// Inputs and injectable dependencies
// ---------------------------------------------------------------------------

/**
 * Player information supplied when joining (or hosting) a session. The slot
 * index (`ParticipantId`) and `joinedAt` timestamp are assigned by the manager,
 * so callers only provide the human-facing fields.
 *
 * Requirements: 7.4, 7.5
 */
export interface JoinPlayer {
  /** Player's chosen display name (1–20 characters). */
  displayName: string;
  /** Password supplied for the join attempt; `null`/omitted for open sessions. */
  password?: string | null;
}

/** Constraint bounds, exported for reuse by tests and property definitions. */
export const SESSION_NAME_MAX = 32;
export const SESSION_NAME_MIN = 1;
export const SESSION_MAX_PLAYERS_MIN = 2;
export const SESSION_MAX_PLAYERS_MAX = 8;
export const SESSION_PASSWORD_MAX = 20;

/**
 * The pool of AI characters used when filling empty slots — the real nine-driver
 * roster, shared with single-player so both modes field the same opponents.
 * Requirements: 7.7
 */
const AI_CHARACTERS: readonly AICharacter[] = AI_CHARACTER_ORDER;

const AI_SKILL_TIERS: readonly SkillTier[] = ['novice', 'standard', 'expert'];

/**
 * Injectable non-deterministic dependencies. Defaults use the real clock,
 * random selection, and UUID generation; tests override them for determinism.
 */
export interface SessionManagerDeps {
  /** Returns the current time in milliseconds. Defaults to `Date.now`. */
  now: () => number;
  /** Generates a fresh unique session id. Defaults to a UUID v4 generator. */
  generateId: () => SessionId;
  /**
   * Returns a value in [0, 1) used to pick AI characters/skill tiers when
   * filling empty slots. Defaults to `Math.random`.
   */
  random: () => number;
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

export class SessionManager {
  private readonly sessions = new Map<SessionId, Session>();
  private readonly now: () => number;
  private readonly generateId: () => SessionId;
  private readonly random: () => number;

  constructor(deps: Partial<SessionManagerDeps> = {}) {
    this.now = deps.now ?? (() => Date.now());
    this.generateId = deps.generateId ?? defaultIdGenerator();
    this.random = deps.random ?? (() => Math.random());
  }

  /**
   * Validates a {@link SessionConfig} and, if valid, creates a new session in
   * `'lobby'` state hosted by the supplied player (slot 0).
   *
   * Rejects (without creating anything) when:
   * - `name` is empty or > 32 chars (`invalid_name`);
   * - `maxPlayers` is outside [2, 8] (`invalid_max_players`);
   * - `password` is a non-null string > 20 chars (`invalid_password`).
   *
   * Requirements: 7.1, 7.3, 7.4
   */
  createSession(config: SessionConfig, host: JoinPlayer): Result<Session, SessionError> {
    const validation = validateConfig(config);
    if (!validation.ok) return validation;

    const createdAt = this.now();
    const hostId: ParticipantId = 0;
    const hostInfo: ParticipantInfo = {
      id: hostId,
      displayName: host.displayName,
      loadout: null,
      ready: false,
      isAI: false,
      joinedAt: createdAt,
    };

    const participants = new Map<ParticipantId, ParticipantInfo>();
    participants.set(hostId, hostInfo);

    const session: Session = {
      id: this.generateId(),
      // Defensive copy so later mutation of the caller's object cannot leak in.
      config: { ...config },
      hostParticipantId: hostId,
      participants,
      state: 'lobby',
      createdAt,
    };

    this.sessions.set(session.id, session);
    return { ok: true, value: session };
  }

  /**
   * Attempts to add a player to an existing session.
   *
   * Rejection reasons (see {@link JoinResult.error}):
   * - `not_found`       — no session with the given id;
   * - `already_started` — session is not in `'lobby'` state;
   * - `wrong_password`  — password-protected session and password mismatch;
   * - `full`            — no free human slot up to `maxPlayers`.
   *
   * On success, assigns the lowest free slot index and returns the session.
   *
   * Requirements: 7.2, 7.3, 7.5
   */
  joinSession(sessionId: SessionId, player: JoinPlayer): JoinResult {
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: 'not_found' };

    if (session.state !== 'lobby') {
      return { success: false, error: 'already_started' };
    }

    if (session.config.password !== null) {
      if ((player.password ?? null) !== session.config.password) {
        return { success: false, error: 'wrong_password' };
      }
    }

    const humanCount = countHumans(session);
    if (humanCount >= session.config.maxPlayers) {
      return { success: false, error: 'full' };
    }

    const slot = lowestFreeSlot(session);
    const info: ParticipantInfo = {
      id: slot,
      displayName: player.displayName,
      loadout: null,
      ready: false,
      isAI: false,
      joinedAt: this.now(),
    };
    session.participants.set(slot, info);

    return { success: true, participantId: slot, session };
  }

  /**
   * Returns condensed summaries of every session currently open to browsing —
   * i.e. those in `'lobby'` or `'racing'` state. Closed and results sessions
   * are omitted.
   *
   * Requirements: 7.2
   */
  listOpenSessions(): SessionSummary[] {
    const summaries: SessionSummary[] = [];
    for (const session of this.sessions.values()) {
      if (session.state !== 'lobby' && session.state !== 'racing') continue;
      summaries.push({
        id: session.id,
        name: session.config.name,
        trackId: session.config.trackId,
        currentPlayers: countHumans(session),
        maxPlayers: session.config.maxPlayers,
        hasPassword: session.config.password !== null,
        state: session.state,
      });
    }
    return summaries;
  }

  /**
   * Transfers host status to the connected human participant with the smallest
   * `joinedAt` (longest session membership), preserving all other config. If no
   * human participant remains, the session is closed.
   *
   * Ties on `joinedAt` are broken by the smaller slot index for determinism.
   *
   * Requirements: 7.8
   */
  transferHost(session: Session): void {
    let candidate: ParticipantInfo | null = null;
    for (const p of session.participants.values()) {
      if (p.isAI) continue;
      if (
        candidate === null ||
        p.joinedAt < candidate.joinedAt ||
        (p.joinedAt === candidate.joinedAt && p.id < candidate.id)
      ) {
        candidate = p;
      }
    }

    if (candidate === null) {
      this.closeSession(session.id);
      return;
    }

    session.hostParticipantId = candidate.id;
  }

  /**
   * Fills every empty participant slot (below `maxPlayers`) with an AI driver of
   * a randomly selected character and skill tier, then advances the session to
   * `'racing'`. No-op filling occurs when `config.fillWithAI` is `false`, but the
   * session still transitions to racing.
   *
   * Requirements: 7.7
   */
  startRace(session: Session): void {
    if (session.config.fillWithAI) {
      const startedAt = this.now();
      for (let slot = 0; slot < session.config.maxPlayers; slot++) {
        if (session.participants.has(slot)) continue;
        session.participants.set(slot, {
          id: slot,
          displayName: `AI ${this.pickCharacter()}`,
          loadout: null,
          ready: true,
          isAI: true,
          aiConfig: this.makeAIConfig(),
          joinedAt: startedAt,
        });
      }
    }
    session.state = 'racing';
  }

  /**
   * Removes a participant from a session. When the departing participant is the
   * current host, host status is transferred (which may close the session if no
   * humans remain). Removing the last participant closes the session.
   *
   * Requirements: 7.6, 7.8
   */
  removeParticipant(sessionId: SessionId, participantId: ParticipantId): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.participants.delete(participantId);

    if (countHumans(session) === 0) {
      this.closeSession(sessionId);
      return;
    }

    if (session.hostParticipantId === participantId) {
      this.transferHost(session);
    }
  }

  /**
   * Marks a session as closed and removes it from the active store. Idempotent.
   *
   * Requirements: 7.1
   */
  closeSession(sessionId: SessionId): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.state = 'closed';
    this.sessions.delete(sessionId);
  }

  /** Retrieves a session by id, or `undefined` if it does not exist. */
  getSession(sessionId: SessionId): Session | undefined {
    return this.sessions.get(sessionId);
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private pickCharacter(): AICharacter {
    const idx = Math.floor(this.random() * AI_CHARACTERS.length);
    return AI_CHARACTERS[Math.min(idx, AI_CHARACTERS.length - 1)]!;
  }

  private pickSkillTier(): SkillTier {
    const idx = Math.floor(this.random() * AI_SKILL_TIERS.length);
    return AI_SKILL_TIERS[Math.min(idx, AI_SKILL_TIERS.length - 1)]!;
  }

  private makeAIConfig(): AIDriverConfig {
    return {
      character: this.pickCharacter(),
      skillTier: this.pickSkillTier(),
      aggression: 1 + Math.floor(this.random() * 5), // 1..5
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Validates a {@link SessionConfig} against all documented constraints without
 * side effects.
 *
 * Requirements: 7.1, 7.3
 */
export function validateConfig(config: SessionConfig): Result<SessionConfig, SessionError> {
  if (
    typeof config.name !== 'string' ||
    config.name.length < SESSION_NAME_MIN ||
    config.name.length > SESSION_NAME_MAX
  ) {
    return {
      ok: false,
      error: 'invalid_name',
      message: `Session name must be ${SESSION_NAME_MIN}–${SESSION_NAME_MAX} characters.`,
    };
  }

  if (
    !Number.isInteger(config.maxPlayers) ||
    config.maxPlayers < SESSION_MAX_PLAYERS_MIN ||
    config.maxPlayers > SESSION_MAX_PLAYERS_MAX
  ) {
    return {
      ok: false,
      error: 'invalid_max_players',
      message: `maxPlayers must be an integer in [${SESSION_MAX_PLAYERS_MIN}, ${SESSION_MAX_PLAYERS_MAX}].`,
    };
  }

  if (config.password !== null && config.password.length > SESSION_PASSWORD_MAX) {
    return {
      ok: false,
      error: 'invalid_password',
      message: `Password must be null or at most ${SESSION_PASSWORD_MAX} characters.`,
    };
  }

  return { ok: true, value: config };
}

/** Counts human (non-AI) participants currently in the session. */
function countHumans(session: Session): number {
  let n = 0;
  for (const p of session.participants.values()) {
    if (!p.isAI) n++;
  }
  return n;
}

/** Returns the lowest slot index in [0, maxPlayers) not currently occupied. */
function lowestFreeSlot(session: Session): ParticipantId {
  for (let slot = 0; slot < session.config.maxPlayers; slot++) {
    if (!session.participants.has(slot)) return slot;
  }
  // Callers guard against a full session before calling; fall back to append.
  return session.participants.size;
}

/**
 * Builds a default UUID v4 id generator, preferring the platform `crypto.randomUUID`
 * when available and falling back to a small RFC-4122-shaped generator otherwise.
 */
function defaultIdGenerator(): () => SessionId {
  const globalCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (globalCrypto?.randomUUID) {
    return () => globalCrypto.randomUUID!();
  }
  return () =>
    'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
}
