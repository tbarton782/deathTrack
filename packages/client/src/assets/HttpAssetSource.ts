/**
 * Browser {@link AssetSource} that fetches pre-converted `.dtasset` containers
 * over HTTP (task 25.14).
 *
 * The shared {@link BinaryAssetLoader} is transport-agnostic: it asks an
 * `AssetSource` for the bytes at a path (e.g. `assets/tracks/orlando.dtasset`)
 * and handles all framing/decoding. In the browser those containers are static
 * files served from the client's `public/` directory, so this source maps the
 * loader's path onto a URL and fetches it. (Tests and Node prototyping use the
 * in-memory source shipped in `shared`.)
 *
 * Requirements: 9.2, 9.5
 */

import type { AssetSource } from '@deathtrack/shared';

/** A `fetch`-like function, injectable so the source stays unit-testable. */
export type FetchLike = (input: string) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** Options for {@link HttpAssetSource}. */
export interface HttpAssetSourceOptions {
  /**
   * URL prefix prepended to every asset path. Defaults to `'/'` so a loader
   * path like `assets/tracks/orlando.dtasset` becomes `/assets/tracks/…`,
   * matching files served from the client's `public/` root.
   */
  baseUrl?: string;
  /** Override the fetch implementation (defaults to the global `fetch`). */
  fetchImpl?: FetchLike;
}

/**
 * An {@link AssetSource} that resolves container bytes by HTTP `fetch`. A
 * non-OK response rejects, mirroring how the in-memory source rejects an
 * unknown path, so the loader surfaces it as the appropriate typed error.
 */
export class HttpAssetSource implements AssetSource {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: HttpAssetSourceOptions = {}) {
    const prefix = options.baseUrl ?? '/';
    this.baseUrl = prefix.endsWith('/') ? prefix : `${prefix}/`;
    const fetchImpl = options.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) {
      throw new Error('HttpAssetSource: no fetch implementation available');
    }
    this.fetchImpl = fetchImpl;
  }

  async readAsset(path: string): Promise<Uint8Array> {
    // The loader passes paths without a leading slash; join onto the base URL.
    const rel = path.startsWith('/') ? path.slice(1) : path;
    const url = `${this.baseUrl}${rel}`;
    const response = await this.fetchImpl(url);
    if (!response.ok) {
      throw new Error(`HttpAssetSource: GET ${url} failed with status ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }
}
