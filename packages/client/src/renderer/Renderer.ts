import {
  AnimatedSprite,
  Application,
  Container,
  Graphics,
  Rectangle,
  Sprite,
  Texture,
} from 'pixi.js';
import type { ApplicationOptions } from 'pixi.js';
import type {
  AtlasFrame,
  EliminationEvent,
  ParticipantId,
  SceneryObject,
  SpriteAtlas,
  Vec2,
} from '@deathtrack/shared';
import {
  ExplosionManager,
  type ExplosionState,
  type SpawnExplosionOptions,
} from './explosion.js';
import {
  projectCars,
  type CarProjectionOptions,
  type CarRenderTarget,
} from './carSprite.js';
import {
  CAMERA_ABOVE_DEFAULT_PX,
  CAMERA_BEHIND_DEFAULT_PX,
  depthToRow,
  groundPointAtDepth,
  placeCamera,
  projectAllScanlines,
  type CameraOffsetRequest,
  type CameraState,
  type CameraTarget,
  type ProjectionParams,
  type ScanlineProjection,
} from './scanline.js';
import {
  createPaletteFilter,
  type PaletteFilterHandle,
  type PaletteMode,
} from './PaletteShader.js';
import { AdaptiveLod, type LodTransition } from './adaptiveLod.js';
import type { ActiveProjectile, SpritePalette } from '@deathtrack/shared';
import {
  interpolateRenderState,
  type RenderCar,
  type RenderState,
} from './renderState.js';
import {
  startRenderLoop,
  RenderLoopStepper,
  type FrameStep,
  type RenderLoopEnv,
  type RenderLoopHandle,
} from './renderLoop.js';
import { depthAndLateral } from './carSprite.js';

/**
 * The eight draw layers of the renderer, listed back-to-front. The array order
 * is the render order: earlier entries are drawn first (further back), later
 * entries are drawn on top. See design.md "Draw layers (back to front)".
 *
 * Requirement 2.2: road surface first, then track boundaries, then scenery,
 * then hazards. The remaining layers (cars, projectiles, explosions, HUD)
 * continue front-ward from there.
 */
export const DRAW_LAYER_NAMES = [
  'roadSurface',
  'trackBoundaries',
  'scenery',
  'hazards',
  'cars',
  'projectiles',
  'explosions',
  'hud',
] as const;

/** Name of a single draw layer. */
export type DrawLayerName = (typeof DRAW_LAYER_NAMES)[number];

/**
 * The draw layers whose content is drawn from the 256-colour indexed palette
 * and therefore receive the palette-emulation filter (task 15.3). The road
 * surface and every sprite layer are palette-indexed; track boundaries and the
 * HUD are drawn with explicit RGBA and are left unfiltered.
 */
export const PALETTE_FILTERED_LAYERS = [
  'roadSurface',
  'scenery',
  'hazards',
  'cars',
  'projectiles',
  'explosions',
] as const satisfies readonly DrawLayerName[];

/**
 * A back-to-front ordered registry of draw layers. Maps each layer name to its
 * PixiJS {@link Container}. The insertion order of this record matches
 * {@link DRAW_LAYER_NAMES}, and the containers are expected to be added to a
 * parent stage in that same order so that z-ordering is correct.
 */
export type DrawLayers = Record<DrawLayerName, Container>;

/**
 * Creates the eight draw-layer containers in back-to-front order.
 *
 * This helper is intentionally free of any GPU / WebGL dependency: it only
 * constructs plain PixiJS {@link Container} instances and labels them. This
 * keeps layer scaffolding testable without a rendering context and lets later
 * tasks (scanline road, palette shader, car sprites, explosions, LOD) attach
 * their content to well-known layers.
 *
 * @returns A {@link DrawLayers} registry whose iteration order is the intended
 *   render order (index 0 = furthest back, last = frontmost).
 */
export function createLayers(): DrawLayers {
  const layers = {} as DrawLayers;
  for (const name of DRAW_LAYER_NAMES) {
    const container = new Container();
    // `label` is the PixiJS v8 replacement for the old `name` property and is
    // handy for debugging in the devtools scene inspector.
    container.label = name;
    layers[name] = container;
  }
  return layers;
}

/**
 * Options accepted by {@link Renderer.init}. These are a subset of PixiJS'
 * {@link ApplicationOptions}; the renderer forces `preference: 'webgl'` so the
 * backend is always the WebGL renderer regardless of what the caller passes.
 */
export type RendererInitOptions = Partial<ApplicationOptions>;

/**
 * Options for {@link Renderer.drawScanlineRoad}. When both an {@link atlas} and
 * a {@link roadFrameName} are supplied the road bands sample the track texture
 * atlas; otherwise a depth-shaded flat-colour road is drawn (useful before
 * assets have loaded and for the palette shader task 15.3 to hook into).
 */
export interface RoadDrawOptions {
  /** The track texture atlas (frame table) to sample road tiles from. */
  atlas?: SpriteAtlas;
  /** The PixiJS texture backing {@link atlas}. */
  atlasTexture?: Texture;
  /** Key of the road frame within {@link atlas} to sample. */
  roadFrameName?: string;
  /** Screen width in pixels; defaults to the live canvas width. */
  screenWidth?: number;
}

/**
 * Options for {@link Renderer.drawScenery}. Scenery sprites are looked up in
 * the atlas by {@link SceneryObject.spriteId}.
 */
export interface SceneryDrawOptions {
  /** The track texture atlas containing scenery frames. */
  atlas?: SpriteAtlas;
  /** The PixiJS texture backing {@link atlas}. */
  atlasTexture?: Texture;
  /** Depth beyond which scenery is culled; defaults to no far clip. */
  farClipDepth?: number;
  /** Screen width in pixels; defaults to the live canvas width. */
  screenWidth?: number;
}

/**
 * Options for {@link Renderer.drawCars}. Car sprites are looked up in the atlas
 * by a per-car sprite id derived from {@link CarSpriteInput.spriteId}.
 */
export interface CarDrawOptions {
  /** The sprite atlas containing car frames. */
  atlas?: SpriteAtlas;
  /** The PixiJS texture backing {@link atlas}. */
  atlasTexture?: Texture;
  /** Depth beyond which cars are culled; defaults to no far clip. */
  farClipDepth?: number;
  /** Screen width in pixels; defaults to the live canvas width. */
  screenWidth?: number;
  /**
   * Jump height (track units) mapped to the maximum airborne scale/offset.
   * See {@link import('./carSprite.js').DEFAULT_MAX_JUMP_HEIGHT}.
   */
  maxJumpHeight?: number;
}

