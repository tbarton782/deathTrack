/**
 * Network, session, and multiplayer types for the Deathtrack Multiplayer Recreation.
 *
 * Requirements: 7.1–7.8, 8.1–8.8
 */

import type { ParticipantId, SessionId, TrackId } from './primitives.js';
import type { CarInputs } from './physics.js';
import type { Loadout } from './car.js';
import type { AIDriverConfig } from './ai.js';

// ---------------------------------------------------------------------------
// Session configuration and state
// ---------------------------------------------------------------------------

/**
 * Configuration parameters provided when creating a new multiplayer session.
 *
 * Constraints:
 * - `name`: 1–32 characters (Requirements: 7.1, 7.3)
 * - `maxPlayers`: 2–8 (Requirements: 7.1)
 * - `password`: null for an open session; up to 20 characters if set (Requirements: 7.3)
 *
 * Requirements: 7.1, 7.3
 */
export interface SessionConfig {
  /** Session display name; 1–32 characters. */
  name: string;
  /** The track to race on. */
  trackId: TrackId;
  /** Maximum human participants; 2–8. Requirements: 7.1 */
  maxPlayers: number;
  /** Session password, or `null` for an open (passwordless) session. Up to 20 chars. */
  password: string | null;
  /**
   * When `true`, empty participant slots are filled with AI drivers at race start.
   * Requirements: 7.7
   */
  fillWithAI: boolean;
}

/**
 * Full server-side session record tracking configuration, participants, and lifecycle state.
 *
 * Requirements: 7.1–7.8
 */
export interface Session {
  /** Unique session identifier (UUID v4). */
  id: SessionId;
  /** Immutable configuration supplied at creation time. */
  config: SessionConfig;
  /** Participant ID of the current session host. Changes on host disconnect. Requirements: 7.8 */
  hostParticipantId: ParticipantId;
  /** All connected participants keyed by their slot index. Requirements: 7.4 */
  participants: Map<ParticipantId, ParticipantInfo>;
  /** Session lifecycle state. Requirements: 7.4, 7.5 */
  state: 'lobby' | 'racing' | 'results' | 'closed';
  /** Timestamp of session creation in milliseconds (`Date.now()`). Requirements: 7.1 */
  createdAt: number;
}

/**
 * Per-participant information tracked within a session.
 *
 * Requirements: 7.4, 7.5, 7.7
 */
export interface ParticipantInfo {
  /** Slot index assigned to this participant (0–7). */
  id: ParticipantId;
  /** Player's chosen display name (1–20 characters). Requirements: 13.5 */
  displayName: string;
  /** The car loadout this participant has configured, or `null` if not yet set. Requirements: 4.4 */
  loadout: Loadout | null;
  /** Whether this participant has signalled readiness to start the race. Requirements: 7.5 */
  ready: boolean;
  /** `true` for AI-controlled slots filled at race start. Requirements: 7.7 */
  isAI: boolean;
  /** AI configuration for AI-controlled participants; absent for human participants. */
  aiConfig?: AIDriverConfig;
  /** Timestamp (milliseconds) when this participant joined the session. Requirements: 7.8 */
  joinedAt: number;
}

// ---------------------------------------------------------------------------
// Session summary (used by the session browser)
// ---------------------------------------------------------------------------

/**
 * Condensed session information returned by `GET /sessions` for the session browser.
 *
 * Requirements: 7.2
 */
export interface SessionSummary {
  /** Session identifier. */
  id: SessionId;
  /** Session display name as provided in `SessionConfig`. */
  name: string;
  /** Track being raced. */
  trackId: TrackId;
  /** Number of human participants currently in the session. */
  currentPlayers: number;
  /** Maximum number of human participants allowed. */
  maxPlayers: number;
  /** `true` if the session requires a password to join. */
  hasPassword: boolean;
  /** `'lobby'` means the race has not started yet; `'racing'` means in progress. */
  state: 'lobby' | 'racing';
}

// ---------------------------------------------------------------------------
// Join result
// ---------------------------------------------------------------------------

/**
 * Result returned by `SessionManager.joinSession` and the `POST /sessions/:id/join` endpoint.
 *
 * Requirements: 7.3
 */
export interface JoinResult {
  /** Whether the join request was accepted. */
  success: boolean;
  /** The slot index assigned to the joining participant; present on success. */
  participantId?: ParticipantId;
  /**
   * Reason for rejection; present on failure.
   * - `'full'`            — session has reached `maxPlayers`.
   * - `'wrong_password'`  — provided password did not match.
   * - `'not_found'`       — no session with the given ID exists.
   * - `'already_started'` — session is in `'racing'` state and closed to new joins.
   */
  error?: 'full' | 'wrong_password' | 'not_found' | 'already_started';
  /** Full session record returned on success so the client can populate the lobby. */
  session?: Session;
}

// ---------------------------------------------------------------------------
// Network packets — Client → Server
// ---------------------------------------------------------------------------

/**
 * A single player-input frame sent from client to server every physics tick (60 Hz).
 *
 * Requirements: 8.1, 8.5
 */
export interface InputFrame {
  /** The client's current physics tick counter at the time of dispatch. */
  tick: number;
  /** Control inputs sampled at this tick. */
  inputs: CarInputs;
  /**
   * CRC-32 of the prior tick's local car state.
   * Used by the server to detect desync. Requirements: 8.5
   */
  checksum: number;
}

