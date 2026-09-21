import { Container, Graphics, Text } from 'pixi.js';
import type { TextStyleOptions } from 'pixi.js';
import type {
  ParticipantId,
  PausedEvent,
  ResumedEvent,
} from '@deathtrack/shared';

/**
 * Pause menu overlay (task 17.5).
 *
 * Following the established client UI convention (see
 * {@link ../renderer/Renderer.ts} and the sibling {@link ./MainMenu.tsx} /
 * {@link ./RaceResults.tsx}), the on-screen game UI is built from PixiJS
 * {@link Container} scene graphs rather than DOM/React trees. The `.tsx`
 * extension is retained for consistency with the task/spec naming, but no JSX
 * is used — the screens are PixiJS overlays composed of {@link Container},
 * {@link Graphics} and {@link Text}.
 *
 * The design separates a pure, GPU-free *button model* (labels, ids, layout
 * math and handler wiring) from the GPU draw calls, so the model can be
 * unit-tested headlessly while the actual pixel drawing is validated in a
 * browser.
 *
 * ## Pause semantics (Requirement 11.5)
 *
 * When a Player pauses a Race the game shows a pause menu offering **Resume**
 * and **Quit** (to the main menu). Crucially, pausing is *local* to the pausing
 * Player:
 *
 * - In a **multiplayer** Session the simulation is authoritative-server, so it
 *   MUST keep running for every remote Participant. The pausing client does not
 *   halt anything globally; instead it emits a *pause notification*
 *   ({@link PausedEvent}) so all other Participants are told the Player paused
 *   (and a matching {@link ResumedEvent} when they resume).
 * - In **single-player** the same overlay may pause the local simulation, but
 *   that is the caller's decision — the menu itself never stops any simulation.
 *
 * To keep the menu decoupled from both the app state machine and the
 * multiplayer transport, all behaviour is expressed through injected callbacks
 * ({@link PauseMenuHandlers}). The menu only *calls* callbacks; it deliberately
 * contains no simulation or clock control, guaranteeing it can never freeze
 * remote Participants.
 */

// ---------------------------------------------------------------------------
// Pure button model (GPU-free, unit-testable)
// ---------------------------------------------------------------------------

/**
 * The two pause-menu actions, in top-to-bottom display order. This ordering is
 * the single source of truth used both by the pure layout model and by the
 * rendered screen, keeping the two in sync.
 */
export const PAUSE_MENU_ACTIONS = ['resume', 'quit'] as const;

/** Identifier for a single pause-menu action / button. */
export type PauseMenuAction = (typeof PAUSE_MENU_ACTIONS)[number];

/**
 * Human-readable button labels, keyed by {@link PauseMenuAction}. These are the
 * captions required by requirement 11.5 (resume / quit to main menu).
 */
export const PAUSE_MENU_LABELS: Record<PauseMenuAction, string> = {
  resume: 'Resume',
  quit: 'Quit to Main Menu',
};

/**
 * Behaviour callbacks for the pause menu. Injecting these decouples the menu
 * from the application state machine and the multiplayer transport, and makes
 * the wiring unit-testable without a renderer.
 *
 * The multiplayer controller (task 22.x) is expected to wire {@link onResume}
 * and {@link onQuit} — and, most importantly, {@link onPause} — so that opening
 * the menu broadcasts a {@link PausedEvent} to the session and resuming
 * broadcasts a {@link ResumedEvent}, without ever stopping the authoritative
 * simulation for remote Participants.
 */
export interface PauseMenuHandlers {
  /**
   * Invoked once when the pause menu opens. This is the *pause notification*
   * hook: in multiplayer the controller broadcasts a {@link PausedEvent} to the
   * session here; in single-player it may pause the local clock. The menu does
   * not stop any simulation itself.
   */
  onPause: () => void;
  /**
   * Invoked when the Player activates **Resume**. The controller broadcasts a
   * {@link ResumedEvent} (multiplayer) and/or unpauses the local clock
   * (single-player) and dismisses the overlay.
   */
  onResume: () => void;
  /**
   * Invoked when the Player activates **Quit**. The controller leaves the race
   * and returns to the main menu.
   */
  onQuit: () => void;
}

/** Maps each action to the handler property that services it. */
const HANDLER_KEY: Record<PauseMenuAction, keyof PauseMenuHandlers> = {
  resume: 'onResume',
  quit: 'onQuit',
};

