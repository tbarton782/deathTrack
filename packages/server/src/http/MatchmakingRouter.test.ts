/**
 * Unit tests for {@link MatchmakingRouter}.
 *
 * Covers each of the four endpoints and the status-code mapping from the
 * underlying {@link SessionManager} outcomes:
 *   - POST /sessions          — 201 success, 400 invalid config, 400 bad body
 *   - GET  /sessions          — 200 with open-session summaries
 *   - POST /sessions/:id/join — 200 success, 403 wrong_password, 409 full,
 *                               404 not_found, 409 already_started
 *   - DELETE /sessions/:id     — 200 close, 404 not_found
 *
 * Requirements: 7.1, 7.2
 */

import { describe, expect, it } from 'vitest';
import type { SessionConfig } from '@deathtrack/shared';
import { SessionManager } from '../session/SessionManager.js';
import {
  MatchmakingRouter,
  MALFORMED_BODY,
  type ErrorBody,
  type JoinSuccessBody,
  type SerializableSession,
} from './MatchmakingRouter.js';

/** Deterministic manager: monotonic clock + sequential ids. */
function makeRouter() {
  let clock = 1000;
  let idSeq = 0;
  const manager = new SessionManager({
    now: () => clock++,
    generateId: () => `session-${idSeq++}`,
    random: () => 0,
  });
  return { manager, router: new MatchmakingRouter(manager) };
}

function baseConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    name: 'Test Arena',
    trackId: 'chicago',
    maxPlayers: 4,
    password: null,
    fillWithAI: false,
    ...overrides,
  };
}

/** Creates a session via the router and returns its id. */
function createSession(
  router: MatchmakingRouter,
  config: Partial<SessionConfig> = {},
  displayName = 'Host',
): string {
  const res = router.handle({
    method: 'POST',
    path: '/sessions',
    body: { ...baseConfig(config), host: { displayName } },
  });
  expect(res.status).toBe(201);
  return (res.body as SerializableSession).id;
}

describe('POST /sessions', () => {
  it('creates a session and returns 201 with the serialized session', () => {
    const { router } = makeRouter();
    const res = router.handle({
      method: 'POST',
      path: '/sessions',
      body: { ...baseConfig(), host: { displayName: 'Host' } },
    });

    expect(res.status).toBe(201);
    const session = res.body as SerializableSession;
    expect(session.id).toBe('session-0');
    expect(session.state).toBe('lobby');
    expect(session.hostParticipantId).toBe(0);
    // participants must be a JSON-safe array (not a Map).
    expect(Array.isArray(session.participants)).toBe(true);
    expect(session.participants).toHaveLength(1);
    expect(session.participants[0]!.displayName).toBe('Host');
  });

  it('accepts a top-level displayName as the host', () => {
    const { router } = makeRouter();
    const res = router.handle({
      method: 'POST',
      path: '/sessions',
      body: { ...baseConfig(), displayName: 'SoloHost' },
    });
    expect(res.status).toBe(201);
    const session = res.body as SerializableSession;
    expect(session.participants[0]!.displayName).toBe('SoloHost');
  });

  it('returns 400 with the manager error code for an invalid name', () => {
    const { router } = makeRouter();
    const res = router.handle({
      method: 'POST',
      path: '/sessions',
      body: { ...baseConfig({ name: '' }), host: { displayName: 'Host' } },
    });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toBe('invalid_name');
  });

  it('returns 400 for an invalid maxPlayers value', () => {
    const { router } = makeRouter();
    const res = router.handle({
      method: 'POST',
      path: '/sessions',
      body: { ...baseConfig({ maxPlayers: 1 }), host: { displayName: 'Host' } },
    });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toBe('invalid_max_players');
  });

  it('returns 400 invalid_body for a malformed JSON body', () => {
    const { router } = makeRouter();
    const res = router.handle({ method: 'POST', path: '/sessions', body: MALFORMED_BODY });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toBe('invalid_body');
  });

  it('returns 400 invalid_body when required config fields are missing', () => {
    const { router } = makeRouter();
    const res = router.handle({
      method: 'POST',
      path: '/sessions',
      body: { name: 'X', host: { displayName: 'Host' } }, // no trackId/maxPlayers
    });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toBe('invalid_body');
  });

  it('returns 400 invalid_body when the host displayName is missing', () => {
    const { router } = makeRouter();
    const res = router.handle({
      method: 'POST',
      path: '/sessions',
      body: { ...baseConfig() },
    });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toBe('invalid_body');
  });
});

