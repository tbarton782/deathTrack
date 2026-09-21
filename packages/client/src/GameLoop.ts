/**
 * Client game loop (task 19.1).
 *
 * This module wires together the three already-complete client subsystems into
 * the per-frame flow described in design.md ("Game Loop (requestAnimationFrame)")
 * and Requirements 1.1 (deterministic local prediction), 2.5 (per-frame render
 * feed) and 13.2 (60 fps render path):
 *
 *   read input → local prediction (`stepPhysics`) → {@link NetworkManager.sendInput}
 *   → {@link NetworkManager.getInterpolatedState} → {@link Renderer.render}
 *
 * ## Split for testability (mirrors renderLoop.ts)
 *
 * The loop has two halves, split so the interesting orchestration is testable
 * without a browser or a WebGL context:
 *
 *  1. {@link GameLoop.tick} — the **pure per-frame orchestration**. Given the
 *     frame's fixed-step count and render `alpha`, it reads input, steps the
 *     local prediction the right number of times, sends the input frame,
 *     fetches the interpolated network state, and renders. It touches no DOM,
 *     no `requestAnimationFrame` and no WebGL directly — every collaborator is
 *     injected behind a tiny interface, so a headless unit test can drive it
 *     with fakes and assert the call order.
 *
 *  2. {@link GameLoop.start} — a **thin browser-only wrapper** that pumps
 *     {@link GameLoop.tick} from the shared fixed-timestep
 *     {@link RenderLoopStepper} via {@link startRenderLoop}. This is the only
 *     place `requestAnimationFrame` is touched; it simply forwards each frame's
 *     `simulationSteps`/`alpha` into {@link GameLoop.tick}, so — like
 *     `startRenderLoop` itself — it is validated in the browser rather than in
 *     headless unit tests.
 *
 * The `RenderLoopStepper` (the fixed-timestep accumulator) is **reused** from
 * `renderer/renderLoop.ts` rather than reinvented here; it already converts the
 * irregular rAF timestamps into a whole-step count plus the render `alpha`.
 *
 * ## Decoupling
 *
 * `GameLoop` does not hard-depend on `InputHandler` (task 19.2, a separate
 * file): it consumes input only through the tiny local {@link InputSource}
 * interface, so the two files can be built concurrently. Likewise the network
 * manager and renderer are consumed through the minimal structural
 * {@link GameNetworkManager} / {@link GameRenderer} interfaces (satisfied by the
 * real {@link NetworkManager} / {@link Renderer}) so the loop can be unit-tested
 * with in-memory fakes.
 *
 * Requirements: 1.1, 2.5, 13.2
 */

import {
  stepPhysics,
  mkRNG,
  FIXED_TIMESTEP,
  type CarInputs,
  type CarPhysicsState,
  type InputFrame,
  type ParticipantId,
  type PhysicsCarStats,
  type PhysicsWorldState,
  type RNG,
  type TrackId,
  type TrackSDF,
} from '@deathtrack/shared';
import {
  RenderLoopStepper,
  startRenderLoop,
  type FrameStep,
  type RenderLoopEnv,
  type RenderLoopHandle,
} from './renderer/renderLoop.js';
import type { RenderState as RendererRenderState } from './renderer/renderState.js';

// ---------------------------------------------------------------------------
// Collaborator interfaces (kept minimal so the loop stays decoupled + testable)
// ---------------------------------------------------------------------------

/**
 * The source of the local player's control inputs for a frame. Implemented by
 * the keyboard-driven `InputHandler` (task 19.2), but defined here as a tiny
 * interface so {@link GameLoop} does not hard-depend on that file and so tests
 * can supply a fake. Callers may implement either method (or both):
 *
 * - {@link readInputs} — sample-and-advance semantics (e.g. latch the current
 *   key state for this tick). Preferred when present.
 * - {@link currentInputs} — a pure read of the current input state.
 */
export interface InputSource {
  /** Sample the control inputs for the current tick (may advance internal state). */
  readInputs?(): CarInputs;
  /** Read the current control inputs without advancing any internal state. */
  currentInputs?(): CarInputs;
}

/**
 * The subset of {@link NetworkManager} the loop drives each frame. The real
 * {@link import('./network/NetworkManager.js').NetworkManager} satisfies this
 * structurally; tests supply an in-memory fake.
 *
 * `TRenderState` is the shape returned by {@link getInterpolatedState}; it is
 * left generic so the loop does not couple to the network layer's specific
 * `RenderState` type (which differs from the renderer's richer one).
 */
