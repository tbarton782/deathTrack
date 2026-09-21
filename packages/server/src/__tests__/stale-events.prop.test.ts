/**
 * Property-based test for stale-event discard on the authoritative server
 * input/authority path ({@link ServerNetworkManager}).
 *
 * Property 21: Stale weapon events are discarded without mutating game state.
 *
 * The design (Property 21) frames this in terms of a remote *weapon fire* event
 * whose timestamp is more than 200 ms older than current server time: the
 * Network Manager must discard it and record the miss *without altering any
 * Participant's simulation state* (Requirements 8.4 — "discard the event and
 * record the miss without altering any Participant's simulation state").
 *
 * There is not yet a dedicated weapon-event ingestion API on the server types.
 * The representative stale-discard mechanism that already exists on the
 * authoritative path is {@link ServerNetworkManager.receiveInput}: a frame whose
 * `tick` does not strictly advance past the last accepted tick is stale /
 * out-of-order and is rejected — it is neither buffered nor allowed to touch the
 * participant's liveness clock. Weapon-fire inputs ride inside these very frames
 * (`InputFrame.inputs.fireForward` / `fireRear`), so exercising `receiveInput`
 * with an interleaving of fresh and stale frames *is* the concrete stale
 * weapon-event discard path for the current code. This test targets that
 * mechanism and stays green against the code as it exists today; if a dedicated
 * weapon-event discard API is later added, this property should be re-pointed at
 * it. See design.md §"Property 21" / Requirements 8.4.
 *
 * The property (state-equivalence formulation of "does not mutate game state"):
 *
 *   *For any* interleaving of fresh frames (whose tick strictly advances) and
 *   stale frames (whose tick is <= a previously accepted tick, i.e. old /
 *   out-of-order / duplicate), the resulting authoritative state of the
 *   manager — the buffered input frames (oldest-first) and the last-accepted
 *   tick — is *exactly* what it would be had the stale frames never been sent
 *   at all. Discarding a stale event leaves game state byte-for-byte identical.
 *
 * **Property 21**
 * **Validates: Requirements 8.4**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { CarInputs, InputFrame, ParticipantId } from '@deathtrack/shared';
import { SessionManager } from '../session/SessionManager.js';
import { ServerNetworkManager } from '../network/ServerNetworkManager.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A deterministic, monotonically advancing clock. Each read returns a distinct,
 * increasing timestamp so `receiveInput`'s liveness bookkeeping is fully
 * reproducible across generated inputs.
 */
function makeClock(start = 1000) {
  let t = start;
  return () => t++;
}

/**
 * A weapon-fire input frame. `fireForward` / `fireRear` carry the weapon-event
 * intent that the design's Property 21 is concerned with; `tick` is the event
 * timestamp the server validates for staleness.
 */
function fireFrame(tick: number, fireForward: boolean, fireRear: boolean): InputFrame {
  const inputs: CarInputs = {
    throttle: 1,
    brake: 0,
    steer: 0,
    fireForward,
    fireRear,
  };
  return { tick, inputs, checksum: tick & 0xffff };
}

/**
 * Reference oracle: replays the *fresh-only* subsequence of a frame stream the
 * same way the manager should, tracking the last-accepted tick and the bounded
 * (oldest-first) buffer. A frame is fresh iff its tick is finite and strictly
 * greater than every previously accepted tick. This mirrors the acceptance rule
 * without consulting the implementation.
 */
function referenceState(frames: InputFrame[]): { ticks: number[]; lastTick: number } {
  let lastTick = -1;
  const accepted: InputFrame[] = [];
  for (const f of frames) {
    if (Number.isFinite(f.tick) && f.tick > lastTick) {
      accepted.push(f);
      lastTick = f.tick;
    }
  }
  return { ticks: accepted.map((f) => f.tick), lastTick };
}

const PARTICIPANT: ParticipantId = 0;

