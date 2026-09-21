/**
 * `MusParser` — reads original Deathtrack OPL2/AdLib `.MUS` music sequences and
 * converts them into base64-encoded OGG stub envelopes suitable for the web
 * audio pipeline.
 *
 * The `.MUS` files ship as raw OPL2/AdLib register streams (the canonical
 * "bytes sent to the OPL2 chip" representation, IMF-style): an optional
 * length-prefixed data block followed by a sequence of
 * `{ register, value, delay }` tuples. Each tuple writes `value` to OPL
 * register `register`, then waits `delay` ticks (at the file's declared tick
 * rate) before processing the next tuple.
 *
 * Actual synthesis of the OPL stream into OGG Vorbis audio is deferred to a
 * dedicated build step (which will run an OPL2 emulator + Vorbis encoder). This
 * parser therefore produces a well-defined, self-describing OGG *stub*: a
 * base64-encoded JSON envelope carrying the parsed sequence metadata plus the
 * raw register events, so the build step has everything it needs without
 * re-reading the original DOS file.
 *
 * Parse errors are reported with byte-offset context to aid debugging of
 * malformed or truncated source files.
 *
 * Requirements: 10.1
 */

import type { MusicContext } from '@deathtrack/shared';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single OPL2 register write with an associated post-write delay, mirroring
 * the raw AdLib register-stream representation.
 */
export interface OplEvent {
  /** OPL2 register address (0x00–0xFF). */
  register: number;
  /** Byte value written to the register (0x00–0xFF). */
  value: number;
  /** Number of ticks to wait after this write, at the sequence tick rate. */
  delay: number;
}

/**
 * The parsed representation of a `.MUS` OPL2/AdLib sequence.
 */
export interface MusSequence {
  /** Playback rate of the delay field, in ticks per second (Hz). */
  tickRate: number;
  /** The ordered list of OPL2 register writes with inter-write delays. */
  events: OplEvent[];
  /** Total sequence duration in ticks (sum of all event delays). */
  totalTicks: number;
  /** Total sequence duration in seconds, derived from `totalTicks / tickRate`. */
  durationSeconds: number;
}

/**
 * Options controlling how a raw `.MUS` byte buffer is interpreted.
 */
export interface MusParseOptions {
  /**
   * Tick rate (Hz) of the sequence's delay field. AdLib register streams do
   * not universally embed this, so it is supplied by the caller. Defaults to
   * the classic AdLib/IMF 560 Hz timer rate.
   */
  tickRate?: number;
  /**
   * Whether the stream begins with a little-endian `uint16` byte-length prefix
   * for the register-data block (as some AdLib stream variants do). When
   * `false`, the entire buffer is treated as register data. Defaults to `false`.
   */
  hasLengthPrefix?: boolean;
}

/**
 * The base64-encoded OGG stub produced for the web audio pipeline, together
 * with the metadata needed by the deferred build-step encoder.
 */
export interface OggStub {
  /** Format discriminator; always `'ogg-stub'` for stub envelopes. */
  format: 'ogg-stub';
  /** Stub envelope schema version. */
  version: 1;
  /** The intended playback context for this track, when known. */
  context?: MusicContext;
  /** Playback tick rate (Hz) carried through for the encoder. */
  tickRate: number;
  /** Number of OPL2 register events in the sequence. */
  eventCount: number;
  /** Total sequence duration in seconds. */
  durationSeconds: number;
  /**
   * Base64-encoded JSON payload containing the full {@link MusSequence}. The
   * build step decodes this, runs OPL2 synthesis, and replaces the stub with a
   * real OGG asset.
   */
  data: string;
}

/**
 * Error thrown when a `.MUS` buffer cannot be parsed. Carries the byte offset
 * at which the failure was detected for diagnostic logging.
 */
export class MusParseError extends Error {
  /** Byte offset within the source buffer where parsing failed. */
  readonly offset: number;

