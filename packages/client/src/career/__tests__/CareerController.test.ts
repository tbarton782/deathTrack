import { describe, expect, it, vi } from 'vitest';
import {
  newCareer,
  type CareerState,
  type PrizeTable,
  type SaveSlot,
} from '@deathtrack/shared';
import {
  AUTO_SAVE_BUDGET_MS,
  CareerController,
  type CancelHandle,
  type CareerControllerOptions,
} from '../CareerController.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * A controllable fake {@link SaveScheduler}. It records every scheduled
 * callback with its delay and only runs it when the test explicitly advances
 * time, so the 5-second auto-save budget can be asserted deterministically
 * without any wall-clock wait.
 */
class FakeScheduler {
  private now = 0;
  private nextId = 0;
  private readonly pending = new Map<
    number,
    { runAt: number; callback: () => void }
  >();

  /** The injectable scheduler function. */
  readonly schedule = (callback: () => void, delayMs: number): CancelHandle => {
    const id = this.nextId++;
    this.pending.set(id, { runAt: this.now + delayMs, callback });
    return () => {
      this.pending.delete(id);
    };
  };

  /** Number of callbacks still pending (scheduled and not yet run/cancelled). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Advance the fake clock by `ms`, firing any callbacks whose time arrives. */
  advance(ms: number): void {
    this.now += ms;
    for (const [id, entry] of [...this.pending.entries()]) {
      if (entry.runAt <= this.now) {
        this.pending.delete(id);
        entry.callback();
      }
    }
  }
}

/** A default prize table: 1st = 1000, 2nd = 600, 3rd = 300; +50 per kill. */
const PRIZE_TABLE: PrizeTable = {
  placementPrizes: [0, 1000, 600, 300, 100],
  eliminationBonus: 50,
};

const SLOT: SaveSlot = 1;

function baseCareer(overrides: Partial<CareerState> = {}): CareerState {
  return { ...newCareer(SLOT, 'Racer', 500), ...overrides };
}

/**
 * Build a controller wired with a fake scheduler and a spy saver, returning all
 * three so tests can drive the timer and assert on saves.
 */
function makeController(
  careerOverrides: Partial<CareerState> = {},
  optionOverrides: Partial<CareerControllerOptions> = {},
) {
  const scheduler = new FakeScheduler();
  const saver = vi.fn((_career: CareerState, _slot: SaveSlot) => {});
  const controller = new CareerController({
    career: baseCareer(careerOverrides),
    prizeTable: PRIZE_TABLE,
    saver,
    scheduler: scheduler.schedule,
    ...optionOverrides,
  });
  return { controller, scheduler, saver };
}

// ---------------------------------------------------------------------------
// Flow transitions
// ---------------------------------------------------------------------------

