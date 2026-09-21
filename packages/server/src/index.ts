/**
 * Server entry point for the Deathtrack Multiplayer server.
 *
 * Wires together the four building blocks that make up the authoritative game
 * server into a single runnable process:
 *
 *   - a Node `http.Server` that routes the REST matchmaking endpoints through
 *     {@link MatchmakingRouter} (parsing method/url/JSON body off the wire and
 *     writing back a status + JSON body) — Requirements: 7.1, 7.2;
 *   - a `ws` {@link WebSocketServer} attached to the *same* http server, so a
 *     single port serves both the REST API and the realtime binary protocol;
 *   - a {@link SessionManager} owning session lifecycle (create/join/list/close)
 *     — Requirements: 7.1–7.8;
 *   - a per-session {@link ServerNetworkManager} + {@link AuthorityLoop} pair
 *     (created lazily by an injectable factory) driving the 60 Hz simulation and
 *     20 Hz snapshot broadcast — Requirements: 8.1–8.8.
 *
 * ## Testability
 *
 * The wiring is deliberately factored into small, socketless, exported
 * functions so the parts that do not need a live network can be unit-tested:
 *
 *   - {@link buildHttpHandler} turns a {@link MatchmakingRouter} into a Node
 *     request handler; tests drive it with fake `req`/`res` objects.
 *   - {@link makeWsConnectionAdapter} adapts a `ws` socket to the
 *     {@link ClientConnection} interface {@link ServerNetworkManager} expects;
 *     tests supply a fake socket that records the bytes passed to `send`.
 *   - {@link encodeInputFrame} / {@link decodeInputFrame} are a self-contained
 *     binary codec for the inbound client {@link InputFrame} (there is no shared
 *     codec for it — the shared package only ships the *server → client*
 *     snapshot codec), verified by a round-trip unit test.
 *
 * {@link createServer} assembles the whole thing *without* calling `listen`, so
 * a test could construct it and inspect the wiring; {@link startServer} is the
 * thin wrapper that binds a port. The actual `listen()` is guarded behind an
 * `isMainModule()` check (mirroring the tools CLI) so importing this module —
 * as the unit tests do — never opens a socket.
 *
 * Requirements: 7.1–7.8, 8.1–8.8
 */

import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  BinaryReader,
  BinaryWriter,
  type CarInputs,
  type InputFrame,
  type ParticipantId,
  type SessionId,
} from '@deathtrack/shared';

import { SessionManager } from './session/SessionManager.js';
import {
  MatchmakingRouter,
  MALFORMED_BODY,
  type RouterRequest,
} from './http/MatchmakingRouter.js';
import { ServerNetworkManager, type ClientConnection } from './network/ServerNetworkManager.js';
import { AuthorityLoop } from './AuthorityLoop.js';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Default TCP port when `PORT` is not set in the environment. */
export const DEFAULT_PORT = 8080;

/**
 * Resolves the listen port from the environment, falling back to
 * {@link DEFAULT_PORT} when `PORT` is unset or not a valid port number.
 */
export function resolvePort(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PORT;
  if (raw === undefined) return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65535) return DEFAULT_PORT;
  return parsed;
}

// ---------------------------------------------------------------------------
// Inbound InputFrame binary codec (client -> server)
// ---------------------------------------------------------------------------

/**
 * Fixed-point resolution for the analog input axes (`throttle`, `brake`,
 * `steer`) when encoded on the wire. Axes live in `[-1, 1]` (steer) or `[0, 1]`
 * (throttle/brake); scaling by 10000 and rounding to an int16 preserves four
 * decimal places, ample for control fidelity.
 */
const INPUT_AXIS_SCALE = 10000;

/** Bit positions in the packed `fire` byte of an encoded {@link InputFrame}. */
const FIRE_FORWARD_BIT = 0x01;
const FIRE_REAR_BIT = 0x02;

