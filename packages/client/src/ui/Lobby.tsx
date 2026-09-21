import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type {
  Session,
  SessionConfig,
  ParticipantInfo,
  Loadout,
  ParticipantId,
} from '@deathtrack/shared';

/**
 * Multiplayer lobby screen (task 17.10).
 *
 * Requirements:
 * - 7.3: a password-protected session prompts the joining player for the
 *   session password before they can participate.
 * - 7.4: when all participants have confirmed their loadout as ready the host
 *   can start the race; if fewer than the minimum configured player count are
 *   ready the race must be prevented from starting.
 * - 7.5: every participant's loadout and ready status is displayed.
 *
 * Following the established client UI convention (see {@link MainMenu},
 * {@link RaceResults} and {@link Settings}), the on-screen game UI is built
 * from PixiJS {@link Container} scene graphs rather than DOM/React trees. The
 * `.tsx` extension is retained only for naming consistency with the spec; no
 * JSX is used.
 *
 * The design separates a pure, GPU-free *lobby model* (the participant rows,
 * the `canStartRace` predicate and the password-prompt decision) from the GPU
 * draw calls. The model half is fully unit-testable in a headless `node`
 * environment ({@link buildLobbyRows}, {@link computeCanStartRace},
 * {@link shouldPromptForPassword}); the {@link Lobby} PixiJS overlay only
 * consumes the already-computed model to draw it. The draw path requires a
 * WebGL context and is validated in the browser, not in unit tests.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The smallest number of participants a session can be configured with
 * (Requirement 7.1: 2–8 player slots). Used as the default minimum ready count
 * for {@link computeCanStartRace} when a caller does not supply an explicit
 * minimum.
 */
export const MIN_SESSION_PLAYERS = 2;

// ---------------------------------------------------------------------------
// Pure lobby-row model (GPU-free, unit-testable)
// ---------------------------------------------------------------------------

/**
 * A single fully-resolved lobby row, ready to render: one per participant,
 * carrying the display name, a human-readable loadout summary and the current
 * ready status. Rows are emitted sorted by ascending participant slot id so the
 * order is deterministic and stable across re-renders.
 */
export interface LobbyRow {
  /** Slot index of the participant (0–7). */
  readonly id: ParticipantId;
  /** Display name shown in the roster. */
  readonly displayName: string;
  /** `true` for AI-controlled participants; used only for presentation. */
  readonly isAI: boolean;
  /** Human-readable one-line summary of the participant's loadout. */
  readonly loadoutSummary: string;
  /** Whether the participant has confirmed readiness. */
  readonly ready: boolean;
}

/**
 * Builds a short human-readable summary of a participant's loadout for display
 * in the roster. A `null` loadout (participant has not configured a car yet)
 * yields `"No loadout"`; otherwise the chassis and the count of equipped
 * weapons are summarised.
 *
 * Pure and GPU-free.
 */
export function summariseLoadout(loadout: Loadout | null): string {
  if (loadout === null) {
    return 'No loadout';
  }
  const weaponCount = Object.values(loadout.weapons).filter(
    (w) => w !== null,
  ).length;
  const weaponLabel = weaponCount === 1 ? 'weapon' : 'weapons';
  return `${loadout.chassisId} · ${weaponCount} ${weaponLabel}`;
}

/**
 * Builds the ordered list of lobby rows from a session's participant map.
 *
 * Pure and free of any PixiJS / WebGL dependency so it can be exercised
 * headlessly. Rows are sorted by ascending participant id (slot order). The
 * input session is not mutated.
 *
 * @param session - The session whose participants to display.
 * @returns One lobby row per participant, sorted by slot id.
 */
export function buildLobbyRows(session: Session): LobbyRow[] {
  const rows: LobbyRow[] = [];
  for (const participant of session.participants.values()) {
    rows.push(rowFromParticipant(participant));
  }
  rows.sort((a, b) => a.id - b.id);
  return rows;
}

