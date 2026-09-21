import { Container, Graphics, Text } from 'pixi.js';
import type { TextStyleOptions } from 'pixi.js';

/**
 * Main menu screen.
 *
 * Following the established client UI convention (see
 * `packages/client/src/renderer/Renderer.ts`), the on-screen game UI is built
 * from PixiJS {@link Container} scene graphs rather than DOM/React trees. The
 * `.tsx` extension is retained for consistency with the task/spec naming, but
 * no JSX is used — the screens are PixiJS overlays composed of
 * {@link Container}, {@link Graphics} and {@link Text}.
 *
 * The design separates a pure, GPU-free *button model* (labels, ids, layout
 * math and handler wiring) from the GPU draw calls. This mirrors the
 * `createLayers` / `DRAW_LAYER_NAMES` split in the renderer: the model can be
 * unit-tested headlessly, while the actual pixel drawing is validated in a
 * browser.
 *
 * Requirement 11.3: the main menu provides options to start Career Mode, host
 * a multiplayer Session, join a multiplayer Session, view high scores, and
 * access settings.
 */

/**
 * The five main-menu actions, in top-to-bottom display order. This ordering is
 * the single source of truth used both by the pure layout model and by the
 * rendered screen, keeping the two in sync.
 */
export const MAIN_MENU_ACTIONS = [
  'startCareer',
  'hostSession',
  'joinSession',
  'viewHighScores',
  'settings',
] as const;

/** Identifier for a single main-menu action / button. */
export type MainMenuAction = (typeof MAIN_MENU_ACTIONS)[number];

/**
 * Human-readable button labels, keyed by {@link MainMenuAction}. These are the
 * exact captions required by requirement 11.3.
 */
export const MAIN_MENU_LABELS: Record<MainMenuAction, string> = {
  startCareer: 'Start Career',
  hostSession: 'Host Session',
  joinSession: 'Join Session',
  viewHighScores: 'View High Scores',
  settings: 'Settings',
};

/**
 * Navigation callbacks invoked when a main-menu button is activated. Injecting
 * these decouples the menu from the application state machine and makes the
 * wiring unit-testable without a renderer.
 */
export interface MainMenuHandlers {
  /** Begin Career Mode. */
  onStartCareer: () => void;
  /** Host a new multiplayer session. */
  onHostSession: () => void;
  /** Join an existing multiplayer session. */
  onJoinSession: () => void;
  /** View the high-score table. */
  onViewHighScores: () => void;
  /** Open the settings screen. */
  onSettings: () => void;
}

/** Maps each action to the handler property that services it. */
const HANDLER_KEY: Record<MainMenuAction, keyof MainMenuHandlers> = {
  startCareer: 'onStartCareer',
  hostSession: 'onHostSession',
  joinSession: 'onJoinSession',
  viewHighScores: 'onViewHighScores',
  settings: 'onSettings',
};

/**
 * Layout parameters for arranging the vertical stack of buttons. All values are
 * in logical pixels. Defaults produce a centred column suitable for a 640×480
 * playfield, but every field can be overridden.
 */
export interface MainMenuLayout {
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

/** Default layout: a centred column of five buttons. */
export const DEFAULT_MAIN_MENU_LAYOUT: MainMenuLayout = {
  x: 220,
  y: 160,
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
export interface MainMenuButtonModel {
  action: MainMenuAction;
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
 * Builds the pure button model for the main menu: one entry per action in
 * {@link MAIN_MENU_ACTIONS}, with layout math applied and each `activate`
 * wired to the matching handler in `handlers`.
 *
 * This function performs no GPU work and constructs no display objects, so it
 * is fully unit-testable in a headless environment.
 *
 * @param handlers - Navigation callbacks to wire to each button.
 * @param layout - Optional layout overrides; defaults to
 *   {@link DEFAULT_MAIN_MENU_LAYOUT}.
 */
export function createMainMenuButtonModels(
  handlers: MainMenuHandlers,
  layout: MainMenuLayout = DEFAULT_MAIN_MENU_LAYOUT,
): MainMenuButtonModel[] {
  return MAIN_MENU_ACTIONS.map((action, index) => {
    const region: HitRegion = {
      x: layout.x,
      y: layout.y + index * (layout.buttonHeight + layout.gap),
      width: layout.buttonWidth,
      height: layout.buttonHeight,
    };
    const handlerKey = HANDLER_KEY[action];
    return {
      action,
      label: MAIN_MENU_LABELS[action],
      region,
      activate: () => handlers[handlerKey](),
    };
  });
}

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

const BUTTON_FILL = 0x333344;
const BUTTON_HOVER_FILL = 0x555577;
const BUTTON_STROKE = 0xffcc00;

/**
 * The PixiJS main-menu screen. Construct it with the navigation handlers, add
 * {@link MainMenu.view} to a stage/HUD layer, and the five interactive buttons
 * will invoke the corresponding handler on click.
 *
 * The container and all child display objects (Graphics, Text) construct
 * without a WebGL context; only actually rendering them to the screen requires
 * a GPU, which is exercised in the browser rather than in unit tests.
 */
export class MainMenu {
  /** Root container to add to a parent stage or HUD layer. */
  readonly view: Container;

  private readonly models: MainMenuButtonModel[];
  private readonly buttons: Container[] = [];

  constructor(
    handlers: MainMenuHandlers,
    layout: MainMenuLayout = DEFAULT_MAIN_MENU_LAYOUT,
  ) {
    this.view = new Container();
    this.view.label = 'mainMenu';
    this.models = createMainMenuButtonModels(handlers, layout);

    const title = new Text({ text: 'DEATHTRACK', style: TITLE_STYLE });
    title.label = 'mainMenu:title';
    title.x = layout.x;
    title.y = Math.max(0, layout.y - 80);
    this.view.addChild(title);

    for (const model of this.models) {
      this.view.addChild(this.buildButton(model));
    }
  }

  /** The pure button models backing the rendered buttons (read-only view). */
  getButtonModels(): readonly MainMenuButtonModel[] {
    return this.models;
  }

  /** Builds a single interactive button display object from its model. */
  private buildButton(model: MainMenuButtonModel): Container {
    const button = new Container();
    button.label = `mainMenu:${model.action}`;
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

  /** Tears down the screen and releases its display objects. */
  destroy(): void {
    this.view.destroy({ children: true });
    this.buttons.length = 0;
  }
}
