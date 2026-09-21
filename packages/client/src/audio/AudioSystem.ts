// packages/client/src/audio/AudioSystem.ts
//
// Audio System — channel management + music crossfade logic.
//
// Design (see design.md "Audio System" and requirements 10.1, 10.5, 10.6):
//   - Up to 8 simultaneously active SFX channels.
//   - When all 8 are active and a new SFX is triggered, evict the channel with
//     the SMALLEST remaining playback duration, then start the new sound in that
//     slot (requirement 10.6).
//   - Music transitions crossfade to the new track within 500 ms (requirement 10.1).
//   - Music and SFX can be toggled independently (requirement 10.5).
//
// The Web Audio API (AudioContext, AudioBufferSourceNode, GainNode) cannot run in
// the node test environment, so the concrete backend is abstracted behind the
// `AudioBackend` interface and a `Clock` is injected. This keeps the channel
// allocation / eviction / crossfade scheduling deterministic and unit-testable
// headless. The only piece that touches a real AudioContext is the
// `WebAudioBackend` adapter, which is browser-only and not unit-tested.

import type { SFXId, MusicContext } from '@deathtrack/shared';

/** Number of simultaneous SFX channels supported (requirement 10.6). */
export const SFX_CHANNEL_COUNT = 8;

/** Maximum music crossfade duration in milliseconds (requirement 10.1). */
export const MUSIC_FADE_MS = 500;

/**
 * Monotonic clock injected into the AudioSystem. `now()` returns seconds.
 * In the browser this is backed by `AudioContext.currentTime`; in tests it is a
 * controllable fake.
 */
export interface Clock {
  now(): number;
}

/**
 * A handle to a single playing sound effect, returned by the backend. The
 * AudioSystem uses `endTime` to compute remaining duration for eviction and
 * calls `stop()` when evicting a channel.
 */
export interface SfxHandle {
  /** Clock time (seconds) at which this sound naturally finishes playing. */
  readonly endTime: number;
  /** Stop playback immediately (must not click; the adapter ramps gain down). */
  stop(): void;
}

/**
 * A handle to the currently playing music track. The AudioSystem drives fades by
 * scheduling gain ramps; the adapter is responsible for the actual audio graph.
 */
export interface MusicHandle {
  readonly context: MusicContext;
  /** Ramp this track's gain to `target` (0..1), reaching it at `atTime` seconds. */
  fadeTo(target: number, atTime: number): void;
  /** Stop playback (called after a fade-out completes). */
  stop(): void;
}

/**
 * The audio backend. The AudioSystem never touches the Web Audio API directly;
 * it drives this interface instead. A fake implementation is used in tests.
 */
export interface AudioBackend {
  /**
   * Begin playing the SFX identified by `id`, starting at `startTime` (seconds
   * on the injected clock). Returns a handle exposing the natural end time so the
   * AudioSystem can pick eviction victims by remaining duration.
   */
  playSfx(id: SFXId, startTime: number): SfxHandle;

  /**
   * Begin playing the music track for `context` at gain `initialGain`, starting
   * at `startTime`. Returns a handle the AudioSystem uses to schedule fades.
   */
  playMusic(context: MusicContext, initialGain: number, startTime: number): MusicHandle;
}

interface ChannelSlot {
  handle: SfxHandle;
}

/**
 * Channel manager + music crossfade scheduler. Backend-agnostic and clock-driven.
 */
export class AudioSystem {
  private readonly backend: AudioBackend;
  private readonly clock: Clock;
  private readonly fadeMs: number;

  /** Fixed-size slot array; a `null` slot is free. */
  private readonly channels: (ChannelSlot | null)[];

  private currentMusic: MusicHandle | null = null;
  private pendingContext: MusicContext | null = null;

  private musicEnabled = true;
  private sfxEnabled = true;

  constructor(
    backend: AudioBackend,
    clock: Clock,
    options: { channelCount?: number; fadeMs?: number } = {},
  ) {
    this.backend = backend;
    this.clock = clock;
    this.fadeMs = options.fadeMs ?? MUSIC_FADE_MS;
    const count = options.channelCount ?? SFX_CHANNEL_COUNT;
    this.channels = new Array<ChannelSlot | null>(count).fill(null);
  }

