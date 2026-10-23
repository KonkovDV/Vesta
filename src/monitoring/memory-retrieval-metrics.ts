/**
 * Counters for hybrid retrieval and backend failures.
 * Layer: Monitoring
 */

import { getOrCreateCounter, getOrCreateHistogram } from './registry';

export type BackendName = 'legacy' | 'openmemory' | 'hsg' | 'vector' | 'session' | 'facts' | 'text';
export type GraphExpandOutcome = 'success' | 'error';

const backendErrorsTotal = getOrCreateCounter(
  'memory_backend_errors_total',
  'Total number of memory backend errors',
  ['backend', 'operation', 'error_class'],
);

const hybridGraphExpandDuration = getOrCreateHistogram(
  'memory_hybrid_graph_expand_duration_seconds',
  'Duration of graph-aware expand+rescore step in HybridMemoryRetrievalService',
  ['outcome'],
);

const hybridGraphNeighborsTotal = getOrCreateCounter(
  'memory_hybrid_graph_neighbors_total',
  'Total number of graph neighbors added during HybridMemoryRetrievalService retrieval',
  ['outcome'],
);

function classifyBackendError(error: unknown): string {
  try {
    const message = error instanceof Error ? error.message : String(error ?? '');
    const lower = message.toLowerCase();
    if (lower.includes('timeout') || lower.includes('etimedout')) return 'timeout';
    if (
      lower.includes('unavailable') ||
      lower.includes('econnrefused') ||
      lower.includes('econnreset') ||
      lower.includes('enotfound')
    ) {
      return 'unavailable';
    }
    if (lower.includes('bad request') || lower.includes('4xx')) return 'bad_request';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function recordBackendError(params: {
  backend: BackendName;
  operation: string;
  error: unknown;
  mode?: string;
}): void {
  try {
    backendErrorsTotal.inc({
      backend: params.backend,
      operation: params.operation,
      error_class: classifyBackendError(params.error),
    });
  } catch {
    // A metric must not hide the retrieval result.
  }
}

export function recordHybridGraphExpandDuration(params: {
  outcome: GraphExpandOutcome;
  durationSeconds: number;
}): void {
  try {
    hybridGraphExpandDuration.observe({ outcome: params.outcome }, params.durationSeconds);
  } catch {
    // A metric must not hide the retrieval result.
  }
}

export function incrementHybridGraphNeighborsTotal(params: {
  outcome: GraphExpandOutcome;
  count: number;
}): void {
  try {
    if (params.count <= 0) return;
    hybridGraphNeighborsTotal.inc({ outcome: params.outcome }, params.count);
  } catch {
    // A metric must not hide the retrieval result.
  }
}