export interface GameNetworkManager<TRenderState> {
  /** Send the local input frame for this tick to the server (Req 8.1). */
  sendInput(frame: InputFrame): void;
  /** Record the locally-predicted state for a tick into the reconciliation buffer. */
  recordPrediction?(tick: number, inputs: CarInputs, state: CarPhysicsState): void;
  /** Produce the interpolated render state for the given render time (server-time ms). */
  getInterpolatedState(renderTime: number): TRenderState;
  /** Advance any active smooth-lerp correction by one render frame. */
  tickCorrection?(): { x: number; y: number };
  /** Current wall-clock time from the network manager's injected clock (ms). */
  now?(): number;
}

/**
 * The subset of {@link Renderer} the loop calls each frame. The real
 * {@link import('./renderer/Renderer.js').Renderer} satisfies this structurally;
 * tests supply a fake that just records its calls.
 */
export interface GameRenderer<TRenderState> {
  /**
   * Draw one frame. `alpha` is the fixed-timestep interpolation factor for this
   * frame (see {@link RenderLoopStepper}).
   */
  render(current: TRenderState, alpha: number, previous?: TRenderState, nowMs?: number): void;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * Everything the loop needs to run local prediction via {@link stepPhysics}.
 * These come from the loaded track and resolved loadouts and stay fixed for the
 * duration of a race.
 */
export interface PredictionContext {
  /** The local participant whose car is predicted each frame. */
  readonly localId: ParticipantId;
  /** The track currently being raced on. */
  readonly trackId: TrackId;
  /** Deterministic RNG seed shared with the authority for identical stepping (Req 1.9). */
  readonly rngSeed: number;
  /** Optional per-car physics stats forwarded to {@link stepPhysics}. */
  readonly carStats?: ReadonlyMap<ParticipantId, PhysicsCarStats>;
  /** Optional track signed-distance field for off-track detection. */
  readonly trackSDF?: TrackSDF;
}

/**
 * Constructor options for {@link GameLoop}.
 *
 * `TNetState` is the type {@link GameNetworkManager.getInterpolatedState}
 * returns; `mapRenderState` converts it into the renderer's own
 * {@link RendererRenderState}. Keeping this a caller-supplied mapper is what
 * lets {@link GameLoop} orchestrate the two subsystems without hard-coding the
 * (deliberately different) network- and renderer-side state shapes.
 */
export interface GameLoopOptions<TNetState> {
  /** Source of the local player's control inputs (task 19.2 `InputHandler`). */
  readonly input: InputSource;
  /** The client network manager (prediction/reconciliation/interpolation). */
  readonly network: GameNetworkManager<TNetState>;
  /** The PixiJS renderer. */
  readonly renderer: GameRenderer<RendererRenderState>;
  /** Local-prediction context for {@link stepPhysics}. */
  readonly prediction: PredictionContext;
  /**
   * Converts the network layer's interpolated state into the renderer's render
   * state. Invoked once per frame with the value from
   * {@link GameNetworkManager.getInterpolatedState}.
   */
  readonly mapRenderState: (netState: TNetState) => RendererRenderState;
  /**
   * The car's initial physics state at race start. Local prediction advances
   * from here; if omitted, prediction starts from a stationary car at the
   * origin on the first tick.
   */
  readonly initialCarState?: CarPhysicsState;
  /**
   * Time source used both as the interpolation render time and the wall-clock
   * passed to {@link Renderer.render}. Defaults to the network manager's clock
   * (`network.now()`) when available, else `performance.now()`/`Date.now()`.
   */
  readonly now?: () => number;
}

// ---------------------------------------------------------------------------
// GameLoop
// ---------------------------------------------------------------------------

/** A neutral/idle input used before the input source produces anything. */
const IDLE_INPUTS: CarInputs = {
  throttle: 0,
  brake: 0,
  steer: 0,
  fireForward: false,
  fireRear: false,
};

/**
 * The client game loop. Owns the local-prediction state and the per-frame
 * orchestration; delegates rAF scheduling to the shared {@link startRenderLoop}
 * and all timing maths to {@link RenderLoopStepper}.
 */
export class GameLoop<TNetState> {
  private readonly input: InputSource;
  private readonly network: GameNetworkManager<TNetState>;
  private readonly renderer: GameRenderer<RendererRenderState>;
  private readonly prediction: PredictionContext;
  private readonly mapRenderState: (netState: TNetState) => RendererRenderState;
  private readonly nowFn: () => number;

  /** Deterministic RNG for local prediction; re-seeded from the prediction context. */
  private readonly rng: RNG;

  /** The local car's current predicted physics state. Advanced by {@link tick}. */
  private car: CarPhysicsState;

