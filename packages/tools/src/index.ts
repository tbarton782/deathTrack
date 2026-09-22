/**
 * Public programmatic entry point for `@deathtrack/tools`.
 *
 * The tools package ships an asset-conversion CLI (`deathtrack-tools`), but its
 * conversion functions are also importable so other workspace packages (e.g.
 * the integration tests) can run the real pipeline in-process without spawning
 * a subprocess. Only the stable, section-25 real-asset surface is re-exported
 * here; the internal per-format decoders remain reachable via their own module
 * paths for the tools' own unit tests.
 */

export {
  convertReal,
  type RealConversionResult,
  type RealConversionError,
  type ConvertRealOptions,
  type Logger,
} from './realPipeline.js';

export { AssetKind, encodeAsset, decodeAsset } from './cli.js';

export {
  probeChunkDir,
  reportFile,
  buildChunkReport,
  formatChunkReport,
  type FileChunkReport,
  type ChunkReportNode,
} from './chunkProbe.js';
