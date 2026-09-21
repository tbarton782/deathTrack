import { describe, expect, it, vi } from 'vitest';
import type {
  CarInputs,
  CarPhysicsState,
  InputFrame,
  ParticipantId,
} from '@deathtrack/shared';
import {
  GameLoop,
  checksumCarState,
  type GameNetworkManager,
  type GameRenderer,
  type InputSource,
} from '../GameLoop';
import type { RenderState as RendererRenderState } from '../renderer/renderState';
import type { FrameStep } from '../renderer/renderLoop';

/**
 * Headless unit tests for the client game loop's pure per-frame orchestration
 * (task 19.1). The loop's collaborators (input source, network manager,
 * renderer) are injected behind tiny interfaces, so this exercises the
 * read-input → predict → sendInput → getInterpolatedState → render flow with
 * in-memory fakes under the `node` vitest environment — no rAF, no WebGL.
 *
 * Validates: Requirements 1.1 (local prediction), 2.5 / 13.2 (per-frame render).
 */

// --- Test doubles ----------------------------------------------------------

const HELD_INPUTS: CarInputs = {
  throttle: 1,
  brake: 0,
  steer: 0.25,
  fireForward: false,
  fireRear: false,
};

/** Records the ordered sequence of collaborator calls for order assertions. */
interface CallLog {
  readonly events: string[];
}

class FakeInput implements InputSource {
  reads = 0;
  constructor(
    private readonly log: CallLog,
    private readonly inputs: CarInputs = HELD_INPUTS,
  ) {}
  readInputs(): CarInputs {
    this.reads += 1;
    this.log.events.push('readInputs');
    return this.inputs;
  }
}

/** A minimal network-side interpolated state the fake returns. */
interface FakeNetState {
  readonly renderTime: number;
  readonly cars: readonly { id: ParticipantId; x: number; y: number }[];
}

class FakeNetwork implements GameNetworkManager<FakeNetState> {
  sentFrames: InputFrame[] = [];
  predictions: { tick: number; state: CarPhysicsState }[] = [];
  interpolatedTimes: number[] = [];
  correctionTicks = 0;
  constructor(
    private readonly log: CallLog,
    private readonly clockValue = 1000,
  ) {}
  sendInput(frame: InputFrame): void {
    this.log.events.push('sendInput');
    this.sentFrames.push(frame);
  }
  recordPrediction(tick: number, _inputs: CarInputs, state: CarPhysicsState): void {
    this.log.events.push('recordPrediction');
    this.predictions.push({ tick, state });
  }
  getInterpolatedState(renderTime: number): FakeNetState {
    this.log.events.push('getInterpolatedState');
    this.interpolatedTimes.push(renderTime);
    return { renderTime, cars: [{ id: 0, x: renderTime, y: 0 }] };
  }
  tickCorrection(): { x: number; y: number } {
    this.correctionTicks += 1;
    return { x: 0, y: 0 };
  }
  now(): number {
    return this.clockValue;
  }
}

class FakeRenderer implements GameRenderer<RendererRenderState> {
  renders: { state: RendererRenderState; alpha: number; previous?: RendererRenderState }[] = [];
  constructor(private readonly log: CallLog) {}
  render(
    current: RendererRenderState,
    alpha: number,
    previous?: RendererRenderState,
    _nowMs?: number,
  ): void {
    this.log.events.push('render');
    this.renders.push({ state: current, alpha, ...(previous ? { previous } : {}) });
  }
}

/** Maps the fake network state into a renderer render state. */
function mapRenderState(net: FakeNetState): RendererRenderState {
  const lead = net.cars[0] ?? { id: 0, x: 0, y: 0 };
  return {
    cameraTarget: { position: { x: lead.x, y: lead.y }, heading: 0 },
    cars: net.cars.map((c) => ({
      id: c.id,
      position: { x: c.x, y: c.y },
      heading: 0,
      airborneHeight: 0,
    })),
    scenery: [],
    hazards: [],
    projectiles: [],
  };
}

function makeLoop(overrides?: {
  input?: FakeInput;
  network?: FakeNetwork;
  renderer?: FakeRenderer;
  now?: () => number;
}) {
  const log: CallLog = { events: [] };
  const input = overrides?.input ?? new FakeInput(log);
  const network = overrides?.network ?? new FakeNetwork(log);
  const renderer = overrides?.renderer ?? new FakeRenderer(log);
  const loop = new GameLoop<FakeNetState>({
    input,
    network,
    renderer,
    prediction: { localId: 0, trackId: 'bay_area', rngSeed: 42 },
    mapRenderState,
    ...(overrides?.now ? { now: overrides.now } : {}),
  });
  return { loop, log, input, network, renderer };
}

const frame = (simulationSteps: number, alpha = 0.5): FrameStep => ({
  deltaMs: simulationSteps * (1000 / 60),
  simulationSteps,
  alpha,
});

// --- Tests -----------------------------------------------------------------

