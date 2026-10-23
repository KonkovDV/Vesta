/**
 * Memory Governance service contract and MVP implementation.
 *
 * Layer: Memory
 */

import type { TenantId } from '../../domain/memory/session-types';
import {
  MemoryGovernanceError,
  type MemoryGovernanceDecision,
  type MemoryGovernanceEffects,
  type MemoryGovernanceReasonCode,
  type MemoryGovernanceRequest,
  type MemoryGovernanceScope,
  type MemoryQuotaView,
  type MemoryGovernanceViolation,
  type MemoryUsageSnapshot,
  type PlanTier,
} from '../../domain/memory/governance/memory-governance.types';
import type {
  IMemoryPolicyEngineAdapter,
  UpstreamPolicyDecision,
  UpstreamPolicyConstraints,
} from '../../domain/memory/governance/memory-policy-engine-adapter';
import type { IMemoryGovernanceAuditSink } from '../../domain/memory/governance/memory-governance.audit';
import type { IMemoryGovernanceService } from '../../domain/memory/governance/memory-governance.service.port';
import {
  incrementMemoryGovernanceDecision,
  recordMemoryGovernanceError,
  recordMemoryGovernanceEvaluationDuration,
} from '../observability/memory-governance-metrics';

export type { IMemoryGovernanceService } from '../../domain/memory/governance/memory-governance.service.port';

/**
 * Per-plan квоты для сессии.
 */
export interface PlanQuotaConfig {
  /**
   * Жёсткий верхний предел размера контекста в токенах
   * (используется как max_context_tokens per session).
   */
  maxContextTokensPerSession: number;
  /**
   * Верхний предел количества сообщений в сессии.
   */
  maxMessagesPerSession: number;
}

/**
 * Per-tenant квоты.
 */
export interface TenantQuotaConfig {
  /**
   * Максимальное количество активных сессий на tenant.
   */
  maxActiveSessions?: number;
  /**
   * Оценочный верхний предел storage по tenant (байты).
   * В MVP используется только как справочная метрика.
   */
  maxStorageBytes?: number;
}

/**
 * Статическая конфигурация governance-слоя для MVP.
 *
 * В следующих итерациях может быть заменена динамической конфигурацией
 * (per-tenant, из базы или PolicyEngine).
 */
export interface StaticMemoryGovernanceConfig {
  defaultPlanTier: PlanTier;
  /**
   * Дефолтный верхний предел storage по tenant (байты).
   */
  maxStorageBytesPerTenant?: number;
  /**
   * Per-tenant overrides.
   */
  tenantOverrides?: Record<TenantId, TenantQuotaConfig>;
  /**
   * Перечень квот per-plan.
   */
  planQuotas: Record<PlanTier, PlanQuotaConfig>;
}

const DEFAULT_PLAN_QUOTAS: Record<PlanTier, PlanQuotaConfig> = {
  free: {
    maxContextTokensPerSession: 4000,
    maxMessagesPerSession: 100,
  },
  pro: {
    maxContextTokensPerSession: 8000,
    maxMessagesPerSession: 200,
  },
  enterprise: {
    maxContextTokensPerSession: 16000,
    maxMessagesPerSession: 400,
  },
};

const DEFAULT_CONFIG: StaticMemoryGovernanceConfig = {
  defaultPlanTier: 'pro',
  maxStorageBytesPerTenant: 10 * 1024 * 1024 * 1024, // 10 GiB (оценочно)
  tenantOverrides: {},
  planQuotas: DEFAULT_PLAN_QUOTAS,
};

function resolveScope(request: MemoryGovernanceRequest): MemoryGovernanceScope {
  if (request.session_id) return 'session';
  if (request.user_id) return 'user';
  return 'tenant';
}

function resolvePlanTier(
  request: MemoryGovernanceRequest,
  config: StaticMemoryGovernanceConfig,
): PlanTier {
  return request.plan_tier ?? config.defaultPlanTier;
}

function ensureDecisionArrays(
  decision: MemoryGovernanceDecision,
): asserts decision is MemoryGovernanceDecision & {
  quota_views: MemoryQuotaView[];
  violations: MemoryGovernanceViolation[];
} {
  // Небольшой helper, чтобы не плодить undefined-массивы.
  if (!decision.quota_views) decision.quota_views = [];
  if (!decision.violations) decision.violations = [];
}

