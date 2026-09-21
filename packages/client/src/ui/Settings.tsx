import { Container, Graphics, Text, TextStyle } from 'pixi.js';
import type { AudioSettings } from '../audio/AudioSettings.js';

/**
 * Settings screen (task 17.4).
 *
 * Requirement 11.4: the game provides a settings screen letting the player
 * configure display resolution, audio volume, key bindings, and network
 * options.
 *
 * Following the established client UI convention (see {@link MainMenu} and
 * {@link RaceResults}), the on-screen game UI is built from PixiJS
 * {@link Container} scene graphs rather than DOM/React trees. The `.tsx`
 * extension is retained only for naming consistency with the spec; no JSX is
 * used.
 *
 * The design deliberately separates a pure, GPU-free *settings model* (the
 * {@link SettingsModel} value, its update/validation functions, and the flat
 * list of {@link SettingsControlRow} descriptors) from the actual GPU draw
 * calls. The model half performs all clamping, option cycling and key-binding
 * mutation and is fully unit-testable in a headless `node` environment; the
 * {@link Settings} PixiJS overlay only consumes the already-computed rows to
 * draw them. The draw path requires a WebGL context and is validated in the
 * browser, not in unit tests.
 *
 * The music/SFX toggles are wired to the audio seam created by task 16.3
 * ({@link applyAudioSettings}) through an injected callback
 * ({@link SettingsHandlers.onAudioSettingsChange}) so the wiring stays testable
 * without a live AudioSystem.
 */

// ---------------------------------------------------------------------------
// Display resolution
// ---------------------------------------------------------------------------

/** A selectable display resolution, in logical pixels. */
export interface Resolution {
  readonly width: number;
  readonly height: number;
}

/**
 * The resolutions offered by the settings screen, in display order. The first
 * entry is the default. These match the fixed 4:3 playfield the renderer is
 * designed around while offering common upscaled sizes.
 */
export const RESOLUTION_OPTIONS: readonly Resolution[] = [
  { width: 640, height: 480 },
  { width: 800, height: 600 },
  { width: 1024, height: 768 },
  { width: 1280, height: 960 },
] as const;

/** Renders a resolution as a `WIDTHxHEIGHT` string, e.g. `640x480`. */
export function formatResolution(resolution: Resolution): string {
  return `${resolution.width}x${resolution.height}`;
}

/**
 * Returns the index of `resolution` within {@link RESOLUTION_OPTIONS}, matching
 * by width and height. Returns `-1` when the value is not one of the offered
 * options.
 */
export function resolutionOptionIndex(resolution: Resolution): number {
  return RESOLUTION_OPTIONS.findIndex(
    (r) => r.width === resolution.width && r.height === resolution.height,
  );
}

// ---------------------------------------------------------------------------
// Key bindings
// ---------------------------------------------------------------------------

/**
 * The bindable control actions, in display order. These mirror the
 * controllable fields of the shared `CarInputs` (throttle / brake / steer /
 * forward + rear fire); steering is split into discrete left/right keys for
 * keyboard control. This ordering is the single source of truth shared by the
 * pure model and the rendered screen.
 */
export const BINDABLE_ACTIONS = [
  'accelerate',
  'brake',
  'steerLeft',
  'steerRight',
  'fireForward',
  'fireRear',
] as const;

/** Identifier for a single bindable control action. */
export type BindableAction = (typeof BINDABLE_ACTIONS)[number];

/** Human-readable labels for each bindable action. */
export const BINDABLE_ACTION_LABELS: Record<BindableAction, string> = {
  accelerate: 'Accelerate',
  brake: 'Brake',
  steerLeft: 'Steer Left',
  steerRight: 'Steer Right',
  fireForward: 'Fire Forward',
  fireRear: 'Deploy Rear',
};

/** A map from each bindable action to the key that triggers it. */
export type KeyBindings = Record<BindableAction, string>;