// ---------------------------------------------------------------------------
// Network packets — Server → Client
// ---------------------------------------------------------------------------

/**
 * Fixed-point compressed representation of a single car's state, broadcast to all
 * clients in a `StateSnapshot`.
 *
 * Encoding sizes (total ≈ 10 bytes per car):
 * - `id`           — 3 bits (up to 8 participants)
 * - `x`, `y`       — uint16 × 0.1 unit resolution
 * - `heading`      — uint8, 256 steps ≈ 1.4° resolution
 * - `speed`        — uint16 × 0.01 unit resolution
 * - `armor`        — uint8, 0–255 mapped from 0–maxArmor
 * - `flags`        — uint8 bitfield (bit 0 = eliminated, bit 1 = airborne, bit 2 = onTrack)
 * - `ammoForward`  — uint8
 * - `ammoRear`     — uint8
 *
 * Requirements: 8.7, 8.8
 */
export interface CompressedCarState {
  /** Participant slot index (0–7). */
  id: ParticipantId;
  /** X position, fixed-point with 0.1 unit resolution. */
  x: number;
  /** Y position, fixed-point with 0.1 unit resolution. */
  y: number;
  /** Heading encoded as uint8 (0–255 maps to 0–2π). */
  heading: number;
  /** Speed encoded as uint16 with 0.01 unit resolution. */
  speed: number;
  /** Armor encoded as uint8 (0–255 linearly mapped from 0–maxArmor). */
  armor: number;
  /**
   * Status bitfield:
   * - bit 0 (0x01): eliminated
   * - bit 1 (0x02): airborne
   * - bit 2 (0x04): onTrack
   */
  flags: number;
  /** Forward weapon ammo count (uint8). */
  ammoForward: number;
  /** Rear weapon ammo count (uint8). */
  ammoRear: number;
}

/**
 * Authoritative game state snapshot broadcast from server to all clients at 20 Hz.
 *
 * The `events` array includes the last 3 events for replay recovery against
 * packet loss.
 *
 * 8 cars × ~10 bytes + header ≈ 100 bytes — well within the 512-byte limit.
 *
 * Requirements: 8.1, 8.5, 8.7, 8.8
 */
export interface StateSnapshot {
  /** Server's authoritative physics tick counter. */
  tick: number;
  /** Milliseconds elapsed since race start on the server. */
  serverTime: number;
  /** Compressed state for all active cars (1–8 entries). */
  cars: CompressedCarState[];
  /** Network events that occurred since the previous snapshot (up to 3 replayed). */
  events: NetworkEvent[];
  /**
   * CRC-32 of the full server world state at this tick.
   * Clients compare against their local state to detect desync. Requirements: 8.5
   */
  authorityChecksum: number;
}

// ---------------------------------------------------------------------------
// Network events (discriminated union)
// ---------------------------------------------------------------------------

/**
 * A player has joined the session.
 * Requirements: 7.4
 */
export interface ParticipantJoinedEvent {
  readonly type: 'participant_joined';
  readonly participantId: ParticipantId;
  readonly displayName: string;
  /** Timestamp matching `ParticipantInfo.joinedAt`. */
  readonly joinedAt: number;
}

/**
 * A player has disconnected or been removed from the session.
 * The client should freeze and then remove the car sprite.
 * Requirements: 7.6
 */
export interface ParticipantLeftEvent {
  readonly type: 'participant_left';
  readonly participantId: ParticipantId;
  /**
   * Reason for departure.
   * - `'disconnect'`  — no input received for > 3 s (> 60 missed frames).
   * - `'quit'`        — participant voluntarily left.
   * - `'eliminated'`  — car armor reached zero (race removal).
   */
  readonly reason: 'disconnect' | 'quit' | 'eliminated';
}

/**
 * The session has been closed by the host or server.
 * Requirements: 7.1
 */
export interface SessionClosedEvent {
  readonly type: 'session_closed';
  /** Human-readable reason string (e.g. "Host closed the session"). */
  readonly reason: string;
}

/**
 * Session host has changed to another participant.
 * Requirements: 7.8
 */
export interface HostTransferredEvent {
  readonly type: 'host_transferred';
  /** Participant ID of the previous host (for display). */
  readonly previousHostId: ParticipantId;
  /** Participant ID of the new host. */
  readonly newHostId: ParticipantId;
}

/**
 * A participant has paused the game.
 * Requirements: 11.5
 */
export interface PausedEvent {
  readonly type: 'paused';
  readonly participantId: ParticipantId;
}

/**
 * A participant has resumed the game after a pause.
 * Requirements: 11.5
 */
export interface ResumedEvent {
  readonly type: 'resumed';
  readonly participantId: ParticipantId;
}

/**
 * Discriminated union of all events broadcast in a `StateSnapshot.events` array.
 *
 * Requirements: 7.4, 7.6, 7.8, 8.4
 */
export type NetworkEvent =
  | ParticipantJoinedEvent
  | ParticipantLeftEvent
  | SessionClosedEvent
  | HostTransferredEvent
  | PausedEvent
  | ResumedEvent;
