/**
 * PolicyEngine runtime implementation (Infrastructure layer).
 *
 * Layer: Infrastructure (policy / security)
 *
 * This class implements the application-level [`IPolicyEngine`](src/application/security/policy-engine.ts:94)
 * contract and provides a minimal in-memory rules engine used by:
 * - MAS preflight via [`MasPolicyService`](src/application/agents/security/mas-policy-service.ts:73)
 * - Memory governance via [`PolicyEngineMemoryAdapter`](src/infrastructure/policy/memory-policy-engine.adapter.ts:1)
 */

import type {
  AccessRequest,
  PolicyDecision,
  PolicyDecisionStatus,
  IPolicyEngine,
  PolicyContext,
} from '../../domain/security/policy-engine.port';
import type { ILogger } from '../../core/decorators/ILogger';
import type {
  PolicyEvaluateRequestedEventPayload,
  PolicyEvaluateDecisionEventPayload,
} from '../../core/events/policy-events';
import type { DomainEvent } from '../../domain/events/event-store.interface';
import { EventFactory } from '../../domain/events/event-store.interface';
import { CorrelationIdProvider } from '../../core/correlation/correlation';
import { IdGenerator } from '../../core/utils/IdGenerator';
import {
  getPolicyDenialsCounter,
  getPolicyEvaluationsCounter,
  getPolicyEvalLatencyHistogram,
  recordPolicyAuditBacklog,
} from '../../monitoring';

const policyEvaluationsTotal = getPolicyEvaluationsCounter();
const policyEvalLatencySeconds = getPolicyEvalLatencyHistogram();
const policyDenialsTotal = getPolicyDenialsCounter();
const POLICY_AUDIT_OUTBOX_PARTITION = 'policy_engine';

interface DomainEventAppender {
  saveDomainEvents(events: DomainEvent[]): Promise<void>;
}

const POLICY_EVALUATE_REQUESTED_TOPIC = 'policy.evaluate.requested' as const;
const POLICY_EVALUATE_DECISION_TOPIC = 'policy.evaluate.decision' as const;

async function persistPolicyEvaluationEvents(
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
    // Best-effort: policy evaluation events must never break PolicyEngine.
  }
}

