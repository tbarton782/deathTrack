/**
 * Framework-agnostic matchmaking REST router for the Deathtrack Multiplayer server.
 *
 * Maps the four session-management endpoints onto {@link SessionManager} calls
 * and translates the manager's `Result`/`JoinResult` outcomes into HTTP status
 * codes and JSON-serialisable response bodies:
 *
 *   - `POST   /sessions`          — create a session from a {@link SessionConfig}
 *                                   plus host display name (201 on success);
 *   - `GET    /sessions`          — list open (lobby/racing) sessions (200);
 *   - `POST   /sessions/:id/join` — join a session by id (200 on success);
 *   - `DELETE /sessions/:id`      — host closes a session (200).
 *
 * The router deliberately has no dependency on any HTTP framework. It operates
 * on an already-parsed {@link RouterRequest} (method, path, params, parsed body)
 * and returns a {@link RouterResponse} (`{ status, body }`), so it can be unit
 * tested without opening a socket. The concrete Node `http` wiring — routing a
 * real request/response pair and parsing the JSON body off the wire — lives in
 * the server entry point (task 12.8).
 *
 * Status-code mapping:
 *   - create: invalid config -> 400 with the manager's error code;
 *   - join:   `not_found` -> 404, `wrong_password` -> 403,
 *             `full`/`already_started` -> 409;
 *   - malformed / missing body -> 400 (`invalid_body`);
 *   - unknown route -> 404 (`not_found`).
 *
 * Requirements: 7.1, 7.2
 */

import type {
  JoinResult,
  Session,
  SessionConfig,
  SessionId,
  SessionSummary,
  TrackId,
} from '@deathtrack/shared';
import { SessionManager, type JoinPlayer } from '../session/SessionManager.js';

// ---------------------------------------------------------------------------
// Request / response shapes
// ---------------------------------------------------------------------------

/** HTTP methods handled by the router. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';

/**
 * A parsed HTTP request handed to the router. The concrete Node `http` layer is
 * responsible for parsing method, path, route params, and the JSON body before
 * calling {@link MatchmakingRouter.handle}.
 */
export interface RouterRequest {
  /** Request method, upper-cased. */
  readonly method: string;
  /** URL path with the query string stripped, e.g. `/sessions/abc/join`. */
  readonly path: string;
  /**
   * Route params extracted by the caller (optional). When omitted, the router
   * derives the session id from the path itself, so callers are free to pass a
   * raw path without pre-extracting params.
   */
  readonly params?: Readonly<Record<string, string>>;
  /**
   * Parsed request body. `undefined` when there is no body. If the caller could
   * not parse the body as JSON it should pass the {@link MALFORMED_BODY}
   * sentinel so the router can respond `400 invalid_body`.
   */
  readonly body?: unknown;
}

/** The router's result: an HTTP status code plus a JSON-serialisable body. */
export interface RouterResponse {
  readonly status: number;
  readonly body: unknown;
}

/**
 * Sentinel a caller may pass as {@link RouterRequest.body} to signal that the
 * incoming payload could not be parsed as JSON. The router maps it to
 * `400 invalid_body`.
 */
export const MALFORMED_BODY = Symbol('MALFORMED_BODY');

// ---------------------------------------------------------------------------
// Response body shapes
// ---------------------------------------------------------------------------

/** Standard error body: a machine-readable code plus an optional message. */
export interface ErrorBody {
  readonly error: string;
  readonly message?: string;
}

/** Body returned by `POST /sessions/:id/join` on success. */
export interface JoinSuccessBody {
  readonly participantId: number;
  readonly session: SerializableSession;
}

/**
 * A `Session` with its `participants` Map converted to a plain array so the
 * value is JSON-serialisable.
 */
export interface SerializableSession {
  readonly id: SessionId;
  readonly config: SessionConfig;
  readonly hostParticipantId: number;
  readonly participants: Session['participants'] extends Map<infer _K, infer V>
    ? readonly V[]
    : never;
  readonly state: Session['state'];
  readonly createdAt: number;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

/**
 * Maps the manager's join-error codes to HTTP status codes.
 *
 * Requirements: 7.2
 */
const JOIN_ERROR_STATUS: Record<NonNullable<JoinResult['error']>, number> = {
  not_found: 404,
  wrong_password: 403,
  full: 409,
  already_started: 409,
};

export class MatchmakingRouter {
  constructor(private readonly manager: SessionManager) {}

