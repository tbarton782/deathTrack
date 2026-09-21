/**
 * Pure, deterministic waypoint navigation for the Deathtrack Multiplayer
 * Recreation AI drivers.
 *
 * The AI follows the track path using a directed {@link WaypointGraph} derived
 * from the {@link TrackDef}. Every function in this module is a pure function
 * of its arguments: it never reads `Math.random()`, `Date.now()`, or any
 * ambient mutable state, and never mutates its inputs. Navigation is fully
 * deterministic — the same car position and graph always resolve to the same
 * next waypoint and racing-line target — which keeps AI decisions safe for
 * lockstep client/server reconciliation and replay.
 *
 * Responsibilities (Requirements: 6.1):
 *
 *   1. **Build** — {@link buildWaypointGraph} derives a directed graph from a
 *      track's road segments when a track does not already ship one, wiring
 *      each segment centre to the next in a closed loop with pre-computed
 *      Euclidean edge distances.
 *   2. **Next waypoint** — {@link nextWaypoint} resolves the waypoint a car is
 *      currently heading toward. Given a car position it locates the nearest
 *      node and returns the graph successor of that node, so the AI always
 *      aims *ahead* along the route rather than at the point it has already
 *      reached.
 *   3. **Racing line** — {@link racingLineTarget} offsets the raw waypoint
 *      position laterally within the node's usable corridor based on the
 *      driver's aggression level (1–5). Cautious drivers (aggression 1) hug the
 *      corridor centre; aggressive drivers (aggression 5) commit to the inside
 *      line, using the full half-width of the corridor.
 *
 * Requirements: 6.1
 */

import type { Vec2 } from '../types/primitives.js';
import type {
  TrackDef,
  WaypointGraph,
  WaypointNode,
  WaypointEdge,
} from '../types/track.js';

// ---------------------------------------------------------------------------
// Aggression scale
// ---------------------------------------------------------------------------

/** Minimum valid aggression level (most cautious). Requirements: 6.1 */
export const MIN_AGGRESSION = 1;

/** Maximum valid aggression level (most aggressive). Requirements: 6.1 */
export const MAX_AGGRESSION = 5;

// ---------------------------------------------------------------------------
// Small pure vector helpers (local, to avoid a cross-module dependency)
// ---------------------------------------------------------------------------

function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Clamp an aggression value into the inclusive `[1, 5]` band and round it to
 * the nearest integer. Out-of-band or fractional configuration values are
 * tolerated rather than rejected so the navigator never throws mid-race.
 */
function clampAggression(aggression: number): number {
  if (!Number.isFinite(aggression)) return MIN_AGGRESSION;
  const rounded = Math.round(aggression);
  if (rounded < MIN_AGGRESSION) return MIN_AGGRESSION;
  if (rounded > MAX_AGGRESSION) return MAX_AGGRESSION;
  return rounded;
}

// ---------------------------------------------------------------------------
// Graph construction
// ---------------------------------------------------------------------------

/**
 * Build a closed-loop directed waypoint graph from a track's road segments.
 *
 * Each road segment contributes one {@link WaypointNode} positioned at the
 * segment centre, carrying the segment width as its usable corridor. Nodes are
 * wired sequentially — segment `i` to segment `i + 1` — with the final segment
 * looping back to the first so the AI can lap continuously. Edge distances are
 * pre-computed Euclidean distances between the connected node positions.
 *
 * If the track already ships a non-empty {@link WaypointGraph}, that graph is
 * returned as-is (defensively cloned) rather than being rebuilt, so authored
 * navigation data always wins over the derived fallback.
 *
 * Requirements: 6.1, 9.1
 */