async function emitPolicyEvaluationAuditEvents(params: {
  request: AccessRequest;
  decision: PolicyDecision;
  source: string;
  policyEvaluationId: string;
  startedAt: Date;
  durationMs: number;
  eventStoreService?: DomainEventAppender;
}): Promise<void> {
  const {
    request,
    decision,
    source,
    policyEvaluationId,
    startedAt,
    durationMs,
    eventStoreService,
  } = params;

  const ctx = (request.context ?? {});
  const tenantIdRaw =
    (request.tenantId as string | undefined) ??
    request.actor.tenantId;
  const tenantId = tenantIdRaw ?? 'unknown';

  const actorType = request.actor.type;
  const actorId = request.actor.id ? String(request.actor.id) : 'unknown';

  // RCTX-POLICY: prefer propagated correlation_id; generate a new one only
  // when context is missing/invalid or explicitly marked as internal fallback.
  const rawCorrelation =
    typeof (ctx.correlation_id as unknown) === 'string'
      ? (ctx.correlation_id as string).trim()
      : '';
  const normalizedCorrelation =
    rawCorrelation.length > 0
      ? CorrelationIdProvider.normalize(rawCorrelation) ?? rawCorrelation
      : undefined;

  const contextSource =
    typeof (ctx.source as unknown) === 'string'
      ? (ctx.source as string).trim()
      : undefined;
  const isInternalFallbackSource =
    source === 'policy_internal_fallback' ||
    contextSource === 'policy_internal_fallback';

  const baseCorrelationId =
    !isInternalFallbackSource && normalizedCorrelation
      ? normalizedCorrelation
      : CorrelationIdProvider.generate('policy');

  const correlationId =
    typeof baseCorrelationId === 'string' && baseCorrelationId.trim().length > 0
      ? baseCorrelationId
      : CorrelationIdProvider.generate('policy');

  const decisionEvalIdRaw =
    typeof decision.evaluationId === 'string' ? decision.evaluationId.trim() : '';
  const effectivePolicyEvaluationId =
    decisionEvalIdRaw.length > 0 ? decisionEvalIdRaw : policyEvaluationId;

  if (!decisionEvalIdRaw || decisionEvalIdRaw !== effectivePolicyEvaluationId) {
    // RCTX-POLICY: выравниваем единый identifier между PolicyDecision и policy.evaluate.* payload.
    decision.evaluationId = effectivePolicyEvaluationId;
  }

  const sensitivity =
    typeof (ctx.sensitivity as unknown) === 'string'
      ? (ctx.sensitivity as string)
      : undefined;

  let policyTags: string[] | undefined;
  const rawPolicyTags = ctx.policy_tags;
  if (Array.isArray(rawPolicyTags)) {
    policyTags = (rawPolicyTags as unknown[])
      .filter((v) => typeof v === 'string')
      .map((v) => (v).trim())
      .filter((v) => v.length > 0);
    if (policyTags.length === 0) {
      policyTags = undefined;
    }
  }

  const requestedTimestamp = startedAt.toISOString();
  const decisionTimestamp = new Date().toISOString();

  const requestedPayload: PolicyEvaluateRequestedEventPayload = {
    policy_evaluation_id: effectivePolicyEvaluationId,
    tenant_id: tenantId,
    actor_type: actorType,
    actor_id: actorId,
    action: request.action,
    resource: request.resource,
    source,
    sensitivity,
    policy_tags: policyTags,
    requested_capabilities:
      policyTags && policyTags.length > 0 ? [...policyTags] : undefined,
    timestamp: requestedTimestamp,
    correlation_id: correlationId,
  };

  const reasons =
    decision.reasons && decision.reasons.length > 0
      ? decision.reasons
      : ['ok'];

  const decisionPayload: PolicyEvaluateDecisionEventPayload = {
    policy_evaluation_id: effectivePolicyEvaluationId,
    tenant_id: tenantId,
    actor_type: actorType,
    actor_id: actorId,
    action: request.action,
    resource: request.resource,
    source,
    status: decision.status,
    reasons,
    constraints:
      decision.constraints === undefined || decision.constraints === null
        ? undefined
        : decision.constraints,
    audit_ref: decision.auditRef,
    decision_latency_ms: Math.max(0, Math.round(durationMs)),
    timestamp: decisionTimestamp,
    correlation_id: correlationId,
  };

  const aggregateId = tenantId || 'policy-engine';

  const requestedEvent = EventFactory.createBaseEvent(
    aggregateId,
    POLICY_EVALUATE_REQUESTED_TOPIC,
    requestedPayload,
    correlationId,
  );

  const decisionEvent = EventFactory.createBaseEvent(
    aggregateId,
    POLICY_EVALUATE_DECISION_TOPIC,
    decisionPayload,
    correlationId,
  );

  await persistPolicyEvaluationEvents(
    [requestedEvent, decisionEvent],
    eventStoreService,
  );
}

/**
 * Minimal in-memory PolicyEngine runtime used as the canonical
 * infrastructure implementation behind the application-level interface.
 */
export class PolicyEngineRuntime implements IPolicyEngine {
  private readonly logger?: ILogger | Console;
  private readonly rulesLoaded: boolean;
  private readonly eventStoreService?: DomainEventAppender;

  constructor(logger?: ILogger | Console, eventStoreService?: DomainEventAppender) {
    this.logger = logger;
    this.rulesLoaded = true;
    this.eventStoreService = eventStoreService;
  }