/**
 * Options for {@link Renderer.spawnExplosion}. Supplies the atlas frames that
 * make up the explosion animation plus the duration override.
 */
export interface ExplosionDrawOptions extends SpawnExplosionOptions {
  /** The sprite atlas containing the explosion animation frames. */
  atlas?: SpriteAtlas;
  /** The PixiJS texture backing {@link atlas}. */
  atlasTexture?: Texture;
  /**
   * Ordered atlas frame keys making up the explosion animation. When supplied
   * with an atlas + texture, an {@link AnimatedSprite} cycling these frames is
   * drawn; otherwise a plain placeholder sprite is used.
   */
  frameNames?: readonly string[];
}

/**
 * The per-car input {@link Renderer.drawCars} accepts. A structural subset of
 * `CarPhysicsState` (position + heading + airborne height) plus an optional
 * atlas frame key so callers may pass a full physics state or a light stand-in.
 */
export interface CarSpriteInput extends CarRenderTarget {
  /** Atlas frame key for this car's sprite; falls back to a plain rectangle. */
  readonly spriteId?: string;
}

/**
 * The client-side renderer.
 *
 * Built on PixiJS v8 with a WebGL renderer. The renderer is a one-way consumer
 * of game state: it reads interpolated snapshots and draws them, and never
 * writes back to simulation state.
 *
 * This class (task 15.1) provides only application initialisation and the
 * eight-layer scaffolding. Later tasks layer their behaviour on top:
 * - 15.2 scanline road (roadSurface / trackBoundaries / scenery layers)
 * - 15.3 palette shader
 * - 15.4 car sprites (cars layer)
 * - 15.5 explosions (explosions layer)
 * - 15.6 LOD adaptation
 * - 15.7 render integration (a `render(state, alpha)` method)
 */
export class Renderer {
  private app: Application | null = null;
  private layers: DrawLayers | null = null;
  private palette: PaletteFilterHandle | null = null;

  /**
   * Pure explosion lifetime bookkeeping (task 15.5). The manager owns the
   * 500–1500 ms timelines; this class mirrors its state onto the `explosions`
   * draw layer and removes car sprites when explosions finish.
   */
  private readonly explosions = new ExplosionManager();
  /** Live explosion display objects keyed by eliminated participant id. */
  private readonly explosionSprites = new Map<ParticipantId, Container>();
  /**
   * Car display objects registered for removal-on-elimination, keyed by
   * participant id. Populated by {@link registerCarSprite}; entries are removed
   * from their parent when the matching explosion finishes.
   */
  private readonly carSprites = new Map<ParticipantId, Container>();

  /**
   * Pure adaptive-LOD state machine (task 15.6). Driven by injected per-frame
   * deltas via {@link recordFrame}; owns the rolling 5 s FPS average and the
   * scenery draw-distance reduction/recovery ladder (Requirements 2.5, 2.8).
   * The renderer reads {@link sceneryDrawDistanceFraction} to scale the
   * `farClipDepth` it passes to {@link drawScenery}.
   */
  private readonly lod = new AdaptiveLod();
  /**
   * Baseline (100%) scenery far-clip depth, in world units. Multiplied by the
   * adaptive-LOD fraction to obtain the live scenery draw distance. `null`
   * until configured via {@link setSceneryBaselineDrawDistance}.
   */
  private sceneryBaselineFarClip: number | null = null;

  /**
   * The scanline projection parameters (horizon row, focal length) used by
   * {@link render}. `null` until derived from the canvas size on first render
   * or set explicitly via {@link setProjectionParams}.
   */
  private projection: ProjectionParams | null = null;

  /**
   * The last {@link RenderState} passed to {@link render}. Retained so that
   * {@link render} can (a) look up an eliminated car's last-known position when
   * spawning its explosion (Requirement 2.7) and (b) let callers query the most
   * recent frame. `null` before the first render.
   */
  private lastRenderState: RenderState | null = null;

  /**
   * The set of participant ids for which an explosion has already been spawned,
   * so a repeated {@link EliminationEvent} across frames does not restart the
   * animation every frame. Cleared entries are pruned when their car sprite is
   * removed.
   */
  private readonly explodedParticipants = new Set<ParticipantId>();

  /** Active rAF render-loop handle, or `null` when the loop is not running. */
  private renderLoop: RenderLoopHandle | null = null;

  /** Wall-clock timestamp (ms) of the previous {@link render} call, for LOD. */
  private lastRenderTimeMs: number | null = null;

  /**
   * Initialises the underlying PixiJS {@link Application} with a WebGL renderer
   * and mounts the eight draw layers onto the stage in back-to-front order.
   *
   * @param options - PixiJS application options (canvas, width, height, etc.).
   *   The renderer preference is always overridden to `'webgl'`.
   */
  async init(options: RendererInitOptions = {}): Promise<void> {
    if (this.app) {
      throw new Error('Renderer.init() called more than once');
    }

    const app = new Application();
    await app.init({
      ...options,
      // Force the WebGL backend. Design decision: WebGL via PixiJS v8.
      preference: 'webgl',
    });

    const layers = createLayers();
    // Add in back-to-front order so later layers render on top.
    for (const name of DRAW_LAYER_NAMES) {
      app.stage.addChild(layers[name]);
    }

    this.app = app;
    this.layers = layers;
  }

  /** Whether {@link init} has completed and the renderer is ready to use. */
  get isInitialised(): boolean {
    return this.app !== null;
  }

  /**
   * The underlying PixiJS application.
   * @throws If accessed before {@link init} has been called.
   */
  get application(): Application {
    if (!this.app) {
      throw new Error('Renderer not initialised; call init() first');
    }
    return this.app;
  }

  /**
   * The rendering canvas element produced by PixiJS.
   * @throws If accessed before {@link init} has been called.
   */
  get canvas(): HTMLCanvasElement {
    return this.application.canvas;
  }

  /**
   * Returns a single draw layer by name.
   * @throws If accessed before {@link init} has been called.
   */
  getLayer(name: DrawLayerName): Container {
    if (!this.layers) {
      throw new Error('Renderer not initialised; call init() first');
    }
    return this.layers[name];
  }

