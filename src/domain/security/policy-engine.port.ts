/**
 * Policy decision contract.
 * Layer: Domain
 *
 * The runtime lives in infrastructure. Application services and that runtime
 * both speak this port, so neither imports the other for a decision.
 */

import type { TenantId } from '../../core/context/IRequestContext';

export interface PolicyContext extends Record<string, unknown> {
  correlation_id?: string;
  source?: string;
  sensitivity?: string;
  policy_tags?: string[];
  scenario?: string;
  current_context_tokens?: number | string;
  prospective_context_tokens?: number | string;
  added_storage_bytes_estimate?: number | string;
  tenant_id?: string;
  user_id?: string;
  session_id?: string;
  plan_tier?: string;
  region?: string;
  operation?: string;
  usage_snapshot?: unknown;
  memory?: Record<string, unknown>;
}

export interface AccessRequest {
  actor: {
    type: 'user' | 'service';
    id: string | null;
    tenantId?: TenantId;
    scopes?: string[];
    roles?: string[];
  };
  action: string;
  resource: string;
  tenantId?: TenantId;
  context: PolicyContext;
}

export type PolicyDecisionStatus = 'allow' | 'allow_with_constraints' | 'deny';

export interface PolicyDecision {
  status: PolicyDecisionStatus;
  constraints?: Record<string, unknown> | null;
  reasons?: string[];
  auditRef?: string;
  evaluationId?: string;
}

export interface IPolicyEngine {
  evaluateAccessRequest(request: AccessRequest): Promise<PolicyDecision>;
}
