// packages/client/src/audio/AudioSettings.ts
//
// Pure helper that applies the player's music/SFX toggle preferences to a live
// AudioSystem. This is the seam between the settings UI and the audio engine.
//
// Requirement 10.5: the player may independently toggle music and sound effects
// on or off via the settings screen, and each change must apply within one
// rendered frame. AudioSystem.setMusicEnabled / setSFXEnabled already apply
// synchronously (the mute path silences immediately, with no 500 ms fade), so
// this helper simply forwards the two boolean preferences in a single call.
//
// The settings screen itself (packages/client/src/ui/Settings.tsx) is owned by
// task 17.4. When that screen is built, its music and SFX toggle controls will
// call `applyAudioSettings(audioSystem, { musicEnabled, sfxEnabled })` on change
// so the toggle takes effect within the same frame the control was flipped.

import type { AudioSystem } from './AudioSystem.js';

/** Player-facing audio on/off preferences captured by the settings screen. */
export interface AudioSettings {
  /** Whether background music should play. */
  musicEnabled: boolean;
  /** Whether sound effects should play. */
  sfxEnabled: boolean;
}

/**
 * Apply the given audio settings to the AudioSystem. Forwards each preference to
 * the corresponding synchronous toggle so the change is reflected within one
 * rendered frame (requirement 10.5). Idempotent: re-applying the same settings
 * is a no-op inside AudioSystem.
 *
 * @param audio  the live AudioSystem to update
 * @param settings  the desired music/SFX on-off state
 */
export function applyAudioSettings(audio: AudioSystem, settings: AudioSettings): void {
  audio.setMusicEnabled(settings.musicEnabled);
  audio.setSFXEnabled(settings.sfxEnabled);
}