/**
 * MVP-реализация IMemoryGovernanceService с простыми статическими квотами.
 *
 * Поддерживаемые квоты:
 * - max_active_sessions per-tenant (по usage_snapshot.active_sessions);
 * - max_context_tokens per-session (per-plan, через planQuotas);
 * - max_messages per-session.
 *
 * Решения:
 * - allow;
 * - deny (при жёстком превышении квот);
 * - allow_with_modifications (в основном для get_context_window с обрезкой max_tokens).
 *
 * PolicyEngine-интеграция:
 * - через IMemoryPolicyEngineAdapter (в MVP — stub-адаптер, всегда allow).
 */
export class StaticQuotaMemoryGovernanceService implements IMemoryGovernanceService {
  constructor(
    private readonly policyEngine: IMemoryPolicyEngineAdapter,
    private readonly auditSink: IMemoryGovernanceAuditSink,
    private readonly config: StaticMemoryGovernanceConfig = DEFAULT_CONFIG,
  ) {}

  async evaluateOperation(request: MemoryGovernanceRequest): Promise<MemoryGovernanceDecision> {
    const scope = resolveScope(request);
    const planTier = resolvePlanTier(request, this.config);
    const started = process.hrtime.bigint();

    let decision: MemoryGovernanceDecision = {
      status: 'allow',
      quota_status: 'ok',
      reasons: [],
      effects: {},
      quota_views: [],
      violations: [],
      audit_ref: undefined,
      policy_snapshot_id: undefined,
    };

    try {
      // 1. PolicyEngine (если подключён)
      let upstreamDecision: UpstreamPolicyDecision | undefined;
      try {
        upstreamDecision = await this.policyEngine.evaluate(request);
      } catch (err) {
        recordMemoryGovernanceError({
          operation: request.operation,
          stage: 'policy_engine',
          error: err,
        });
        // В MVP — деградация до локальных квот без PolicyEngine.
      }

      if (upstreamDecision) {
        this.applyUpstreamPolicy(decision, upstreamDecision, scope);
      }

      // 2. Локальные квоты/лимиты
      const planQuota = this.config.planQuotas[planTier] ?? DEFAULT_PLAN_QUOTAS[planTier];
      this.applyLocalQuotas(decision, request, scope, planQuota);

      if (decision.reasons.length === 0) {
        decision.reasons.push('ok');
      }

      // 3. Audit (best-effort)
      ensureDecisionArrays(decision);
      await this.auditSink.recordDecision({ request, decision, scope });

      // 4. Метрики решений
      const primaryReason: MemoryGovernanceReasonCode = decision.reasons[0];
      incrementMemoryGovernanceDecision({
        operation: request.operation,
        status: decision.status,
        scope,
        reason: primaryReason,
        planTier,
      });

      // TODO(OBS-NEXT.SEC-PE.2):
      // Как только PolicyEngine/Memory Governance начнёт возвращать агрегированный бюджет
      // (оставшийся лимит в USD или эквиваленте) на уровне tenant/окна,
      // здесь же следует обновлять policy_budget_remaining_usd через
      // getPolicyBudgetRemainingGauge().set({ tenant_id: request.tenant_id, window }, value).
      // Текущее состояние: в MemoryGovernanceRequest/Decision нет полей с бюджетами,
      // поэтому gauge сознательно не трогаем до расширения контрактов
      // (см. 02-PLANNING/P0_ADVANCED_OBSERVABILITY_MONITORING.md § OBS-NEXT.SEC-PE.2).

      return decision;
    } catch (err) {
      // Governance не должен ломать Memory-операции: fallback в allow с reason=internal_error.
      recordMemoryGovernanceError({
        operation: request.operation,
        stage: 'quota_evaluation',
        error: err,
      });

      const fallback: MemoryGovernanceDecision = {
        status: 'allow',
        quota_status: 'ok',
        reasons: ['internal_error'],
        effects: {},
      };

      // Audit fallback-решения
      try {
        await this.auditSink.recordDecision({
          request,
          decision: fallback,
          scope,
        });
      } catch {
        // Игнорируем audit-ошибки.
      }

      return fallback;
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - started) / 1e9;
      // В финальный статус/decision попадает либо "нормальное" решение, либо fallback.
      recordMemoryGovernanceEvaluationDuration({
        operation: request.operation,
        status: decision.status,
        scope,
        durationSeconds,
      });
    }
  }

  /**
   * Маппинг решения PolicyEngine в MemoryGovernanceDecision.
   *
   * Важно: локальные квоты могут только ужесточать решение, но не ослаблять deny.
   */
  private applyUpstreamPolicy(
    decision: MemoryGovernanceDecision,
    upstream: UpstreamPolicyDecision,
    scope: MemoryGovernanceScope,
  ): void {
    ensureDecisionArrays(decision);

    if (upstream.policy_evaluation_id) {
      decision.policy_evaluation_id = upstream.policy_evaluation_id;
    }

    if (upstream.status === 'deny') {
      decision.status = 'deny';
      decision.reasons.push('policy_engine_deny');
      decision.quota_status = decision.quota_status ?? 'hard_exceeded';
      decision.violations.push({
        code: 'policy_engine_deny',
        severity: 'error',
        scope,
        message: 'PolicyEngine returned deny for memory operation',
      });
      if (upstream.audit_ref) {
        decision.audit_ref = upstream.audit_ref;
        decision.policy_snapshot_id = upstream.audit_ref;
      }
      return;
    }

    if (upstream.status === 'allow_with_constraints') {
      if (decision.status === 'allow') {
        decision.status = 'allow_with_modifications';
      }
      this.applyUpstreamConstraints(decision, upstream.constraints);
      if (upstream.audit_ref) {
        decision.audit_ref = upstream.audit_ref;
        decision.policy_snapshot_id = upstream.audit_ref;
      }
    }
  }

  private applyUpstreamConstraints(
    decision: MemoryGovernanceDecision,
    constraints?: UpstreamPolicyConstraints,
  ): void {
    if (!constraints) return;

    const effects: MemoryGovernanceEffects = decision.effects ?? {};
    decision.effects = effects;

    if (typeof constraints.max_context_tokens === 'number') {
      const current = effects.truncate_context_to_tokens;
      const constrained = constraints.max_context_tokens;
      effects.truncate_context_to_tokens =
        typeof current === 'number' ? Math.min(current, constrained) : constrained;
    }

    if (constraints.forbid_long_term_persist) {
      // Запрещаем long-term persistence (HSG/Vector). Legacy путь остаётся разрешённым.
      effects.allow_hsg_persist = false;
      effects.allow_vector_persist = false;
      if (effects.allow_legacy_persist === undefined) {
        effects.allow_legacy_persist = true;
      }
    }
  }

  private resolveTenantQuota(tenantId: TenantId): TenantQuotaConfig {
    const overrides = this.config.tenantOverrides ?? {};
    return overrides[tenantId] ?? {
      maxActiveSessions: undefined,
      maxStorageBytes: this.config.maxStorageBytesPerTenant,
    };
  }

  private applyLocalQuotas(
    decision: MemoryGovernanceDecision,
    request: MemoryGovernanceRequest,
    scope: MemoryGovernanceScope,
    planQuota: PlanQuotaConfig,
  ): void {
    ensureDecisionArrays(decision);

    // Если уже deny (например, PolicyEngine), локальные квоты не могут его ослабить.
    if (decision.status === 'deny') {
      return;
    }

    const usage = request.usage_snapshot ?? this.emptyUsageSnapshot(request);
    const tenantQuota = this.resolveTenantQuota(request.tenant_id);

    // --- Per-tenant: max_active_sessions ---
    if (typeof tenantQuota.maxActiveSessions === 'number') {
      const active = usage.active_sessions ?? 0;

      decision.quota_views.push({
        scope: 'tenant',
        dimension: 'active_sessions',
        limit: tenantQuota.maxActiveSessions,
        used: active,
      });

      if (active >= tenantQuota.maxActiveSessions) {
        decision.status = 'deny';
        decision.quota_status = 'hard_exceeded';
        decision.reasons.push('tenant_active_sessions_limit_exceeded');
        decision.violations.push({
          code: 'tenant_active_sessions_limit_exceeded',
          severity: 'error',
          scope: 'tenant',
          message: 'Tenant active sessions hard limit exceeded',
        });
        return;
      }

      if (active >= tenantQuota.maxActiveSessions * 0.9) {
        // 90%+ — сигнализируем near_limit.
        if (!decision.quota_status || decision.quota_status === 'ok') {
          decision.quota_status = 'near_limit';
        }
      }
    }

    // --- Per-session: context_tokens ---
    const sessionSnapshot = usage.session;
    const limitTokens = planQuota.maxContextTokensPerSession;

    const sessionTokens =
      request.prospective_context_tokens ??
      request.current_context_tokens ??
      sessionSnapshot?.context_tokens;

    if (typeof sessionTokens === 'number') {
      decision.quota_views.push({
        scope: 'session',
        dimension: 'context_tokens',
        limit: limitTokens,
        used: sessionTokens,
      });

      // Жёсткий deny при значительном превышении лимита (например, >150%)
      const hardThreshold = limitTokens * 1.5;
      const isMutatingOperation =
        request.operation === 'add_message' || request.operation === 'create_session';

      if (isMutatingOperation && sessionTokens > hardThreshold) {
        decision.status = 'deny';
        decision.quota_status = 'hard_exceeded';
        decision.reasons.push('session_context_tokens_limit_exceeded');
        decision.violations.push({
          code: 'session_context_tokens_limit_exceeded',
          severity: 'error',
          scope: 'session',
          message: 'Session context tokens hard limit exceeded for mutating operation',
        });
        return;
      }

      if (sessionTokens > limitTokens) {
        // Мягкое превышение: allow_with_modifications для get_context_window,
        // allow (с near_limit) для остальных операций.
        if (request.operation === 'get_context_window') {
          if (decision.status === 'allow') {
            decision.status = 'allow_with_modifications';
          }
          const currentTruncate = decision.effects.truncate_context_to_tokens;
          decision.effects.truncate_context_to_tokens =
            typeof currentTruncate === 'number'
              ? Math.min(currentTruncate, limitTokens)
              : limitTokens;
        }

        if (!decision.quota_status || decision.quota_status === 'ok') {
          decision.quota_status = 'soft_exceeded';
        }

        decision.reasons.push('session_context_tokens_limit_exceeded');
      }
    }

    // --- Per-session: messages ---
    const baseMessageCount = sessionSnapshot?.message_count ?? 0;
    const prospectiveMessages =
      baseMessageCount + (request.operation === 'add_message' ? 1 : 0);
    const limitMessages = planQuota.maxMessagesPerSession;

    decision.quota_views.push({
      scope: 'session',
      dimension: 'messages',
      limit: limitMessages,
      used: prospectiveMessages,
    });

    if (prospectiveMessages > limitMessages) {
      // Для превышения количества сообщений — жёсткий deny add_message.
      if (request.operation === 'add_message') {
        decision.status = 'deny';
        decision.quota_status = 'hard_exceeded';
        decision.reasons.push('session_messages_limit_exceeded');
        decision.violations.push({
          code: 'session_messages_limit_exceeded',
          severity: 'error',
          scope: 'session',
          message: 'Session messages hard limit exceeded',
        });
        return;
      }

      // Для read-only операций просто сигнализируем soft_exceeded.
      if (!decision.quota_status || decision.quota_status === 'ok') {
        decision.quota_status = 'soft_exceeded';
      }
      decision.reasons.push('session_messages_limit_exceeded');
    }
  }

  private emptyUsageSnapshot(request: MemoryGovernanceRequest): MemoryUsageSnapshot {
    return {
      tenant_id: request.tenant_id,
      active_sessions: 0,
      total_context_tokens: 0,
      total_storage_bytes: 0,
    };
  }
}

/**
 * Helper для создания дефолтного governance-сервиса в DI.
 */
export function createDefaultMemoryGovernanceService(
  policyAdapter: IMemoryPolicyEngineAdapter,
  auditSink: IMemoryGovernanceAuditSink,
  config: StaticMemoryGovernanceConfig = DEFAULT_CONFIG,
): IMemoryGovernanceService {
  return new StaticQuotaMemoryGovernanceService(policyAdapter, auditSink, config);
}