/** Maps a single {@link ParticipantInfo} to its display row. */
function rowFromParticipant(participant: ParticipantInfo): LobbyRow {
  return {
    id: participant.id,
    displayName: participant.displayName,
    isAI: participant.isAI,
    loadoutSummary: summariseLoadout(participant.loadout),
    ready: participant.ready,
  };
}

// ---------------------------------------------------------------------------
// Start-race predicate (GPU-free, unit-testable)
// ---------------------------------------------------------------------------

/**
 * Parameters governing whether the start-race button is enabled.
 */
export interface StartRaceParams {
  /** `true` if the local participant is the session host. */
  readonly isHost: boolean;
  /**
   * The minimum number of ready participants required to start the race
   * (Requirement 7.4). Defaults to {@link MIN_SESSION_PLAYERS} when omitted.
   */
  readonly minPlayers?: number;
}

/**
 * Decides whether the host may start the race (Requirement 7.4).
 *
 * The race may start only when **all** of the following hold:
 * - the local participant is the host (`isHost`);
 * - every participant in the session has confirmed readiness; and
 * - the number of participants meets or exceeds the minimum player count.
 *
 * A session with zero participants can never start. Pure and GPU-free.
 *
 * @param session - The session to evaluate.
 * @param params - Host flag and minimum ready count.
 * @returns `true` when the start-race action should be enabled.
 */
export function computeCanStartRace(
  session: Session,
  params: StartRaceParams,
): boolean {
  if (!params.isHost) {
    return false;
  }
  const minPlayers = params.minPlayers ?? MIN_SESSION_PLAYERS;
  const participants = [...session.participants.values()];
  if (participants.length < minPlayers) {
    return false;
  }
  return participants.every((p) => p.ready);
}

// ---------------------------------------------------------------------------
// Password-prompt decision (GPU-free, unit-testable)
// ---------------------------------------------------------------------------

/**
 * Decides whether the lobby should show the session-password prompt
 * (Requirement 7.3).
 *
 * The prompt is shown only when the session is password-protected (its config
 * carries a non-null, non-empty password) and the local participant has not yet
 * supplied the password. Once a password has been submitted (`passwordEntered`)
 * the prompt is hidden, whether or not the session is protected.
 *
 * Pure and GPU-free.
 *
 * @param config - The session configuration.
 * @param passwordEntered - Whether the local player has already submitted a
 *   password for this session.
 * @returns `true` when the password prompt should be displayed.
 */
export function shouldPromptForPassword(
  config: SessionConfig,
  passwordEntered: boolean,
): boolean {
  const isProtected = config.password !== null && config.password.length > 0;
  return isProtected && !passwordEntered;
}

// ---------------------------------------------------------------------------
// Overlay wiring
// ---------------------------------------------------------------------------

/**
 * Callbacks the lobby overlay invokes in response to user actions. Injecting
 * these decouples the screen from the network layer and makes the wiring
 * unit-testable without a renderer.
 */
export interface LobbyHandlers {
  /** Toggle the local participant's ready status. Requirement 7.5 */
  onReadyToggle: () => void;
  /**
   * Start the race. Only invoked while the start-race button is enabled
   * (host + all ready + minimum met). Requirement 7.4
   */
  onStartRace: () => void;
  /**
   * Submit the entered session password for validation. Requirement 7.3
   * @param password - The password the player typed.
   */
  onSubmitPassword: (password: string) => void;
}

/**
 * The full pure view-model for the lobby: the participant rows, whether the
 * start-race button is enabled, and whether the password prompt is shown. This
 * is the single source of truth consumed by the {@link Lobby} overlay and is
 * fully assertable headlessly.
 */
export interface LobbyViewModel {
  readonly rows: LobbyRow[];
  readonly canStartRace: boolean;
  readonly showPasswordPrompt: boolean;
}

/**
 * State that varies per local viewer (as opposed to the shared session state).
 */
