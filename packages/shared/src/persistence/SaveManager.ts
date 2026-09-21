/**
 * Career save-slot manager.
 *
 * {@link SaveManager} is the storage-abstracted façade over the on-disk
 * {@link SaveFile} format. It owns the *policy* of career persistence — which
 * slots exist, how a slot's bytes map to a {@link CareerState}, how a corrupt
 * slot is distinguished from a missing one, and how a write is made atomic —
 * while delegating the raw byte I/O to a pluggable {@link SlotStorage}
 * provider.
 *
 * ## Why a storage provider?
 *
 * The two runtimes that persist careers have completely different byte stores:
 * the server writes files under a directory with the Node `fs` module, while
 * the browser client uses IndexedDB or `localStorage`. Rather than branch on
 * environment, {@link SaveManager} depends only on the small {@link SlotStorage}
 * interface (read / write / list / delete a slot's raw bytes). Each host supplies
 * a concrete implementation; the encode/decode and integrity logic lives here,
 * shared by both. An {@link InMemorySlotStorage} is provided for tests and for
 * ephemeral/preview environments.
 *
 * ## Encoding & integrity
 *
 * All bytes flow through {@link SaveFileCodec}, which frames the payload with a
 * magic number, a version, and a trailing CRC-32. On load, a byte store that
 * has no entry for a slot yields `null` (a *missing* slot), whereas a store that
 * returns bytes which fail codec validation surfaces a {@link CorruptSaveError}
 * — the two conditions are deliberately kept distinct so the UI can offer
 * "start a new career" for a corrupt slot without silently masking a bug.
 *
 * ## Atomic writes
 *
 * {@link SaveManager.save} asks the provider to write to a temporary key first
 * and then atomically promote it into place via {@link SlotStorage.commit}. A
 * provider backed by `fs` implements `commit` as a `rename`; the in-memory
 * provider implements it as a map swap. Either way a crash mid-write cannot
 * leave a slot half-written.
 *
 * Requirements: 12.1, 12.2, 12.3, 12.4, 12.5, 12.6, 5.5
 */

import { CorruptSaveError, SaveFileCodec, SAVE_FILE_MAGIC, SAVE_FILE_VERSION } from '../codec/SaveFileCodec.js';
import type { CareerState, SaveFile, SlotInfo } from '../types/career.js';

/** The three supported career save-slot indices. */
export type SaveSlot = 1 | 2 | 3;

/** All valid save slots, in ascending order. */
export const SAVE_SLOTS: readonly SaveSlot[] = [1, 2, 3] as const;

/**
 * Storage-provider interface abstracting the raw byte store behind
 * {@link SaveManager}.
 *
 * Implementations own *only* the mechanics of reading, writing, and removing a
 * slot's bytes; they perform no encoding, validation, or CRC handling — that is
 * {@link SaveManager}'s job. A provider may be synchronous or asynchronous;
 * every method returns a value or a promise, and {@link SaveManager} awaits all
 * of them so both an `fs`-backed (sync or promise) and an IndexedDB-backed
 * (promise) implementation work unchanged.
 *
 * ### Atomic-write contract
 *
 * A caller writes with {@link write} to a *staging* location keyed by `slot`,
 * then calls {@link commit} to promote the staged bytes into the live slot in a
 * single, non-partial step. Providers back this with whatever primitive gives
 * atomicity on their medium (a filesystem `rename`, a transaction, a reference
 * swap). If {@link commit} is never reached (e.g. a crash after {@link write}),
 * the live slot retains its previous contents.
 *
 * Requirements: 12.4, 12.5, 12.6
 */
export interface SlotStorage {
  /**
   * Return the raw bytes stored for the live `slot`, or `null` if the slot has
   * never been written (a *missing* slot). Must not throw for a missing slot.
   */
  read(slot: SaveSlot): Uint8Array | null | Promise<Uint8Array | null>;

  /**
   * Stage `bytes` for `slot` without yet exposing them as the live value.
   * A subsequent {@link commit} promotes the staged bytes atomically.
   */
  write(slot: SaveSlot, bytes: Uint8Array): void | Promise<void>;

  /**
   * Atomically promote the most recently {@link write}-staged bytes for `slot`
   * into the live slot. After this resolves, {@link read} returns those bytes.
   */
  commit(slot: SaveSlot): void | Promise<void>;

  /** List the slots that currently hold live bytes, in any order. */
  list(): SaveSlot[] | Promise<SaveSlot[]>;

  /** Remove any live (and staged) bytes for `slot`. A no-op if the slot is missing. */
  delete(slot: SaveSlot): void | Promise<void>;
}

/**
 * In-memory {@link SlotStorage} used by tests and ephemeral environments.
 *
 * Live slots and staged (uncommitted) writes are held in separate maps; a
 * {@link commit} moves a staged entry into the live map, modelling the atomic
 * promote of a real backing store. Byte buffers are copied on the way in and
 * out so callers cannot mutate stored state through a retained reference.
 */
export class InMemorySlotStorage implements SlotStorage {
  private readonly live = new Map<SaveSlot, Uint8Array>();
  private readonly staged = new Map<SaveSlot, Uint8Array>();

  read(slot: SaveSlot): Uint8Array | null {
    const bytes = this.live.get(slot);
    return bytes === undefined ? null : bytes.slice();
  }