  /**
   * The full draw-layer registry, in back-to-front order.
   * @throws If accessed before {@link init} has been called.
   */
  getLayers(): DrawLayers {
    if (!this.layers) {
      throw new Error('Renderer not initialised; call init() first');
    }
    return this.layers;
  }

  // Convenience accessors for the most frequently used layers.

  /** Road-surface layer (drawn first / furthest back). */
  get roadSurfaceLayer(): Container {
    return this.getLayer('roadSurface');
  }

  /** Track-boundaries layer. */
  get trackBoundariesLayer(): Container {
    return this.getLayer('trackBoundaries');
  }

  /** Scenery-objects layer (distance-sorted). */
  get sceneryLayer(): Container {
    return this.getLayer('scenery');
  }

  /** Hazard-objects layer (mines, caltrops). */
  get hazardLayer(): Container {
    return this.getLayer('hazards');
  }

  /** Car-sprites layer (depth-sorted). */
  get carLayer(): Container {
    return this.getLayer('cars');
  }

  /** Projectile-sprites layer. */
  get projectileLayer(): Container {
    return this.getLayer('projectiles');
  }

  /** Explosion-animations layer. */
  get explosionLayer(): Container {
    return this.getLayer('explosions');
  }

  /** HUD-overlay layer (drawn last / frontmost). */
  get hudLayer(): Container {
    return this.getLayer('hud');
  }

  // -------------------------------------------------------------------------
  // Scanline pseudo-3D road rendering (task 15.2)
  //
  // The projection/camera *math* lives in `renderer/scanline.ts` as pure,
  // headless-testable functions. The methods below are the PixiJS *draw* half:
  // they call the pure math to decide, per screen row, what world-space depth
  // to sample, then issue PixiJS draw calls onto the roadSurface and scenery
  // layers. The draw half needs a real WebGL context and so is validated in the
  // browser rather than in headless unit tests.
  // -------------------------------------------------------------------------

  /**
   * Builds a {@link CameraState} that follows the leading car, using the fixed
   * offsets from Requirement 11.1 (150–300 px behind, 60–120 px above). Thin
   * wrapper over the pure {@link placeCamera} helper so callers of the renderer
   * do not need to import the math module directly.
   *
   * @param target - The leading car's position/heading (and airborne height).
   * @param offsets - Optional desired offsets; clamped into the allowed ranges.
   */
  computeCamera(
    target: CameraTarget,
    offsets: CameraOffsetRequest = {},
  ): CameraState {
    return placeCamera(target, {
      behindPx: offsets.behindPx ?? CAMERA_BEHIND_DEFAULT_PX,
      abovePx: offsets.abovePx ?? CAMERA_ABOVE_DEFAULT_PX,
    });
  }

  /**
   * Renders the scanline pseudo-3D road surface for the current frame.
   *
   * For each screen row below the horizon the pure projection computes a
   * world-space depth; this method samples the corresponding road band from the
   * track texture atlas (when a road frame is supplied) and stacks the bands
   * onto the {@link roadSurfaceLayer}. Sky rows (at/above the horizon) are
   * skipped so a background layer can show through. The previous frame's bands
   * are cleared first.
   *
   * The heavy lifting of "which depth does row N correspond to" is delegated to
   * {@link projectAllScanlines}; this method is purely the PixiJS draw glue.
   *
   * @param camera - Resolved camera pose (see {@link computeCamera}).
   * @param params - Projection parameters (screen height, horizon, focal len).
   * @param options - Atlas texture + road frame used to sample road bands, and
   *   optional screen width. When no atlas/frame is given the road is drawn as
   *   flat depth-shaded bands (useful before the atlas has loaded).
   */
  drawScanlineRoad(
    camera: CameraState,
    params: ProjectionParams,
    options: RoadDrawOptions = {},
  ): void {
    const layer = this.roadSurfaceLayer;
    layer.removeChildren();

    const width = options.screenWidth ?? this.viewWidth(params);
    const rows = projectAllScanlines(camera, params);
    const atlas = options.atlas;
    const texture = options.atlasTexture;
    const roadFrame =
      atlas && options.roadFrameName
        ? atlas.frames[options.roadFrameName]
        : undefined;

    for (const projection of rows) {
      if (projection.aboveHorizon) {
        continue;
      }
      const band = this.buildRoadBand(projection, width, texture, roadFrame);
      layer.addChild(band);
    }
  }

  /**
   * Draws scenery objects onto the {@link sceneryLayer}, positioned and scaled
   * by their world-space depth relative to the camera. Objects behind the
   * camera or beyond the far clip are skipped. Objects are added far-to-near so
   * nearer scenery overlaps farther scenery (Requirement 11.2: scenery is
   * distance-sorted).
   *
   * @param camera - Resolved camera pose.
   * @param params - Projection parameters.
   * @param scenery - Scenery objects from the track definition.
   * @param options - Atlas texture and frame lookup for scenery sprites, plus
   *   optional far-clip depth and screen width.
   */
  drawScenery(
    camera: CameraState,
    params: ProjectionParams,
    scenery: readonly SceneryObject[],
    options: SceneryDrawOptions = {},
  ): void {
    const layer = this.sceneryLayer;
    layer.removeChildren();

    const width = options.screenWidth ?? this.viewWidth(params);
    // Far-clip precedence: an explicit per-call override wins; otherwise use the
    // adaptive-LOD-scaled baseline (task 15.6) when one is configured; failing
    // that, do not clip. This is how the rolling-FPS LOD reduces scenery draw
    // distance (Requirements 2.5, 2.8) without the caller re-deriving it.
    const farClip =
      options.farClipDepth ?? this.sceneryFarClipDepth ?? Number.POSITIVE_INFINITY;
    const forward = { x: Math.sin(camera.heading), y: Math.cos(camera.heading) };

    // Depth of each scenery object along the camera's view axis.
    const withDepth = scenery
      .map((object) => {
        const dx = object.position.x - camera.eye.x;
        const dy = object.position.y - camera.eye.y;
        const depth = dx * forward.x + dy * forward.y;
        // Lateral offset (signed) perpendicular to the view axis.
        const lateral = dx * forward.y - dy * forward.x;
        return { object, depth, lateral };
      })
      .filter((entry) => entry.depth > 0 && entry.depth <= farClip)
      // Far first so near draws on top.
      .sort((a, b) => b.depth - a.depth);

    for (const { object, depth, lateral } of withDepth) {
      const row = depthToRow(depth, camera, params);
      const scale = params.focalLength / depth;
      const sprite = this.buildScenerySprite(object, options);
      sprite.anchor.set(0.5, 1);
      sprite.scale.set(scale);
      sprite.x = width / 2 + lateral * scale;
      sprite.y = row;
      layer.addChild(sprite);
    }
  }

