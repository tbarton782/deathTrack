// packages/client/src/career/CareerController.ts
//
// Single-player career flow controller (task 21.1).
//
// The `CareerController` is the pure, GPU-free orchestrator of the single-player
// career loop:
//
//   new career -> car config -> race -> results -> shop -> next race
//
// It is a headless state machine: it holds the current phase and the current
// `CareerState`, and drives transitions in response to lifecycle events (the
// player configures a car, a race finishes with an outcome, the player buys an
// item in the shop, the player advances to the next race). All persistent-rule
// side effects are delegated to the shared services:
//
//   - `computePrizeMoney` (CareerService) — awards prize money on race finish;
//   - `purchaseItem`      (CareerService) — atomic shop purchases;
//   - `advanceCircuit`    (CareerService) — step to the next race in the circuit.
//
// Following requirement 12.1, the controller auto-saves the career within five
// seconds of every race completion. To keep that timing testable without a real
// `setTimeout` on the tested path, the controller depends on two injected
// collaborators:
//
//   - a `SaveScheduler` — schedules a callback to run after a delay (production
//     wires this to `setTimeout`; tests wire a fake timer they can advance);
//   - a `CareerSaver` — persists a `CareerState` (production injects a closure
//     over the shared `SaveManager`; tests inject a spy so no disk/IndexedDB is
//     touched).
//
// The controller contains no PixiJS/DOM references; the App/UI render the
// screens for each phase while the controller owns the flow.
//
// Requirements: 5.1–5.10, 12.1, 12.2

import {
  advanceCircuit,
  computePrizeMoney,
  purchaseItem,
  newCareer,
  CorruptSaveError,
  type CareerState,
  type CareerResult,
  type PrizeTable,
  type SaveSlot,
  type SlotInfo,
} from '@deathtrack/shared';

// ---------------------------------------------------------------------------
// Auto-save timing budget (Requirement 12.1)
// ---------------------------------------------------------------------------

/**
 * The maximum delay, in milliseconds, permitted between a race completing and
 * the career being auto-saved (Requirement 12.1: "within 5 seconds of every
 * Race completion"). The controller schedules the auto-save at this delay; a
 * caller may schedule sooner but never later.
 */
export const AUTO_SAVE_BUDGET_MS = 5_000;

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

/**
 * The phases of the single-player career loop, in forward-flow order. `config`
 * is the pre-race car/loadout configuration; `race` is the active race; after a
 * race the flow shows `results`, then the `shop`, then loops back to `config`
 * for the next race.
 */
export const CAREER_PHASES = [
  'config',
  'race',
  'results',
  'shop',
] as const;

/** A single career-loop phase. */
export type CareerPhase = (typeof CAREER_PHASES)[number];

// ---------------------------------------------------------------------------
// Injected collaborators
// ---------------------------------------------------------------------------

/**
 * A cancellable handle for a scheduled callback, mirroring the shape returned by
 * a scheduler so a caller can cancel a pending auto-save (e.g. on teardown).
 */
export type CancelHandle = () => void;

/**
 * Schedules `callback` to run after `delayMs` milliseconds, returning a handle
 * that cancels the pending run when invoked.
 *
 * Production wires this to `setTimeout`/`clearTimeout`; tests inject a
 * controllable fake timer so the 5-second budget can be asserted deterministically
 * without wall-clock waits. Keeping the scheduler injected (rather than calling
 * `setTimeout` directly on the tested path) is what makes the auto-save timing
 * testable.
 */
export type SaveScheduler = (callback: () => void, delayMs: number) => CancelHandle;

/**
 * Persists a career state. Returns a promise so an async backing store (the
 * shared `SaveManager` over disk or IndexedDB) is supported; a synchronous
 * saver may return `void`.
 *
 * Injecting the saver (rather than referencing a concrete `SaveManager`) keeps
 * the controller decoupled from any real storage medium: tests inject a spy,
 * production injects a closure such as `(career, slot) => saveManager.save(career, slot)`.
 */
export type CareerSaver = (career: CareerState, slot: SaveSlot) => void | Promise<void>;

