import { describe, expect, it } from 'vitest';
import { crc32, type CarInputs } from '@deathtrack/shared';
import {
  DEFAULT_KEY_BINDINGS,
  type KeyBindings,
} from '../ui/Settings.js';
import {
  InputHandler,
  NEUTRAL_INPUTS,
  buildInputFrame,
  keyStateToInputs,
  type KeyEventTarget,
} from '../InputHandler.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** A minimal fake DOM target that records listeners and can dispatch events. */
class FakeTarget implements KeyEventTarget {
  private readonly down = new Set<(e: KeyboardEvent) => void>();
  private readonly up = new Set<(e: KeyboardEvent) => void>();

  addEventListener(type: 'keydown' | 'keyup', listener: (e: KeyboardEvent) => void): void {
    (type === 'keydown' ? this.down : this.up).add(listener);
  }

  removeEventListener(
    type: 'keydown' | 'keyup',
    listener: (e: KeyboardEvent) => void,
  ): void {
    (type === 'keydown' ? this.down : this.up).delete(listener);
  }

  press(code: string): void {
    for (const l of this.down) l({ code } as KeyboardEvent);
  }

  release(code: string): void {
    for (const l of this.up) l({ code } as KeyboardEvent);
  }

  get listenerCount(): number {
    return this.down.size + this.up.size;
  }
}

// ---------------------------------------------------------------------------
// keyStateToInputs — each bound key maps to the right CarInputs field
// ---------------------------------------------------------------------------

