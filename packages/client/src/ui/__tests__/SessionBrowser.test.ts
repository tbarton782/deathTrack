import { describe, expect, it, vi } from 'vitest';
import type { SessionSummary } from '@deathtrack/shared';
import {
  buildSessionRows,
  toSessionRow,
  isSessionFull,
  canJoinSession,
  formatPlayerCount,
  joinSessionRow,
  fetchSessionRows,
  createFetchSessionBrowserClient,
  type SessionRow,
  type SessionBrowserClient,
  type FetchLike,
  type ListSessionsResponse,
} from '../SessionBrowser';

/**
 * These tests exercise only the GPU-free session-browser logic: mapping
 * `SessionSummary`s to rows, the full/joinable decision, player-count
 * formatting, and the join call wiring through an injected client. None of this
 * needs a WebGL context or a live server, so it runs headless in the `node`
 * vitest environment. The actual PixiJS drawing (the `SessionBrowser` class) is
 * validated in the browser, not here.
 *
 * Validates: Requirements 7.2 (session browser lists sessions by name, track,
 * and current/max player count; full sessions are flagged and non-joinable).
 */

function summary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    id: 'sess-1',
    name: 'Test Arena',
    trackId: 'track_01' as SessionSummary['trackId'],
    currentPlayers: 2,
    maxPlayers: 8,
    hasPassword: false,
    state: 'lobby',
    ...overrides,
  };
}

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 'sess-1',
    name: 'Test Arena',
    track: 'track_01' as SessionRow['track'],
    current: 2,
    max: 8,
    isFull: false,
    hasPassword: false,
    ...overrides,
  };
}

describe('isSessionFull', () => {
  it('is false while there is room', () => {
    expect(isSessionFull(0, 8)).toBe(false);
    expect(isSessionFull(7, 8)).toBe(false);
  });

  it('is true once current reaches or exceeds max', () => {
    expect(isSessionFull(8, 8)).toBe(true);
    expect(isSessionFull(9, 8)).toBe(true);
  });
});

describe('toSessionRow / buildSessionRows', () => {
  it('maps name, track, and current/max counts from the summary', () => {
    const r = toSessionRow(
      summary({ name: 'Rumble', trackId: 'track_03' as never, currentPlayers: 3, maxPlayers: 6 }),
    );
    expect(r.name).toBe('Rumble');
    expect(r.track).toBe('track_03');
    expect(r.current).toBe(3);
    expect(r.max).toBe(6);
  });

  it('flags full sessions (current >= max)', () => {
    const full = toSessionRow(summary({ currentPlayers: 8, maxPlayers: 8 }));
    const open = toSessionRow(summary({ currentPlayers: 4, maxPlayers: 8 }));
    expect(full.isFull).toBe(true);
    expect(open.isFull).toBe(false);
  });

  it('preserves order and maps every summary', () => {
    const rows = buildSessionRows([
      summary({ id: 'a', name: 'A' }),
      summary({ id: 'b', name: 'B', currentPlayers: 8, maxPlayers: 8 }),
    ]);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[0]!.isFull).toBe(false);
    expect(rows[1]!.isFull).toBe(true);
  });

  it('does not mutate the input array', () => {
    const input = [summary()];
    const snapshot = JSON.stringify(input);
    buildSessionRows(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});

describe('canJoinSession', () => {
  it('allows joining open sessions', () => {
    expect(canJoinSession(row({ isFull: false }))).toBe(true);
  });

  it('forbids joining full sessions', () => {
    expect(canJoinSession(row({ isFull: true }))).toBe(false);
  });
});

describe('formatPlayerCount', () => {
  it('renders current/max for open sessions', () => {
    expect(formatPlayerCount(row({ current: 3, max: 8, isFull: false }))).toBe('3/8');
  });

  it('appends FULL for full sessions', () => {
    expect(formatPlayerCount(row({ current: 8, max: 8, isFull: true }))).toBe('8/8 FULL');
  });
});

describe('joinSessionRow', () => {
  it('calls the client with the correct session id and body for open sessions', async () => {
    const joinSession = vi.fn(async () => ({ participantId: 5 }));
    const client: SessionBrowserClient = {
      listSessions: vi.fn(),
      joinSession,
    };
    const result = await joinSessionRow(client, row({ id: 'target-99' }), {
      displayName: 'Racer',
    });
    expect(joinSession).toHaveBeenCalledTimes(1);
    expect(joinSession).toHaveBeenCalledWith('target-99', { displayName: 'Racer' });
    expect(result).toEqual({ participantId: 5 });
  });

  it('refuses to join a full session without calling the client', async () => {
    const joinSession = vi.fn();
    const client: SessionBrowserClient = {
      listSessions: vi.fn(),
      joinSession,
    };
    await expect(
      joinSessionRow(client, row({ id: 'full-1', isFull: true }), { displayName: 'X' }),
    ).rejects.toThrow(/full/i);
    expect(joinSession).not.toHaveBeenCalled();
  });
});

describe('fetchSessionRows', () => {
  it('fetches summaries via the client and maps them to rows', async () => {
    const response: ListSessionsResponse = {
      sessions: [
        summary({ id: 'a', currentPlayers: 2, maxPlayers: 8 }),
        summary({ id: 'b', currentPlayers: 6, maxPlayers: 6 }),
      ],
    };
    const client: SessionBrowserClient = {
      listSessions: vi.fn(async () => response),
      joinSession: vi.fn(),
    };
    const rows = await fetchSessionRows(client);
    expect(client.listSessions).toHaveBeenCalledTimes(1);
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[1]!.isFull).toBe(true);
  });
});

describe('createFetchSessionBrowserClient', () => {
  it('issues GET /sessions and returns the parsed body', async () => {
    const body: ListSessionsResponse = { sessions: [summary({ id: 'x' })] };
    const fetchImpl: FetchLike = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => body,
    }));
    const client = createFetchSessionBrowserClient(fetchImpl, 'http://host:8080/');
    const result = await client.listSessions();
    expect(fetchImpl).toHaveBeenCalledWith('http://host:8080/sessions', { method: 'GET' });
    expect(result).toEqual(body);
  });

  it('issues POST /sessions/:id/join with a JSON body', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ participantId: 1 }),
    }));
    const client = createFetchSessionBrowserClient(fetchImpl as unknown as FetchLike, 'http://host:8080');
    await client.joinSession('sess-42', { displayName: 'Neo', password: null });
    expect(fetchImpl).toHaveBeenCalledWith('http://host:8080/sessions/sess-42/join', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ displayName: 'Neo', password: null }),
    });
  });

  it('throws when GET /sessions returns a non-ok status', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => ({}),
    }));
    const client = createFetchSessionBrowserClient(fetchImpl);
    await expect(client.listSessions()).rejects.toThrow(/500/);
  });
});