/**
 * A real-timer {@link SaveScheduler} backed by `setTimeout`/`clearTimeout`,
 * provided for production wiring. The tested path always injects a fake instead.
 */
export const setTimeoutScheduler: SaveScheduler = (callback, delayMs) => {
  const id = setTimeout(callback, delayMs);
  return () => clearTimeout(id);
};

// ---------------------------------------------------------------------------
// Save-slot management collaborators (task 21.2)
// ---------------------------------------------------------------------------

/**
 * Lists the metadata for every save slot, for the career menu.
 *
 * Production injects a closure over the shared `SaveManager.listSlots()`; tests
 * inject a spy over an in-memory store so no disk/IndexedDB is touched. Each
 * returned {@link SlotInfo} reports whether the slot is occupied and, when it
 * is, the stored player name and cumulative earnings summary.
 *
 * Requirements: 12.3, 12.5
 */
export type SlotLister = () => SlotInfo[] | Promise<SlotInfo[]>;

/**
 * Loads and decodes the career stored at `slot`.
 *
 * Returns `null` for an empty slot, the decoded {@link CareerState} for a valid
 * slot, and *throws* {@link CorruptSaveError} when the slot's bytes fail
 * integrity validation. Production injects a closure over the shared
 * `SaveManager.load(slot)`; tests inject a spy. Injecting the loader (rather
 * than referencing a concrete `SaveManager`) keeps slot loading headlessly
 * testable.
 *
 * Requirements: 12.3
 */
export type SlotLoader = (slot: SaveSlot) => CareerState | null | Promise<CareerState | null>;

// ---------------------------------------------------------------------------
// Corrupt-save surface (Requirement 12.3)
// ---------------------------------------------------------------------------

/**
 * The condition surfaced by {@link CareerController.loadSlot} when the requested
 * slot's bytes fail integrity validation. It carries the affected slot so the
 * UI can identify it in the "corrupt save" screen, and never causes the slot to
 * be overwritten — the fresh start it offers is persisted only on an explicit
 * action (Requirement 12.3).
 */
export interface CorruptSaveCondition {
  /** The slot whose save is corrupt (shown on the corrupt-save screen). */
  readonly slot: SaveSlot;
  /** Human-readable detail from the underlying integrity failure. */
  readonly message: string;
}

/** The outcome of a {@link CareerController.loadSlot} attempt. */
export type LoadSlotResult =
  | { readonly status: 'loaded'; readonly career: CareerState }
  | { readonly status: 'empty' }
  | { readonly status: 'corrupt'; readonly corrupt: CorruptSaveCondition };

// ---------------------------------------------------------------------------
// Race outcome
// ---------------------------------------------------------------------------

/**
 * The player's outcome for a completed race, as fed into
 * {@link CareerController.finishRace}. Placement is 1-based (1 = winner);
 * `eliminationCount` is the number of opponents the player eliminated in the
 * race. These feed the shared {@link computePrizeMoney} formula.
 */
export interface RaceOutcome {
  /** 1-based finishing placement (1 = winner). */
  readonly placement: number;
  /** Number of opponents the player eliminated during the race. */
  readonly eliminationCount: number;
}

/**
 * The result of finishing a race: the prize money awarded (via the shared
 * formula) and the career state after that prize and the player's cumulative
 * counters have been applied.
 */
