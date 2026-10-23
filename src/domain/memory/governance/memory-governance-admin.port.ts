/**
 * Memory governance admin port. In-memory and PostgreSQL implementations sit above it.
 * Layer: Domain
 */

import type { SessionId, TenantId, UserId } from '../session-types';
import type { PlanTier } from './memory-governance.types';

export interface TenantQuotaOverride {
  tenant_id: TenantId;
  max_active_sessions?: number;
  max_storage_bytes?: number;
  max_context_tokens_per_session?: number;
  max_messages_per_session?: number;
  plan_tier_override?: PlanTier;
  expires_at?: Date | null;
  notes?: string;
  created_by?: string;
  created_at: Date;
  updated_at: Date;
}

export interface UpsertQuotaOverrideInput {
  tenant_id: TenantId;
  max_active_sessions?: number;
  max_storage_bytes?: number;
  max_context_tokens_per_session?: number;
  max_messages_per_session?: number;
  plan_tier_override?: PlanTier;
  expires_at?: Date | null;
  notes?: string;
  created_by?: string;
}

export interface TenantUsageSummary {
  tenant_id: TenantId;
  active_sessions: number;
  total_context_tokens: number;
  total_storage_bytes: number;
  plan_tier: PlanTier;
  has_override: boolean;
  last_activity_at?: Date;
}

export type MemoryGovernanceLifecyclePlane =
  | 'working'
  | 'summary'
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'profile'
  | 'archival'
  | 'graph'
  | 'reflective'
  | 'governance'
  | 'evaluation';

export type MemoryGovernanceLifecycleOperation =
  | 'forget'
  | 'correct'
  | 'downgrade'
  | 'supersede'
  | 'redact'
  | 'delete';

export type MemoryGovernanceLifecycleStatus =
  | 'requested'
  | 'approved'
  | 'rejected'
  | 'applied'
  | 'reverted';

export interface MemoryGovernanceLifecycleRecord {
  operation_id: string;
  tenant_id: TenantId;
  plane: MemoryGovernanceLifecyclePlane;
  operation: MemoryGovernanceLifecycleOperation;
  status: MemoryGovernanceLifecycleStatus;
  summary: string;
  reason: string;
  correlation_id: string;
  user_id?: UserId;
  session_id?: SessionId;
  artifact_id?: string;
  artifact_type?: string;
  requested_by?: string;
  replacement_artifact_id?: string;
  supersedes_operation_id?: string;
  policy_snapshot_id?: string;
  evaluation_run_id?: string;
  metadata?: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface RecordMemoryGovernanceLifecycleInput {
  tenant_id: TenantId;
  plane: MemoryGovernanceLifecyclePlane;
  operation: MemoryGovernanceLifecycleOperation;
  summary: string;
  reason: string;
  correlation_id: string;
  status?: MemoryGovernanceLifecycleStatus;
  user_id?: UserId;
  session_id?: SessionId;
  artifact_id?: string;
  artifact_type?: string;
  requested_by?: string;
  replacement_artifact_id?: string;
  supersedes_operation_id?: string;
  policy_snapshot_id?: string;
  evaluation_run_id?: string;
  metadata?: Record<string, unknown>;
}

export interface ListMemoryGovernanceLifecycleOptions {
  tenant_id?: TenantId;
  planes?: ReadonlyArray<MemoryGovernanceLifecyclePlane>;
  operations?: ReadonlyArray<MemoryGovernanceLifecycleOperation>;
  statuses?: ReadonlyArray<MemoryGovernanceLifecycleStatus>;
  limit?: number;
  offset?: number;
}

export interface IMemoryGovernanceAdminService {
  getQuotaOverride(tenantId: TenantId): Promise<TenantQuotaOverride | null>;
  upsertQuotaOverride(input: UpsertQuotaOverrideInput): Promise<TenantQuotaOverride>;
  deleteQuotaOverride(tenantId: TenantId): Promise<boolean>;
  listQuotaOverrides(options?: { limit?: number; offset?: number }): Promise<TenantQuotaOverride[]>;
  getTenantUsageSummary(tenantId: TenantId): Promise<TenantUsageSummary | null>;
  recordLifecycleOperation(
    input: RecordMemoryGovernanceLifecycleInput,
  ): Promise<MemoryGovernanceLifecycleRecord>;
  listLifecycleOperations(
    options?: ListMemoryGovernanceLifecycleOptions,
  ): Promise<MemoryGovernanceLifecycleRecord[]>;
}
