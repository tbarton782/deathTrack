/**
 * Smoke tests for `@deathtrack/shared` package index.
 *
 * Verifies that every module within the shared package can be imported without
 * throwing, satisfying the requirement that the scaffolded monorepo loads cleanly.
 *
 * Requirements: 13.1
 */

import { describe, it, expect } from 'vitest';

describe('@deathtrack/shared smoke tests', () => {
  it('imports primitives module without throwing', async () => {
    const mod = await import('../types/primitives.js');
    expect(mod).toBeDefined();
  });

  it('imports physics module without throwing', async () => {
    const mod = await import('../types/physics.js');
    expect(mod).toBeDefined();
  });

  it('imports weapons module without throwing', async () => {
    const mod = await import('../types/weapons.js');
    expect(mod).toBeDefined();
  });

  it('imports car module without throwing', async () => {
    const mod = await import('../types/car.js');
    expect(mod).toBeDefined();
  });

  it('imports track module without throwing', async () => {
    const mod = await import('../types/track.js');
    expect(mod).toBeDefined();
  });

  it('imports career module without throwing', async () => {
    const mod = await import('../types/career.js');
    expect(mod).toBeDefined();
  });

  it('imports network module without throwing', async () => {
    const mod = await import('../types/network.js');
    expect(mod).toBeDefined();
  });

  it('imports ai module without throwing', async () => {
    const mod = await import('../types/ai.js');
    expect(mod).toBeDefined();
  });

  it('imports package index without throwing', async () => {
    const mod = await import('../index.js');
    expect(mod).toBeDefined();
  });
});
