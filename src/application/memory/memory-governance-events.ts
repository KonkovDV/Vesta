/**
 * Memory Governance typed events facade.
 *
 * Layer: Application
 *
 * Emits Outbox-first typed events for Memory Governance decisions:
 * - memory.governance.decision
 * - memory.governance.violation
 *
 * Schema contract: see 05-PLUGIN_SYSTEM/14-typed-events-registry.md.
 */

import type {
  MemoryGovernanceDecision,
  MemoryGovernanceRequest,
  MemoryGovernanceScope,
  MemoryQuotaView,
  MemoryGovernanceViolation,
  MemoryGovernanceReasonCode,
  PlanTier,
} from '../../domain/memory/governance/memory-governance.types';
import type { DomainEvent } from '../../domain/events/event-store.interface';
import { EventFactory } from '../../domain/events/event-store.interface';
import type {
  MemoryGovernanceDecisionPayloadV1,
  MemoryGovernanceViolationPayloadV1,
} from '../../domain/events/typed-events';
interface DomainEventAppender {
  saveDomainEvents(events: DomainEvent[]): Promise<void>;
}

const MEMORY_GOVERNANCE_DECISION_TOPIC = 'memory.governance.decision' as const;
const MEMORY_GOVERNANCE_VIOLATION_TOPIC = 'memory.governance.violation' as const;

/**
 * TypeScript payload for memory.governance.decision.
 * Aligned with domain-level critical typed event payload v1.
 */
export type MemoryGovernanceDecisionEventPayload =
  MemoryGovernanceDecisionPayloadV1;

/**
 * TypeScript payload for memory.governance.violation.
 * Aligned with domain-level critical typed event payload v1.
 */
export type MemoryGovernanceViolationEventPayload =
  MemoryGovernanceViolationPayloadV1;

function resolvePlanTierForEvent(request: MemoryGovernanceRequest): PlanTier | undefined {
  // For now we align with StaticMemoryGovernanceConfig.defaultPlanTier = 'pro'.
  const explicit = request.plan_tier;
  return explicit ?? 'pro';
}

function buildDecisionEventPayload(input: {
  request: MemoryGovernanceRequest;
  decision: MemoryGovernanceDecision;
}): MemoryGovernanceDecisionEventPayload {
  const { request, decision } = input;

  const quotaStatus: NonNullable<MemoryGovernanceDecision['quota_status']> =
    decision.quota_status ?? 'ok';
  const reasons: MemoryGovernanceReasonCode[] =
    decision.reasons && decision.reasons.length > 0 ? decision.reasons : ['internal_error'];

  const effects: Record<string, unknown> = decision.effects
    ? { ...decision.effects }
    : {};

  const quota_views: Array<Record<string, unknown>> = (decision.quota_views ?? []).map(
    (view) => ({
      scope: view.scope,
      dimension: view.dimension,
      limit: view.limit,
      used: view.used,
    }),
  );

  const violations: Array<Record<string, unknown>> = (decision.violations ?? []).map(
    (violation) => ({
      code: violation.code,
      message: violation.message,
      scope: violation.scope,
      severity: violation.severity,
    }),
  );

  return {
    tenant_id: request.tenant_id,
    user_id: request.user_id,
    session_id: request.session_id,
    plan_tier: resolvePlanTierForEvent(request),
    region: request.region ?? 'unknown',
    operation: request.operation,
    status: decision.status,
    quota_status: quotaStatus,
    reasons,
    effects,
    quota_views,
    violations,
    audit_ref: decision.audit_ref,
    policy_snapshot_id: decision.policy_snapshot_id,
    policy_evaluation_id: decision.policy_evaluation_id,
    timestamp: new Date().toISOString(),
    correlation_id: request.correlation_id,
    correlation_source: 'memory_context',
  };
}

function shouldEmitViolationEvent(decision: MemoryGovernanceDecision): boolean {
  if (decision.status === 'deny') return true;
  if (decision.quota_status === 'hard_exceeded') return true;
  if (decision.violations?.some((v) => v.severity === 'error')) return true;
  return false;
}

function resolvePrimaryReason(decision: MemoryGovernanceDecision): MemoryGovernanceReasonCode {
  const [primary] = decision.reasons ?? [];
  return primary ?? 'internal_error';
}

function resolvePrimaryViolation(
  decision: MemoryGovernanceDecision,
): MemoryGovernanceViolation | undefined {
  const violations = decision.violations ?? [];
  if (violations.length === 0) return undefined;
  const errorViolation = violations.find((v) => v.severity === 'error');
  return errorViolation ?? violations[0];
}

function resolveViolationSeverity(
  decision: MemoryGovernanceDecision,
  primaryViolation?: MemoryGovernanceViolation,
): 'warning' | 'error' {
  if (decision.status === 'deny') return 'error';
  if (decision.quota_status === 'hard_exceeded') return 'error';
  if (primaryViolation?.severity === 'error') return 'error';
  return 'warning';
}