  /** Monotonic local physics tick counter; increments once per fixed step. */
  private tickCounter = 0;

  /** CRC-32 of the prior tick's local car state (attached to the next input frame). */
  private priorChecksum = 0;

  /** The previous frame's mapped render state, for fixed-timestep interpolation. */
  private previousRenderState: RendererRenderState | null = null;

  /** Active rAF loop handle, or `null` when stopped. */
  private handle: RenderLoopHandle | null = null;

  constructor(options: GameLoopOptions<TNetState>) {
    this.input = options.input;
    this.network = options.network;
    this.renderer = options.renderer;
    this.prediction = options.prediction;
    this.mapRenderState = options.mapRenderState;
    this.rng = mkRNG(options.prediction.rngSeed);
    this.car = options.initialCarState ?? defaultCarState(options.prediction.localId);
    this.nowFn =
      options.now ??
      (this.network.now ? () => this.network.now!() : defaultNow);
  }

  // --- Public accessors (mainly for tests / HUD) --------------------------

  /** The local car's current predicted physics state. */
  getPredictedCarState(): CarPhysicsState {
    return this.car;
  }

  /** The current local physics tick counter. */
  getTick(): number {
    return this.tickCounter;
  }

  /** Whether the rAF loop is currently running. */
  get running(): boolean {
    return this.handle?.running ?? false;
  }

  // --- Pure per-frame orchestration (unit-tested headlessly) --------------

  /**
   * Runs the per-frame flow once, in the order mandated by the task:
   *
   *   1. **read input** from the {@link InputSource};
   *   2. **run local prediction** by stepping {@link stepPhysics}
   *      `simulationSteps` times with those inputs (Req 1.1) and recording each
   *      predicted tick into the network manager's reconciliation buffer;
   *   3. **send** the input frame via {@link GameNetworkManager.sendInput}
   *      (Req 8.1);
   *   4. **get the interpolated state** for `renderTime` from
   *      {@link GameNetworkManager.getInterpolatedState};
   *   5. **render** it via {@link GameRenderer.render} with this frame's `alpha`.
   *
   * This method is deliberately free of `requestAnimationFrame` / WebGL so it is
   * fully unit-testable with fakes. {@link start} feeds it real frames.
   *
   * @param frame - The fixed-timestep frame info (whole `simulationSteps` to run
   *   plus the render `alpha`), as produced by {@link RenderLoopStepper.step}.
   * @param nowMs - Optional wall-clock override (ms). Defaults to the loop's
   *   time source; used both as the interpolation render time and passed to the
   *   renderer for its LOD frame-delta tracking.
   */
  tick(frame: FrameStep, nowMs?: number): void {
    const now = nowMs ?? this.nowFn();

    // 1. Read input for this frame.
    const inputs = this.readInputs();

    // 2. Local prediction: advance the local car by each whole fixed step this
    //    frame consumed. `simulationSteps` may be 0 (frame shorter than a step)
    //    or >1 (after a long stall, already clamped by the stepper). Each step
    //    increments the local tick, records the prediction for reconciliation,
    //    and updates the rolling checksum base.
    let sentThisFrame = false;
    for (let i = 0; i < frame.simulationSteps; i++) {
      this.car = this.predictOneStep(inputs);
      this.tickCounter += 1;

      const frameToSend: InputFrame = {
        tick: this.tickCounter,
        inputs,
        checksum: this.priorChecksum,
      };
      this.network.recordPrediction?.(this.tickCounter, inputs, this.car);

      // 3. Send the input frame for each simulated tick (one input frame per
      //    physics tick, per design.md / Req 8.1).
      this.network.sendInput(frameToSend);
      sentThisFrame = true;

      this.priorChecksum = checksumCarState(this.car);
    }

    // On a frame that consumed no whole step, still send the current input once
    // so the server keeps receiving the held control state at the render rate.
    if (!sentThisFrame) {
      this.network.sendInput({
        tick: this.tickCounter,
        inputs,
        checksum: this.priorChecksum,
      });
    }

    // Advance any pending reconciliation correction by one render frame.
    this.network.tickCorrection?.();

    // 4. Fetch the interpolated authoritative state for this render time.
    const netState = this.network.getInterpolatedState(now);
    const renderState = this.mapRenderState(netState);

    // 5. Render, blending from the previous frame's state by `alpha`.
    const previous = this.previousRenderState ?? undefined;
    this.renderer.render(renderState, frame.alpha, previous, now);
    this.previousRenderState = renderState;
  }

  // --- Thin browser rAF wrapper (validated in-browser) --------------------