export interface FinishRaceResult {
  /** Prize money awarded for the race, from {@link computePrizeMoney}. */
  readonly prizeMoney: number;
  /** The career state after the prize and counters were applied. */
  readonly career: CareerState;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Construction options for a {@link CareerController}. The prize table, save
 * scheduler, and saver are all injected so the controller stays pure and its
 * auto-save timing stays testable.
 */
export interface CareerControllerOptions {
  /** The initial career state the controller starts driving. */
  readonly career: CareerState;
  /** Prize schedule used to compute post-race winnings. */
  readonly prizeTable: PrizeTable;
  /** Persists a career state (injected; no direct storage dependency). */
  readonly saver: CareerSaver;
  /**
   * Lists save-slot metadata for the menu (injected over the shared
   * `SaveManager.listSlots`). Optional so a controller constructed purely for
   * the in-race flow need not wire it; slot operations throw if it is missing.
   */
  readonly slotLister?: SlotLister;
  /**
   * Loads a career from a slot (injected over the shared `SaveManager.load`),
   * surfacing corrupt saves. Optional for the same reason as {@link slotLister}.
   */
  readonly slotLoader?: SlotLoader;
  /**
   * Schedules the auto-save callback. Defaults to {@link setTimeoutScheduler}
   * for production; tests inject a controllable fake.
   */
  readonly scheduler?: SaveScheduler;
  /**
   * Auto-save delay in milliseconds. Defaults to {@link AUTO_SAVE_BUDGET_MS};
   * must not exceed it (values above the budget are clamped to the budget so the
   * 5-second requirement always holds).
   */
  readonly autoSaveDelayMs?: number;
  /** Optional listener notified after every phase change with `(next, previous)`. */
  readonly onPhaseChange?: (next: CareerPhase, previous: CareerPhase) => void;
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

/**
 * Drives the single-player career loop as a headless state machine.
 *
 * Lifecycle (forward flow):
 *
 * 1. Construct with an initial career (from {@link newCareer} or a loaded save)
 *    — the controller starts in the `config` phase.
 * 2. {@link startRace} — `config` -> `race`.
 * 3. {@link finishRace} — `race` -> `results`; awards prize money via
 *    {@link computePrizeMoney}, applies it to the career balance, and schedules
 *    the auto-save within {@link AUTO_SAVE_BUDGET_MS} (Requirement 12.1).
 * 4. {@link enterShop} — `results` -> `shop`.
 * 5. {@link buyItem} — atomic purchase via {@link purchaseItem} while in `shop`.
 * 6. {@link nextRace} — `shop` -> `config`; advances the circuit via
 *    {@link advanceCircuit}.
 *
 * Every mutating operation returns fresh career state; the controller holds the
 * latest as its own `career`.
 */
export class CareerController {
  private currentPhase: CareerPhase = 'config';
  private currentCareer: CareerState;
  private readonly prizeTable: PrizeTable;
  private readonly saver: CareerSaver;
  private readonly slotLister: SlotLister | undefined;
  private readonly slotLoader: SlotLoader | undefined;
  private readonly scheduler: SaveScheduler;
  private readonly autoSaveDelayMs: number;
  private readonly onPhaseChange:
    | ((next: CareerPhase, previous: CareerPhase) => void)
    | undefined;

  /** Handle for a currently-pending auto-save, or `null` when none is scheduled. */
  private pendingAutoSave: CancelHandle | null = null;

  /**
   * A save that is staged and awaiting overwrite confirmation because its target
   * slot is already occupied (Requirement 12.6), or `null` when none is pending.
   */
  private pendingOverwriteState:
    | { readonly career: CareerState; readonly slot: SaveSlot }
    | null = null;

  /**
   * The corrupt-save condition currently being surfaced to the UI, or `null`
   * when no corrupt save is being handled (Requirement 12.3).
   */
  private corruptSaveState: CorruptSaveCondition | null = null;

  constructor(options: CareerControllerOptions) {
    this.currentCareer = options.career;
    this.prizeTable = options.prizeTable;
    this.saver = options.saver;
    this.slotLister = options.slotLister;
    this.slotLoader = options.slotLoader;
    this.scheduler = options.scheduler ?? setTimeoutScheduler;
    // Never allow the auto-save to be scheduled later than the 5 s budget.
    const requested = options.autoSaveDelayMs ?? AUTO_SAVE_BUDGET_MS;
    this.autoSaveDelayMs = Math.min(requested, AUTO_SAVE_BUDGET_MS);
    this.onPhaseChange = options.onPhaseChange;
  }

  /**
   * Convenience factory: create a fresh career via the shared {@link newCareer}
   * and wrap it in a controller. The controller begins in the `config` phase,
   * ready for the player to configure their car for the first race.
   */
  static newCareer(
    slot: SaveSlot,
    playerName: string,
    initialMoney: number,
    options: Omit<CareerControllerOptions, 'career'>,
  ): CareerController {
    return new CareerController({
      ...options,
      career: newCareer(slot, playerName, initialMoney),
    });
  }

