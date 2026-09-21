import { describe, expect, it, vi } from 'vitest';
import {
  APP_STATES,
  APP_EVENTS,
  INITIAL_STATE,
  TRANSITIONS,
  SCREENS,
  STATE_TO_SCREEN,
  nextState,
  canTransition,
  screenForState,
  isLoopActiveState,
  decideStartup,
  AppStateMachine,
  type AppState,
} from '../appState';

/**
 * These tests exercise only the pure, GPU-free application state machine: the
 * transition table (current state + event -> next state), the state -> screen
 * mapping, rejection of invalid transitions, and the startup gate that blocks
 * the loop on an unsupported browser (Requirement 13.6). None of this needs a
 * WebGL context or DOM, so it runs headless in the `node` vitest environment.
 *
 * The browser-only App wiring (PixiJS Application.init, DOM mount, rAF start in
 * bootstrap()) is validated in the browser, not here.
 */

const UA_SUPPORTED =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const UA_UNSUPPORTED_OLD_CHROME =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.0.0 Safari/537.36';
const UA_UNKNOWN = 'SomeRandomBot/1.0';

describe('appState — states and screens', () => {
  it('starts in mainMenu', () => {
    expect(INITIAL_STATE).toBe('mainMenu');
  });

  it('defines the six required states in forward-flow order', () => {
    expect(APP_STATES).toEqual([
      'mainMenu',
      'carConfig',
      'lobby',
      'race',
      'results',
      'career',
    ]);
  });

  it('maps every state to a known screen id', () => {
    for (const state of APP_STATES) {
      const screen = screenForState(state);
      expect(SCREENS).toContain(screen);
      expect(STATE_TO_SCREEN[state]).toBe(screen);
    }
  });

  it('maps each state to its expected screen', () => {
    expect(screenForState('mainMenu')).toBe('mainMenu');
    expect(screenForState('carConfig')).toBe('carConfig');
    expect(screenForState('lobby')).toBe('lobby');
    expect(screenForState('race')).toBe('race');
    expect(screenForState('results')).toBe('raceResults');
    expect(screenForState('career')).toBe('career');
  });

  it('runs the loop only in the race state', () => {
    for (const state of APP_STATES) {
      expect(isLoopActiveState(state)).toBe(state === 'race');
    }
  });
});

describe('appState — forward flow transitions (Requirement 13.3)', () => {
  it('walks mainMenu -> carConfig -> lobby -> race -> results -> career', () => {
    let state: AppState = INITIAL_STATE;
    state = nextState(state, 'configureCar');
    expect(state).toBe('carConfig');
    state = nextState(state, 'enterLobby');
    expect(state).toBe('lobby');
    state = nextState(state, 'startRace');
    expect(state).toBe('race');
    state = nextState(state, 'finishRace');
    expect(state).toBe('results');
    state = nextState(state, 'openCareer');
    expect(state).toBe('career');
  });

  it('allows entering car config from career (start a new race from career)', () => {
    expect(nextState('career', 'configureCar')).toBe('carConfig');
  });

  it('allows opening career directly from the main menu', () => {
    expect(nextState('mainMenu', 'openCareer')).toBe('career');
  });
});

describe('appState — back / return transitions', () => {
  it('steps back one screen toward the main menu', () => {
    expect(nextState('carConfig', 'back')).toBe('mainMenu');
    expect(nextState('lobby', 'back')).toBe('carConfig');
    expect(nextState('results', 'back')).toBe('mainMenu');
    expect(nextState('career', 'back')).toBe('mainMenu');
  });

  it('supports quit-to-main-menu from every non-menu state', () => {
    for (const state of APP_STATES) {
      if (state === 'mainMenu') continue;
      expect(nextState(state, 'toMainMenu')).toBe('mainMenu');
    }
  });
});

