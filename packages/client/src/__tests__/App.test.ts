import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import { App, type OverlayFactories, type ScreenHost, type LoopController } from '../App';
import { decideStartup, type ScreenId } from '../appState';

/**
 * These tests exercise the App *orchestration* — driving the pure state machine,
 * swapping the active overlay on an injected host, and starting/stopping the
 * loop for the race state — using fakes for every heavy subsystem. No WebGL
 * context or DOM is required: PixiJS `Container`s construct without a GPU, and
 * the loop/host are plain fakes.
 *
 * The browser-only bootstrap() (Application.init + DOM mount + rAF) is validated
 * in the browser, not here.
 */

const UA_SUPPORTED =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const UA_UNSUPPORTED =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.0.0 Safari/537.36';

interface Harness {
  app: App;
  host: { added: Container[]; removed: Container[] } & ScreenHost;
  loop: { starts: number; stops: number } & LoopController;
  createdScreens: ScreenId[];
  overlays: OverlayFactories;
}

function makeHarness(userAgent: string): Harness {
  const host = {
    added: [] as Container[],
    removed: [] as Container[],
    addOverlay(o: Container) {
      this.added.push(o);
    },
    removeOverlay(o: Container) {
      this.removed.push(o);
    },
  };

  const loop = {
    starts: 0,
    stops: 0,
    start() {
      this.starts++;
    },
    stop() {
      this.stops++;
    },
  };

  const createdScreens: ScreenId[] = [];
  const makeFactory = (id: ScreenId) => () => {
    createdScreens.push(id);
    const c = new Container();
    c.label = id;
    return c;
  };
  const overlays: OverlayFactories = {
    mainMenu: makeFactory('mainMenu'),
    carConfig: makeFactory('carConfig'),
    lobby: makeFactory('lobby'),
    race: makeFactory('race'),
    raceResults: makeFactory('raceResults'),
    career: makeFactory('career'),
  };

  const app = new App({
    host,
    overlays,
    loop,
    startup: decideStartup(userAgent),
    browserWarningFactory: () => {
      const c = new Container();
      c.label = 'browserWarning';
      return c;
    },
  });

  return { app, host, loop, createdScreens, overlays };
}

describe('App — supported browser flow', () => {
  it('shows the main menu on start', () => {
    const h = makeHarness(UA_SUPPORTED);
    h.app.start();
    expect(h.app.isBlocked).toBe(false);
    expect(h.app.screen).toBe('mainMenu');
    expect(h.host.added).toHaveLength(1);
    expect(h.host.added[0]!.label).toBe('mainMenu');
    expect(h.loop.starts).toBe(0);
  });

  it('swaps overlays as it walks the forward flow', () => {
    const h = makeHarness(UA_SUPPORTED);
    h.app.start();

    h.app.dispatch('configureCar');
    expect(h.app.screen).toBe('carConfig');
    expect(h.host.added.at(-1)!.label).toBe('carConfig');
    expect(h.host.removed.at(-1)!.label).toBe('mainMenu');

    h.app.dispatch('enterLobby');
    expect(h.host.added.at(-1)!.label).toBe('lobby');

    h.app.dispatch('startRace');
    expect(h.app.screen).toBe('race');
    expect(h.host.added.at(-1)!.label).toBe('race');

    h.app.dispatch('finishRace');
    expect(h.host.added.at(-1)!.label).toBe('raceResults');

    h.app.dispatch('openCareer');
    expect(h.host.added.at(-1)!.label).toBe('career');
  });

  it('starts the loop entering race and stops it leaving race', () => {
    const h = makeHarness(UA_SUPPORTED);
    h.app.start();
    h.app.dispatch('configureCar');
    h.app.dispatch('enterLobby');
    expect(h.loop.starts).toBe(0);

    h.app.dispatch('startRace');
    expect(h.app.isLoopRunning).toBe(true);
    expect(h.loop.starts).toBe(1);
    expect(h.loop.stops).toBe(0);

    h.app.dispatch('finishRace');
    expect(h.app.isLoopRunning).toBe(false);
    expect(h.loop.stops).toBe(1);
  });

  it('is a no-op on an invalid transition (no overlay swap)', () => {
    const h = makeHarness(UA_SUPPORTED);
    h.app.start();
    const addedBefore = h.host.added.length;
    const removedBefore = h.host.removed.length;

    expect(h.app.dispatch('startRace')).toBe('mainMenu');
    expect(h.app.screen).toBe('mainMenu');
    expect(h.host.added.length).toBe(addedBefore);
    expect(h.host.removed.length).toBe(removedBefore);
  });

  it('caches overlays — a screen is only constructed once', () => {
    const h = makeHarness(UA_SUPPORTED);
    h.app.start(); // mainMenu
    h.app.dispatch('configureCar'); // carConfig
    h.app.dispatch('back'); // mainMenu again (cached)
    h.app.dispatch('configureCar'); // carConfig again (cached)

    const mainMenuCount = h.createdScreens.filter((s) => s === 'mainMenu').length;
    const carConfigCount = h.createdScreens.filter((s) => s === 'carConfig').length;
    expect(mainMenuCount).toBe(1);
    expect(carConfigCount).toBe(1);
  });

  it('start() is idempotent', () => {
    const h = makeHarness(UA_SUPPORTED);
    h.app.start();
    h.app.start();
    expect(h.host.added).toHaveLength(1);
  });
});

describe('App — unsupported browser (Requirement 13.6)', () => {
  it('shows the browser warning and never starts the loop', () => {
    const h = makeHarness(UA_UNSUPPORTED);
    h.app.start();
    expect(h.app.isBlocked).toBe(true);
    expect(h.host.added).toHaveLength(1);
    expect(h.host.added[0]!.label).toBe('browserWarning');
    expect(h.loop.starts).toBe(0);
  });

  it('ignores navigation events while blocked', () => {
    const h = makeHarness(UA_UNSUPPORTED);
    h.app.start();
    expect(h.app.dispatch('configureCar')).toBe('mainMenu');
    // No screen overlay was ever created; only the warning was mounted.
    expect(h.createdScreens).toHaveLength(0);
    expect(h.loop.starts).toBe(0);
  });
});