export function buildWaypointGraph(track: TrackDef): WaypointGraph {
  const authored = track.waypointGraph;
  if (authored && authored.nodes.length > 0) {
    return {
      nodes: authored.nodes.map((n) => ({ ...n, position: { ...n.position } })),
      edges: authored.edges.map((e) => ({ ...e })),
    };
  }

  const segments = track.roadSegments;
  const nodes: WaypointNode[] = segments.map((seg) => ({
    id: seg.index,
    position: { x: seg.centre.x, y: seg.centre.y },
    width: seg.width,
  }));

  const edges: WaypointEdge[] = [];
  const count = nodes.length;
  for (let i = 0; i < count; i++) {
    if (count === 1) break; // A single node has no meaningful edge.
    const from = nodes[i]!;
    // Wrap the final node back to the first to form a closed racing loop.
    const to = nodes[(i + 1) % count]!;
    edges.push({
      from: from.id,
      to: to.id,
      distance: distance(from.position, to.position),
    });
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Graph indexing
// ---------------------------------------------------------------------------

/**
 * Build a fast id → node lookup for a graph. Exposed for callers that resolve
 * many positions against the same graph (e.g. the AI brain each tick).
 */
export function indexNodes(graph: WaypointGraph): Map<number, WaypointNode> {
  const map = new Map<number, WaypointNode>();
  for (const node of graph.nodes) map.set(node.id, node);
  return map;
}

/**
 * Find the node in the graph nearest to a car position. Returns `undefined`
 * for an empty graph. Ties are broken deterministically by the earlier node in
 * `graph.nodes` iteration order.
 *
 * Requirements: 6.1
 */
export function nearestNode(
  graph: WaypointGraph,
  position: Vec2,
): WaypointNode | undefined {
  let best: WaypointNode | undefined;
  let bestDistSq = Infinity;
  for (const node of graph.nodes) {
    const dx = node.position.x - position.x;
    const dy = node.position.y - position.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = node;
    }
  }
  return best;
}

/**
 * Resolve the next waypoint a car at `position` should aim for.
 *
 * The car's nearest node represents the point it has effectively reached; the
 * AI should steer toward the *successor* of that node along the directed graph
 * so it tracks the route ahead. When the nearest node has multiple outgoing
 * edges the nearest destination node is chosen, keeping the AI on the tightest
 * forward path. When it has none (a terminal node) the nearest node itself is
 * returned so callers always receive a target.
 *
 * Returns `undefined` only for an empty graph.
 *
 * Requirements: 6.1
 */
export function nextWaypoint(
  graph: WaypointGraph,
  position: Vec2,
): WaypointNode | undefined {
  const current = nearestNode(graph, position);
  if (current === undefined) return undefined;

  const byId = indexNodes(graph);

  let best: WaypointNode | undefined;
  let bestDistSq = Infinity;
  for (const edge of graph.edges) {
    if (edge.from !== current.id) continue;
    const dest = byId.get(edge.to);
    if (dest === undefined) continue;
    const dx = dest.position.x - position.x;
    const dy = dest.position.y - position.y;
    const distSq = dx * dx + dy * dy;
    if (distSq < bestDistSq) {
      bestDistSq = distSq;
      best = dest;
    }
  }

  // Terminal node with no outgoing edges: aim at the node itself.
  return best ?? current;
}

// ---------------------------------------------------------------------------
// Racing line
// ---------------------------------------------------------------------------

/**
 * Compute the normalised lateral offset fraction for a given aggression level.
 *
 * The fraction is in `[0, 1]` and represents how far toward the corridor edge
 * the racing line sits, measured from the corridor centre:
 *
 * - aggression 1 → 0.0  (dead centre; cautious)
 * - aggression 2 → 0.25
 * - aggression 3 → 0.5
 * - aggression 4 → 0.75
 * - aggression 5 → 1.0  (full corridor edge; aggressive inside line)
 *
 * Requirements: 6.1
 */
export function racingLineOffsetFraction(aggression: number): number {
  const level = clampAggression(aggression);
  return (level - MIN_AGGRESSION) / (MAX_AGGRESSION - MIN_AGGRESSION);
}

/**
 * Compute the world-space racing-line target for a waypoint given a driver's
 * aggression level.
 *
 * The target is the waypoint position offset laterally along the corridor's
 * perpendicular by `offsetFraction × halfWidth`. The lateral direction is the
 * unit perpendicular of the segment heading (previous → this → next node);
 * this points consistently toward one side of the corridor so more aggressive
 * drivers commit further onto the racing line while cautious drivers stay
 * centred.
 *
 * When a heading cannot be derived (isolated node) the offset collapses to zero
 * and the raw waypoint position is returned. The returned Vec2 is always a
 * fresh object; inputs are never mutated.
 *
 * Requirements: 6.1
 */
export function racingLineTarget(
  graph: WaypointGraph,
  node: WaypointNode,
  aggression: number,
): Vec2 {
  const fraction = racingLineOffsetFraction(aggression);
  if (fraction === 0) {
    return { x: node.position.x, y: node.position.y };
  }

  const heading = nodeHeading(graph, node);
  if (heading === undefined) {
    return { x: node.position.x, y: node.position.y };
  }

  // Left-hand perpendicular of the heading (rotate 90°): (x, y) -> (-y, x).
  const perpX = -heading.y;
  const perpY = heading.x;

  const halfWidth = node.width / 2;
  const offset = fraction * halfWidth;

  return {
    x: node.position.x + perpX * offset,
    y: node.position.y + perpY * offset,
  };
}

/**
 * Derive a unit heading vector at a node from its graph neighbours.
 *
 * The heading uses the incoming predecessor and outgoing successor when both
 * exist (centred difference), otherwise falls back to whichever single edge is
 * available. Returns `undefined` when the node has neither neighbours nor a
 * usable non-zero direction.
 */
function nodeHeading(graph: WaypointGraph, node: WaypointNode): Vec2 | undefined {
  const byId = indexNodes(graph);

  let successor: WaypointNode | undefined;
  let predecessor: WaypointNode | undefined;
  for (const edge of graph.edges) {
    if (successor === undefined && edge.from === node.id) {
      successor = byId.get(edge.to);
    }
    if (predecessor === undefined && edge.to === node.id) {
      predecessor = byId.get(edge.from);
    }
    if (successor !== undefined && predecessor !== undefined) break;
  }

  let dx: number;
  let dy: number;
  if (predecessor !== undefined && successor !== undefined) {
    dx = successor.position.x - predecessor.position.x;
    dy = successor.position.y - predecessor.position.y;
  } else if (successor !== undefined) {
    dx = successor.position.x - node.position.x;
    dy = successor.position.y - node.position.y;
  } else if (predecessor !== undefined) {
    dx = node.position.x - predecessor.position.x;
    dy = node.position.y - predecessor.position.y;
  } else {
    return undefined;
  }

  const len = Math.sqrt(dx * dx + dy * dy);
  if (len === 0) return undefined;
  return { x: dx / len, y: dy / len };
}

// ---------------------------------------------------------------------------
// WaypointNavigator facade
// ---------------------------------------------------------------------------

/**
 * Stateful convenience wrapper binding a single {@link WaypointGraph} so the AI
 * brain can resolve navigation queries without threading the graph through
 * every call. The wrapper holds no mutable per-tick state and performs no
 * randomness; it is a thin deterministic facade over the module functions.
 *
 * Requirements: 6.1
 */
export class WaypointNavigator {
  readonly graph: WaypointGraph;

  private constructor(graph: WaypointGraph) {
    this.graph = graph;
  }

  /** Construct a navigator from an explicit graph. */
  static fromGraph(graph: WaypointGraph): WaypointNavigator {
    return new WaypointNavigator(graph);
  }

  /**
   * Construct a navigator from a track, building the waypoint graph from road
   * segments when the track does not already ship one.
   */
  static fromTrack(track: TrackDef): WaypointNavigator {
    return new WaypointNavigator(buildWaypointGraph(track));
  }

  /** Nearest graph node to a car position. */
  nearestNode(position: Vec2): WaypointNode | undefined {
    return nearestNode(this.graph, position);
  }

  /** Next waypoint a car at `position` should steer toward. */
  nextWaypoint(position: Vec2): WaypointNode | undefined {
    return nextWaypoint(this.graph, position);
  }

  /** Racing-line target for the next waypoint at a given aggression level. */
  racingLineTarget(position: Vec2, aggression: number): Vec2 | undefined {
    const node = this.nextWaypoint(position);
    if (node === undefined) return undefined;
    return racingLineTarget(this.graph, node, aggression);
  }
}