/** The default keyboard layout applied when no saved bindings exist. */
export const DEFAULT_KEY_BINDINGS: KeyBindings = {
  accelerate: 'ArrowUp',
  brake: 'ArrowDown',
  steerLeft: 'ArrowLeft',
  steerRight: 'ArrowRight',
  fireForward: 'Space',
  fireRear: 'ControlLeft',
};

// ---------------------------------------------------------------------------
// Network options
// ---------------------------------------------------------------------------

/** Player-configurable network options. */
export interface NetworkOptions {
  /**
   * Server host/address the client connects to when joining a session. Trimmed
   * of surrounding whitespace by {@link setServerHost}.
   */
  readonly serverHost: string;
  /** Server port. Clamped to the valid TCP/UDP range [1, 65535]. */
  readonly serverPort: number;
  /**
   * Whether to interpolate remote participants' state for smoother rendering.
   * When off, remote state snaps to the latest received snapshot.
   */
  readonly interpolationEnabled: boolean;
}

/** Default network options: localhost with interpolation enabled. */
export const DEFAULT_NETWORK_OPTIONS: NetworkOptions = {
  serverHost: 'localhost',
  serverPort: 8080,
  interpolationEnabled: true,
};

/** Lowest and highest valid network port. */
export const MIN_PORT = 1;
export const MAX_PORT = 65535;

// ---------------------------------------------------------------------------
// Settings model
// ---------------------------------------------------------------------------

/**
 * The complete, serialisable settings value. This is a plain immutable data
 * object with no PixiJS dependency; every mutation goes through one of the pure
 * update functions below, each of which returns a new {@link SettingsModel}.
 */
export interface SettingsModel {
  readonly resolution: Resolution;
  /** Background music volume, always within [0, 1]. */
  readonly musicVolume: number;
  /** Sound-effects volume, always within [0, 1]. */
  readonly sfxVolume: number;
  /** Whether background music is enabled (wired to the audio seam). */
  readonly musicEnabled: boolean;
  /** Whether sound effects are enabled (wired to the audio seam). */
  readonly sfxEnabled: boolean;
  readonly keyBindings: KeyBindings;
  readonly network: NetworkOptions;
}

/** The out-of-the-box settings used before any player customisation. */
export const DEFAULT_SETTINGS: SettingsModel = {
  resolution: RESOLUTION_OPTIONS[0]!,
  musicVolume: 0.8,
  sfxVolume: 0.8,
  musicEnabled: true,
  sfxEnabled: true,
  keyBindings: { ...DEFAULT_KEY_BINDINGS },
  network: { ...DEFAULT_NETWORK_OPTIONS },
};

/** Clamps `value` to the closed interval [0, 1]. Non-finite input becomes 0. */
export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/** Clamps a port number to the integer range [MIN_PORT, MAX_PORT]. */
export function clampPort(value: number): number {
  if (!Number.isFinite(value)) return MIN_PORT;
  const truncated = Math.trunc(value);
  if (truncated < MIN_PORT) return MIN_PORT;
  if (truncated > MAX_PORT) return MAX_PORT;
  return truncated;
}

/**
 * Returns a copy of `model` with the music volume clamped to [0, 1]. Pure.
 */
export function setMusicVolume(model: SettingsModel, volume: number): SettingsModel {
  return { ...model, musicVolume: clampVolume(volume) };
}

/** Returns a copy of `model` with the SFX volume clamped to [0, 1]. Pure. */
export function setSfxVolume(model: SettingsModel, volume: number): SettingsModel {
  return { ...model, sfxVolume: clampVolume(volume) };
}

/** Returns a copy of `model` with music enabled/disabled. Pure. */
export function setMusicEnabled(model: SettingsModel, enabled: boolean): SettingsModel {
  return { ...model, musicEnabled: enabled };
}

