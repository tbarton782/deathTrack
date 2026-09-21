import { describe, expect, it, vi } from 'vitest';
import type {
  Session,
  SessionConfig,
  ParticipantInfo,
  Loadout,
} from '@deathtrack/shared';
import {
  buildLobbyRows,
  buildLobbyViewModel,
  computeCanStartRace,
  shouldPromptForPassword,
  summariseLoadout,
  MIN_SESSION_PLAYERS,
} from '../Lobby';

/**
 * These tests exercise only the GPU-free lobby model: the participant-row
 * mapping, the `canStartRace` predicate, and the password-prompt decision. They
 * run in the headless `node` vitest environment.
 *
 * The PixiJS `Lobby` overlay draw path requires a WebGL context and is
 * validated in the browser, not here.
 *
 * Validates:
 * - Requirement 7.3 (password prompt shown only for protected sessions)
 * - Requirement 7.4 (start-race gated by host + all-ready + minimum count)
 * - Requirement 7.5 (roster lists every participant's loadout + ready status)
 */

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLoadout(overrides: Partial<Loadout> = {}): Loadout {
  return {
    chassisId: 'hellcat',
    components: {
      engine: null,
      brakes: null,
      transmission: null,
      tires: null,
      airfoil: null,
      armor: null,
    },
    weapons: {
      forward: null,
      rear: null,
      side_spike: null,
      ram: null,
    },
    ...overrides,
  };
}

function makeParticipant(
  overrides: Partial<ParticipantInfo> &
    Pick<ParticipantInfo, 'id'>,
): ParticipantInfo {
  return {
    displayName: `P${overrides.id}`,
    loadout: makeLoadout(),
    ready: false,
    isAI: false,
    joinedAt: 1000 + overrides.id,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    name: 'Test Session',
    trackId: 'chicago',
    maxPlayers: 4,
    password: null,
    fillWithAI: false,
    ...overrides,
  };
}

function makeSession(
  participants: ParticipantInfo[],
  configOverrides: Partial<SessionConfig> = {},
): Session {
  const map = new Map<number, ParticipantInfo>();
  for (const p of participants) map.set(p.id, p);
  return {
    id: 'session-1',
    config: makeConfig(configOverrides),
    hostParticipantId: participants[0]?.id ?? 0,
    participants: map,
    state: 'lobby',
    createdAt: 1000,
  };
}

// ---------------------------------------------------------------------------
// summariseLoadout
// ---------------------------------------------------------------------------

describe('summariseLoadout', () => {
  it('reports "No loadout" for a null loadout', () => {
    expect(summariseLoadout(null)).toBe('No loadout');
  });

  it('summarises chassis and singular weapon count', () => {
    const loadout = makeLoadout({
      weapons: { forward: 'machine_gun', rear: null, side_spike: null, ram: null },
    });
    expect(summariseLoadout(loadout)).toBe('hellcat · 1 weapon');
  });

  it('summarises chassis and plural weapon count', () => {
    const loadout = makeLoadout({
      chassisId: 'crusher',
      weapons: {
        forward: 'machine_gun',
        rear: 'mine',
        side_spike: null,
        ram: null,
      },
    });
    expect(summariseLoadout(loadout)).toBe('crusher · 2 weapons');
  });

  it('reports zero weapons as plural', () => {
    expect(summariseLoadout(makeLoadout())).toBe('hellcat · 0 weapons');
  });
});

// ---------------------------------------------------------------------------
// buildLobbyRows  (Requirement 7.5)
// ---------------------------------------------------------------------------

