import { getOrCreateCounter, getOrCreateHistogram } from '../../../monitoring';
import type { MasOperationOutcome } from './mas-metrics';
import type { MasStepKind } from '../memory/mas-memory.port';
import type {
  MemoryGovernanceScope,
  MemoryGovernanceReasonCode,
} from '../../../domain/memory/governance/memory-governance.types';

export type GovernanceStatus =
  | 'ok'
  | 'deny'
  | 'allow_with_modifications'
  | 'fallback'
  | 'unknown';

const masMemoryContextRequestsTotal = getOrCreateCounter(
  'mas_memory_context_requests_total',
  'Total number of MAS ⇄ Memory context window requests',
  ['scenario', 'use_case', 'outcome', 'governance_status'],
);

const masMemoryContextRequestDurationSeconds = getOrCreateHistogram(
  'mas_memory_context_request_duration_seconds',
  'Duration of MAS ⇄ Memory context window requests in seconds',
  ['scenario', 'use_case', 'outcome', 'governance_status'],
);

const masMemoryAppendTotal = getOrCreateCounter(
  'mas_memory_append_total',
  'Total number of MAS ⇄ Memory append operations',
  ['scenario', 'use_case', 'step_kind', 'outcome', 'governance_status'],
);

const masMemoryAppendDurationSeconds = getOrCreateHistogram(
  'mas_memory_append_duration_seconds',
  'Duration of MAS ⇄ Memory append operations in seconds',
  ['scenario', 'use_case', 'step_kind', 'outcome', 'governance_status'],
);

const masMemoryGovernanceDeniedTotal = getOrCreateCounter(
  'mas_memory_governance_denied_total',
  'Total number of MAS-visible Memory governance denies',
  ['operation', 'scope', 'reason'],
);

function normalizeScenario(scenario: string | undefined): string {
  if (!scenario) return '__unknown__';
  const trimmed = scenario.trim();
  if (!trimmed) return '__unknown__';
  return trimmed.slice(0, 100);
}

function normalizeUseCase(useCase: string | undefined): string {
  if (!useCase) return '__none__';
  const trimmed = useCase.trim();
  if (!trimmed) return '__none__';
  return trimmed.slice(0, 100);
}

function normalizeGovernanceStatus(
  status: GovernanceStatus | undefined,
): GovernanceStatus {
  if (!status) {
    return 'unknown';
  }

  if (
    status === 'ok' ||
    status === 'deny' ||
    status === 'allow_with_modifications' ||
    status === 'fallback' ||
    status === 'unknown'
  ) {
    return status;
  }

  return 'unknown';
}

/**
 * Record MAS ⇄ Memory context-window request metrics (reads).
 *
 * Labels:
 * - scenario/use_case — high-level business routing identifiers;
 * - outcome          — success/error from MAS perspective;
 * - governanceStatus — MAS-visible governance status ('ok'/'deny'/...).
 */
export function recordMasMemoryContextRequest(input: {
  scenario?: string;
  useCase?: string;
  outcome: MasOperationOutcome;
  governanceStatus?: GovernanceStatus;
  durationSeconds: number;
}): void {
  try {
    const labels = {
      scenario: normalizeScenario(input.scenario),
      use_case: normalizeUseCase(input.useCase),
      outcome: input.outcome,
      governance_status: normalizeGovernanceStatus(input.governanceStatus),
    };

    masMemoryContextRequestsTotal.inc(labels);
    masMemoryContextRequestDurationSeconds.observe(labels, input.durationSeconds);
  } catch {
    // Metrics must never break MAS Runtime business logic.
  }
}

/**
 * Record MAS ⇄ Memory append/finalize operations (writes).
 *
 * Emitted at MAS adapter/batching level (per-AppendMessages/finalizeSession call).
 */
export function recordMasMemoryAppend(input: {
  scenario?: string;
  useCase?: string;
  stepKind: MasStepKind;
  outcome: MasOperationOutcome;
  governanceStatus?: GovernanceStatus;
  durationSeconds: number;
}): void {
  try {
    const labels = {
      scenario: normalizeScenario(input.scenario),
      use_case: normalizeUseCase(input.useCase),
      step_kind: input.stepKind,
      outcome: input.outcome,
      governance_status: normalizeGovernanceStatus(input.governanceStatus),
    };

    masMemoryAppendTotal.inc(labels);
    masMemoryAppendDurationSeconds.observe(labels, input.durationSeconds);
  } catch {
    // Metrics must never break MAS Runtime business logic.
  }
}

/**
 * Increment MAS-visible governance deny counter for Memory operations that
 * surfaced as governance errors at MAS layer.
 */
export function incrementMasMemoryGovernanceDenied(input: {
  operation:
    | 'get_context_window'
    | 'append_messages'
    | 'consolidate_session'
    | 'end_session'
    | 'finalize_session';
  scope: MemoryGovernanceScope;
  reason: MemoryGovernanceReasonCode;
}): void {
  try {
    masMemoryGovernanceDeniedTotal.inc({
      operation: input.operation,
      scope: input.scope,
      reason: input.reason,
    });
  } catch {
    // Metrics must never break MAS Runtime business logic.
  }
}