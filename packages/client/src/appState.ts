// packages/client/src/appState.ts
//
// Application state machine (task 19.3).
//
// This module is the pure, GPU-free core of the client entry point. It owns:
//   - the set of application states (mainMenu, carConfig, lobby, race, results,
//     career),
//   - the transition table (given a current state + an event, what is the next
//     state — or `null` when the event is not valid in that state),
//   - the mapping from each state to the UI screen/overlay that should be shown,
//   - the startup gate that decides whether the game loop may start at all
//     (Requirement 13.6 — an unsupported browser must NOT start the loop).
//
// Following the established client convention (see BrowserWarning.tsx,
// MainMenu.tsx, AudioSystem.ts), the pure decision logic lives here and is fully
// unit-testable in a headless `node` environment. The heavy, browser-only wiring
// (PixiJS Application.init, DOM mount, requestAnimationFrame) lives in App.tsx
// and is NOT exercised by unit tests.
//
// Requirements:
//   - 13.1 — run in a modern browser; the startup gate enforces the supported
//     matrix before anything is initialised.
//   - 13.3 — navigation from the main menu through to a race start screen; the
//     transition table below encodes that flow.

import {
  evaluateBrowserSupport,
  type BrowserSupportResult,
} from './ui/BrowserWarning.js';

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

/**
 * The application-level states, in the primary forward flow order required by
 * task 19.3: mainMenu → carConfig → lobby → race → results → career.
 */
export const APP_STATES = [
  'mainMenu',
  'carConfig',
  'lobby',
  'race',
  'results',
  'career',
] as const;

/** A single application state. */
export type AppState = (typeof APP_STATES)[number];

/** The state the application starts in. */
export const INITIAL_STATE: AppState = 'mainMenu';

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * The navigation events that drive transitions between {@link AppState}s. Each
 * event corresponds to a user action (a button press in an overlay) or a game
 * lifecycle signal (a race finishing).
 */
export const APP_EVENTS = [
  // Forward flow.
  'configureCar', // mainMenu | career -> carConfig
  'enterLobby', // carConfig -> lobby
  'startRace', // lobby -> race
  'finishRace', // race -> results
  'openCareer', // results | mainMenu -> career
  // Back / return flow.
  'back', // context-sensitive step back toward the main menu
  'toMainMenu', // any state -> mainMenu (quit to menu)
] as const;

/** A single navigation event. */
export type AppEvent = (typeof APP_EVENTS)[number];

// ---------------------------------------------------------------------------
// Transition table
// ---------------------------------------------------------------------------

/**
 * The transition table: `TRANSITIONS[state][event]` is the state to move to, or
 * `undefined` when the event is not valid in that state (an invalid transition,
 * which {@link nextState} treats as a no-op).
 *
 * Forward flow (Requirement 13.3):
 *   mainMenu --configureCar--> carConfig --enterLobby--> lobby --startRace-->
 *   race --finishRace--> results --openCareer--> career
 *
 * The `back` event steps one screen toward the main menu along the flow. The
 * `toMainMenu` event is a hard "quit to menu" available from every non-menu
 * state (Requirement 11.5's "quit to the main menu").
 */
export const TRANSITIONS: Readonly<
  Record<AppState, Partial<Record<AppEvent, AppState>>>
> = {
  mainMenu: {
    configureCar: 'carConfig',
    openCareer: 'career',
  },
  carConfig: {
    enterLobby: 'lobby',
    back: 'mainMenu',
    toMainMenu: 'mainMenu',
  },
  lobby: {
    startRace: 'race',
    back: 'carConfig',
    toMainMenu: 'mainMenu',
  },
  race: {
    finishRace: 'results',
    toMainMenu: 'mainMenu',
  },
  results: {
    openCareer: 'career',
    back: 'mainMenu',
    toMainMenu: 'mainMenu',
  },
  career: {
    configureCar: 'carConfig',
    back: 'mainMenu',
    toMainMenu: 'mainMenu',
  },
} as const;

/**
 * Computes the next state given the `current` state and an `event`. Returns the
 * target state for a valid transition, or the `current` state unchanged when the
 * event is not permitted in that state (a rejected / no-op transition).
 *
 * Pure: no side effects, no display objects — fully unit-testable headlessly.
 */
export function nextState(current: AppState, event: AppEvent): AppState {
  return TRANSITIONS[current][event] ?? current;
}

