/**
 * Unit and property tests for the projectile round-trip validation guard.
 *
 * Requirement 3.10: before a projectile packet is transmitted it must be
 * encoded then decoded, and if any field of the decoded projectile differs from
 * the original the packet is rejected (not transmitted).
 *
 * These tests verify:
 *   - a well-formed projectile round-trips field-for-field and is accepted;
 *   - {@link validateProjectileRoundTrip} returns `true` for accepted packets;
 *   - a projectile carrying an out-of-range / unknown field is rejected;
 *   - the guard is total (never throws) and holds across arbitrary inputs.
 *
 * Requirements: 3.10
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import type { ActiveProjectile } from '../../types/weapons.js';
import type { WeaponId } from '../../types/primitives.js';
import {
  ProjectileCodec,
  validateProjectileRoundTrip,
  WEAPON_ID_ORDER,
} from '../ProjectileCodec.js';

/** A concrete, representative valid projectile used by the example tests. */
const sampleProjectile: ActiveProjectile = {
  id: 42,
  ownerId: 3,
  weaponId: 'missile',
  position: { x: 123.5, y: -87.25 },
  velocity: { x: -4.5, y: 12.75 },
  spawnTick: 1000,
};

describe('ProjectileCodec round-trip (Requirement 3.10)', () => {
  it('encode -> decode reproduces every field of a valid projectile', () => {
    const decoded = ProjectileCodec.decode(ProjectileCodec.encode(sampleProjectile));
    expect(decoded).toEqual(sampleProjectile);
  });

  it('preserves each weapon id in the catalogue across the round-trip', () => {
    for (const weaponId of WEAPON_ID_ORDER) {
      const projectile: ActiveProjectile = { ...sampleProjectile, weaponId };
      const decoded = ProjectileCodec.decode(ProjectileCodec.encode(projectile));
      expect(decoded.weaponId).toBe(weaponId);
    }
  });
});

describe('validateProjectileRoundTrip (Requirement 3.10)', () => {
  it('accepts a well-formed projectile', () => {
    expect(validateProjectileRoundTrip(sampleProjectile)).toBe(true);
  });

  it('accepts projectiles with zeroed position and velocity', () => {
    const projectile: ActiveProjectile = {
      id: 0,
      ownerId: 0,
      weaponId: 'machine_gun',
      position: { x: 0, y: 0 },
      velocity: { x: 0, y: 0 },
      spawnTick: 0,
    };
    expect(validateProjectileRoundTrip(projectile)).toBe(true);
  });

  it('rejects a projectile whose weaponId is not in the catalogue', () => {
    // A weaponId outside WEAPON_ID_ORDER encodes to the unknown sentinel and
    // decodes to a value that differs from the original, so it is rejected.
    const corrupted = {
      ...sampleProjectile,
      weaponId: 'plasma_rifle' as WeaponId,
    };
    expect(validateProjectileRoundTrip(corrupted)).toBe(false);
  });

  it('rejects a projectile whose id exceeds the uint32 wire range', () => {
    // 2^32 cannot be represented by the uint32 id field, so the decoded id
    // differs from the original and the packet is rejected.
    const corrupted: ActiveProjectile = { ...sampleProjectile, id: 2 ** 32 };
    expect(validateProjectileRoundTrip(corrupted)).toBe(false);
  });

  it('rejects a projectile whose ownerId exceeds the uint8 wire range', () => {
    const corrupted: ActiveProjectile = { ...sampleProjectile, ownerId: 300 };
    expect(validateProjectileRoundTrip(corrupted)).toBe(false);
  });

  it('is total: never throws for arbitrary structurally-typed input', () => {
    fc.assert(
      fc.property(
        fc.record({
          id: fc.integer(),
          ownerId: fc.integer(),
          weaponId: fc.string(),
          position: fc.record({ x: fc.double(), y: fc.double() }),
          velocity: fc.record({ x: fc.double(), y: fc.double() }),
          spawnTick: fc.integer(),
        }),
        (candidate) => {
          const result = validateProjectileRoundTrip(candidate as ActiveProjectile);
          expect(typeof result).toBe('boolean');
        },
      ),
    );
  });

  it('accepts every well-formed projectile the generator produces', () => {
    const arbProjectile: fc.Arbitrary<ActiveProjectile> = fc.record({
      id: fc.integer({ min: 0, max: 2 ** 32 - 1 }),
      ownerId: fc.integer({ min: 0, max: 7 }),
      weaponId: fc.constantFrom(...WEAPON_ID_ORDER),
      // Finite, non-NaN doubles round-trip exactly through float64.
      position: fc.record({
        x: fc.double({ noNaN: true, noDefaultInfinity: true }),
        y: fc.double({ noNaN: true, noDefaultInfinity: true }),
      }),
      velocity: fc.record({
        x: fc.double({ noNaN: true, noDefaultInfinity: true }),
        y: fc.double({ noNaN: true, noDefaultInfinity: true }),
      }),
      spawnTick: fc.integer({ min: 0, max: 2 ** 32 - 1 }),
    });

    fc.assert(
      fc.property(arbProjectile, (projectile) => {
        expect(validateProjectileRoundTrip(projectile)).toBe(true);
      }),
    );
  });
});
