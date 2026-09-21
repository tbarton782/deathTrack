/**
 * Property-based test for the audio channel-count invariant.
 *
 * Property 24: Audio channel count never exceeds 8. For any sequence of SFX
 * trigger events of any length — with arbitrary sfx ids, arbitrary per-sound
 * durations, arbitrary interleaved clock advances, and arbitrary SFX
 * enable/disable toggles — the number of simultaneously active audio channels
 * reported by {@link AudioSystem.activeChannelCount} is at most
 * {@link SFX_CHANNEL_COUNT} (8) after every operation. When all channels are
 * active and a new trigger arrives, an existing channel is evicted rather than
 * a ninth channel being opened, so the cap is preserved.
 *
 * Validates: Requirements 10.6
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { AudioSystem, SFX_CHANNEL_COUNT } from '../audio/AudioSystem.js';
import type { AudioBackend, Clock, MusicHandle, SfxHandle } from '../audio/AudioSystem.js';
import type { SFXId, MusicContext } from '@deathtrack/shared';

// --- Test doubles (mirror AudioSystem.test.ts) -----------------------------

class FakeClock implements Clock {
  t = 0;
  now(): number {
    return this.t;
  }
  advance(seconds: number): void {
    this.t += seconds;
  }
}

/**
 * Minimal fake backend. Each SFX ends at `startTime + duration`; the duration
 * for the next `playSfx` call is supplied by the caller via `nextDuration`.
 */
class FakeBackend implements AudioBackend {
  nextDuration = 1;

  playSfx(_id: SFXId, startTime: number): SfxHandle {
    const endTime = startTime + this.nextDuration;
    return {
      endTime,
      stop(): void {
        /* no-op for the invariant test */
      },
    };
  }

  playMusic(context: MusicContext, _initialGain: number, _startTime: number): MusicHandle {
    return {
      context,
      fadeTo(): void {
        /* no-op */
      },
      stop(): void {
        /* no-op */
      },
    };
  }
}

// --- Event model -----------------------------------------------------------

type Event =
  | { kind: 'play'; id: string; duration: number }
  | { kind: 'advance'; seconds: number }
  | { kind: 'toggle'; on: boolean };

// A small set of ids so eviction collisions actually happen, but still varied.
const idArb = fc.integer({ min: 0, max: 20 }).map((n) => `sfx-${n}`);

// Durations include very short (near-zero) and long sounds so both reclaim and
// eviction paths are exercised.
const durationArb = fc.double({ min: 0, max: 50, noNaN: true, noDefaultInfinity: true });

const eventArb: fc.Arbitrary<Event> = fc.oneof(
  fc.record({ kind: fc.constant('play' as const), id: idArb, duration: durationArb }),
  fc.record({
    kind: fc.constant('advance' as const),
    seconds: fc.double({ min: 0, max: 60, noNaN: true, noDefaultInfinity: true }),
  }),
  fc.record({ kind: fc.constant('toggle' as const), on: fc.boolean() }),
);

const eventsArb = fc.array(eventArb, { minLength: 0, maxLength: 200 });

describe('Property 24: audio channel count never exceeds 8', () => {
  it('activeChannelCount stays within the channel cap after every operation', () => {
    // Validates: Requirements 10.6
    fc.assert(
      fc.property(eventsArb, (events) => {
        const clock = new FakeClock();
        const backend = new FakeBackend();
        const audio = new AudioSystem(backend, clock);

        // Invariant holds before any events are processed.
        expect(audio.activeChannelCount()).toBeLessThanOrEqual(SFX_CHANNEL_COUNT);

        for (const ev of events) {
          switch (ev.kind) {
            case 'play':
              backend.nextDuration = ev.duration;
              audio.playSFX(ev.id);
              break;
            case 'advance':
              clock.advance(ev.seconds);
              break;
            case 'toggle':
              audio.setSFXEnabled(ev.on);
              break;
          }

          // The invariant must hold after EVERY operation, never exceeding 8.
          expect(audio.activeChannelCount()).toBeLessThanOrEqual(SFX_CHANNEL_COUNT);
        }
      }),
      { numRuns: 1000 },
    );
  });

  it('holds for a custom (non-default) channel count as well', () => {
    // Validates: Requirements 10.6
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.array(fc.record({ id: idArb, duration: durationArb }), { maxLength: 100 }),
        (channelCount, plays) => {
          const clock = new FakeClock();
          const backend = new FakeBackend();
          const audio = new AudioSystem(backend, clock, { channelCount });

          for (const p of plays) {
            backend.nextDuration = p.duration;
            audio.playSFX(p.id);
            expect(audio.activeChannelCount()).toBeLessThanOrEqual(channelCount);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
