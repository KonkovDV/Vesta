/**
 * MAS Runtime Policy Layer - non-durable retry policy service.
 *
 * Layer: Application (MAS runtime core).
 *
 * Scope MAS-RT-R2-C1:
 * - exposes NonDurableRetryPolicy contract for MasterAgentV1 non-durable branch;
 * - reads best-effort overrides from config-layer (AppConfig / env vars) without
 *   leaking raw environment reads into MasterAgentV1;
 * - enforces R1-compatible defaults and guard-rails with structured logging.
 */

import type { IStructuredLogger } from '../../../core/logging/IStructuredLogger';
import type { MasMetadataBag } from '../types/mas-types';
import type { MasErrorCategory } from '../../../domain/mas/services/mas-error-types';
import type { MasTaskExecution } from '../../../domain/mas/MasTaskExecution';
import {
  DEFAULT_TASK_TIMEOUT_MS,
  DEFAULT_STEP_TIMEOUT_MS,
  DEFAULT_MAX_STEP_RETRY_ATTEMPTS,
  DEFAULT_CB_BLOCKED_COOLDOWN_MS,
  DEFAULT_CB_BLOCKED_MAX_DURATION_MS,
  type DurableExecutionPolicy,
  type IMasDurableExecutionPolicyProvider,
} from '../../../domain/mas/services/MasRecoveryService';
import {
  observeDurableEffectivePolicy,
  recordDurableSloPolicyFallback,
  recordDurableSloProfileApplied,
  type DurableScopeLabel,
  type DurableSloFallbackReason,
} from '../observability/mas-metrics';

export type MasScenarioId = string;

/**
 * Non-durable retry policy surface for MasterAgentV1 non-durable branch.
 *
 * Semantics of fields are aligned with MAS_RUNTIME_CORE_ARCHITECTURE §6.7.1.
 */
export interface NonDurableRetryPolicy {
  /**
   * Max number of additional non-durable retry attempts per MAS task
   * (after the first attempt). 0 disables retry, 1 reproduces R1 behaviour.
   */
  maxNonDurableRetries: number;

  /**
   * Threshold of consecutive transient errors within a MAS session after which
   * the in-process session breaker is opened and subsequent tasks are skipped.
   */
  maxConsecutiveTransientErrorsPerSession: number;

  /**
   * Whitelist of MasErrorCategory values eligible for non-durable retry.
   */
  allowedErrorCategories: MasErrorCategory[];

  /**
   * Blacklist of logical error codes for which retry is always forbidden
   * even if the category is allowed (e.g. CIRCUIT_OPEN).
   */
  disallowedRetryErrorCodes: string[];
}

export interface GetNonDurableRetryPolicyParams {
  scenarioId: MasScenarioId;
  /**
   * Reserved for future tenant-level overrides (R3+). Currently unused but
   * kept in API to avoid breaking changes later.
   */
  tenantId?: string;
}

/**
 * DI token for MAS runtime policy service.
 *
 * Registration is performed in the MAS core DI module:
 * - src/infrastructure/di/modules/mas-core.module.ts
 */
export const masRuntimePolicyServiceToken =
  'MasRuntimePolicyService' as const;
export type MasRuntimePolicyServiceDiToken =
  | typeof masRuntimePolicyServiceToken;

/**
 * R1-compatible defaults for non-durable retry/session-breaker policy.
 *
 * These values reproduce the behaviour of MasterAgentV1 resilience v1
 * (Wave2 / A‑W2‑02) when no configuration is provided or configuration
 * is invalid.
 */
export const R1_DEFAULT_NON_DURABLE_RETRY_POLICY: NonDurableRetryPolicy = {
  maxNonDurableRetries: 1,
  maxConsecutiveTransientErrorsPerSession: 3,
  allowedErrorCategories: ['memory', 'session_state'],
  disallowedRetryErrorCodes: ['CIRCUIT_OPEN'],
};

const VALID_ERROR_CATEGORIES: MasErrorCategory[] = [
  'decomposition',
  'execution',
  'memory',
  'policy',
  'plugin',
  'session_state',
  'unknown',
];

type NonDurableRetryPolicyConfigInput = {
  maxNonDurableRetries?: unknown;
  maxConsecutiveTransientErrorsPerSession?: unknown;
  allowedErrorCategories?: unknown;
  disallowedRetryErrorCodes?: unknown;
};

type NonDurableRetryPolicyTenantConfig = {
  global?: NonDurableRetryPolicyConfigInput;
  scenarios?: Record<string, NonDurableRetryPolicyConfigInput>;
};

type NonDurableRetryPolicyConfig = {
  global?: NonDurableRetryPolicyConfigInput;
  scenarios?: Record<string, NonDurableRetryPolicyConfigInput>;
  tenants?: Record<string, NonDurableRetryPolicyTenantConfig>;
};

type DurableExecutionPolicyConfigInput = {
  defaultTaskTimeoutMs?: unknown;
  defaultStepTimeoutMs?: unknown;
  maxStepRetryAttempts?: unknown;
  cbBlockedCooldownMs?: unknown;
  cbBlockedMaxDurationMs?: unknown;
  cbMaxRecoveryAttempts?: unknown;
};

type DurableExecutionPolicyScopeConfigInput =
  DurableExecutionPolicyConfigInput & {
    /**
     * Optional logical SLO profile identifier for this scope.
     *
     * R3‑C2‑C1 wiring only: parsed and exposed but not yet applied to
     * DurableExecutionPolicy; behaviour remains R1/R2‑equivalent.
     */
    sloProfileId?: string;
  };

type DurableSloProfileInput = {
  defaultTaskTimeoutMs?: unknown;
  defaultStepTimeoutMs?: unknown;
  maxStepRetryAttempts?: unknown;
  cbBlockedCooldownMs?: unknown;
  cbBlockedMaxDurationMs?: unknown;
  cbMaxRecoveryAttempts?: unknown;
};

type DurableSloProfile = {
  defaultTaskTimeoutMs: number;
  defaultStepTimeoutMs: number;
  maxStepRetryAttempts: number;
  cbBlockedCooldownMs: number;
  cbBlockedMaxDurationMs: number;
  cbMaxRecoveryAttempts: number;
};

type DurableExecutionPolicyTenantConfig = {
  global?: DurableExecutionPolicyScopeConfigInput;
  scenarios?: Record<string, DurableExecutionPolicyScopeConfigInput>;
};

