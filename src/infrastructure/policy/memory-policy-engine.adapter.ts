/**
 * Memory PolicyEngine adapter (Infrastructure layer).
 *
 * Layer: Infrastructure (policy / memory governance)
 *
 * This adapter implements the Memory-layer port
 * [`IMemoryPolicyEngineAdapter`](src/memory/governance/memory-policy-engine-adapter.ts:44)
 * over the shared application-level [`IPolicyEngine`](src/application/security/policy-engine.ts:94).
 *
 * It is wired in DI under the token 'IMemoryPolicyEngineAdapter' and is used by
 * [`StaticQuotaMemoryGovernanceService`](src/memory/governance/memory-governance.service.ts:150)
 * to combine upstream PolicyEngine decisions with local quota enforcement.
 */

import type { ILogger } from '../../core/decorators/ILogger';
import type {
  MemoryGovernanceRequest,
} from '../../domain/memory/governance/memory-governance.types';
import type {
  IMemoryPolicyEngineAdapter,
  UpstreamPolicyDecision,
  UpstreamPolicyConstraints,
} from '../../domain/memory/governance/memory-policy-engine-adapter';
import type {
  AccessRequest,
  PolicyDecision,
  IPolicyEngine,
} from '../../domain/security/policy-engine.port';
import {
  getPolicyDenialsCounter,
  getPolicyEvaluationsCounter,
} from '../../monitoring';

const memoryPolicyEvaluations = getPolicyEvaluationsCounter();
const memoryPolicyDenials = getPolicyDenialsCounter();
const MEMORY_POLICY_SOURCE = 'memory_adapter';

function getDecisionEvaluationId(decision: PolicyDecision): string | undefined {
  const maybeDecision = decision as PolicyDecision & { evaluationId?: unknown };
  return typeof maybeDecision.evaluationId === 'string' && maybeDecision.evaluationId.trim().length > 0
    ? maybeDecision.evaluationId.trim()
    : undefined;
}

export class PolicyEngineMemoryAdapter implements IMemoryPolicyEngineAdapter {
  constructor(
    private readonly policyEngine: IPolicyEngine,
    private readonly logger?: ILogger | Console,
  ) {}

  /**
   * Evaluate Memory governance request via shared PolicyEngine.
   *
   * On any error from PolicyEngine we rethrow, letting
   * [`StaticQuotaMemoryGovernanceService`](src/memory/governance/memory-governance.service.ts:150)
   * fall back to local static quotas.
   */
  async evaluate(request: MemoryGovernanceRequest): Promise<UpstreamPolicyDecision> {
    const accessRequest = this.buildAccessRequest(request);

    let decision: PolicyDecision;
    try {
      decision = await this.policyEngine.evaluateAccessRequest(accessRequest);
    } catch (error) {
      this.safeLogError('memory.policy_engine_adapter.evaluate.error', error, {
        tenant_id: String(request.tenant_id ?? ''),
        user_id: request.user_id ? String(request.user_id) : undefined,
        session_id: request.session_id ? String(request.session_id) : undefined,
        operation: request.operation,
      });
      throw error;
    }

    const mappedDecision = this.mapDecision(decision);
    this.recordPolicyMetrics(mappedDecision, accessRequest);

    return mappedDecision;
  }

  /**
   * Build an AccessRequest from MemoryGovernanceRequest according to
   * the architectural mapping described in Memory governance design.
   */
  private buildAccessRequest(request: MemoryGovernanceRequest): AccessRequest {
    const actorType: 'user' | 'service' = request.user_id ? 'user' : 'service';
    const actorId = request.user_id
      ? String(request.user_id)
      : 'service:memory-governor';

    const tenantId = String(request.tenant_id) as AccessRequest['tenantId'];

    const action = `memory.operation.${request.operation}`;

    const resource = request.session_id
      ? 'memory.session'
      : request.user_id
        ? 'memory.user'
        : 'memory.tenant';

    const sensitivity = request.sensitivity ?? 'internal';
    const policyTags = request.policy_tags ?? [];

    const context: Record<string, unknown> = {
      source: 'memory',
      operation: request.operation,
      plan_tier: request.plan_tier ?? 'unknown',
      region: request.region ?? 'unknown',
      sensitivity,
      policy_tags: policyTags,
      tenant_id: String(request.tenant_id),
      user_id: request.user_id ? String(request.user_id) : undefined,
      session_id: request.session_id ? String(request.session_id) : undefined,
      current_context_tokens: request.current_context_tokens,
      prospective_context_tokens: request.prospective_context_tokens,
      added_storage_bytes_estimate: request.added_storage_bytes_estimate,
      usage_snapshot: request.usage_snapshot ?? null,
      correlation_id: String(request.correlation_id),
      memory: {
        operation: request.operation,
        plan_tier: request.plan_tier ?? 'unknown',
        region: request.region ?? 'unknown',
        sensitivity,
        policy_tags: policyTags,
      },
    };

    return {
      actor: {
        type: actorType,
        id: actorId,
        tenantId,
      },
      action,
      resource,
      tenantId,
      context,
    };
  }

