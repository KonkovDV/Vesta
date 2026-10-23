import type {
  GovernanceMemoryDecision,
  GovernanceMemoryLifecycleExecutionMode,
  GovernanceMemoryLifecycleExecutionResult,
  GovernanceMemoryLifecycleListOptions,
  GovernanceMemoryLifecycleRecord,
  GovernanceMemoryQuotaListOptions,
  GovernanceMemoryQuotaOverride,
  GovernanceMemoryRequest,
  GovernanceMemoryUsageSnapshot,
  GovernanceMemoryUsageSummary,
  IGovernanceMemory,
  RecordGovernanceMemoryLifecycleInput,
  UpsertGovernanceMemoryQuotaInput,
} from '../../domain/memory/IGovernanceMemory';
import type { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import type {
  IMemoryGovernanceAdminService,
  ListMemoryGovernanceLifecycleOptions,
  MemoryGovernanceLifecycleRecord as AdminLifecycleRecord,
  RecordMemoryGovernanceLifecycleInput,
} from '../../domain/memory/governance/memory-governance-admin.port';
import type {
  MemoryGovernanceDecision,
  MemoryGovernanceRequest,
  MemoryUsageSnapshot,
} from '../../domain/memory/governance/memory-governance.types';
import type { IMemoryGovernanceService } from '../../domain/memory/governance/memory-governance.service.port';

const PROFILE_LIFECYCLE_OPERATIONS = new Set(['forget', 'delete']);
const EVALUATION_LIFECYCLE_OPERATIONS = new Set(['forget', 'delete']);

type LifecycleExecutionPlan = {
  readonly sql: string;
  readonly params: unknown[];
  readonly executionMode: Exclude<GovernanceMemoryLifecycleExecutionMode, 'rejected'>;
};

function toUsageSnapshot(
  snapshot?: GovernanceMemoryUsageSnapshot,
): MemoryUsageSnapshot | undefined {
  if (!snapshot) {
    return undefined;
  }

  return {
    tenant_id: snapshot.tenantId,
    active_sessions: snapshot.activeSessions,
    total_context_tokens: snapshot.totalContextTokens,
    total_storage_bytes: snapshot.totalStorageBytes,
    session: snapshot.session
      ? {
          session_id: snapshot.session.sessionId,
          context_tokens: snapshot.session.contextTokens,
          message_count: snapshot.session.messageCount,
          storage_bytes: snapshot.session.storageBytes,
        }
      : undefined,
    user: snapshot.user
      ? {
          user_id: snapshot.user.userId,
          active_sessions: snapshot.user.activeSessions,
          context_tokens: snapshot.user.contextTokens,
        }
      : undefined,
  };
}

function toGovernanceRequest(input: GovernanceMemoryRequest): MemoryGovernanceRequest {
  return {
    tenant_id: input.tenantId,
    user_id: input.userId,
    session_id: input.sessionId,
    plan_tier: input.planTier,
    region: input.region,
    operation: input.operation,
    role: input.role as MemoryGovernanceRequest['role'],
    modality: input.modality as MemoryGovernanceRequest['modality'],
    current_context_tokens: input.currentContextTokens,
    added_tokens_estimate: input.addedTokensEstimate,
    prospective_context_tokens: input.prospectiveContextTokens,
    added_storage_bytes_estimate: input.addedStorageBytesEstimate,
    usage_snapshot: toUsageSnapshot(input.usageSnapshot),
    sensitivity: input.sensitivity,
    policy_tags: input.policyTags ? [...input.policyTags] : undefined,
    correlation_id: input.correlationId,
  };
}

function toDomainDecision(decision: MemoryGovernanceDecision): GovernanceMemoryDecision {
  return {
    status: decision.status,
    quotaStatus: decision.quota_status,
    reasons: decision.reasons,
    effects: {
      truncateContextToTokens: decision.effects.truncate_context_to_tokens,
      truncateContextToMessages: decision.effects.truncate_context_to_messages,
      allowLegacyPersist: decision.effects.allow_legacy_persist,
      allowHsgPersist: decision.effects.allow_hsg_persist,
      allowVectorPersist: decision.effects.allow_vector_persist,
      overrideMemoryMode: decision.effects.override_memory_mode,
    },
    quotaViews: decision.quota_views?.map(view => ({
      scope: view.scope,
      dimension: view.dimension,
      limit: view.limit,
      used: view.used,
    })),
    violations: decision.violations?.map(violation => ({
      code: violation.code,
      message: violation.message,
      scope: violation.scope,
      severity: violation.severity,
    })),
    auditRef: decision.audit_ref,
    policySnapshotId: decision.policy_snapshot_id,
    policyEvaluationId: decision.policy_evaluation_id,
  };
}

function toDomainQuotaOverride(
  override: Awaited<ReturnType<IMemoryGovernanceAdminService['getQuotaOverride']>>,
): GovernanceMemoryQuotaOverride | null {
  if (!override) {
    return null;
  }

  return {
    tenantId: override.tenant_id,
    maxActiveSessions: override.max_active_sessions,
    maxStorageBytes: override.max_storage_bytes,
    maxContextTokensPerSession: override.max_context_tokens_per_session,
    maxMessagesPerSession: override.max_messages_per_session,
    planTierOverride: override.plan_tier_override,
    expiresAt: override.expires_at,
    notes: override.notes,
    createdBy: override.created_by,
    createdAt: override.created_at,
    updatedAt: override.updated_at,
  };
}

function toDomainUsageSummary(
  summary: Awaited<ReturnType<IMemoryGovernanceAdminService['getTenantUsageSummary']>>,
): GovernanceMemoryUsageSummary | null {
  if (!summary) {
    return null;
  }

  return {
    tenantId: summary.tenant_id,
    activeSessions: summary.active_sessions,
    totalContextTokens: summary.total_context_tokens,
    totalStorageBytes: summary.total_storage_bytes,
    planTier: summary.plan_tier,
    hasOverride: summary.has_override,
    lastActivityAt: summary.last_activity_at,
  };
}

function toLifecycleRecordInput(
  input: RecordGovernanceMemoryLifecycleInput,
): RecordMemoryGovernanceLifecycleInput {
  return {
    tenant_id: input.target.tenantId,
    plane: input.target.plane,
    operation: input.operation,
    summary: input.summary,
    reason: input.reason,
    correlation_id: input.correlationId,
    status: input.status,
    user_id: input.target.userId,
    session_id: input.target.sessionId,
    artifact_id: input.target.artifactId,
    artifact_type: input.target.artifactType,
    requested_by: input.requestedBy,
    replacement_artifact_id: input.replacementArtifactId,
    supersedes_operation_id: input.supersedesOperationId,
    policy_snapshot_id: input.policySnapshotId,
    evaluation_run_id: input.evaluationRunId,
    metadata: input.metadata,
  };
}

function toLifecycleListOptions(
  options?: GovernanceMemoryLifecycleListOptions,
): ListMemoryGovernanceLifecycleOptions | undefined {
  if (!options) {
    return undefined;
  }

  return {
    tenant_id: options.tenantId,
    planes: options.planes ? [...options.planes] : undefined,
    operations: options.operations ? [...options.operations] : undefined,
    statuses: options.statuses ? [...options.statuses] : undefined,
    limit: options.limit,
    offset: options.offset,
  };
}

function toDomainLifecycleRecord(record: AdminLifecycleRecord): GovernanceMemoryLifecycleRecord {
  return {
    operationId: record.operation_id,
    target: {
      plane: record.plane,
      tenantId: record.tenant_id,
      userId: record.user_id,
      sessionId: record.session_id,
      artifactId: record.artifact_id,
      artifactType: record.artifact_type,
    },
    operation: record.operation,
    status: record.status,
    summary: record.summary,
    reason: record.reason,
    correlationId: record.correlation_id,
    requestedBy: record.requested_by,
    replacementArtifactId: record.replacement_artifact_id,
    supersedesOperationId: record.supersedes_operation_id,
    policySnapshotId: record.policy_snapshot_id,
    evaluationRunId: record.evaluation_run_id,
    metadata: record.metadata,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
  };
}

function buildExecutionMetadata(
  input: RecordGovernanceMemoryLifecycleInput,
  executionMode: GovernanceMemoryLifecycleExecutionMode,
  applied: boolean,
  affectedArtifacts: number,
  note: string,
): Record<string, unknown> {
  const baseMetadata = input.metadata ? { ...input.metadata } : {};

  return {
    ...baseMetadata,
    execution: {
      applied,
      affected_artifacts: affectedArtifacts,
      execution_mode: executionMode,
      note,
    },
  };
}

function buildLifecycleExecutionPlan(
  input: RecordGovernanceMemoryLifecycleInput,
): LifecycleExecutionPlan | { readonly note: string } {
  const artifactId = input.target.artifactId?.trim();
  if (!artifactId) {
    return { note: 'Lifecycle execution requires target.artifactId for destructive operations.' };
  }

  if (input.target.plane === 'profile') {
    if (!PROFILE_LIFECYCLE_OPERATIONS.has(input.operation)) {
      return {
        note: `Profile lifecycle execution currently supports forget/delete only. Received ${input.operation}.`,
      };
    }

    return {
      executionMode: 'profile_delete',
      sql: `
        DELETE FROM long_term_memories
        WHERE id = $1
          AND tenant_id = $2
          AND ($3::text IS NULL OR user_id = $3)
          AND type IN ('user_profile', 'preference')
      `,
      params: [artifactId, input.target.tenantId, input.target.userId ?? null],
    };
  }

  if (input.target.plane === 'evaluation') {
    if (!EVALUATION_LIFECYCLE_OPERATIONS.has(input.operation)) {
      return {
        note: `Evaluation lifecycle execution currently supports forget/delete only. Received ${input.operation}.`,
      };
    }

    return {
      executionMode: 'evaluation_delete',
      sql: `
        DELETE FROM long_term_memories
        WHERE tenant_id = $1
          AND ($2::text IS NULL OR user_id = $2)
          AND type = 'evaluation_run'
          AND (id = $3 OR metadata->>'runId' = $3)
      `,
      params: [input.target.tenantId, input.target.userId ?? null, artifactId],
    };
  }

  return {
    note: `Lifecycle execution is not yet implemented for plane ${input.target.plane}.`,
  };
}

export class GovernanceMemoryAdapter implements IGovernanceMemory {
  constructor(
    private readonly governanceService: IMemoryGovernanceService,
    private readonly governanceAdminService: IMemoryGovernanceAdminService,
    private readonly databaseConnection?: IDatabaseConnection,
  ) {}

  private async recordLifecycleExecutionOutcome(
    input: RecordGovernanceMemoryLifecycleInput,
    status: 'applied' | 'rejected',
    executionMode: GovernanceMemoryLifecycleExecutionMode,
    applied: boolean,
    affectedArtifacts: number,
    note: string,
  ): Promise<GovernanceMemoryLifecycleExecutionResult> {
    const record = await this.governanceAdminService.recordLifecycleOperation(
      toLifecycleRecordInput({
        ...input,
        status,
        metadata: buildExecutionMetadata(
          input,
          executionMode,
          applied,
          affectedArtifacts,
          note,
        ),
      }),
    );

    return {
      record: toDomainLifecycleRecord(record),
      applied,
      affectedArtifacts,
      executionMode,
      note,
    };
  }

  async evaluateOperation(input: GovernanceMemoryRequest): Promise<GovernanceMemoryDecision> {
    const decision = await this.governanceService.evaluateOperation(toGovernanceRequest(input));
    return toDomainDecision(decision);
  }

  async getQuotaOverride(tenantId: string): Promise<GovernanceMemoryQuotaOverride | null> {
    return toDomainQuotaOverride(await this.governanceAdminService.getQuotaOverride(tenantId));
  }

  async upsertQuotaOverride(
    input: UpsertGovernanceMemoryQuotaInput,
  ): Promise<GovernanceMemoryQuotaOverride> {
    const override = await this.governanceAdminService.upsertQuotaOverride({
      tenant_id: input.tenantId,
      max_active_sessions: input.maxActiveSessions,
      max_storage_bytes: input.maxStorageBytes,
      max_context_tokens_per_session: input.maxContextTokensPerSession,
      max_messages_per_session: input.maxMessagesPerSession,
      plan_tier_override: input.planTierOverride,
      expires_at: input.expiresAt,
      notes: input.notes,
      created_by: input.createdBy,
    });

    return toDomainQuotaOverride(override)!;
  }

  async deleteQuotaOverride(tenantId: string): Promise<boolean> {
    return this.governanceAdminService.deleteQuotaOverride(tenantId);
  }

  async listQuotaOverrides(
    options?: GovernanceMemoryQuotaListOptions,
  ): Promise<ReadonlyArray<GovernanceMemoryQuotaOverride>> {
    const overrides = await this.governanceAdminService.listQuotaOverrides(options);
    return overrides
      .map(override => toDomainQuotaOverride(override))
      .filter((override): override is GovernanceMemoryQuotaOverride => override !== null);
  }

  async getTenantUsageSummary(tenantId: string): Promise<GovernanceMemoryUsageSummary | null> {
    return toDomainUsageSummary(await this.governanceAdminService.getTenantUsageSummary(tenantId));
  }

  async recordLifecycleOperation(
    input: RecordGovernanceMemoryLifecycleInput,
  ): Promise<GovernanceMemoryLifecycleRecord> {
    const record = await this.governanceAdminService.recordLifecycleOperation(
      toLifecycleRecordInput(input),
    );
    return toDomainLifecycleRecord(record);
  }

  async applyLifecycleOperation(
    input: RecordGovernanceMemoryLifecycleInput,
  ): Promise<GovernanceMemoryLifecycleExecutionResult> {
    const plan = buildLifecycleExecutionPlan(input);

    if ('note' in plan) {
      return this.recordLifecycleExecutionOutcome(
        input,
        'rejected',
        'rejected',
        false,
        0,
        plan.note,
      );
    }

    if (!this.databaseConnection) {
      return this.recordLifecycleExecutionOutcome(
        input,
        'rejected',
        'rejected',
        false,
        0,
        'Lifecycle execution requires an active database connection.',
      );
    }

    try {
      const result = await this.databaseConnection.query(plan.sql, plan.params);
      const affectedArtifacts = result.rowCount ?? 0;
      const applied = affectedArtifacts > 0;
      const note = applied
        ? `Applied ${plan.executionMode} to ${affectedArtifacts} artifact(s).`
        : 'No matching artifact found for lifecycle execution.';

      return this.recordLifecycleExecutionOutcome(
        input,
        applied ? 'applied' : 'rejected',
        applied ? plan.executionMode : 'rejected',
        applied,
        affectedArtifacts,
        note,
      );
    } catch (error) {
      const note = error instanceof Error
        ? `Lifecycle execution failed: ${error.message}`
        : 'Lifecycle execution failed due to an unknown error.';

      return this.recordLifecycleExecutionOutcome(
        input,
        'rejected',
        'rejected',
        false,
        0,
        note,
      );
    }
  }

  async listLifecycleOperations(
    options?: GovernanceMemoryLifecycleListOptions,
  ): Promise<ReadonlyArray<GovernanceMemoryLifecycleRecord>> {
    const records = await this.governanceAdminService.listLifecycleOperations(
      toLifecycleListOptions(options),
    );
    return records.map((record) => toDomainLifecycleRecord(record));
  }
}