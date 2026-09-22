// packages/client/src/App.tsx
//
// Client entry point (task 19.3).
//
// Top-level wiring of the already-complete subsystems into a running game:
//   - PixiJS Application (via the Renderer)
//   - AssetLoader (@deathtrack/shared)
//   - AudioSystem
//   - NetworkManager
// driven by the pure application state machine in `appState.ts`
// (mainMenu → carConfig → lobby → race → results → career).
//
// Following the established client convention (see MainMenu.tsx,
// BrowserWarning.tsx, Renderer.ts), the on-screen UI is built from PixiJS
// `Container` overlays, NOT React/DOM trees. The `.tsx` extension is retained
// only for consistency with the task/spec naming; no JSX is used.
//
// TESTABILITY (critical): `Application.init` requires a WebGL context and can
// only run in a real browser. This module therefore splits into two halves:
//
//   1. The `App` class — pure orchestration. It owns the state machine, swaps
//      the active overlay via an injected `ScreenHost`, and starts/stops the
//      loop via injected callbacks. Every heavy subsystem is INJECTED, so the
//      orchestration can be unit-tested headlessly with fakes.
//
//   2. `bootstrap()` — the thin, browser-only glue that actually constructs the
//      real PixiJS Application, AssetLoader, AudioSystem and NetworkManager,
//      mounts the canvas into the DOM, and starts the render loop. It is NOT
//      exercised by unit tests (it needs a GPU + DOM).
//
// Requirements: 13.1 (modern browser), 13.3 (menu → race navigation), 13.6
// (block the loop on an unsupported browser).

import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import {
  BinaryAssetLoader,
  CHASSIS_CATALOGUE,
  COMPONENT_CATALOGUE,
  WEAPON_CATALOGUE,
  INITIAL_CAREER_MONEY,
  emptyLoadout,
  type Loadout,
  type TrackDef,
  type TrackId,
} from '@deathtrack/shared';
import {
  AppStateMachine,
  decideStartup,
  isLoopActiveState,
  screenForState,
  type AppEvent,
  type AppState,
  type ScreenId,
  type StartupDecision,
} from './appState.js';
import { HttpAssetSource } from './assets/HttpAssetSource.js';
import { layoutTrackPreview } from './renderer/trackPreview.js';
import { CarConfig } from './ui/CarConfig.js';
import { Shop } from './ui/Shop.js';
import {
  currentUserAgent,
  BrowserWarning,
} from './ui/BrowserWarning.js';
import { MainMenu } from './ui/MainMenu.js';
import { HUD, buildHudModel } from './ui/HUD.js';
import { RaceResults } from './ui/RaceResults.js';
import { InputHandler } from './InputHandler.js';
import { RaceSession } from './race/RaceSession.js';
import { CareerSession, CAREER_PRIZE_TABLE, type CareerPurchase } from './career/CareerSession.js';
import type { RenderState as RenderStateSnapshot } from './renderer/renderState.js';

// ---------------------------------------------------------------------------
// Injected collaborators (structural interfaces so fakes suffice in tests)
// ---------------------------------------------------------------------------

/**
 * Abstraction over the PixiJS stage that the App swaps overlays on. Backed in
 * the browser by `renderer.application.stage` (a `Container`); in tests by a
 * plain fake that records add/remove calls.
 */
export interface ScreenHost {
  /** Add an overlay to the stage. */
  addOverlay(overlay: Container): void;
  /** Remove an overlay from the stage. */
  removeOverlay(overlay: Container): void;
}

/**
 * Controls the game/render loop lifecycle. Backed in the browser by
 * `GameLoop.start()/stop()`; the App calls these when entering/leaving the
 * `race` state (see {@link isLoopActiveState}).
 */
export interface LoopController {
  start(): void;
  stop(): void;
}

/**
 * Produces the PixiJS overlay for a given screen. One factory per screen id;
 * the App calls it lazily the first time a screen is shown and caches the
 * result. Returning a `Container` keeps the App decoupled from each overlay's
 * concrete constructor shape (some overlays extend `Container`, others expose a
 * `.view` container — the factory adapts either into a `Container`).
 */
export type OverlayFactory = () => Container;

/** The set of overlay factories, one per {@link ScreenId}. */
export type OverlayFactories = Record<ScreenId, OverlayFactory>;

