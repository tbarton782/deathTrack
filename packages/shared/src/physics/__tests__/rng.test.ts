/**
 * Unit and property tests for the seeded xorshift64 {@link mkRNG}.
 *
 * Verifies determinism (same seed -> identical sequence), interface conformance,
 * output range bounds for `next()` and `nextInt()`, and distribution sanity.
 *
 * Requirements: 1.9
 */

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { mkRNG } from '../rng.js';

describe('mkRNG interface conformance', () => {
  it('exposes the seed it was created with', () => {
    expect(mkRNG(42).seed).toBe(42);
    expect(mkRNG(0).seed).toBe(0);
    expect(mkRNG(-7).seed).toBe(-7);
  });

  it('never calls Math.random in its implementation', async () => {
    // Guard against accidental reintroduction of Math.random in executable code.
    // Comment mentions (e.g. documenting the no-Math.random contract) are stripped
    // first so the guard only inspects real statements.
    const fs = await import('node:fs');
    const url = await import('node:url');
    const raw = fs.readFileSync(
      url.fileURLToPath(new URL('../rng.ts', import.meta.url)),
      'utf8',
    );
    const withoutBlockComments = raw.replace(/\/\*[\s\S]*?\*\//g, '');
    const withoutComments = withoutBlockComments
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n');
    expect(/Math\s*\.\s*random\s*\(/.test(withoutComments)).toBe(false);
  });
});

describe('mkRNG.next range', () => {
  it('produces values in [0, 1)', () => {
    const rng = mkRNG(123);
    for (let i = 0; i < 10_000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('mkRNG.nextInt', () => {
  it('produces integers within the inclusive range', () => {
    const rng = mkRNG(999);
    for (let i = 0; i < 10_000; i++) {
      const v = rng.nextInt(3, 9);
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(3);
      expect(v).toBeLessThanOrEqual(9);
    }
  });

  it('returns min when min === max', () => {
    const rng = mkRNG(5);
    for (let i = 0; i < 100; i++) {
      expect(rng.nextInt(4, 4)).toBe(4);
    }
  });

  it('supports negative ranges', () => {
    const rng = mkRNG(77);
    for (let i = 0; i < 5_000; i++) {
      const v = rng.nextInt(-5, 5);
      expect(v).toBeGreaterThanOrEqual(-5);
      expect(v).toBeLessThanOrEqual(5);
    }
  });

  it('throws when min > max', () => {
    expect(() => mkRNG(1).nextInt(5, 4)).toThrow(RangeError);
  });

  it('throws on non-integer bounds', () => {
    expect(() => mkRNG(1).nextInt(0.5, 4)).toThrow(RangeError);
  });
});

describe('mkRNG determinism', () => {
  it('produces an identical next() sequence for the same seed', () => {
    const a = mkRNG(2024);
    const b = mkRNG(2024);
    const seqA = Array.from({ length: 1000 }, () => a.next());
    const seqB = Array.from({ length: 1000 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = Array.from({ length: 50 }, () => mkRNG(1).next());
    const b = Array.from({ length: 50 }, () => mkRNG(2).next());
    expect(a).not.toEqual(b);
  });

  it('advances state across mixed next()/nextInt() calls consistently', () => {
    const a = mkRNG(88);
    const b = mkRNG(88);
    const seqA: number[] = [];
    const seqB: number[] = [];
    for (let i = 0; i < 200; i++) {
      seqA.push(a.next(), a.nextInt(0, 100));
      seqB.push(b.next(), b.nextInt(0, 100));
    }
    expect(seqA).toEqual(seqB);
  });

  it('treats seed 0 as a valid non-degenerate seed', () => {
    const rng = mkRNG(0);
    const values = new Set(Array.from({ length: 100 }, () => rng.next()));
    // A working generator yields many distinct values, not a constant.
    expect(values.size).toBeGreaterThan(50);
  });
});

describe('property: mkRNG', () => {
  it('same seed always yields identical sequences', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 1, max: 200 }), (seed, n) => {
        const a = mkRNG(seed);
        const b = mkRNG(seed);
        const seqA = Array.from({ length: n }, () => a.next());
        const seqB = Array.from({ length: n }, () => b.next());
        expect(seqA).toEqual(seqB);
      }),
      { numRuns: 500 },
    );
  });

  it('next() output always lies in [0, 1)', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer({ min: 1, max: 500 }), (seed, n) => {
        const rng = mkRNG(seed);
        for (let i = 0; i < n; i++) {
          const v = rng.next();
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThan(1);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('nextInt output always lies within the requested inclusive range', () => {
    const boundsArb = fc
      .tuple(fc.integer({ min: -1000, max: 1000 }), fc.integer({ min: 0, max: 2000 }))
      .map(([min, span]) => [min, min + span] as const);

    fc.assert(
      fc.property(boundsArb, ([min, max]) => {
        const rng = mkRNG(min ^ max);
        for (let i = 0; i < 50; i++) {
          const v = rng.nextInt(min, max);
          expect(v).toBeGreaterThanOrEqual(min);
          expect(v).toBeLessThanOrEqual(max);
          expect(Number.isInteger(v)).toBe(true);
        }
      }),
      { numRuns: 300 },
    );
  });

  it('nextInt covers every value in a small range (distribution sanity)', () => {
    fc.assert(
      fc.property(fc.integer(), (seed) => {
        const rng = mkRNG(seed);
        const seen = new Set<number>();
        for (let i = 0; i < 2000; i++) {
          seen.add(rng.nextInt(0, 5));
        }
        // Over 2000 draws into a 6-value range, every bucket should appear.
        expect(seen.size).toBe(6);
      }),
      { numRuns: 100 },
    );
  });
});
