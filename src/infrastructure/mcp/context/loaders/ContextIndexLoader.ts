/**
 * ContextIndexLoader — Loads and caches CONTEXT_INDEX.json.
 *
 * Layer: Infrastructure (dev-time)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ContextIndex {
  sys: string;
  metrics: Record<string, unknown>;
  entrypoint: string;
  layers: Record<string, unknown>;
  di_tokens_key: Record<string, string[]>;
  error_recovery: Record<string, string>;
  file_placement: Record<string, string>;
  task_routing: Record<string, string[]>;
  invariants: string[];
  [key: string]: unknown;
}

export class ContextIndexLoader {
  private static cache: ContextIndex | null = null;

  static load(projectRoot: string): ContextIndex {
    if (this.cache) return this.cache;

    const filePath = path.join(projectRoot, 'CONTEXT_INDEX.json');
    if (!fs.existsSync(filePath)) {
      throw new Error(`CONTEXT_INDEX.json not found at ${filePath}`);
    }

    const raw = fs.readFileSync(filePath, 'utf-8');
    this.cache = JSON.parse(raw) as ContextIndex;
    return this.cache;
  }

  static invalidate(): void {
    this.cache = null;
  }

  /**
   * Reads a text file from disk. Returns undefined if not found.
   * Convenience wrapper for loaders that need fs access without direct import.
   */
  static readTextFile(filePath: string): string | undefined {
    if (!fs.existsSync(filePath)) return undefined;
    return fs.readFileSync(filePath, 'utf-8');
  }
}