/** Returns a copy of `model` with SFX enabled/disabled. Pure. */
export function setSfxEnabled(model: SettingsModel, enabled: boolean): SettingsModel {
  return { ...model, sfxEnabled: enabled };
}

/**
 * Extracts the {@link AudioSettings} slice consumed by the audio seam
 * (task 16.3). Used to forward toggle changes to `applyAudioSettings`.
 */
export function toAudioSettings(model: SettingsModel): AudioSettings {
  return { musicEnabled: model.musicEnabled, sfxEnabled: model.sfxEnabled };
}

/**
 * Returns a copy of `model` with the display resolution set to the option at
 * `index` in {@link RESOLUTION_OPTIONS}. An out-of-range index leaves the
 * resolution unchanged. Pure.
 */
export function setResolutionByIndex(model: SettingsModel, index: number): SettingsModel {
  const option = RESOLUTION_OPTIONS[index];
  if (!option) return model;
  return { ...model, resolution: option };
}

/**
 * Returns a copy of `model` with the resolution advanced to the next option in
 * {@link RESOLUTION_OPTIONS}, wrapping around after the last. If the current
 * resolution is not a known option, selection starts at the first option.
 * Pure.
 */
export function cycleResolution(model: SettingsModel): SettingsModel {
  const current = resolutionOptionIndex(model.resolution);
  const next = (current + 1) % RESOLUTION_OPTIONS.length;
  return { ...model, resolution: RESOLUTION_OPTIONS[next]! };
}

/**
 * Returns a copy of `model` with `action` rebound to `key`. Pure.
 *
 * If `key` is already bound to a different action, that other action is cleared
 * (set to the empty string) so a physical key never triggers two actions at
 * once. Rebinding an action to the key it already holds is a no-op copy.
 */
export function rebindKey(
  model: SettingsModel,
  action: BindableAction,
  key: string,
): SettingsModel {
  const keyBindings: KeyBindings = { ...model.keyBindings };
  for (const other of BINDABLE_ACTIONS) {
    if (other !== action && keyBindings[other] === key) {
      keyBindings[other] = '';
    }
  }
  keyBindings[action] = key;
  return { ...model, keyBindings };
}

/** Returns a copy of `model` with the server host set (trimmed). Pure. */
export function setServerHost(model: SettingsModel, host: string): SettingsModel {
  return { ...model, network: { ...model.network, serverHost: host.trim() } };
}

/**
 * Returns a copy of `model` with the server port clamped to
 * [MIN_PORT, MAX_PORT]. Pure.
 */
export function setServerPort(model: SettingsModel, port: number): SettingsModel {
  return { ...model, network: { ...model.network, serverPort: clampPort(port) } };
}

/** Returns a copy of `model` with remote-state interpolation toggled. Pure. */
export function setInterpolationEnabled(
  model: SettingsModel,
  enabled: boolean,
): SettingsModel {
  return { ...model, network: { ...model.network, interpolationEnabled: enabled } };
}

// ---------------------------------------------------------------------------
// Control rows (pure descriptor model, GPU-free)
// ---------------------------------------------------------------------------

/** The kind of control a settings row represents. */
export type SettingsControlKind = 'cycle' | 'slider' | 'toggle' | 'keybind' | 'text';

/**
 * A pure description of one settings row: its label, the kind of control, and
 * the current value formatted for display. Contains no PixiJS display objects,
 * so the full screen layout can be built and asserted headlessly.
 */
export interface SettingsControlRow {
  /** Stable identifier for the setting this row edits. */
  readonly id: string;
  /** Human-readable label shown on the left. */
  readonly label: string;
  /** Which control widget renders on the right. */
  readonly kind: SettingsControlKind;
  /** The current value rendered as display text (e.g. `640x480`, `80%`, `On`). */
  readonly valueText: string;
  /**
   * Normalised fill fraction in [0, 1] for `slider` rows; `undefined` for other
   * kinds. Lets the overlay draw the slider without re-deriving the value.
   */
  readonly fill?: number;
}