describe('appState — invalid transitions are rejected (no-op)', () => {
  it('rejects skipping ahead in the flow', () => {
    // Can't jump straight from mainMenu to a race.
    expect(nextState('mainMenu', 'startRace')).toBe('mainMenu');
    expect(canTransition('mainMenu', 'startRace')).toBe(false);
    // Can't finish a race from the lobby.
    expect(nextState('lobby', 'finishRace')).toBe('lobby');
    expect(canTransition('lobby', 'finishRace')).toBe(false);
    // Can't enter a lobby from a running race.
    expect(nextState('race', 'enterLobby')).toBe('race');
    expect(canTransition('race', 'enterLobby')).toBe(false);
  });

  it('rejects `back` and `toMainMenu` from the main menu (already there)', () => {
    expect(nextState('mainMenu', 'back')).toBe('mainMenu');
    expect(canTransition('mainMenu', 'back')).toBe(false);
    expect(nextState('mainMenu', 'toMainMenu')).toBe('mainMenu');
    expect(canTransition('mainMenu', 'toMainMenu')).toBe(false);
  });

  it('every table entry points at a valid state, and canTransition agrees', () => {
    for (const state of APP_STATES) {
      for (const event of APP_EVENTS) {
        const target = TRANSITIONS[state][event];
        if (target === undefined) {
          expect(canTransition(state, event)).toBe(false);
          expect(nextState(state, event)).toBe(state);
        } else {
          expect(APP_STATES).toContain(target);
          expect(canTransition(state, event)).toBe(true);
          expect(nextState(state, event)).toBe(target);
        }
      }
    }
  });
});

describe('AppStateMachine', () => {
  it('advances on valid events and notifies listeners with (next, previous)', () => {
    const machine = new AppStateMachine();
    const changes: Array<[AppState, AppState]> = [];
    machine.onChange((next, prev) => changes.push([next, prev]));

    expect(machine.state).toBe('mainMenu');
    expect(machine.screen).toBe('mainMenu');

    expect(machine.dispatch('configureCar')).toBe('carConfig');
    expect(machine.state).toBe('carConfig');
    expect(machine.screen).toBe('carConfig');

    machine.dispatch('enterLobby');
    machine.dispatch('startRace');
    expect(machine.state).toBe('race');

    expect(changes).toEqual([
      ['carConfig', 'mainMenu'],
      ['lobby', 'carConfig'],
      ['race', 'lobby'],
    ]);
  });

  it('does not change state or notify on an invalid event', () => {
    const machine = new AppStateMachine();
    const listener = vi.fn();
    machine.onChange(listener);

    expect(machine.dispatch('startRace')).toBe('mainMenu');
    expect(machine.state).toBe('mainMenu');
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribes listeners', () => {
    const machine = new AppStateMachine();
    const listener = vi.fn();
    const off = machine.onChange(listener);
    off();
    machine.dispatch('configureCar');
    expect(listener).not.toHaveBeenCalled();
  });

  it('honours a custom initial state', () => {
    const machine = new AppStateMachine('career');
    expect(machine.state).toBe('career');
    expect(machine.screen).toBe('career');
  });
});

describe('appState — startup gate (Requirement 13.6)', () => {
  it('does NOT block start on a supported browser', () => {
    const decision = decideStartup(UA_SUPPORTED);
    expect(decision.blockStart).toBe(false);
    expect(decision.support.supported).toBe(true);
    expect(decision.support.message).toBeNull();
    expect(decision.initialState).toBe('mainMenu');
  });

  it('blocks start on an outdated supported-brand browser', () => {
    const decision = decideStartup(UA_UNSUPPORTED_OLD_CHROME);
    expect(decision.blockStart).toBe(true);
    expect(decision.support.supported).toBe(false);
    expect(decision.support.message).not.toBeNull();
  });

  it('blocks start on an unknown browser', () => {
    const decision = decideStartup(UA_UNKNOWN);
    expect(decision.blockStart).toBe(true);
    expect(decision.support.detected.name).toBe('Unknown');
  });

  it('blocks start on an empty user agent (headless/no navigator)', () => {
    const decision = decideStartup('');
    expect(decision.blockStart).toBe(true);
  });
});
