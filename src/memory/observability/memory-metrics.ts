import { getOrCreateCounter, getOrCreateHistogram, getOrCreateGauge } from '../../monitoring';
import type { MemoryMode } from '../session/MemoryModeResolver';
import type { SessionMessage, TenantId } from '../../domain/memory/session-types';

export type MemoryOperation =
  | 'create_session'
  | 'add_message'
  | 'consolidate_session'
  | 'get_context_window'
  | 'end_session';

export type SessionOperationOutcome = 'success' | 'error';

export type DualWriteOperation =
  | 'create_session'
  | 'add_message'
  | 'consolidate_session'
  | 'end_session';

export type DualWriteBackend = 'legacy' | 'openmemory';

export type { BackendName, GraphExpandOutcome } from '../../monitoring/memory-retrieval-metrics';
export {
  incrementHybridGraphNeighborsTotal,
  recordBackendError,
  recordHybridGraphExpandDuration,
} from '../../monitoring/memory-retrieval-metrics';

export type MultimodalIngestOutcome = 'success' | 'error';

const sessionCreateDuration = getOrCreateHistogram(
  'memory_session_create_duration_seconds',
  'Duration of memory.create_session operations',
  ['mode', 'outcome'],
);

const addMessageDuration = getOrCreateHistogram(
  'memory_add_message_duration_seconds',
  'Duration of memory.add_message operations',
  ['mode', 'outcome', 'role'],
);

const consolidateSessionDuration = getOrCreateHistogram(
  'memory_consolidate_session_duration_seconds',
  'Duration of memory.consolidate_session operations',
  ['mode', 'outcome', 'strategy'],
);

const getContextWindowDuration = getOrCreateHistogram(
  'memory_get_context_window_duration_seconds',
  'Duration of memory.get_context_window operations',
  ['mode', 'outcome'],
);

const endSessionDuration = getOrCreateHistogram(
  'memory_end_session_duration_seconds',
  'Duration of memory.end_session operations',
  ['mode', 'outcome'],
);

const activeSessionsGauge = getOrCreateGauge(
  'memory_active_sessions',
  'Number of active memory sessions',
  ['tenant_id', 'mode'],
);

const contextWindowTokensGauge = getOrCreateGauge(
  'memory_context_window_tokens',
  'Total tokens in current context window',
  ['mode'],
);

const sessionOperationsTotal = getOrCreateCounter(
  'memory_session_operations_total',
  'Total number of Memory API operations',
  ['operation', 'mode', 'outcome'],
);

const dualWriteOperationTotal = getOrCreateCounter(
  'memory_dualwrite_operation_total',
  'Dual-write backend operations by outcome',
  ['operation', 'backend', 'mode', 'outcome'],
);

const multimodalIngestDuration = getOrCreateHistogram(
  'memory_multimodal_ingest_duration_seconds',
  'Duration of multimodal ingest item processing in seconds',
  ['modality', 'source', 'mode', 'outcome'],
);

const multimodalIngestTotal = getOrCreateCounter(
  'memory_multimodal_ingest_total',
  'Total number of multimodal ingest items processed',
  ['modality', 'source', 'mode', 'outcome'],
);

const multimodalIngestErrorsTotal = getOrCreateCounter(
  'memory_multimodal_ingest_errors_total',
  'Total number of multimodal ingest errors',
  ['modality', 'source', 'mode', 'error_class'],
);

/**
 * Record latency for a high-level Memory API operation.
 */
export function recordSessionOperationDuration(
  params:
    | {
        operation: 'create_session';
        mode: MemoryMode;
        durationSeconds: number;
        outcome: SessionOperationOutcome;
      }
    | {
        operation: 'add_message';
        mode: MemoryMode;
        durationSeconds: number;
        outcome: SessionOperationOutcome;
        role: SessionMessage['role'];
      }
    | {
        operation: 'consolidate_session';
        mode: MemoryMode;
        durationSeconds: number;
        outcome: SessionOperationOutcome;
        strategy: 'auto' | 'full' | 'recent_window';
      }
    | {
        operation: 'get_context_window';
        mode: MemoryMode;
        durationSeconds: number;
        outcome: SessionOperationOutcome;
      }
    | {
        operation: 'end_session';
        mode: MemoryMode;
        durationSeconds: number;
        outcome: SessionOperationOutcome;
      },
): void {
  try {
    switch (params.operation) {
      case 'create_session':
        sessionCreateDuration.observe(
          {
            mode: params.mode,
            outcome: params.outcome,
          },
          params.durationSeconds,
        );
        break;
      case 'add_message':
        addMessageDuration.observe(
          {
            mode: params.mode,
            outcome: params.outcome,
            role: params.role,
          },
          params.durationSeconds,
        );
        break;
      case 'consolidate_session':
        consolidateSessionDuration.observe(
          {
            mode: params.mode,
            outcome: params.outcome,
            strategy: params.strategy,
          },
          params.durationSeconds,
        );
        break;
      case 'get_context_window':
        getContextWindowDuration.observe(
          {
            mode: params.mode,
            outcome: params.outcome,
          },
          params.durationSeconds,
        );
        break;
      case 'end_session':
        endSessionDuration.observe(
          {
            mode: params.mode,
            outcome: params.outcome,
          },
          params.durationSeconds,
        );
        break;
      default:
        break;
    }
  } catch {
    // Metrics must never break business logic.
  }
}

