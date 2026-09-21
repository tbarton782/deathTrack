/**
 * Track domain types for the Deathtrack Multiplayer Recreation.
 *
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
 */

import type { Vec2, TrackId } from './primitives.js';

// ---------------------------------------------------------------------------
// Surface types
// ---------------------------------------------------------------------------

/**
 * The surface material of a road segment, affecting car traction and speed.
 * Requirements: 9.1
 */
export type SurfaceType = 'asphalt' | 'dirt' | 'gravel';

// ---------------------------------------------------------------------------
// Road geometry
// ---------------------------------------------------------------------------

/**
 * A single road segment defining a slice of the track geometry.
 * The `centre` is the midpoint of the driveable lane at this segment index.
 * The `normal` vector is perpendicular to the road direction (used for
 * off-track signed-distance-field calculations).
 * Requirements: 9.1, 9.2
 */
export interface RoadSegment {
  /** Sequential index of this segment within the track. */
  index: number;
  /** Midpoint of the driveable lane in track-space units. */
  centre: Vec2;
  /** Full width of the driveable lane in track-space units. */
  width: number;
  /** Unit normal perpendicular to the road direction at this segment. */
  normal: Vec2;
  /** Surface material affecting traction penalties. */
  surface: SurfaceType;
}

// ---------------------------------------------------------------------------
// Jump ramps
// ---------------------------------------------------------------------------

/**
 * A jump ramp that launches cars into the air on contact.
 * Requirements: 9.1
 */
export interface JumpRamp {
  /** Position of the ramp's trigger point in track-space units. */
  position: Vec2;
  /** Launch angle in degrees above the horizontal. */
  angle: number;
  /** Multiplier applied to the car's speed when computing vertical launch velocity. */
  launchMultiplier: number;
}

// ---------------------------------------------------------------------------
// Waypoint graph
// ---------------------------------------------------------------------------

/**
 * A single node in the AI waypoint graph.
 * The `width` indicates the usable racing-line corridor at this waypoint.
 * Requirements: 9.1, 9.2
 */
export interface WaypointNode {
  /** Unique numeric identifier for this node. */
  id: number;
  /** Position of the waypoint in track-space units. */
  position: Vec2;
  /** Usable racing-line corridor width at this node, in track-space units. */
  width: number;
}

/**
 * A directed edge connecting two waypoint nodes in the AI navigation graph.
 * Requirements: 9.1, 9.2
 */
export interface WaypointEdge {
  /** ID of the source waypoint node. */
  from: number;
  /** ID of the destination waypoint node. */
  to: number;
  /** Pre-computed Euclidean distance between the two nodes, in track-space units. */
  distance: number;
}

/**
 * The complete directed waypoint graph used by AI navigation.
 * Requirements: 9.1, 9.2
 */
export interface WaypointGraph {
  nodes: WaypointNode[];
  edges: WaypointEdge[];
}

// ---------------------------------------------------------------------------
// Pit lane
// ---------------------------------------------------------------------------

/**
 * Entry/exit positions and path of the pit lane.
 * When a car enters the pit lane, armor is restored to maximum and all
 * ammo is reloaded before the car reaches the exit position.
 * Requirements: 9.3, 9.4
 */
export interface PitLaneData {
  /** Track-space position where a car enters the pit lane. */
  entryPosition: Vec2;
  /** Track-space position where a car exits the pit lane. */
  exitPosition: Vec2;
  /** Ordered list of waypoints defining the path through the pit lane. */
  path: Vec2[];
}

// ---------------------------------------------------------------------------
// Hazard zones
// ---------------------------------------------------------------------------

/**
 * A polygonal region on the track that marks a static hazard zone.
 * The `bounds` array defines the polygon vertices in track-space units.
 * Requirements: 9.1
 */
export interface HazardZone {
  /** Unique numeric identifier for this hazard zone. */
  id: number;
  /** Polygon vertices defining the hazard area in track-space units. */
  bounds: Vec2[];
  /** Opaque string describing the hazard type (e.g. 'oil_slick', 'barrier'). */
  hazardType: string;
}

// ---------------------------------------------------------------------------
// Scenery
// ---------------------------------------------------------------------------

/**
 * A static scenery object placed alongside the track.
 * The `depth` field is used for back-to-front rendering order in the
 * scanline-based pseudo-3D renderer.
 * Requirements: 9.1, 9.2
 */
export interface SceneryObject {
  /** Unique numeric identifier for this scenery instance. */
  id: number;
  /** Position of the object in track-space units. */
  position: Vec2;
  /** Reference to the sprite asset used to draw this object. */
  spriteId: string;
  /** Depth value used to determine draw order (larger = further away). */
  depth: number;
}

// ---------------------------------------------------------------------------
// Track definition
// ---------------------------------------------------------------------------

/**
 * Complete definition of a track, combining geometry, navigation data,
 * game-play zones, and rendering assets.
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6
 */
export interface TrackDef {
  /** Unique track identifier corresponding to one of the ten city tracks. */
  id: TrackId;
  /** Human-readable track name (e.g. 'Bay Area'). */
  name: string;
  /** City name displayed in menus. */
  city: string;
  /** Number of laps required to complete the race. */
  lapCount: number;
  /** Ordered array of road segments defining the driveable surface. */
  roadSegments: RoadSegment[];
  /** All jump ramps present on the track. */
  jumpRamps: JumpRamp[];
  /** Directed waypoint graph used by AI navigation. */
  waypointGraph: WaypointGraph;
  /** Pit lane geometry and restoration trigger zone. */
  pitLane: PitLaneData;
  /** Static hazard zones overlaid on the track surface. */
  hazardZones: HazardZone[];
  /** Scenery objects placed alongside the road. */
  scenery: SceneryObject[];
  /**
   * 256-colour palette as a flat RGB byte array (length = 256 × 3).
   * Used by the WebGL palette-lookup shader for all track textures.
   * Requirements: 2.6
   */
  palette: Uint8Array;
}
