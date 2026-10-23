/**
 * Стратегия A/B-тестирования для feature-флага.
 * Layer: Domain
 *
 * Делит пользователей на две группы: control и treatment
 * на основе детерминированного хеша (userId/tenantId/sessionId + flagKey).
 *
 * Поведение:
 * - При отсутствии конфигурации abTest стратегия не применяется.
 * - При value === false флаг всегда отключён (эксперимент не активен).
 * - При отсутствии стабильного идентификатора в контексте возвращается базовое value.
 * - При некорректных весах (<= 0 или сумма == 0) стратегия не применяется.
 *
 * Для булевого флага:
 * - Группа control получает значение false.
 * - Группа treatment получает значение true (если value === true).
 */
import type {
  FeatureFlagAbTestConfig,
  FeatureFlagMetadata,
} from '../../../core/config/feature-flags';
import type { FeatureContext } from '../FeatureContext';
import type { IFeatureStrategy } from './IFeatureStrategy';

function getStableIdentifier(context?: FeatureContext): string | undefined {
  if (!context) {
    return undefined;
  }

  return context.userId ?? context.tenantId ?? context.sessionId;
}

function computeDeterministicBucket(identifier: string, flagKey: string): number {
  const input = `${flagKey}:${identifier}`;
  let hash = 0;

  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }

  return hash;
}

function isValidConfig(config: FeatureFlagAbTestConfig | undefined): config is FeatureFlagAbTestConfig {
  if (!config) {
    return false;
  }

  const { controlWeight, treatmentWeight } = config;

  if (!Number.isFinite(controlWeight) || !Number.isFinite(treatmentWeight)) {
    return false;
  }

  if (controlWeight <= 0 && treatmentWeight <= 0) {
    return false;
  }

  return true;
}

export class AbTestStrategy implements IFeatureStrategy {
  supports(metadata: FeatureFlagMetadata): boolean {
    return isValidConfig(metadata.abTest);
  }

  isEnabled(params: {
    flagKey: string;
    value: boolean;
    metadata: FeatureFlagMetadata;
    context?: FeatureContext;
  }): boolean {
    const { flagKey, value, metadata, context } = params;

    if (!value) {
      // Глобально выключенный флаг не должен случайно включаться A/B-стратегией.
      return false;
    }

    if (!this.supports(metadata)) {
      return value;
    }

    const identifier = getStableIdentifier(context);
    if (!identifier) {
      // Нет стабильного идентификатора — не вмешиваемся.
      return value;
    }

    const config = metadata.abTest as FeatureFlagAbTestConfig;
    const totalWeight = config.controlWeight + config.treatmentWeight;

    if (totalWeight <= 0) {
      return value;
    }

    const bucket = computeDeterministicBucket(identifier, flagKey) % totalWeight;

    // В простейшей схеме control = [0, controlWeight), treatment = [controlWeight, totalWeight).
    const isInTreatmentGroup = bucket >= config.controlWeight;

    // Для булевого флага: treatment получает true, control — false.
    return isInTreatmentGroup;
  }
}