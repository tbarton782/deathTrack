import { describe, expect, it } from 'vitest';
import { Container } from 'pixi.js';
import {
  createLayers,
  DRAW_LAYER_NAMES,
  type DrawLayerName,
} from '../Renderer';

/**
 * These tests exercise only the GPU-free layer scaffolding produced by
 * {@link createLayers}. PixiJS {@link Container} instances construct without a
 * WebGL context, so this runs headless in the `node` vitest environment.
 *
 * The actual `PIXI.Application` WebGL init (Renderer.init) requires a real
 * canvas / GPU and is validated in the browser, not here.
 *
 * Validates: Requirements 2.2 (draw order: road surface, track boundaries,
 * scenery, hazards, ...).
 */
describe('createLayers', () => {
  it('creates exactly the eight documented draw layers', () => {
    const layers = createLayers();
    expect(Object.keys(layers)).toEqual([...DRAW_LAYER_NAMES]);
    expect(DRAW_LAYER_NAMES).toHaveLength(8);
  });

  it('orders layers back-to-front per the design spec', () => {
    const expected: DrawLayerName[] = [
      'roadSurface',
      'trackBoundaries',
      'scenery',
      'hazards',
      'cars',
      'projectiles',
      'explosions',
      'hud',
    ];
    expect([...DRAW_LAYER_NAMES]).toEqual(expected);
  });

  it('produces a PixiJS Container per layer, labelled by name', () => {
    const layers = createLayers();
    for (const name of DRAW_LAYER_NAMES) {
      expect(layers[name]).toBeInstanceOf(Container);
      expect(layers[name].label).toBe(name);
    }
  });

  it('produces distinct container instances', () => {
    const layers = createLayers();
    const instances = new Set(DRAW_LAYER_NAMES.map((n) => layers[n]));
    expect(instances.size).toBe(DRAW_LAYER_NAMES.length);
  });

  it('places road surface first and HUD last', () => {
    expect(DRAW_LAYER_NAMES[0]).toBe('roadSurface');
    expect(DRAW_LAYER_NAMES[DRAW_LAYER_NAMES.length - 1]).toBe('hud');
  });
});