  /** The current career-loop phase. */
  get phase(): CareerPhase {
    return this.currentPhase;
  }

  /** The current (latest) career state. */
  get career(): CareerState {
    return this.currentCareer;
  }

  /** `true` while an auto-save is scheduled but has not yet fired. */
  get hasPendingAutoSave(): boolean {
    return this.pendingAutoSave !== null;
  }

  /** The delay, in ms, at which the auto-save is scheduled after a race. */
  get effectiveAutoSaveDelayMs(): number {
    return this.autoSaveDelayMs;
  }

  /**
   * `true` while a save is staged awaiting overwrite confirmation for an
   * occupied slot (Requirement 12.6). The UI shows a confirm/cancel prompt while
   * this holds; the occupied slot is not written until {@link confirmOverwrite}.
   */
  get hasPendingOverwrite(): boolean {
    return this.pendingOverwriteState !== null;
  }

  /**
   * The slot targeted by a save that is awaiting overwrite confirmation, or
   * `null` when none is pending. Lets the UI name the slot in its prompt.
   */
  get pendingOverwriteSlot(): SaveSlot | null {
    return this.pendingOverwriteState?.slot ?? null;
  }

  /**
   * The corrupt-save condition currently surfaced to the UI, or `null` when no
   * corrupt save is being handled. When non-null the UI shows the "corrupt save"
   * screen for {@link CorruptSaveCondition.slot}, offering a fresh start that
   * does not overwrite the slot (Requirement 12.3).
   */
  get corruptSave(): CorruptSaveCondition | null {
    return this.corruptSaveState;
  }

  // -------------------------------------------------------------------------
  // Save-slot management (task 21.2 — Requirements 12.3, 12.5, 12.6)
  // -------------------------------------------------------------------------

  /**
   * List every save slot's metadata for the career menu (Requirements 12.3,
   * 12.5): whether each slot is occupied and, for occupied slots, the stored
   * player name and cumulative earnings summary. Delegates to the injected
   * {@link SlotLister} (a closure over the shared `SaveManager`). A corrupt slot
   * is reported as unoccupied at this level; {@link loadSlot} is where the
   * corrupt condition surfaces.
   *
   * @throws if no slot lister was injected.
   */
  async listSlots(): Promise<SlotInfo[]> {
    if (this.slotLister === undefined) {
      throw new Error('CareerController has no slot lister injected.');
    }
    return this.slotLister();
  }

  /**
   * Load the career stored at `slot` (Requirement 12.3).
   *
   * Returns a discriminated {@link LoadSlotResult}:
   * - `loaded` with the decoded career (which becomes the controller's current
   *   career, and the phase resets to `config` ready to continue that career);
   * - `empty` when the slot holds no save;
   * - `corrupt` when the slot's bytes fail integrity validation. In the corrupt
   *   case the controller records a {@link CorruptSaveCondition} (surfaced via
   *   {@link corruptSave}) and does **not** overwrite the slot; the UI then
   *   offers a fresh start via {@link startFreshFromCorrupt}. Any prior
   *   corrupt-save state is cleared on a successful or empty load.
   *
   * @throws if no slot loader was injected, or on a non-corrupt load error.
   */
  async loadSlot(slot: SaveSlot): Promise<LoadSlotResult> {
    if (this.slotLoader === undefined) {
      throw new Error('CareerController has no slot loader injected.');
    }
    try {
      const career = await this.slotLoader(slot);
      if (career === null) {
        this.corruptSaveState = null;
        return { status: 'empty' };
      }
      this.corruptSaveState = null;
      this.currentCareer = career;
      this.setPhase('config');
      return { status: 'loaded', career };
    } catch (err) {
      if (err instanceof CorruptSaveError) {
        // Surface the corrupt condition WITHOUT touching the slot's bytes.
        this.corruptSaveState = { slot, message: err.message };
        return { status: 'corrupt', corrupt: this.corruptSaveState };
      }
      throw err;
    }
  }

