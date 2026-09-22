import { describe, it, expect } from 'vitest';

import { layoutTrackPreview } from '../trackPreview.js';

/** Build a minimal segment list from raw centre points. */
function segs(pts: [number, number][]): { centre: { x: number; y: number } }[] {
  return pts.map(([x, y]) => ({ centre: { x, y } }));
}

describe('layoutTrackPreview', () => {
  it('fits a square circuit inside the padded canvas, aspect preserved', () => {
    const layout = layoutTrackPreview(
      segs([
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
      ]),
      { width: 200, height: 200, padding: 20, closed: true },
    );

    expect(layout.points).toHaveLength(4);
    expect(layout.closed).toBe(true);
    // Draw box is 160x160 for a 100x100 span => scale 1.6.
    expect(layout.scale).toBeCloseTo(1.6, 5);
    // Every projected point stays within the canvas bounds.
    for (const p of layout.points) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(200);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(200);
    }
  });

  it('flips the Y axis so larger track-space Y draws lower on screen', () => {
    const layout = layoutTrackPreview(
      segs([
        [0, 0], // min Y
        [0, 100], // max Y
      ]),
      { width: 200, height: 200, padding: 0 },
    );
    const [low, high] = layout.points;
    // Track y=0 (min) should map to a LARGER screen y than track y=100 (max).
    expect(low!.y).toBeGreaterThan(high!.y);
  });

  it('preserves aspect ratio: a wide track scales by the tighter axis', () => {
    // 400 wide x 100 tall into a 240x240 draw box (300px canvas, 30 pad).
    const layout = layoutTrackPreview(
      segs([
        [0, 0],
        [400, 0],
        [400, 100],
      ]),
      { width: 300, height: 300, padding: 30 },
    );
    // Width is the binding axis: 240 / 400 = 0.6.
    expect(layout.scale).toBeCloseTo(0.6, 5);
  });

  it('handles a single point without dividing by zero (finite, on-canvas)', () => {
    const layout = layoutTrackPreview(segs([[50, 50]]), {
      width: 200,
      height: 100,
      padding: 10,
    });
    // A zero-span axis uses a unit span (scale = min(180, 80) = 80), so the lone
    // point lands at the box offset, not the exact canvas centre. What matters
    // is that it is finite and within the canvas.
    expect(layout.points).toHaveLength(1);
    expect(Number.isFinite(layout.points[0]!.x)).toBe(true);
    expect(Number.isFinite(layout.points[0]!.y)).toBe(true);
    expect(layout.points[0]!.x).toBeGreaterThanOrEqual(0);
    expect(layout.points[0]!.x).toBeLessThanOrEqual(200);
    expect(layout.points[0]!.y).toBeGreaterThanOrEqual(0);
    expect(layout.points[0]!.y).toBeLessThanOrEqual(100);
    expect(Number.isFinite(layout.scale)).toBe(true);
  });

  it('returns no points for an empty segment list', () => {
    const layout = layoutTrackPreview([], { width: 100, height: 100 });
    expect(layout.points).toHaveLength(0);
  });
});
