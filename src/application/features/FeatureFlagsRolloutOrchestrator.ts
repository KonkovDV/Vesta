import type { FeatureFlags } from '@domain/features/FeatureFlagsConfig';
import type { IFeatureManager } from '@domain/features/IFeatureManager';
import type IMetricsPort from '@domain/metrics/IMetricsPort';
import type { MetricContext } from '@domain/metrics/IBusinessMetrics';
import { getOverallHealth } from '../../monitoring';
import type {
  FeatureFlagsRolloutProfile,
  FeatureFlagsRolloutResult,
  FeatureFlagRolloutStep,
} from './FeatureFlagRolloutTypes';

interface FeatureFlagsRolloutLogger {
  info?(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  log?(message: string, meta?: Record<string, unknown>): void;
}

/**
 * Оркестратор rollout/rollback/profile для feature-флагов.
 * Layer: Application
 *
 * Инкапсулирует:
 * - поэтапный rollout одного флага;
 * - health‑проверки между шагами;
 * - rollback при ошибках;
 * - запуск стандартных rollout‑профилей.
 *
 * Фактическое изменение флагов может делегировать либо в IFeatureManager,
 * либо в внешнюю функцию setFlagFn (например, FeatureFlagsService.setFlag),
 * чтобы сохранить существующие метрики/логи.
 */
export class FeatureFlagsRolloutOrchestrator {
  /** Internal state for rollout percentages - isolates state from process.env */
  private readonly rolloutState = new Map<string, string>();

  constructor(
    private readonly featureManager: IFeatureManager,
    private readonly logger?: FeatureFlagsRolloutLogger,
    private readonly metrics?: IMetricsPort,
    private readonly setFlagFn?: (
      flag: keyof FeatureFlags,
      value: boolean,
    ) => Promise<void>,
    private readonly rollbackLogger?: (
      flag: keyof FeatureFlags,
      reason: string,
    ) => void,
  ) {}

  async rolloutFlag(
    flag: keyof FeatureFlags,
    percentages: number[],
  ): Promise<void> {
    const metadataMap = await this.featureManager.getAllMetadata();
    const metadata = metadataMap[flag];
    if (!metadata) {
      throw new Error(`No metadata for flag ${String(flag)}`);
    }

    for (const percentage of percentages) {
      const stateKey = `FF_${String(flag).toUpperCase()}_ROLLOUT`;

      // Use internal state instead of mutating process.env
      this.rolloutState.set(stateKey, String(percentage));

      this.logInfo(`Rolling out ${String(flag)} to ${percentage}%`, {
        flag: String(flag),
        percentage,
      });

      await this.waitForStabilization(flag, percentage);

      const metrics = await this.checkRolloutMetrics(flag);
      if (!metrics.isHealthy) {
        const errorMessage = `Rollout failed for ${String(
          flag,
        )} at ${percentage}%`;
        this.logError(errorMessage, new Error(metrics.errors.join(', ')), {
          flag: String(flag),
          percentage,
          errors: metrics.errors,
        });

        await this.setFlagInternal(flag, false);
        throw new Error(`Rollout failed: ${metrics.errors.join(', ')}`);
      }
    }

    await this.setFlagInternal(flag, true);

    // Clean up internal state instead of mutating process.env
    const stateKey = `FF_${String(flag).toUpperCase()}_ROLLOUT`;
    this.rolloutState.delete(stateKey);
  }

  /**
   * Get the current rollout percentage for a flag from internal state.
   * Returns null if no rollout is in progress.
   */
  getRolloutPercentage(flag: keyof FeatureFlags): number | null {
    const stateKey = `FF_${String(flag).toUpperCase()}_ROLLOUT`;
    const value = this.rolloutState.get(stateKey);
    return value ? parseInt(value, 10) : null;
  }

  async rollbackFlag(
    flag: keyof FeatureFlags,
    reason: string,
  ): Promise<void> {
    this.logWarn(`Rolling back ${String(flag)}: ${reason}`, { flag: String(flag), reason });

    await this.setFlagInternal(flag, false);

    if (this.rollbackLogger) {
      this.rollbackLogger(flag, reason);
    }
  }

  async rolloutProfile(
    profile: FeatureFlagsRolloutProfile,
  ): Promise<FeatureFlagsRolloutResult> {
    const profileFlags = this.getRolloutProfileFlags(profile);
    const metadataMap = await this.featureManager.getAllMetadata();

    const steps: FeatureFlagRolloutStep[] = [];
    const succeeded: Array<{ flag: keyof FeatureFlags }> = [];
    const failed: Array<{ flag: keyof FeatureFlags; error: string }> = [];

    this.logInfo(`Starting feature flags rollout profile '${profile}'`, {
      profile,
      flags: profileFlags.map(flagKey => String(flagKey)),
    });

    for (const flag of profileFlags) {
      const metadata = metadataMap[flag];
      const percentages =
        metadata &&
        Array.isArray(metadata.rolloutSteps) &&
        metadata.rolloutSteps.length > 0
          ? metadata.rolloutSteps
          : [100];

      steps.push({ flag, percentages });

      try {
        await this.rolloutFlag(flag, percentages);
        succeeded.push({ flag });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failed.push({ flag, error: message });

        this.logError(
          `Feature flags rollout profile '${profile}' failed at flag ${String(
            flag,
          )}`,
          error,
          {
            profile,
            flag: String(flag),
            percentages,
          },
        );

        break;
      }
    }

    if (failed.length === 0) {
      this.logInfo(`Completed feature flags rollout profile '${profile}'`, {
        profile,
        flags: succeeded.map(item => String(item.flag)),
      });
    }

    return {
      profile,
      steps,
      succeeded,
      failed,
    };
  }