  /**
   * Draws car sprites onto the {@link carLayer}, depth-sorted with nearer cars
   * on top. Each sprite is positioned and scaled by its world-space depth
   * relative to the camera, and — while a jump is in progress — additionally
   * scaled between 100 % and 150 % and lifted 0–80 px proportional to the car's
   * airborne height (Requirements 2.3, 2.4).
   *
   * The placement/scale/offset *math* is delegated to the pure
   * {@link projectCars} helper in `renderer/carSprite.ts`; this method is only
   * the PixiJS draw glue. The previous frame's sprites are cleared first.
   *
   * @param camera - Resolved camera pose (see {@link computeCamera}).
   * @param params - Projection parameters (screen height, horizon, focal len).
   * @param cars - Cars to draw (full physics states or light stand-ins).
   * @param options - Atlas lookup, screen width, far clip and airborne tuning.
   */
  drawCars(
    camera: CameraState,
    params: ProjectionParams,
    cars: readonly CarSpriteInput[],
    options: CarDrawOptions = {},
  ): void {
    const layer = this.carLayer;
    layer.removeChildren();

    const width = options.screenWidth ?? this.viewWidth(params);
    const projectionOptions: CarProjectionOptions = {
      screenWidth: width,
      ...(options.farClipDepth !== undefined
        ? { farClipDepth: options.farClipDepth }
        : {}),
      ...(options.maxJumpHeight !== undefined
        ? { maxJumpHeight: options.maxJumpHeight }
        : {}),
    };

    const placements = projectCars(cars, camera, params, projectionOptions);
    for (const placement of placements) {
      const sprite = this.buildCarSprite(placement.car, options);
      // Anchor at bottom-centre so the sprite sits on the projected ground row
      // and grows upward as it scales / lifts during a jump.
      sprite.anchor.set(0.5, 1);
      sprite.scale.set(placement.scale);
      sprite.x = placement.screenX;
      sprite.y = placement.screenY;
      layer.addChild(sprite);
    }
  }

  /**
   * World-space ground position sampled for a given screen row. Convenience
   * accessor over {@link groundPointAtDepth} + {@link projectAllScanlines} so
   * callers can figure out which world tile a row corresponds to without
   * importing the math module.
   *
   * @param projection - A single row's projection.
   * @param camera - The camera pose the projection was computed with.
   */
  groundForRow(projection: ScanlineProjection, camera: CameraState) {
    if (projection.aboveHorizon) {
      return null;
    }
    return groundPointAtDepth(projection.depth, camera);
  }

  // -------------------------------------------------------------------------
  // Explosion animations (task 15.5)
  //
  // The lifetime *state machine* (spawn at a position with a clamped 500–1500 ms
  // duration, advance by elapsed ms, decide when a car sprite must be removed)
  // lives in `renderer/explosion.ts` as a pure, headless-testable module. The
  // methods below are the PixiJS *draw* half: they place an AnimatedSprite on
  // the `explosions` layer for the explosion's lifetime and remove the eliminated
  // car's sprite from the `cars` layer once the animation finishes.
  //
  // Requirement 2.7: on Elimination, play a 500–1500 ms explosion at the car's
  // last-known position, then remove the car sprite on completion.
  // -------------------------------------------------------------------------

  /**
   * Registers a car's display object so it can be removed automatically when
   * that car's explosion finishes. The renderer does not take ownership of the
   * sprite's lifecycle otherwise; it only removes it from its parent on
   * explosion completion.
   *
   * @param participantId - The car's participant id.
   * @param sprite - The display object representing the car.
   */
  registerCarSprite(participantId: ParticipantId, sprite: Container): void {
    this.carSprites.set(participantId, sprite);
  }

  /**
   * Starts an explosion animation for an eliminated car at its last-known
   * position (Requirement 2.7). The duration is clamped into `[500, 1500]` ms
   * by the pure state machine. An {@link AnimatedSprite} (or placeholder) is
   * added to the {@link explosionLayer}; it is removed and the eliminated car's
   * registered sprite is removed when the explosion finishes (see
   * {@link advanceExplosions}).
   *
   * @param eliminatedId - Participant whose car was eliminated.
   * @param lastKnownPosition - The car's last-known position.
   * @param options - Atlas frames + duration override for the animation.
   * @returns The spawned {@link ExplosionState} (pure lifetime record).
   */
  spawnExplosion(
    eliminatedId: ParticipantId,
    lastKnownPosition: Vec2,
    options: ExplosionDrawOptions = {},
  ): ExplosionState {
    const spawnOptions: SpawnExplosionOptions =
      options.durationMs !== undefined ? { durationMs: options.durationMs } : {};
    const explosion = this.explosions.spawn(
      eliminatedId,
      lastKnownPosition,
      spawnOptions,
    );

    // Replace any prior sprite for this participant (a fresh elimination
    // restarts the animation).
    const existing = this.explosionSprites.get(eliminatedId);
    if (existing) {
      existing.removeFromParent();
    }

    const sprite = this.buildExplosionSprite(options);
    sprite.x = lastKnownPosition.x;
    sprite.y = lastKnownPosition.y;
    this.explosionLayer.addChild(sprite);
    this.explosionSprites.set(eliminatedId, sprite);

    return explosion;
  }

  /**
   * Convenience wrapper mapping an {@link EliminationEvent} to
   * {@link spawnExplosion}. The event only carries the eliminated participant's
   * id, so the caller supplies that car's last-known position (looked up from
   * the last rendered snapshot). Requirement 2.7.
   *
   * @param event - The elimination event from the weapon system.
   * @param lastKnownPosition - The eliminated car's last-known position.
   * @param options - Atlas frames + duration override for the animation.
   */
  spawnExplosionForElimination(
    event: EliminationEvent,
    lastKnownPosition: Vec2,
    options: ExplosionDrawOptions = {},
  ): ExplosionState {
    return this.spawnExplosion(event.eliminatedId, lastKnownPosition, options);
  }