type DurableExecutionPolicyConfig = {
  global?: DurableExecutionPolicyScopeConfigInput;
  scenarios?: Record<string, DurableExecutionPolicyScopeConfigInput>;
  tenants?: Record<string, DurableExecutionPolicyTenantConfig>;
  /**
   * Normalized SLO profiles map (values clamped to guard‑rails).
   *
   * R3‑C2‑C1 wiring only: profiles are parsed and stored here but
   * are not yet taken into account when building DurableExecutionPolicy.
   */
  sloProfiles?: Record<string, DurableSloProfile>;
};

type RuntimePolicyConfigRecord = Record<string, unknown>;

type RuntimePolicyConfigLoader = {
  get(): RuntimePolicyConfigRecord;
  getValue?(key: string): unknown;
};

/**
 * Logical durable policy scope used for diagnostics / observability only.
 *
 * Matches MAS_RUNTIME_CORE_ARCHITECTURE §6.7.7.1 durable_scope values.
 */
type DurablePolicyScopeType =
  | 'tenant_scenario'
  | 'tenant_global'
  | 'scenario'
  | 'global'
  | 'baseline';

/**
 * Lightweight diagnostics snapshot for SLO‑aware durable policy resolution.
 *
 * Stored in MasTaskExecution.meta.durable_policy_debug and later propagated
 * into MasExecutionError.details / MAS events as per MAS‑RT‑R3‑C2‑C3 spec.
 */
type DurablePolicyDebugPayload = {
  tenant_id?: string;
  scenario_id: string;
  durable_scope: DurablePolicyScopeType;
  slo_profile_id_input?: string;
  slo_profile_id_resolved: string;
  policy_source: 'r1_r2_defaults' | 'scope_override' | 'slo_profile';
  durable_policy_snapshot: {
    effective_task_timeout_ms: number;
    effective_step_timeout_ms: number;
    effective_max_step_retries: number;
    effective_cb_blocked_cooldown_ms: number;
    effective_cb_blocked_max_duration_ms: number;
    effective_cb_max_recovery_attempts: number;
  };
};

const DURABLE_SLO_GUARDS = {
  // Guard‑rails aligned with §6.7.1 MAS_RUNTIME_CORE_ARCHITECTURE.md.
  defaultTaskTimeoutMs: { min: 10_000, max: 86_400_000 },
  defaultStepTimeoutMs: { min: 1_000, max: 86_400_000 },
  maxStepRetryAttempts: { min: 0, max: 10 },
  cbBlockedCooldownMs: { min: 10_000, max: 3_600_000 },
  cbBlockedMaxDurationMs: { min: 60_000, max: 86_400_000 },
  cbMaxRecoveryAttempts: { min: 1, max: 20 },
} as const;

/**
 * Application-layer service that encapsulates MAS runtime policy resolution
 * for non-durable retry/session-breaker.
 *
 * It is intentionally synchronous and side-effect free except for structured
 * logging of invalid configuration.
 */
export interface IMasRuntimePolicyService
  extends IMasDurableExecutionPolicyProvider {
  getNonDurableRetryPolicy(
    params: GetNonDurableRetryPolicyParams,
  ): NonDurableRetryPolicy;
}

export class MasRuntimePolicyService implements IMasRuntimePolicyService {
  constructor(
    private readonly logger?: IStructuredLogger,
    private readonly configLoader?: RuntimePolicyConfigLoader,
  ) {}

  getNonDurableRetryPolicy(
    params: GetNonDurableRetryPolicyParams,
  ): NonDurableRetryPolicy {
    const cfg = this.getRuntimeConfig();

    const raw =
      this.configLoader?.getValue?.('MAS_RUNTIME_POLICY_NON_DURABLE') ??
      cfg['MAS_RUNTIME_POLICY_NON_DURABLE'];
    const parsed = this.parseConfig(raw);

    const scenarioId = params.scenarioId;
    const tenantId = params.tenantId;

    // Helper to get effective config for a field with tenant-aware priority
    const getEffectiveValue = (field: keyof NonDurableRetryPolicyConfigInput): { scenarioValue: unknown; globalValue: unknown } => {
      const tenantScenario = tenantId
        ? parsed?.tenants?.[tenantId]?.scenarios?.[scenarioId]
        : undefined;
      const tenantGlobal = tenantId
        ? parsed?.tenants?.[tenantId]?.global
        : undefined;

      if (tenantScenario?.[field] !== undefined) {
        // 1. tenants[tenantId].scenarios[scenarioId] (highest priority)
        return { scenarioValue: tenantScenario[field], globalValue: undefined };
      } else if (tenantGlobal?.[field] !== undefined) {
        // 2. tenants[tenantId].global
        return { scenarioValue: tenantGlobal[field], globalValue: undefined };
      } else {
        // 3-4. scenarios[scenarioId] or global (fallback to existing R2 behavior)
        return {
          scenarioValue: parsed?.scenarios?.[scenarioId]?.[field],
          globalValue: parsed?.global?.[field]
        };
      }
    };

    const maxNonDurableRetries = this.resolveNumberWithGuard({
      ...getEffectiveValue('maxNonDurableRetries'),
      defaultValue: R1_DEFAULT_NON_DURABLE_RETRY_POLICY.maxNonDurableRetries,
      min: 0,
      max: 5,
      policyKey: 'nonDurable.maxNonDurableRetries',
      scenarioId,
    });

    const maxConsecutiveTransientErrorsPerSession =
      this.resolveNumberWithGuard({
        ...getEffectiveValue('maxConsecutiveTransientErrorsPerSession'),
        defaultValue:
          R1_DEFAULT_NON_DURABLE_RETRY_POLICY
            .maxConsecutiveTransientErrorsPerSession,
        min: 1,
        max: 50,
        policyKey: 'nonDurable.maxConsecutiveTransientErrorsPerSession',
        scenarioId,
      });

    const allowedErrorCategories = this.resolveAllowedErrorCategories({
      ...getEffectiveValue('allowedErrorCategories'),
      defaultValue: R1_DEFAULT_NON_DURABLE_RETRY_POLICY.allowedErrorCategories,
      policyKey: 'nonDurable.allowedErrorCategories',
      scenarioId,
    });

    const disallowedRetryErrorCodes = this.resolveDisallowedErrorCodes({
      ...getEffectiveValue('disallowedRetryErrorCodes'),
      defaultValue:
        R1_DEFAULT_NON_DURABLE_RETRY_POLICY.disallowedRetryErrorCodes,
      policyKey: 'nonDurable.disallowedRetryErrorCodes',
      scenarioId,
    });

    return {
      maxNonDurableRetries,
      maxConsecutiveTransientErrorsPerSession,
      allowedErrorCategories,
      disallowedRetryErrorCodes,
    };
  }

