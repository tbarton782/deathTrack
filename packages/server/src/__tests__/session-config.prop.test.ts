/**
 * Property-based tests for {@link SessionManager} config validation.
 *
 * Property 16: Session creation validates all config constraints.
 *
 * For an arbitrary {@link SessionConfig}, `validateConfig` accepts the config
 * IF AND ONLY IF all of the following hold:
 *   - `name` length is in [SESSION_NAME_MIN, SESSION_NAME_MAX] (1..32);
 *   - `maxPlayers` is an integer in [SESSION_MAX_PLAYERS_MIN, SESSION_MAX_PLAYERS_MAX] (2..8);
 *   - `password` is null OR its length is <= SESSION_PASSWORD_MAX (20).
 * Otherwise it rejects with the corresponding error code (`invalid_name`,
 * `invalid_max_players`, or `invalid_password`, checked in that priority order).
 * When the config is invalid, `createSession` must NOT create a session.
 *
 * Validates: Requirements 7.1, 7.3
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { SessionConfig, TrackId } from '@deathtrack/shared';
import {
  SessionManager,
  validateConfig,
  SESSION_NAME_MIN,
  SESSION_NAME_MAX,
  SESSION_MAX_PLAYERS_MIN,
  SESSION_MAX_PLAYERS_MAX,
  SESSION_PASSWORD_MAX,
  type JoinPlayer,
  type SessionError,
} from '../session/SessionManager.js';

const TRACK_IDS: readonly TrackId[] = [
  'bay_area',
  'boston',
  'chicago',
  'houston',
  'los_angeles',
  'manhattan',
  'orlando',
  'phoenix',
  'seattle',
  'st_louis',
];

const host: JoinPlayer = { displayName: 'Host' };

/**
 * Deterministic manager: monotonic clock, sequential ids, fixed random. The
 * property only cares about whether a session is created, so determinism here
 * simply keeps ids stable and side-effect-free.
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

/**
 * The reference oracle mirroring `validateConfig`'s contract. Returns `null`
 * when the config is valid, otherwise the expected error code following the
 * same precedence the implementation documents: name, then maxPlayers, then
 * password.
 */
function expectedError(config: SessionConfig): SessionError | null {
  if (
    typeof config.name !== 'string' ||
    config.name.length < SESSION_NAME_MIN ||
    config.name.length > SESSION_NAME_MAX
  ) {
    return 'invalid_name';
  }
  if (
    !Number.isInteger(config.maxPlayers) ||
    config.maxPlayers < SESSION_MAX_PLAYERS_MIN ||
    config.maxPlayers > SESSION_MAX_PLAYERS_MAX
  ) {
    return 'invalid_max_players';
  }
  if (config.password !== null && config.password.length > SESSION_PASSWORD_MAX) {
    return 'invalid_password';
  }
  return null;
}

/**
 * A generator covering the full input space around every constraint boundary:
 * names from empty through well over the max, maxPlayers spanning below/inside/
 * above the range plus non-integers, and passwords that are null, short, at the
 * boundary, or too long. This intelligently constrains generation to the region
 * where accept/reject decisions flip rather than sampling arbitrary huge values.
 */
const arbConfig: fc.Arbitrary<SessionConfig> = fc.record({
  // Lengths 0..40 straddle both the min (1) and max (32) name bounds.
  name: fc.nat({ max: 40 }).map((n) => 'x'.repeat(n)),
  trackId: fc.constantFrom(...TRACK_IDS),
  // Mix integers straddling [2, 8] with occasional non-integers.
  maxPlayers: fc.oneof(
    fc.integer({ min: 0, max: 12 }),
    fc.double({ min: 0, max: 12, noNaN: true }),
  ),
  // null, or strings of length 0..30 straddling the 20-char cap.
  password: fc.oneof(
    fc.constant<string | null>(null),
    fc.nat({ max: 30 }).map((n) => 'p'.repeat(n)),
  ),
  fillWithAI: fc.boolean(),
});

describe('Property 16: Session creation validates all config constraints', () => {
  it('validateConfig accepts IFF all constraints hold, else rejects with the matching code', () => {
    fc.assert(
      fc.property(arbConfig, (config) => {
        const expected = expectedError(config);
        const result = validateConfig(config);

        if (expected === null) {
          expect(result.ok).toBe(true);
        } else {
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toBe(expected);
          }
        }
      }),
    );
  });

  it('createSession creates a session IFF the config is valid, and never otherwise', () => {
    fc.assert(
      fc.property(arbConfig, (config) => {
        const mgr = makeManager();
        const expected = expectedError(config);
        const result = mgr.createSession(config, host);

        if (expected === null) {
          // Valid config: a lobby session hosted by the creator must exist.
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(mgr.getSession(result.value.id)).toBe(result.value);
            expect(result.value.state).toBe('lobby');
          }
          expect(mgr.listOpenSessions()).toHaveLength(1);
        } else {
          // Invalid config: rejection with the matching code, nothing created.
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error).toBe(expected);
          }
          expect(mgr.listOpenSessions()).toHaveLength(0);
        }
      }),
    );
  });
});
