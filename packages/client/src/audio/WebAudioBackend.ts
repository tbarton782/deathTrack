// packages/client/src/audio/WebAudioBackend.ts
//
// Concrete Web Audio API adapter for the AudioSystem. This is the ONLY part of
// the audio subsystem that touches AudioContext / AudioBufferSourceNode /
// GainNode, so it is browser-only and intentionally not unit-tested (the node
// test environment has no Web Audio API). All channel/eviction/crossfade logic
// lives in the backend-agnostic AudioSystem, which is fully tested with a fake
// backend.

import type { SFXId, MusicContext } from '@deathtrack/shared';
import type { AudioBackend, MusicHandle, SfxHandle } from './AudioSystem.js';

/** Resolves decoded audio buffers for playback. Supplied by the asset layer. */
export interface AudioBufferProvider {
  /** Decoded PCM buffer for a sound effect, or undefined if not loaded yet. */
  getSfxBuffer(id: SFXId): AudioBuffer | undefined;
  /** Decoded PCM buffer for a music track, or undefined if not loaded yet. */
  getMusicBuffer(context: MusicContext): AudioBuffer | undefined;
}

/** Short gain ramp (seconds) applied on stop to avoid clicks (requirement 10.6). */
const STOP_RAMP_SECONDS = 0.01;

/**
 * Web Audio backend. `ctx.currentTime` provides the clock; pass the same
 * AudioContext to a `WebAudioClock` when constructing the AudioSystem so the
 * scheduling stays coherent.
 */
export class WebAudioBackend implements AudioBackend {
  private readonly ctx: AudioContext;
  private readonly provider: AudioBufferProvider;
  private readonly sfxBus: GainNode;
  private readonly musicBus: GainNode;

  constructor(ctx: AudioContext, provider: AudioBufferProvider) {
    this.ctx = ctx;
    this.provider = provider;
    this.sfxBus = ctx.createGain();
    this.musicBus = ctx.createGain();
    this.sfxBus.connect(ctx.destination);
    this.musicBus.connect(ctx.destination);
  }

  playSfx(id: SFXId, startTime: number): SfxHandle {
    const buffer = this.provider.getSfxBuffer(id);
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    source.connect(gain);
    gain.connect(this.sfxBus);

    let endTime = startTime;
    if (buffer) {
      source.buffer = buffer;
      endTime = startTime + buffer.duration;
      source.start(Math.max(startTime, this.ctx.currentTime));
      source.stop(endTime);
    }

    const ctx = this.ctx;
    return {
      endTime,
      stop(): void {
        const t = ctx.currentTime;
        try {
          gain.gain.cancelScheduledValues(t);
          gain.gain.setValueAtTime(gain.gain.value, t);
          gain.gain.linearRampToValueAtTime(0, t + STOP_RAMP_SECONDS);
          source.stop(t + STOP_RAMP_SECONDS);
        } catch {
          // Source may already be stopped; ignore.
        }
      },
    };
  }

  playMusic(context: MusicContext, initialGain: number, startTime: number): MusicHandle {
    const buffer = this.provider.getMusicBuffer(context);
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    source.loop = true;
    source.connect(gain);
    gain.connect(this.musicBus);
    gain.gain.setValueAtTime(initialGain, Math.max(startTime, this.ctx.currentTime));

    if (buffer) {
      source.buffer = buffer;
      source.start(Math.max(startTime, this.ctx.currentTime));
    }

    const ctx = this.ctx;
    return {
      context,
      fadeTo(target: number, atTime: number): void {
        const t = Math.max(ctx.currentTime, startTime);
        gain.gain.setValueAtTime(gain.gain.value, t);
        gain.gain.linearRampToValueAtTime(target, Math.max(atTime, t));
      },
      stop(): void {
        // Stop shortly after any scheduled fade completes.
        try {
          source.stop(Math.max(ctx.currentTime, startTime) + STOP_RAMP_SECONDS);
        } catch {
          // Already stopped; ignore.
        }
      },
    };
  }
}

/** Clock backed by an AudioContext's `currentTime`. */
export class WebAudioClock {
  private readonly ctx: AudioContext;
  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }
  now(): number {
    return this.ctx.currentTime;
  }
}