function clampAxis(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

/**
 * Encodes a client {@link InputFrame} into a compact little-endian binary frame.
 *
 * Layout (13 bytes):
 *   - `tick`      uint32
 *   - `throttle`  int16  (× {@link INPUT_AXIS_SCALE}, clamped to `[0, 1]`)
 *   - `brake`     int16  (× {@link INPUT_AXIS_SCALE}, clamped to `[0, 1]`)
 *   - `steer`     int16  (× {@link INPUT_AXIS_SCALE}, clamped to `[-1, 1]`)
 *   - `fire`      uint8  (bit 0 = fireForward, bit 1 = fireRear)
 *   - `checksum`  uint32
 *
 * There is no shared codec for {@link InputFrame} — the shared package only
 * ships the server → client {@link StateSnapshot} codec — so the client/server
 * input protocol is owned here. `decode(encode(frame))` reproduces a
 * structurally identical frame (modulo axis quantisation), which the unit test
 * asserts. Requirements: 8.1, 8.5
 */
export function encodeInputFrame(frame: InputFrame): Uint8Array {
  const writer = new BinaryWriter();
  writer.uint32(frame.tick >>> 0);
  writer.int16(Math.round(clampAxis(frame.inputs.throttle, 0, 1) * INPUT_AXIS_SCALE));
  writer.int16(Math.round(clampAxis(frame.inputs.brake, 0, 1) * INPUT_AXIS_SCALE));
  writer.int16(Math.round(clampAxis(frame.inputs.steer, -1, 1) * INPUT_AXIS_SCALE));
  let fire = 0;
  if (frame.inputs.fireForward) fire |= FIRE_FORWARD_BIT;
  if (frame.inputs.fireRear) fire |= FIRE_REAR_BIT;
  writer.uint8(fire);
  writer.uint32(frame.checksum >>> 0);
  return writer.toUint8Array();
}

/**
 * Decodes an inbound binary client {@link InputFrame} produced by
 * {@link encodeInputFrame}. Returns `null` when the buffer is malformed (too
 * short / unreadable) so the caller can drop the packet rather than throw and
 * tear down the socket. Requirements: 8.1, 8.5
 */
export function decodeInputFrame(bytes: Uint8Array): InputFrame | null {
  try {
    const reader = new BinaryReader(bytes);
    const tick = reader.uint32();
    const throttle = reader.int16() / INPUT_AXIS_SCALE;
    const brake = reader.int16() / INPUT_AXIS_SCALE;
    const steer = reader.int16() / INPUT_AXIS_SCALE;
    const fire = reader.uint8();
    const checksum = reader.uint32();

    const inputs: CarInputs = {
      throttle,
      brake,
      steer,
      fireForward: (fire & FIRE_FORWARD_BIT) !== 0,
      fireRear: (fire & FIRE_REAR_BIT) !== 0,
    };
    return { tick, inputs, checksum };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// HTTP handler
// ---------------------------------------------------------------------------

/** Maximum accepted REST request body size (bytes); guards against unbounded buffering. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * Builds a Node `http` request handler that funnels every request through the
 * framework-agnostic {@link MatchmakingRouter}.
 *
 * Responsibilities kept here (off the router, which is transport-agnostic):
 *   - read the request body (bounded by {@link MAX_BODY_BYTES});
 *   - parse it as JSON, substituting the {@link MALFORMED_BODY} sentinel when a
 *     non-empty body is not valid JSON so the router can answer `400`;
 *   - build a {@link RouterRequest}, call `router.handle`, and serialise the
 *     `{ status, body }` result as a JSON response.
 *
 * Requirements: 7.1, 7.2
 */
export function buildHttpHandler(
  router: MatchmakingRouter,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;

    req.on('data', (chunk: Buffer) => {
      if (aborted) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        aborted = true;
        writeJson(res, 413, { error: 'payload_too_large' });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('error', () => {
      if (aborted) return;
      aborted = true;
      writeJson(res, 400, { error: 'request_error' });
    });

    req.on('end', () => {
      if (aborted) return;

      const raw = Buffer.concat(chunks).toString('utf8');
      const body = parseJsonBody(raw);

      const routerReq: RouterRequest = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        body,
      };

      let response;
      try {
        response = router.handle(routerReq);
      } catch {
        writeJson(res, 500, { error: 'internal_error' });
        return;
      }
      writeJson(res, response.status, response.body);
    });
  };
}

/**
 * Parses a raw request-body string into a value for {@link RouterRequest.body}.
 * An empty body becomes `undefined`; a non-empty body that fails to parse as
 * JSON becomes the {@link MALFORMED_BODY} sentinel (mapped to `400` by the
 * router).
 */
function parseJsonBody(raw: string): unknown {
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return MALFORMED_BODY;
  }
}

/** Serialises `body` as a JSON response with the given status code. */
function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body ?? null);
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

// ---------------------------------------------------------------------------
// WebSocket <-> ClientConnection adapter
// ---------------------------------------------------------------------------

/**
 * Minimal structural view of the `ws` socket surface this module uses. Declaring
 * it locally (rather than importing the concrete `WebSocket` everywhere) keeps
 * {@link makeWsConnectionAdapter} unit-testable with a lightweight fake.
 */
export interface WebSocketLike {
  send(data: Uint8Array): void;
}

/**
 * Adapts a `ws` socket into the {@link ClientConnection} interface the
 * {@link ServerNetworkManager} broadcasts through. The adapter's `send` forwards
 * the encoded snapshot bytes straight to `ws.send`; the manager never sees the
 * concrete socket. Requirements: 8.1
 */
export function makeWsConnectionAdapter(
  ws: WebSocketLike,
  participantId: ParticipantId,
): ClientConnection {
  return {
    participantId,
    send(bytes: Uint8Array): void {
      ws.send(bytes);
    },
  };
}

/**
 * Normalises a `ws` `message` payload (which may arrive as a `Buffer`, an
 * `ArrayBuffer`, or an array of `Buffer`s depending on fragmentation) into a
 * single `Uint8Array` for {@link decodeInputFrame}.
 */
export function coerceMessageData(data: unknown): Uint8Array {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (Array.isArray(data)) {
    // Array of Buffers (fragmented frame) — concatenate.
    return new Uint8Array(Buffer.concat(data as Buffer[]));
  }
  // Fallback: best-effort empty buffer keeps decode from throwing.
  return new Uint8Array(0);
}

// ---------------------------------------------------------------------------
// Per-session runtime
// ---------------------------------------------------------------------------

/**
 * The live simulation resources for a single racing session: the network
 * manager that owns transports + input buffers and the authority loop that
 * drives physics/broadcast. Bundled so a session can be torn down as a unit.
 */
export interface SessionRuntime {
  readonly network: ServerNetworkManager;
  /**
   * The authority loop for the session. Optional because the loop can only be
   * constructed once the full race context (track SDF, waypoint graph, resolved
   * car stats, initial car states) is assembled at race start — a concern owned
   * by the race-start wiring, not this transport entry point.
   */
  readonly loop?: AuthorityLoop;
}

/**
 * Factory that lazily creates the {@link SessionRuntime} for a session the first
 * time a client connects to it. Injectable so tests (and the race-start flow)
 * can control how the network manager / authority loop are built.
 */
export type SessionRuntimeFactory = (sessionId: SessionId) => SessionRuntime;

/**
 * The assembled server: the underlying `http.Server`, the attached
 * {@link WebSocketServer}, the shared {@link SessionManager}, and the registry
 * of per-session runtimes. Returned by {@link createServer} without listening.
 */
export interface DeathtrackServer {
  readonly httpServer: HttpServer;
  readonly wss: WebSocketServer;
  readonly sessionManager: SessionManager;
  readonly router: MatchmakingRouter;
  /** Per-session runtimes, created on first connection. */
  readonly runtimes: Map<SessionId, SessionRuntime>;
  /** Begins listening on `port`; resolves once bound. */
  listen(port: number): Promise<void>;
  /** Stops the authority loops, closes the WS server, and shuts the http server. */
  close(): Promise<void>;
}

/** Options accepted by {@link createServer}, all optional with sensible defaults. */
export interface CreateServerOptions {
  /** Pre-built session manager (defaults to a fresh one). */
  sessionManager?: SessionManager;
  /**
   * Factory for per-session runtimes. Defaults to a bare {@link ServerNetworkManager}
   * with no authority loop (the loop is attached by the race-start flow).
   */
  runtimeFactory?: SessionRuntimeFactory;
}

/**
 * Reads the `sessionId` a connecting client is joining from the WS upgrade URL's
 * query string, e.g. `ws://host/?session=abc`. Returns `null` when absent.
 */
export function extractSessionId(url: string | undefined): SessionId | null {
  if (!url) return null;
  const q = url.indexOf('?');
  if (q === -1) return null;
  const params = new URLSearchParams(url.slice(q + 1));
  return params.get('session');
}

/**
 * Reads the participant slot a connecting client was assigned (returned by the
 * REST join call) from the WS upgrade URL, e.g. `?participant=2`. Returns `null`
 * when absent or not a valid slot.
 */
export function extractParticipantId(url: string | undefined): ParticipantId | null {
  if (!url) return null;
  const q = url.indexOf('?');
  if (q === -1) return null;
  const raw = new URLSearchParams(url.slice(q + 1)).get('participant');
  if (raw === null) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 7) return null;
  return parsed;
}