  write(slot: SaveSlot, bytes: Uint8Array): void {
    this.staged.set(slot, bytes.slice());
  }

  commit(slot: SaveSlot): void {
    const bytes = this.staged.get(slot);
    if (bytes === undefined) {
      throw new Error(`InMemorySlotStorage.commit called for slot ${slot} with nothing staged`);
    }
    this.live.set(slot, bytes);
    this.staged.delete(slot);
  }

  list(): SaveSlot[] {
    return [...this.live.keys()].sort((a, b) => a - b);
  }

  delete(slot: SaveSlot): void {
    this.live.delete(slot);
    this.staged.delete(slot);
  }
}

/**
 * Manages career save slots on top of a {@link SlotStorage} provider.
 *
 * The manager is stateless beyond its provider reference: every operation reads
 * or writes through the provider, so two managers sharing one provider observe
 * the same slots.
 *
 * Requirements: 12.1–12.6, 5.5
 */
export class SaveManager {
  constructor(private readonly storage: SlotStorage) {}

  /**
   * Encode `career` and persist it to `slot`, overwriting any existing save.
   *
   * The bytes are framed by {@link SaveFileCodec} (magic + version + CRC-32),
   * staged via {@link SlotStorage.write}, then promoted atomically via
   * {@link SlotStorage.commit}. The `career.saveSlot` field is normalised to
   * match `slot` so the persisted state is internally consistent regardless of
   * the caller's in-memory value.
   *
   * Overwrite protection is the caller's responsibility: guard occupied slots
   * with {@link SaveManager.confirmOverwrite} before calling `save`.
   *
   * Requirements: 12.1, 12.2, 12.4, 12.6, 5.5
   */
  async save(career: CareerState, slot: SaveSlot): Promise<void> {
    const file: SaveFile = {
      magic: SAVE_FILE_MAGIC,
      version: SAVE_FILE_VERSION,
      slot,
      career: { ...career, saveSlot: slot },
      // Ignored by the codec, which recomputes the trailer on encode.
      crc32: 0,
    };
    const bytes = SaveFileCodec.encode(file);
    await this.storage.write(slot, bytes);
    await this.storage.commit(slot);
  }

  /**
   * Load and decode the career stored at `slot`.
   *
   * Returns `null` when the slot is *missing* (the provider has no bytes for
   * it). Re-throws a {@link CorruptSaveError} when bytes exist but fail codec
   * validation (bad magic, unsupported version, truncation, or CRC mismatch) so
   * the caller can distinguish "no save here" from "save is damaged".
   *
   * Requirements: 12.3, 12.4, 5.5
   */
  async load(slot: SaveSlot): Promise<CareerState | null> {
    const bytes = await this.storage.read(slot);
    if (bytes === null) {
      return null;
    }
    // Let CorruptSaveError propagate; it is the caller's signal to offer a fresh
    // start without overwriting the damaged slot.
    const file = SaveFileCodec.decode(bytes);
    return file.career;
  }

  /**
   * Summarise all three save slots for the career menu.
   *
   * Every slot (1–3) appears in the result, ordered ascending. A slot with no
   * bytes, or whose bytes fail integrity validation, is reported as
   * `exists: false` with an empty `playerName` and `0` `totalEarnings`; a corrupt
   * slot is thus surfaced as unoccupied at the list level, while a direct
   * {@link load} of that slot still throws so the dedicated corrupt-save flow can
   * run. Slots that decode cleanly carry their `playerName` and `totalEarnings`.
   *
   * Requirements: 12.3, 12.5
   */
  async listSlots(): Promise<SlotInfo[]> {
    const present = new Set(await this.storage.list());
    const infos: SlotInfo[] = [];
    for (const slot of SAVE_SLOTS) {
      if (!present.has(slot)) {
        infos.push({ slot, playerName: '', totalEarnings: 0, exists: false });
        continue;
      }
      const bytes = await this.storage.read(slot);
      if (bytes === null) {
        infos.push({ slot, playerName: '', totalEarnings: 0, exists: false });
        continue;
      }
      try {
        const file = SaveFileCodec.decode(bytes);
        infos.push({
          slot,
          playerName: file.career.playerName,
          totalEarnings: file.career.totalEarnings,
          exists: true,
        });
      } catch (err) {
        if (err instanceof CorruptSaveError) {
          infos.push({ slot, playerName: '', totalEarnings: 0, exists: false });
          continue;
        }
        throw err;
      }
    }
    return infos;
  }

  /**
   * Report whether `slot` is currently occupied by a valid or corrupt save.
   *
   * Intended as the guard a caller invokes before {@link save} to decide whether
   * to prompt the player for overwrite confirmation (requirement 12.6). Returns
   * `true` if any bytes exist for the slot — including corrupt bytes, which the
   * player should still be warned about before replacing.
   *
   * Requirements: 12.6
   */
  async confirmOverwrite(slot: SaveSlot): Promise<boolean> {
    const bytes = await this.storage.read(slot);
    return bytes !== null;
  }

  /**
   * Permanently remove the save at `slot`. A no-op if the slot is already empty.
   *
   * Requirements: 12.5
   */
  async deleteSlot(slot: SaveSlot): Promise<void> {
    await this.storage.delete(slot);
  }
}
