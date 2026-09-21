// packages/client/src/audio/__tests__/audio-settings.test.ts
//
// Tests for task 16.3: music/SFX toggles apply within one rendered frame, and
// the applyAudioSettings helper (the seam the future Settings screen — task 17.4
// — will call) forwards both preferences.
//
// Uses a fake, guarded backend and fake clock so no real Web Audio AudioContext
// is required and the tests run headlessly in node.
//
// Validates: Requirements 10.5

import { describe, it, expect, beforeEach } from 'vitest';
import { AudioSystem, MUSIC_FADE_MS } from '../AudioSystem.js';
import type { AudioBackend, Clock, MusicHandle, SfxHandle } from '../AudioSystem.js';
import { applyAudioSettings } from '../AudioSettings.js';
import type { SFXId, MusicContext } from '@deathtrack/shared';

/** Controllable monotonic clock (seconds). */
class FakeClock implements Clock {
  t = 0;
  now(): number {
    return this.t;
  }
  advance(seconds: number): void {
    this.t += seconds;
  }
}

interface SfxRecord {
  id: SFXId;
  startTime: number;
  endTime: number;
  stopped: boolean;
}

interface FadeCall {
  target: number;
  atTime: number;
}

interface MusicRecord {
  context: MusicContext;
  startTime: number;
  initialGain: number;
  fades: FadeCall[];
  stopped: boolean;
}

/**
 * Guarded fake backend: records all calls, touches no AudioContext. Safe to run
 * under node with no Web Audio API present.
 */
class FakeBackend implements AudioBackend {
  sfx: SfxRecord[] = [];
  music: MusicRecord[] = [];
  defaultDuration = 1;

  playSfx(id: SFXId, startTime: number): SfxHandle {
    const rec: SfxRecord = {
      id,
      startTime,
      endTime: startTime + this.defaultDuration,
      stopped: false,
    };
    this.sfx.push(rec);
    return {
      endTime: rec.endTime,
      stop(): void {
        rec.stopped = true;
      },
    };
  }

  playMusic(context: MusicContext, initialGain: number, startTime: number): MusicHandle {
    const rec: MusicRecord = { context, startTime, initialGain, fades: [], stopped: false };
    this.music.push(rec);
    return {
      context,
      fadeTo(target: number, atTime: number): void {
        rec.fades.push({ target, atTime });
      },
      stop(): void {
        rec.stopped = true;
      },
    };
  }
}

describe('setSFXEnabled toggle (requirement 10.5)', () => {
  let clock: FakeClock;
  let backend: FakeBackend;
  let audio: AudioSystem;

  beforeEach(() => {
    clock = new FakeClock();
    backend = new FakeBackend();
    audio = new AudioSystem(backend, clock);
  });

  it('setSFXEnabled(false) makes playSFX a no-op', () => {
    audio.setSFXEnabled(false);
    const before = backend.sfx.length;

    audio.playSFX('weapon_fire');
    audio.playSFX('explosion');

    // No new sound was created and no channel is active.
    expect(backend.sfx.length).toBe(before);
    expect(audio.activeChannelCount()).toBe(0);
  });

  it('setSFXEnabled(true) restores playSFX after being disabled', () => {
    audio.setSFXEnabled(false);
    audio.playSFX('muted'); // ignored
    expect(backend.sfx).toHaveLength(0);

    audio.setSFXEnabled(true);
    audio.playSFX('audible');

    expect(backend.sfx).toHaveLength(1);
    expect(backend.sfx[0]!.id).toBe('audible');
    expect(audio.activeChannelCount()).toBe(1);
  });

  it('disabling SFX silences currently active channels immediately (same frame)', () => {
    audio.playSFX('a');
    audio.playSFX('b');
    expect(audio.activeChannelCount()).toBe(2);

    const startClock = clock.now();
    audio.setSFXEnabled(false);

    // All active sounds stopped without advancing the clock — no fade window.
    expect(backend.sfx.every((s) => s.stopped)).toBe(true);
    expect(audio.activeChannelCount()).toBe(0);
    expect(clock.now()).toBe(startClock);
  });
});