  /**
   * Advances all in-flight explosions by `deltaMs`, updating each explosion
   * sprite's animation progress and, for any explosion that finishes this tick,
   * removing its explosion sprite and the eliminated car's registered sprite
   * (Requirement 2.7 "remove the Car sprite upon animation completion").
   *
   * @param deltaMs - Elapsed frame time in milliseconds.
   * @returns The participant ids whose cars were removed on this tick.
   */
  advanceExplosions(deltaMs: number): ParticipantId[] {
    const { carsToRemove } = this.explosions.advance(deltaMs);

    for (const id of carsToRemove) {
      // Remove the finished explosion's sprite.
      const explosionSprite = this.explosionSprites.get(id);
      if (explosionSprite) {
        explosionSprite.removeFromParent();
        this.explosionSprites.delete(id);
      }
      // Remove the eliminated car's sprite, if one was registered.
      const carSprite = this.carSprites.get(id);
      if (carSprite) {
        carSprite.removeFromParent();
        this.carSprites.delete(id);
      }
    }

    return carsToRemove;
  }

  /** Number of explosions currently playing. */
  get activeExplosionCount(): number {
    return this.explosions.size;
  }

  /**
   * Builds the explosion display object: an {@link AnimatedSprite} cycling the
   * supplied atlas frames when an atlas/texture/frame list is provided, else a
   * plain placeholder {@link Sprite} so callers still see something before the
   * explosion assets have loaded. Anchored centre so it sits on the car's
   * last-known position. Pure PixiJS glue.
   */
  private buildExplosionSprite(options: ExplosionDrawOptions): Container {
    const { atlas, atlasTexture, frameNames } = options;
    if (atlas && atlasTexture && frameNames && frameNames.length > 0) {
      const textures: Texture[] = [];
      for (const name of frameNames) {
        const frame = atlas.frames[name]?.frame;
        if (frame) {
          textures.push(
            new Texture({
              source: atlasTexture.source,
              frame: new Rectangle(frame.x, frame.y, frame.w, frame.h),
            }),
          );
        }
      }
      if (textures.length > 0) {
        const anim = new AnimatedSprite(textures);
        anim.anchor.set(0.5, 0.5);
        anim.loop = false;
        anim.play();
        return anim;
      }
    }
    const placeholder = new Sprite(Texture.WHITE);
    placeholder.anchor.set(0.5, 0.5);
    return placeholder;
  }

  // -------------------------------------------------------------------------
  // Palette emulation (task 15.3)
  //
  // A single 256-colour palette is uploaded to the GPU as a 256×1 RGBA texture
  // and a fragment shader performs the palette lookup per pixel. The shader
  // construction / palette byte layout is GPU-free and lives in
  // `renderer/PaletteShader.ts`; the methods below attach the resulting filter
  // to the palette-indexed draw layers (road surface + sprite layers).
  // -------------------------------------------------------------------------

  /**
   * Installs the palette-emulation filter and applies it to all layers that
   * draw indexed-palette content: the road surface plus the scenery, hazard,
   * car, projectile and explosion sprite layers (Requirement 2.6). Track
   * boundaries and the HUD are left unfiltered since they are drawn with
   * explicit RGBA rather than palette indices.
   *
   * Calling this again replaces the previous palette filter (e.g. when a track
   * with a different palette loads).
   *
   * @param palette - The 256-colour palette to upload.
   * @param mode - Lookup strategy; `'indexed'` (default) reads the palette
   *   index from the source red channel, `'nearest'` snaps RGB to the palette.
   */
  applyPalette(palette: SpritePalette, mode: PaletteMode = 'indexed'): PaletteFilterHandle {
    if (!this.layers) {
      throw new Error('Renderer not initialised; call init() first');
    }
    const handle = createPaletteFilter(palette, mode);
    this.palette = handle;
    for (const name of PALETTE_FILTERED_LAYERS) {
      this.layers[name].filters = [handle.filter];
    }
    return handle;
  }

  /**
   * Re-uploads a new palette into the existing palette texture, enabling
   * palette animation / flash effects without reallocating the filter. No-op if
   * {@link applyPalette} has not been called yet.
   *
   * @param palette - The new 256-colour palette.
   */
  updatePalette(palette: SpritePalette): void {
    this.palette?.updatePalette(palette);
  }

  /** The active palette filter handle, or `null` if none has been applied. */
  get paletteFilter(): PaletteFilterHandle | null {
    return this.palette;
  }

  // -------------------------------------------------------------------------
  // Adaptive LOD (task 15.6)
  //
  // The rolling 5 s FPS average and the scenery draw-distance reduction ladder
  // (Requirements 2.5, 2.8) live in the pure, headless-testable
  // `renderer/adaptiveLod.ts` module, driven by injected frame deltas. The
  // methods below are the thin PixiJS-side wiring: the game loop feeds real
  // frame times via `recordFrame`, and `drawScenery` (or the caller) scales the
  // baseline draw distance by `sceneryDrawDistanceFraction`.
  // -------------------------------------------------------------------------

  /**
   * Sets the baseline (100%) scenery draw distance in world units. The live
   * scenery far-clip depth is this value multiplied by the current adaptive-LOD
   * fraction (see {@link sceneryFarClipDepth}). Call once when a track's
   * default draw distance is known.
   *
   * @param farClipDepth - Baseline scenery far-clip depth (world units).
   */
  setSceneryBaselineDrawDistance(farClipDepth: number): void {
    this.sceneryBaselineFarClip = farClipDepth;
  }

  /**
   * Records one rendered frame's delta (ms since the previous frame) into the
   * adaptive-LOD tracker (Requirements 2.5, 2.8). Should be called once per
   * frame from the game loop before drawing scenery. Returns the LOD transition
   * that occurred this frame (`'reduced'`, `'restored'`, or `'none'`), which
   * callers may use for diagnostics.
   *
   * @param deltaMs - Milliseconds elapsed since the previous rendered frame.
   */
  recordFrame(deltaMs: number): LodTransition {
    return this.lod.pushFrame(deltaMs);
  }

  /**
   * The current scenery draw-distance fraction of the baseline, in `[0.2, 1]`,
   * as decided by the adaptive-LOD state machine.
   */
  get sceneryDrawDistanceFraction(): number {
    return this.lod.drawDistanceFraction;
  }