/** Everything the {@link App} needs, all injectable for headless testing. */
export interface AppDependencies {
  /** Stage abstraction to mount/unmount overlays on. */
  host: ScreenHost;
  /** Overlay factory per screen. */
  overlays: OverlayFactories;
  /** Loop lifecycle controller (started only in the `race` state). */
  loop: LoopController;
  /**
   * The startup decision (browser support gate). Defaults to evaluating the
   * live user agent; inject a value in tests.
   */
  startup?: StartupDecision;
  /**
   * Factory for the browser-unsupported overlay, shown instead of any screen
   * when {@link StartupDecision.blockStart} is `true`. Defaults to a
   * {@link BrowserWarning}; injectable so tests need no PixiJS draw path.
   */
  browserWarningFactory?: (decision: StartupDecision) => Container;
}

// ---------------------------------------------------------------------------
// App orchestrator
// ---------------------------------------------------------------------------

/**
 * The application orchestrator. Drives the pure {@link AppStateMachine},
 * swapping the active PixiJS overlay on the injected {@link ScreenHost} as the
 * state changes and starting/stopping the loop for the `race` state.
 *
 * Construction is GPU-free and DOM-free — everything heavy is injected — so the
 * navigation flow is fully unit-testable with fakes.
 */
export class App {
  private readonly machine: AppStateMachine;
  private readonly deps: AppDependencies;
  private readonly startup: StartupDecision;

  /** Lazily-created overlays, cached by screen id. */
  private readonly overlayCache = new Map<ScreenId, Container>();
  /** The overlay currently mounted on the host, or `null`. */
  private activeOverlay: Container | null = null;
  /** `true` once the loop has been started for the current race state. */
  private loopRunning = false;
  /** `true` when the browser gate blocked startup (loop must never run). */
  private blocked = false;
  private started = false;

  constructor(deps: AppDependencies) {
    this.deps = deps;
    this.startup = deps.startup ?? decideStartup(currentUserAgent());
    this.machine = new AppStateMachine(this.startup.initialState);
  }

  /** The current application state. */
  get state(): AppState {
    return this.machine.state;
  }

  /** The screen id currently active (or that would be active). */
  get screen(): ScreenId {
    return this.machine.screen;
  }

  /** Whether startup was blocked by the browser-support gate (Req 13.6). */
  get isBlocked(): boolean {
    return this.blocked;
  }

  /** Whether the loop is currently running. */
  get isLoopRunning(): boolean {
    return this.loopRunning;
  }

  /**
   * Boots the application. When the browser is unsupported (Requirement 13.6),
   * shows the browser-warning overlay and does NOT start the loop or the normal
   * screen flow. Otherwise shows the initial screen (main menu). Idempotent.
   */
  start(): void {
    if (this.started) {
      return;
    }
    this.started = true;

    if (this.startup.blockStart) {
      this.blocked = true;
      const warning =
        this.deps.browserWarningFactory?.(this.startup) ??
        new BrowserWarning(this.startup.support.detected.name === 'Unknown' ? '' : currentUserAgent());
      this.mount(warning);
      // Requirement 13.6: never start the game loop on an unsupported browser.
      return;
    }

    this.showScreenFor(this.machine.state);
  }

  /**
   * Dispatches a navigation `event` through the state machine. When the state
   * actually changes, swaps the active overlay and updates the loop. A no-op
   * (rejected) transition leaves everything untouched. Blocked startups ignore
   * all events. Returns the resulting state.
   */
  dispatch(event: AppEvent): AppState {
    if (this.blocked) {
      return this.machine.state;
    }
    const previous = this.machine.state;
    const next = this.machine.dispatch(event);
    if (next !== previous) {
      this.showScreenFor(next);
    }
    return next;
  }

  /** Swaps to the screen for `state` and syncs the loop for that state. */
  private showScreenFor(state: AppState): void {
    const screen = screenForState(state);
    const overlay = this.getOverlay(screen);
    this.mount(overlay);
    this.syncLoop(state);
  }

  /** Starts the loop for loop-active states, stops it otherwise. */
  private syncLoop(state: AppState): void {
    const shouldRun = isLoopActiveState(state);
    if (shouldRun && !this.loopRunning) {
      this.deps.loop.start();
      this.loopRunning = true;
    } else if (!shouldRun && this.loopRunning) {
      this.deps.loop.stop();
      this.loopRunning = false;
    }
  }

