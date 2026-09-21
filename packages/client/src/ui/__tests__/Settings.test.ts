import { describe, expect, it } from 'vitest';
import type { AudioSettings } from '../../audio/AudioSettings';
import {
  BINDABLE_ACTIONS,
  BINDABLE_ACTION_LABELS,
  DEFAULT_KEY_BINDINGS,
  DEFAULT_NETWORK_OPTIONS,
  DEFAULT_SETTINGS,
  MAX_PORT,
  MIN_PORT,
  RESOLUTION_OPTIONS,
  buildSettingsRows,
  clampPort,
  clampVolume,
  cycleResolution,
  formatResolution,
  formatToggle,
  formatVolumePercent,
  rebindKey,
  resolutionOptionIndex,
  setInterpolationEnabled,
  setMusicEnabled,
  setMusicVolume,
  setResolutionByIndex,
  setServerHost,
  setServerPort,
  setSfxEnabled,
  setSfxVolume,
  toAudioSettings,
  type SettingsModel,
} from '../Settings';

/**
 * These tests exercise only the GPU-free settings *model*: clamping,
 * resolution option handling, key-binding mutation, network option updates, the
 * audio-seam slice, and the flat control-row descriptors. None of this needs a
 * WebGL context, so it runs headless in the `node` vitest environment.
 *
 * The PixiJS `Settings` overlay draw path requires a renderer and is validated
 * in the browser, not here.
 *
 * Validates: Requirements 11.4 (settings screen: display resolution, audio
 * volume, key bindings, network options) and 10.5 (music/SFX toggle wiring to
 * the audio seam).
 */

describe('clampVolume', () => {
  it('passes through values already within [0, 1]', () => {
    expect(clampVolume(0)).toBe(0);
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(1)).toBe(1);
  });

  it('clamps out-of-range values to the [0, 1] interval', () => {
    expect(clampVolume(-0.3)).toBe(0);
    expect(clampVolume(1.7)).toBe(1);
  });

  it('maps non-finite input to 0', () => {
    expect(clampVolume(Number.NaN)).toBe(0);
    expect(clampVolume(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clampVolume(Number.NEGATIVE_INFINITY)).toBe(0);
  });
});

describe('clampPort', () => {
  it('keeps ports within [MIN_PORT, MAX_PORT]', () => {
    expect(clampPort(8080)).toBe(8080);
    expect(clampPort(MIN_PORT)).toBe(MIN_PORT);
    expect(clampPort(MAX_PORT)).toBe(MAX_PORT);
  });

  it('clamps and truncates out-of-range / fractional ports', () => {
    expect(clampPort(0)).toBe(MIN_PORT);
    expect(clampPort(70000)).toBe(MAX_PORT);
    expect(clampPort(8080.9)).toBe(8080);
    expect(clampPort(Number.NaN)).toBe(MIN_PORT);
  });
});

describe('setMusicVolume / setSfxVolume', () => {
  it('clamps volumes into [0, 1] and returns a new object', () => {
    const a = setMusicVolume(DEFAULT_SETTINGS, 2);
    expect(a.musicVolume).toBe(1);
    expect(a).not.toBe(DEFAULT_SETTINGS);

    const b = setSfxVolume(DEFAULT_SETTINGS, -1);
    expect(b.sfxVolume).toBe(0);
  });

  it('does not mutate the input model', () => {
    const snapshot = { ...DEFAULT_SETTINGS };
    setMusicVolume(DEFAULT_SETTINGS, 0.25);
    expect(DEFAULT_SETTINGS.musicVolume).toBe(snapshot.musicVolume);
  });
});

describe('audio toggles and seam slice', () => {
  it('toggles music and sfx independently', () => {
    const noMusic = setMusicEnabled(DEFAULT_SETTINGS, false);
    expect(noMusic.musicEnabled).toBe(false);
    expect(noMusic.sfxEnabled).toBe(true);

    const noSfx = setSfxEnabled(DEFAULT_SETTINGS, false);
    expect(noSfx.sfxEnabled).toBe(false);
    expect(noSfx.musicEnabled).toBe(true);
  });

  it('extracts the AudioSettings slice consumed by the audio seam', () => {
    const model = setSfxEnabled(setMusicEnabled(DEFAULT_SETTINGS, false), true);
    const slice: AudioSettings = toAudioSettings(model);
    expect(slice).toEqual({ musicEnabled: false, sfxEnabled: true });
  });
});

describe('resolution options', () => {
  it('offers a non-empty list defaulting to the first option', () => {
    expect(RESOLUTION_OPTIONS.length).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.resolution).toEqual(RESOLUTION_OPTIONS[0]);
  });

  it('formats a resolution as WIDTHxHEIGHT', () => {
    expect(formatResolution({ width: 640, height: 480 })).toBe('640x480');
  });

  it('finds the index of a known option and -1 for unknown', () => {
    expect(resolutionOptionIndex(RESOLUTION_OPTIONS[1]!)).toBe(1);
    expect(resolutionOptionIndex({ width: 1, height: 1 })).toBe(-1);
  });

  it('sets a resolution by index and ignores out-of-range indices', () => {
    const set = setResolutionByIndex(DEFAULT_SETTINGS, 2);
    expect(set.resolution).toEqual(RESOLUTION_OPTIONS[2]);
    expect(setResolutionByIndex(DEFAULT_SETTINGS, 99)).toEqual(DEFAULT_SETTINGS);
  });

  it('cycles resolution and wraps after the last option', () => {
    let model: SettingsModel = { ...DEFAULT_SETTINGS, resolution: RESOLUTION_OPTIONS[0]! };
    for (let i = 1; i < RESOLUTION_OPTIONS.length; i++) {
      model = cycleResolution(model);
      expect(model.resolution).toEqual(RESOLUTION_OPTIONS[i]);
    }
    model = cycleResolution(model);
    expect(model.resolution).toEqual(RESOLUTION_OPTIONS[0]);
  });

  it('starts cycling from the first option when the current one is unknown', () => {
    const model: SettingsModel = { ...DEFAULT_SETTINGS, resolution: { width: 1, height: 1 } };
    expect(cycleResolution(model).resolution).toEqual(RESOLUTION_OPTIONS[0]);
  });
});