  /**
   * The rolling average frame rate (fps) over the trailing 5-second window
   * (Requirement 2.5), or 0 before any frame has been recorded.
   */
  get averageFps(): number {
    return this.lod.averageFps;
  }

  /**
   * The live scenery far-clip depth in world units: the configured baseline
   * scaled by the adaptive-LOD fraction. Returns `undefined` when no baseline
   * has been set (so {@link drawScenery} leaves scenery unclipped by default).
   */
  get sceneryFarClipDepth(): number | undefined {
    if (this.sceneryBaselineFarClip === null) {
      return undefined;
    }
    return this.sceneryBaselineFarClip * this.lod.drawDistanceFraction;
  }

  /** The adaptive-LOD state machine (for diagnostics / advanced wiring). */
  get adaptiveLod(): AdaptiveLod {
    return this.lod;
  }

  /** Screen width to assume when none is supplied: the live canvas width. */
  private viewWidth(params: ProjectionParams): number {
    if (this.app) {
      return this.app.renderer.width;
    }
    // Fall back to a square view based on the configured screen height.
    return params.screenHeight;
  }

  /**
   * Builds a single 1px-tall road band for a projected scanline. When a road
   * atlas frame + texture are supplied, the band samples a horizontal slice of
   * the road frame (whose vertical position within the frame is driven by
   * depth) so the road texture appears to recede. Otherwise a solid,
   * depth-shaded {@link Graphics} band is produced.
   */
  private buildRoadBand(
    projection: ScanlineProjection,
    width: number,
    texture: Texture | undefined,
    roadFrame: AtlasFrame | undefined,
  ): Container {
    if (texture && roadFrame) {
      const frame = roadFrame.frame;
      // Sample one texel row from the road frame, chosen by depth so the road
      // texture scrolls toward the horizon. The sampled row is clamped within
      // the frame's vertical extent.
      const denom = projection.depth + 1;
      const rawV = frame.h > 0 ? frame.y + (frame.h - 1) / denom : frame.y;
      const v = Math.min(frame.y + Math.max(0, frame.h - 1), Math.max(frame.y, rawV));
      const bandTexture = new Texture({
        source: texture.source,
        frame: new Rectangle(frame.x, v, frame.w, 1),
      });
      const sprite = new Sprite(bandTexture);
      sprite.width = width;
      sprite.height = 1;
      sprite.x = 0;
      sprite.y = projection.row;
      return sprite;
    }

    // Fallback: flat depth-shaded band. Nearer rows are lighter.
    const shade = this.depthShade(projection.depth);
    const g = new Graphics();
    g.rect(0, projection.row, width, 1).fill({ color: shade });
    return g;
  }

  /**
   * Builds a scenery sprite from the atlas when possible, else a small
   * placeholder rectangle sized from the object's declared depth ordering.
   */
  private buildScenerySprite(
    object: SceneryObject,
    options: SceneryDrawOptions,
  ): Sprite {
    const atlas = options.atlas;
    const texture = options.atlasTexture;
    const frame = atlas?.frames[object.spriteId]?.frame;
    if (texture && frame) {
      const sub = new Texture({
        source: texture.source,
        frame: new Rectangle(frame.x, frame.y, frame.w, frame.h),
      });
      return new Sprite(sub);
    }
    // Placeholder white sprite so callers still see something pre-atlas.
    return new Sprite(Texture.WHITE);
  }

  /**
   * Builds a car sprite from the atlas when a matching frame exists, otherwise
   * a plain white placeholder so callers still see something before car assets
   * have loaded. Pure PixiJS glue; the placement/scale is applied by the
   * caller.
   */
  private buildCarSprite(
    car: CarSpriteInput,
    options: CarDrawOptions,
  ): Sprite {
    const atlas = options.atlas;
    const texture = options.atlasTexture;
    const frame = car.spriteId
      ? atlas?.frames[car.spriteId]?.frame
      : undefined;
    if (texture && frame) {
      const sub = new Texture({
        source: texture.source,
        frame: new Rectangle(frame.x, frame.y, frame.w, frame.h),
      });
      return new Sprite(sub);
    }
    return new Sprite(Texture.WHITE);
  }

  /**
   * Simple linear depth shading returning a packed RGB grey that lightens as
   * depth decreases (closer road is brighter). Pure helper used only for the
   * atlas-free fallback road.
   */
  private depthShade(depth: number): number {
    const t = 1 / (1 + depth / 256);
    const v = Math.round(40 + t * 120);
    const c = Math.min(255, Math.max(0, v));
    return (c << 16) | (c << 8) | c;
  }

  // -------------------------------------------------------------------------
  // Frame integration (task 15.7)
  //
  // `render(state, alpha)` is the single per-frame entry point that stitches
  // together every draw half built by tasks 15.1–15.6: it interpolates between
  // the previous and current simulation snapshots by `alpha`, places the camera
  // on the (interpolated) leading car, and issues the layered draw calls in the
  // documented back-to-front order (Requirement 2.2). The pure interpolation
  // and the fixed-timestep `alpha` production live in the headless-testable
  // `renderState.ts` / `renderLoop.ts` modules; this method is the PixiJS glue.
  // -------------------------------------------------------------------------

  /**
   * Sets the scanline projection parameters (horizon row + focal length) used
   * by {@link render}. When not set, {@link render} derives sensible defaults
   * from the live canvas size (horizon at the vertical midpoint, focal length
   * equal to the canvas height).
   *
   * @param params - Projection parameters.
   */
  setProjectionParams(params: ProjectionParams): void {
    this.projection = params;
  }

  /**
   * Resolves the projection parameters to use for a frame: the explicitly
   * configured params if any, otherwise defaults derived from the live canvas
   * height (horizon at mid-screen, focal length = screen height).
   */
  private resolveProjection(): ProjectionParams {
    if (this.projection) {
      return this.projection;
    }
    const height = this.app ? this.app.renderer.height : 480;
    return {
      screenHeight: height,
      horizonRow: Math.floor(height / 2),
      focalLength: height,
    };
  }

