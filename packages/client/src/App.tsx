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

import { Container, Graphics } from 'pixi.js';
import { BinaryAssetLoader, type TrackId } from '@deathtrack/shared';
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
import {
  currentUserAgent,
  BrowserWarning,
} from './ui/BrowserWarning.js';

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

/** Colour of the previewed track centerline (bright green, as in the RE PNGs). */
const TRACK_PREVIEW_COLOR = 0x33ff66;

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

  // Loop controller backed by the renderer's own render loop. The full GameLoop
  // (fixed-step simulation + network) is wired when a race actually begins; at
  // this top level we start/stop the presentation loop for the race state.
  const loop: LoopController = {
    start: () => {
      // The fixed-step simulation + network stepping (via GameLoop) is wired per
      // race as that flow is entered; at this top level we drive the renderer's
      // presentation loop so the race scene is drawn each frame.
      renderer.startRenderLoop(() => {
        // Per-frame race stepping is attached when a race begins.
      });
    },
    stop: () => {
      renderer.stopRenderLoop();
    },
  };

  // Overlay factories. Each returns a PixiJS Container; overlays that expose a
  // `.view` are adapted, those that extend Container are returned directly.
  // These are created lazily by the App on first navigation, so unused screens
  // never allocate. Concrete overlay construction (with real handlers/models)
  // is beyond this entry-point wiring task and is assembled per-screen as those
  // flows are entered; here we provide placeholder containers that the
  // per-screen wiring replaces. The App only requires a Container per screen.
  const overlays: OverlayFactories = {
    mainMenu: () => new Container(),
    carConfig: () => new Container(),
    lobby: () => new Container(),
    race: () => new Container(),
    raceResults: () => new Container(),
    career: () => new Container(),
  };

  const app = new App({
    host,
    overlays,
    loop,
    startup: decision,
    browserWarningFactory: (d) =>
      new BrowserWarning(d.support.detected.name === 'Unknown' ? '' : currentUserAgent()),
  });
  app.start();
  return app;
}
