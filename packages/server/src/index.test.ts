/**
 * Unit tests for the socketless wiring pieces of the server entry point.
 *
 * These tests deliberately never open a real TCP or WebSocket socket. They
 * exercise the exported factory helpers that make up {@link createServer}:
 *
 *   - {@link buildHttpHandler} — dispatching a fake `req`/`res` pair through a
 *     {@link MatchmakingRouter} and asserting the JSON response;
 *   - {@link makeWsConnectionAdapter} — the `ws` → {@link ClientConnection}
 *     `send` path with a fake socket that records bytes;
 *   - {@link encodeInputFrame} / {@link decodeInputFrame} — round-trip of the
 *     inbound client input codec;
 *   - the small URL/env parsing helpers ({@link resolvePort},
 *     {@link extractSessionId}, {@link extractParticipantId}).
 *
 * The live-socket behaviour (actual HTTP listen, WS upgrade, broadcast over a
 * real connection) is intentionally out of scope here — it needs an
 * integration harness that binds a port.
 *
 * Requirements: 7.1, 7.2, 8.1, 8.5
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { InputFrame } from '@deathtrack/shared';

import { SessionManager } from './session/SessionManager.js';
import { MatchmakingRouter } from './http/MatchmakingRouter.js';
import {
  buildHttpHandler,
  makeWsConnectionAdapter,
  encodeInputFrame,
  decodeInputFrame,
  coerceMessageData,
  resolvePort,
  extractSessionId,
  extractParticipantId,
  DEFAULT_PORT,
} from './index.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A minimal fake `http.IncomingMessage` that streams a body then ends. */
class FakeRequest extends EventEmitter {
  constructor(
    public method: string,
    public url: string,
  ) {
    super();
  }

  /** Emits the body (if any) then `end`, mimicking a request stream. */
  drive(body?: string): void {
    // Defer so the handler has attached its listeners first.
    queueMicrotask(() => {
      if (body !== undefined && body.length > 0) {
        this.emit('data', Buffer.from(body, 'utf8'));
      }
      this.emit('end');
    });
  }

  destroy(): void {
    /* no-op for the fake */
  }
}

/** A minimal fake `http.ServerResponse` capturing the written response. */
class FakeResponse {
  statusCode = 200;
  headers: Record<string, string | number> = {};
  body = '';
  ended = false;

  setHeader(name: string, value: string | number): void {
    this.headers[name] = value;
  }

  end(payload: string): void {
    this.body = payload;
    this.ended = true;
  }
}

/** Runs one request through the handler and resolves with the fake response. */
function dispatch(
  router: MatchmakingRouter,
  method: string,
  url: string,
  body?: string,
): Promise<FakeResponse> {
  const handler = buildHttpHandler(router);
  const req = new FakeRequest(method, url);
  const res = new FakeResponse();
  return new Promise((resolve) => {
    // Wrap end so we resolve once the handler finishes writing.
    const originalEnd = res.end.bind(res);
    res.end = (payload: string) => {
      originalEnd(payload);
      resolve(res);
    };
    handler(req as never, res as never);
    req.drive(body);
  });
}

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

// ---------------------------------------------------------------------------
// buildHttpHandler
// ---------------------------------------------------------------------------

describe('buildHttpHandler', () => {
  it('dispatches GET /sessions through the router and returns JSON', async () => {
    const { router } = makeRouter();
    const res = await dispatch(router, 'GET', '/sessions');

    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(res.body)).toEqual({ sessions: [] });
  });

  it('parses a JSON body and creates a session (201)', async () => {
    const { router } = makeRouter();
    const body = JSON.stringify({
      name: 'Arena',
      trackId: 'track-1',
      maxPlayers: 4,
      password: null,
      fillWithAI: false,
      displayName: 'Host',
    });
    const res = await dispatch(router, 'POST', '/sessions', body);

    expect(res.statusCode).toBe(201);
    const parsed = JSON.parse(res.body);
    expect(parsed.id).toBe('session-0');
    expect(parsed.hostParticipantId).toBe(0);
  });

  it('maps a malformed JSON body to 400 invalid_body', async () => {
    const { router } = makeRouter();
    const res = await dispatch(router, 'POST', '/sessions', '{not json');

    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe('invalid_body');
  });

  it('returns 404 for an unknown route', async () => {
    const { router } = makeRouter();
    const res = await dispatch(router, 'GET', '/nope');

    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body).error).toBe('not_found');
  });

  it('strips the query string before routing', async () => {
    const { router } = makeRouter();
    const res = await dispatch(router, 'GET', '/sessions?foo=bar');

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ sessions: [] });
  });
});

// ---------------------------------------------------------------------------
// makeWsConnectionAdapter
// ---------------------------------------------------------------------------

