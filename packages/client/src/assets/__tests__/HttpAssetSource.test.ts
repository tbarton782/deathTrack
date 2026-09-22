import { describe, it, expect } from 'vitest';

import { HttpAssetSource, type FetchLike } from '../HttpAssetSource.js';

/** Build a fake fetch that serves a fixed byte map keyed by URL. */
function fakeFetch(map: Record<string, Uint8Array>): { fn: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fn: FetchLike = async (input) => {
    calls.push(input);
    const bytes = map[input];
    if (bytes === undefined) {
      return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) };
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    };
  };
  return { fn, calls };
}

describe('HttpAssetSource', () => {
  it('maps a loader path onto a URL under the default root and returns the bytes', async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    const { fn, calls } = fakeFetch({ '/assets/tracks/orlando.dtasset': payload });
    const source = new HttpAssetSource({ fetchImpl: fn });

    const bytes = await source.readAsset('assets/tracks/orlando.dtasset');
    expect(Array.from(bytes)).toEqual([1, 2, 3, 4]);
    expect(calls).toEqual(['/assets/tracks/orlando.dtasset']);
  });

  it('honours a custom base URL', async () => {
    const payload = new Uint8Array([9]);
    const { fn, calls } = fakeFetch({ 'https://cdn.example/game/assets/x.dtasset': payload });
    const source = new HttpAssetSource({ baseUrl: 'https://cdn.example/game', fetchImpl: fn });

    await source.readAsset('assets/x.dtasset');
    expect(calls).toEqual(['https://cdn.example/game/assets/x.dtasset']);
  });

  it('rejects on a non-OK response', async () => {
    const { fn } = fakeFetch({});
    const source = new HttpAssetSource({ fetchImpl: fn });
    await expect(source.readAsset('assets/missing.dtasset')).rejects.toThrow(/status 404/);
  });

  it('throws at construction when no fetch is available (no option, no global)', () => {
    const savedFetch = (globalThis as { fetch?: unknown }).fetch;
    // Simulate an environment with no global fetch and no injected impl.
    delete (globalThis as { fetch?: unknown }).fetch;
    try {
      expect(() => new HttpAssetSource()).toThrow(/no fetch/);
    } finally {
      if (savedFetch !== undefined) (globalThis as { fetch?: unknown }).fetch = savedFetch;
    }
  });
});