describe('keyStateToInputs', () => {
  it('produces neutral input when nothing is pressed', () => {
    expect(keyStateToInputs(new Set(), DEFAULT_KEY_BINDINGS)).toEqual(NEUTRAL_INPUTS);
  });

  it('maps accelerate to throttle = 1', () => {
    const inputs = keyStateToInputs(new Set([DEFAULT_KEY_BINDINGS.accelerate]));
    expect(inputs.throttle).toBe(1);
    expect(inputs.brake).toBe(0);
  });

  it('maps brake to brake = 1', () => {
    const inputs = keyStateToInputs(new Set([DEFAULT_KEY_BINDINGS.brake]));
    expect(inputs.brake).toBe(1);
    expect(inputs.throttle).toBe(0);
  });

  it('maps steerLeft to steer = -1', () => {
    const inputs = keyStateToInputs(new Set([DEFAULT_KEY_BINDINGS.steerLeft]));
    expect(inputs.steer).toBe(-1);
  });

  it('maps steerRight to steer = +1', () => {
    const inputs = keyStateToInputs(new Set([DEFAULT_KEY_BINDINGS.steerRight]));
    expect(inputs.steer).toBe(1);
  });

  it('maps fireForward and fireRear to their boolean flags', () => {
    const forward = keyStateToInputs(new Set([DEFAULT_KEY_BINDINGS.fireForward]));
    expect(forward.fireForward).toBe(true);
    expect(forward.fireRear).toBe(false);

    const rear = keyStateToInputs(new Set([DEFAULT_KEY_BINDINGS.fireRear]));
    expect(rear.fireRear).toBe(true);
    expect(rear.fireForward).toBe(false);
  });

  it('handles simultaneous accelerate + fireForward', () => {
    const inputs = keyStateToInputs(
      new Set([DEFAULT_KEY_BINDINGS.accelerate, DEFAULT_KEY_BINDINGS.fireForward]),
    );
    expect(inputs.throttle).toBe(1);
    expect(inputs.fireForward).toBe(true);
  });

  it('resolves steerLeft + steerRight pressed together to centred (0)', () => {
    const inputs = keyStateToInputs(
      new Set([DEFAULT_KEY_BINDINGS.steerLeft, DEFAULT_KEY_BINDINGS.steerRight]),
    );
    expect(inputs.steer).toBe(0);
  });

  it('ignores keys that are not bound to any action', () => {
    const inputs = keyStateToInputs(new Set(['KeyZ', 'F5']));
    expect(inputs).toEqual(NEUTRAL_INPUTS);
  });

  it('rebinding changes which key drives an action', () => {
    const rebound: KeyBindings = { ...DEFAULT_KEY_BINDINGS, accelerate: 'KeyW' };
    // The old key no longer accelerates.
    expect(keyStateToInputs(new Set([DEFAULT_KEY_BINDINGS.accelerate]), rebound).throttle).toBe(0);
    // The new key does.
    expect(keyStateToInputs(new Set(['KeyW']), rebound).throttle).toBe(1);
  });

  it('treats an empty (cleared) binding as never pressed', () => {
    const cleared: KeyBindings = { ...DEFAULT_KEY_BINDINGS, fireRear: '' };
    // An empty key in the state set must not trigger the cleared action.
    const inputs = keyStateToInputs(new Set(['']), cleared);
    expect(inputs.fireRear).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildInputFrame — carries tick and CRC-32 of prior state
// ---------------------------------------------------------------------------

describe('buildInputFrame', () => {
  const sampleInputs: CarInputs = {
    throttle: 1,
    brake: 0,
    steer: -1,
    fireForward: true,
    fireRear: false,
  };

  it('carries the given tick and inputs unchanged', () => {
    const frame = buildInputFrame(42, sampleInputs, new Uint8Array([1, 2, 3]));
    expect(frame.tick).toBe(42);
    expect(frame.inputs).toEqual(sampleInputs);
  });

  it('sets checksum to the shared CRC-32 of the prior state bytes', () => {
    const prior = new Uint8Array([10, 20, 30, 40]);
    const frame = buildInputFrame(7, sampleInputs, prior);
    expect(frame.checksum).toBe(crc32(prior));
  });

  it('uses the CRC-32 of no bytes for an empty prior state', () => {
    const frame = buildInputFrame(0, sampleInputs, new Uint8Array());
    expect(frame.checksum).toBe(crc32(new Uint8Array()));
  });

  it('produces different checksums for different prior state', () => {
    const a = buildInputFrame(1, sampleInputs, new Uint8Array([1]));
    const b = buildInputFrame(1, sampleInputs, new Uint8Array([2]));
    expect(a.checksum).not.toBe(b.checksum);
  });
});

// ---------------------------------------------------------------------------
// InputHandler — browser wiring + delegation to the pure core
// ---------------------------------------------------------------------------

describe('InputHandler', () => {
  it('tracks keydown/keyup via a fake target and samples inputs', () => {
    const handler = new InputHandler();
    const target = new FakeTarget();
    handler.attach(target);

    target.press(DEFAULT_KEY_BINDINGS.accelerate);
    target.press(DEFAULT_KEY_BINDINGS.steerRight);
    expect(handler.sampleInputs()).toMatchObject({ throttle: 1, steer: 1 });

    target.release(DEFAULT_KEY_BINDINGS.steerRight);
    expect(handler.sampleInputs().steer).toBe(0);
  });

  it('detach removes listeners and clears held keys', () => {
    const handler = new InputHandler();
    const target = new FakeTarget();
    handler.attach(target);
    target.press(DEFAULT_KEY_BINDINGS.accelerate);
    expect(target.listenerCount).toBe(2);

    handler.detach();
    expect(target.listenerCount).toBe(0);
    expect(handler.sampleInputs()).toEqual(NEUTRAL_INPUTS);
  });

  it('setKeyState seeds pressed keys headlessly', () => {
    const handler = new InputHandler();
    handler.setKeyState([DEFAULT_KEY_BINDINGS.brake, DEFAULT_KEY_BINDINGS.fireRear]);
    const inputs = handler.sampleInputs();
    expect(inputs.brake).toBe(1);
    expect(inputs.fireRear).toBe(true);
  });

  it('setBindings changes the mapping at runtime', () => {
    const handler = new InputHandler();
    handler.setKeyState(['KeyW']);
    expect(handler.sampleInputs().throttle).toBe(0);

    handler.setBindings({ ...DEFAULT_KEY_BINDINGS, accelerate: 'KeyW' });
    expect(handler.sampleInputs().throttle).toBe(1);
  });

  it('buildFrame packages the sampled inputs with the given tick and prior-state CRC-32', () => {
    const handler = new InputHandler();
    handler.setKeyState([DEFAULT_KEY_BINDINGS.accelerate]);
    const prior = new Uint8Array([9, 9, 9]);
    const frame = handler.buildFrame(123, prior);

    expect(frame.tick).toBe(123);
    expect(frame.inputs.throttle).toBe(1);
    expect(frame.checksum).toBe(crc32(prior));
  });

  it('attach re-wires cleanly after a prior attach (idempotent target swap)', () => {
    const handler = new InputHandler();
    const first = new FakeTarget();
    const second = new FakeTarget();
    handler.attach(first);
    handler.attach(second);
    // First target's listeners were removed; only the second is wired.
    expect(first.listenerCount).toBe(0);
    expect(second.listenerCount).toBe(2);
  });
});
