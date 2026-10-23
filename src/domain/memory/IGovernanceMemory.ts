/**
 * IGovernanceMemory — Domain port for the explicit governance-memory plane.
 *
 * Makes quota, policy, audit-reference, and tenant override operations
 * addressable as a first-class memory plane instead of leaving governance
 * split across lower-level memory services.
 *
 * @layer Domain (Memory)
 * @since v2.9.0 — governance-memory plane explicitization
 */

import type { EvaluationMemoryPlane } from './IEvaluationMemory';

export type GovernanceMemoryOperationType =
  | 'create_session'
  | 'add_message'
  | 'get_context_window'
  | 'consolidate_session'
  | 'end_session'
  | 'query_long_term_context'
  | 'retrieval';

export type GovernanceMemoryPlanTier = 'free' | 'pro' | 'enterprise';

export type GovernanceMemoryReasonCode =
  | 'ok'
  | 'tenant_active_sessions_limit_exceeded'
  | 'session_context_tokens_limit_exceeded'
  | 'session_messages_limit_exceeded'
  | 'tenant_storage_limit_exceeded'
  | 'policy_engine_deny'
  | 'pii_content_blocked'
  | 'internal_error';

export type GovernanceMemoryScope = 'tenant' | 'user' | 'session';

export type GovernanceMemoryDecisionStatus = 'allow' | 'deny' | 'allow_with_modifications';

export type GovernanceMemoryQuotaStatus = 'ok' | 'near_limit' | 'soft_exceeded' | 'hard_exceeded';

export interface GovernanceMemoryUsageSnapshot {
  readonly tenantId: string;
  readonly activeSessions?: number;
  readonly totalContextTokens?: number;
  readonly totalStorageBytes?: number;
  readonly session?: {
    readonly sessionId: string;
    readonly contextTokens?: number;
    readonly messageCount?: number;
    readonly storageBytes?: number;
  };
  readonly user?: {
    readonly userId: string;
    readonly activeSessions?: number;
    readonly contextTokens?: number;
  };
}

export interface GovernanceMemoryRequest {
  readonly tenantId: string;
  readonly userId?: string;
  readonly sessionId?: string;
  readonly planTier?: GovernanceMemoryPlanTier;
  readonly region?: string;
  readonly operation: GovernanceMemoryOperationType;
  readonly role?: string;
  readonly modality?: string;
  readonly currentContextTokens?: number;
  readonly addedTokensEstimate?: number;
  readonly prospectiveContextTokens?: number;
  readonly addedStorageBytesEstimate?: number;
  readonly usageSnapshot?: GovernanceMemoryUsageSnapshot;
  readonly sensitivity?: 'public' | 'internal' | 'confidential' | 'restricted';
  readonly policyTags?: ReadonlyArray<string>;
  readonly correlationId: string;
}

export interface GovernanceMemoryEffects {
  readonly truncateContextToTokens?: number;
  readonly truncateContextToMessages?: number;
  readonly allowLegacyPersist?: boolean;
  readonly allowHsgPersist?: boolean;
  readonly allowVectorPersist?: boolean;
  readonly overrideMemoryMode?: 'legacy-only' | 'dual-write' | 'openmemory-only';
}

export interface GovernanceMemoryQuotaView {
  readonly scope: GovernanceMemoryScope;
  readonly dimension:
    | 'active_sessions'
    | 'storage_bytes'
    | 'llm_tokens'
    | 'context_tokens'
    | 'messages';
  readonly limit: number;
  readonly used: number;
}

export interface GovernanceMemoryViolation {
  readonly code: GovernanceMemoryReasonCode;
  readonly message?: string;
  readonly scope?: GovernanceMemoryScope;
  readonly severity: 'warning' | 'error';
}

export interface GovernanceMemoryDecision {
  readonly status: GovernanceMemoryDecisionStatus;
  readonly quotaStatus?: GovernanceMemoryQuotaStatus;
  readonly reasons: ReadonlyArray<GovernanceMemoryReasonCode>;
  readonly effects: GovernanceMemoryEffects;
  readonly quotaViews?: ReadonlyArray<GovernanceMemoryQuotaView>;
  readonly violations?: ReadonlyArray<GovernanceMemoryViolation>;
  readonly auditRef?: string;
  readonly policySnapshotId?: string;
  readonly policyEvaluationId?: string;
}