describe('GET /sessions', () => {
  it('returns 200 with an empty list when no sessions exist', () => {
    const { router } = makeRouter();
    const res = router.handle({ method: 'GET', path: '/sessions' });
    expect(res.status).toBe(200);
    expect((res.body as { sessions: unknown[] }).sessions).toEqual([]);
  });

  it('lists open sessions with summary fields', () => {
    const { router } = makeRouter();
    createSession(router, { name: 'Arena One' });
    createSession(router, { name: 'Arena Two', password: 'secret' });

    const res = router.handle({ method: 'GET', path: '/sessions' });
    expect(res.status).toBe(200);
    const { sessions } = res.body as {
      sessions: Array<{ name: string; hasPassword: boolean; currentPlayers: number }>;
    };
    expect(sessions).toHaveLength(2);
    const two = sessions.find((s) => s.name === 'Arena Two')!;
    expect(two.hasPassword).toBe(true);
    expect(two.currentPlayers).toBe(1);
  });
});

describe('POST /sessions/:id/join', () => {
  it('returns 200 with participantId and session on success', () => {
    const { router } = makeRouter();
    const id = createSession(router);

    const res = router.handle({
      method: 'POST',
      path: `/sessions/${id}/join`,
      body: { displayName: 'Player 2' },
    });
    expect(res.status).toBe(200);
    const body = res.body as JoinSuccessBody;
    expect(body.participantId).toBe(1);
    expect(body.session.participants).toHaveLength(2);
  });

  it('returns 404 not_found for an unknown session id', () => {
    const { router } = makeRouter();
    const res = router.handle({
      method: 'POST',
      path: '/sessions/does-not-exist/join',
      body: { displayName: 'Player' },
    });
    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error).toBe('not_found');
  });

  it('returns 403 wrong_password for a password mismatch', () => {
    const { router } = makeRouter();
    const id = createSession(router, { password: 'secret' });
    const res = router.handle({
      method: 'POST',
      path: `/sessions/${id}/join`,
      body: { displayName: 'Player', password: 'wrong' },
    });
    expect(res.status).toBe(403);
    expect((res.body as ErrorBody).error).toBe('wrong_password');
  });

  it('returns 409 full when the session is at capacity', () => {
    const { router } = makeRouter();
    const id = createSession(router, { maxPlayers: 2 }); // host occupies slot 0

    const first = router.handle({
      method: 'POST',
      path: `/sessions/${id}/join`,
      body: { displayName: 'Player 2' },
    });
    expect(first.status).toBe(200);

    const full = router.handle({
      method: 'POST',
      path: `/sessions/${id}/join`,
      body: { displayName: 'Player 3' },
    });
    expect(full.status).toBe(409);
    expect((full.body as ErrorBody).error).toBe('full');
  });

  it('returns 409 already_started once the race has begun', () => {
    const { manager, router } = makeRouter();
    const id = createSession(router);
    manager.startRace(manager.getSession(id)!);

    const res = router.handle({
      method: 'POST',
      path: `/sessions/${id}/join`,
      body: { displayName: 'Latecomer' },
    });
    expect(res.status).toBe(409);
    expect((res.body as ErrorBody).error).toBe('already_started');
  });

  it('returns 400 invalid_body when displayName is missing', () => {
    const { router } = makeRouter();
    const id = createSession(router);
    const res = router.handle({
      method: 'POST',
      path: `/sessions/${id}/join`,
      body: {},
    });
    expect(res.status).toBe(400);
    expect((res.body as ErrorBody).error).toBe('invalid_body');
  });
});

describe('DELETE /sessions/:id', () => {
  it('closes an existing session and returns 200', () => {
    const { manager, router } = makeRouter();
    const id = createSession(router);

    const res = router.handle({ method: 'DELETE', path: `/sessions/${id}` });
    expect(res.status).toBe(200);
    expect((res.body as { closed: boolean }).closed).toBe(true);
    expect(manager.getSession(id)).toBeUndefined();
  });

  it('returns 404 not_found when closing an unknown session', () => {
    const { router } = makeRouter();
    const res = router.handle({ method: 'DELETE', path: '/sessions/nope' });
    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error).toBe('not_found');
  });
});

describe('routing edge cases', () => {
  it('returns 404 for an unknown route', () => {
    const { router } = makeRouter();
    const res = router.handle({ method: 'GET', path: '/unknown' });
    expect(res.status).toBe(404);
    expect((res.body as ErrorBody).error).toBe('not_found');
  });

  it('returns 405 for an unsupported method on /sessions', () => {
    const { router } = makeRouter();
    const res = router.handle({ method: 'PUT', path: '/sessions' });
    expect(res.status).toBe(405);
  });

  it('tolerates a trailing slash and query string on the collection path', () => {
    const { router } = makeRouter();
    const res = router.handle({ method: 'GET', path: '/sessions/?foo=bar' });
    expect(res.status).toBe(200);
  });
});