  getDurableExecutionPolicyForTask(
    task: MasTaskExecution,
  ): DurableExecutionPolicy {
    const cfg = this.getRuntimeConfig();

    const raw =
      this.configLoader?.getValue?.('MAS_RUNTIME_POLICY_DURABLE') ??
      cfg['MAS_RUNTIME_POLICY_DURABLE'];

    if (raw === undefined || raw === null) {
      // No durable config provided – count a baseline fallback for observability.
      recordDurableSloPolicyFallback({
        reason: 'no_config',
        policyKey: 'durable',
        durableScope: 'baseline',
      });
    }

    const parsed = this.parseDurableConfig(raw);

    const scenarioId = this.extractScenarioIdFromTask(task);
    const tenantId = this.extractTenantIdFromTask(task);

    const hasSloProfiles =
      parsed?.sloProfiles && Object.keys(parsed.sloProfiles).length > 0;

    const {
      scopeConfig: effectiveScope,
      scopeType: durableScope,
      sloProfileIdInput,
      hasNumericOverrides,
    } = this.getEffectiveDurableScopeDebug(parsed, scenarioId, tenantId);

    // Base policy_source is determined by presence of numeric overrides and SLO profile.
    const determinePolicySource = (
      hasOverrides: boolean,
      hasProfile: boolean,
    ): 'r1_r2_defaults' | 'scope_override' | 'slo_profile' => {
      if (hasOverrides) {
        return 'scope_override';
      }
      if (hasProfile) {
        return 'slo_profile';
      }
      return 'r1_r2_defaults';
    };

    let selectedProfile: DurableSloProfile | undefined;
    let sloProfileIdResolved = '__baseline__';

    const globalConfig: DurableExecutionPolicyScopeConfigInput | undefined =
      parsed?.global;

    if (parsed?.sloProfiles && effectiveScope?.sloProfileId) {
      const sloProfileId = effectiveScope.sloProfileId;
      const profile = parsed.sloProfiles[sloProfileId];

      if (profile) {
        selectedProfile = profile;
        sloProfileIdResolved = sloProfileId;
      } else {
        this.logConfigError({
          policyKey: 'durable.sloProfileId',
          scope: 'profile',
          reason: 'unknown_slo_profile_id',
          rawValue: sloProfileId,
          scenarioId,
          meta: tenantId ? { tenantId, sloProfileId } : { sloProfileId },
        });
      }
    }

    const policySource = determinePolicySource(
      hasNumericOverrides,
      Boolean(selectedProfile),
    );

    const defaultTaskTimeoutMs = this.resolveDurableNumberWithSlo({
      scenarioValue: effectiveScope?.defaultTaskTimeoutMs,
      globalValue: globalConfig?.defaultTaskTimeoutMs,
      profileValue: selectedProfile?.defaultTaskTimeoutMs,
      defaultValue: DEFAULT_TASK_TIMEOUT_MS,
      min: DURABLE_SLO_GUARDS.defaultTaskTimeoutMs.min,
      max: DURABLE_SLO_GUARDS.defaultTaskTimeoutMs.max,
      policyKey: 'durable.defaultTaskTimeoutMs',
      scenarioId,
    });

    const defaultStepTimeoutMs = this.resolveDurableNumberWithSlo({
      scenarioValue: effectiveScope?.defaultStepTimeoutMs,
      globalValue: globalConfig?.defaultStepTimeoutMs,
      profileValue: selectedProfile?.defaultStepTimeoutMs,
      defaultValue: DEFAULT_STEP_TIMEOUT_MS,
      min: DURABLE_SLO_GUARDS.defaultStepTimeoutMs.min,
      max: DURABLE_SLO_GUARDS.defaultStepTimeoutMs.max,
      policyKey: 'durable.defaultStepTimeoutMs',
      scenarioId,
    });

    const maxStepRetryAttempts = this.resolveDurableNumberWithSlo({
      scenarioValue: effectiveScope?.maxStepRetryAttempts,
      globalValue: globalConfig?.maxStepRetryAttempts,
      profileValue: selectedProfile?.maxStepRetryAttempts,
      defaultValue: DEFAULT_MAX_STEP_RETRY_ATTEMPTS,
      min: DURABLE_SLO_GUARDS.maxStepRetryAttempts.min,
      max: DURABLE_SLO_GUARDS.maxStepRetryAttempts.max,
      policyKey: 'durable.maxStepRetryAttempts',
      scenarioId,
    });

    const cbBlockedCooldownMs = this.resolveDurableNumberWithSlo({
      scenarioValue: effectiveScope?.cbBlockedCooldownMs,
      globalValue: globalConfig?.cbBlockedCooldownMs,
      profileValue: selectedProfile?.cbBlockedCooldownMs,
      defaultValue: DEFAULT_CB_BLOCKED_COOLDOWN_MS,
      min: DURABLE_SLO_GUARDS.cbBlockedCooldownMs.min,
      max: DURABLE_SLO_GUARDS.cbBlockedCooldownMs.max,
      policyKey: 'durable.cbBlockedCooldownMs',
      scenarioId,
    });

    const cbBlockedMaxDurationMs = this.resolveDurableNumberWithSlo({
      scenarioValue: effectiveScope?.cbBlockedMaxDurationMs,
      globalValue: globalConfig?.cbBlockedMaxDurationMs,
      profileValue: selectedProfile?.cbBlockedMaxDurationMs,
      defaultValue: DEFAULT_CB_BLOCKED_MAX_DURATION_MS,
      min: DURABLE_SLO_GUARDS.cbBlockedMaxDurationMs.min,
      max: DURABLE_SLO_GUARDS.cbBlockedMaxDurationMs.max,
      policyKey: 'durable.cbBlockedMaxDurationMs',
      scenarioId,
    });

    const cbMaxRecoveryAttempts = this.resolveDurableNumberWithSlo({
      scenarioValue: effectiveScope?.cbMaxRecoveryAttempts,
      globalValue: globalConfig?.cbMaxRecoveryAttempts,
      profileValue: selectedProfile?.cbMaxRecoveryAttempts,
      defaultValue: DEFAULT_MAX_STEP_RETRY_ATTEMPTS,
      min: DURABLE_SLO_GUARDS.cbMaxRecoveryAttempts.min,
      max: DURABLE_SLO_GUARDS.cbMaxRecoveryAttempts.max,
      policyKey: 'durable.cbMaxRecoveryAttempts',
      scenarioId,
    });

    const basePolicy: DurableExecutionPolicy = {
      defaultTaskTimeoutMs,
      defaultStepTimeoutMs,
      maxStepRetryAttempts,
      cbBlockedCooldownMs,
      cbBlockedMaxDurationMs,
      cbMaxRecoveryAttempts,
    };

    const policy = this.applyDurablePolicyInvariants({
      policy: basePolicy,
      scenarioId,
      durableScope,
    });

    this.publishDurablePolicyDebugSnapshot({
      task,
      tenantId,
      scenarioId,
      durableScope,
      sloProfileIdInput,
      sloProfileIdResolved,
      policySource,
      policy,
    });

    return policy;
  }