/**
 * Returns whether `event` is a valid (state-changing) transition from
 * `current`. Distinguishes a rejected transition from a self-transition that a
 * table might legitimately define.
 */
export function canTransition(current: AppState, event: AppEvent): boolean {
  return TRANSITIONS[current][event] !== undefined;
}

// ---------------------------------------------------------------------------
// State -> screen mapping
// ---------------------------------------------------------------------------

/**
 * The distinct UI screens/overlays the App can show. Each {@link AppState} maps
 * to exactly one screen id; the App swaps the matching PixiJS overlay onto the
 * stage when the state changes.
 */
export const SCREENS = [
  'mainMenu',
  'carConfig',
  'lobby',
  'race',
  'raceResults',
  'career',
] as const;

/** A single screen id. */
export type ScreenId = (typeof SCREENS)[number];

/**
 * Maps each application state to the screen shown while in that state. The race
 * state shows the in-race view (HUD overlay on top of the renderer); the results
 * state shows the {@link RaceResults} overlay.
 */
export const STATE_TO_SCREEN: Readonly<Record<AppState, ScreenId>> = {
  mainMenu: 'mainMenu',
  carConfig: 'carConfig',
  lobby: 'lobby',
  race: 'race',
  results: 'raceResults',
  career: 'career',
} as const;

/** Returns the screen id to display for `state`. Pure. */
export function screenForState(state: AppState): ScreenId {
  return STATE_TO_SCREEN[state];
}

/**
 * Whether the game simulation / render loop should be running while in `state`.
 * Only the `race` state runs the loop; every menu/overlay state is static.
 */
export function isLoopActiveState(state: AppState): boolean {
  return state === 'race';
}

// ---------------------------------------------------------------------------
// Startup gate (Requirement 13.6)
// ---------------------------------------------------------------------------

/** The outcome of the startup decision made before any subsystem is created. */
export interface StartupDecision {
  /** Full browser-support evaluation (detected browser, message, ...). */
  readonly support: BrowserSupportResult;
  /**
   * `true` when the game loop must be BLOCKED from starting because the browser
   * is unsupported. When blocked, the App shows the browser-warning overlay and
   * never starts the loop (Requirement 13.6).
   */
  readonly blockStart: boolean;
  /** The state the application should begin in when it is allowed to start. */
  readonly initialState: AppState;
}

/**
 * Decides, from a user-agent string, whether the application may start and where
 * it should begin. Pure: the UA is injected so tests can exercise supported and
 * unsupported browsers deterministically.
 *
 * When the browser is unsupported the loop is blocked (Requirement 13.6). The
 * `initialState` is always {@link INITIAL_STATE}; a blocked start simply never
 * advances past showing the warning.
 */
export function decideStartup(userAgent: string): StartupDecision {
  const support = evaluateBrowserSupport(userAgent);
  return {
    support,
    blockStart: support.blockStart,
    initialState: INITIAL_STATE,
  };
}

// ---------------------------------------------------------------------------
// State machine object
// ---------------------------------------------------------------------------

/**
 * A tiny, pure state-machine instance wrapping the {@link TRANSITIONS} table.
 * Holds the current state and applies events, notifying an optional listener on
 * every actual state change. Contains no PixiJS/DOM references so the App's
 * navigation can be driven and asserted headlessly with fakes.
 */
export class AppStateMachine {
  private current: AppState;
  private readonly listeners: ((state: AppState, previous: AppState) => void)[] = [];

  constructor(initial: AppState = INITIAL_STATE) {
    this.current = initial;
  }

  /** The current application state. */
  get state(): AppState {
    return this.current;
  }

  /** The screen id for the current state. */
  get screen(): ScreenId {
    return screenForState(this.current);
  }

  /**
   * Applies `event`. On a valid transition the state advances and every
   * registered listener is invoked with `(next, previous)`. An invalid event is
   * a no-op (no state change, no listener call). Returns the resulting state.
   */
  dispatch(event: AppEvent): AppState {
    const previous = this.current;
    const next = nextState(previous, event);
    if (next !== previous) {
      this.current = next;
      for (const listener of this.listeners) {
        listener(next, previous);
      }
    }
    return this.current;
  }

  /**
   * Registers a listener invoked after every state change. Returns an
   * unsubscribe function.
   */
  onChange(listener: (state: AppState, previous: AppState) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) {
        this.listeners.splice(idx, 1);
      }
    };
  }
}