describe('GameLoop.tick per-frame orchestration', () => {
  it('runs the flow in order: read input → predict → send → interpolate → render', () => {
    const { loop, log } = makeLoop();
    loop.tick(frame(1));

    // The five stages appear in the mandated order. Prediction (predict/record/
    // send) happens before interpolation and render.
    expect(log.events[0]).toBe('readInputs');
    const sendIdx = log.events.indexOf('sendInput');
    const interpIdx = log.events.indexOf('getInterpolatedState');
    const renderIdx = log.events.indexOf('render');
    expect(sendIdx).toBeGreaterThan(0);
    expect(interpIdx).toBeGreaterThan(sendIdx);
    expect(renderIdx).toBeGreaterThan(interpIdx);
    expect(renderIdx).toBe(log.events.length - 1);
  });

  it('reads input exactly once per frame regardless of step count', () => {
    const { loop, input } = makeLoop();
    loop.tick(frame(3));
    expect(input.reads).toBe(1);
  });

  it('advances local prediction once per whole simulation step (Req 1.1)', () => {
    const { loop, network } = makeLoop();
    loop.tick(frame(3));
    expect(loop.getTick()).toBe(3);
    expect(network.predictions).toHaveLength(3);
    expect(network.predictions.map((p) => p.tick)).toEqual([1, 2, 3]);
    // Sends one input frame per simulated tick.
    expect(network.sentFrames.map((f) => f.tick)).toEqual([1, 2, 3]);
  });

  it('passes the frame alpha through to the renderer', () => {
    const { loop, renderer } = makeLoop();
    loop.tick(frame(1, 0.75));
    expect(renderer.renders).toHaveLength(1);
    expect(renderer.renders[0]!.alpha).toBe(0.75);
  });

  it('uses the network clock as the interpolation render time', () => {
    const network = new FakeNetwork({ events: [] }, 2500);
    const { loop } = makeLoop({ network });
    loop.tick(frame(1));
    expect(network.interpolatedTimes).toEqual([2500]);
  });

  it('feeds the previous frame render state on the next render (interpolation)', () => {
    const { loop, renderer } = makeLoop();
    loop.tick(frame(1));
    loop.tick(frame(1));
    expect(renderer.renders[0]!.previous).toBeUndefined();
    expect(renderer.renders[1]!.previous).toBeDefined();
    expect(renderer.renders[1]!.previous).toBe(renderer.renders[0]!.state);
  });

  it('still sends the held input once on a frame that consumes no whole step', () => {
    const { loop, network } = makeLoop();
    loop.tick(frame(0));
    expect(loop.getTick()).toBe(0);
    expect(network.predictions).toHaveLength(0);
    expect(network.sentFrames).toHaveLength(1);
    expect(network.sentFrames[0]!.tick).toBe(0);
  });

  it('advances the reconciliation correction each frame', () => {
    const { loop, network } = makeLoop();
    loop.tick(frame(1));
    loop.tick(frame(0));
    expect(network.correctionTicks).toBe(2);
  });

  it('attaches the prior tick checksum to each input frame (Req 8.5)', () => {
    const { loop, network } = makeLoop();
    loop.tick(frame(2));
    // First frame carries the initial (prior) checksum of 0; the second frame
    // carries the checksum of the state predicted at tick 1.
    expect(network.sentFrames[0]!.checksum).toBe(0);
    expect(network.sentFrames[1]!.checksum).toBe(
      checksumCarState(network.predictions[0]!.state),
    );
  });

  it('predicts from the supplied initial car state', () => {
    const log: CallLog = { events: [] };
    const input = new FakeInput(log);
    const network = new FakeNetwork(log);
    const renderer = new FakeRenderer(log);
    const initial: CarPhysicsState = {
      id: 0,
      position: { x: 5, y: 10 },
      velocity: { x: 0, y: 0 },
      heading: 0,
      speed: 0,
      angularVelocity: 0,
      onTrack: true,
      airborne: false,
      airborneHeight: 0,
      airborneVY: 0,
    };
    const loop = new GameLoop<FakeNetState>({
      input,
      network,
      renderer,
      prediction: { localId: 0, trackId: 'bay_area', rngSeed: 1 },
      mapRenderState,
      initialCarState: initial,
    });
    // Zero steps: prediction untouched, so the predicted state is the initial one.
    loop.tick(frame(0));
    expect(loop.getPredictedCarState()).toEqual(initial);
  });
});

describe('GameLoop.start / stop (rAF wrapper)', () => {
  it('pumps tick from injected requestAnimationFrame and stops cleanly', () => {
    const { loop, renderer } = makeLoop();
    let rafCb: ((t: number) => void) | null = null;
    let handle = 0;
    const env = {
      requestAnimationFrame: (cb: (t: number) => void): number => {
        rafCb = cb;
        return ++handle;
      },
      cancelAnimationFrame: vi.fn(),
    };
    const h = loop.start(env);
    expect(loop.running).toBe(true);

    // Drive two frames through the injected rAF: first frame baselines the
    // stepper (0 steps), the second advances time enough for a render.
    expect(rafCb).not.toBeNull();
    rafCb!(0);
    rafCb!(100);
    expect(renderer.renders.length).toBeGreaterThanOrEqual(2);

    h.stop();
    expect(loop.running).toBe(false);
    expect(env.cancelAnimationFrame).toHaveBeenCalled();
  });
});

describe('checksumCarState', () => {
  it('is deterministic and returns an unsigned 32-bit integer', () => {
    const s: CarPhysicsState = {
      id: 0,
      position: { x: 1.234, y: -5.678 },
      velocity: { x: 0.5, y: -0.25 },
      heading: 1.5,
      speed: 12.5,
      angularVelocity: 0.1,
      onTrack: true,
      airborne: false,
      airborneHeight: 0,
      airborneVY: 0,
    };
    const a = checksumCarState(s);
    const b = checksumCarState(s);
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(a)).toBe(true);
  });

  it('changes when the car state changes', () => {
    const base: CarPhysicsState = {
      id: 0,
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
    const moved: CarPhysicsState = { ...base, position: { x: 1, y: 0 } };
    expect(checksumCarState(base)).not.toBe(checksumCarState(moved));
  });
});