  constructor(message: string, offset: number) {
    super(`MusParseError at byte 0x${offset.toString(16).padStart(4, '0')} (${offset}): ${message}`);
    this.name = 'MusParseError';
    this.offset = offset;
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** The classic AdLib/IMF hardware timer rate in Hz. */
const DEFAULT_TICK_RATE = 560;

/** Bytes consumed per OPL register event: register, value, delay(uint16 LE). */
const EVENT_SIZE = 4;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse a raw `.MUS` OPL2/AdLib register stream into a {@link MusSequence}.
 *
 * @param buffer Raw bytes of the `.MUS` file.
 * @param options Interpretation options (tick rate, length prefix).
 * @returns The decoded sequence.
 * @throws {MusParseError} If the buffer is malformed or truncated.
 *
 * Requirements: 10.1
 */
export function parseMus(buffer: Uint8Array, options: MusParseOptions = {}): MusSequence {
  const tickRate = options.tickRate ?? DEFAULT_TICK_RATE;
  if (!Number.isFinite(tickRate) || tickRate <= 0) {
    throw new MusParseError(`invalid tickRate ${tickRate}; must be a positive finite number`, 0);
  }

  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  let offset = 0;
  let dataEnd = buffer.byteLength;

  if (options.hasLengthPrefix) {
    if (buffer.byteLength < 2) {
      throw new MusParseError(
        `expected a 2-byte length prefix but buffer holds only ${buffer.byteLength} byte(s)`,
        0,
      );
    }
    const declaredLength = view.getUint16(0, true);
    offset = 2;
    dataEnd = offset + declaredLength;
    if (dataEnd > buffer.byteLength) {
      throw new MusParseError(
        `length prefix declares ${declaredLength} byte(s) of register data, ` +
          `but only ${buffer.byteLength - offset} byte(s) follow the prefix`,
        0,
      );
    }
  }

  const dataBytes = dataEnd - offset;
  if (dataBytes % EVENT_SIZE !== 0) {
    throw new MusParseError(
      `register data length ${dataBytes} is not a multiple of the ${EVENT_SIZE}-byte event size ` +
        `(stream appears truncated or misaligned)`,
      offset + dataBytes - (dataBytes % EVENT_SIZE),
    );
  }

  const events: OplEvent[] = [];
  let totalTicks = 0;

  while (offset < dataEnd) {
    // Bounds are guaranteed by the multiple-of-EVENT_SIZE check above, but we
    // keep an explicit guard so the offset is reported precisely if reached.
    if (offset + EVENT_SIZE > dataEnd) {
      throw new MusParseError(
        `incomplete event: ${dataEnd - offset} byte(s) remain, need ${EVENT_SIZE}`,
        offset,
      );
    }

    const register = view.getUint8(offset);
    const value = view.getUint8(offset + 1);
    const delay = view.getUint16(offset + 2, true);

    events.push({ register, value, delay });
    totalTicks += delay;
    offset += EVENT_SIZE;
  }

  return {
    tickRate,
    events,
    totalTicks,
    durationSeconds: totalTicks / tickRate,
  };
}

// ---------------------------------------------------------------------------
// OGG stub conversion
// ---------------------------------------------------------------------------

/**
 * Encode a string as base64 in a way that works in both Node and browser
 * runtimes without pulling in Buffer typings at call sites.
 */
function toBase64(text: string): string {
  // `Buffer` is available in the tools (Node) runtime; guard for portability.
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(text, 'utf-8').toString('base64');
  }
  // Fallback for browser-like environments.
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Convert a parsed {@link MusSequence} into a base64-encoded OGG stub envelope
 * for the web audio pipeline.
 *
 * The stub carries the full sequence so the deferred build step can perform the
 * actual OPL2 synthesis and Vorbis encoding without re-reading the original DOS
 * file.
 *
 * @param sequence The parsed sequence.
 * @param context Optional music context to associate with the track.
 * @returns The OGG stub envelope.
 *
 * Requirements: 10.1
 */
export function toOggStub(sequence: MusSequence, context?: MusicContext): OggStub {
  const payload = JSON.stringify(sequence);
  const stub: OggStub = {
    format: 'ogg-stub',
    version: 1,
    tickRate: sequence.tickRate,
    eventCount: sequence.events.length,
    durationSeconds: sequence.durationSeconds,
    data: toBase64(payload),
  };
  if (context !== undefined) {
    stub.context = context;
  }
  return stub;
}

/**
 * Parse a raw `.MUS` buffer and convert it directly to an OGG stub, logging any
 * parse error with byte-offset context before rethrowing.
 *
 * @param buffer Raw bytes of the `.MUS` file.
 * @param options Interpretation options and optional music context.
 * @returns The OGG stub envelope.
 * @throws {MusParseError} If the buffer is malformed or truncated.
 *
 * Requirements: 10.1
 */
export function convertMusToOggStub(
  buffer: Uint8Array,
  options: MusParseOptions & { context?: MusicContext } = {},
): OggStub {
  try {
    const sequence = parseMus(buffer, options);
    return toOggStub(sequence, options.context);
  } catch (error) {
    if (error instanceof MusParseError) {
      // Log with byte-offset context to aid diagnosis of malformed files.
      console.error(
        `[MusParser] failed to parse .MUS stream: ${error.message} ` +
          `(offset=0x${error.offset.toString(16).padStart(4, '0')})`,
      );
    }
    throw error;
  }
}
