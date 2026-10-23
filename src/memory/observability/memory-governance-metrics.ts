import { getOrCreateCounter, getOrCreateHistogram } from '../../monitoring';
import type {
  MemoryOperationType,
  MemoryGovernanceReasonCode,
  MemoryGovernanceScope,
  PlanTier,
} from '../../domain/memory/governance/memory-governance.types';

const evaluationDurationHistogram = getOrCreateHistogram(
  'memory_governance_evaluation_duration_seconds',
  'Duration of Memory Governance evaluateOperation calls',
  ['operation', 'status', 'scope'],
);

const decisionsTotalCounter = getOrCreateCounter(
  'memory_governance_decisions_total',
  'Total number of Memory Governance decisions',
  ['operation', 'status', 'reason', 'scope', 'plan_tier'],
);

const governanceErrorsTotalCounter = getOrCreateCounter(
  'memory_governance_errors_total',
  'Total number of Memory Governance evaluation errors',
  ['operation', 'error_class', 'stage'],
);

function normalizeScope(scope: MemoryGovernanceScope | undefined): MemoryGovernanceScope {
  return scope ?? 'tenant';
}

function normalizePlanTier(planTier?: PlanTier): string {
  return planTier ?? 'unknown';
}

function classifyGovernanceError(error: unknown): string {
  try {
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
    if (lower.includes('quota') || lower.includes('limit')) {
      return 'quota';
    }
    if (lower.includes('policy')) {
      return 'policy';
    }

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

export function recordMemoryGovernanceEvaluationDuration(params: {
  operation: MemoryOperationType;
  status: 'allow' | 'deny' | 'allow_with_modifications';
  scope: MemoryGovernanceScope;
  durationSeconds: number;
}): void {
  try {
    evaluationDurationHistogram.observe(
      {
        operation: params.operation,
        status: params.status,
        scope: normalizeScope(params.scope),
      },
      params.durationSeconds,
    );
  } catch {
    // Metrics must never break governance logic.
  }
}

export function incrementMemoryGovernanceDecision(params: {
  operation: MemoryOperationType;
  status: 'allow' | 'deny' | 'allow_with_modifications';
  scope: MemoryGovernanceScope;
  reason: MemoryGovernanceReasonCode;
  planTier?: PlanTier;
}): void {
  try {
    decisionsTotalCounter.inc({
      operation: params.operation,
      status: params.status,
      reason: params.reason,
      scope: normalizeScope(params.scope),
      plan_tier: normalizePlanTier(params.planTier),
    });
  } catch {
    // Ignore metric errors.
  }
}

export function recordMemoryGovernanceError(params: {
  operation: MemoryOperationType;
  stage: 'policy_engine' | 'quota_evaluation' | 'audit' | 'unknown';
  error: unknown;
}): void {
  try {
    const errorClass = classifyGovernanceError(params.error);
    governanceErrorsTotalCounter.inc({
      operation: params.operation,
      error_class: errorClass,
      stage: params.stage,
    });
  } catch {
    // Ignore metric errors.
  }
}