  /**
   * Routes a parsed request to the appropriate handler and returns a
   * `{ status, body }` response. Never throws for client-input problems;
   * malformed bodies and unknown routes are returned as 4xx responses.
   *
   * Requirements: 7.1, 7.2
   */
  handle(req: RouterRequest): RouterResponse {
    const method = req.method.toUpperCase();
    const path = normalizePath(req.path);

    if (path === '/sessions') {
      if (method === 'POST') return this.createSession(req);
      if (method === 'GET') return this.listSessions();
      return methodNotAllowed();
    }

    // /sessions/:id/join
    const joinId = matchSegment(path, 'join');
    if (joinId !== null) {
      if (method !== 'POST') return methodNotAllowed();
      return this.joinSession(joinId, req);
    }

    // /sessions/:id
    const id = matchSessionId(path);
    if (id !== null) {
      if (method === 'DELETE') return this.closeSession(id);
      return methodNotAllowed();
    }

    return errorResponse(404, 'not_found', `No route for ${method} ${path}.`);
  }

  // -------------------------------------------------------------------------
  // POST /sessions
  // -------------------------------------------------------------------------

  private createSession(req: RouterRequest): RouterResponse {
    const body = parseBody(req.body);
    if (body === null) return invalidBody();

    const config = extractSessionConfig(body);
    if (config === null) {
      return errorResponse(400, 'invalid_body', 'Request body is not a valid session config.');
    }

    const host = extractHost(body);
    if (host === null) {
      return errorResponse(400, 'invalid_body', 'Request body is missing a valid host displayName.');
    }

    const result = this.manager.createSession(config, host);
    if (!result.ok) {
      // Invalid config -> 400 with the manager's machine-readable error code.
      return errorResponse(400, result.error, result.message);
    }

    return { status: 201, body: serializeSession(result.value) };
  }

  // -------------------------------------------------------------------------
  // GET /sessions
  // -------------------------------------------------------------------------

  private listSessions(): RouterResponse {
    const sessions: SessionSummary[] = this.manager.listOpenSessions();
    return { status: 200, body: { sessions } };
  }

  // -------------------------------------------------------------------------
  // POST /sessions/:id/join
  // -------------------------------------------------------------------------

  private joinSession(sessionId: SessionId, req: RouterRequest): RouterResponse {
    const body = parseBody(req.body);
    if (body === null) return invalidBody();

    const player = extractJoinPlayer(body);
    if (player === null) {
      return errorResponse(400, 'invalid_body', 'Request body is missing a valid displayName.');
    }

    const result = this.manager.joinSession(sessionId, player);
    if (!result.success) {
      const code = result.error ?? 'not_found';
      const status = JOIN_ERROR_STATUS[code] ?? 400;
      return errorResponse(status, code, joinErrorMessage(code));
    }

    const successBody: JoinSuccessBody = {
      participantId: result.participantId!,
      session: serializeSession(result.session!),
    };
    return { status: 200, body: successBody };
  }

  // -------------------------------------------------------------------------
  // DELETE /sessions/:id
  // -------------------------------------------------------------------------

