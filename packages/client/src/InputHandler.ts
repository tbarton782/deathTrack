/**
 * Keyboard input handling for the client (task 19.2).
 *
 * Requirement 11.4: key bindings are configurable. This module turns the
 * player's live keyboard state into the shared {@link CarInputs} the physics
 * step and prediction loop consume, and packages a sampled input into a shared
 * {@link InputFrame} carrying the current tick plus a CRC-32 of the prior local
 * state (design.md: `checksum` = "CRC32 of prior frame's local state").
 *
 * Design follows the established client convention (see {@link Settings}) of
 * separating a pure, GPU-/DOM-free core from a thin browser-only wiring layer:
 *
 *  - The PURE core ({@link keyStateToInputs}, {@link buildInputFrame}) is fully
 *    headlessly testable. It maps a set of currently-pressed keys to a
 *    `CarInputs` through the {@link KeyBindings} shape owned by the Settings
 *    screen, and builds an `InputFrame` from a tick + the prior local-state
 *    bytes supplied by the caller.
 *  - The browser layer ({@link InputHandler}) only tracks the live key-state
 *    set and wires `keydown`/`keyup` via {@link InputHandler.attach} /
 *    {@link InputHandler.detach}. It delegates all mapping to the pure core.
 *
 * The CRC-32 is the shared codec implementation re-exported from
 * `@deathtrack/shared`; it is not reimplemented here.
 */

import { crc32, type CarInputs, type InputFrame } from '@deathtrack/shared';
import {
  DEFAULT_KEY_BINDINGS,
  type BindableAction,
  type KeyBindings,
} from './ui/Settings.js';

// ---------------------------------------------------------------------------
// Pure core — key state → CarInputs
// ---------------------------------------------------------------------------

/**
 * The neutral input applied when no bound key is pressed: no throttle, no
 * brake, centred steering, and no weapons.
 */
export const NEUTRAL_INPUTS: CarInputs = {
  throttle: 0,
  brake: 0,
  steer: 0,
  fireForward: false,
  fireRear: false,
};

/**
 * Returns whether the key currently bound to `action` is present in
 * `keyState`. An action with an empty binding (cleared via the Settings screen)
 * is never considered pressed, so an unbound key press cannot trigger it.
 */
function isActionActive(
  action: BindableAction,
  keyState: ReadonlySet<string>,
  bindings: KeyBindings,
): boolean {
  const key = bindings[action];
  if (!key) return false;
  return keyState.has(key);
}

/**
 * Maps the set of currently-pressed keys to a shared {@link CarInputs} using the
 * supplied configurable {@link KeyBindings}. Pure and DOM-free.
 *
 * Mapping:
 *  - `accelerate`  → `throttle` = 1
 *  - `brake`       → `brake` = 1
 *  - `steerLeft`   → contributes -1 to `steer`
 *  - `steerRight`  → contributes +1 to `steer`
 *  - `fireForward` → `fireForward` = true
 *  - `fireRear`    → `fireRear` = true
 *
 * Steering resolves as `right - left`, so pressing left and right
 * simultaneously cancels to centred (`0`); pressing only one yields `-1` or
 * `+1`. Throttle and brake are independent, so a player may hold both at once
 * (the physics step decides how opposing throttle/brake resolve).
 */
export function keyStateToInputs(
  keyState: ReadonlySet<string>,
  bindings: KeyBindings = DEFAULT_KEY_BINDINGS,
): CarInputs {
  const left = isActionActive('steerLeft', keyState, bindings);
  const right = isActionActive('steerRight', keyState, bindings);
  const steer = (right ? 1 : 0) - (left ? 1 : 0);

  return {
    throttle: isActionActive('accelerate', keyState, bindings) ? 1 : 0,
    brake: isActionActive('brake', keyState, bindings) ? 1 : 0,
    steer,
    fireForward: isActionActive('fireForward', keyState, bindings),
    fireRear: isActionActive('fireRear', keyState, bindings),
  };
}

// ---------------------------------------------------------------------------
// Pure core — InputFrame construction
// ---------------------------------------------------------------------------

/**
 * Builds a shared {@link InputFrame} for transmission to the server.
 *
 * The `checksum` field is the CRC-32 (shared codec implementation) of the
 * caller-supplied `priorStateBytes` — the serialised local car state from the
 * previous tick — which the server uses to detect desync (Req 8.5,
 * design.md). The caller owns serialisation of its prior state; this function
 * simply hashes whatever bytes it is handed, so an empty buffer (e.g. on the
 * very first tick) yields the CRC-32 of no bytes.
 *
 * Pure: no DOM, no clock, no mutation of inputs.
 */