describe('setMusicEnabled toggle (requirement 10.5)', () => {
  let clock: FakeClock;
  let backend: FakeBackend;
  let audio: AudioSystem;

  beforeEach(() => {
    clock = new FakeClock();
    backend = new FakeBackend();
    audio = new AudioSystem(backend, clock);
  });

  it('setMusicEnabled(false) mutes music immediately, within one frame (no fade delay)', () => {
    audio.playMusic('race');
    const track = backend.music[0]!;
    const fadesBefore = track.fades.length;

    const t = clock.now();
    audio.setMusicEnabled(false);

    // A mute ramp was scheduled to reach 0 gain at the CURRENT clock time,
    // not `now + 500 ms`. This is the "within one rendered frame" guarantee.
    expect(track.fades.length).toBe(fadesBefore + 1);
    const muteFade = track.fades.at(-1)!;
    expect(muteFade.target).toBe(0);
    expect(muteFade.atTime).toBe(t); // immediate, no MUSIC_FADE_MS delay
    // Sanity: it must NOT be the 500 ms crossfade window.
    expect(muteFade.atTime).not.toBeCloseTo(t + MUSIC_FADE_MS / 1000);

    expect(track.stopped).toBe(true);
    expect(audio.currentMusicContext()).toBeNull();
  });

  it('re-enabling music resumes the last-requested context', () => {
    audio.playMusic('shop');
    audio.setMusicEnabled(false);
    expect(audio.currentMusicContext()).toBeNull();

    audio.setMusicEnabled(true);
    expect(audio.currentMusicContext()).toBe('shop');
    expect(backend.music.at(-1)!.context).toBe('shop');
  });

  it('toggling music twice quickly is stable (disable then re-enable)', () => {
    audio.playMusic('main_menu');
    audio.setMusicEnabled(false);
    audio.setMusicEnabled(true);
    expect(audio.currentMusicContext()).toBe('main_menu');
  });
});

describe('applyAudioSettings helper (task 17.4 seam)', () => {
  let clock: FakeClock;
  let backend: FakeBackend;
  let audio: AudioSystem;

  beforeEach(() => {
    clock = new FakeClock();
    backend = new FakeBackend();
    audio = new AudioSystem(backend, clock);
  });

  it('forwards both preferences to setMusicEnabled and setSFXEnabled', () => {
    audio.playMusic('race');
    audio.playSFX('engine');
    expect(audio.currentMusicContext()).toBe('race');
    expect(audio.activeChannelCount()).toBe(1);

    // Disable both via the helper.
    applyAudioSettings(audio, { musicEnabled: false, sfxEnabled: false });

    expect(audio.currentMusicContext()).toBeNull(); // music muted
    expect(audio.activeChannelCount()).toBe(0); // sfx stopped
    audio.playSFX('ignored');
    expect(audio.activeChannelCount()).toBe(0); // sfx still disabled
  });

  it('re-enables both via the helper', () => {
    audio.playMusic('shop');
    applyAudioSettings(audio, { musicEnabled: false, sfxEnabled: false });
    expect(audio.currentMusicContext()).toBeNull();

    applyAudioSettings(audio, { musicEnabled: true, sfxEnabled: true });

    // Music resumes the last-requested context; SFX are audible again.
    expect(audio.currentMusicContext()).toBe('shop');
    audio.playSFX('audible');
    expect(audio.activeChannelCount()).toBe(1);
  });

  it('supports independent toggles (music off, sfx on)', () => {
    audio.playMusic('main_menu');
    applyAudioSettings(audio, { musicEnabled: false, sfxEnabled: true });

    expect(audio.currentMusicContext()).toBeNull(); // music off
    audio.playSFX('shot');
    expect(audio.activeChannelCount()).toBe(1); // sfx on
  });
});
