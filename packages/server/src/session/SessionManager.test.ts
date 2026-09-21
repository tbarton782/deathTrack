/**
 * Unit tests for {@link SessionManager}.
 *
 * Covers config validation for each constraint, create/join/list-open,
 * host transfer to the minimum-`joinedAt` participant, close-when-empty,
 * and AI fill at race start.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.7, 7.8
 */

import { describe, expect, it } from 'vitest';
import type { SessionConfig } from '@deathtrack/shared';
import {
  SessionManager,
  validateConfig,
  type JoinPlayer,
} from './SessionManager.js';

/** Deterministic deps: monotonically increasing clock, sequential ids, fixed random. */
function makeManager(opts: { random?: number } = {}) {
  let clock = 1000;
  let idSeq = 0;
  const random = opts.random ?? 0;
  return new SessionManager({
    now: () => clock++,
    generateId: () => `session-${idSeq++}`,
    random: () => random,
  });
}

function baseConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    name: 'Test Arena',
    trackId: 'chicago',
    maxPlayers: 4,
    password: null,
    fillWithAI: false,
    ...overrides,
  };
}

const host: JoinPlayer = { displayName: 'Host' };

describe('validateConfig', () => {
  it('accepts a valid config', () => {
    expect(validateConfig(baseConfig()).ok).toBe(true);
  });

  it('rejects an empty name', () => {
    const r = validateConfig(baseConfig({ name: '' }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_name');
  });

  it('rejects a name longer than 32 characters', () => {
    const r = validateConfig(baseConfig({ name: 'x'.repeat(33) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_name');
  });

  it('accepts a name of exactly 32 characters', () => {
    expect(validateConfig(baseConfig({ name: 'x'.repeat(32) })).ok).toBe(true);
  });

  it('rejects maxPlayers below 2', () => {
    const r = validateConfig(baseConfig({ maxPlayers: 1 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_max_players');
  });

  it('rejects maxPlayers above 8', () => {
    const r = validateConfig(baseConfig({ maxPlayers: 9 }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_max_players');
  });

  it('accepts maxPlayers at the boundaries 2 and 8', () => {
    expect(validateConfig(baseConfig({ maxPlayers: 2 })).ok).toBe(true);
    expect(validateConfig(baseConfig({ maxPlayers: 8 })).ok).toBe(true);
  });

  it('rejects a password longer than 20 characters', () => {
    const r = validateConfig(baseConfig({ password: 'p'.repeat(21) }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_password');
  });

  it('accepts a password of exactly 20 characters and a null password', () => {
    expect(validateConfig(baseConfig({ password: 'p'.repeat(20) })).ok).toBe(true);
    expect(validateConfig(baseConfig({ password: null })).ok).toBe(true);
  });
});

describe('createSession', () => {
  it('creates a lobby session hosted by the creator at slot 0', () => {
    const mgr = makeManager();
    const r = mgr.createSession(baseConfig(), host);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const s = r.value;
    expect(s.state).toBe('lobby');
    expect(s.hostParticipantId).toBe(0);
    expect(s.participants.size).toBe(1);
    expect(s.participants.get(0)?.displayName).toBe('Host');
    expect(mgr.getSession(s.id)).toBe(s);
  });

  it('does not create a session when the config is invalid', () => {
    const mgr = makeManager();
    const r = mgr.createSession(baseConfig({ maxPlayers: 99 }), host);
    expect(r.ok).toBe(false);
    expect(mgr.listOpenSessions()).toHaveLength(0);
  });

  it('does not leak later mutations of the caller config into the session', () => {
    const mgr = makeManager();
    const cfg = baseConfig();
    const r = mgr.createSession(cfg, host);
    if (!r.ok) throw new Error('expected ok');
    cfg.name = 'Mutated';
    expect(r.value.config.name).toBe('Test Arena');
  });
});

describe('joinSession', () => {
  it('assigns the lowest free slot and returns the session', () => {
    const mgr = makeManager();
    const created = mgr.createSession(baseConfig(), host);
    if (!created.ok) throw new Error('expected ok');
    const res = mgr.joinSession(created.value.id, { displayName: 'P2' });
    expect(res.success).toBe(true);
    expect(res.participantId).toBe(1);
    expect(res.session?.participants.get(1)?.displayName).toBe('P2');
  });

  it('rejects joining an unknown session', () => {
    const mgr = makeManager();
    const res = mgr.joinSession('nope', { displayName: 'X' });
    expect(res.success).toBe(false);
    expect(res.error).toBe('not_found');
  });

  it('rejects joining a full session', () => {
    const mgr = makeManager();
    const created = mgr.createSession(baseConfig({ maxPlayers: 2 }), host);
    if (!created.ok) throw new Error('expected ok');
    mgr.joinSession(created.value.id, { displayName: 'P2' });
    const res = mgr.joinSession(created.value.id, { displayName: 'P3' });
    expect(res.success).toBe(false);
    expect(res.error).toBe('full');
  });

  it('rejects a wrong password and accepts a correct one', () => {
    const mgr = makeManager();
    const created = mgr.createSession(baseConfig({ password: 'secret' }), host);
    if (!created.ok) throw new Error('expected ok');
    const bad = mgr.joinSession(created.value.id, { displayName: 'P2', password: 'nope' });
    expect(bad.success).toBe(false);
    expect(bad.error).toBe('wrong_password');
    const good = mgr.joinSession(created.value.id, { displayName: 'P2', password: 'secret' });
    expect(good.success).toBe(true);
  });

  it('rejects joining a session that has already started', () => {
    const mgr = makeManager();
    const created = mgr.createSession(baseConfig(), host);
    if (!created.ok) throw new Error('expected ok');
    mgr.startRace(created.value);
    const res = mgr.joinSession(created.value.id, { displayName: 'Late' });
    expect(res.success).toBe(false);
    expect(res.error).toBe('already_started');
  });
});

describe('listOpenSessions', () => {
  it('lists lobby sessions with human counts and password flag, omitting closed', () => {
    const mgr = makeManager();
    const a = mgr.createSession(baseConfig({ name: 'A', password: 'pw' }), host);
    const b = mgr.createSession(baseConfig({ name: 'B' }), host);
    if (!a.ok || !b.ok) throw new Error('expected ok');
    mgr.joinSession(a.value.id, { displayName: 'P2', password: 'pw' });
    mgr.closeSession(b.value.id);

    const list = mgr.listOpenSessions();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe('A');
    expect(list[0]?.currentPlayers).toBe(2);
    expect(list[0]?.hasPassword).toBe(true);
    expect(list[0]?.state).toBe('lobby');
  });
});

describe('transferHost', () => {
  it('assigns host to the participant with the smallest joinedAt', () => {
    const mgr = makeManager();
    const created = mgr.createSession(baseConfig(), host); // host joinedAt=1000, slot 0
    if (!created.ok) throw new Error('expected ok');
    const s = created.value;
    mgr.joinSession(s.id, { displayName: 'P2' }); // joinedAt=1001, slot 1
    mgr.joinSession(s.id, { displayName: 'P3' }); // joinedAt=1002, slot 2

    // Remove the original host; next-longest-standing is slot 1.
    s.participants.delete(0);
    mgr.transferHost(s);
    expect(s.hostParticipantId).toBe(1);
  });

  it('closes the session when no human participants remain', () => {
    const mgr = makeManager();
    const created = mgr.createSession(baseConfig(), host);
    if (!created.ok) throw new Error('expected ok');
    const s = created.value;
    s.participants.clear();
    mgr.transferHost(s);
    expect(mgr.getSession(s.id)).toBeUndefined();
    expect(s.state).toBe('closed');
  });

  it('ignores AI participants when selecting a new host', () => {
    const mgr = makeManager();
    const created = mgr.createSession(baseConfig({ fillWithAI: true }), host);
    if (!created.ok) throw new Error('expected ok');
    const s = created.value;
    mgr.joinSession(s.id, { displayName: 'P2' }); // slot 1
    mgr.startRace(s); // fills slots 2,3 with AI (joinedAt later, but AI ignored anyway)
    s.state = 'lobby'; // reset for transfer semantics in this unit test
    s.participants.delete(0);
    mgr.transferHost(s);
    expect(s.hostParticipantId).toBe(1);
    expect(s.participants.get(1)?.isAI).toBe(false);
  });
});

describe('removeParticipant', () => {
  it('transfers host when the host leaves and others remain', () => {
    const mgr = makeManager();
    const created = mgr.createSession(baseConfig(), host);
    if (!created.ok) throw new Error('expected ok');
    const s = created.value;
    mgr.joinSession(s.id, { displayName: 'P2' });
    mgr.removeParticipant(s.id, 0);
    expect(mgr.getSession(s.id)?.hostParticipantId).toBe(1);
  });

  it('closes the session when the last human leaves', () => {
    const mgr = makeManager();
    const created = mgr.createSession(baseConfig(), host);
    if (!created.ok) throw new Error('expected ok');
    const s = created.value;
    mgr.removeParticipant(s.id, 0);
    expect(mgr.getSession(s.id)).toBeUndefined();
  });
});

describe('startRace AI fill', () => {
  it('fills empty slots with AI when fillWithAI is true', () => {
    const mgr = makeManager({ random: 0 });
    const created = mgr.createSession(baseConfig({ maxPlayers: 4, fillWithAI: true }), host);
    if (!created.ok) throw new Error('expected ok');
    const s = created.value;
    mgr.joinSession(s.id, { displayName: 'P2' });
    mgr.startRace(s);
    expect(s.state).toBe('racing');
    expect(s.participants.size).toBe(4);
    const aiSlots = [...s.participants.values()].filter((p) => p.isAI);
    expect(aiSlots).toHaveLength(2);
    for (const ai of aiSlots) {
      expect(ai.aiConfig).toBeDefined();
      expect(ai.aiConfig?.aggression).toBeGreaterThanOrEqual(1);
      expect(ai.aiConfig?.aggression).toBeLessThanOrEqual(5);
    }
  });

  it('does not fill slots when fillWithAI is false but still starts racing', () => {
    const mgr = makeManager();
    const created = mgr.createSession(baseConfig({ maxPlayers: 4, fillWithAI: false }), host);
    if (!created.ok) throw new Error('expected ok');
    const s = created.value;
    mgr.startRace(s);
    expect(s.state).toBe('racing');
    expect(s.participants.size).toBe(1);
  });
});