  private async setFlagInternal(
    flag: keyof FeatureFlags,
    value: boolean,
  ): Promise<void> {
    if (this.setFlagFn) {
      await this.setFlagFn(flag, value);
      return;
    }

    await this.featureManager.setFlag(flag, value);
  }

  private async waitForStabilization(
    flag: keyof FeatureFlags,
    percentage: number,
  ): Promise<void> {
    const waitTime = 30000; // 30 секунд
    this.logInfo(`Waiting ${waitTime}ms for stabilization at ${percentage}%`, {
      flag: String(flag),
      percentage,
    });
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  private async checkRolloutMetrics(
    flag: keyof FeatureFlags,
  ): Promise<{ isHealthy: boolean; errors: string[] }> {
    const errors: string[] = [];
    const metricContext = this.buildMetricContext('rollout_check', {
      flag: String(flag),
    });
    const timer = this.metrics?.startTimer(
      'feature_flags.rollout.check_metrics',
      metricContext,
    );

    try {
      const health = await getOverallHealth();
      const components = health.components || {};

      const requiredComponents: string[] = [];

      switch (flag) {
        case 'useRealEventStore':
        case 'enableEventSourcing':
        case 'enableCQRS':
          requiredComponents.push('event_store');
          break;
        case 'useRealEventBus':
        case 'useRealRateLimit':
          requiredComponents.push('event_bus');
          break;
        case 'useRealOutbox':
          requiredComponents.push('outbox', 'event_store', 'event_bus');
          break;
        case 'useRealDatabase':
        case 'useRealAuthService':
          requiredComponents.push('database');
          break;
        case 'enableCaching':
          requiredComponents.push('cache');
          break;
        default:
          break;
      }

      for (const component of requiredComponents) {
        const st = components[component];
        if (!st?.ok) {
          errors.push(
            `Component '${component}' is not healthy (${st?.error ?? 'unknown'})`,
          );
        }
      }

      const isHealthy = errors.length === 0;

      if (isHealthy) {
        this.metrics?.recordSuccess(
          'feature_flags.rollout.check_metrics',
          metricContext,
        );
      } else {
        this.metrics?.recordError(
          'feature_flags.rollout.check_metrics',
          new Error(errors.join('; ')),
          metricContext,
        );
      }

      return { isHealthy, errors };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logError('Failed to evaluate rollout metrics', error, {
        flag: String(flag),
      });
      this.metrics?.recordError(
        'feature_flags.rollout.check_metrics',
        error,
        metricContext,
      );
      return {
        isHealthy: false,
        errors: [`Failed to evaluate rollout metrics: ${message}`],
      };
    } finally {
      timer?.stop();
    }
  }

  private getRolloutProfileFlags(
    profile: FeatureFlagsRolloutProfile,
  ): Array<keyof FeatureFlags> {
    const infraProfile: Array<keyof FeatureFlags> = [
      'useRealEventStore',
      'useRealEventBus',
      'useRealOutbox',
      'useRealDatabase',
    ];

    const applicationProfile: Array<keyof FeatureFlags> = [
      'useRealAuthService',
      'useRealRateLimit',
      'enableEventSourcing',
      'enableCQRS',
    ];

    switch (profile) {
      case 'infra':
        return infraProfile;
      case 'application':
        return applicationProfile;
      case 'full':
        return [...infraProfile, ...applicationProfile];
      default:
        return [];
    }
  }

  private logInfo(message: string, meta?: Record<string, unknown>): void {
    if (!this.logger) {
      return;
    }
    if (typeof this.logger.info === 'function') {
      this.logger.info(message, meta);
    } else {
      this.logger.log?.(message, meta);
    }
  }

  private logWarn(message: string, meta?: Record<string, unknown>): void {
    if (!this.logger) {
      return;
    }
    this.logger.warn(message, meta);
  }

  private logError(
    message: string,
    error: unknown,
    meta?: Record<string, unknown>,
  ): void {
    if (!this.logger) {
      return;
    }
    const safe = this.safeError(error);
    this.logger.error(message, { ...meta, error: safe });
  }

  private safeError(error: unknown): { message: string; stack?: string } {
    if (error instanceof Error) {
      return { message: error.message, stack: error.stack };
    }
    return { message: String(error) };
  }

  private buildMetricContext(
    operation: string,
    extraTags: Record<string, string | number | boolean> = {},
  ): MetricContext {
    return {
      entityType: 'feature_flag',
      tags: {
        feature_flag_operation: operation,
        ...extraTags,
      },
      timestamp: new Date(),
    };
  }
}