  /**
   * Begin a fresh career after a corrupt-save screen, WITHOUT overwriting the
   * corrupt slot (Requirement 12.3).
   *
   * Creates a brand-new career (via the shared {@link newCareer}) for the given
   * `slot`, makes it the controller's current career, clears the corrupt-save
   * state, and resets to the `config` phase — but performs no save. Nothing is
   * written to the corrupt slot until the player explicitly persists (e.g. the
   * post-race auto-save, {@link saveNow}, or a confirmed {@link requestSave}),
   * so the corrupt bytes remain untouched until an explicit action replaces
   * them.
   */
  startFreshFromCorrupt(slot: SaveSlot, playerName: string, initialMoney: number): CareerState {
    this.cancelPendingAutoSave();
    this.pendingOverwriteState = null;
    this.corruptSaveState = null;
    this.currentCareer = newCareer(slot, playerName, initialMoney);
    this.setPhase('config');
    return this.currentCareer;
  }

  /**
   * Dismiss the corrupt-save screen without starting a fresh career, leaving the
   * corrupt slot untouched. Safe to call when no corrupt save is being handled.
   */
  dismissCorruptSave(): void {
    this.corruptSaveState = null;
  }

  /**
   * Request that the current career be saved to `slot`, honouring overwrite
   * protection (Requirement 12.6).
   *
   * If the slot is unoccupied, the save proceeds immediately (returning
   * `'saved'`). If the slot is already occupied by a different career, the save
   * is *staged* (returning `'confirm_overwrite'`) and NOT written; the UI then
   * shows a confirmation prompt and calls {@link confirmOverwrite} to proceed or
   * {@link cancelOverwrite} to abandon it. Occupancy is decided by the injected
   * {@link SlotLister}: a slot is occupied when its {@link SlotInfo.exists} is
   * `true`.
   *
   * A pending auto-save is cancelled first, since this explicit save subsumes it.
   *
   * @throws if no slot lister was injected.
   */
  async requestSave(slot: SaveSlot): Promise<'saved' | 'confirm_overwrite'> {
    if (this.slotLister === undefined) {
      throw new Error('CareerController has no slot lister injected.');
    }
    this.cancelPendingAutoSave();
    const slots = await this.slotLister();
    const occupied = slots.some((info) => info.slot === slot && info.exists);
    if (occupied) {
      this.pendingOverwriteState = { career: this.currentCareer, slot };
      return 'confirm_overwrite';
    }
    await this.saver(this.currentCareer, slot);
    return 'saved';
  }

  /**
   * Confirm and perform a save that was staged awaiting overwrite confirmation
   * (Requirement 12.6). Writes the staged career to the previously-occupied slot
   * via the injected saver and clears the pending-overwrite state. Returns
   * `false` (a no-op) when no overwrite is pending; otherwise returns the saver's
   * promise resolving to `true`.
   */
  confirmOverwrite(): boolean | Promise<boolean> {
    const pending = this.pendingOverwriteState;
    if (pending === null) {
      return false;
    }
    this.pendingOverwriteState = null;
    const result = this.saver(pending.career, pending.slot);
    if (result instanceof Promise) {
      return result.then(() => true);
    }
    return true;
  }

  /**
   * Cancel a staged overwrite, leaving the occupied slot untouched
   * (Requirement 12.6). Safe to call when no overwrite is pending.
   */
  cancelOverwrite(): void {
    this.pendingOverwriteState = null;
  }

  /**
   * Begin the race for the currently-configured car. Valid only from the
   * `config` phase; a no-op (returning `false`) from any other phase.
   */
  startRace(): boolean {
    return this.transition('config', 'race');
  }

  /**
   * Finish the current race with the player's `outcome`.
   *
   * Awards prize money computed via the shared {@link computePrizeMoney}
   * (`placementPrize(placement) + eliminationCount × eliminationBonus`), adds it
   * to both the career balance and cumulative `totalEarnings`, accumulates the
   * player's `eliminationCount`, and moves to the `results` phase. Finally it
   * schedules the auto-save to run within {@link AUTO_SAVE_BUDGET_MS}
   * (Requirement 12.1).
   *
   * Valid only from the `race` phase; returns `null` from any other phase
   * without mutating state.
   */
  finishRace(outcome: RaceOutcome): FinishRaceResult | null {
    if (this.currentPhase !== 'race') {
      return null;
    }

    const prizeMoney = computePrizeMoney(
      outcome.placement,
      outcome.eliminationCount,
      this.prizeTable,
    );

    this.currentCareer = {
      ...this.currentCareer,
      money: this.currentCareer.money + prizeMoney,
      totalEarnings: this.currentCareer.totalEarnings + prizeMoney,
      eliminationCount:
        this.currentCareer.eliminationCount + outcome.eliminationCount,
    };

    this.setPhase('results');
    this.scheduleAutoSave();

    return { prizeMoney, career: this.currentCareer };
  }