  /** Returns the cached overlay for `screen`, creating it on first use. */
  private getOverlay(screen: ScreenId): Container {
    let overlay = this.overlayCache.get(screen);
    if (!overlay) {
      overlay = this.deps.overlays[screen]();
      this.overlayCache.set(screen, overlay);
    }
    return overlay;
  }

  /** Removes the active overlay (if any) and mounts `overlay` in its place. */
  private mount(overlay: Container): void {
    if (this.activeOverlay === overlay) {
      return;
    }
    if (this.activeOverlay) {
      this.deps.host.removeOverlay(this.activeOverlay);
    }
    this.deps.host.addOverlay(overlay);
    this.activeOverlay = overlay;
  }
}

// ---------------------------------------------------------------------------
// Track-preview launch verification (task 25.14)
// ---------------------------------------------------------------------------

/** The track drawn as a boot-time preview to verify asset loading + rendering. */
const DEFAULT_PREVIEW_TRACK: TrackId = 'orlando';

/** The track a standalone single-player race runs on until career selection is wired. */
const DEFAULT_RACE_TRACK: TrackId = 'orlando';

/** Colour of the previewed track centerline (bright green, as in the RE PNGs). */
const TRACK_PREVIEW_COLOR = 0x33ff66;

/** Deterministic seed for the single-player race. */
const SINGLE_PLAYER_RACE_SEED = 0x5eed;

/** The human player's display name for a single-player career. */
const SINGLE_PLAYER_NAME = 'Player';

/**
 * Load a converted track through the runtime {@link BinaryAssetLoader} (over an
 * {@link HttpAssetSource} fetching from the client's `public/` assets) and draw
 * its `roadSegments` centerline as a top-down polyline on the renderer's
 * track-boundaries layer.
 *
 * This is the honest end-to-end check for task 25.14: a real converted
 * `.TRK` → `TrackDef` is fetched, decoded (magic/CRC/kind/JSON) and its decoded
 * geometry is drawn to the canvas. It is a static top-down preview, not the
 * in-race scanline scene, and is intentionally best-effort: if the asset is not
 * present the caller logs and the client boots normally.
 */
async function drawTrackPreview(
  renderer: { getLayer(name: 'trackBoundaries'): Container; canvas: { width: number; height: number } },
  trackId: TrackId,
): Promise<void> {
  const loader = new BinaryAssetLoader(new HttpAssetSource());
  const track = await loader.loadTrack(trackId);

  const width = renderer.canvas.width || 640;
  const height = renderer.canvas.height || 480;
  const layout = layoutTrackPreview(track.roadSegments, { width, height, padding: 24 });
  if (layout.points.length < 2) return;

  const g = new Graphics();
  const [first, ...rest] = layout.points;
  g.moveTo(first!.x, first!.y);
  for (const p of rest) g.lineTo(p.x, p.y);
  if (layout.closed) g.lineTo(first!.x, first!.y);
  g.stroke({ width: 2, color: TRACK_PREVIEW_COLOR });

  renderer.getLayer('trackBoundaries').addChild(g);
}

// ---------------------------------------------------------------------------
// Browser-only bootstrap (NOT unit-tested — needs WebGL + DOM)
// ---------------------------------------------------------------------------

/**
 * Constructs and runs the real application in a browser: evaluates browser
 * support, and on a supported browser initialises the PixiJS Application (via
 * the Renderer), the AssetLoader, the AudioSystem and the NetworkManager, wires
 * them into an {@link App}, mounts the canvas into `mountPoint`, and starts.
 *
 * This function touches WebGL and the DOM and is therefore browser-only; it is
 * intentionally excluded from unit tests. The App orchestration it produces is
 * covered by tests via the injectable {@link App} constructor above.
 *
 * The heavy imports (Renderer, GameLoop, AudioSystem, AssetLoader,
 * NetworkManager) are loaded dynamically so that merely importing this module
 * in a headless context does not pull in GPU/DOM-only code paths.
 */