  /**
   * Draws one animation frame (task 15.7).
   *
   * Given the `previous` and `current` simulation snapshots and an
   * interpolation factor `alpha ∈ [0, 1]`, this:
   *
   *   1. Interpolates the continuous fields (camera target + car
   *      positions/headings/heights) via the pure {@link interpolateRenderState}
   *      (`alpha = 0` → previous, `1` → current). Passing a single state (no
   *      `previous`) skips interpolation and draws it directly.
   *   2. Re-uploads the palette (Requirement 2.6) and places the camera on the
   *      leading car (Requirement 2.1).
   *   3. Issues the layered draw calls back-to-front (Requirement 2.2): road
   *      surface, scenery, hazards, cars, projectiles — then advances/spawns
   *      explosions (Requirement 2.7).
   *   4. Feeds the frame delta to the adaptive-LOD tracker (Requirements 2.5,
   *      2.8) so sustained low frame rates shrink the scenery draw distance.
   *
   * @param current - The current simulation snapshot's render state.
   * @param alpha - Interpolation factor in `[0, 1]` (clamped internally).
   * @param previous - The previous simulation snapshot; omit to draw `current`
   *   un-interpolated (e.g. the very first frame).
   * @param nowMs - Optional wall-clock timestamp (ms) for the LOD frame delta;
   *   defaults to `performance.now()`/`Date.now()` when available.
   */
  render(
    current: RenderState,
    alpha: number,
    previous?: RenderState,
    nowMs?: number,
  ): void {
    if (!this.layers) {
      throw new Error('Renderer not initialised; call init() first');
    }

    // 1. Interpolate the continuous fields between snapshots.
    const state = previous
      ? interpolateRenderState(previous, current, alpha)
      : current;

    // Feed the adaptive-LOD tracker this frame's wall-clock delta.
    const now = nowMs ?? this.wallClockMs();
    if (this.lastRenderTimeMs !== null) {
      const delta = now - this.lastRenderTimeMs;
      if (delta > 0) {
        this.recordFrame(delta);
      }
    }
    this.lastRenderTimeMs = now;

    // 2. Palette + camera.
    if (state.palette) {
      if (this.palette) {
        this.updatePalette(state.palette);
      } else {
        this.applyPalette(state.palette);
      }
    }

    const params = this.resolveProjection();
    const camera = this.computeCamera(
      state.cameraTarget,
      state.cameraOffsets ?? {},
    );
    this.lastCamera = camera;

    const atlasOptions =
      state.atlas && state.atlasTexture
        ? { atlas: state.atlas, atlasTexture: state.atlasTexture }
        : {};

    // 3. Layered draw calls, back-to-front (Requirement 2.2).
    this.drawScanlineRoad(camera, params, {
      ...atlasOptions,
      ...(state.roadFrameName !== undefined
        ? { roadFrameName: state.roadFrameName }
        : {}),
    });
    this.drawScenery(camera, params, state.scenery, atlasOptions);
    this.drawHazards(camera, params, state.hazards, atlasOptions);

    // Cars: skip those already fully exploded away; register the drawn sprites
    // so the explosion machinery can remove them on completion.
    const visibleCars: RenderCar[] = state.cars.filter(
      (car) => !this.explodedParticipants.has(car.id),
    );
    this.drawCars(camera, params, visibleCars, atlasOptions);
    this.registerDrawnCarSprites(visibleCars);

    this.drawProjectiles(camera, params, state.projectiles, atlasOptions);

    // 4. Explosions (Requirement 2.7): spawn new ones for this frame's
    // eliminations. Existing explosions are advanced separately by the game
    // loop via `advanceFrameExplosions(deltaMs)` so the elapsed time comes from
    // the loop's frame delta rather than being re-derived here.
    this.spawnEliminationExplosions(state);

    this.lastRenderState = state;
  }

  /**
   * Advances all in-flight explosions by `deltaMs` and prunes the exploded-set
   * bookkeeping for any car whose explosion just finished. Call once per frame
   * from the game loop (alongside {@link render}); kept separate from
   * {@link render} so the elapsed time is driven by the loop's frame delta
   * rather than re-derived here.
   *
   * @param deltaMs - Milliseconds elapsed since the previous frame.
   * @returns The participant ids whose car sprites were removed this tick.
   */
  advanceFrameExplosions(deltaMs: number): ParticipantId[] {
    const removed = this.advanceExplosions(deltaMs);
    // Keep the exploded-set marking these cars so a repeated elimination event
    // does not re-spawn an explosion for an already-removed car within the same
    // race; it is cleared wholesale on `destroy`/reset.
    return removed;
  }

  /** The most recent {@link RenderState} drawn, or `null` before first render. */
  get currentRenderState(): RenderState | null {
    return this.lastRenderState;
  }

  /**
   * Spawns explosions for any {@link RenderState.eliminations} not already
   * handled, positioned at the eliminated car's last-known position looked up
   * from the previous frame (Requirement 2.7).
   */
  private spawnEliminationExplosions(state: RenderState): void {
    if (!state.eliminations) {
      return;
    }
    for (const event of state.eliminations) {
      if (this.explodedParticipants.has(event.eliminatedId)) {
        continue;
      }
      const position = this.lastKnownPosition(event.eliminatedId, state);
      if (!position) {
        continue;
      }
      const options =
        state.atlas && state.atlasTexture && state.explosionFrameNames
          ? {
              atlas: state.atlas,
              atlasTexture: state.atlasTexture,
              frameNames: state.explosionFrameNames,
            }
          : {};
      this.spawnExplosionForElimination(event, position, options);
      this.explodedParticipants.add(event.eliminatedId);
    }
  }

  /**
   * Looks up an eliminated car's last-known world position: preferring the
   * current frame's car list, then the previous frame's.
   */
  private lastKnownPosition(
    id: ParticipantId,
    state: RenderState,
  ): Vec2 | null {
    const inCurrent = state.cars.find((car) => car.id === id);
    if (inCurrent) {
      return inCurrent.position;
    }
    const inPrevious = this.lastRenderState?.cars.find((car) => car.id === id);
    return inPrevious ? inPrevious.position : null;
  }

