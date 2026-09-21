// Unit tests for the backend-agnostic AudioSystem channel + crossfade logic.
// Uses a fake backend and fake clock so no real AudioContext is required.

import { describe, it, expect, beforeEach } from 'vitest';
import { AudioSystem, MUSIC_FADE_MS, SFX_CHANNEL_COUNT } from './AudioSystem.js';
import type { AudioBackend, Clock, MusicHandle, SfxHandle } from './AudioSystem.js';
import type { SFXId, MusicContext } from '@deathtrack/shared';

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
 * Fake backend that records everything. `defaultDuration` sets how long each
 * SFX plays; individual durations can be overridden per id via `durations`.
 */
class FakeBackend implements AudioBackend {
  sfx: SfxRecord[] = [];
  music: MusicRecord[] = [];
  durations = new Map<SFXId, number>();
  defaultDuration = 1;

  setDuration(id: SFXId, seconds: number): void {
    this.durations.set(id, seconds);
  }

  playSfx(id: SFXId, startTime: number): SfxHandle {
    const dur = this.durations.get(id) ?? this.defaultDuration;
    const rec: SfxRecord = { id, startTime, endTime: startTime + dur, stopped: false };
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

describe('AudioSystem SFX channels', () => {
  let clock: FakeClock;
  let backend: FakeBackend;
  let audio: AudioSystem;

  beforeEach(() => {
    clock = new FakeClock();
    backend = new FakeBackend();
    audio = new AudioSystem(backend, clock);
  });

  it('exposes 8 channels by default', () => {
    for (let i = 0; i < SFX_CHANNEL_COUNT; i++) {
      audio.playSFX(`sfx-${i}`);
    }
    expect(audio.activeChannelCount()).toBe(SFX_CHANNEL_COUNT);
    expect(backend.sfx).toHaveLength(SFX_CHANNEL_COUNT);
  });

  it('allocates a free slot when channels are available', () => {
    audio.playSFX('a');
    audio.playSFX('b');
    expect(audio.activeChannelCount()).toBe(2);
    expect(backend.sfx.every((s) => !s.stopped)).toBe(true);
  });

  it('never exceeds 8 active channels no matter how many SFX are triggered', () => {
    for (let i = 0; i < 30; i++) {
      audio.playSFX(`sfx-${i}`);
    }
    expect(audio.activeChannelCount()).toBeLessThanOrEqual(SFX_CHANNEL_COUNT);
    expect(audio.activeChannelCount()).toBe(SFX_CHANNEL_COUNT);
  });

  it('evicts the channel with the smallest remaining duration when all 8 are active', () => {
    // Fill 8 channels with distinct end times. sfx-3 ends soonest.
    const durations = [5, 4, 3, 0.5, 6, 7, 8, 9];
    durations.forEach((d, i) => {
      backend.setDuration(`sfx-${i}`, d);
      audio.playSFX(`sfx-${i}`);
    });
    expect(audio.activeChannelCount()).toBe(8);

    // Trigger a 9th. The victim must be sfx-3 (shortest remaining = 0.5s).
    audio.playSFX('new-sound');

    const victim = backend.sfx.find((s) => s.id === 'sfx-3');
    expect(victim?.stopped).toBe(true);

    // All other original sounds remain playing.
    backend.sfx
      .filter((s) => s.id.startsWith('sfx-') && s.id !== 'sfx-3')
      .forEach((s) => expect(s.stopped).toBe(false));

    // The new sound started and the count is still capped at 8.
    expect(backend.sfx.some((s) => s.id === 'new-sound')).toBe(true);
    expect(audio.activeChannelCount()).toBe(8);
  });

  it('evicts by remaining duration relative to the current clock, not original length', () => {
    // Two long sounds and one short one, then advance time so a "long" sound
    // now has the least remaining time.
    backend.setDuration('long-a', 10); // ends at 10
    backend.setDuration('long-b', 2); // ends at 2
    audio.playSFX('long-a');
    audio.playSFX('long-b');
    // Fill remaining 6 slots with sounds ending at 20.
    for (let i = 0; i < 6; i++) {
      backend.setDuration(`filler-${i}`, 20);
      audio.playSFX(`filler-${i}`);
    }

    // Advance to t=1.5: long-b has 0.5s remaining (smallest), long-a has 8.5s.
    clock.advance(1.5);
    audio.playSFX('trigger');

    const victim = backend.sfx.find((s) => s.id === 'long-b');
    expect(victim?.stopped).toBe(true);
    expect(backend.sfx.find((s) => s.id === 'long-a')?.stopped).toBe(false);
  });

  it('reclaims finished channels instead of evicting active ones', () => {
    for (let i = 0; i < SFX_CHANNEL_COUNT; i++) {
      backend.setDuration(`sfx-${i}`, 1);
      audio.playSFX(`sfx-${i}`);
    }
    // Advance past the end of all sounds; they should be reclaimed.
    clock.advance(1.5);
    expect(audio.activeChannelCount()).toBe(0);

    audio.playSFX('fresh');
    // No eviction should have occurred.
    expect(backend.sfx.filter((s) => s.stopped)).toHaveLength(0);
    expect(audio.activeChannelCount()).toBe(1);
  });

  it('respects a custom channel count', () => {
    const small = new AudioSystem(backend, clock, { channelCount: 2 });
    small.playSFX('a');
    small.playSFX('b');
    small.playSFX('c');
    expect(small.activeChannelCount()).toBe(2);
  });

  it('does not play SFX when disabled and stops active ones', () => {
    audio.playSFX('a');
    audio.setSFXEnabled(false);
    expect(audio.activeChannelCount()).toBe(0);
    const before = backend.sfx.length;
    audio.playSFX('b');
    expect(backend.sfx.length).toBe(before); // no new sound created
  });
});

describe('AudioSystem music crossfade', () => {
  let clock: FakeClock;
  let backend: FakeBackend;
  let audio: AudioSystem;

  beforeEach(() => {
    clock = new FakeClock();
    backend = new FakeBackend();
    audio = new AudioSystem(backend, clock);
  });

  it('starts the first track fading in over <=500 ms', () => {
    audio.playMusic('main_menu');
    expect(backend.music).toHaveLength(1);
    const track = backend.music[0]!;
    expect(track.context).toBe('main_menu');
    expect(track.initialGain).toBe(0);
    expect(track.fades).toHaveLength(1);
    expect(track.fades[0]!.target).toBe(1);
    // Fade completes within 500 ms.
    expect(track.fades[0]!.atTime).toBeLessThanOrEqual(MUSIC_FADE_MS / 1000);
    expect(track.fades[0]!.atTime).toBeCloseTo(clock.now() + MUSIC_FADE_MS / 1000);
  });

  it('crossfades: fades out old track and fades in new one within the same window', () => {
    audio.playMusic('main_menu');
    clock.advance(3);
    audio.playMusic('race');

    expect(backend.music).toHaveLength(2);
    const [menu, race] = backend.music;

    // Outgoing fades to 0 and is stopped.
    expect(menu!.fades.at(-1)!.target).toBe(0);
    expect(menu!.stopped).toBe(true);

    // Incoming fades to 1 starting silent.
    expect(race!.initialGain).toBe(0);
    expect(race!.fades.at(-1)!.target).toBe(1);

    // Both reach their targets by now + 500 ms.
    const deadline = clock.now() + MUSIC_FADE_MS / 1000;
    expect(menu!.fades.at(-1)!.atTime).toBeLessThanOrEqual(deadline + 1e-9);
    expect(race!.fades.at(-1)!.atTime).toBeLessThanOrEqual(deadline + 1e-9);
    expect(audio.currentMusicContext()).toBe('race');
  });

  it('is a no-op when requesting the already-playing context', () => {
    audio.playMusic('shop');
    audio.playMusic('shop');
    expect(backend.music).toHaveLength(1);
  });

  it('honors a custom fade duration', () => {
    const fast = new AudioSystem(backend, clock, { fadeMs: 200 });
    fast.playMusic('results');
    expect(backend.music[0]!.fades[0]!.atTime).toBeCloseTo(0.2);
  });

  it('fades out and stops music when disabled, resumes last context when re-enabled', () => {
    audio.playMusic('race');
    audio.setMusicEnabled(false);
    expect(backend.music[0]!.stopped).toBe(true);
    expect(audio.currentMusicContext()).toBeNull();

    audio.setMusicEnabled(true);
    // A fresh track for the same context is started.
    expect(audio.currentMusicContext()).toBe('race');
    expect(backend.music.at(-1)!.context).toBe('race');
  });

  it('remembers the requested context while disabled and starts it on enable', () => {
    audio.setMusicEnabled(false);
    audio.playMusic('shop'); // requested while disabled -> deferred
    expect(backend.music).toHaveLength(0);

    audio.setMusicEnabled(true);
    expect(backend.music).toHaveLength(1);
    expect(audio.currentMusicContext()).toBe('shop');
  });
});