export interface LobbyLocalState {
  /** `true` if this client is the session host. */
  readonly isHost: boolean;
  /** Whether the local player has already submitted the session password. */
  readonly passwordEntered: boolean;
  /** Optional minimum ready count override; defaults to {@link MIN_SESSION_PLAYERS}. */
  readonly minPlayers?: number;
}

/**
 * Assembles the complete {@link LobbyViewModel} from a session and the local
 * viewer state. Pure and GPU-free — the overlay and the tests both build the
 * model through this one function so the rendered screen and the assertions
 * stay in sync.
 */
export function buildLobbyViewModel(
  session: Session,
  local: LobbyLocalState,
): LobbyViewModel {
  return {
    rows: buildLobbyRows(session),
    canStartRace: computeCanStartRace(
      session,
      local.minPlayers === undefined
        ? { isHost: local.isHost }
        : { isHost: local.isHost, minPlayers: local.minPlayers },
    ),
    showPasswordPrompt: shouldPromptForPassword(
      session.config,
      local.passwordEntered,
    ),
  };
}

// ---------------------------------------------------------------------------
// PixiJS overlay (browser-only draw path)
// ---------------------------------------------------------------------------

/** Layout constants for the lobby draw. */
const PANEL_WIDTH = 560;
const PADDING = 24;
const HEADER_HEIGHT = 40;
const ROW_HEIGHT = 30;
const BUTTON_HEIGHT = 40;
const BUTTON_GAP = 16;

const READY_COLOR = 0x33cc55;
const NOT_READY_COLOR = 0xcc5533;
const BUTTON_ENABLED_FILL = 0x333344;
const BUTTON_DISABLED_FILL = 0x22222a;
const BUTTON_STROKE = 0xffcc00;

/**
 * Multiplayer lobby overlay. A self-contained PixiJS {@link Container} that
 * draws the participant roster (name + loadout summary + ready status), a
 * ready-up toggle, a host-only start-race button, and — for password-protected
 * sessions — a password prompt.
 *
 * Construction is GPU-free (PixiJS display objects instantiate without a WebGL
 * context); only attaching the container to a live stage and presenting it
 * requires a renderer. The overlay derives its model via
 * {@link buildLobbyViewModel} so the roster, button-enabled state and prompt
 * visibility stay consistent with the pure predicates.
 */
export class Lobby extends Container {
  private readonly model: LobbyViewModel;
  private readonly handlers: LobbyHandlers;
  private passwordText = '';

  /**
   * @param session - The session to display.
   * @param local - Per-viewer state (host flag, password-entered flag, min).
   * @param handlers - Callbacks for ready-toggle, start-race and password.
   */
  constructor(
    session: Session,
    local: LobbyLocalState,
    handlers: LobbyHandlers,
  ) {
    super();
    this.label = 'lobby';
    this.handlers = handlers;
    this.model = buildLobbyViewModel(session, local);
    this.draw(session.config);
  }

  /** The pure view-model backing the rendered lobby (read-only). */
  getViewModel(): LobbyViewModel {
    return this.model;
  }

  private draw(config: SessionConfig): void {
    const rosterHeight = this.model.rows.length * ROW_HEIGHT;
    const panelHeight =
      PADDING * 2 +
      HEADER_HEIGHT +
      rosterHeight +
      BUTTON_GAP +
      BUTTON_HEIGHT;

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
    const title = new Text({ text: `LOBBY — ${config.name}`, style: titleStyle });
    title.position.set(PADDING, PADDING - 6);
    this.addChild(title);

    this.drawRoster();
    this.drawButtons(rosterHeight);

    if (this.model.showPasswordPrompt) {
      this.drawPasswordPrompt(panelHeight);
    }
  }