export function incrementSessionOperationTotal(params: {
  operation: MemoryOperation;
  mode: MemoryMode;
  outcome: SessionOperationOutcome;
}): void {
  try {
    sessionOperationsTotal.inc({
      operation: params.operation,
      mode: params.mode,
      outcome: params.outcome,
    });
  } catch {
    // ignore
  }
}

export function updateActiveSessions(params: {
  tenantId: TenantId;
  mode: MemoryMode;
  delta?: number;
  absoluteValue?: number;
}): void {
  try {
    const labels = {
      tenant_id: params.tenantId,
      mode: params.mode,
    };

    if (typeof params.absoluteValue === 'number') {
      activeSessionsGauge.set(labels, params.absoluteValue);
      return;
    }

    const delta = params.delta ?? 0;
    if (delta === 0) {
      return;
    }

    if (delta > 0) {
      activeSessionsGauge.inc(labels, delta);
    } else {
      activeSessionsGauge.dec(labels, -delta);
    }
  } catch {
    // ignore
  }
}

export function updateContextWindowTokens(params: {
  tokens: number;
  mode: MemoryMode;
}): void {
  try {
    contextWindowTokensGauge.set({ mode: params.mode }, params.tokens);
  } catch {
    // ignore
  }
}

export function recordDualWriteOutcome(params: {
  operation: DualWriteOperation;
  backend: DualWriteBackend;
  mode: MemoryMode;
  outcome: SessionOperationOutcome;
}): void {
  try {
    dualWriteOperationTotal.inc({
      operation: params.operation,
      backend: params.backend,
      mode: params.mode,
      outcome: params.outcome,
    });
  } catch {
    // ignore
  }
}

function classifyBackendError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();

  if (lower.includes('timeout') || lower.includes('etimedout')) {
    return 'timeout';
  }

  if (
    lower.includes('unavailable') ||
    lower.includes('econnrefused') ||
    lower.includes('econnreset') ||
    lower.includes('enotfound')
  ) {
    return 'unavailable';
  }

  if (lower.includes('bad request') || lower.includes('4xx')) {
    return 'bad_request';
  }

  return 'unknown';
}

function normalizeMultimodalSource(source?: string): string {
  if (!source) {
    return 'unknown';
  }
  const value = String(source).trim().toLowerCase();

  if (value === 'mas' || value === 'plugin' || value === 'api') {
    return value;
  }

  return 'other';
}

function normalizeMultimodalMode(mode?: MemoryMode): string {
  return mode ?? 'unknown';
}

export function recordMultimodalIngestDuration(params: {
  modality: string;
  source?: string;
  mode?: MemoryMode;
  outcome: MultimodalIngestOutcome;
  durationSeconds: number;
}): void {
  try {
    multimodalIngestDuration.observe(
      {
        modality: params.modality,
        source: normalizeMultimodalSource(params.source),
        mode: normalizeMultimodalMode(params.mode),
        outcome: params.outcome,
      },
      params.durationSeconds,
    );
  } catch {
    // Metrics must never break business logic.
  }
}

export function incrementMultimodalIngestTotal(params: {
  modality: string;
  source?: string;
  mode?: MemoryMode;
  outcome: MultimodalIngestOutcome;
}): void {
  try {
    multimodalIngestTotal.inc({
      modality: params.modality,
      source: normalizeMultimodalSource(params.source),
      mode: normalizeMultimodalMode(params.mode),
      outcome: params.outcome,
    });
  } catch {
    // ignore
  }
}

export function recordMultimodalIngestError(params: {
  modality?: string;
  source?: string;
  mode?: MemoryMode;
  error: unknown;
}): void {
  try {
    const errorClass = classifyBackendError(params.error);
    multimodalIngestErrorsTotal.inc({
      modality: params.modality ?? 'unknown',
      source: normalizeMultimodalSource(params.source),
      mode: normalizeMultimodalMode(params.mode),
      error_class: errorClass,
    });
  } catch {
    // ignore
  }
}