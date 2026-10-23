/**
 * PostgreSQL implementation of Memory Governance Admin Service.
 *
 * Layer: Infrastructure
 *
 * Provides persistent storage for quota overrides using PostgreSQL.
 * Replaces InMemoryGovernanceAdminService for production.
 */

import type {
  IMemoryGovernanceAdminService,
  ListMemoryGovernanceLifecycleOptions,
  MemoryGovernanceLifecycleRecord,
  MemoryGovernanceLifecycleStatus,
  RecordMemoryGovernanceLifecycleInput,
  TenantQuotaOverride,
  TenantUsageSummary,
  UpsertQuotaOverrideInput,
} from '../../domain/memory/governance/memory-governance-admin.port';

import type {
  TenantId,
} from '../../domain/memory/session-types';

import type {
  PlanTier,
} from '../../domain/memory/governance/memory-governance.types';

import type { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import { IdGenerator } from '../../core/utils/IdGenerator';
import { safeJsonParse } from '../../core/utils/json';
import { logger } from '../logging/logger';

const log = logger.child({ component: 'PostgresGovernanceAdminService' });
const GOVERNANCE_LIFECYCLE_TYPE = 'governance_lifecycle';
const DEFAULT_GOVERNANCE_USER_ID = 'system';

/**
 * Row shape from memory.quota_overrides table.
 */
interface QuotaOverrideRow {
  tenant_id: string;
  max_active_sessions: number | null;
  max_storage_bytes: string | null; // bigint comes as string
  max_context_tokens_per_session: number | null;
  max_messages_per_session: number | null;
  plan_tier_override: string | null;
  expires_at: Date | null;
  notes: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
}

interface GovernanceLifecycleRow {
  id: string;
  tenant_id: string;
  user_id: string;
  content: string;
  metadata: unknown;
  created_at: Date;
  updated_at: Date;
}

function toMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    return safeJsonParse<Record<string, unknown>>(value, {}) ?? {};
  }

  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

/**
 * PostgreSQL implementation of IMemoryGovernanceAdminService.
 */
export class PostgresGovernanceAdminService implements IMemoryGovernanceAdminService {
  constructor(private readonly db: IDatabaseConnection) {}

  async getQuotaOverride(tenantId: TenantId): Promise<TenantQuotaOverride | null> {
    const result = await this.db.query<QuotaOverrideRow>(
      `SELECT * FROM memory.quota_overrides 
       WHERE tenant_id = $1 
         AND (expires_at IS NULL OR expires_at > NOW())`,
      [tenantId],
    );

    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToOverride(result.rows[0]);
  }

  async upsertQuotaOverride(input: UpsertQuotaOverrideInput): Promise<TenantQuotaOverride> {
    const result = await this.db.query<QuotaOverrideRow>(
      `INSERT INTO memory.quota_overrides (
        tenant_id,
        max_active_sessions,
        max_storage_bytes,
        max_context_tokens_per_session,
        max_messages_per_session,
        plan_tier_override,
        expires_at,
        notes,
        created_by
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (tenant_id) DO UPDATE SET
        max_active_sessions = EXCLUDED.max_active_sessions,
        max_storage_bytes = EXCLUDED.max_storage_bytes,
        max_context_tokens_per_session = EXCLUDED.max_context_tokens_per_session,
        max_messages_per_session = EXCLUDED.max_messages_per_session,
        plan_tier_override = EXCLUDED.plan_tier_override,
        expires_at = EXCLUDED.expires_at,
        notes = EXCLUDED.notes,
        created_by = EXCLUDED.created_by,
        updated_at = NOW()
      RETURNING *`,
      [
        input.tenant_id,
        input.max_active_sessions ?? null,
        input.max_storage_bytes ?? null,
        input.max_context_tokens_per_session ?? null,
        input.max_messages_per_session ?? null,
        input.plan_tier_override ?? null,
        input.expires_at ?? null,
        input.notes ?? null,
        input.created_by ?? null,
      ],
    );

    log.info('Quota override upserted', {
      tenant_id: input.tenant_id,
      overrides: {
        max_active_sessions: input.max_active_sessions,
        max_storage_bytes: input.max_storage_bytes,
      },
    });

    return this.mapRowToOverride(result.rows[0]);
  }

  async deleteQuotaOverride(tenantId: TenantId): Promise<boolean> {
    const result = await this.db.query(
      `DELETE FROM memory.quota_overrides WHERE tenant_id = $1`,
      [tenantId],
    );

    const deleted = (result.rowCount ?? 0) > 0;
    if (deleted) {
      log.info('Quota override deleted', { tenant_id: tenantId });
    }
    return deleted;
  }