/**
 * Assembles the full server — http + WebSocket + session management — without
 * binding a port. Call {@link DeathtrackServer.listen} to start serving.
 *
 * Requirements: 7.1–7.8, 8.1–8.8
 */
export function createServer(options: CreateServerOptions = {}): DeathtrackServer {
  const sessionManager = options.sessionManager ?? new SessionManager();
  const router = new MatchmakingRouter(sessionManager);
  const runtimes = new Map<SessionId, SessionRuntime>();

  const runtimeFactory: SessionRuntimeFactory =
    options.runtimeFactory ??
    ((sessionId) => ({ network: new ServerNetworkManager(sessionManager, sessionId) }));

  const httpServer = createHttpServer(buildHttpHandler(router));
  const wss = new WebSocketServer({ server: httpServer });

  wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
    const sessionId = extractSessionId(req.url);
    const participantId = extractParticipantId(req.url);

    // Reject connections that do not name a valid, existing session + slot.
    if (sessionId === null || participantId === null || !sessionManager.getSession(sessionId)) {
      ws.close(1008, 'invalid_session');
      return;
    }

    let runtime = runtimes.get(sessionId);
    if (!runtime) {
      runtime = runtimeFactory(sessionId);
      runtimes.set(sessionId, runtime);
    }
    const { network } = runtime;

    network.addConnection(makeWsConnectionAdapter(ws, participantId));

    ws.on('message', (data: unknown) => {
      const frame = decodeInputFrame(coerceMessageData(data));
      if (frame) network.receiveInput(participantId, frame);
    });

    ws.on('close', () => {
      network.onDisconnect(participantId);
      // If the session emptied out, drop its runtime and stop its loop.
      if (network.connectionCount === 0) {
        runtime?.loop?.stop();
        runtimes.delete(sessionId);
      }
    });

    ws.on('error', () => {
      // Treat a socket error like a disconnect; `close` will also fire.
      network.onDisconnect(participantId);
    });
  });

  return {
    httpServer,
    wss,
    sessionManager,
    router,
    runtimes,
    listen(port: number): Promise<void> {
      return new Promise<void>((resolve) => {
        httpServer.listen(port, () => resolve());
      });
    },
    close(): Promise<void> {
      for (const runtime of runtimes.values()) runtime.loop?.stop();
      runtimes.clear();
      return new Promise<void>((resolve, reject) => {
        wss.close((wssErr?: Error) => {
          httpServer.close((httpErr?: Error) => {
            if (wssErr) return reject(wssErr);
            if (httpErr) return reject(httpErr);
            resolve();
          });
        });
      });
    },
  };
}

/**
 * Convenience wrapper: {@link createServer} + bind the resolved port. Returns the
 * assembled {@link DeathtrackServer} once it is listening.
 *
 * Requirements: 7.1–7.8, 8.1–8.8
 */
export async function startServer(
  options: CreateServerOptions = {},
  port: number = resolvePort(),
): Promise<DeathtrackServer> {
  const server = createServer(options);
  await server.listen(port);
  return server;
}

// ---------------------------------------------------------------------------
// Main-module guard
// ---------------------------------------------------------------------------

/**
 * Whether this module is being executed directly as a script (rather than
 * imported by a test). Compares the resolved path of `import.meta.url` against
 * `process.argv[1]` in a Windows-safe way (mirrors the tools CLI).
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    const modulePath = fileURLToPath(import.meta.url);
    return path.resolve(entry) === path.resolve(modulePath);
  } catch {
    return false;
  }
}

// Start listening only when invoked directly (never when imported by tests).
if (isMainModule()) {
  const port = resolvePort();
  startServer({}, port).then(
    () => {
      console.log(`Deathtrack server listening on port ${port}`);
    },
    (err) => {
      console.error('Failed to start Deathtrack server:', err);
      process.exitCode = 1;
    },
  );
}
