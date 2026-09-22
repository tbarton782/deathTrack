/**
 * Public API surface for the `@deathtrack/shared` package.
 *
 * Re-exports all domain types, codec, and utility modules so that
 * consumers can import from the single `@deathtrack/shared` entry point.
 *
 * Requirements: all
 */

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type {
  Vec2,
  ParticipantId,
  SessionId,
  ChassisId,
  TrackId,
  WeaponId,
  WeaponSlot,
  ComponentId,
  ComponentSlot,
  ProjectileId,
  HazardId,
  SFXId,
  MusicContext,
  SpriteSheetRef,
} from './types/primitives.js';

export type {
  RNG,
  CarPhysicsState,
  CarInputs,
  WorldPhysicsState,
  PhysicsStepResult,
  PhysicsEvent,
  CollisionEvent,
  JumpLaunchEvent,
  JumpLandEvent,
  OffTrackEvent,
  OnTrackEvent,
  PitLaneEnterEvent,
  PitLaneExitEvent,
} from './types/physics.js';

export type {
  WeaponCategory,
  WeaponDef,
  WeaponConfig,
  ActiveProjectile,
  PlacedHazard,
  CarWeaponState,
  WeaponSystemState,
  WeaponEvent,
  ProjectileFiredEvent,
  HazardPlacedEvent,
  HitEvent,
  EliminationEvent,
  BeamDamageEvent,
  WeaponStepResult,
} from './types/weapons.js';

export type {
  CarBaseStats,
  EffectiveCarStats,
  ChassisDef,
  ComponentDef,
  Loadout,
  ResolvedLoadout,
  CarRaceState,
} from './types/car.js';

export type {
  SurfaceType,
  RoadSegment,
  JumpRamp,
  WaypointNode,
  WaypointEdge,
  WaypointGraph,
  PitLaneData,
  HazardZone,
  SceneryObject,
  TrackDef,
} from './types/track.js';

export type {
  CareerState,
  HighScoreEntry,
  SaveFile,
  SlotInfo,
} from './types/career.js';

export type {
  SessionConfig,
  Session,
  ParticipantInfo,
  SessionSummary,
  JoinResult,
  InputFrame,
  CompressedCarState,
  StateSnapshot,
  NetworkEvent,
  ParticipantJoinedEvent,
  ParticipantLeftEvent,
  SessionClosedEvent,
  HostTransferredEvent,
  PausedEvent,
  ResumedEvent,
} from './types/network.js';

export type {
  SkillTier,
  AICharacter,
  AIDriverConfig,
  AIDriverState,
} from './types/ai.js';

// ---------------------------------------------------------------------------
// Binary codec
// ---------------------------------------------------------------------------

export type { Codec, FieldType, SchemaField, SchemaDescriptor } from './codec/schema.js';

export {
  createCodec,
  uint8,
  uint16,
  int16,
  uint32,
  int32,
  float32,
  float64,
  boolean,
  fixedString,
  nested,
  array,
} from './codec/schema.js';

export { BinaryWriter } from './codec/BinaryWriter.js';
export { BinaryReader } from './codec/BinaryReader.js';

export {
  CompressedCarStateCodec,
  compressedCarStateSchema,
  COMPRESSED_CAR_STATE_BYTES,
} from './codec/CompressedCarStateCodec.js';

export {
  StateSnapshotCodec,
  stateSnapshotSchema,
  STATE_SNAPSHOT_MAX_CARS,
  STATE_SNAPSHOT_HEADER_BYTES,
  STATE_SNAPSHOT_MAX_BYTES,
  STATE_SNAPSHOT_PACKET_CAP_BYTES,
} from './codec/StateSnapshotCodec.js';

export {
  SaveFileCodec,
  CorruptSaveError,
  crc32,
  SAVE_FILE_MAGIC,
  SAVE_FILE_VERSION,
} from './codec/SaveFileCodec.js';

// ---------------------------------------------------------------------------
// Physics
// ---------------------------------------------------------------------------

export { mkRNG } from './physics/rng.js';

