/**
 * Unit tests for the WaypointNavigator AI navigation module.
 *
 * Covers: graph construction from road segments (and passthrough of authored
 * graphs), next-waypoint resolution for various car positions, and racing-line
 * selection across the full 1–5 aggression band.
 *
 * Requirements: 6.1
 */

import { describe, it, expect } from 'vitest';
import type { Vec2 } from '../../types/primitives.js';
import type {
  RoadSegment,
  TrackDef,
  WaypointGraph,
  WaypointNode,
} from '../../types/track.js';
import {
  buildWaypointGraph,
  nearestNode,
  nextWaypoint,
  racingLineOffsetFraction,
  racingLineTarget,
  WaypointNavigator,
  MIN_AGGRESSION,
  MAX_AGGRESSION,
} from '../WaypointNavigator.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function seg(index: number, x: number, y: number, width = 10): RoadSegment {
  return {
    index,
    centre: { x, y },
    width,
    normal: { x: 0, y: 1 },
    surface: 'asphalt',
  };
}

/** A square loop of four road segments, no authored waypoint graph. */
function squareTrack(): TrackDef {
  return {
    id: 'bay_area',
    name: 'Bay Area',
    city: 'San Francisco',
    lapCount: 3,
    roadSegments: [
      seg(0, 0, 0),
      seg(1, 10, 0),
      seg(2, 10, 10),
      seg(3, 0, 10),
    ],
    jumpRamps: [],
    // Empty authored graph triggers the derived fallback.
    waypointGraph: { nodes: [], edges: [] },
    pitLane: { entryPosition: { x: 0, y: 0 }, exitPosition: { x: 0, y: 0 }, path: [] },
    hazardZones: [],
    scenery: [],
    palette: new Uint8Array(256 * 3),
  };
}

function node(id: number, x: number, y: number, width = 10): WaypointNode {
  return { id, position: { x, y }, width };
}

/** A simple straight horizontal graph: nodes at x = 0,10,20 along y = 0. */
function straightGraph(): WaypointGraph {
  return {
    nodes: [node(0, 0, 0), node(1, 10, 0), node(2, 20, 0)],
    edges: [
      { from: 0, to: 1, distance: 10 },
      { from: 1, to: 2, distance: 10 },
    ],
  };
}

// ---------------------------------------------------------------------------
// buildWaypointGraph
// ---------------------------------------------------------------------------