describe('CareerController flow transitions', () => {
  it('starts in the config phase', () => {
    const { controller } = makeController();
    expect(controller.phase).toBe('config');
  });

  it('drives config -> race -> results -> shop -> config across a full loop', () => {
    const { controller } = makeController();

    expect(controller.startRace()).toBe(true);
    expect(controller.phase).toBe('race');

    const finished = controller.finishRace({ placement: 1, eliminationCount: 0 });
    expect(finished).not.toBeNull();
    expect(controller.phase).toBe('results');

    expect(controller.enterShop()).toBe(true);
    expect(controller.phase).toBe('shop');

    expect(controller.nextRace()).toBe(true);
    expect(controller.phase).toBe('config');
  });

  it('rejects out-of-order transitions as no-ops', () => {
    const { controller } = makeController();

    // Cannot finish a race we never started.
    expect(controller.finishRace({ placement: 1, eliminationCount: 0 })).toBeNull();
    // Cannot enter the shop from config.
    expect(controller.enterShop()).toBe(false);
    // Cannot advance to next race from config.
    expect(controller.nextRace()).toBe(false);
    expect(controller.phase).toBe('config');
  });

  it('notifies the phase-change listener with (next, previous)', () => {
    const changes: Array<[string, string]> = [];
    const { controller } = makeController(
      {},
      { onPhaseChange: (next, prev) => changes.push([next, prev]) },
    );

    controller.startRace();
    controller.finishRace({ placement: 2, eliminationCount: 1 });
    controller.enterShop();
    controller.nextRace();

    expect(changes).toEqual([
      ['race', 'config'],
      ['results', 'race'],
      ['shop', 'results'],
      ['config', 'shop'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Prize money via computePrizeMoney
// ---------------------------------------------------------------------------

describe('CareerController prize money on results', () => {
  it('computes prize via computePrizeMoney and adds it to career money', () => {
    const { controller } = makeController({ money: 500 });
    controller.startRace();

    // placement 2 -> 600, plus 3 kills * 50 = 150 => 750.
    const result = controller.finishRace({ placement: 2, eliminationCount: 3 });

    expect(result?.prizeMoney).toBe(750);
    expect(controller.career.money).toBe(500 + 750);
    expect(controller.career.totalEarnings).toBe(750);
    expect(controller.career.eliminationCount).toBe(3);
  });

  it('accumulates earnings and kills across multiple races', () => {
    const { controller } = makeController({ money: 0 });

    controller.startRace();
    controller.finishRace({ placement: 1, eliminationCount: 2 }); // 1000 + 100 = 1100
    controller.enterShop();
    controller.nextRace();

    controller.startRace();
    controller.finishRace({ placement: 3, eliminationCount: 1 }); // 300 + 50 = 350

    expect(controller.career.money).toBe(1100 + 350);
    expect(controller.career.totalEarnings).toBe(1100 + 350);
    expect(controller.career.eliminationCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Shop purchases via purchaseItem
// ---------------------------------------------------------------------------

describe('CareerController shop purchases', () => {
  it('deducts an affordable purchase atomically via purchaseItem', () => {
    const { controller } = makeController({ money: 1000 });
    controller.startRace();
    controller.finishRace({ placement: 4, eliminationCount: 0 }); // +100 => 1100
    controller.enterShop();

    const result = controller.buyItem(400);
    expect(result.ok).toBe(true);
    expect(controller.career.money).toBe(1100 - 400);
  });

  it('rejects an unaffordable purchase with the exact shortfall and no deduction', () => {
    const { controller } = makeController({ money: 100 });
    controller.startRace();
    controller.finishRace({ placement: 4, eliminationCount: 0 }); // +100 => 200
    controller.enterShop();

    const result = controller.buyItem(500);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('insufficient_funds');
      expect(result.shortfall).toBe(300); // 500 - 200
    }
    expect(controller.career.money).toBe(200);
  });

  it('refuses purchases outside the shop phase', () => {
    const { controller } = makeController({ money: 1000 });
    // Still in config.
    const result = controller.buyItem(100);
    expect(result.ok).toBe(false);
    expect(controller.career.money).toBe(1000);
  });
});

// ---------------------------------------------------------------------------
// Circuit advancement via advanceCircuit
// ---------------------------------------------------------------------------

describe('CareerController circuit advancement', () => {
  it('advances the circuit index when moving to the next race', () => {
    const { controller } = makeController({ currentCircuitIndex: 0, circuitNumber: 1 });
    controller.startRace();
    controller.finishRace({ placement: 1, eliminationCount: 0 });
    controller.enterShop();

    controller.nextRace();
    expect(controller.career.currentCircuitIndex).toBe(1);
    expect(controller.career.circuitNumber).toBe(1);
  });

  it('wraps to a new circuit after the tenth track', () => {
    const { controller } = makeController({ currentCircuitIndex: 9, circuitNumber: 1 });
    controller.startRace();
    controller.finishRace({ placement: 1, eliminationCount: 0 });
    controller.enterShop();

    controller.nextRace();
    expect(controller.career.currentCircuitIndex).toBe(0);
    expect(controller.career.circuitNumber).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Auto-save within the 5 s budget (Requirement 12.1)
// ---------------------------------------------------------------------------

describe('CareerController auto-save after a race', () => {
  it('schedules the auto-save at no more than the 5 s budget', () => {
    const { controller, saver } = makeController();
    controller.startRace();
    controller.finishRace({ placement: 1, eliminationCount: 0 });

    // A save is scheduled but has not yet fired.
    expect(controller.hasPendingAutoSave).toBe(true);
    expect(saver).not.toHaveBeenCalled();
    expect(controller.effectiveAutoSaveDelayMs).toBeLessThanOrEqual(AUTO_SAVE_BUDGET_MS);
  });

  it('does not save before the budget elapses', () => {
    const { controller, scheduler, saver } = makeController();
    controller.startRace();
    controller.finishRace({ placement: 1, eliminationCount: 0 });

    scheduler.advance(AUTO_SAVE_BUDGET_MS - 1);
    expect(saver).not.toHaveBeenCalled();
  });

  it('saves the career within the 5 s budget when the timer elapses', () => {
    const { controller, scheduler, saver } = makeController({ money: 250 });
    controller.startRace();
    controller.finishRace({ placement: 1, eliminationCount: 0 }); // +1000 => 1250

    scheduler.advance(AUTO_SAVE_BUDGET_MS);

    expect(saver).toHaveBeenCalledTimes(1);
    const [savedCareer, savedSlot] = saver.mock.calls[0]!;
    expect(savedCareer.money).toBe(1250);
    expect(savedSlot).toBe(SLOT);
    expect(controller.hasPendingAutoSave).toBe(false);
  });

  it('persists shop purchases made before the auto-save timer fires', () => {
    const { controller, scheduler, saver } = makeController({ money: 0 });
    controller.startRace();
    controller.finishRace({ placement: 1, eliminationCount: 0 }); // +1000 => 1000
    controller.enterShop();
    controller.buyItem(400); // 1000 - 400 => 600

    scheduler.advance(AUTO_SAVE_BUDGET_MS);

    expect(saver).toHaveBeenCalledTimes(1);
    expect(saver.mock.calls[0]![0].money).toBe(600);
  });

  it('clamps an over-budget requested delay down to the 5 s budget', () => {
    const { controller } = makeController({}, { autoSaveDelayMs: 10_000 });
    expect(controller.effectiveAutoSaveDelayMs).toBe(AUTO_SAVE_BUDGET_MS);
  });

  it('saveNow cancels the pending auto-save and saves immediately', () => {
    const { controller, scheduler, saver } = makeController();
    controller.startRace();
    controller.finishRace({ placement: 1, eliminationCount: 0 });

    expect(controller.hasPendingAutoSave).toBe(true);
    controller.saveNow();

    expect(saver).toHaveBeenCalledTimes(1);
    expect(controller.hasPendingAutoSave).toBe(false);

    // Advancing time must not trigger a second (auto) save.
    scheduler.advance(AUTO_SAVE_BUDGET_MS);
    expect(saver).toHaveBeenCalledTimes(1);
  });

  it('only one auto-save is outstanding across back-to-back races', () => {
    const { controller, scheduler, saver } = makeController();

    controller.startRace();
    controller.finishRace({ placement: 1, eliminationCount: 0 });
    controller.enterShop();
    controller.nextRace();
    controller.startRace();
    controller.finishRace({ placement: 2, eliminationCount: 0 });

    expect(scheduler.pendingCount).toBe(1);
    scheduler.advance(AUTO_SAVE_BUDGET_MS);
    expect(saver).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// newCareer factory
// ---------------------------------------------------------------------------

describe('CareerController.newCareer factory', () => {
  it('creates a fresh career at track 1 in the config phase', () => {
    const scheduler = new FakeScheduler();
    const saver = vi.fn();
    const controller = CareerController.newCareer(2, 'Nova', 750, {
      prizeTable: PRIZE_TABLE,
      saver,
      scheduler: scheduler.schedule,
    });

    expect(controller.phase).toBe('config');
    expect(controller.career.saveSlot).toBe(2);
    expect(controller.career.playerName).toBe('Nova');
    expect(controller.career.money).toBe(750);
    expect(controller.career.currentCircuitIndex).toBe(0);
    expect(controller.career.circuitNumber).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Save-slot management (task 21.2 — Requirements 12.3, 12.5, 12.6)
// ---------------------------------------------------------------------------

import {
  CorruptSaveError,
  SaveManager,
  InMemorySlotStorage,
  type SlotInfo,
} from '@deathtrack/shared';

/**
 * Build a controller wired with an injected slot lister and slot loader (both
 * spies over in-memory data) plus a spy saver, so slot-management behaviour can
 * be asserted without touching disk/IndexedDB.
 */
function makeSlotController(
  slots: SlotInfo[],
  loader: (slot: SaveSlot) => CareerState | null | Promise<CareerState | null>,
) {
  const saver = vi.fn((_career: CareerState, _slot: SaveSlot) => {});
  const slotLister = vi.fn(() => slots);
  const slotLoader = vi.fn(loader);
  const controller = new CareerController({
    career: baseCareer(),
    prizeTable: PRIZE_TABLE,
    saver,
    slotLister,
    slotLoader,
  });
  return { controller, saver, slotLister, slotLoader };
}

function slotInfo(slot: SaveSlot, exists: boolean, playerName = '', totalEarnings = 0): SlotInfo {
  return { slot, playerName, totalEarnings, exists };
}

describe('CareerController.listSlots', () => {
  it('returns occupied and empty slot metadata via the injected lister', async () => {
    const slots: SlotInfo[] = [
      slotInfo(1, true, 'Ace', 4200),
      slotInfo(2, false),
      slotInfo(3, false),
    ];
    const { controller, slotLister } = makeSlotController(slots, () => null);

    const listed = await controller.listSlots();

    expect(slotLister).toHaveBeenCalledTimes(1);
    expect(listed).toHaveLength(3);
    expect(listed[0]).toMatchObject({ slot: 1, exists: true, playerName: 'Ace', totalEarnings: 4200 });
    expect(listed[1]).toMatchObject({ slot: 2, exists: false });
    expect(listed[2]).toMatchObject({ slot: 3, exists: false });
  });

  it('throws when no slot lister was injected', async () => {
    const { controller } = makeController();
    await expect(controller.listSlots()).rejects.toThrow(/slot lister/);
  });

  it('reflects real SaveManager listing of occupied vs empty slots', async () => {
    const storage = new InMemorySlotStorage();
    const manager = new SaveManager(storage);
    await manager.save({ ...baseCareer({ playerName: 'Zed', totalEarnings: 999 }), saveSlot: 1 }, 1);

    const controller = new CareerController({
      career: baseCareer(),
      prizeTable: PRIZE_TABLE,
      saver: (career, slot) => manager.save(career, slot),
      slotLister: () => manager.listSlots(),
      slotLoader: (slot) => manager.load(slot),
    });

    const listed = await controller.listSlots();
    expect(listed.find((s) => s.slot === 1)).toMatchObject({ exists: true, playerName: 'Zed', totalEarnings: 999 });
    expect(listed.find((s) => s.slot === 2)).toMatchObject({ exists: false });
    expect(listed.find((s) => s.slot === 3)).toMatchObject({ exists: false });
  });
});

describe('CareerController overwrite confirmation (Requirement 12.6)', () => {
  it('saves immediately to an EMPTY slot without confirmation', async () => {
    const { controller, saver } = makeSlotController(
      [slotInfo(1, false), slotInfo(2, false), slotInfo(3, false)],
      () => null,
    );

    const outcome = await controller.requestSave(1);

    expect(outcome).toBe('saved');
    expect(controller.hasPendingOverwrite).toBe(false);
    expect(saver).toHaveBeenCalledTimes(1);
    expect(saver.mock.calls[0]![1]).toBe(1);
  });

  it('does NOT overwrite an OCCUPIED slot without explicit confirmation', async () => {
    const { controller, saver } = makeSlotController(
      [slotInfo(1, true, 'Old', 100), slotInfo(2, false), slotInfo(3, false)],
      () => null,
    );

    const outcome = await controller.requestSave(1);

    expect(outcome).toBe('confirm_overwrite');
    expect(controller.hasPendingOverwrite).toBe(true);
    expect(controller.pendingOverwriteSlot).toBe(1);
    // Crucially: nothing was written yet.
    expect(saver).not.toHaveBeenCalled();
  });

  it('writes the occupied slot only after confirmOverwrite', async () => {
    const { controller, saver } = makeSlotController(
      [slotInfo(1, true, 'Old', 100), slotInfo(2, false), slotInfo(3, false)],
      () => null,
    );

    await controller.requestSave(1);
    expect(saver).not.toHaveBeenCalled();

    const confirmed = controller.confirmOverwrite();
    expect(confirmed).toBe(true);
    expect(saver).toHaveBeenCalledTimes(1);
    expect(saver.mock.calls[0]![1]).toBe(1);
    expect(controller.hasPendingOverwrite).toBe(false);
  });

  it('cancelOverwrite abandons the staged save, leaving the slot untouched', async () => {
    const { controller, saver } = makeSlotController(
      [slotInfo(1, true, 'Old', 100), slotInfo(2, false), slotInfo(3, false)],
      () => null,
    );

    await controller.requestSave(1);
    controller.cancelOverwrite();

    expect(controller.hasPendingOverwrite).toBe(false);
    expect(saver).not.toHaveBeenCalled();
    // A follow-up confirm is now a no-op.
    expect(controller.confirmOverwrite()).toBe(false);
    expect(saver).not.toHaveBeenCalled();
  });
});

describe('CareerController corrupt-save handling (Requirement 12.3)', () => {
  const corruptLoader = (slot: SaveSlot): CareerState => {
    throw new CorruptSaveError('crc-mismatch', `slot ${slot} failed CRC`);
  };

  it('surfaces a corrupt condition on load WITHOUT overwriting the slot', async () => {
    const { controller, saver } = makeSlotController(
      [slotInfo(1, false), slotInfo(2, false), slotInfo(3, false)],
      corruptLoader,
    );

    const result = await controller.loadSlot(2);

    expect(result.status).toBe('corrupt');
    if (result.status === 'corrupt') {
      expect(result.corrupt.slot).toBe(2);
      expect(result.corrupt.message).toContain('CRC');
    }
    expect(controller.corruptSave?.slot).toBe(2);
    // The corrupt slot must not be written during load.
    expect(saver).not.toHaveBeenCalled();
  });

  it('startFreshFromCorrupt begins a new career without clobbering the corrupt slot until an explicit save', async () => {
    const { controller, saver } = makeSlotController(
      [slotInfo(1, false), slotInfo(2, false), slotInfo(3, false)],
      corruptLoader,
    );

    await controller.loadSlot(2);
    expect(controller.corruptSave).not.toBeNull();

    const fresh = controller.startFreshFromCorrupt(2, 'FreshStart', 500);

    expect(fresh.playerName).toBe('FreshStart');
    expect(fresh.saveSlot).toBe(2);
    expect(fresh.currentCircuitIndex).toBe(0);
    expect(controller.career).toBe(fresh);
    expect(controller.phase).toBe('config');
    // Corrupt screen cleared.
    expect(controller.corruptSave).toBeNull();
    // Still nothing persisted — the corrupt slot remains untouched.
    expect(saver).not.toHaveBeenCalled();
  });

  it('persists the fresh career to the slot only on an explicit save', async () => {
    const { controller, saver } = makeSlotController(
      [slotInfo(1, false), slotInfo(2, false), slotInfo(3, false)],
      corruptLoader,
    );

    await controller.loadSlot(2);
    controller.startFreshFromCorrupt(2, 'FreshStart', 500);
    expect(saver).not.toHaveBeenCalled();

    controller.saveNow();

    expect(saver).toHaveBeenCalledTimes(1);
    const [savedCareer, savedSlot] = saver.mock.calls[0]!;
    expect(savedSlot).toBe(2);
    expect(savedCareer.playerName).toBe('FreshStart');
  });

  it('loads a valid slot into the controller and clears any corrupt state', async () => {
    const valid = baseCareer({ saveSlot: 3, playerName: 'Valid', money: 4242 });
    const { controller } = makeSlotController(
      [slotInfo(1, false), slotInfo(2, false), slotInfo(3, true, 'Valid', 4242)],
      (slot) => (slot === 3 ? valid : null),
    );

    const result = await controller.loadSlot(3);

    expect(result.status).toBe('loaded');
    if (result.status === 'loaded') {
      expect(result.career.playerName).toBe('Valid');
    }
    expect(controller.career.money).toBe(4242);
    expect(controller.corruptSave).toBeNull();
    expect(controller.phase).toBe('config');
  });

  it('reports an empty slot as empty', async () => {
    const { controller } = makeSlotController(
      [slotInfo(1, false), slotInfo(2, false), slotInfo(3, false)],
      () => null,
    );

    const result = await controller.loadSlot(1);
    expect(result.status).toBe('empty');
    expect(controller.corruptSave).toBeNull();
  });

  it('surfaces corruption end-to-end through a real SaveManager over corrupt bytes', async () => {
    const storage = new InMemorySlotStorage();
    const manager = new SaveManager(storage);
    await manager.save({ ...baseCareer({ playerName: 'Doomed' }), saveSlot: 1 }, 1);
    // Corrupt the stored bytes so CRC validation fails on load.
    const raw = storage.read(1)!;
    const lastIndex = raw.length - 1;
    raw[lastIndex] = (raw[lastIndex] ?? 0) ^ 0xff;
    storage.write(1, raw);
    storage.commit(1);

    const controller = new CareerController({
      career: baseCareer(),
      prizeTable: PRIZE_TABLE,
      saver: (career, slot) => manager.save(career, slot),
      slotLister: () => manager.listSlots(),
      slotLoader: (slot) => manager.load(slot),
    });

    const result = await controller.loadSlot(1);
    expect(result.status).toBe('corrupt');
    expect(controller.corruptSave?.slot).toBe(1);
  });
});