  /**
   * Starts the `requestAnimationFrame`-driven loop at 60 fps, pumping
   * {@link tick} from the shared fixed-timestep {@link RenderLoopStepper}. This
   * is the only part of the loop that touches `requestAnimationFrame`; all
   * timing lives in the (unit-tested) stepper and all orchestration in
   * {@link tick}.
   *
   * @param env - Optional rAF/cancel overrides (default: browser globals),
   *   forwarded to {@link startRenderLoop}. Handy for driving the wrapper from
   *   a non-browser harness.
   * @param stepper - The fixed-timestep stepper to pump; defaults to a fresh
   *   60 fps one.
   * @returns A handle to stop the loop.
   */
  start(env: RenderLoopEnv = {}, stepper: RenderLoopStepper = new RenderLoopStepper()): RenderLoopHandle {
    this.stop();
    const handle = startRenderLoop((frame) => this.tick(frame), stepper, env);
    this.handle = handle;
    return handle;
  }

  /** Stops the rAF loop started by {@link start}, if running. */
  stop(): void {
    if (this.handle) {
      this.handle.stop();
      this.handle = null;
    }
  }

  // --- Internals ----------------------------------------------------------

  /** Sample the input source, tolerating either method and falling back to idle. */
  private readInputs(): CarInputs {
    if (this.input.readInputs) {
      return this.input.readInputs();
    }
    if (this.input.currentInputs) {
      return this.input.currentInputs();
    }
    return IDLE_INPUTS;
  }

  /** Advance the local car by one fixed physics step with the given inputs. */
  private predictOneStep(inputs: CarInputs): CarPhysicsState {
    const world: PhysicsWorldState = {
      cars: [this.car],
      tick: this.tickCounter,
      trackId: this.prediction.trackId,
      ...(this.prediction.carStats ? { carStats: this.prediction.carStats } : {}),
      ...(this.prediction.trackSDF ? { trackSDF: this.prediction.trackSDF } : {}),
    };
    const inputMap = new Map<ParticipantId, CarInputs>([[this.prediction.localId, inputs]]);
    const result = stepPhysics(world, inputMap, FIXED_TIMESTEP, this.rng);
    return result.cars[0] ?? this.car;
  }
}

// ---------------------------------------------------------------------------
// Helpers (pure)
// ---------------------------------------------------------------------------

/** A stationary local car at the origin, used when no initial state is supplied. */
function defaultCarState(id: ParticipantId): CarPhysicsState {
  return {
    id,
    position: { x: 0, y: 0 },
    velocity: { x: 0, y: 0 },
    heading: 0,
    speed: 0,
    angularVelocity: 0,
    onTrack: true,
    airborne: false,
    airborneHeight: 0,
    airborneVY: 0,
  };
}

/** Best-available monotonic wall clock (ms): `performance.now()` if present. */
function defaultNow(): number {
  const perf = (globalThis as { performance?: { now(): number } }).performance;
  return perf ? perf.now() : Date.now();
}

/**
 * A cheap, deterministic CRC-32-style checksum of the local car's continuous
 * physics state, used as the `checksum` field of the *next* input frame (the
 * CRC of the prior tick's state, per Req 8.5 / `InputFrame.checksum`). This is
 * intentionally simple: the authoritative desync check lives server-side and in
 * {@link NetworkManager}; the loop only needs a stable, order-independent hash
 * of the fields that define a tick's outcome.
 */
export function checksumCarState(state: CarPhysicsState): number {
  let crc = 0xffffffff;
  const feed = (n: number): void => {
    // Quantise floats to 0.001 so tiny FP noise does not perturb the checksum,
    // then fold the 32-bit integer in byte by byte.
    let v = Math.round(n * 1000) | 0;
    for (let b = 0; b < 4; b++) {
      crc = crc32Byte(crc, v & 0xff);
      v >>>= 8;
    }
  };
  feed(state.position.x);
  feed(state.position.y);
  feed(state.velocity.x);
  feed(state.velocity.y);
  feed(state.heading);
  feed(state.speed);
  feed(state.angularVelocity);
  feed(state.airborneHeight);
  crc = crc32Byte(crc, state.onTrack ? 1 : 0);
  crc = crc32Byte(crc, state.airborne ? 1 : 0);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Fold a single byte into a running CRC-32 (polynomial 0xEDB88320). */
function crc32Byte(crc: number, byte: number): number {
  let c = (crc ^ byte) & 0xff;
  for (let i = 0; i < 8; i++) {
    c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ((crc >>> 8) ^ c) >>> 0;
}
