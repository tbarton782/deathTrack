/**
 * Chunk-tree probe (task 25.3).
 *
 * Walks a directory of real Death Track game files and records each file's
 * Dynamix RES chunk structure — the chunk IDs, container flags, byte lengths,
 * and nesting depth — into a structured report. This is the diagnostic that
 * drove the section-25 reverse engineering: it reveals which files are
 * chunk-wrapped (`PAL:`, `BMP:`, `FNT:`, …) versus raw payloads (`.TRK`, which
 * is not a chunk tree), and the exact container layout of the chunk-wrapped
 * ones.
 *
 * The report builder ({@link buildChunkReport}) is a pure function of parsed
 * chunk nodes so it is unit-testable without any real files; the directory
 * walker ({@link probeChunkDir}) reads files and tolerates non-chunk files by
 * recording the parse error rather than throwing.
 *
 * Requirements: 9.1
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { parseChunks, ChunkParseError, type ChunkNode } from './parsers/ChunkReader.js';

/** A flattened description of one chunk node in a file's tree. */
export interface ChunkReportNode {
  /** Nesting depth (0 = top-level chunk). */
  depth: number;
  /** 3-character chunk ID (colon stripped). */
  id: string;
  /** Whether this chunk is a container of nested chunks. */
  isContainer: boolean;
  /** Data length in bytes (low 31 bits of the length word). */
  length: number;
  /** Byte offset of this chunk's header in the file. */
  offset: number;
}

/** The probe result for a single file. */
export interface FileChunkReport {
  /** File name (basename). */
  file: string;
  /** Total file size in bytes. */
  byteLength: number;
  /**
   * Flattened, depth-first list of chunk nodes when the file parses as a chunk
   * tree; empty when {@link parseError} is set.
   */
  nodes: ChunkReportNode[];
  /**
   * The parse error message when the file is NOT a valid chunk tree (e.g. the
   * raw `.TRK` payload, whose leading bytes are not a `XXX:` tag). `null` when
   * the file parsed cleanly.
   */
  parseError: string | null;
}

/**
 * Flatten a parsed chunk tree into a depth-first list of report nodes.
 * Pure — no I/O — so it can be unit-tested against synthetic chunk bytes.
 */
export function buildChunkReport(nodes: ChunkNode[], depth = 0): ChunkReportNode[] {
  const out: ChunkReportNode[] = [];
  for (const node of nodes) {
    out.push({
      depth,
      id: node.id,
      isContainer: node.isContainer,
      length: node.length,
      offset: node.offset,
    });
    if (node.isContainer && node.children.length > 0) {
      out.push(...buildChunkReport(node.children, depth + 1));
    }
  }
  return out;
}

/**
 * Parse a single file's bytes into a {@link FileChunkReport}. A file that is not
 * a valid chunk tree (a raw payload) is reported with its `parseError` rather
 * than throwing, so the probe can walk a mixed directory.
 */
export function reportFile(file: string, bytes: Uint8Array): FileChunkReport {
  try {
    const nodes = parseChunks(bytes);
    return { file, byteLength: bytes.length, nodes: buildChunkReport(nodes), parseError: null };
  } catch (err) {
    const message =
      err instanceof ChunkParseError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    return { file, byteLength: bytes.length, nodes: [], parseError: message };
  }
}

/**
 * Render a set of file reports as a readable indented text report.
 */
export function formatChunkReport(reports: readonly FileChunkReport[]): string {
  const lines: string[] = [];
  for (const r of reports) {
    lines.push(`${r.file}  (${r.byteLength} bytes)`);
    if (r.parseError !== null) {
      lines.push(`  [not a chunk tree] ${r.parseError}`);
    } else if (r.nodes.length === 0) {
      lines.push('  (empty)');
    } else {
      for (const n of r.nodes) {
        const indent = '  '.repeat(n.depth + 1);
        const kind = n.isContainer ? 'container' : 'leaf';
        lines.push(`${indent}${n.id}: ${kind} len=${n.length} @0x${n.offset.toString(16)}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Walk a directory and probe every file's chunk structure. Sub-directories are
 * ignored (the Death Track asset folder is flat). Files are read and reported
 * in sorted order for deterministic output.
 *
 * @param dir Directory of game files.
 * @returns One {@link FileChunkReport} per file, sorted by name.
 */
export async function probeChunkDir(dir: string): Promise<FileChunkReport[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile())
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const reports: FileChunkReport[] = [];
  for (const name of files) {
    const bytes = new Uint8Array(await fs.readFile(path.join(dir, name)));
    reports.push(reportFile(name, bytes));
  }
  return reports;
}