  async evaluateAccessRequest(request: AccessRequest): Promise<PolicyDecision> {
    const startedHr = process.hrtime.bigint();
    const startedAt = new Date();
    const source = this.extractSource(request);
    const resourceLabel = this.extractResourceLabel(request, source);
    const actionLabel = this.extractActionLabel(request, source);
    const policyEvaluationId = CorrelationIdProvider.generate('policy-eval');
    let decision: PolicyDecision | undefined;

    try {
      decision = this.evaluateInternal(request);

      if (!decision.reasons || decision.reasons.length === 0) {
        decision.reasons = ['ok'];
      }

      if (!decision.auditRef) {
        decision.auditRef = this.generateAuditRef();
      }

      // Expose the evaluation identifier alongside the decision so that
      // MAS/Memory/Plugins can correlate runtime decisions with
      // `policy.evaluate.*` typed events.
      decision.evaluationId = policyEvaluationId;

      return decision;
    } catch (error) {
      this.safeLogError('policy_engine.evaluate.error', error, {
        action: request.action,
        resource: request.resource,
        source,
      });

      const fallback: PolicyDecision = {
        status: 'deny',
        constraints: null,
        reasons: ['policy_engine_internal_error', 'fail_closed'],
        auditRef: this.generateAuditRef(),
        evaluationId: policyEvaluationId,
      };

      decision = fallback;
      return fallback;
    } finally {
      const durationSeconds =
        Number(process.hrtime.bigint() - startedHr) / 1e9;

      try {
        const status: PolicyDecisionStatus =
          (decision?.status as PolicyDecisionStatus) ?? 'deny';
        policyEvaluationsTotal.inc({
          status,
          source,
          resource: resourceLabel,
        });
        if (status === 'deny') {
          const reasons = decision?.reasons ?? ['unknown'];
          const reasonLabel = normalizePolicyDenialReason(reasons);
          policyDenialsTotal.inc({
            reason: reasonLabel,
            severity: mapPolicyDenialSeverity(reasons),
            source,
          });
        }
      } catch {
        // Metrics must never break PolicyEngine.
      }

      try {
        policyEvalLatencySeconds.observe(
          {
            source,
            resource: resourceLabel,
            action: actionLabel,
          },
          durationSeconds,
        );
      } catch {
        // ignore metric errors
      }

      try {
        if (decision) {
          await emitPolicyEvaluationAuditEvents({
            request,
            decision,
            source,
            policyEvaluationId,
            startedAt,
            durationMs: durationSeconds * 1000,
            eventStoreService: this.eventStoreService,
          });
          try {
            const backlogSeconds = Math.max(
              0,
              (Date.now() - startedAt.getTime()) / 1000,
            );
            recordPolicyAuditBacklog(
              POLICY_AUDIT_OUTBOX_PARTITION,
              backlogSeconds,
            );
          } catch {
            // Gauge updates must never break PolicyEngine.
          }
        }
      } catch {
        // Typed events emission must be best-effort and must never break PolicyEngine.
      }
    }
  }

  /**
   * Basic health check used by monitoring health probes.
   */
  async isHealthy(): Promise<boolean> {
    if (this.rulesLoaded) {
      try {
        recordPolicyAuditBacklog(POLICY_AUDIT_OUTBOX_PARTITION, 0);
      } catch {
        // Best-effort heartbeat for policy_audit_store when idle.
      }
    }
    return this.rulesLoaded;
  }

  private evaluateInternal(request: AccessRequest): PolicyDecision {
    if (request.action.startsWith('memory.operation.')) {
      return this.evaluateMemoryOperation(request);
    }

    if (request.action.startsWith('mas.execute.')) {
      return this.evaluateMasOperation(request);
    }

    // Deny-by-default: unknown action prefixes are not allowed.
    return {
      status: 'deny',
      constraints: null,
      reasons: ['unknown_action_denied'],
      auditRef: undefined,
    };
  }

  private evaluateMemoryOperation(request: AccessRequest): PolicyDecision {
    const ctx = (request.context ?? {});
    const sensitivity = this.readString(ctx, 'sensitivity');
    const policyTags = this.readStringArray(ctx, 'policy_tags');

    const prospectiveTokens =
      this.readNumber(ctx, 'prospective_context_tokens') ??
      this.readNumber(ctx, 'current_context_tokens');
    const addedStorageBytes = this.readNumber(
      ctx,
      'added_storage_bytes_estimate',
    );

    const constraints: Record<string, unknown> = {};
    const reasons: string[] = [];
    let status: PolicyDecisionStatus = 'allow';

    if (policyTags.includes('deny.memory.write')) {
      status = 'deny';
      reasons.push('policy_tag_deny_memory_write');
      return {
        status,
        constraints: null,
        reasons,
        auditRef: undefined,
      };
    }

    if (typeof prospectiveTokens === 'number' && prospectiveTokens > 12000) {
      constraints['memory.max_context_tokens'] = 8000;
      status = 'allow_with_constraints';
      reasons.push('memory_context_tokens_capped');
    }

    if (
      typeof addedStorageBytes === 'number' &&
      addedStorageBytes > 10 * 1024 * 1024
    ) {
      constraints['memory.forbid_long_term_persist'] = true;
      status = 'allow_with_constraints';
      reasons.push('memory_large_persist_capped');
    }

    if (sensitivity === 'restricted') {
      constraints['memory.forbid_long_term_persist'] = true;
      status = 'allow_with_constraints';
      reasons.push('sensitivity_restricted');
    }

    if (reasons.length === 0) {
      reasons.push('ok');
    }

    return {
      status,
      constraints: Object.keys(constraints).length ? constraints : null,
      reasons,
      auditRef: undefined,
    };
  }