export interface GovernanceMemoryQuotaOverride {
  readonly tenantId: string;
  readonly maxActiveSessions?: number;
  readonly maxStorageBytes?: number;
  readonly maxContextTokensPerSession?: number;
  readonly maxMessagesPerSession?: number;
  readonly planTierOverride?: GovernanceMemoryPlanTier;
  readonly expiresAt?: Date | null;
  readonly notes?: string;
  readonly createdBy?: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface UpsertGovernanceMemoryQuotaInput {
  readonly tenantId: string;
  readonly maxActiveSessions?: number;
  readonly maxStorageBytes?: number;
  readonly maxContextTokensPerSession?: number;
  readonly maxMessagesPerSession?: number;
  readonly planTierOverride?: GovernanceMemoryPlanTier;
  readonly expiresAt?: Date | null;
  readonly notes?: string;
  readonly createdBy?: string;
}

export interface GovernanceMemoryUsageSummary {
  readonly tenantId: string;
  readonly activeSessions: number;
  readonly totalContextTokens: number;
  readonly totalStorageBytes: number;
  readonly planTier: GovernanceMemoryPlanTier;
  readonly hasOverride: boolean;
  readonly lastActivityAt?: Date;
}

export interface GovernanceMemoryQuotaListOptions {
  readonly limit?: number;
  readonly offset?: number;
}

export type GovernanceMemoryLifecycleOperation =
  | 'forget'
  | 'correct'
  | 'downgrade'
  | 'supersede'
  | 'redact'
  | 'delete';

export type GovernanceMemoryLifecycleStatus =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'reverted';

export interface GovernanceMemoryLifecycleTarget {
  readonly plane: EvaluationMemoryPlane;
  readonly tenantId: string;
  readonly userId?: string;
  readonly sessionId?: string;
  readonly artifactId?: string;
  readonly artifactType?: string;
}

export interface RecordGovernanceMemoryLifecycleInput {
  readonly target: GovernanceMemoryLifecycleTarget;
  readonly operation: GovernanceMemoryLifecycleOperation;
  readonly status?: GovernanceMemoryLifecycleStatus;
  readonly summary: string;
  readonly reason: string;
  readonly correlationId: string;
  readonly requestedBy?: string;
  readonly replacementArtifactId?: string;
  readonly supersedesOperationId?: string;
  readonly policySnapshotId?: string;
  readonly evaluationRunId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface GovernanceMemoryLifecycleRecord {
  readonly operationId: string;
  readonly target: GovernanceMemoryLifecycleTarget;
  readonly operation: GovernanceMemoryLifecycleOperation;
  readonly status: GovernanceMemoryLifecycleStatus;
  readonly summary: string;
  readonly reason: string;
  readonly correlationId: string;
  readonly requestedBy?: string;
  readonly replacementArtifactId?: string;
  readonly supersedesOperationId?: string;
  readonly policySnapshotId?: string;
  readonly evaluationRunId?: string;
  readonly metadata?: Record<string, unknown>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export type GovernanceMemoryLifecycleExecutionMode =
  | 'profile_delete'
  | 'evaluation_delete'
  | 'rejected';

export interface GovernanceMemoryLifecycleExecutionResult {
  readonly record: GovernanceMemoryLifecycleRecord;
  readonly applied: boolean;
  readonly affectedArtifacts: number;
  readonly executionMode: GovernanceMemoryLifecycleExecutionMode;
  readonly note?: string;
}

export interface GovernanceMemoryLifecycleListOptions {
  readonly tenantId?: string;
  readonly planes?: ReadonlyArray<EvaluationMemoryPlane>;
  readonly operations?: ReadonlyArray<GovernanceMemoryLifecycleOperation>;
  readonly statuses?: ReadonlyArray<GovernanceMemoryLifecycleStatus>;
  readonly limit?: number;
  readonly offset?: number;
}

export interface IGovernanceMemory {
  evaluateOperation(input: GovernanceMemoryRequest): Promise<GovernanceMemoryDecision>;

  getQuotaOverride(tenantId: string): Promise<GovernanceMemoryQuotaOverride | null>;

  upsertQuotaOverride(
    input: UpsertGovernanceMemoryQuotaInput,
  ): Promise<GovernanceMemoryQuotaOverride>;

  deleteQuotaOverride(tenantId: string): Promise<boolean>;

  listQuotaOverrides(
    options?: GovernanceMemoryQuotaListOptions,
  ): Promise<ReadonlyArray<GovernanceMemoryQuotaOverride>>;

  getTenantUsageSummary(tenantId: string): Promise<GovernanceMemoryUsageSummary | null>;

  recordLifecycleOperation(
    input: RecordGovernanceMemoryLifecycleInput,
  ): Promise<GovernanceMemoryLifecycleRecord>;

  applyLifecycleOperation(
    input: RecordGovernanceMemoryLifecycleInput,
  ): Promise<GovernanceMemoryLifecycleExecutionResult>;

  listLifecycleOperations(
    options?: GovernanceMemoryLifecycleListOptions,
  ): Promise<ReadonlyArray<GovernanceMemoryLifecycleRecord>>;
}