  async listQuotaOverrides(options?: {
    limit?: number;
    offset?: number;
  }): Promise<TenantQuotaOverride[]> {
    const limit = options?.limit ?? 100;
    const offset = options?.offset ?? 0;

    const result = await this.db.query<QuotaOverrideRow>(
      `SELECT * FROM memory.quota_overrides 
       WHERE expires_at IS NULL OR expires_at > NOW()
       ORDER BY tenant_id
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    return result.rows.map(row => this.mapRowToOverride(row));
  }

  async getTenantUsageSummary(tenantId: TenantId): Promise<TenantUsageSummary | null> {
    // Usage summary requires aggregation from session store
    // For now, return override info only
    const override = await this.getQuotaOverride(tenantId);

    return {
      tenant_id: tenantId,
      active_sessions: 0, // Populated by session store aggregation
      total_context_tokens: 0,
      total_storage_bytes: 0,
      plan_tier: override?.plan_tier_override ?? 'pro',
      has_override: !!override,
    };
  }

  async recordLifecycleOperation(
    input: RecordMemoryGovernanceLifecycleInput,
  ): Promise<MemoryGovernanceLifecycleRecord> {
    const createdAt = new Date();
    const operationId = IdGenerator.generateWithPrefix('mgov');
    const userId = input.user_id ?? input.requested_by ?? DEFAULT_GOVERNANCE_USER_ID;

    const result = await this.db.query<GovernanceLifecycleRow>(
      `INSERT INTO long_term_memories (
         id,
         tenant_id,
         user_id,
         content,
         type,
         metadata,
         created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, tenant_id, user_id, content, metadata, created_at, updated_at`,
      [
        operationId.replace(/^mgov_/, ''),
        input.tenant_id,
        userId,
        input.summary,
        GOVERNANCE_LIFECYCLE_TYPE,
        JSON.stringify({
          operationId,
          plane: input.plane,
          operation: input.operation,
          status: input.status ?? 'requested',
          reason: input.reason,
          correlation_id: input.correlation_id,
          requested_by: input.requested_by,
          session_id: input.session_id,
          artifact_id: input.artifact_id,
          artifact_type: input.artifact_type,
          replacement_artifact_id: input.replacement_artifact_id,
          supersedes_operation_id: input.supersedes_operation_id,
          policy_snapshot_id: input.policy_snapshot_id,
          evaluation_run_id: input.evaluation_run_id,
          metadata: input.metadata,
        }),
        createdAt,
      ],
    );

    log.info('Lifecycle operation persisted', {
      operation_id: operationId,
      tenant_id: input.tenant_id,
      plane: input.plane,
      operation: input.operation,
      status: input.status ?? 'requested',
    });

    return this.mapRowToLifecycleRecord(result.rows[0]);
  }

  async listLifecycleOperations(
    options?: ListMemoryGovernanceLifecycleOptions,
  ): Promise<MemoryGovernanceLifecycleRecord[]> {
    const result = await this.db.query<GovernanceLifecycleRow>(
      `SELECT id, tenant_id, user_id, content, metadata, created_at, updated_at
       FROM long_term_memories
       WHERE type = $1
         AND ($2::text IS NULL OR tenant_id = $2)
         AND ($3::text[] IS NULL OR metadata->>'plane' = ANY($3))
         AND ($4::text[] IS NULL OR metadata->>'operation' = ANY($4))
         AND ($5::text[] IS NULL OR metadata->>'status' = ANY($5))
       ORDER BY created_at DESC
       LIMIT $6 OFFSET $7`,
      [
        GOVERNANCE_LIFECYCLE_TYPE,
        options?.tenant_id ?? null,
        options?.planes?.length ? [...options.planes] : null,
        options?.operations?.length ? [...options.operations] : null,
        options?.statuses?.length ? [...options.statuses] : null,
        options?.limit ?? 100,
        options?.offset ?? 0,
      ],
    );

    return result.rows.map((row) => this.mapRowToLifecycleRecord(row));
  }

  /**
   * Map database row to typed override.
   */
  private mapRowToOverride(row: QuotaOverrideRow): TenantQuotaOverride {
    return {
      tenant_id: row.tenant_id,
      max_active_sessions: row.max_active_sessions ?? undefined,
      max_storage_bytes: row.max_storage_bytes ? Number(row.max_storage_bytes) : undefined,
      max_context_tokens_per_session: row.max_context_tokens_per_session ?? undefined,
      max_messages_per_session: row.max_messages_per_session ?? undefined,
      plan_tier_override: (row.plan_tier_override as PlanTier) ?? undefined,
      expires_at: row.expires_at ?? undefined,
      notes: row.notes ?? undefined,
      created_by: row.created_by ?? undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private mapRowToLifecycleRecord(row: GovernanceLifecycleRow): MemoryGovernanceLifecycleRecord {
    const metadata = toMetadata(row.metadata);
    const status = typeof metadata.status === 'string'
      ? metadata.status as MemoryGovernanceLifecycleStatus
      : 'requested';

    return {
      operation_id: typeof metadata.operationId === 'string' ? metadata.operationId : row.id,
      tenant_id: row.tenant_id,
      plane: String(metadata.plane) as MemoryGovernanceLifecycleRecord['plane'],
      operation: String(metadata.operation) as MemoryGovernanceLifecycleRecord['operation'],
      status,
      summary: row.content,
      reason: typeof metadata.reason === 'string' ? metadata.reason : '',
      correlation_id: typeof metadata.correlation_id === 'string' ? metadata.correlation_id : '',
      user_id: row.user_id,
      session_id: typeof metadata.session_id === 'string' ? metadata.session_id : undefined,
      artifact_id: typeof metadata.artifact_id === 'string' ? metadata.artifact_id : undefined,
      artifact_type: typeof metadata.artifact_type === 'string' ? metadata.artifact_type : undefined,
      requested_by: typeof metadata.requested_by === 'string' ? metadata.requested_by : undefined,
      replacement_artifact_id: typeof metadata.replacement_artifact_id === 'string'
        ? metadata.replacement_artifact_id
        : undefined,
      supersedes_operation_id: typeof metadata.supersedes_operation_id === 'string'
        ? metadata.supersedes_operation_id
        : undefined,
      policy_snapshot_id: typeof metadata.policy_snapshot_id === 'string'
        ? metadata.policy_snapshot_id
        : undefined,
      evaluation_run_id: typeof metadata.evaluation_run_id === 'string'
        ? metadata.evaluation_run_id
        : undefined,
      metadata: typeof metadata.metadata === 'object' && metadata.metadata !== null
        ? metadata.metadata as Record<string, unknown>
        : undefined,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
}
