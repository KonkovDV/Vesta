/**
 * Memory Governance Admin Service for runtime quota management.
 *
 * Layer: Memory
 *
 * Provides admin API for:
 * - Viewing quota configurations per tenant/plan
 * - Updating quota overrides at runtime
 * - Getting usage snapshots
 *
 * For MVP, this uses in-memory storage. Production should persist to
 * PostgreSQL or configuration service.
 */

import type { TenantId } from '../../domain/memory/session-types';

import type { MemoryUsageSnapshot } from '../../domain/memory/governance/memory-governance.types';

import { IdGenerator } from '../../core/utils/IdGenerator';

import { logger } from '../../infrastructure/logging/logger';
import type {
  IMemoryGovernanceAdminService,
  ListMemoryGovernanceLifecycleOptions,
  MemoryGovernanceLifecycleRecord,
  RecordMemoryGovernanceLifecycleInput,
  TenantQuotaOverride,
  TenantUsageSummary,
  UpsertQuotaOverrideInput,
} from '../../domain/memory/governance/memory-governance-admin.port';

export type {
  IMemoryGovernanceAdminService,
  ListMemoryGovernanceLifecycleOptions,
  MemoryGovernanceLifecycleOperation,
  MemoryGovernanceLifecyclePlane,
  MemoryGovernanceLifecycleRecord,
  MemoryGovernanceLifecycleStatus,
  RecordMemoryGovernanceLifecycleInput,
  TenantQuotaOverride,
  TenantUsageSummary,
  UpsertQuotaOverrideInput,
} from '../../domain/memory/governance/memory-governance-admin.port';

const log = logger.child({ component: 'MemoryGovernanceAdminService' });

/**
 * In-memory implementation of Memory Governance Admin Service.
 *
 * For MVP only. Production should use PostgreSQL or config service.
 */
export class InMemoryGovernanceAdminService implements IMemoryGovernanceAdminService {
  private readonly overrides = new Map<TenantId, TenantQuotaOverride>();
  private readonly usageSnapshots = new Map<TenantId, MemoryUsageSnapshot>();
  private readonly lifecycleOperations = new Map<string, MemoryGovernanceLifecycleRecord>();

  async getQuotaOverride(tenantId: TenantId): Promise<TenantQuotaOverride | null> {
    const override = this.overrides.get(tenantId);
    if (!override) return null;

    // Check expiration
    if (override.expires_at && override.expires_at < new Date()) {
      this.overrides.delete(tenantId);
      log.info('Quota override expired', { tenant_id: tenantId });
      return null;
    }

    return override;
  }

  async upsertQuotaOverride(input: UpsertQuotaOverrideInput): Promise<TenantQuotaOverride> {
    const now = new Date();
    const existing = this.overrides.get(input.tenant_id);

    const override: TenantQuotaOverride = {
      tenant_id: input.tenant_id,
      max_active_sessions: input.max_active_sessions,
      max_storage_bytes: input.max_storage_bytes,
      max_context_tokens_per_session: input.max_context_tokens_per_session,
      max_messages_per_session: input.max_messages_per_session,
      plan_tier_override: input.plan_tier_override,
      expires_at: input.expires_at,
      notes: input.notes,
      created_by: input.created_by,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };

    this.overrides.set(input.tenant_id, override);
    log.info('Quota override upserted', {
      tenant_id: input.tenant_id,
      overrides: {
        max_active_sessions: input.max_active_sessions,
        max_storage_bytes: input.max_storage_bytes,
      },
    });

    return override;
  }

  async deleteQuotaOverride(tenantId: TenantId): Promise<boolean> {
    const deleted = this.overrides.delete(tenantId);
    if (deleted) {
      log.info('Quota override deleted', { tenant_id: tenantId });
    }
    return deleted;
  }

  async listQuotaOverrides(options?: {
    limit?: number;
    offset?: number;
  }): Promise<TenantQuotaOverride[]> {
    const all = Array.from(this.overrides.values());
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 100;
    return all.slice(offset, offset + limit);
  }

  async getTenantUsageSummary(tenantId: TenantId): Promise<TenantUsageSummary | null> {
    const snapshot = this.usageSnapshots.get(tenantId);
    const override = this.overrides.get(tenantId);

    if (!snapshot) return null;

    return {
      tenant_id: tenantId,
      active_sessions: snapshot.active_sessions ?? 0,
      total_context_tokens: snapshot.total_context_tokens ?? 0,
      total_storage_bytes: snapshot.total_storage_bytes ?? 0,
      plan_tier: override?.plan_tier_override ?? 'pro',
      has_override: !!override,
    };
  }

  async recordLifecycleOperation(
    input: RecordMemoryGovernanceLifecycleInput,
  ): Promise<MemoryGovernanceLifecycleRecord> {
    const now = new Date();
    const record: MemoryGovernanceLifecycleRecord = {
      operation_id: IdGenerator.generateWithPrefix('mgov'),
      tenant_id: input.tenant_id,
      plane: input.plane,
      operation: input.operation,
      status: input.status ?? 'requested',
      summary: input.summary,
      reason: input.reason,
      correlation_id: input.correlation_id,
      user_id: input.user_id,
      session_id: input.session_id,
      artifact_id: input.artifact_id,
      artifact_type: input.artifact_type,
      requested_by: input.requested_by,
      replacement_artifact_id: input.replacement_artifact_id,
      supersedes_operation_id: input.supersedes_operation_id,
      policy_snapshot_id: input.policy_snapshot_id,
      evaluation_run_id: input.evaluation_run_id,
      metadata: input.metadata,
      created_at: now,
      updated_at: now,
    };

    this.lifecycleOperations.set(record.operation_id, record);
    log.info('Lifecycle operation recorded', {
      operation_id: record.operation_id,
      tenant_id: record.tenant_id,
      plane: record.plane,
      operation: record.operation,
      status: record.status,
    });

    return record;
  }

  async listLifecycleOperations(
    options?: ListMemoryGovernanceLifecycleOptions,
  ): Promise<MemoryGovernanceLifecycleRecord[]> {
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 100;

    return Array.from(this.lifecycleOperations.values())
      .filter((record) => {
        if (options?.tenant_id && record.tenant_id !== options.tenant_id) {
          return false;
        }
        if (options?.planes && options.planes.length > 0 && !options.planes.includes(record.plane)) {
          return false;
        }
        if (options?.operations && options.operations.length > 0 && !options.operations.includes(record.operation)) {
          return false;
        }
        if (options?.statuses && options.statuses.length > 0 && !options.statuses.includes(record.status)) {
          return false;
        }
        return true;
      })
      .sort((left, right) => right.created_at.getTime() - left.created_at.getTime())
      .slice(offset, offset + limit);
  }

  /**
   * Update usage snapshot (called internally by governance service).
   */
  updateUsageSnapshot(snapshot: MemoryUsageSnapshot): void {
    this.usageSnapshots.set(snapshot.tenant_id, snapshot);
  }
}

/**
 * DI token for IMemoryGovernanceAdminService.
 */
export const MEMORY_GOVERNANCE_ADMIN_TOKEN = 'IMemoryGovernanceAdminService' as const;