function resolveViolationScope(
  request: MemoryGovernanceRequest,
  primaryViolation?: MemoryGovernanceViolation,
): MemoryGovernanceScope {
  if (primaryViolation?.scope) {
    return primaryViolation.scope;
  }
  if (request.session_id) return 'session';
  if (request.user_id) return 'user';
  return 'tenant';
}

function findQuotaViewForViolation(
  decision: MemoryGovernanceDecision,
  violationCode: MemoryGovernanceReasonCode,
  scope: MemoryGovernanceScope,
): MemoryQuotaView | undefined {
  const views = decision.quota_views ?? [];
  if (views.length === 0) return undefined;

  let dimension: MemoryQuotaView['dimension'] | undefined;

  switch (violationCode) {
    case 'tenant_active_sessions_limit_exceeded':
      dimension = 'active_sessions';
      break;
    case 'session_context_tokens_limit_exceeded':
      dimension = 'context_tokens';
      break;
    case 'session_messages_limit_exceeded':
      dimension = 'messages';
      break;
    default:
      break;
  }

  if (dimension) {
    const matched = views.find((v) => v.scope === scope && v.dimension === dimension);
    if (matched) {
      return matched;
    }
  }

  // Fallback: first available view.
  return views[0];
}

function buildViolationEventPayload(input: {
  request: MemoryGovernanceRequest;
  decision: MemoryGovernanceDecision;
  scope: MemoryGovernanceScope;
}): MemoryGovernanceViolationEventPayload | undefined {
  const { request, decision } = input;

  if (!shouldEmitViolationEvent(decision)) {
    return undefined;
  }

  const primaryViolation = resolvePrimaryViolation(decision);
  const primaryReason = resolvePrimaryReason(decision);
  const violationCode: string = (primaryViolation?.code ?? primaryReason);
  const violationScope = resolveViolationScope(request, primaryViolation);
  const severity = resolveViolationSeverity(decision, primaryViolation);
  const quotaView = findQuotaViewForViolation(
    decision,
    violationCode as MemoryGovernanceReasonCode,
    violationScope,
  );

  const details: Record<string, unknown> = {
    scope: violationScope,
    quota_status: decision.quota_status ?? 'ok',
    reasons: decision.reasons,
  };

  if (primaryViolation?.message) {
    details.message = primaryViolation.message;
  }

  if (decision.violations && decision.violations.length > 0) {
    details.violations = decision.violations;
  }

  const quota_view: Record<string, unknown> | undefined = quotaView
    ? {
        scope: quotaView.scope,
        dimension: quotaView.dimension,
        limit: quotaView.limit,
        used: quotaView.used,
      }
    : undefined;

  return {
    tenant_id: request.tenant_id,
    user_id: request.user_id,
    session_id: request.session_id,
    operation: request.operation,
    violation_code: violationCode,
    severity,
    reason: primaryViolation?.message ?? primaryReason,
    details,
    quota_view,
    audit_ref: decision.audit_ref,
    policy_evaluation_id: decision.policy_evaluation_id,
    timestamp: new Date().toISOString(),
    correlation_id: request.correlation_id,
    correlation_source: 'memory_context',
  };
}

async function persistMemoryGovernanceEvents(
  events: DomainEvent[],
  eventStoreService?: DomainEventAppender,
): Promise<void> {
  if (!events || events.length === 0) {
    return;
  }

  if (!eventStoreService) {
    return;
  }

  try {
    await eventStoreService.saveDomainEvents(events);
  } catch {
    // Best-effort: audit events must never break governance flow.
    // Errors from DomainEventAppender/DI are swallowed here.
  }
}

/**
 * Emit Memory Governance typed events (decision + optional violation) via DomainEventAppender.
 *
 * Best-effort:
 * - collects both events into a single Outbox-first batch;
 * - logs and swallows any errors from DomainEventAppender/DI.
 */
export async function emitMemoryGovernanceAuditEvents(params: {
  request: MemoryGovernanceRequest;
  decision: MemoryGovernanceDecision;
  scope: MemoryGovernanceScope;
  eventStoreService?: DomainEventAppender;
}): Promise<void> {
  const { request, decision, scope, eventStoreService } = params;
  const correlationId = request.correlation_id;

  const decisionPayload = buildDecisionEventPayload({ request, decision });
  const aggregateId = request.tenant_id;

  const events: DomainEvent[] = [];

  const decisionEvent = EventFactory.createBaseEvent(
    aggregateId,
    MEMORY_GOVERNANCE_DECISION_TOPIC,
    decisionPayload,
    correlationId,
  );
  events.push(decisionEvent);

  const violationPayload = buildViolationEventPayload({ request, decision, scope });
  if (violationPayload) {
    const violationEvent = EventFactory.createBaseEvent(
      aggregateId,
      MEMORY_GOVERNANCE_VIOLATION_TOPIC,
      violationPayload,
      correlationId,
    );
    events.push(violationEvent);
  }

  await persistMemoryGovernanceEvents(events, eventStoreService);
}