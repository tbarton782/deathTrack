/**
 * Browser `localStorage`-backed {@link SlotStorage} for career saves (task 25 —
 * finish the career runtime loop).
 *
 * The shared {@link SaveManager} frames a {@link CareerState} into CRC-checked
 * bytes and delegates raw slot I/O to a {@link SlotStorage}. In the browser we
 * persist those bytes in `localStorage` (base64-encoded, one key per slot) so a
 * career survives a page reload. The staged→commit protocol the manager expects
 * is honoured with a per-slot staging key promoted atomically on {@link commit}.
 *
 * Everything degrades gracefully: if `localStorage` is unavailable (private
 * mode, SSR, disabled storage) the store transparently falls back to an
 * in-memory map for the session, so the game still runs — it just does not
 * persist across reloads. No exception escapes to the caller.
 */

import type { SaveSlot, SlotStorage } from '@deathtrack/shared';

/** `localStorage` key prefix for a slot's live (committed) bytes. */
const LIVE_PREFIX = 'deathtrack.save.slot';

/** `localStorage` key prefix for a slot's staged (uncommitted) bytes. */
const STAGED_PREFIX = 'deathtrack.save.staged';

/** Encode raw bytes as a base64 string for text-only `localStorage`. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

/** Decode a base64 string back into raw bytes. */
function fromBase64(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * A {@link SlotStorage} that persists career-save bytes in the browser's
 * `localStorage`, with a transparent in-memory fallback when storage is not
 * available. Construct one and hand it to `new SaveManager(storage)`.
 */
export class LocalStorageSlotStorage implements SlotStorage {
  /** In-memory fallback used when `localStorage` is unavailable. */
  private readonly memLive = new Map<SaveSlot, Uint8Array>();
  private readonly memStaged = new Map<SaveSlot, Uint8Array>();
  private readonly usable: boolean;

  constructor() {
    this.usable = LocalStorageSlotStorage.detectLocalStorage();
  }

  /** Feature-detect a working `localStorage` (throws in some sandboxed frames). */
  private static detectLocalStorage(): boolean {
    try {
      const probe = '__deathtrack_probe__';
      globalThis.localStorage?.setItem(probe, '1');
      globalThis.localStorage?.removeItem(probe);
      return typeof globalThis.localStorage !== 'undefined';
    } catch {
      return false;
    }
  }

  private liveKey(slot: SaveSlot): string {
    return `${LIVE_PREFIX}${slot}`;
  }

  private stagedKey(slot: SaveSlot): string {
    return `${STAGED_PREFIX}${slot}`;
  }

  read(slot: SaveSlot): Uint8Array | null {
    if (!this.usable) {
      const bytes = this.memLive.get(slot);
      return bytes ? bytes.slice() : null;
    }
    try {
      const text = globalThis.localStorage.getItem(this.liveKey(slot));
      return text === null ? null : fromBase64(text);
    } catch {
      return null;
    }
  }

  write(slot: SaveSlot, bytes: Uint8Array): void {
    if (!this.usable) {
      this.memStaged.set(slot, bytes.slice());
      return;
    }
    try {
      globalThis.localStorage.setItem(this.stagedKey(slot), toBase64(bytes));
    } catch {
      // Quota or serialization failure: fall back to memory for this slot.
      this.memStaged.set(slot, bytes.slice());
    }
  }

  commit(slot: SaveSlot): void {
    if (!this.usable) {
      const staged = this.memStaged.get(slot);
      if (staged) {
        this.memLive.set(slot, staged);
        this.memStaged.delete(slot);
      }
      return;
    }
    try {
      const staged = globalThis.localStorage.getItem(this.stagedKey(slot));
      if (staged !== null) {
        globalThis.localStorage.setItem(this.liveKey(slot), staged);
        globalThis.localStorage.removeItem(this.stagedKey(slot));
      }
    } catch {
      /* best-effort: leave live bytes as-is */
    }
  }

  list(): SaveSlot[] {
    if (!this.usable) {
      return [...this.memLive.keys()].sort((a, b) => a - b);
    }
    const slots: SaveSlot[] = [];
    for (const slot of [1, 2, 3] as const) {
      try {
        if (globalThis.localStorage.getItem(this.liveKey(slot)) !== null) slots.push(slot);
      } catch {
        /* ignore */
      }
    }
    return slots;
  }

  delete(slot: SaveSlot): void {
    if (!this.usable) {
      this.memLive.delete(slot);
      this.memStaged.delete(slot);
      return;
    }
    try {
      globalThis.localStorage.removeItem(this.liveKey(slot));
      globalThis.localStorage.removeItem(this.stagedKey(slot));
    } catch {
      /* ignore */
    }
  }
}