export { stepPhysics, FIXED_TIMESTEP } from './physics/stepPhysics.js';
export type {
  PhysicsCarStats,
  TrackSDF,
  PhysicsWorldExtras,
  PhysicsWorldState,
} from './physics/stepPhysics.js';

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export {
  SaveManager,
  InMemorySlotStorage,
  SAVE_SLOTS,
} from './persistence/SaveManager.js';
export type { SaveSlot, SlotStorage } from './persistence/SaveManager.js';

// ---------------------------------------------------------------------------
// Loadout
// ---------------------------------------------------------------------------

export {
  equip,
  equipComponent,
  computeEffectiveStats,
  previewComponent,
  confirmLoadout,
  rejectEquipDuringRace,
  emptyLoadout,
  STAT_MAXIMA,
  CHASSIS_BASE_MASS,
  MASS_PER_ARMOR,
} from './loadout/LoadoutService.js';

export {
  CHASSIS_CATALOGUE,
  COMPONENT_CATALOGUE,
  WEAPON_CATALOGUE,
  findChassis,
} from './catalogue/GameCatalogue.js';

export type {
  Result,
  LoadoutError,
  StatPreview,
  ComponentStatPreview,
} from './loadout/LoadoutService.js';

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

export {
  stepWeapons,
  DEFAULT_CONTACT_RADIUS,
  DEFAULT_MUZZLE_OFFSET,
} from './weapons/WeaponSystem.js';

export type {
  WeaponFireInput,
  WeaponStepConfig,
  WeaponStepOutput,
} from './weapons/WeaponSystem.js';

export {
  ProjectileCodec,
  projectileSchema,
  validateProjectileRoundTrip,
  WEAPON_ID_ORDER,
} from './weapons/ProjectileCodec.js';

// ---------------------------------------------------------------------------
// Career
// ---------------------------------------------------------------------------

export {
  computePrizeMoney,
  purchaseItem,
  advanceCircuit,
  addHighScore,
  newCareer,
  CIRCUIT_TRACK_COUNT,
  HIGH_SCORE_CAPACITY,
} from './career/CareerService.js';

export type {
  CareerResult,
  CareerError,
  PrizeTable,
} from './career/CareerService.js';

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

export {
  WaypointNavigator,
  buildWaypointGraph,
  indexNodes,
  nearestNode,
  nextWaypoint,
  racingLineOffsetFraction,
  racingLineTarget,
  MIN_AGGRESSION,
  MAX_AGGRESSION,
} from './ai/WaypointNavigator.js';

export {
  computeAIInputs,
  nextEvasive,
  steerToward,
  steerAwayFrom,
  detectHazardAhead,
  nearestOpponentDistance,
  decideForwardFire,
  decideRearDrop,
  sampleLapThrottleJitter,
  FIRE_PROBABILITY_BY_TIER,
  HAZARD_RADIUS_BY_TIER,
  EVASIVE_ENTER_FRACTION,
  EVASIVE_EXIT_FRACTION,
  EVASIVE_THREAT_RANGE,
  REAR_DROP_DISTANCE,
  REAR_DROP_CONE_COS,
  LAP_JITTER_MIN,
  LAP_JITTER_MAX,
} from './ai/AIBrain.js';

export type { AIBrainWorld } from './ai/AIBrain.js';

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export {
  loadSpriteSheet,
  SpriteSheetLoader,
  SpriteSheetLoadError,
  PALETTE_RGB_BYTE_LENGTH,
  DEFAULT_MAX_ATLAS_WIDTH,
} from './assets/SpriteSheetLoader.js';

export type {
  SpriteSheetBlock,
  SpriteSheetBundle,
  SpritePalette,
  AtlasRect,
  AtlasSize,
  AtlasFrame,
  AtlasMeta,
  SpriteAtlas,
  SpriteSheetLoadResult,
  SpriteSheetLoadOptions,
} from './assets/SpriteSheetLoader.js';

// ---------------------------------------------------------------------------
// Assets
// ---------------------------------------------------------------------------

export {
  AssetKind,
  ASSET_MAGIC,
  ASSET_VERSION,
  BinaryAssetLoader,
  InMemoryAssetSource,
  TrackLoadError,
} from './assets/AssetLoader.js';

export type {
  AssetLoader,
  AssetSource,
  AssetLoaderOptions,
  SpriteSheetData,
  MusicTrackData,
} from './assets/AssetLoader.js';