  private evaluateMasOperation(request: AccessRequest): PolicyDecision {
    const ctx = (request.context ?? {});
    const rawScenario =
      this.readString(ctx, 'scenario') ??
      this.extractScenarioFromAction(request.action);
    const scenario = rawScenario ?? 'unknown';
    const sensitivity = this.readString(ctx, 'sensitivity');

    const risk = this.classifyMasScenarioRisk(scenario);
    const reasons: string[] = [];
    let status: PolicyDecisionStatus = 'allow';
    let constraints: Record<string, unknown> | null = null;

    if (risk === 'high' && sensitivity === 'restricted') {
      status = 'deny';
      reasons.push('high_risk_scenario', 'sensitivity_restricted');
    } else if (risk === 'high') {
      status = 'allow_with_constraints';
      constraints = {
        'mas.max_parallel_agents': 3,
        'mas.max_depth': 2,
      };
      reasons.push('high_risk_scenario', 'constraints_applied');
    } else {
      reasons.push('ok');
    }

    return {
      status,
      constraints,
      reasons,
      auditRef: undefined,
    };
  }

  private extractSource(request: AccessRequest): string {
    const ctx = (request.context ?? {});
    const fromContext = ctx.source;
    if (typeof fromContext === 'string' && fromContext.trim()) {
      return this.normalizeLabel(fromContext, 'unknown');
    }

    if (request.action.startsWith('mas.')) return 'mas';
    if (request.action.startsWith('memory.')) return 'memory';

    return 'unknown';
  }

  private extractResourceLabel(
    request: AccessRequest,
    source: string,
  ): string {
    if (source === 'memory') {
      const raw =
        typeof request.resource === 'string' ? request.resource.trim() : '';

      if (raw === 'memory.session') return 'memory.session';
      if (raw === 'memory.user') return 'memory.user';
      if (raw === 'memory.tenant') return 'memory.tenant';

      return '__unknown__';
    }

    return this.normalizeLabel(request.resource, 'unknown');
  }

  private extractActionLabel(
    request: AccessRequest,
    source: string,
  ): string {
    if (source === 'memory') {
      const raw =
        typeof request.action === 'string' ? request.action.trim() : '';
      const prefix = 'memory.operation.';

      if (raw.startsWith(prefix)) {
        const op = raw.slice(prefix.length);

        switch (op) {
          case 'create_session':
          case 'add_message':
          case 'get_context_window':
          case 'consolidate_session':
          case 'end_session':
          case 'query_long_term_context':
          case 'retrieval':
            return `${prefix}${op}`;
          default:
            return `${prefix}__unknown__`;
        }
      }

      return '__unknown__';
    }

    return this.normalizeLabel(request.action, 'unknown');
  }

  private extractScenarioFromAction(action: string): string | undefined {
    const marker = '.scenario.';
    const idx = action.indexOf(marker);
    if (idx === -1) return undefined;
    return action.slice(idx + marker.length);
  }

  private classifyMasScenarioRisk(
    scenario: string,
  ): 'low' | 'medium' | 'high' {
    const normalized = scenario.toLowerCase();

    const highRiskPrefixes = ['payment', 'payout', 'transfer', 'admin', 'root'];
    if (highRiskPrefixes.some((p) => normalized.startsWith(p))) {
      return 'high';
    }

    const mediumRiskPrefixes = ['config', 'settings', 'moderation'];
    if (mediumRiskPrefixes.some((p) => normalized.startsWith(p))) {
      return 'medium';
    }

    return 'low';
  }

