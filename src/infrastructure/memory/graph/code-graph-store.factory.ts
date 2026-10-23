/**
 * Shared runtime selector for the Code Knowledge Graph store.
 *
 * Keeps DI modules and the standalone MCP server aligned on one policy:
 * - Use Kuzu when CODE_GRAPH_KUZU_PATH is configured and the adapter loads
 * - Fall back honestly to InMemory when Kuzu is unavailable
 */

import type { ICodeGraphStore } from '../../../domain/memory/ICodeGraphStore';
import { InMemoryCodeGraphAdapter } from './InMemoryCodeGraphAdapter';

export interface CodeGraphStoreFactoryOptions {
  readonly kuzuPath?: string;
  readonly createKuzuStore?: (kuzuPath: string) => ICodeGraphStore;
  readonly createFallbackStore?: () => ICodeGraphStore;
}

export interface CodeGraphStoreSelection {
  readonly store: ICodeGraphStore;
  readonly backend: 'kuzu' | 'in-memory';
  readonly kuzuPath?: string;
  readonly reason?: string;
}

function defaultCreateKuzuStore(kuzuPath: string): ICodeGraphStore {
  const { KuzuCodeGraphAdapter } = require('./KuzuCodeGraphAdapter');
  return new KuzuCodeGraphAdapter(kuzuPath);
}

export function createCodeGraphStoreFromEnv(
  options: CodeGraphStoreFactoryOptions = {},
): CodeGraphStoreSelection {
  const kuzuPath = options.kuzuPath ?? process.env.CODE_GRAPH_KUZU_PATH;
  const createFallbackStore = options.createFallbackStore ?? (() => new InMemoryCodeGraphAdapter());

  if (!kuzuPath) {
    return {
      store: createFallbackStore(),
      backend: 'in-memory',
    };
  }

  const createKuzuStore = options.createKuzuStore ?? defaultCreateKuzuStore;

  try {
    return {
      store: createKuzuStore(kuzuPath),
      backend: 'kuzu',
      kuzuPath,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      store: createFallbackStore(),
      backend: 'in-memory',
      kuzuPath,
      reason: `Failed to initialize Kuzu-backed CodeGraphStore: ${reason}`,
    };
  }
}