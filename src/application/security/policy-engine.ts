/**
 * Application-level PolicyEngine facade and core types.
 *
 * Layer: Application (security / authorization).
 *
 * This module defines the minimal contracts used by MAS and other
 * application services to talk to the underlying PolicyEngine.
 *
 * The actual implementation is expected to be provided by
 * infrastructure code and wired via DI. For MAS-A4.2 we provide
 * a safe in-memory stub (NoopPolicyEngine) that always returns
 * "allow", so that preflight wiring can be implemented without
 * introducing infrastructure dependencies.
 */

import type { TenantId } from '../../core/context/IRequestContext';
import type { AccessRequest, IPolicyEngine, PolicyContext, PolicyDecision } from '../../domain/security/policy-engine.port';

export type {
  AccessRequest,
  IPolicyEngine,
  PolicyContext,
  PolicyDecision,
  PolicyDecisionStatus,
} from '../../domain/security/policy-engine.port';

/**
 * DI token for resolving IPolicyEngine implementations.
 *
 * Infrastructure code is expected to register a concrete
 * implementation under this token; in environments where
 * PolicyEngine is not yet wired, Application bootstrap
 * will provision a safe NoopPolicyEngine stub.
 */
export const POLICY_ENGINE_DI_TOKEN = 'PolicyEngine' as const;
export type PolicyEngineDiToken = typeof POLICY_ENGINE_DI_TOKEN;

/**
 * Safe in-memory stub used when no real PolicyEngine is available.
 *
 * It always returns "allow" and never throws; intended only for
 * local development and tests where strict policy enforcement is
 * not yet required.
 */
export class NoopPolicyEngine implements IPolicyEngine {
  async evaluateAccessRequest(request: AccessRequest): Promise<PolicyDecision> {
    console.warn(
      '⚠️ [Security] NoopPolicyEngine is active. All policy checks are being BYPASSED. Do not use in production!',
    );
    return {
      status: 'allow',
      constraints: null,
      reasons: [],
      auditRef: `noop:${request.action}:${Date.now()}`,
    };
  }
}

/**
 * Helper for internal/policy-only tasks that need to evaluate access without
 * an ambient RequestContext/correlationId.
 *
 * RCTX-POLICY:
 * - sets `context.source = 'policy_internal_fallback'`;
 * - intentionally does NOT set `context.correlation_id`, letting
 *   PolicyEngineRuntime generate a dedicated correlation id for audit events.
 */
export function createInternalPolicyAccessRequest(params: {
  actorId?: string | null;
  tenantId?: TenantId;
  action: string;
  resource: string;
  context?: PolicyContext;
}): AccessRequest {
  const tenantId = params.tenantId;
  const actorId =
    params.actorId === undefined ||
    params.actorId === null ||
    String(params.actorId).trim().length === 0
      ? 'service:policy-internal'
      : String(params.actorId);

  const baseContext: PolicyContext = {
    source: 'policy_internal_fallback',
    ...(params.context ?? {}),
  };

  return {
    actor: {
      type: 'service',
      id: actorId,
      tenantId,
    },
    action: params.action,
    resource: params.resource,
    tenantId,
    context: baseContext,
  };
}