  /**
   * Move from the post-race `results` screen into the `shop`. Valid only from
   * the `results` phase; a no-op (returning `false`) otherwise.
   */
  enterShop(): boolean {
    return this.transition('results', 'shop');
  }

  /**
   * Attempt to buy a catalogue item priced at `itemPrice` while in the `shop`.
   *
   * Delegates to the shared {@link purchaseItem}: an affordable item deducts
   * exactly its price and updates the controller's career; an unaffordable one
   * is rejected with the exact shortfall and leaves the career unchanged
   * (Requirements 5.3, 5.4). Returns the shared {@link CareerResult}.
   *
   * Rejected (returns an `insufficient_funds` result) when not in the `shop`
   * phase, so purchases cannot happen outside the shop.
   */
  buyItem(itemPrice: number): CareerResult<CareerState> {
    if (this.currentPhase !== 'shop') {
      return {
        ok: false,
        error: 'insufficient_funds',
        message: 'Purchases are only available in the shop.',
        shortfall: 0,
      };
    }

    const result = purchaseItem(this.currentCareer, itemPrice);
    if (result.ok) {
      this.currentCareer = result.value;
    }
    return result;
  }

  /**
   * Advance to the next race: step the circuit forward via the shared
   * {@link advanceCircuit} (incrementing the track index, wrapping to a new
   * circuit after track 10) and return to the `config` phase for the next race's
   * loadout. Valid only from the `shop` phase; a no-op (returning `false`)
   * otherwise.
   */
  nextRace(): boolean {
    if (this.currentPhase !== 'shop') {
      return false;
    }
    this.currentCareer = advanceCircuit(this.currentCareer);
    this.setPhase('config');
    return true;
  }

  /**
   * Manually persist the current career (Requirement 12.2). Cancels any pending
   * auto-save (the manual save subsumes it) and invokes the injected saver
   * immediately. Returns the saver's promise so callers can await completion.
   */
  saveNow(): void | Promise<void> {
    this.cancelPendingAutoSave();
    return this.saver(this.currentCareer, this.currentCareer.saveSlot);
  }

  /**
   * Cancel a pending auto-save, if any (e.g. on teardown). Safe to call when no
   * save is pending.
   */
  cancelPendingAutoSave(): void {
    if (this.pendingAutoSave !== null) {
      this.pendingAutoSave();
      this.pendingAutoSave = null;
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Schedule the auto-save to run after {@link autoSaveDelayMs}. Any previously
   * pending auto-save is cancelled first so at most one is ever outstanding. The
   * scheduled callback captures the career state as it is at fire time (via
   * `this.currentCareer`) so late shop purchases before the timer fires are also
   * persisted.
   */
  private scheduleAutoSave(): void {
    this.cancelPendingAutoSave();
    this.pendingAutoSave = this.scheduler(() => {
      this.pendingAutoSave = null;
      void this.saver(this.currentCareer, this.currentCareer.saveSlot);
    }, this.autoSaveDelayMs);
  }

  /**
   * Apply a phase transition guarded on the expected `from` phase. Returns
   * `true` when the transition was applied, `false` when the current phase did
   * not match `from` (a rejected no-op).
   */
  private transition(from: CareerPhase, to: CareerPhase): boolean {
    if (this.currentPhase !== from) {
      return false;
    }
    this.setPhase(to);
    return true;
  }

  /** Set the phase and notify the listener when it actually changes. */
  private setPhase(next: CareerPhase): void {
    const previous = this.currentPhase;
    if (next === previous) {
      return;
    }
    this.currentPhase = next;
    this.onPhaseChange?.(next, previous);
  }
}