describe('key bindings', () => {
  it('provides a default key for every bindable action', () => {
    for (const action of BINDABLE_ACTIONS) {
      expect(DEFAULT_KEY_BINDINGS[action]).toBeTruthy();
      expect(BINDABLE_ACTION_LABELS[action]).toBeTruthy();
    }
  });

  it('rebinds an action to a new key', () => {
    const model = rebindKey(DEFAULT_SETTINGS, 'accelerate', 'KeyW');
    expect(model.keyBindings.accelerate).toBe('KeyW');
    expect(model).not.toBe(DEFAULT_SETTINGS);
  });

  it('clears a conflicting binding so a key never triggers two actions', () => {
    // brake defaults to ArrowDown; bind accelerate to ArrowDown too.
    const model = rebindKey(DEFAULT_SETTINGS, 'accelerate', DEFAULT_KEY_BINDINGS.brake);
    expect(model.keyBindings.accelerate).toBe(DEFAULT_KEY_BINDINGS.brake);
    expect(model.keyBindings.brake).toBe('');
  });

  it('does not mutate the source key bindings', () => {
    rebindKey(DEFAULT_SETTINGS, 'brake', 'KeyS');
    expect(DEFAULT_SETTINGS.keyBindings.brake).toBe(DEFAULT_KEY_BINDINGS.brake);
  });
});

describe('network options', () => {
  it('has sensible defaults', () => {
    expect(DEFAULT_SETTINGS.network).toEqual(DEFAULT_NETWORK_OPTIONS);
  });

  it('trims the server host', () => {
    expect(setServerHost(DEFAULT_SETTINGS, '  example.com  ').network.serverHost).toBe(
      'example.com',
    );
  });

  it('clamps the server port', () => {
    expect(setServerPort(DEFAULT_SETTINGS, 100000).network.serverPort).toBe(MAX_PORT);
    expect(setServerPort(DEFAULT_SETTINGS, -5).network.serverPort).toBe(MIN_PORT);
  });

  it('toggles interpolation without touching other network fields', () => {
    const off = setInterpolationEnabled(DEFAULT_SETTINGS, false);
    expect(off.network.interpolationEnabled).toBe(false);
    expect(off.network.serverHost).toBe(DEFAULT_SETTINGS.network.serverHost);
    expect(off.network.serverPort).toBe(DEFAULT_SETTINGS.network.serverPort);
  });
});

describe('formatters', () => {
  it('renders volume as a whole percentage', () => {
    expect(formatVolumePercent(0)).toBe('0%');
    expect(formatVolumePercent(0.8)).toBe('80%');
    expect(formatVolumePercent(1)).toBe('100%');
    expect(formatVolumePercent(1.5)).toBe('100%');
  });

  it('renders toggles as On/Off', () => {
    expect(formatToggle(true)).toBe('On');
    expect(formatToggle(false)).toBe('Off');
  });
});

describe('buildSettingsRows', () => {
  it('includes resolution, both volume sliders, both audio toggles, all key binds, and network options', () => {
    const rows = buildSettingsRows(DEFAULT_SETTINGS);
    const ids = rows.map((r) => r.id);

    expect(ids).toContain('resolution');
    expect(ids).toContain('musicVolume');
    expect(ids).toContain('sfxVolume');
    expect(ids).toContain('musicEnabled');
    expect(ids).toContain('sfxEnabled');
    for (const action of BINDABLE_ACTIONS) {
      expect(ids).toContain(`key:${action}`);
    }
    expect(ids).toContain('serverHost');
    expect(ids).toContain('serverPort');
    expect(ids).toContain('interpolationEnabled');
  });

  it('marks volume rows as sliders with a matching fill fraction', () => {
    const model = setMusicVolume(DEFAULT_SETTINGS, 0.5);
    const rows = buildSettingsRows(model);
    const music = rows.find((r) => r.id === 'musicVolume')!;
    expect(music.kind).toBe('slider');
    expect(music.fill).toBe(0.5);
    expect(music.valueText).toBe('50%');
  });

  it('shows the current resolution as a cycle control', () => {
    const rows = buildSettingsRows(setResolutionByIndex(DEFAULT_SETTINGS, 1));
    const res = rows.find((r) => r.id === 'resolution')!;
    expect(res.kind).toBe('cycle');
    expect(res.valueText).toBe(formatResolution(RESOLUTION_OPTIONS[1]!));
  });

  it('shows an unbound key binding with a placeholder', () => {
    // Rebinding brake onto accelerate's key clears accelerate, leaving it unbound.
    const model = rebindKey(DEFAULT_SETTINGS, 'brake', DEFAULT_KEY_BINDINGS.accelerate);
    const rows = buildSettingsRows(model);
    const accelerate = rows.find((r) => r.id === 'key:accelerate')!;
    expect(accelerate.valueText).toBe('(unbound)');
  });
});
