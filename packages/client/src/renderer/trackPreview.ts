/**
 * Pure, GPU-free helper for the top-down **track preview** used by launch
 * verification (task 25.14).
 *
 * A converted `.TRK` decodes to a {@link TrackDef} whose `roadSegments` trace
 * the track centerline in track-space units (each segment's `centre` is a
 * ground-plane point). To confirm a real converted track loaded correctly we
 * draw that centerline as a top-down polyline fitted into the canvas. This
 * module holds the fit math only — the bounding box of the segment centres and
 * the scale/translate that maps them into a padded canvas rectangle — so it can
 * be unit-tested headless (no PixiJS). The actual `Graphics` draw glue lives in
 * the renderer / bootstrap and needs a real WebGL context.
 *
 * This is deliberately **not** the in-race scanline renderer (that is a
 * first-person pseudo-3D view driven by the game loop). It is a static,
 * top-down preview whose only job is to prove the decoded geometry is a
 * coherent circuit on screen.
 *
 * Requirements: 2.1, 2.2, 9.2
 */

import type { RoadSegment } from '@deathtrack/shared';

/** A 2-D point in screen (canvas) pixels. */
export interface ScreenPoint {
  x: number;
  y: number;
}

/** The result of fitting a track centerline into a canvas rectangle. */
export interface TrackPreviewLayout {
  /** The centerline points projected into canvas pixels, in segment order. */
  points: ScreenPoint[];
  /** Whether the polyline should be closed back to its first point. */
  closed: boolean;
  /** Uniform scale applied (canvas px per track-space unit). */
  scale: number;
}

/** Options for {@link layoutTrackPreview}. */
export interface TrackPreviewOptions {
  /** Canvas width in pixels. */
  width: number;
  /** Canvas height in pixels. */
  height: number;
  /** Padding (px) kept clear on every side. Default 24. */
  padding?: number;
  /**
   * Whether the polyline closes back to its start (a full circuit). Pass the
   * track's decoded `roadPathClosed` flag; defaults to `true`.
   */
  closed?: boolean;
}

/**
 * Project a track's `roadSegments` centerline into canvas pixels, fitted to the
 * given canvas rectangle with uniform scaling (aspect preserved) and centred.
 *
 * The track-space Y axis (a ground-plane depth) is flipped so the preview reads
 * top-down with increasing depth going down the screen, matching how the
 * circuits were verified as PNGs.
 *
 * Degenerate inputs are handled without throwing: an empty segment list yields
 * no points; a zero-span axis uses a unit span so all points collapse to the
 * canvas centre rather than dividing by zero.
 */
export function layoutTrackPreview(
  segments: readonly Pick<RoadSegment, 'centre'>[],
  options: TrackPreviewOptions,
): TrackPreviewLayout {
  const padding = options.padding ?? 24;
  const closed = options.closed ?? true;

  if (segments.length === 0) {
    return { points: [], closed, scale: 1 };
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const seg of segments) {
    const { x, y } = seg.centre;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }

  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  const drawW = Math.max(1, options.width - 2 * padding);
  const drawH = Math.max(1, options.height - 2 * padding);
  // Uniform scale so the circuit keeps its aspect ratio inside the padded box.
  const scale = Math.min(drawW / spanX, drawH / spanY);

  // Centre the scaled bounding box within the canvas.
  const scaledW = spanX * scale;
  const scaledH = spanY * scale;
  const offsetX = (options.width - scaledW) / 2;
  const offsetY = (options.height - scaledH) / 2;

  const points = segments.map((seg) => {
    const px = offsetX + (seg.centre.x - minX) * scale;
    // Flip Y so larger track-space Y draws lower on screen.
    const py = offsetY + (maxY - seg.centre.y) * scale;
    return { x: px, y: py };
  });

  return { points, closed, scale };
}