  /**
   * Play a sound effect. Reclaims any channels whose sounds have finished, then:
   *   - if a free slot exists, uses it;
   *   - otherwise evicts the channel with the smallest remaining playback
   *     duration and reuses its slot (requirement 10.6).
   * When SFX are disabled the call is a no-op.
   */
  playSFX(id: SFXId): void {
    if (!this.sfxEnabled) {
      return;
    }
    const now = this.clock.now();
    this.reclaimFinished(now);

    let slot = this.findFreeSlot();
    if (slot === -1) {
      slot = this.findEvictionSlot(now);
      const victim = this.channels[slot];
      if (victim) {
        victim.handle.stop();
      }
    }

    const handle = this.backend.playSfx(id, now);
    this.channels[slot] = { handle };
  }

  /**
   * Transition music to `context`, crossfading within `fadeMs` (<=500 ms). The
   * current track fades out over the window while the new track fades in over the
   * same window, so the transition completes by `now + fadeMs`.
   * Requesting the context that is already playing is a no-op. When music is
   * disabled the target context is remembered and started on re-enable.
   */
  playMusic(context: MusicContext): void {
    this.pendingContext = context;

    if (!this.musicEnabled) {
      return;
    }
    if (this.currentMusic && this.currentMusic.context === context) {
      return;
    }

    const now = this.clock.now();
    const fadeSeconds = this.fadeMs / 1000;
    const endTime = now + fadeSeconds;

    if (this.currentMusic) {
      // Fade the outgoing track down and stop it once the fade completes.
      const outgoing = this.currentMusic;
      outgoing.fadeTo(0, endTime);
      outgoing.stop();
    }

    // Start the new track silent and fade it up over the same window.
    const next = this.backend.playMusic(context, 0, now);
    next.fadeTo(1, endTime);
    this.currentMusic = next;
  }

  /**
   * Toggle music on/off. Enabling starts (fades in) the pending/last-requested
   * context if one exists; disabling mutes and stops the current track.
   *
   * The mute path takes effect within one rendered frame (requirement 10.5):
   * the gain is ramped to 0 at the CURRENT clock time (no 500 ms fade window),
   * so the track is silenced synchronously rather than over the crossfade
   * window used for track-to-track transitions.
   */
  setMusicEnabled(on: boolean): void {
    if (on === this.musicEnabled) {
      return;
    }
    this.musicEnabled = on;

    if (!on) {
      if (this.currentMusic) {
        const now = this.clock.now();
        // Immediate mute: reach 0 gain at `now`, within the current frame.
        this.currentMusic.fadeTo(0, now);
        this.currentMusic.stop();
        this.currentMusic = null;
      }
      return;
    }

    // Re-enabled: resume the last-requested context, if any.
    if (this.pendingContext !== null) {
      const resume = this.pendingContext;
      // currentMusic is null while disabled, so playMusic will start fresh.
      this.playMusic(resume);
    }
  }

  /**
   * Toggle SFX on/off. Disabling stops all active channels immediately so no
   * further sound is heard; enabling simply allows future triggers. Applied
   * immediately (requirement 10.5).
   */
  setSFXEnabled(on: boolean): void {
    if (on === this.sfxEnabled) {
      return;
    }
    this.sfxEnabled = on;
    if (!on) {
      for (let i = 0; i < this.channels.length; i++) {
        const slot = this.channels[i];
        if (slot) {
          slot.handle.stop();
          this.channels[i] = null;
        }
      }
    }
  }

  /** Number of currently active SFX channels. Never exceeds the slot count. */
  activeChannelCount(): number {
    this.reclaimFinished(this.clock.now());
    let n = 0;
    for (const slot of this.channels) {
      if (slot) {
        n++;
      }
    }
    return n;
  }

  /** The music context currently playing, or null. */
  currentMusicContext(): MusicContext | null {
    return this.currentMusic ? this.currentMusic.context : null;
  }

  // --- internals ---------------------------------------------------------

  /** Free any slot whose sound has finished playing at or before `now`. */
  private reclaimFinished(now: number): void {
    for (let i = 0; i < this.channels.length; i++) {
      const slot = this.channels[i];
      if (slot && slot.handle.endTime <= now) {
        this.channels[i] = null;
      }
    }
  }

  private findFreeSlot(): number {
    for (let i = 0; i < this.channels.length; i++) {
      if (this.channels[i] === null) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Pick the slot to evict: the one with the smallest remaining playback
   * duration (i.e. the earliest `endTime`). Assumes all slots are occupied.
   */
  private findEvictionSlot(now: number): number {
    let bestIndex = 0;
    let bestRemaining = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.channels.length; i++) {
      const slot = this.channels[i];
      if (!slot) {
        // Should not happen when called with a full array, but stay safe.
        return i;
      }
      const remaining = slot.handle.endTime - now;
      if (remaining < bestRemaining) {
        bestRemaining = remaining;
        bestIndex = i;
      }
    }
    return bestIndex;
  }
}