  private parseConfig(
    raw: unknown,
  ): NonDurableRetryPolicyConfig | undefined {
    if (!raw) {
      return undefined;
    }

    let parsed: unknown;
    if (typeof raw === 'object') {
      parsed = raw;
    } else if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        this.logConfigError({
          policyKey: 'nonDurable',
          scope: 'global',
          reason: 'invalid_json',
          rawValue: raw,
          error,
        });
        return undefined;
      }
    } else {
      this.logConfigError({
        policyKey: 'nonDurable',
        scope: 'global',
        reason: 'invalid_type',
        rawValue: raw,
      });
      return undefined;
    }

    const config = this.toConfigRecord(parsed);
    if (!config) {
      this.logConfigError({
        policyKey: 'nonDurable',
        scope: 'global',
        reason: 'invalid_type_after_parse',
        rawValue: parsed,
      });
      return undefined;
    }

    const result: NonDurableRetryPolicyConfig = {};

    const global = this.toNonDurableScopeConfig(config.global);
    if (global) {
      result.global = global;
    }

    const scenarios = this.toNonDurableScopeMap(config.scenarios);
    if (scenarios) {
      result.scenarios = scenarios;
    }

    const tenants = this.toConfigRecord(config.tenants);
    if (tenants) {
      try {
        const parsedTenants: Record<string, NonDurableRetryPolicyTenantConfig> = {};

        for (const [tenantId, tenantConfig] of Object.entries(tenants)) {
          const tenantResult = this.toNonDurableTenantConfig(tenantConfig);
          if (tenantResult) {
            parsedTenants[tenantId] = tenantResult;
          }
        }

        if (Object.keys(parsedTenants).length > 0) {
          result.tenants = parsedTenants;
        }
      } catch (error) {
        // Log error but continue without tenants - graceful degradation
        this.logConfigError({
          policyKey: 'nonDurable',
          scope: 'global',
          reason: 'failed_to_parse_tenants',
          rawValue: config.tenants,
          error,
        });
      }
    }

    return result;
  }

  private parseDurableConfig(
    raw: unknown,
  ): DurableExecutionPolicyConfig | undefined {
    if (!raw) {
      return undefined;
    }

    let parsed: unknown;

    if (typeof raw === 'object') {
      parsed = raw;
    } else if (typeof raw === 'string') {
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch (error) {
        this.logConfigError({
          policyKey: 'durable',
          scope: 'global',
          reason: 'invalid_json',
          rawValue: raw,
          error,
        });
        return undefined;
      }
    } else {
      this.logConfigError({
        policyKey: 'durable',
        scope: 'global',
        reason: 'invalid_type',
        rawValue: raw,
      });
      return undefined;
    }

    const config = this.toConfigRecord(parsed);
    if (!config) {
      this.logConfigError({
        policyKey: 'durable',
        scope: 'global',
        reason: 'invalid_type_after_parse',
        rawValue: parsed,
      });
      return undefined;
    }

    const result: DurableExecutionPolicyConfig = {};

    const global = this.toDurableScopeConfig(config.global);
    if (global) {
      result.global = global;
    }

    const scenarios = this.toDurableScopeMap(config.scenarios);
    if (scenarios) {
      result.scenarios = scenarios;
    }

    // Tenant-level durable policies (R3‑C2‑C1 wiring only).
    const tenants = this.toConfigRecord(config.tenants);
    if (tenants) {
      try {
        const parsedTenants: Record<string, DurableExecutionPolicyTenantConfig> =
          {};

        for (const [tenantId, tenantConfig] of Object.entries(tenants)) {
          const tenantResult = this.toDurableTenantConfig(tenantConfig);
          if (tenantResult) {
            parsedTenants[tenantId] = tenantResult;
          }
        }

        if (Object.keys(parsedTenants).length > 0) {
          result.tenants = parsedTenants;
        }
      } catch (error) {
        this.logConfigError({
          policyKey: 'durable',
          scope: 'global',
          reason: 'failed_to_parse_tenants',
          rawValue: config.tenants,
          error,
        });
      }
    } else if (config.tenants !== undefined) {
      this.logConfigError({
        policyKey: 'durable',
        scope: 'global',
        reason: 'invalid_tenants_type',
        rawValue: config.tenants,
      });
    }

    // SLO profiles dictionary (R3‑C2‑C1 wiring only).
    const rawProfiles = this.toConfigRecord(config.sloProfiles);
    if (rawProfiles) {
      const normalizedProfiles: Record<string, DurableSloProfile> = {};

      for (const [profileId, profileRaw] of Object.entries(rawProfiles)) {
        if (!this.toConfigRecord(profileRaw)) {
          this.logConfigError({
            policyKey: 'durable',
            scope: 'global',
            reason: 'invalid_slo_profile_type',
            rawValue: profileRaw,
            meta: { profileId },
          });
          continue;
        }

        const normalized = this.normalizeDurableSloProfile(
          profileId,
          profileRaw,
        ) as DurableSloProfile;

        normalizedProfiles[profileId] = normalized;
      }

      if (Object.keys(normalizedProfiles).length > 0) {
        result.sloProfiles = normalizedProfiles;
      }
    } else if (config.sloProfiles !== undefined) {
      this.logConfigError({
        policyKey: 'durable',
        scope: 'global',
        reason: 'invalid_slo_profiles_type',
        rawValue: config.sloProfiles,
      });
    }

    return result;
  }

  private normalizeDurableSloProfile(
    profileId: string,
    input: unknown,
  ): DurableSloProfile | undefined {
    const profileInput = this.toConfigRecord(input);
    if (!profileInput) {
      this.logConfigError({
        policyKey: 'durable',
        scope: 'global',
        reason: 'invalid_slo_profile_type',
        rawValue: input,
        meta: { profileId },
      });
      return undefined;
    }

    const {
      defaultTaskTimeoutMs: taskTimeoutRaw,
      defaultStepTimeoutMs: stepTimeoutRaw,
      maxStepRetryAttempts: maxStepRetriesRaw,
      cbBlockedCooldownMs: cbCooldownRaw,
      cbBlockedMaxDurationMs: cbMaxDurationRaw,
      cbMaxRecoveryAttempts: cbMaxRecoveryAttemptsRaw,
    } = profileInput;

    const defaultTaskTimeoutMs = this.coerceDurableSloNumber({
      profileId,
      field: 'defaultTaskTimeoutMs',
      rawValue: taskTimeoutRaw,
      defaultValue: DEFAULT_TASK_TIMEOUT_MS,
      min: DURABLE_SLO_GUARDS.defaultTaskTimeoutMs.min,
      max: DURABLE_SLO_GUARDS.defaultTaskTimeoutMs.max,
    });

    const defaultStepTimeoutMs = this.coerceDurableSloNumber({
      profileId,
      field: 'defaultStepTimeoutMs',
      rawValue: stepTimeoutRaw,
      defaultValue: DEFAULT_STEP_TIMEOUT_MS,
      min: DURABLE_SLO_GUARDS.defaultStepTimeoutMs.min,
      max: DURABLE_SLO_GUARDS.defaultStepTimeoutMs.max,
    });

    const maxStepRetryAttempts = this.coerceDurableSloNumber({
      profileId,
      field: 'maxStepRetryAttempts',
      rawValue: maxStepRetriesRaw,
      defaultValue: DEFAULT_MAX_STEP_RETRY_ATTEMPTS,
      min: DURABLE_SLO_GUARDS.maxStepRetryAttempts.min,
      max: DURABLE_SLO_GUARDS.maxStepRetryAttempts.max,
    });

    const cbBlockedCooldownMs = this.coerceDurableSloNumber({
      profileId,
      field: 'cbBlockedCooldownMs',
      rawValue: cbCooldownRaw,
      defaultValue: DEFAULT_CB_BLOCKED_COOLDOWN_MS,
      min: DURABLE_SLO_GUARDS.cbBlockedCooldownMs.min,
      max: DURABLE_SLO_GUARDS.cbBlockedCooldownMs.max,
    });

    const cbBlockedMaxDurationMs = this.coerceDurableSloNumber({
      profileId,
      field: 'cbBlockedMaxDurationMs',
      rawValue: cbMaxDurationRaw,
      defaultValue: DEFAULT_CB_BLOCKED_MAX_DURATION_MS,
      min: DURABLE_SLO_GUARDS.cbBlockedMaxDurationMs.min,
      max: DURABLE_SLO_GUARDS.cbBlockedMaxDurationMs.max,
    });

    const cbMaxRecoveryAttempts = this.coerceDurableSloNumber({
      profileId,
      field: 'cbMaxRecoveryAttempts',
      rawValue: cbMaxRecoveryAttemptsRaw,
      defaultValue: DEFAULT_MAX_STEP_RETRY_ATTEMPTS,
      min: DURABLE_SLO_GUARDS.cbMaxRecoveryAttempts.min,
      max: DURABLE_SLO_GUARDS.cbMaxRecoveryAttempts.max,
    });

    return {
      defaultTaskTimeoutMs,
      defaultStepTimeoutMs,
      maxStepRetryAttempts,
      cbBlockedCooldownMs,
      cbBlockedMaxDurationMs,
      cbMaxRecoveryAttempts,
    };
  }

  private coerceDurableSloNumber(params: {
    profileId: string;
    field: keyof DurableSloProfile;
    rawValue: unknown;
    defaultValue: number;
    min: number;
    max: number;
  }): number {
    const { profileId, field, rawValue, defaultValue, min, max } = params;

    const value = this.tryCoerceNumber(
      rawValue,
      min,
      max,
      `durable.sloProfiles.${String(field)}`,
      'profile',
      profileId,
    );

    if (value != null) {
      return value;
    }

    // Fallback: clamp default value into guard-rail range.
    if (defaultValue < min || defaultValue > max) {
      return Math.max(min, Math.min(max, defaultValue));
    }

    return defaultValue;
  }

  private toConfigRecord(
    value: unknown,
  ): RuntimePolicyConfigRecord | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined;
    }

    return value as RuntimePolicyConfigRecord;
  }

  private toNonDurableScopeConfig(
    value: unknown,
  ): NonDurableRetryPolicyConfigInput | undefined {
    return this.toConfigRecord(value);
  }

  private toNonDurableScopeMap(
    value: unknown,
  ): Record<string, NonDurableRetryPolicyConfigInput> | undefined {
    return this.toConfigRecord(value) as Record<string, NonDurableRetryPolicyConfigInput> | undefined;
  }

  private toNonDurableTenantConfig(
    value: unknown,
  ): NonDurableRetryPolicyTenantConfig | undefined {
    const record = this.toConfigRecord(value);
    if (!record) {
      return undefined;
    }

    const tenantConfig: NonDurableRetryPolicyTenantConfig = {};
    const global = this.toNonDurableScopeConfig(record.global);
    if (global) {
      tenantConfig.global = global;
    }

    const scenarios = this.toNonDurableScopeMap(record.scenarios);
    if (scenarios) {
      tenantConfig.scenarios = scenarios;
    }

    return tenantConfig;
  }

  private toDurableScopeConfig(
    value: unknown,
  ): DurableExecutionPolicyScopeConfigInput | undefined {
    return this.toConfigRecord(value);
  }

  private toDurableScopeMap(
    value: unknown,
  ): Record<string, DurableExecutionPolicyScopeConfigInput> | undefined {
    return this.toConfigRecord(value) as Record<string, DurableExecutionPolicyScopeConfigInput> | undefined;
  }

  private toDurableTenantConfig(
    value: unknown,
  ): DurableExecutionPolicyTenantConfig | undefined {
    const record = this.toConfigRecord(value);
    if (!record) {
      return undefined;
    }

    const tenantConfig: DurableExecutionPolicyTenantConfig = {};
    const global = this.toDurableScopeConfig(record.global);
    if (global) {
      tenantConfig.global = global;
    }

    const scenarios = this.toDurableScopeMap(record.scenarios);
    if (scenarios) {
      tenantConfig.scenarios = scenarios;
    }

    return tenantConfig;
  }

  private resolveNumberWithGuard(params: {
    scenarioValue: unknown;
    globalValue: unknown;
    defaultValue: number;
    min: number;
    max: number;
    policyKey: string;
    scenarioId: string;
  }): number {
    const {
      scenarioValue,
      globalValue,
      defaultValue,
      min,
      max,
      policyKey,
      scenarioId,
    } = params;

    const scenarioResolved = this.tryCoerceNumber(
      scenarioValue,
      min,
      max,
      policyKey,
      'scenario',
      scenarioId,
    );

    if (scenarioResolved != null) {
      return scenarioResolved;
    }

    const globalResolved = this.tryCoerceNumber(
      globalValue,
      min,
      max,
      policyKey,
      'global',
    );

    if (globalResolved != null) {
      return globalResolved;
    }

    return defaultValue;
  }

  private tryCoerceNumber(
    raw: unknown,
    min: number,
    max: number,
    policyKey: string,
    scope: 'global' | 'scenario' | 'profile',
    scenarioId?: string,
  ): number | undefined {
    if (raw === undefined || raw === null) {
      return undefined;
    }

    let value: number | undefined;

    if (typeof raw === 'number') {
      value = raw;
    } else if (typeof raw === 'string' && raw.trim().length > 0) {
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) {
        value = parsed;
      }
    }

    if (value == null || !Number.isFinite(value)) {
      this.logConfigError({
        policyKey,
        scope,
        scenarioId,
        reason: 'not_a_number',
        rawValue: raw,
      });
      return undefined;
    }

    if (value < min || value > max) {
      this.logConfigError({
        policyKey,
        scope,
        scenarioId,
        reason: 'out_of_range',
        rawValue: raw,
        meta: { min, max },
      });
      // Apply guard-rail: clamp to valid range instead of rejecting
      return Math.max(min, Math.min(max, value));
    }

    return value;
  }

  private resolveAllowedErrorCategories(params: {
    scenarioValue: unknown;
    globalValue: unknown;
    defaultValue: MasErrorCategory[];
    policyKey: string;
    scenarioId: string;
  }): MasErrorCategory[] {
    const {
      scenarioValue,
      globalValue,
      defaultValue,
      policyKey,
      scenarioId,
    } = params;

    const scenarioCats = this.tryResolveErrorCategories(
      scenarioValue,
      policyKey,
      'scenario',
      scenarioId,
    );
    if (scenarioCats && scenarioCats.length > 0) {
      return scenarioCats;
    }

    const globalCats = this.tryResolveErrorCategories(
      globalValue,
      policyKey,
      'global',
    );
    if (globalCats && globalCats.length > 0) {
      return globalCats;
    }

    return defaultValue;
  }

  private tryResolveErrorCategories(
    raw: unknown,
    policyKey: string,
    scope: 'global' | 'scenario',
    scenarioId?: string,
  ): MasErrorCategory[] | undefined {
    if (raw === undefined || raw === null) {
      return undefined;
    }

    const asStrings = this.parseStringArray(raw);
    if (!asStrings) {
      this.logConfigError({
        policyKey,
        scope,
        scenarioId,
        reason: 'invalid_array',
        rawValue: raw,
      });
      return undefined;
    }

    const normalized = asStrings
      .map(v => String(v).trim())
      .filter(v => v.length > 0)
      .map(v => v as MasErrorCategory)
      .filter(v => VALID_ERROR_CATEGORIES.includes(v));

    if (normalized.length === 0) {
      this.logConfigError({
        policyKey,
        scope,
        scenarioId,
        reason: 'no_valid_values',
        rawValue: raw,
      });
      return undefined;
    }

    return Array.from(new Set(normalized));
  }

  private resolveDisallowedErrorCodes(params: {
    scenarioValue: unknown;
    globalValue: unknown;
    defaultValue: string[];
    policyKey: string;
    scenarioId: string;
  }): string[] {
    const {
      scenarioValue,
      globalValue,
      defaultValue,
      policyKey,
      scenarioId,
    } = params;

    const scenarioCodes = this.tryResolveStringArray(
      scenarioValue,
      policyKey,
      'scenario',
      scenarioId,
    );

    const globalCodes = this.tryResolveStringArray(
      globalValue,
      policyKey,
      'global',
    );

    const base = new Set<string>(defaultValue);

    for (const code of globalCodes ?? []) {
      base.add(code);
    }
    for (const code of scenarioCodes ?? []) {
      base.add(code);
    }

    // Ensure CIRCUIT_OPEN is always blacklisted even if configuration is empty.
    base.add('CIRCUIT_OPEN');

    return Array.from(base);
  }

  private tryResolveStringArray(
    raw: unknown,
    policyKey: string,
    scope: 'global' | 'scenario',
    scenarioId?: string,
  ): string[] | undefined {
    if (raw === undefined || raw === null) {
      return undefined;
    }

    const arr = this.parseStringArray(raw);
    if (!arr) {
      this.logConfigError({
        policyKey,
        scope,
        scenarioId,
        reason: 'invalid_array',
        rawValue: raw,
      });
      return undefined;
    }

    const normalized = arr
      .map(v => String(v).trim())
      .filter(v => v.length > 0);

    if (normalized.length === 0) {
      this.logConfigError({
        policyKey,
        scope,
        scenarioId,
        reason: 'no_valid_values',
        rawValue: raw,
      });
      return undefined;
    }

    return Array.from(new Set(normalized));
  }

  private parseStringArray(raw: unknown): string[] | undefined {
    if (raw === undefined || raw === null) {
      return undefined;
    }

    if (Array.isArray(raw)) {
      return raw as string[];
    }

    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (!trimmed) {
        return [];
      }

      if (trimmed.startsWith('[')) {
        try {
          return JSON.parse(trimmed) as string[];
        } catch {
          // fall through to CSV parsing
        }
      }

      return trimmed.split(',').map(v => v.trim());
    }

    return undefined;
  }

  private extractScenarioIdFromTask(task: MasTaskExecution): string {
    const meta = task.meta ?? {};
    const raw =
      (meta.scenarioId as string | undefined) ??
      (meta.masScenarioId as string | undefined);

    const value =
      typeof raw === 'string' && raw.trim().length > 0
        ? raw.trim()
        : 'default';

    return value;
  }

  private extractTenantIdFromTask(
    task: MasTaskExecution,
  ): string | undefined {
    const snapshot = (
      task as unknown as {
        requestContextSnapshot?: { tenantId?: unknown };
      }
    ).requestContextSnapshot;

    const raw = snapshot?.tenantId;

    if (typeof raw === 'string') {
      const trimmed = raw.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }

    return undefined;
  }

  private getEffectiveDurableScopeConfig(
    config: DurableExecutionPolicyConfig | undefined,
    scenarioId: MasScenarioId,
    tenantId?: string,
  ): DurableExecutionPolicyScopeConfigInput | undefined {
    return this.getEffectiveDurableScopeDebug(
      config,
      scenarioId,
      tenantId,
    ).scopeConfig;
  }

  private getEffectiveDurableScopeDebug(
    config: DurableExecutionPolicyConfig | undefined,
    scenarioId: MasScenarioId,
    tenantId?: string,
  ): {
    scopeConfig?: DurableExecutionPolicyScopeConfigInput;
    scopeType: DurablePolicyScopeType;
    sloProfileIdInput?: string;
    hasNumericOverrides: boolean;
  } {
    if (!config) {
      return {
        scopeConfig: undefined,
        scopeType: 'baseline',
        sloProfileIdInput: undefined,
        hasNumericOverrides: false,
      };
    }

    if (tenantId && config.tenants && config.tenants[tenantId]) {
      const tenantConfig = config.tenants[tenantId];

      if (tenantConfig.scenarios && tenantConfig.scenarios[scenarioId]) {
        const scope = tenantConfig.scenarios[scenarioId];
        return {
          scopeConfig: scope,
          scopeType: 'tenant_scenario',
          sloProfileIdInput: scope.sloProfileId,
          hasNumericOverrides: this.hasDurableNumericOverrides(scope),
        };
      }

      if (tenantConfig.global) {
        const scope = tenantConfig.global;
        return {
          scopeConfig: scope,
          scopeType: 'tenant_global',
          sloProfileIdInput: scope.sloProfileId,
          hasNumericOverrides: this.hasDurableNumericOverrides(scope),
        };
      }
    }

    if (config.scenarios && config.scenarios[scenarioId]) {
      const scope = config.scenarios[scenarioId];
      return {
        scopeConfig: scope,
        scopeType: 'scenario',
        sloProfileIdInput: scope.sloProfileId,
        hasNumericOverrides: this.hasDurableNumericOverrides(scope),
      };
    }

    if (config.global) {
      const scope = config.global;
      return {
        scopeConfig: scope,
        scopeType: 'global',
        sloProfileIdInput: scope.sloProfileId,
        hasNumericOverrides: this.hasDurableNumericOverrides(scope),
      };
    }

    return {
      scopeConfig: undefined,
      scopeType: 'baseline',
      sloProfileIdInput: undefined,
      hasNumericOverrides: false,
    };
  }

  private hasDurableNumericOverrides(
    scope?: DurableExecutionPolicyScopeConfigInput,
  ): boolean {
    if (!scope || typeof scope !== 'object') {
      return false;
    }

    const candidate = scope;

    return (
      candidate.defaultTaskTimeoutMs !== undefined ||
      candidate.defaultStepTimeoutMs !== undefined ||
      candidate.maxStepRetryAttempts !== undefined ||
      candidate.cbBlockedCooldownMs !== undefined ||
      candidate.cbBlockedMaxDurationMs !== undefined ||
      candidate.cbMaxRecoveryAttempts !== undefined
    );
  }

  private attachDurablePolicyDebugToTask(
    task: MasTaskExecution,
    payload: DurablePolicyDebugPayload,
  ): void {
    try {
      if (!task || typeof task !== 'object') {
        return;
      }

      const meta = task.meta ?? {};

      const mutableTask = task as unknown as { meta?: unknown };
      mutableTask.meta = {
        ...meta,
        durable_policy_debug: {
          ...(meta.durable_policy_debug as MasMetadataBag | undefined),
          ...payload,
        },
      };
    } catch {
      // Diagnostics must never break policy resolution.
    }
  }

  private publishDurablePolicyDebugSnapshot(params: {
    task: MasTaskExecution;
    tenantId?: string;
    scenarioId: string;
    durableScope: DurablePolicyScopeType;
    sloProfileIdInput?: string;
    sloProfileIdResolved: string;
    policySource: DurablePolicyDebugPayload['policy_source'];
    policy: DurableExecutionPolicy;
  }): void {
    const {
      task,
      tenantId,
      scenarioId,
      durableScope,
      sloProfileIdInput,
      sloProfileIdResolved,
      policySource,
      policy,
    } = params;

    const payload: DurablePolicyDebugPayload = {
      tenant_id: tenantId,
      scenario_id: scenarioId,
      durable_scope: durableScope,
      slo_profile_id_input: sloProfileIdInput,
      slo_profile_id_resolved: sloProfileIdResolved,
      policy_source: policySource,
      durable_policy_snapshot: {
        effective_task_timeout_ms: policy.defaultTaskTimeoutMs,
        effective_step_timeout_ms: policy.defaultStepTimeoutMs,
        effective_max_step_retries: policy.maxStepRetryAttempts,
        effective_cb_blocked_cooldown_ms: policy.cbBlockedCooldownMs,
        effective_cb_blocked_max_duration_ms: policy.cbBlockedMaxDurationMs,
        effective_cb_max_recovery_attempts: policy.cbMaxRecoveryAttempts,
      },
    };

    this.attachDurablePolicyDebugToTask(task, payload);
    this.recordDurableSloMetrics(payload);
  }

  private recordDurableSloMetrics(
    payload: DurablePolicyDebugPayload,
  ): void {
    try {
      const scope = payload.durable_scope;

      recordDurableSloProfileApplied({
        durableScope: scope,
        sloProfileId: payload.slo_profile_id_resolved,
      });

      observeDurableEffectivePolicy({
        durableScope: scope,
        policySnapshot: payload.durable_policy_snapshot,
      });
    } catch {
      // Metrics must never break policy resolution.
    }
  }

  private resolveDurableNumberWithSlo(params: {
    scenarioValue: unknown;
    globalValue: unknown;
    profileValue: number | undefined;
    defaultValue: number;
    min: number;
    max: number;
    policyKey: string;
    scenarioId: string;
  }): number {
    const { profileValue, defaultValue, ...rest } = params;

    const effectiveDefault =
      profileValue !== undefined ? profileValue : defaultValue;

    return this.resolveNumberWithGuard({
      ...rest,
      defaultValue: effectiveDefault,
    });
  }

  private applyDurablePolicyInvariants(params: {
    policy: DurableExecutionPolicy;
    scenarioId: string;
    durableScope: DurablePolicyScopeType;
  }): DurableExecutionPolicy {
    const { policy, scenarioId, durableScope } = params;

    let result: DurableExecutionPolicy = { ...policy };

    // Invariant: defaultTaskTimeoutMs >= defaultStepTimeoutMs
    if (result.defaultTaskTimeoutMs < result.defaultStepTimeoutMs) {
      const adjustedTaskTimeoutMs = result.defaultStepTimeoutMs;

      this.logConfigError({
        policyKey: 'durable.defaultTaskTimeoutMs',
        scope: 'scenario',
        scenarioId,
        reason: 'invariant_violation_task_vs_step_timeout',
        rawValue: {
          defaultTaskTimeoutMs: result.defaultTaskTimeoutMs,
          defaultStepTimeoutMs: result.defaultStepTimeoutMs,
        },
        meta: {
          durableScope,
          adjustedTaskTimeoutMs,
        },
      });

      result = {
        ...result,
        defaultTaskTimeoutMs: adjustedTaskTimeoutMs,
      };
    }

    // Invariant: cbMaxRecoveryAttempts <= maxStepRetryAttempts
    if (result.cbMaxRecoveryAttempts > result.maxStepRetryAttempts) {
      const originalCb = result.cbMaxRecoveryAttempts;
      const originalMaxStep = result.maxStepRetryAttempts;

      const cbGuards = DURABLE_SLO_GUARDS.cbMaxRecoveryAttempts;
      const stepGuards = DURABLE_SLO_GUARDS.maxStepRetryAttempts;

      let adjustedMaxStep = result.maxStepRetryAttempts;
      let adjustedCb = result.maxStepRetryAttempts;

      // Enforce cb guard-rails.
      if (adjustedCb < cbGuards.min) {
        adjustedCb = cbGuards.min;
      } else if (adjustedCb > cbGuards.max) {
        adjustedCb = cbGuards.max;
      }

      // Ensure maxStepRetryAttempts is not lower than cb and within its own guard-rails.
      if (adjustedMaxStep < adjustedCb) {
        adjustedMaxStep = adjustedCb;
      }

      // At this point adjustedMaxStep is already >= adjustedCb and adjustedCb is
      // clamped to at least cbGuards.min (1), while stepGuards.min is 0.
      // The lower-bound branch is therefore unreachable; only the upper clamp
      // can still fire after the earlier normalization.
      if (adjustedMaxStep > stepGuards.max) {
        adjustedMaxStep = stepGuards.max;
      }

      // Final safeguard: keep cb <= maxStep after all clamping.
      if (adjustedCb > adjustedMaxStep) {
        adjustedCb = adjustedMaxStep;
      }

      this.logConfigError({
        policyKey: 'durable.cbMaxRecoveryAttempts',
        scope: 'scenario',
        scenarioId,
        reason: 'invariant_violation_cb_vs_step_retries',
        rawValue: {
          cbMaxRecoveryAttempts: originalCb,
          maxStepRetryAttempts: originalMaxStep,
        },
        meta: {
          durableScope,
          adjustedCbMaxRecoveryAttempts: adjustedCb,
          adjustedMaxStepRetryAttempts: adjustedMaxStep,
        },
      });

      result = {
        ...result,
        cbMaxRecoveryAttempts: adjustedCb,
        maxStepRetryAttempts: adjustedMaxStep,
      };
    }

    return result;
  }

  private mapConfigScopeToDurableScope(
    scope: 'global' | 'scenario' | 'profile',
    _scenarioId?: string,
  ): DurableScopeLabel {
    if (scope === 'global') return 'global';
    if (scope === 'scenario') return 'scenario';
    return 'baseline';
  }

  private mapConfigErrorReasonToFallbackReason(
    reason: string,
  ): DurableSloFallbackReason | undefined {
    switch (reason) {
      case 'invalid_json':
        return 'invalid_json';
      case 'invalid_type':
      case 'invalid_tenants_type':
      case 'invalid_slo_profiles_type':
      case 'invalid_array':
      case 'no_valid_values':
        return 'invalid_type';
      case 'invalid_type_after_parse':
        return 'invalid_type_after_parse';
      case 'not_a_number':
        return 'not_a_number';
      case 'out_of_range':
        return 'out_of_range';
      case 'unknown_slo_profile_id':
        return 'unknown_slo_profile_id';
      case 'no_config':
        return 'no_config';
      case 'failed_to_parse_tenants':
        return 'failed_to_parse_tenants';
      case 'invalid_slo_profile_type':
        return 'invalid_slo_profile_type';
      case 'invariant_violation_task_vs_step_timeout':
      case 'invariant_violation_cb_vs_step_retries':
        return 'invalid_type';
      default:
        return undefined;
    }
  }

  private logConfigError(params: {
    policyKey: string;
    scope: 'global' | 'scenario' | 'profile';
    rawValue: unknown;
    reason: string;
    scenarioId?: string;
    error?: unknown;
    meta?: MasMetadataBag;
  }): void {
    try {
      this.logger?.error(
        '[MasRuntimePolicyService] Invalid MAS runtime policy value',
        {
          component: 'mas_runtime_policy',
          policyKey: params.policyKey,
          scope: params.scope,
          scenarioId: params.scenarioId,
          reason: params.reason,
          rawValue: params.rawValue,
          ...(params.error ? { error: this.serializeError(params.error) } : {}),
          ...(params.meta ?? {}),
        },
      );

      if (params.policyKey.startsWith('durable')) {
        const fallbackReason = this.mapConfigErrorReasonToFallbackReason(
          params.reason,
        );
        if (fallbackReason) {
          const durableScope = this.mapConfigScopeToDurableScope(
            params.scope,
            params.scenarioId,
          );
          recordDurableSloPolicyFallback({
            reason: fallbackReason,
            policyKey: params.policyKey,
            durableScope,
          });
        }
      }
    } catch {
      // Logging and metrics must never break policy resolution.
    }
  }

  private serializeError(error: unknown): MasMetadataBag {
    if (error instanceof Error) {
      return {
        name: error.name,
        message: error.message,
      };
    }
    return { value: String(error) };
  }

  private getRuntimeConfig(): RuntimePolicyConfigRecord {
    const config = this.configLoader?.get();
    return config && typeof config === 'object' ? config : {};
  }
}

export function createMasRuntimePolicyService(
  logger?: IStructuredLogger,
  configLoader?: RuntimePolicyConfigLoader,
): IMasRuntimePolicyService {
  return new MasRuntimePolicyService(logger, configLoader);
}