  private mapDecision(decision: PolicyDecision): UpstreamPolicyDecision {
    const status = decision.status;

    const reasons =
      decision.reasons && decision.reasons.length > 0
        ? decision.reasons
        : ['ok'];

    const constraints = this.mapConstraints(decision.constraints);

    const evaluationId = getDecisionEvaluationId(decision) ?? '';

    return {
      status,
      reasons,
      constraints,
      audit_ref: decision.auditRef,
      policy_evaluation_id: evaluationId.length > 0 ? evaluationId : undefined,
    };
  }

  /**
   * Map opaque PolicyDecision.constraints into Memory-layer
   * UpstreamPolicyConstraints with a minimal convention:
   *
   * - memory.max_context_tokens | max_context_tokens    -> max_context_tokens
   * - memory.forbid_long_term_persist | forbid_long_term_persist -> forbid_long_term_persist
   */
  private mapConstraints(
    constraints: Record<string, unknown> | null | undefined,
  ): UpstreamPolicyConstraints | undefined {
    if (!constraints) return undefined;

    const upstream: UpstreamPolicyConstraints = {};

    const maxTokensRaw =
      (constraints['memory.max_context_tokens']) ??
      (constraints['max_context_tokens']);
    if (typeof maxTokensRaw === 'number' && Number.isFinite(maxTokensRaw)) {
      upstream.max_context_tokens = maxTokensRaw;
    }

    const forbidPersistRaw =
      (constraints['memory.forbid_long_term_persist']) ??
      (constraints['forbid_long_term_persist']);
    if (typeof forbidPersistRaw === 'boolean') {
      upstream.forbid_long_term_persist = forbidPersistRaw;
    }

    // TODO(OBS-NEXT.SEC-PE.2):
    // Когда PolicyEngine начнёт возвращать бюджетные ограничения
    // (например, constraints['budget.remaining_usd'] или аналог),
    // их нужно будет домаппить в UpstreamPolicyConstraints и далее
    // использовать на уровне MemoryGovernanceService для обновления
    // policy_budget_remaining_usd gauge. Пока таких полей нет в контрактах,
    // adapter остаётся прозрачным и gauge не трогаем.
    if (
      upstream.max_context_tokens === undefined &&
      upstream.forbid_long_term_persist === undefined
    ) {
      return undefined;
    }

    return upstream;
  }

  private recordPolicyMetrics(
    decision: UpstreamPolicyDecision,
    request: AccessRequest,
  ): void {
    try {
      const resourceLabel = this.normalizeResourceLabel(request.resource);
      memoryPolicyEvaluations.inc({
        status: decision.status,
        source: MEMORY_POLICY_SOURCE,
        resource: resourceLabel,
      });

      if (decision.status === 'deny') {
        const primaryReason = decision.reasons?.[0] ?? 'unknown';
        const reasonLabel =
          this.normalizeDenialReasonForMetrics(primaryReason);
        memoryPolicyDenials.inc({
          reason: reasonLabel,
          severity: this.deriveSeverity(primaryReason),
          source: MEMORY_POLICY_SOURCE,
        });
      }
    } catch {
      // Metrics problems must never break governance flows.
    }
  }

  private normalizeResourceLabel(resource: AccessRequest['resource']): string {
    if (typeof resource === 'string' && resource.trim()) {
      return resource.trim();
    }
    return 'memory.unknown';
  }

  private normalizeDenialReasonForMetrics(rawReason: string): string {
    const reason = rawReason.toLowerCase();

    if (reason.includes('internal_error')) {
      return 'internal_error';
    }
    if (reason.includes('sanction')) {
      return 'sanctions';
    }
    if (reason.includes('budget') && reason.includes('exceed')) {
      return 'budget_exceeded';
    }
    if (reason.includes('region') && reason.includes('restrict')) {
      return 'region_restricted';
    }
    if (reason.includes('risk') && reason.includes('high')) {
      return 'risk_high';
    }
    if (
      reason.includes('limit') ||
      reason.includes('quota') ||
      reason.includes('exceed') ||
      reason.includes('capped')
    ) {
      return 'limit_exceeded';
    }
    if (reason.includes('deny') || reason.includes('violation')) {
      return 'policy_denied';
    }
    return 'other';
  }

  private deriveSeverity(reason: string): 'critical' | 'warning' | 'info' {
    const lowered = reason.toLowerCase();

    if (
      lowered.includes('internal_error') ||
      lowered.includes('sanction') ||
      lowered.includes('deny') ||
      lowered.includes('violation')
    ) {
      return 'critical';
    }
    if (
      lowered.includes('limit') ||
      lowered.includes('exceeded') ||
      lowered.includes('quota') ||
      lowered.includes('capped') ||
      lowered.includes('budget')
    ) {
      return 'warning';
    }
    return 'info';
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
      // Logging must never break governance flows
    }
  }
}