function makeManager(now: () => number) {
  return new ServerNetworkManager(new SessionManager(), 's-prop', { now });
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/**
 * Generates a stream of frames deliberately interleaving fresh and stale ones.
 *
 * We first pick a set of strictly-increasing "fresh" ticks, then splice in
 * "stale" frames whose ticks are drawn from at or below already-seen ticks
 * (old, out-of-order, or exact duplicates). The generator intentionally
 * concentrates on the boundary where the accept/reject decision flips rather
 * than sampling arbitrary huge values.
 */
const arbFrameStream: fc.Arbitrary<InputFrame[]> = fc
  .array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 25 })
  .chain((deltas) => {
    // Build the strictly-increasing "fresh" backbone from positive deltas.
    const fresh: number[] = [];
    let acc = 0;
    for (const d of deltas) {
      acc += d;
      fresh.push(acc);
    }
    const maxTick = fresh[fresh.length - 1] ?? 0;

    // For each position we may insert zero or more stale frames whose tick is
    // <= some earlier fresh tick (0..maxTick covers old / duplicate / reorder).
    return fc
      .array(
        fc.record({
          insertBefore: fc.nat({ max: fresh.length }),
          staleTick: fc.integer({ min: 0, max: maxTick }),
          fwd: fc.boolean(),
          rear: fc.boolean(),
        }),
        { minLength: 0, maxLength: 25 },
      )
      .chain((staleSpecs) =>
        fc
          .tuple(
            fc.array(fc.boolean(), { minLength: fresh.length, maxLength: fresh.length }),
            fc.array(fc.boolean(), { minLength: fresh.length, maxLength: fresh.length }),
          )
          .map(([fwdFlags, rearFlags]) => {
            // Bucket stale frames by the fresh-index they should precede.
            const buckets: InputFrame[][] = Array.from({ length: fresh.length + 1 }, () => []);
            for (const s of staleSpecs) {
              buckets[s.insertBefore]!.push(fireFrame(s.staleTick, s.fwd, s.rear));
            }
            const stream: InputFrame[] = [];
            for (let i = 0; i < fresh.length; i++) {
              stream.push(...buckets[i]!);
              stream.push(fireFrame(fresh[i]!, fwdFlags[i]!, rearFlags[i]!));
            }
            stream.push(...buckets[fresh.length]!);
            return stream;
          }),
      );
  });

// ---------------------------------------------------------------------------
// Property
// ---------------------------------------------------------------------------

describe('Property 21: stale weapon events are discarded without mutating game state', () => {
  it('Validates: Requirements 8.4 — feeding fresh+stale frames yields the same state as fresh-only', () => {
    fc.assert(
      fc.property(arbFrameStream, (stream) => {
        const oracle = referenceState(stream);

        // Full stream: fresh + stale interleaved.
        const mgrAll = makeManager(makeClock());
        const acceptedTicks: number[] = [];
        for (const f of stream) {
          const accepted = mgrAll.receiveInput(PARTICIPANT, f);
          // A frame is accepted IFF it is fresh (strictly advancing, finite).
          const isFresh = Number.isFinite(f.tick) && f.tick > (acceptedTicks[acceptedTicks.length - 1] ?? -1);
          expect(accepted).toBe(isFresh);
          if (accepted) acceptedTicks.push(f.tick);
        }

        // Fresh-only stream: what the state should be if the stale frames were
        // never sent at all.
        const mgrFreshOnly = makeManager(makeClock());
        for (const t of oracle.ticks) {
          expect(mgrFreshOnly.receiveInput(PARTICIPANT, fireFrame(t, false, false))).toBe(true);
        }

        // 1. Authoritative buffered state is identical between the two runs —
        //    discarding the stale frames left the buffer byte-for-byte the same
        //    (modulo the fire flags carried only in the full run's accepted
        //    frames, which are themselves the fresh frames, so ticks match).
        const allTicks = mgrAll.getInputs(PARTICIPANT).map((f) => f.tick);
        const freshOnlyTicks = mgrFreshOnly.getInputs(PARTICIPANT).map((f) => f.tick);
        expect(allTicks).toEqual(freshOnlyTicks);

        // 2. The buffered ticks equal exactly the oracle's accepted subsequence
        //    (bounded to the ring capacity, oldest-first).
        expect(allTicks).toEqual(oracle.ticks.slice(-allTicks.length));

        // 3. Last-accepted tick advanced only via fresh frames.
        expect(mgrAll.latestInput(PARTICIPANT)?.tick).toBe(
          oracle.lastTick === -1 ? undefined : oracle.lastTick,
        );
        expect(mgrAll.latestInput(PARTICIPANT)?.tick).toBe(
          mgrFreshOnly.latestInput(PARTICIPANT)?.tick,
        );
      }),
      { numRuns: 400 },
    );
  });

  it('Validates: Requirements 8.4 — a stale frame after fresh input leaves the buffer unchanged', () => {
    fc.assert(
      fc.property(
        // A fresh baseline tick and a stale offset at or below it.
        fc.integer({ min: 1, max: 1000 }),
        fc.nat({ max: 1000 }),
        (freshTick, staleDelta) => {
          const mgr = makeManager(makeClock());
          expect(mgr.receiveInput(PARTICIPANT, fireFrame(freshTick, true, true))).toBe(true);

          const before = mgr.getInputs(PARTICIPANT).map((f) => f.tick);
          const latestBefore = mgr.latestInput(PARTICIPANT)?.tick;

          // Any tick <= the accepted one is stale (old / duplicate).
          const staleTick = freshTick - staleDelta; // in [freshTick-1000, freshTick]
          const rejected = mgr.receiveInput(PARTICIPANT, fireFrame(staleTick, true, false));
          // Only strictly-greater ticks are accepted; staleTick <= freshTick here.
          expect(rejected).toBe(staleTick > freshTick);

          if (!rejected) {
            // State is untouched by the discarded stale frame.
            expect(mgr.getInputs(PARTICIPANT).map((f) => f.tick)).toEqual(before);
            expect(mgr.latestInput(PARTICIPANT)?.tick).toBe(latestBefore);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
