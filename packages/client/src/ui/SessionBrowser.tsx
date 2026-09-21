import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { SessionSummary, SessionId, TrackId } from '@deathtrack/shared';

/**
 * Session browser screen (task 17.9).
 *
 * Requirement 7.2: players discover and join open sessions via a browser that
 * lists available sessions by name, track, and current/max player count. A full
 * session (current >= max) must be flagged and cannot be joined.
 *
 * Following the established client UI convention (see MainMenu.tsx,
 * RaceResults.tsx, HUD.tsx, Settings.tsx), the on-screen UI is built from PixiJS
 * {@link Container} scene graphs, not DOM/React. The `.tsx` extension is kept
 * for consistency with the task/spec naming, but no JSX is used.
 *
 * The pure, GPU-free logic — mapping `SessionSummary`s to display rows,
 * deciding join enablement, and issuing the REST calls through an injected HTTP
 * client — is factored into exported functions so it can be unit-tested
 * headlessly. The PixiJS overlay class ({@link SessionBrowser}) is a thin layer
 * that only consumes the already-computed rows to draw them; its draw path
 * requires a WebGL context and is validated in the browser, not in tests.
 */

// ---------------------------------------------------------------------------
// HTTP client abstraction (injected so the browser is testable offline)
// ---------------------------------------------------------------------------

/**
 * The response body of `GET /sessions`, matching the server's
 * `MatchmakingRouter.listSessions`: an object with a `sessions` array.
 */
export interface ListSessionsResponse {
  readonly sessions: readonly SessionSummary[];
}

/**
 * Body accepted by `POST /sessions/:id/join`, matching the server's
 * `extractJoinPlayer`: a display name plus an optional password.
 */
export interface JoinRequestBody {
  readonly displayName: string;
  /** Password for protected sessions; `null`/omitted for open sessions. */
  readonly password?: string | null;
}

/**
 * Minimal HTTP client the session browser depends on. Injecting this decouples
 * the browser from any concrete transport (fetch, XHR, a test double) so the
 * pure logic can be exercised without a live server or network.
 */