describe('makeWsConnectionAdapter', () => {
  it('forwards send() bytes to the underlying socket and carries participantId', () => {
    const sent: Uint8Array[] = [];
    const fakeWs = {
      send(bytes: Uint8Array) {
        sent.push(bytes);
      },
    };

    const conn = makeWsConnectionAdapter(fakeWs, 3);
    expect(conn.participantId).toBe(3);

    const payload = new Uint8Array([1, 2, 3, 4]);
    conn.send(payload);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(payload);
  });
});

// ---------------------------------------------------------------------------
// InputFrame codec
// ---------------------------------------------------------------------------

describe('encodeInputFrame / decodeInputFrame', () => {
  const frame: InputFrame = {
    tick: 12345,
    inputs: {
      throttle: 0.75,
      brake: 0.25,
      steer: -0.5,
      fireForward: true,
      fireRear: false,
    },
    checksum: 0xdeadbeef,
  };

  it('round-trips a frame through encode -> decode', () => {
    const decoded = decodeInputFrame(encodeInputFrame(frame));
    expect(decoded).not.toBeNull();
    expect(decoded!.tick).toBe(frame.tick);
    expect(decoded!.checksum).toBe(frame.checksum);
    expect(decoded!.inputs.throttle).toBeCloseTo(0.75, 4);
    expect(decoded!.inputs.brake).toBeCloseTo(0.25, 4);
    expect(decoded!.inputs.steer).toBeCloseTo(-0.5, 4);
    expect(decoded!.inputs.fireForward).toBe(true);
    expect(decoded!.inputs.fireRear).toBe(false);
  });

  it('packs both fire bits independently', () => {
    const both: InputFrame = {
      ...frame,
      inputs: { ...frame.inputs, fireForward: true, fireRear: true },
    };
    const decoded = decodeInputFrame(encodeInputFrame(both));
    expect(decoded!.inputs.fireForward).toBe(true);
    expect(decoded!.inputs.fireRear).toBe(true);
  });

  it('returns null for a truncated / malformed buffer', () => {
    expect(decodeInputFrame(new Uint8Array([1, 2]))).toBeNull();
    expect(decodeInputFrame(new Uint8Array(0))).toBeNull();
  });

  it('clamps out-of-range axes into the representable range', () => {
    const wild: InputFrame = {
      tick: 1,
      inputs: { throttle: 5, brake: -3, steer: 2, fireForward: false, fireRear: false },
      checksum: 0,
    };
    const decoded = decodeInputFrame(encodeInputFrame(wild))!;
    expect(decoded.inputs.throttle).toBeCloseTo(1, 4);
    expect(decoded.inputs.brake).toBeCloseTo(0, 4);
    expect(decoded.inputs.steer).toBeCloseTo(1, 4);
  });
});

// ---------------------------------------------------------------------------
// coerceMessageData
// ---------------------------------------------------------------------------

describe('coerceMessageData', () => {
  it('passes a Uint8Array through unchanged', () => {
    const u = new Uint8Array([9, 8, 7]);
    expect(coerceMessageData(u)).toBe(u);
  });

  it('wraps an ArrayBuffer', () => {
    const ab = new Uint8Array([1, 2, 3]).buffer;
    expect(Array.from(coerceMessageData(ab))).toEqual([1, 2, 3]);
  });

  it('concatenates an array of Buffers', () => {
    const parts = [Buffer.from([1, 2]), Buffer.from([3])];
    expect(Array.from(coerceMessageData(parts))).toEqual([1, 2, 3]);
  });

  it('falls back to an empty buffer for unexpected shapes', () => {
    expect(coerceMessageData(null)).toHaveLength(0);
    expect(coerceMessageData('nope')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// resolvePort
// ---------------------------------------------------------------------------

describe('resolvePort', () => {
  it('defaults when PORT is unset', () => {
    expect(resolvePort({})).toBe(DEFAULT_PORT);
  });

  it('reads a valid PORT', () => {
    expect(resolvePort({ PORT: '3000' })).toBe(3000);
  });

  it('falls back on an invalid PORT', () => {
    expect(resolvePort({ PORT: 'abc' })).toBe(DEFAULT_PORT);
    expect(resolvePort({ PORT: '-1' })).toBe(DEFAULT_PORT);
    expect(resolvePort({ PORT: '99999' })).toBe(DEFAULT_PORT);
  });
});

// ---------------------------------------------------------------------------
// URL parsing helpers
// ---------------------------------------------------------------------------

describe('extractSessionId / extractParticipantId', () => {
  it('extracts session and participant from the upgrade URL', () => {
    expect(extractSessionId('/?session=abc&participant=2')).toBe('abc');
    expect(extractParticipantId('/?session=abc&participant=2')).toBe(2);
  });

  it('returns null when absent', () => {
    expect(extractSessionId('/')).toBeNull();
    expect(extractSessionId(undefined)).toBeNull();
    expect(extractParticipantId('/?session=abc')).toBeNull();
  });

  it('rejects out-of-range participant slots', () => {
    expect(extractParticipantId('/?participant=8')).toBeNull();
    expect(extractParticipantId('/?participant=-1')).toBeNull();
    expect(extractParticipantId('/?participant=x')).toBeNull();
  });
});