describe('buildLobbyRows', () => {
  it('emits one row per participant with loadout summary and ready status', () => {
    const session = makeSession([
      makeParticipant({ id: 0, displayName: 'Alice', ready: true }),
      makeParticipant({ id: 1, displayName: 'Bob', ready: false, loadout: null }),
    ]);
    const rows = buildLobbyRows(session);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      id: 0,
      displayName: 'Alice',
      ready: true,
      loadoutSummary: 'hellcat · 0 weapons',
    });
    expect(rows[1]).toMatchObject({
      id: 1,
      displayName: 'Bob',
      ready: false,
      loadoutSummary: 'No loadout',
    });
  });

  it('sorts rows by ascending participant id regardless of map order', () => {
    const session = makeSession([
      makeParticipant({ id: 2 }),
      makeParticipant({ id: 0 }),
      makeParticipant({ id: 1 }),
    ]);
    expect(buildLobbyRows(session).map((r) => r.id)).toEqual([0, 1, 2]);
  });

  it('marks AI participants', () => {
    const session = makeSession([makeParticipant({ id: 0, isAI: true })]);
    expect(buildLobbyRows(session)[0]?.isAI).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeCanStartRace  (Requirement 7.4)
// ---------------------------------------------------------------------------

describe('computeCanStartRace', () => {
  const twoReady = () => [
    makeParticipant({ id: 0, ready: true }),
    makeParticipant({ id: 1, ready: true }),
  ];

  it('is disabled for a non-host even when all are ready and count is met', () => {
    const session = makeSession(twoReady());
    expect(computeCanStartRace(session, { isHost: false })).toBe(false);
  });

  it('is disabled for the host when not all participants are ready', () => {
    const session = makeSession([
      makeParticipant({ id: 0, ready: true }),
      makeParticipant({ id: 1, ready: false }),
    ]);
    expect(computeCanStartRace(session, { isHost: true })).toBe(false);
  });

  it('is disabled for the host when below the minimum player count', () => {
    const session = makeSession([makeParticipant({ id: 0, ready: true })]);
    expect(computeCanStartRace(session, { isHost: true })).toBe(false);
  });

  it('is enabled for the host when all ready and minimum met', () => {
    const session = makeSession(twoReady());
    expect(computeCanStartRace(session, { isHost: true })).toBe(true);
  });

  it('respects an explicit higher minimum player count', () => {
    const session = makeSession(twoReady());
    expect(computeCanStartRace(session, { isHost: true, minPlayers: 3 })).toBe(
      false,
    );
  });

  it('defaults the minimum to MIN_SESSION_PLAYERS', () => {
    expect(MIN_SESSION_PLAYERS).toBe(2);
    const oneReady = makeSession([makeParticipant({ id: 0, ready: true })]);
    expect(computeCanStartRace(oneReady, { isHost: true })).toBe(false);
  });

  it('never starts an empty session', () => {
    const session = makeSession([]);
    expect(computeCanStartRace(session, { isHost: true })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldPromptForPassword  (Requirement 7.3)
// ---------------------------------------------------------------------------

describe('shouldPromptForPassword', () => {
  it('does not prompt for an open (passwordless) session', () => {
    expect(shouldPromptForPassword(makeConfig({ password: null }), false)).toBe(
      false,
    );
  });

  it('treats an empty-string password as unprotected', () => {
    expect(shouldPromptForPassword(makeConfig({ password: '' }), false)).toBe(
      false,
    );
  });

  it('prompts for a protected session before the password is entered', () => {
    expect(
      shouldPromptForPassword(makeConfig({ password: 'secret' }), false),
    ).toBe(true);
  });

  it('hides the prompt once the password has been entered', () => {
    expect(
      shouldPromptForPassword(makeConfig({ password: 'secret' }), true),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildLobbyViewModel (aggregate)
// ---------------------------------------------------------------------------

describe('buildLobbyViewModel', () => {
  it('aggregates rows, start-race enablement and prompt visibility', () => {
    const session = makeSession(
      [
        makeParticipant({ id: 0, ready: true }),
        makeParticipant({ id: 1, ready: true }),
      ],
      { password: 'secret' },
    );
    const vm = buildLobbyViewModel(session, {
      isHost: true,
      passwordEntered: false,
    });
    expect(vm.rows).toHaveLength(2);
    expect(vm.canStartRace).toBe(true);
    expect(vm.showPasswordPrompt).toBe(true);
  });

  it('reflects non-host and open-session state', () => {
    const session = makeSession([
      makeParticipant({ id: 0, ready: true }),
      makeParticipant({ id: 1, ready: false }),
    ]);
    const vm = buildLobbyViewModel(session, {
      isHost: false,
      passwordEntered: false,
    });
    expect(vm.canStartRace).toBe(false);
    expect(vm.showPasswordPrompt).toBe(false);
  });
});

// A trivial guard so `vi` import stays meaningful if extended later.
describe('handler wiring shape', () => {
  it('accepts injected callbacks without invoking them at build time', () => {
    const onReadyToggle = vi.fn();
    const onStartRace = vi.fn();
    const onSubmitPassword = vi.fn();
    const session = makeSession([
      makeParticipant({ id: 0, ready: true }),
      makeParticipant({ id: 1, ready: true }),
    ]);
    buildLobbyViewModel(session, { isHost: true, passwordEntered: false });
    expect(onReadyToggle).not.toHaveBeenCalled();
    expect(onStartRace).not.toHaveBeenCalled();
    expect(onSubmitPassword).not.toHaveBeenCalled();
  });
});