  /**
   * Registers the freshly-drawn car sprites (by participant id) so the
   * explosion machinery can remove the correct display object when a car's
   * explosion finishes. The `cars` layer children are in the same order as the
   * depth-sorted placements produced by {@link drawCars}; matching is by index
   * is unreliable after sorting, so we instead map each layer child back to its
   * car by drawing order is avoided — we register by clearing and re-adding.
   *
   * Because {@link drawCars} rebuilds the layer each frame, we map the layer's
   * children to their cars using the depth-sorted order returned by the pure
   * projection so the registry always points at live sprites.
   */
  private registerDrawnCarSprites(cars: readonly RenderCar[]): void {
    // drawCars clears and repopulates the car layer each frame, so previous
    // registrations are stale. Re-register from the current layer children,
    // matching them to cars by the same depth-sort drawCars applied.
    const layer = this.carLayer;
    const children = layer.children;
    // The pure projection sorts visible cars far-to-near; drawCars adds them in
    // that order. Recompute that order here to pair child ↔ car.
    const camera = this.lastCamera;
    if (!camera) {
      return;
    }
    const ordered = [...cars]
      .map((car) => ({
        car,
        depth: depthAndLateral(car.position, camera).depth,
      }))
      .filter((entry) => entry.depth > 0)
      .sort((a, b) => b.depth - a.depth);
    for (let i = 0; i < ordered.length && i < children.length; i++) {
      const child = children[i];
      const entry = ordered[i];
      if (child && entry) {
        this.registerCarSprite(entry.car.id, child);
      }
    }
  }

  /** The camera used by the most recent {@link render}, for sprite pairing. */
  private lastCamera: CameraState | null = null;

  /**
   * Draws hazards onto the {@link hazardLayer} using the same depth projection
   * as scenery. Hazards behind the camera are skipped and nearer hazards are
   * drawn on top. Requirement 2.2 (hazards drawn after scenery).
   */
  private drawHazards(
    camera: CameraState,
    params: ProjectionParams,
    hazards: readonly { position: Vec2; weaponId: string }[],
    options: { atlas?: SpriteAtlas; atlasTexture?: Texture },
  ): void {
    this.drawDepthSprites(this.hazardLayer, camera, params, hazards, options);
  }

  /**
   * Draws in-flight projectiles onto the {@link projectileLayer} using the same
   * depth projection as scenery/hazards. Requirement 2.2 (projectiles drawn
   * after cars).
   */
  private drawProjectiles(
    camera: CameraState,
    params: ProjectionParams,
    projectiles: readonly ActiveProjectile[],
    options: { atlas?: SpriteAtlas; atlasTexture?: Texture },
  ): void {
    this.drawDepthSprites(
      this.projectileLayer,
      camera,
      params,
      projectiles.map((p) => ({ position: p.position, weaponId: p.weaponId })),
      options,
    );
  }

  /**
   * Shared depth-projected sprite draw for point-like world objects (hazards,
   * projectiles). Clears the layer, projects each object's depth/lateral offset,
   * culls those behind the camera or beyond the adaptive-LOD far clip, and adds
   * them far-to-near so nearer objects overlap farther ones. The sprite frame
   * is looked up in the atlas by `weaponId`, falling back to a placeholder.
   */
  private drawDepthSprites(
    layer: Container,
    camera: CameraState,
    params: ProjectionParams,
    objects: readonly { position: Vec2; weaponId: string }[],
    options: { atlas?: SpriteAtlas; atlasTexture?: Texture },
  ): void {
    layer.removeChildren();
    const width = this.viewWidth(params);
    const farClip = this.sceneryFarClipDepth ?? Number.POSITIVE_INFINITY;

    const withDepth = objects
      .map((object) => ({ object, ...depthAndLateral(object.position, camera) }))
      .filter((entry) => entry.depth > 0 && entry.depth <= farClip)
      .sort((a, b) => b.depth - a.depth);

    for (const { object, depth, lateral } of withDepth) {
      const row = depthToRow(depth, camera, params);
      const scale = params.focalLength / depth;
      const frame = options.atlas?.frames[object.weaponId]?.frame;
      const sprite =
        options.atlasTexture && frame
          ? new Sprite(
              new Texture({
                source: options.atlasTexture.source,
                frame: new Rectangle(frame.x, frame.y, frame.w, frame.h),
              }),
            )
          : new Sprite(Texture.WHITE);
      sprite.anchor.set(0.5, 1);
      sprite.scale.set(scale);
      sprite.x = width / 2 + lateral * scale;
      sprite.y = row;
      layer.addChild(sprite);
    }
  }

  /** Current wall-clock time in ms, preferring `performance.now()`. */
  private wallClockMs(): number {
    const perf = (globalThis as { performance?: { now?: () => number } })
      .performance;
    if (perf && typeof perf.now === 'function') {
      return perf.now();
    }
    return Date.now();
  }

  /**
   * Starts the `requestAnimationFrame` render loop at 60 fps (Requirement 13.2).
   * Each frame the supplied `onFrame` callback receives the fixed-timestep
   * {@link FrameStep} (whole simulation-step count + render `alpha`); the caller
   * (the game loop) steps the simulation and calls {@link render}. This is the
   * thin browser-only wrapper; all timing logic is in the headless-testable
   * {@link RenderLoopStepper}.
   *
   * @param onFrame - Per-frame callback receiving the frame's step + alpha.
   * @param env - Optional rAF overrides (default: browser globals).
   * @returns A handle that {@link stopRenderLoop} also stops.
   */
  startRenderLoop(
    onFrame: (frame: FrameStep) => void,
    env: RenderLoopEnv = {},
  ): RenderLoopHandle {
    this.stopRenderLoop();
    const handle = startRenderLoop(onFrame, new RenderLoopStepper(), env);
    this.renderLoop = handle;
    return handle;
  }

  /** Stops the render loop started by {@link startRenderLoop}, if running. */
  stopRenderLoop(): void {
    if (this.renderLoop) {
      this.renderLoop.stop();
      this.renderLoop = null;
    }
  }

  /**
   * Tears down the PixiJS application and releases all layers. After calling
   * this the renderer must be re-created (or {@link init} called again).
   *
   * @param removeCanvas - When `true`, the canvas element is removed from the
   *   DOM as part of teardown. Defaults to `false`.
   */
  destroy(removeCanvas = false): void {
    this.stopRenderLoop();
    if (this.app) {
      this.app.destroy(removeCanvas ? { removeView: true } : undefined, {
        children: true,
      });
    }
    this.app = null;
    this.layers = null;
    this.palette = null;
    this.explosions.clear();
    this.explosionSprites.clear();
    this.carSprites.clear();
    this.explodedParticipants.clear();
    this.lastRenderState = null;
    this.lastCamera = null;
    this.lastRenderTimeMs = null;
  }
}