  private drawRoster(): void {
    const rowStyle = new TextStyle({
      fill: 0xffffff,
      fontFamily: 'monospace',
      fontSize: 14,
    });
    const statusStyleFor = (ready: boolean): TextStyle =>
      new TextStyle({
        fill: ready ? READY_COLOR : NOT_READY_COLOR,
        fontFamily: 'monospace',
        fontSize: 14,
        fontWeight: 'bold',
      });

    const rosterTop = PADDING + HEADER_HEIGHT;
    this.model.rows.forEach((row, index) => {
      const y = rosterTop + index * ROW_HEIGHT;
      const name = row.isAI ? `${row.displayName} (AI)` : row.displayName;
      const nameText = new Text({ text: name, style: rowStyle });
      nameText.position.set(PADDING, y);
      this.addChild(nameText);

      const loadoutText = new Text({ text: row.loadoutSummary, style: rowStyle });
      loadoutText.position.set(PADDING + 180, y);
      this.addChild(loadoutText);

      const status = new Text({
        text: row.ready ? 'READY' : 'NOT READY',
        style: statusStyleFor(row.ready),
      });
      status.position.set(PANEL_WIDTH - PADDING - 100, y);
      this.addChild(status);
    });
  }

  private drawButtons(rosterHeight: number): void {
    const buttonY = PADDING + HEADER_HEIGHT + rosterHeight + BUTTON_GAP;
    const buttonWidth = (PANEL_WIDTH - PADDING * 2 - BUTTON_GAP) / 2;

    const readyButton = this.buildButton(
      'lobby:readyToggle',
      'READY UP',
      PADDING,
      buttonY,
      buttonWidth,
      true,
      this.handlers.onReadyToggle,
    );
    this.addChild(readyButton);

    const startButton = this.buildButton(
      'lobby:startRace',
      'START RACE',
      PADDING + buttonWidth + BUTTON_GAP,
      buttonY,
      buttonWidth,
      this.model.canStartRace,
      this.handlers.onStartRace,
    );
    this.addChild(startButton);
  }

  private buildButton(
    label: string,
    caption: string,
    x: number,
    y: number,
    width: number,
    enabled: boolean,
    onActivate: () => void,
  ): Container {
    const button = new Container();
    button.label = label;
    button.x = x;
    button.y = y;

    const bg = new Graphics();
    bg.label = `${label}:bg`;
    bg.roundRect(0, 0, width, BUTTON_HEIGHT, 6);
    bg.fill(enabled ? BUTTON_ENABLED_FILL : BUTTON_DISABLED_FILL);
    bg.stroke({ width: 2, color: BUTTON_STROKE, alpha: enabled ? 1 : 0.4 });
    button.addChild(bg);

    const captionText = new Text({
      text: caption,
      style: new TextStyle({
        fill: enabled ? 0xffffff : 0x777788,
        fontFamily: 'monospace',
        fontSize: 16,
      }),
    });
    captionText.anchor.set(0.5);
    captionText.x = width / 2;
    captionText.y = BUTTON_HEIGHT / 2;
    button.addChild(captionText);

    if (enabled) {
      button.eventMode = 'static';
      button.cursor = 'pointer';
      button.on('pointertap', onActivate);
    }
    return button;
  }

  private drawPasswordPrompt(panelHeight: number): void {
    const prompt = new Container();
    prompt.label = 'lobby:passwordPrompt';
    prompt.y = panelHeight + BUTTON_GAP;

    const promptStyle = new TextStyle({
      fill: 0xffcc33,
      fontFamily: 'monospace',
      fontSize: 16,
    });
    const promptLabel = new Text({
      text: 'This session is password protected. Enter password:',
      style: promptStyle,
    });
    promptLabel.position.set(0, 0);
    prompt.addChild(promptLabel);

    const submit = this.buildButton(
      'lobby:submitPassword',
      'SUBMIT',
      0,
      28,
      160,
      true,
      () => this.handlers.onSubmitPassword(this.passwordText),
    );
    prompt.addChild(submit);

    this.addChild(prompt);
  }
}
