/**
 * Property-based test for {@link SessionManager} host-transfer invariants.
 *
 * Property 17: Host transfer preserves exactly one host at all times.
 *
 * *For any* session with an arbitrary set of joined participants and any
 * sequence of participant removals (including the current host), after each
 * removal one of the following holds:
 *   (a) the session is closed because no human participants remain; or
 *   (b) exactly one participant is the host, that host is a current human
 *       participant of the session, and it is the human participant with the
 *       smallest `joinedAt` (longest session membership). Ties on `joinedAt`
 *       are broken deterministically by the smaller slot id.
 *
 * The manager's non-determinism (clock, id generation, random) is injected so
 * the property runs deterministically across all generated inputs.
 *
 * **Property 17**
 * **Validates: Requirements 7.8**
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { Session, SessionConfig } from '@deathtrack/shared';
import { SessionManager, type JoinPlayer } from '../session/SessionManager.js';

/**
 * Builds a deterministic manager with a strictly monotonic clock (so each
 * create/join call yields a distinct, increasing `joinedAt`), sequential
 * session ids, and a fixed random source.
 */
function makeManager() {
  let clock = 1000;
  let idSeq = 0;
  return new SessionManager({
    now: () => clock++,
    generateId: () => `session-${idSeq++}`,
    random: () => 0,
  });
}

function baseConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    name: 'Prop Arena',
    trackId: 'chicago',
    maxPlayers: 8,
    password: null,
    fillWithAI: false,
    ...overrides,
  };
}

/**
 * Asserts the host invariant on a live session that still exists in the
 * manager. Exactly one participant must be host; it must be a current human;
 * and it must be the human with the minimum `joinedAt` (ties by slot id).
 */
function assertHostInvariant(session: Session): void {
  const humans = [...session.participants.values()].filter((p) => !p.isAI);
  // If the session is still live in the manager, at least one human remains.
  expect(humans.length).toBeGreaterThan(0);

  const host = session.participants.get(session.hostParticipantId);
  expect(host).toBeDefined();
  expect(host?.isAI).toBe(false);

  // The host is the human with the smallest joinedAt (ties broken by slot id).
  const expected = humans.reduce((best, p) => {
    if (p.joinedAt < best.joinedAt) return p;
    if (p.joinedAt === best.joinedAt && p.id < best.id) return p;
    return best;
  });
  expect(session.hostParticipantId).toBe(expected.id);
}

describe('Property 17: host transfer preserves exactly one host at all times', () => {
  it('Validates: Requirements 7.8 — after any removal sequence, exactly one host remains or the session is closed', () => {
    fc.assert(
      fc.property(
        // Number of additional joiners beyond the host (host occupies slot 0).
        fc.integer({ min: 0, max: 7 }),
        // A sequence of removal decisions; each is an index into the *current*
        // set of occupied slots, so it always targets a live participant
        // (including, potentially, the current host).
        fc.array(fc.nat({ max: 20 }), { minLength: 0, maxLength: 12 }),
        (extraJoiners, removalPicks) => {
          const mgr = makeManager();
          const host: JoinPlayer = { displayName: 'Host' };
          const created = mgr.createSession(baseConfig(), host);
          if (!created.ok) throw new Error('expected session creation to succeed');
          const sessionId = created.value.id;

          // Fill remaining human slots up to maxPlayers.
          for (let i = 0; i < extraJoiners; i++) {
            const res = mgr.joinSession(sessionId, { displayName: `P${i + 1}` });
            expect(res.success).toBe(true);
          }

          // Snapshot config to verify it is preserved across transfers.
          const originalConfig = { ...created.value.config };

          for (const pick of removalPicks) {
            const live = mgr.getSession(sessionId);
            if (!live) break; // Session already closed; nothing left to remove.

            const slots = [...live.participants.keys()];
            if (slots.length === 0) break;
            const target = slots[pick % slots.length]!;

            mgr.removeParticipant(sessionId, target);

            const after = mgr.getSession(sessionId);
            if (!after) {
              // (a) Session closed: only valid when no humans remained.
              // Nothing further to assert; the manager removed it.
              continue;
            }

            // (b) Session still live: exactly one valid host remains.
            assertHostInvariant(after);

            // Config is preserved across host transfers (Req 7.8).
            expect(after.config).toEqual(originalConfig);
          }

          // Final state: either closed, or the invariant still holds.
          const finalSession = mgr.getSession(sessionId);
          if (finalSession) {
            assertHostInvariant(finalSession);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('Validates: Requirements 7.8 — removing every human in turn eventually closes the session with no dangling host', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 7 }), (extraJoiners) => {
        const mgr = makeManager();
        const created = mgr.createSession(baseConfig(), { displayName: 'Host' });
        if (!created.ok) throw new Error('expected session creation to succeed');
        const sessionId = created.value.id;

        for (let i = 0; i < extraJoiners; i++) {
          mgr.joinSession(sessionId, { displayName: `P${i + 1}` });
        }

        // Repeatedly remove the current host until the session closes.
        let guard = 0;
        while (guard++ < 100) {
          const live = mgr.getSession(sessionId);
          if (!live) break;
          assertHostInvariant(live);
          mgr.removeParticipant(sessionId, live.hostParticipantId);
        }

        // The loop must terminate with a closed session (no humans remain).
        expect(mgr.getSession(sessionId)).toBeUndefined();
      }),
      { numRuns: 200 },
    );
  });
});