  private closeSession(sessionId: SessionId): RouterResponse {
    const existing = this.manager.getSession(sessionId);
    if (!existing) {
      return errorResponse(404, 'not_found', `No session with id ${sessionId}.`);
    }
    this.manager.closeSession(sessionId);
    return { status: 200, body: { closed: true, id: sessionId } };
  }
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

/** Strips a trailing slash (except the root) and any query string. */
function normalizePath(path: string): string {
  let p = path;
  const q = p.indexOf('?');
  if (q !== -1) p = p.slice(0, q);
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

/**
 * Matches `/sessions/:id/{tail}` and returns the decoded id, or `null` if the
 * path does not have that exact three-segment shape.
 */
function matchSegment(path: string, tail: string): SessionId | null {
  const parts = splitPath(path);
  if (parts.length === 3 && parts[0] === 'sessions' && parts[2] === tail) {
    return decode(parts[1]!);
  }
  return null;
}

/**
 * Matches `/sessions/:id` and returns the decoded id, or `null` if the path is
 * not exactly two segments under `sessions`.
 */
function matchSessionId(path: string): SessionId | null {
  const parts = splitPath(path);
  if (parts.length === 2 && parts[0] === 'sessions') {
    return decode(parts[1]!);
  }
  return null;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// Body parsing / validation
// ---------------------------------------------------------------------------

/**
 * Normalises the incoming body into a plain object, or `null` when it is
 * malformed / not an object. The {@link MALFORMED_BODY} sentinel and non-object
 * values both yield `null`.
 */
function parseBody(body: unknown): Record<string, unknown> | null {
  if (body === MALFORMED_BODY) return null;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

/**
 * Extracts a {@link SessionConfig} from a request body. Returns `null` if the
 * required fields are missing or the wrong primitive type. Value-range
 * validation (name length, player bounds, password length) is left to
 * {@link SessionManager.createSession}, which owns those business rules.
 */
function extractSessionConfig(body: Record<string, unknown>): SessionConfig | null {
  const name = body.name;
  const trackId = body.trackId;
  const maxPlayers = body.maxPlayers;
  const password = body.password ?? null;
  const fillWithAI = body.fillWithAI ?? false;

  if (typeof name !== 'string') return null;
  if (typeof trackId !== 'string') return null;
  if (typeof maxPlayers !== 'number') return null;
  if (password !== null && typeof password !== 'string') return null;
  if (typeof fillWithAI !== 'boolean') return null;

  return {
    name,
    // `trackId` is a string-literal union; the router does not police track
    // validity (neither does SessionManager), so accept any string here.
    trackId: trackId as TrackId,
    maxPlayers,
    password,
    fillWithAI,
  };
}

/**
 * Extracts the host {@link JoinPlayer} from a create-session body. The host's
 * display name may be provided as `host.displayName` or a top-level
 * `displayName`.
 */
function extractHost(body: Record<string, unknown>): JoinPlayer | null {
  const hostObj =
    typeof body.host === 'object' && body.host !== null
      ? (body.host as Record<string, unknown>)
      : body;
  const displayName = hostObj.displayName;
  if (typeof displayName !== 'string' || displayName.length === 0) return null;
  return { displayName };
}

/** Extracts the joining {@link JoinPlayer} (display name + optional password). */
function extractJoinPlayer(body: Record<string, unknown>): JoinPlayer | null {
  const displayName = body.displayName;
  if (typeof displayName !== 'string' || displayName.length === 0) return null;

  const rawPassword = body.password;
  const password =
    rawPassword === undefined || rawPassword === null
      ? null
      : typeof rawPassword === 'string'
        ? rawPassword
        : undefined;
  if (password === undefined) return null; // non-string, non-null password

  return { displayName, password };
}

// ---------------------------------------------------------------------------
// Serialisation
// ---------------------------------------------------------------------------

/** Converts a `Session` (with a Map of participants) into a JSON-safe object. */
function serializeSession(session: Session): SerializableSession {
  return {
    id: session.id,
    config: session.config,
    hostParticipantId: session.hostParticipantId,
    participants: Array.from(session.participants.values()),
    state: session.state,
    createdAt: session.createdAt,
  } as SerializableSession;
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

function errorResponse(status: number, error: string, message?: string): RouterResponse {
  const body: ErrorBody = message === undefined ? { error } : { error, message };
  return { status, body };
}

function invalidBody(): RouterResponse {
  return errorResponse(400, 'invalid_body', 'Request body could not be parsed as JSON.');
}

function methodNotAllowed(): RouterResponse {
  return errorResponse(405, 'method_not_allowed', 'HTTP method not allowed for this route.');
}

function joinErrorMessage(code: NonNullable<JoinResult['error']>): string {
  switch (code) {
    case 'not_found':
      return 'No session with the given id exists.';
    case 'wrong_password':
      return 'The provided password is incorrect.';
    case 'full':
      return 'The session is full.';
    case 'already_started':
      return 'The session has already started and is closed to new players.';
  }
}