export function buildInputFrame(
  tick: number,
  inputs: CarInputs,
  priorStateBytes: Uint8Array,
): InputFrame {
  return {
    tick,
    inputs,
    checksum: crc32(priorStateBytes),
  };
}

// ---------------------------------------------------------------------------
// Browser-only wiring layer
// ---------------------------------------------------------------------------

/**
 * The minimal slice of the DOM the {@link InputHandler} attaches its listeners
 * to. Declared structurally so the handler can be unit-tested against a fake
 * target without a real `window`/`document`.
 */
export interface KeyEventTarget {
  addEventListener(
    type: 'keydown' | 'keyup',
    listener: (event: KeyboardEvent) => void,
  ): void;
  removeEventListener(
    type: 'keydown' | 'keyup',
    listener: (event: KeyboardEvent) => void,
  ): void;
}

/**
 * Tracks live keyboard state and produces {@link CarInputs} / {@link InputFrame}
 * values from it. The DOM event wiring is confined to {@link attach} /
 * {@link detach}; everything else delegates to the pure core above so the class
 * is exercisable headlessly by feeding it {@link handleKeyDown} /
 * {@link handleKeyup} or by seeding {@link setKeyState}.
 *
 * Key bindings are configurable at runtime via {@link setBindings} to reflect
 * changes made on the Settings screen.
 */
export class InputHandler {
  /** The physical keys currently held down (keyed by `KeyboardEvent.code`). */
  private readonly keyState = new Set<string>();
  private bindings: KeyBindings;
  private target: KeyEventTarget | null = null;

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.handleKeyDown(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.handleKeyUp(event.code);
  };

  constructor(bindings: KeyBindings = { ...DEFAULT_KEY_BINDINGS }) {
    this.bindings = bindings;
  }

  /**
   * Begins listening for `keydown`/`keyup` on `target` (defaults to the global
   * `window` when available). Idempotent per target: attaching again after a
   * {@link detach} re-wires cleanly. Throws if no target is available.
   */
  attach(target?: KeyEventTarget): void {
    const resolved =
      target ??
      (typeof window !== 'undefined' ? (window as unknown as KeyEventTarget) : null);
    if (!resolved) {
      throw new Error('InputHandler.attach: no event target available');
    }
    if (this.target) this.detach();
    this.target = resolved;
    resolved.addEventListener('keydown', this.onKeyDown);
    resolved.addEventListener('keyup', this.onKeyUp);
  }

  /**
   * Stops listening for keyboard events and clears the tracked key state so a
   * detached handler reports neutral input.
   */
  detach(): void {
    if (this.target) {
      this.target.removeEventListener('keydown', this.onKeyDown);
      this.target.removeEventListener('keyup', this.onKeyUp);
      this.target = null;
    }
    this.keyState.clear();
  }

  /** Records `key` (a `KeyboardEvent.code`) as pressed. */
  handleKeyDown(key: string): void {
    this.keyState.add(key);
  }

  /** Records `key` (a `KeyboardEvent.code`) as released. */
  handleKeyUp(key: string): void {
    this.keyState.delete(key);
  }

  /** Replaces the tracked key state wholesale (test/seed helper). */
  setKeyState(keys: Iterable<string>): void {
    this.keyState.clear();
    for (const key of keys) this.keyState.add(key);
  }

  /** A read-only snapshot of the currently-pressed keys. */
  getKeyState(): ReadonlySet<string> {
    return new Set(this.keyState);
  }

  /**
   * Replaces the active key bindings (e.g. after the player rebinds a control
   * on the Settings screen). Subsequent {@link sampleInputs} calls use the new
   * mapping immediately.
   */
  setBindings(bindings: KeyBindings): void {
    this.bindings = bindings;
  }

  /** The current key bindings. */
  getBindings(): KeyBindings {
    return this.bindings;
  }

  /** Samples the current key state into a {@link CarInputs} via the pure core. */
  sampleInputs(): CarInputs {
    return keyStateToInputs(this.keyState, this.bindings);
  }

  /**
   * Samples the current inputs and packages them into an {@link InputFrame} for
   * `tick`, with `checksum` set to the CRC-32 of `priorStateBytes` (the prior
   * tick's serialised local state).
   */
  buildFrame(tick: number, priorStateBytes: Uint8Array): InputFrame {
    return buildInputFrame(tick, this.sampleInputs(), priorStateBytes);
  }
}