describe('buildWaypointGraph', () => {
  it('derives one node per road segment when no authored graph exists', () => {
    const graph = buildWaypointGraph(squareTrack());
    expect(graph.nodes).toHaveLength(4);
    expect(graph.nodes.map((n) => n.id)).toEqual([0, 1, 2, 3]);
    expect(graph.nodes[1]!.position).toEqual({ x: 10, y: 0 });
    expect(graph.nodes[0]!.width).toBe(10);
  });

  it('wires segments into a closed loop with pre-computed distances', () => {
    const graph = buildWaypointGraph(squareTrack());
    expect(graph.edges).toHaveLength(4);
    // Each edge of the unit-10 square is length 10.
    for (const e of graph.edges) expect(e.distance).toBeCloseTo(10);
    // Final node loops back to the first.
    expect(graph.edges[3]).toMatchObject({ from: 3, to: 0 });
  });

  it('returns the authored graph unchanged when the track ships one', () => {
    const authored = straightGraph();
    const track = squareTrack();
    track.waypointGraph = authored;
    const graph = buildWaypointGraph(track);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges).toHaveLength(2);
  });

  it('defensively clones the authored graph (no shared references)', () => {
    const authored = straightGraph();
    const track = squareTrack();
    track.waypointGraph = authored;
    const graph = buildWaypointGraph(track);
    graph.nodes[0]!.position.x = 999;
    expect(authored.nodes[0]!.position.x).toBe(0);
  });

  it('produces no edges for a single-segment track', () => {
    const track = squareTrack();
    track.roadSegments = [seg(0, 5, 5)];
    const graph = buildWaypointGraph(track);
    expect(graph.nodes).toHaveLength(1);
    expect(graph.edges).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// nearestNode
// ---------------------------------------------------------------------------

describe('nearestNode', () => {
  it('returns the closest node to a position', () => {
    const g = straightGraph();
    expect(nearestNode(g, { x: 9, y: 1 })?.id).toBe(1);
    expect(nearestNode(g, { x: 0.5, y: 0 })?.id).toBe(0);
    expect(nearestNode(g, { x: 100, y: 0 })?.id).toBe(2);
  });

  it('returns undefined for an empty graph', () => {
    expect(nearestNode({ nodes: [], edges: [] }, { x: 0, y: 0 })).toBeUndefined();
  });

  it('breaks ties deterministically toward the earlier node', () => {
    const g: WaypointGraph = {
      nodes: [node(0, 0, 0), node(1, 2, 0)],
      edges: [{ from: 0, to: 1, distance: 2 }],
    };
    // Position exactly between both nodes.
    expect(nearestNode(g, { x: 1, y: 0 })?.id).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// nextWaypoint
// ---------------------------------------------------------------------------

describe('nextWaypoint', () => {
  it('aims at the successor of the nearest node', () => {
    const g = straightGraph();
    // Near node 0 -> should target node 1.
    expect(nextWaypoint(g, { x: 0.5, y: 0 })?.id).toBe(1);
    // Near node 1 -> should target node 2.
    expect(nextWaypoint(g, { x: 10.2, y: 0 })?.id).toBe(2);
  });

  it('returns the terminal node itself when it has no successor', () => {
    const g = straightGraph();
    // Near node 2 (the terminal node) -> no outgoing edge, returns node 2.
    expect(nextWaypoint(g, { x: 20, y: 0 })?.id).toBe(2);
  });

  it('follows the loop wrap on a closed track', () => {
    const g = buildWaypointGraph(squareTrack());
    // Near node 3 (0,10) -> successor wraps to node 0 (0,0).
    expect(nextWaypoint(g, { x: 0, y: 10 })?.id).toBe(0);
  });

  it('returns undefined for an empty graph', () => {
    expect(nextWaypoint({ nodes: [], edges: [] }, { x: 0, y: 0 })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// racingLineOffsetFraction
// ---------------------------------------------------------------------------

describe('racingLineOffsetFraction', () => {
  it('maps aggression 1..5 to fractions 0..1 in even steps', () => {
    expect(racingLineOffsetFraction(1)).toBeCloseTo(0);
    expect(racingLineOffsetFraction(2)).toBeCloseTo(0.25);
    expect(racingLineOffsetFraction(3)).toBeCloseTo(0.5);
    expect(racingLineOffsetFraction(4)).toBeCloseTo(0.75);
    expect(racingLineOffsetFraction(5)).toBeCloseTo(1);
  });

  it('is monotonically non-decreasing across the aggression band', () => {
    let prev = -1;
    for (let a = MIN_AGGRESSION; a <= MAX_AGGRESSION; a++) {
      const f = racingLineOffsetFraction(a);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });

  it('clamps out-of-band and fractional aggression values', () => {
    expect(racingLineOffsetFraction(0)).toBeCloseTo(0);
    expect(racingLineOffsetFraction(-3)).toBeCloseTo(0);
    expect(racingLineOffsetFraction(9)).toBeCloseTo(1);
    expect(racingLineOffsetFraction(2.4)).toBeCloseTo(0.25); // rounds to 2
    expect(racingLineOffsetFraction(NaN)).toBeCloseTo(0);
  });
});

// ---------------------------------------------------------------------------
// racingLineTarget
// ---------------------------------------------------------------------------

describe('racingLineTarget', () => {
  it('returns the raw waypoint centre for aggression 1', () => {
    const g = straightGraph();
    const target = racingLineTarget(g, g.nodes[1]!, 1);
    expect(target).toEqual({ x: 10, y: 0 });
  });

  it('offsets toward the corridor edge for aggression 5', () => {
    const g = straightGraph();
    // Node 1 heading is +x (from node 0 -> node 2); left perpendicular is +y.
    // Full offset = fraction(1.0) * halfWidth(5) = 5.
    const target = racingLineTarget(g, g.nodes[1]!, 5);
    expect(target.x).toBeCloseTo(10);
    expect(target.y).toBeCloseTo(5);
  });

  it('offsets proportionally for mid-range aggression', () => {
    const g = straightGraph();
    // aggression 3 -> fraction 0.5 -> offset 0.5 * 5 = 2.5 along +y.
    const target = racingLineTarget(g, g.nodes[1]!, 3);
    expect(target.x).toBeCloseTo(10);
    expect(target.y).toBeCloseTo(2.5);
  });

  it('produces a monotonically increasing lateral offset with aggression', () => {
    const g = straightGraph();
    let prevY = -1;
    for (let a = MIN_AGGRESSION; a <= MAX_AGGRESSION; a++) {
      const t = racingLineTarget(g, g.nodes[1]!, a);
      expect(t.y).toBeGreaterThanOrEqual(prevY);
      prevY = t.y;
    }
  });

  it('falls back to the raw position when no heading can be derived', () => {
    const isolated: WaypointGraph = { nodes: [node(0, 3, 4)], edges: [] };
    const target = racingLineTarget(isolated, isolated.nodes[0]!, 5);
    expect(target).toEqual({ x: 3, y: 4 });
  });

  it('does not mutate the source node position', () => {
    const g = straightGraph();
    const before: Vec2 = { ...g.nodes[1]!.position };
    racingLineTarget(g, g.nodes[1]!, 5);
    expect(g.nodes[1]!.position).toEqual(before);
  });
});

// ---------------------------------------------------------------------------
// WaypointNavigator facade
// ---------------------------------------------------------------------------

describe('WaypointNavigator', () => {
  it('builds from a track and resolves the next waypoint', () => {
    const nav = WaypointNavigator.fromTrack(squareTrack());
    expect(nav.graph.nodes).toHaveLength(4);
    expect(nav.nextWaypoint({ x: 0.5, y: 0 })?.id).toBe(1);
  });

  it('builds from an explicit graph', () => {
    const nav = WaypointNavigator.fromGraph(straightGraph());
    expect(nav.nearestNode({ x: 9, y: 0 })?.id).toBe(1);
  });

  it('resolves a racing-line target for the next waypoint', () => {
    const nav = WaypointNavigator.fromGraph(straightGraph());
    // Near node 0 -> next is node 1, aggression 5 offsets +5 in y.
    const target = nav.racingLineTarget({ x: 0.5, y: 0 }, 5);
    expect(target?.x).toBeCloseTo(10);
    expect(target?.y).toBeCloseTo(5);
  });

  it('returns undefined racing-line target for an empty graph', () => {
    const nav = WaypointNavigator.fromGraph({ nodes: [], edges: [] });
    expect(nav.racingLineTarget({ x: 0, y: 0 }, 3)).toBeUndefined();
  });

  it('is deterministic: identical queries yield identical results', () => {
    const nav = WaypointNavigator.fromTrack(squareTrack());
    const a = nav.racingLineTarget({ x: 5, y: 1 }, 4);
    const b = nav.racingLineTarget({ x: 5, y: 1 }, 4);
    expect(a).toEqual(b);
  });
});