export interface SessionBrowserClient {
  /** Fetches the list of open sessions from `GET /sessions`. */
  listSessions(): Promise<ListSessionsResponse>;
  /**
   * Joins the session with `sessionId` via `POST /sessions/:id/join`, passing
   * the join body. Resolves with the parsed success body (opaque to the
   * browser) or rejects on failure.
   */
  joinSession(sessionId: SessionId, body: JoinRequestBody): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// fetch-backed client
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
 * Builds a {@link SessionBrowserClient} backed by a `fetch`-like function and a
 * base URL. Extracted as a pure factory so it can be unit-tested with a fake
 * `fetch` — no real network is ever touched in tests.
 *
 * @param fetchImpl - A `fetch`-compatible function.
 * @param baseUrl - Server origin, e.g. `http://localhost:8080`. A trailing
 *   slash is tolerated.
 */
export function createFetchSessionBrowserClient(
  fetchImpl: FetchLike,
  baseUrl = '',
): SessionBrowserClient {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;

  return {
    async listSessions(): Promise<ListSessionsResponse> {
      const res = await fetchImpl(`${base}/sessions`, { method: 'GET' });
      if (!res.ok) {
        throw new Error(`GET /sessions failed with status ${res.status}`);
      }
      const body = (await res.json()) as ListSessionsResponse;
      return body;
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
  };
}

// ---------------------------------------------------------------------------
// Pure row model (GPU-free, unit-testable)
// ---------------------------------------------------------------------------

/**
 * A single fully-resolved row of the session browser, ready to render or to
 * drive interaction. Derived from a {@link SessionSummary}.
 */
export interface SessionRow {
  /** Session id, used as the target of the join call. */
  readonly id: SessionId;
  /** Session display name. */
  readonly name: string;
  /** Track being raced. */
  readonly track: TrackId;
  /** Current number of human participants. */
  readonly current: number;
  /** Maximum number of human participants. */
  readonly max: number;
  /** `true` when `current >= max`: the session is full and cannot be joined. */
  readonly isFull: boolean;
  /** `true` when the session requires a password to join. */
  readonly hasPassword: boolean;
}

/**
 * Returns `true` when the session has room for another player. A session is
 * full — and therefore not joinable — once its current player count reaches its
 * maximum (Requirement 7.2).
 */
export function isSessionFull(current: number, max: number): boolean {
  return current >= max;
}

/**
 * Whether the join action should be enabled for a row. Only open (non-full)
 * sessions can be joined; full sessions have their join disabled (Requirement
 * 7.2).
 */
export function canJoinSession(row: SessionRow): boolean {
  return !row.isFull;
}

/**
 * Maps a single {@link SessionSummary} to a {@link SessionRow}, computing the
 * `isFull` flag from the current/max counts.
 */
export function toSessionRow(summary: SessionSummary): SessionRow {
  return {
    id: summary.id,
    name: summary.name,
    track: summary.trackId,
    current: summary.currentPlayers,
    max: summary.maxPlayers,
    isFull: isSessionFull(summary.currentPlayers, summary.maxPlayers),
    hasPassword: summary.hasPassword,
  };
}

/**
 * Builds the ordered list of display rows from the raw `GET /sessions`
 * summaries. Pure and free of any PixiJS/WebGL dependency, so it can be
 * exercised headlessly. The input order is preserved and the input is not
 * mutated.
 */
export function buildSessionRows(
  summaries: readonly SessionSummary[],
): SessionRow[] {
  return summaries.map(toSessionRow);
}

/** Formats the player count for display, e.g. `3/8` or `8/8 FULL`. */
export function formatPlayerCount(row: SessionRow): string {
  const base = `${row.current}/${row.max}`;
  return row.isFull ? `${base} FULL` : base;
}

/**
 * Attempts to join the given session via the injected client, enforcing the
 * "full sessions are not joinable" rule (Requirement 7.2) before making any
 * network call.
 *
 * Pure with respect to the DOM: it only touches the injected client, so it is
 * unit-testable with a fake client. Returns the client's success payload on
 * success.
 *
 * @throws {Error} when the row is full (the join is refused without calling the
 *   client) or when the client's join call rejects.
 */
export async function joinSessionRow(
  client: SessionBrowserClient,
  row: SessionRow,
  body: JoinRequestBody,
): Promise<unknown> {
  if (!canJoinSession(row)) {
    throw new Error(`Session ${row.id} is full and cannot be joined.`);
  }
  return client.joinSession(row.id, body);
}

/**
 * Fetches the open-session list through the injected client and maps it to
 * display rows. Pure with respect to the DOM.
 */
export async function fetchSessionRows(
  client: SessionBrowserClient,
): Promise<SessionRow[]> {
  const { sessions } = await client.listSessions();
  return buildSessionRows(sessions);
}

// ---------------------------------------------------------------------------
// PixiJS overlay (browser-only draw path)
// ---------------------------------------------------------------------------

/** Layout constants for the session table draw. */
const ROW_HEIGHT = 30;
const HEADER_HEIGHT = 46;
const PADDING = 24;
const PANEL_WIDTH = 600;

/** Column x-offsets (relative to the panel's left padding). */
const COL_NAME = 0;
const COL_TRACK = 260;
const COL_PLAYERS = 440;
const COL_JOIN = 520;

/**
 * Callbacks the session browser overlay invokes in response to interaction.
 * Injected so the overlay is decoupled from the application state machine.
 */
export interface SessionBrowserHandlers {
  /**
   * Invoked when the player activates the join button of a joinable row. Full
   * rows never fire this callback.
   */
  onJoin: (row: SessionRow) => void;
}

/**
 * Session browser overlay. A self-contained PixiJS {@link Container} that draws
 * a table of open sessions and wires a join button per joinable row.
 *
 * Construction is GPU-free (PixiJS display objects instantiate without a WebGL
 * context); only attaching the container to a live stage and presenting it
 * requires a renderer. The overlay derives its rows via {@link buildSessionRows}
 * so the "full is not joinable" rule stays consistent with the pure logic.
 */
export class SessionBrowser extends Container {
  private readonly sessionRows: SessionRow[];
  private readonly handlers: SessionBrowserHandlers;

  /**
   * @param summaries - Session summaries from `GET /sessions`.
   * @param handlers - Interaction callbacks (join).
   */
  constructor(
    summaries: readonly SessionSummary[],
    handlers: SessionBrowserHandlers,
  ) {
    super();
    this.label = 'sessionBrowser';
    this.sessionRows = buildSessionRows(summaries);
    this.handlers = handlers;
    this.draw();
  }

  /** The rendered rows, in display order. Exposed for inspection. */
  get rows(): readonly SessionRow[] {
    return this.sessionRows;
  }

  private draw(): void {
    const bodyHeight = Math.max(1, this.sessionRows.length) * ROW_HEIGHT;
    const panelHeight = HEADER_HEIGHT + bodyHeight + PADDING * 2;

    const panel = new Graphics();
    panel
      .roundRect(0, 0, PANEL_WIDTH, panelHeight, 8)
      .fill({ color: 0x0a0a12, alpha: 0.92 })
      .stroke({ color: 0x3355aa, width: 2 });
    this.addChild(panel);

    const titleStyle = new TextStyle({
      fill: 0xffcc33,
      fontFamily: 'monospace',
      fontSize: 22,
      fontWeight: 'bold',
    });
    const title = new Text({ text: 'JOIN SESSION', style: titleStyle });
    title.position.set(PADDING, PADDING - 6);
    this.addChild(title);

    const headerStyle = new TextStyle({
      fill: 0x8899cc,
      fontFamily: 'monospace',
      fontSize: 13,
      fontWeight: 'bold',
    });
    const headerY = PADDING + HEADER_HEIGHT - 20;
    this.addColumnLabels(headerStyle, headerY, {
      name: 'SESSION',
      track: 'TRACK',
      players: 'PLAYERS',
      join: '',
    });

    const rowStyle = new TextStyle({
      fill: 0xffffff,
      fontFamily: 'monospace',
      fontSize: 14,
    });
    const fullStyle = new TextStyle({
      fill: 0xff6666,
      fontFamily: 'monospace',
      fontSize: 14,
    });

    this.sessionRows.forEach((row, index) => {
      const y = PADDING + HEADER_HEIGHT + index * ROW_HEIGHT;
      this.addColumnLabels(row.isFull ? fullStyle : rowStyle, y, {
        name: row.hasPassword ? `${row.name} (locked)` : row.name,
        track: String(row.track),
        players: formatPlayerCount(row),
        join: '',
      });
      this.addChild(this.buildJoinButton(row, y));
    });
  }

  /**
   * Builds the per-row join affordance. Full rows render a disabled, greyed-out
   * label; joinable rows render an interactive button wired to `onJoin`.
   */
  private buildJoinButton(row: SessionRow, y: number): Container {
    const button = new Container();
    button.label = `sessionBrowser:join:${row.id}`;
    button.position.set(PADDING + COL_JOIN, y - 4);

    const joinable = canJoinSession(row);
    const bg = new Graphics();
    bg.roundRect(0, 0, 60, 22, 4)
      .fill({ color: joinable ? 0x225533 : 0x333333, alpha: 0.9 })
      .stroke({ color: joinable ? 0x33aa55 : 0x555555, width: 1 });
    button.addChild(bg);

    const labelStyle = new TextStyle({
      fill: joinable ? 0xffffff : 0x888888,
      fontFamily: 'monospace',
      fontSize: 12,
      fontWeight: 'bold',
    });
    const label = new Text({
      text: joinable ? 'JOIN' : 'FULL',
      style: labelStyle,
    });
    label.anchor.set(0.5);
    label.position.set(30, 11);
    button.addChild(label);

    if (joinable) {
      button.eventMode = 'static';
      button.cursor = 'pointer';
      button.on('pointertap', () => this.handlers.onJoin(row));
    }

    return button;
  }

  private addColumnLabels(
    style: TextStyle,
    y: number,
    values: { name: string; track: string; players: string; join: string },
  ): void {
    const cols: Array<[number, string]> = [
      [COL_NAME, values.name],
      [COL_TRACK, values.track],
      [COL_PLAYERS, values.players],
      [COL_JOIN, values.join],
    ];
    for (const [dx, text] of cols) {
      if (text.length === 0) continue;
      const label = new Text({ text, style });
      label.position.set(PADDING + dx, y);
      this.addChild(label);
    }
  }
}