export async function bootstrap(
  mountPoint: HTMLElement = document.body,
): Promise<App> {
  const decision = decideStartup(currentUserAgent());

  // On an unsupported browser we still create an App so the warning overlay is
  // shown, but we must not initialise WebGL or start the loop (Requirement
  // 13.6). Mount a minimal PixiJS-free host is not possible (overlays are Pixi
  // Containers), so we initialise only the renderer needed to present the
  // warning and never start the loop.
  const { Renderer } = await import('./renderer/Renderer.js');
  const renderer = new Renderer();
  await renderer.init({ width: 640, height: 480, background: 0x000000 });
  mountPoint.appendChild(renderer.canvas);

  // Launch verification (task 25.14): on a supported browser, load a real
  // converted track through the runtime asset loader and draw its centerline as
  // a top-down preview. This proves the decoded `.TRK` geometry loads and
  // renders end-to-end. It is best-effort — a missing/unservable asset must not
  // stop the client from booting — and is a static preview, distinct from the
  // in-race scanline scene wired per race.
  if (!decision.blockStart) {
    void drawTrackPreview(renderer, DEFAULT_PREVIEW_TRACK).catch((err) => {
      console.warn(
        `[client] track preview skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  const stage = renderer.application.stage;
  const host: ScreenHost = {
    addOverlay: (o) => {
      stage.addChild(o);
    },
    removeOverlay: (o) => {
      stage.removeChild(o);
    },
  };

  // --- Live single-player race wiring (task 25.13) ------------------------
  //
  // The App's overlay factories are zero-argument and cached, and its
  // navigation events carry no data payload, so the per-race runtime state is
  // threaded here through the bootstrap closure instead:
  //   - `humanLoadout`   captured from the car-config screen at confirm time;
  //   - `raceTrack`      the decoded TrackDef, preloaded best-effort below;
  //   - `raceOverlay`    a stable Container that hosts the live HUD;
  //   - `resultsOverlay` a stable Container repopulated with a RaceResults table
  //                      when a race finishes;
  //   - `raceSession`    the running RaceLoop driver, built when `race` begins.
  //
  // The human's keyboard inputs are sampled by a single InputHandler attached
  // to the window for the lifetime of the app.

  const inputHandler = new InputHandler();
  inputHandler.attach();

  // The single-player career runtime: owns the CareerController + a localStorage
  // SaveManager, and mediates the full loop (configure -> race -> results ->
  // shop -> next race) with real money, owned items, and persistence. Created
  // best-effort; a failure falls back to a fresh in-memory career.
  let careerSession: CareerSession | null = null;
  const careerLoad = decision.blockStart
    ? Promise.resolve()
    : CareerSession.create(SINGLE_PLAYER_NAME)
        .then((s) => {
          careerSession = s;
        })
        .catch((err) => {
          console.warn(
            `[client] career session unavailable: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });

  /** The player's current loadout: the career's if available, else a default. */
  const currentLoadout = (): Loadout => careerSession?.loadout ?? emptyLoadout('hellcat');

  // Best-effort preload of the race track. A missing/unservable asset must not
  // stop the client from booting; the race falls back to a "track unavailable"
  // notice in that case (see startRaceSession).
  let raceTrack: TrackDef | null = null;
  const trackLoad = decision.blockStart
    ? Promise.resolve()
    : new BinaryAssetLoader(new HttpAssetSource())
        .loadTrack(DEFAULT_RACE_TRACK)
        .then((t) => {
          raceTrack = t;
        })
        .catch((err) => {
          console.warn(
            `[client] race track '${DEFAULT_RACE_TRACK}' unavailable: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });

  // Stable overlay containers (reused across races so the App's overlay cache
  // and the App.test single-construction contract both hold).
  const raceOverlay = new Container();
  raceOverlay.label = 'race';
  const resultsOverlay = new Container();
  resultsOverlay.label = 'raceResults';

  let raceSession: RaceSession | null = null;
  let raceHud: HUD | null = null;
  let previousRenderState: RenderStateSnapshot | null = null;

  // The App is referenced by the handlers below, which dispatch navigation
  // events back into it. Factories run lazily (on first navigation), so by the
  // time an overlay is constructed `app` is assigned.
  let app: App;

  // The car-config overlay is captured on first construction so the confirm
  // handler can read the player's chosen loadout back out of it, and a rebuild
  // hook re-seeds it from the live career whenever the screen is shown.
  let carConfigOverlay: CarConfig | null = null;
  let carConfigRebuild: (() => void) | null = null;

  // The career hub is the Shop: a stable container rebuilt from the live career
  // (money + catalogue) each time it is shown, whose purchases spend real money
  // via the CareerSession and persist.
  const careerOverlay = new Container();
  careerOverlay.label = 'career';

  /** Navigate to the career hub, syncing the career phase + rebuilding the shop. */
  const goCareer = (): void => {
    // Coming from results, move the career flow into its shop phase so the
    // player can spend their winnings; from the main menu it is a browse-only
    // visit (purchases enable after the first race).
    careerSession?.enterHub();
    rebuildCareerHub();
    app.dispatch('openCareer');
  };

  /** Navigate to car-config, advancing to the next race + re-seeding the screen. */
  const goCarConfig = (): void => {
    // From the shop hub this is the "next race" step (shop -> config, advancing
    // the circuit). From the main menu the career is already in config.
    careerSession?.nextRace();
    carConfigRebuild?.();
    app.dispatch('configureCar');
  };

  /**
   * Rebuild the career hub from the live career: the Shop (spend winnings +
   * record owned items) plus a header showing money/circuit progress and a
   * CONFIGURE CAR button that advances to the next race.
   */
  const rebuildCareerHub = (): void => {
    careerOverlay.removeChildren().forEach((c) => c.destroy({ children: true }));
    const money = careerSession?.money ?? INITIAL_CAREER_MONEY;

    const shop = new Shop(COMPONENT_CATALOGUE, WEAPON_CATALOGUE, money, (item) => {
      // Spend real money and record ownership; on success rebuild so the new
      // balance and affordability are reflected immediately.
      const purchase: CareerPurchase = { id: item.id, kind: item.kind, price: item.price };
      const result = careerSession?.buyItem(purchase);
      if (result?.ok) rebuildCareerHub();
    });
    careerOverlay.addChild(shop);

    // Header: player money + circuit/race progress.
    const info = careerSession
      ? `$${money.toLocaleString('en-US')}   CIRCUIT ${careerSession.circuitNumber}  RACE ${careerSession.raceNumber}/10`
      : `$${money.toLocaleString('en-US')}`;
    const header = new Text({
      text: info,
      style: new TextStyle({ fill: 0x88ccff, fontFamily: 'monospace', fontSize: 15, fontWeight: 'bold' }),
    });
    header.position.set(24, -28);
    careerOverlay.addChild(header);

    // CONFIGURE CAR -> next race. Positioned above the shop panel.
    const button = makeButton('career:configureCar', 'CONFIGURE CAR', 300, 44, () => goCarConfig());
    button.position.set(260, -34);
    careerOverlay.addChild(button);
  };

  /** Draw a centred one-line notice into a container (cleared first). */
  const drawNotice = (container: Container, message: string): void => {
    container.removeChildren().forEach((c) => c.destroy({ children: true }));
    const style = new TextStyle({ fill: 0xffcc33, fontFamily: 'monospace', fontSize: 18 });
    const text = new Text({ text: message, style });
    text.position.set(40, 40);
    container.addChild(text);
  };

  /**
   * Begin a single-player race: build the {@link RaceSession} from the decoded
   * track + the human's loadout, mount a fresh HUD into the race overlay, and
   * reset the interpolation snapshot. No-op (with an on-screen notice) when the
   * track failed to load.
   */
  const startRaceSession = (): void => {
    raceOverlay.removeChildren().forEach((c) => c.destroy({ children: true }));
    previousRenderState = null;

    if (!raceTrack) {
      raceSession = null;
      raceHud = null;
      drawNotice(raceOverlay, 'TRACK UNAVAILABLE — cannot start race');
      return;
    }

    const loadout = currentLoadout();
    const session = new RaceSession({
      track: raceTrack,
      humanLoadout: loadout,
      humanName: SINGLE_PLAYER_NAME,
      inputSource: inputHandler,
      seed: SINGLE_PLAYER_RACE_SEED,
    });
    raceSession = session;

    // Advance the career flow into its `race` phase so finishRace is valid.
    careerSession?.startRace();

    const initialCar = session.humanCar;
    if (initialCar) {
      raceHud = new HUD(
        buildHudModel(initialCar, loadout, session.weaponConfigs, {
          totalLaps: session.lapCount,
        }),
      );
      raceOverlay.addChild(raceHud);
    }
  };

  /**
   * Populate the results overlay from the finished race's outcomes and award the
   * player's prize money to the persisted career (which also schedules the
   * auto-save). The results table shows each car's prize from the same shared
   * career prize table.
   */
  const showResults = (): void => {
    resultsOverlay.removeChildren().forEach((c) => c.destroy({ children: true }));
    if (!raceSession) {
      drawNotice(resultsOverlay, 'NO RACE RESULTS');
      return;
    }
    // Award the human's result to the career before drawing the table.
    const human = raceSession.humanOutcome();
    if (human && careerSession) {
      careerSession.finishRace({
        placement: human.placement,
        eliminationCount: human.eliminationCount,
      });
    }
    const results = new RaceResults(raceSession.outcomes(), CAREER_PRIZE_TABLE);
    resultsOverlay.addChild(results);

    // CONTINUE -> career hub (results -> shop): lets the player spend winnings.
    const cont = makeButton('results:continue', 'CONTINUE', 200, 40, () => goCareer());
    cont.position.set(24, -30);
    resultsOverlay.addChild(cont);
  };

  // Loop controller backed by the renderer's render loop. Entering the `race`
  // state builds the session and drives the fixed-step simulation from each
  // presentation frame; leaving it stops the loop.
  const loop: LoopController = {
    start: () => {
      startRaceSession();
      renderer.startRenderLoop((frame) => {
        const session = raceSession;
        if (!session) return;

        // Advance the simulation the number of fixed steps this frame owes,
        // then render an interpolated snapshot between the previous and current
        // field, and refresh the HUD from the human's live car.
        const current = session.stepAndSnapshot(frame.simulationSteps);
        renderer.render(current, frame.alpha, previousRenderState ?? undefined, frame.deltaMs);
        renderer.advanceFrameExplosions(frame.deltaMs);
        previousRenderState = current;

        const humanCar = session.humanCar;
        if (raceHud && humanCar) {
          raceHud.update(
            buildHudModel(humanCar, session.humanLoadout, session.weaponConfigs, {
              totalLaps: session.lapCount,
            }),
          );
        }

        // When the race resolves, populate the results table and advance the
        // navigation flow (race -> results). syncLoop stops the loop for us.
        if (session.finished) {
          showResults();
          app.dispatch('finishRace');
        }
      });
    },
    stop: () => {
      renderer.stopRenderLoop();
    },
  };

  // Overlay factories. Each returns a PixiJS `Container`; overlays that extend
  // `Container` are returned directly, and `MainMenu` (which exposes a `.view`
  // container) is adapted. Factories are created lazily by the App on first
  // navigation, so unused screens never allocate.
  //
  // `mainMenu`, `carConfig`, `lobby`, `race` and `raceResults` are wired to real
  // overlays. `lobby` is a minimal single-player pre-race screen (the multiplayer
  // Lobby overlay needs a live Session, which single-player has none of); it
  // simply offers a START RACE action. `race` hosts the live HUD driven by the
  // RaceSession, and `raceResults` shows the finishing table + prize money. The
  // `race`/`raceResults` containers are stable and repopulated per race (see the
  // loop controller + startRaceSession/showResults above).
  //   - career:    the live career hub — the Shop (spending real money via the
  //                CareerSession, persisted) plus a CONFIGURE CAR button that
  //                advances to the next race.
  const overlays: OverlayFactories = {
    mainMenu: () => {
      const menu = new MainMenu({
        // Map each menu action to the navigation it represents. Career entry
        // goes through goCareer so the career phase + shop are synced/rebuilt.
        onStartCareer: () => goCareer(),
        onHostSession: () => app.dispatch('configureCar'),
        onJoinSession: () => app.dispatch('configureCar'),
        onViewHighScores: () => goCareer(),
        onSettings: () => {
          // No dedicated settings screen state exists in the navigation model;
          // wired when a settings flow is added.
        },
      });
      return menu.view;
    },
    carConfig: () => {
      // Seed the car-config screen from the live career: the player's current
      // loadout plus the components/weapons they own (purchased in the shop).
      // On a fresh career this is the default chassis with nothing owned
      // (Req 5.10). A stable container is reused and its contents rebuilt each
      // time the screen is shown so it reflects newly-purchased items.
      const rebuild = (): void => {
        carConfigOverlay?.setInput({
          loadout: currentLoadout(),
          chassisCatalogue: CHASSIS_CATALOGUE,
          componentCatalogue: COMPONENT_CATALOGUE,
          weaponCatalogue: WEAPON_CATALOGUE,
          ownedComponents: [...(careerSession?.ownedComponents ?? [])],
          ownedWeapons: [...(careerSession?.ownedWeapons ?? [])],
        });
      };
      const overlay = new CarConfig(
        {
          loadout: currentLoadout(),
          chassisCatalogue: CHASSIS_CATALOGUE,
          componentCatalogue: COMPONENT_CATALOGUE,
          weaponCatalogue: WEAPON_CATALOGUE,
          ownedComponents: [...(careerSession?.ownedComponents ?? [])],
          ownedWeapons: [...(careerSession?.ownedWeapons ?? [])],
        },
        {
          onConfirm: () => {
            // Persist the player's confirmed loadout into the career, then
            // advance the flow toward the race.
            const loadout = carConfigOverlay?.getInput().loadout;
            if (loadout) careerSession?.setLoadout(loadout);
            app.dispatch('enterLobby');
          },
          onClose: () => app.dispatch('back'),
        },
      );
      carConfigOverlay = overlay;
      carConfigRebuild = rebuild;
      return overlay;
    },
    lobby: () => buildPreRaceScreen(() => app.dispatch('startRace')),
    race: () => raceOverlay,
    raceResults: () => resultsOverlay,
    career: () => careerOverlay,
  };

  app = new App({
    host,
    overlays,
    loop,
    startup: decision,
    browserWarningFactory: (d) =>
      new BrowserWarning(d.support.detected.name === 'Unknown' ? '' : currentUserAgent()),
  });
  app.start();
  await Promise.all([trackLoad, careerLoad]);
  return app;
}

// ---------------------------------------------------------------------------
// Small PixiJS UI helpers
// ---------------------------------------------------------------------------

/**
 * Build a clickable rectangular button {@link Container} with a caption. Used
 * for the ad-hoc navigation buttons the bootstrap adds to overlays (start race,
 * continue to career, configure car).
 */
function makeButton(label: string, caption: string, width: number, height: number, onActivate: () => void): Container {
  const button = new Container();
  button.label = label;
  const bg = new Graphics();
  bg.roundRect(0, 0, width, height, 6).fill(0x224488).stroke({ width: 2, color: 0x66aaff });
  button.addChild(bg);
  const text = new Text({
    text: caption,
    style: new TextStyle({ fill: 0xffffff, fontFamily: 'monospace', fontSize: 16 }),
  });
  text.anchor.set(0.5);
  text.position.set(width / 2, height / 2);
  button.addChild(text);
  button.eventMode = 'static';
  button.cursor = 'pointer';
  button.on('pointertap', onActivate);
  return button;
}

// ---------------------------------------------------------------------------
// Minimal single-player pre-race screen
// ---------------------------------------------------------------------------

/**
 * A minimal single-player pre-race screen: a panel with a single START RACE
 * button that invokes `onStart`. The multiplayer {@link import('./ui/Lobby.js').Lobby}
 * overlay requires a live networked Session, which a single-player race has
 * none of, so this stands in as an honest single-player launch point rather
 * than fabricating a fake session.
 */
function buildPreRaceScreen(onStart: () => void): Container {
  const root = new Container();
  root.label = 'lobby';

  const panel = new Graphics();
  panel
    .roundRect(0, 0, 360, 160, 8)
    .fill({ color: 0x0a0a12, alpha: 0.92 })
    .stroke({ color: 0x3355aa, width: 2 });
  root.addChild(panel);

  const title = new Text({
    text: 'READY TO RACE',
    style: new TextStyle({ fill: 0xffcc33, fontFamily: 'monospace', fontSize: 22, fontWeight: 'bold' }),
  });
  title.position.set(24, 20);
  root.addChild(title);

  const button = makeButton('lobby:startRace', 'START RACE', 312, 44, onStart);
  button.position.set(24, 90);
  root.addChild(button);

  return root;
}
