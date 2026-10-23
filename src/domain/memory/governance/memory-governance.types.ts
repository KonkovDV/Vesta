/**
 * Memory Governance core types and contracts.
 *
 * Layer: Domain
 */

import type {
  CorrelationId,
  SessionId,
  TenantId,
  UserId,
  SessionMessage,
} from '../session-types';

export type MemoryOperationType =
  | 'create_session'
  | 'add_message'
  | 'get_context_window'
  | 'consolidate_session'
  | 'end_session'
  | 'query_long_term_context'
  | 'retrieval';

export type PlanTier = 'free' | 'pro' | 'enterprise';

export interface MemoryUsageSnapshot {
  tenant_id: TenantId;
  active_sessions?: number;
  total_context_tokens?: number;
  total_storage_bytes?: number;
  session?: {
    session_id: SessionId;
    context_tokens?: number;
    message_count?: number;
    storage_bytes?: number;
  };
  user?: {
    user_id: UserId;
    active_sessions?: number;
    context_tokens?: number;
  };
}

export type MemoryGovernanceReasonCode =
  | 'ok'
  | 'tenant_active_sessions_limit_exceeded'
  | 'session_context_tokens_limit_exceeded'
  | 'session_messages_limit_exceeded'
  | 'tenant_storage_limit_exceeded'
  | 'policy_engine_deny'
  | 'pii_content_blocked'
  | 'internal_error';

export type MemoryGovernanceScope = 'tenant' | 'user' | 'session';

export interface MemoryGovernanceEffects {
  /**
   * If set, the Memory layer must ensure that context window does not exceed
   * this token count (typically applied in get_context_window).
   */
  truncate_context_to_tokens?: number;
  /**
   * If set, the Memory layer must ensure that no more than this number of
   * messages is returned in context window operations.
   */
  truncate_context_to_messages?: number;
  /**
   * Flags controlling which backends are allowed for persistence.
   *
   * For MVP these flags are advisory only and may be ignored by the
   * underlying implementation, but they are part of the public contract.
   */
  allow_legacy_persist?: boolean;
  allow_hsg_persist?: boolean;
  allow_vector_persist?: boolean;
  /**
   * Optional override of effective memory mode for the operation
   * ('legacy-only' / 'dual-write' / 'openmemory-only').
   */
  override_memory_mode?: 'legacy-only' | 'dual-write' | 'openmemory-only';
}

export interface MemoryQuotaView {
  scope: MemoryGovernanceScope;
  dimension: 'active_sessions' | 'storage_bytes' | 'llm_tokens' | 'context_tokens' | 'messages';
  limit: number;
  used: number;
}

export interface MemoryGovernanceViolation {
  code: MemoryGovernanceReasonCode;
  message?: string;
  scope?: MemoryGovernanceScope;
  severity: 'warning' | 'error';
}

export interface MemoryGovernanceRequest {
  tenant_id: TenantId;
  user_id?: UserId;
  session_id?: SessionId;
  plan_tier?: PlanTier;
  region?: string;

  operation: MemoryOperationType;
  role?: SessionMessage['role'];
  modality?: SessionMessage['modality'];

  current_context_tokens?: number;
  added_tokens_estimate?: number;
  prospective_context_tokens?: number;
  added_storage_bytes_estimate?: number;
  usage_snapshot?: MemoryUsageSnapshot;

  sensitivity?: 'public' | 'internal' | 'confidential' | 'restricted';
  policy_tags?: string[];

  correlation_id: CorrelationId;
}

export interface MemoryGovernanceDecision {
  status: 'allow' | 'deny' | 'allow_with_modifications';
  quota_status?: 'ok' | 'near_limit' | 'soft_exceeded' | 'hard_exceeded';
  reasons: MemoryGovernanceReasonCode[];
  effects: MemoryGovernanceEffects;
  quota_views?: MemoryQuotaView[];
  violations?: MemoryGovernanceViolation[];
  audit_ref?: string;
  policy_snapshot_id?: string;
  /**
   * Optional identifier of the underlying PolicyEngine evaluation, if any.
   *
   * When Memory Governance delegates to PolicyEngine (via
   * IMemoryPolicyEngineAdapter), implementations SHOULD propagate the
   * originating `policy.evaluate.*.policy_evaluation_id` here so that
   * `memory.governance.*` typed events can be stitched with the global
   * policy audit trail.
   */
  policy_evaluation_id?: string;
}

export class MemoryGovernanceError extends Error {
  constructor(
    public readonly reason: MemoryGovernanceReasonCode,
    message: string,
  ) {
    super(message);
    this.name = 'MemoryGovernanceError';
  }
}