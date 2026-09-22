/**
 * Client-side single-player career runtime (task 25 — finish the career loop).
 *
 * Wraps the pure {@link CareerController} together with a persistent
 * {@link SaveManager} so the client's career flow is real end-to-end:
 *
 *   new/continue career → configure car → race → results → shop → next race
 *
 * The controller owns the career state machine (phase + `CareerState`, prize
 * awards via the shared formula, circuit advance, auto-save scheduling); this
 * facade adds the two things the client needs on top: a concrete
 * `localStorage`-backed saver/loader (so a career survives a reload) and a set
 * of small, UI-friendly accessors/mutators the App wires its overlays to
 * (current money, owned items, the configured loadout, and a purchase that
 * spends real money and records the owned item).
 *
 * It holds no PixiJS/DOM references, so the flow stays testable headlessly.
 *
 * Requirements: 5.1–5.10, 12.1, 12.2
 */

import {
  CareerController,
  type FinishRaceResult,
  type RaceOutcome,
} from './CareerController.js';
import { LocalStorageSlotStorage } from './LocalStorageSlotStorage.js';
import {
  SaveManager,
  newCareer,
  INITIAL_CAREER_MONEY,
  type CareerState,
  type Loadout,
  type PrizeTable,
  type SaveSlot,
  type ComponentId,
  type WeaponId,
} from '@deathtrack/shared';

/**
 * The career prize schedule for single-player. **Authored design data** — the
 * original game's exact payout table is not recoverable from the shipped
 * assets. Placement prizes for a ten-car field (index 0 unused; placement is
 * 1-based) plus a fixed per-elimination bonus, matching the shape the shared
 * `computePrizeMoney` formula consumes.
 */
export const CAREER_PRIZE_TABLE: PrizeTable = {
  placementPrizes: [0, 10000, 6000, 4000, 2500, 1500, 1000, 750, 500, 250, 100],
  eliminationBonus: 750,
};

/** The default save slot a fresh single-player career occupies. */
export const DEFAULT_CAREER_SLOT: SaveSlot = 1;

/** A purchasable item as surfaced by the Shop overlay. */
export interface CareerPurchase {
  readonly id: string;
  readonly kind: 'component' | 'weapon';
  readonly price: number;
}

/** The result of attempting a shop purchase against the live career. */
export interface CareerPurchaseResult {
  /** Whether the purchase succeeded (affordable + recorded). */
  readonly ok: boolean;
  /** Shortfall in currency units when rejected (0 on success). */
  readonly shortfall: number;
  /** The career money balance after the attempt. */
  readonly money: number;
}

/**
 * Owns the single-player career: a {@link CareerController} driving the flow and
 * a {@link SaveManager} persisting it to `localStorage`. Construct one per app
 * (via {@link CareerSession.create}) and drive it from the client's overlays.
 */
export class CareerSession {
  private readonly controller: CareerController;

  private constructor(controller: CareerController) {
    this.controller = controller;
  }

  /**
   * Create a career session, continuing the save in {@link DEFAULT_CAREER_SLOT}
   * if one exists (and is not corrupt) or starting a fresh career otherwise.
   * Best-effort: any load failure falls back to a new career so the game always
   * boots into a playable state.
   */
  static async create(playerName = 'Player'): Promise<CareerSession> {
    const storage = new LocalStorageSlotStorage();
    const saveManager = new SaveManager(storage);
    const slot = DEFAULT_CAREER_SLOT;

    let career: CareerState;
    try {
      const loaded = await saveManager.load(slot);
      career = loaded ?? newCareer(slot, playerName, INITIAL_CAREER_MONEY);
    } catch {
      // Corrupt or unreadable save: start fresh (the slot is not overwritten
      // until the next explicit save/auto-save).
      career = newCareer(slot, playerName, INITIAL_CAREER_MONEY);
    }

    const controller = new CareerController({
      career,
      prizeTable: CAREER_PRIZE_TABLE,
      saver: (c, s) => saveManager.save(c, s),
      slotLister: () => saveManager.listSlots(),
      slotLoader: (s) => saveManager.load(s),
    });

    return new CareerSession(controller);
  }