/** Formats a [0, 1] volume as a whole-number percentage string, e.g. `80%`. */
export function formatVolumePercent(volume: number): string {
  return `${Math.round(clampVolume(volume) * 100)}%`;
}

/** Formats an on/off boolean as `On` / `Off`. */
export function formatToggle(on: boolean): string {
  return on ? 'On' : 'Off';
}

/**
 * Builds the flat, ordered list of control rows describing the entire settings
 * screen from a {@link SettingsModel}. Pure and GPU-free.
 *
 * Row order: display resolution, music volume, SFX volume, music toggle, SFX
 * toggle, one key-binding row per {@link BINDABLE_ACTIONS} entry, then the
 * network options (host, port, interpolation).
 */
export function buildSettingsRows(model: SettingsModel): SettingsControlRow[] {
  const rows: SettingsControlRow[] = [
    {
      id: 'resolution',
      label: 'Resolution',
      kind: 'cycle',
      valueText: formatResolution(model.resolution),
    },
    {
      id: 'musicVolume',
      label: 'Music Volume',
      kind: 'slider',
      valueText: formatVolumePercent(model.musicVolume),
      fill: clampVolume(model.musicVolume),
    },
    {
      id: 'sfxVolume',
      label: 'SFX Volume',
      kind: 'slider',
      valueText: formatVolumePercent(model.sfxVolume),
      fill: clampVolume(model.sfxVolume),
    },
    {
      id: 'musicEnabled',
      label: 'Music',
      kind: 'toggle',
      valueText: formatToggle(model.musicEnabled),
    },
    {
      id: 'sfxEnabled',
      label: 'Sound Effects',
      kind: 'toggle',
      valueText: formatToggle(model.sfxEnabled),
    },
  ];

  for (const action of BINDABLE_ACTIONS) {
    rows.push({
      id: `key:${action}`,
      label: BINDABLE_ACTION_LABELS[action],
      kind: 'keybind',
      valueText: model.keyBindings[action] || '(unbound)',
    });
  }

  rows.push(
    {
      id: 'serverHost',
      label: 'Server Host',
      kind: 'text',
      valueText: model.network.serverHost || '(none)',
    },
    {
      id: 'serverPort',
      label: 'Server Port',
      kind: 'text',
      valueText: String(model.network.serverPort),
    },
    {
      id: 'interpolationEnabled',
      label: 'Interpolation',
      kind: 'toggle',
      valueText: formatToggle(model.network.interpolationEnabled),
    },
  );

  return rows;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Callbacks the settings screen invokes as the player edits values. Injecting
 * these decouples the screen from the application state and, critically, keeps
 * the audio-seam wiring testable without a live AudioSystem.
 */
export interface SettingsHandlers {
  /**
   * Invoked whenever the settings value changes, with the new model. The host
   * persists it and/or applies it (e.g. resizing the renderer).
   */
  onChange?: (model: SettingsModel) => void;
  /**
   * Invoked when a music/SFX toggle changes, with the audio-settings slice.
   * The host forwards this to `applyAudioSettings(audioSystem, settings)` so the
   * change takes effect within one rendered frame (requirement 10.5). Kept as a
   * plain callback so the wiring is unit-testable.
   */
  onAudioSettingsChange?: (settings: AudioSettings) => void;
  /** Invoked when the player leaves the settings screen. */
  onClose?: () => void;
}

// ---------------------------------------------------------------------------
// PixiJS overlay (browser-only draw path)
// ---------------------------------------------------------------------------

const PANEL_WIDTH = 560;
const PADDING = 24;
const HEADER_HEIGHT = 44;
const ROW_HEIGHT = 30;
const LABEL_X = 0;
const VALUE_X = 320;
const SLIDER_WIDTH = 180;

/**
 * The PixiJS settings screen. A self-contained {@link Container} that draws a
 * table of every configurable setting derived from a {@link SettingsModel} via
 * {@link buildSettingsRows}.
 *
 * Construction is GPU-free — PixiJS display objects instantiate without a WebGL
 * context — so the overlay can be created headlessly; only attaching it to a
 * live stage and presenting it requires a renderer. Value mutation happens
 * through the pure update functions above; call {@link Settings.setModel} to
 * re-render after a change.
 */
export class Settings extends Container {
  private model: SettingsModel;
  private readonly handlers: SettingsHandlers;
  private readonly body: Container;

  constructor(model: SettingsModel = DEFAULT_SETTINGS, handlers: SettingsHandlers = {}) {
    super();
    this.label = 'settings';
    this.model = model;
    this.handlers = handlers;
    this.body = new Container();
    this.body.label = 'settings:body';
    this.addChild(this.body);
    this.draw();
  }

  /** The current settings value (read-only view). */
  getModel(): SettingsModel {
    return this.model;
  }

  /**
   * Replaces the settings value and re-renders. Fires {@link SettingsHandlers.onChange}
   * and, when the audio toggles changed, {@link SettingsHandlers.onAudioSettingsChange}
   * so the audio seam applies the new toggle state.
   */
  setModel(next: SettingsModel): void {
    const prev = this.model;
    this.model = next;
    this.handlers.onChange?.(next);
    if (
      prev.musicEnabled !== next.musicEnabled ||
      prev.sfxEnabled !== next.sfxEnabled
    ) {
      this.handlers.onAudioSettingsChange?.(toAudioSettings(next));
    }
    this.draw();
  }

  private draw(): void {
    this.body.removeChildren().forEach((child) => child.destroy({ children: true }));

    const rows = buildSettingsRows(this.model);
    const bodyHeight = rows.length * ROW_HEIGHT;
    const panelHeight = HEADER_HEIGHT + bodyHeight + PADDING * 2;

    const panel = new Graphics();
    panel
      .roundRect(0, 0, PANEL_WIDTH, panelHeight, 8)
      .fill({ color: 0x0a0a12, alpha: 0.92 })
      .stroke({ color: 0x3355aa, width: 2 });
    this.body.addChild(panel);

    const titleStyle = new TextStyle({
      fill: 0xffcc33,
      fontFamily: 'monospace',
      fontSize: 22,
      fontWeight: 'bold',
    });
    const title = new Text({ text: 'SETTINGS', style: titleStyle });
    title.position.set(PADDING, PADDING - 6);
    this.body.addChild(title);

    const labelStyle = new TextStyle({
      fill: 0xffffff,
      fontFamily: 'monospace',
      fontSize: 14,
    });
    const valueStyle = new TextStyle({
      fill: 0x88ccff,
      fontFamily: 'monospace',
      fontSize: 14,
    });

    rows.forEach((row, index) => {
      const y = PADDING + HEADER_HEIGHT + index * ROW_HEIGHT;

      const label = new Text({ text: row.label, style: labelStyle });
      label.position.set(PADDING + LABEL_X, y);
      this.body.addChild(label);

      if (row.kind === 'slider') {
        this.drawSlider(PADDING + VALUE_X, y, row.fill ?? 0);
      }

      const value = new Text({ text: row.valueText, style: valueStyle });
      value.position.set(PADDING + VALUE_X + SLIDER_WIDTH + 12, y);
      this.body.addChild(value);
    });
  }

  private drawSlider(x: number, y: number, fill: number): void {
    const track = new Graphics();
    track
      .roundRect(x, y + 6, SLIDER_WIDTH, 8, 4)
      .fill({ color: 0x223047 })
      .stroke({ color: 0x3355aa, width: 1 });
    const filled = Math.max(0, Math.min(1, fill)) * SLIDER_WIDTH;
    if (filled > 0) {
      track.roundRect(x, y + 6, filled, 8, 4).fill({ color: 0x33aaff });
    }
    this.body.addChild(track);
  }
}