  private generateAuditRef(): string {
    const ts = Date.now().toString(36);
    const rand = IdGenerator.generateRandomString(6);
    return `policy-mvp:${ts}:${rand}`;
  }

  private safeLogError(
    message: string,
    error: unknown,
    meta?: Record<string, unknown>,
  ): void {
    const baseMeta: Record<string, unknown> = {
      ...(meta ?? {}),
      error:
        error instanceof Error
          ? { message: error.message, name: error.name }
          : { value: String(error) },
    };

    try {
      if (!this.logger) {
         
        console.error(message, baseMeta);
        return;
      }

      if (typeof this.logger.error === 'function') {
        this.logger.error(message, baseMeta);
      } else if (typeof (this.logger as Console).log === 'function') {
        (this.logger as Console).log(message, baseMeta);
      }
    } catch {
      // Logging must never break PolicyEngine
    }
  }

  private normalizeLabel(
    value: unknown,
    fallback: string,
    maxLen = 100,
  ): string {
    if (typeof value !== 'string') return fallback;
    const trimmed = value.trim();
    if (!trimmed) return fallback;
    if (trimmed.length <= maxLen) return trimmed;
    return trimmed.slice(0, maxLen);
  }

  private readString(
    ctx: PolicyContext,
    key: keyof PolicyContext & string,
  ): string | undefined {
    const v = ctx[key];
    if (typeof v === 'string') {
      const trimmed = v.trim();
      return trimmed || undefined;
    }
    return undefined;
  }

  private readNumber(
    ctx: PolicyContext,
    key: keyof PolicyContext & string,
  ): number | undefined {
    const v = ctx[key];
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v;
    }
    if (typeof v === 'string') {
      const parsed = Number(v);
      if (Number.isFinite(parsed)) return parsed;
    }
    return undefined;
  }

  private readStringArray(
    ctx: PolicyContext,
    key: keyof PolicyContext & string,
  ): string[] {
    const v = ctx[key];
    if (!Array.isArray(v)) return [];
    return (v as unknown[])
      .map((item) => (typeof item === 'string' ? item.trim() : ''))
      .filter((item) => item.length > 0);
  }
}

function normalizePolicyDenialReason(reasons: string[]): string {
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return 'other';
  }

  const lowered = reasons
    .filter((reason) => typeof reason === 'string')
    .map((reason) => reason.toLowerCase());
  const has = (fragment: string) => lowered.some((r) => r.includes(fragment));

  if (has('sanction')) return 'sanctions';
  if (has('budget') && has('exceed')) return 'budget_exceeded';
  if (has('region') && has('restrict')) return 'region_restricted';
  if (has('risk') && has('high')) return 'risk_high';
  if (has('insufficient_funds')) return 'insufficient_funds';
  if (has('provider_unavailable')) return 'provider_unavailable';
  if (has('internal_error') || has('policy_engine_internal_error')) {
    return 'internal_error';
  }
  if (has('deny') || has('violation') || has('forbid')) {
    return 'policy_denied';
  }
  if (has('limit') || has('quota') || has('exceed') || has('capped')) {
    return 'limit_exceeded';
  }
  return 'other';
}

function mapPolicyDenialSeverity(
  reasons: string[],
): 'critical' | 'warning' | 'info' {
  if (!Array.isArray(reasons) || reasons.length === 0) {
    return 'info';
  }

  const lowered = reasons
    .filter((reason) => typeof reason === 'string')
    .map((reason) => reason.toLowerCase());
  const has = (fragment: string) => lowered.some((r) => r.includes(fragment));

  if (
    has('internal_error') ||
    has('policy_engine_internal_error') ||
    has('sanction') ||
    has('deny') ||
    has('violation')
  ) {
    return 'critical';
  }

  if (
    has('limit') ||
    has('quota') ||
    has('exceed') ||
    has('capped') ||
    has('budget') ||
    (has('risk') && has('high'))
  ) {
    return 'warning';
  }

  return 'info';
}