  /** The current career state (money, owned items, circuit, loadout). */
  get career(): CareerState {
    return this.controller.career;
  }

  /** The player's current money balance. */
  get money(): number {
    return this.controller.career.money;
  }

  /** The player's currently-configured loadout. */
  get loadout(): Loadout {
    return this.controller.career.currentLoadout;
  }

  /** Component ids the player owns (purchased in the shop). */
  get ownedComponents(): readonly ComponentId[] {
    return this.controller.career.ownedComponents;
  }

  /** Weapon ids the player owns (purchased in the shop). */
  get ownedWeapons(): readonly WeaponId[] {
    return this.controller.career.ownedWeapons;
  }

  /** The current 1-based race number within the circuit (1–10). */
  get raceNumber(): number {
    return this.controller.career.currentCircuitIndex + 1;
  }

  /** The current circuit number (1-based, increments after all ten tracks). */
  get circuitNumber(): number {
    return this.controller.career.circuitNumber;
  }

  /**
   * Record the player's confirmed car loadout for the upcoming race (called when
   * the car-config screen is confirmed). Persisted with the next auto-save.
   */
  setLoadout(loadout: Loadout): void {
    this.controller.configureLoadout(loadout);
  }

  /**
   * Enter the `race` phase for the configured car. Returns `false` if the
   * controller was not in `config` (e.g. the flow is out of sync).
   */
  startRace(): boolean {
    return this.controller.startRace();
  }

  /**
   * Finish the current race with the player's outcome: awards prize money to the
   * persisted career (shared formula) and schedules the auto-save. Returns the
   * award + updated career, or `null` if not currently racing.
   */
  finishRace(outcome: RaceOutcome): FinishRaceResult | null {
    return this.controller.finishRace(outcome);
  }

  /** Move from the results screen into the shop. */
  enterShop(): boolean {
    return this.controller.enterShop();
  }

  /** The current career-loop phase (config/race/results/shop). */
  get phase(): 'config' | 'race' | 'results' | 'shop' {
    return this.controller.phase;
  }

  /**
   * Ensure the controller is in the `shop` phase for the career hub when the
   * player arrives from the post-race results screen (results → shop). From any
   * other phase this is a no-op: purchases are only enabled once a race has been
   * completed, matching the controller's loop (results → shop → next race). The
   * hub still renders in `config` (a fresh career) so the player can browse the
   * catalogue; the buy action is a no-op until the shop phase is active.
   */
  enterHub(): void {
    if (this.controller.phase === 'results') {
      this.controller.enterShop();
    }
  }

  /** Whether shop purchases are currently enabled (the controller is in `shop`). */
  get canShop(): boolean {
    return this.controller.phase === 'shop';
  }

  /**
   * Attempt to buy a catalogue item. On success, spends the money (shared
   * atomic purchase) AND records the item in the career's owned list so it is
   * available in car-config next time. Returns the outcome + new balance.
   */
  buyItem(item: CareerPurchase): CareerPurchaseResult {
    const result = this.controller.buyItem(item.price, { kind: item.kind, id: item.id });
    if (!result.ok) {
      return { ok: false, shortfall: result.shortfall, money: this.money };
    }
    void this.controller.saveNow();
    return { ok: true, shortfall: 0, money: this.money };
  }

  /**
   * Advance to the next race in the circuit (shop → config), stepping the
   * circuit index. Returns `false` if not currently in the shop.
   */
  nextRace(): boolean {
    return this.controller.nextRace();
  }

  /** Persist the career immediately (e.g. before navigating away). */
  saveNow(): void | Promise<void> {
    return this.controller.saveNow();
  }

  /** Cancel any pending auto-save (teardown). */
  dispose(): void {
    this.controller.cancelPendingAutoSave();
  }

}