/**
 * Layout parameters for arranging the vertical stack of buttons. All values are
 * in logical pixels. Defaults produce a centred column suitable for a 640×480
 * playfield, but every field can be overridden.
 */
export interface PauseMenuLayout {
  /** X coordinate of the left edge of every button. */
  x: number;
  /** Y coordinate of the top edge of the first button. */
  y: number;
  /** Button width. */
  buttonWidth: number;
  /** Button height. */
  buttonHeight: number;
  /** Vertical gap between consecutive buttons. */
  gap: number;
}

/** Default layout: a centred column of two buttons. */
export const DEFAULT_PAUSE_MENU_LAYOUT: PauseMenuLayout = {
  x: 220,
  y: 210,
  buttonWidth: 200,
  buttonHeight: 40,
  gap: 16,
};

/** An axis-aligned rectangular hit region, in logical pixels. */
export interface HitRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A pure description of a single button: which action it represents, its label,
 * its computed hit region, and the handler-invoking callback. Contains no
 * PixiJS display objects, so it can be built and asserted on headlessly.
 */
export interface PauseMenuButtonModel {
  action: PauseMenuAction;
  label: string;
  region: HitRegion;
  /** Invokes the handler bound to this button's action. */
  activate: () => void;
}

/**
 * Returns `true` when the point (`px`, `py`) falls inside `region`. Uses a
 * half-open interval on the far edges so adjacent regions never both claim a
 * boundary pixel.
 */
export function isInsideRegion(region: HitRegion, px: number, py: number): boolean {
  return (
    px >= region.x &&
    px < region.x + region.width &&
    py >= region.y &&
    py < region.y + region.height
  );
}

/**
 * Builds the pure button model for the pause menu: one entry per action in
 * {@link PAUSE_MENU_ACTIONS}, with layout math applied and each `activate`
 * wired to the matching handler in `handlers`.
 *
 * This function performs no GPU work and constructs no display objects, so it
 * is fully unit-testable in a headless environment. Note it does **not** invoke
 * `onPause`: opening the menu is a distinct lifecycle event (see
 * {@link makePauseNotification} and {@link PauseMenu}'s constructor), not a
 * button press.
 *
 * @param handlers - Behaviour callbacks to wire to each button.
 * @param layout - Optional layout overrides; defaults to
 *   {@link DEFAULT_PAUSE_MENU_LAYOUT}.
 */
export function createPauseMenuButtonModels(
  handlers: PauseMenuHandlers,
  layout: PauseMenuLayout = DEFAULT_PAUSE_MENU_LAYOUT,
): PauseMenuButtonModel[] {
  return PAUSE_MENU_ACTIONS.map((action, index) => {
    const region: HitRegion = {
      x: layout.x,
      y: layout.y + index * (layout.buttonHeight + layout.gap),
      width: layout.buttonWidth,
      height: layout.buttonHeight,
    };
    const handlerKey = HANDLER_KEY[action];
    return {
      action,
      label: PAUSE_MENU_LABELS[action],
      region,
      activate: () => handlers[handlerKey](),
    };
  });
}

// ---------------------------------------------------------------------------
// Pause / resume notifications (shared network events)
// ---------------------------------------------------------------------------

/**
 * Builds the {@link PausedEvent} a client broadcasts to the session when the
 * given Participant opens their pause menu (Requirement 11.5). Pure and
 * GPU-free; the multiplayer controller sends the returned event over the wire.
 *
 * @param participantId - Slot index of the Participant who paused.
 */
export function makePauseNotification(participantId: ParticipantId): PausedEvent {
  return { type: 'paused', participantId };
}

/**
 * Builds the {@link ResumedEvent} a client broadcasts to the session when the
 * given Participant resumes from their pause menu (Requirement 11.5).
 *
 * @param participantId - Slot index of the Participant who resumed.
 */
export function makeResumeNotification(participantId: ParticipantId): ResumedEvent {
  return { type: 'resumed', participantId };
}

// ---------------------------------------------------------------------------
// PixiJS overlay (browser-only draw path)
// ---------------------------------------------------------------------------

/** Visual styling for the rendered menu. */
const TITLE_STYLE: TextStyleOptions = {
  fill: 0xffcc00,
  fontFamily: 'monospace',
  fontSize: 32,
  fontWeight: 'bold',
};

const LABEL_STYLE: TextStyleOptions = {
  fill: 0xffffff,
  fontFamily: 'monospace',
  fontSize: 18,
};

const SCRIM_FILL = 0x000000;
const SCRIM_ALPHA = 0.6;
const SCRIM_WIDTH = 640;
const SCRIM_HEIGHT = 480;

const BUTTON_FILL = 0x333344;
const BUTTON_HOVER_FILL = 0x555577;
const BUTTON_STROKE = 0xffcc00;

/**
 * The PixiJS pause-menu overlay. Construct it with the behaviour handlers, add
 * {@link PauseMenu.view} to a stage/HUD layer, and the two interactive buttons
 * will invoke the corresponding handler on click.
 *
 * Opening the menu (construction) fires {@link PauseMenuHandlers.onPause}
 * exactly once — this is where the multiplayer controller broadcasts the pause
 * notification to the session. The overlay never stops any simulation itself,
 * so remote Participants keep racing on the authoritative server.
 *
 * The container and all child display objects (Graphics, Text) construct
 * without a WebGL context; only actually rendering them to the screen requires
 * a GPU, which is exercised in the browser rather than in unit tests.
 */
export class PauseMenu {
  /** Root container to add to a parent stage or HUD layer. */
  readonly view: Container;

  private readonly models: PauseMenuButtonModel[];
  private readonly buttons: Container[] = [];

  constructor(
    handlers: PauseMenuHandlers,
    layout: PauseMenuLayout = DEFAULT_PAUSE_MENU_LAYOUT,
  ) {
    this.view = new Container();
    this.view.label = 'pauseMenu';
    this.models = createPauseMenuButtonModels(handlers, layout);

    // Dimming scrim behind the menu so the still-running race reads as paused
    // for this local Player without hiding that it continues underneath.
    const scrim = new Graphics();
    scrim.label = 'pauseMenu:scrim';
    scrim.rect(0, 0, SCRIM_WIDTH, SCRIM_HEIGHT).fill({
      color: SCRIM_FILL,
      alpha: SCRIM_ALPHA,
    });
    this.view.addChild(scrim);

    const title = new Text({ text: 'PAUSED', style: TITLE_STYLE });
    title.label = 'pauseMenu:title';
    title.x = layout.x;
    title.y = Math.max(0, layout.y - 80);
    this.view.addChild(title);

    for (const model of this.models) {
      this.view.addChild(this.buildButton(model));
    }

    // Opening the menu is the pause notification hook (Requirement 11.5): the
    // controller broadcasts a PausedEvent here. Fire it last so the overlay is
    // fully constructed before any listener reacts.
    handlers.onPause();
  }

  /** The pure button models backing the rendered buttons (read-only view). */
  getButtonModels(): readonly PauseMenuButtonModel[] {
    return this.models;
  }

  /** Builds a single interactive button display object from its model. */
  private buildButton(model: PauseMenuButtonModel): Container {
    const button = new Container();
    button.label = `pauseMenu:${model.action}`;
    button.x = model.region.x;
    button.y = model.region.y;
    button.eventMode = 'static';
    button.cursor = 'pointer';

    const bg = new Graphics();
    bg.label = `${button.label}:bg`;
    const paint = (fill: number): void => {
      bg.clear();
      bg.roundRect(0, 0, model.region.width, model.region.height, 6);
      bg.fill(fill);
      bg.stroke({ width: 2, color: BUTTON_STROKE });
    };
    paint(BUTTON_FILL);
    button.addChild(bg);

    const label = new Text({ text: model.label, style: LABEL_STYLE });
    label.label = `${button.label}:label`;
    // Centre the label within the button.
    label.anchor.set(0.5);
    label.x = model.region.width / 2;
    label.y = model.region.height / 2;
    button.addChild(label);

    button.on('pointertap', model.activate);
    button.on('pointerover', () => paint(BUTTON_HOVER_FILL));
    button.on('pointerout', () => paint(BUTTON_FILL));

    this.buttons.push(button);
    return button;
  }

  /** Tears down the overlay and releases its display objects. */
  destroy(): void {
    this.view.destroy({ children: true });
    this.buttons.length = 0;
  }
}
