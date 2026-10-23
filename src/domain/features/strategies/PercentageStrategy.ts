/**
 * Стратегия процентного включения feature-флага.
 * Layer: Domain
 *
 * Использует детерминированное распределение пользователей по "бакетам" 0–99
 * на основе стабильного идентификатора (userId/tenantId/sessionId) и ключа флага.
 *
 * Поведение:
 * - При отсутствии rolloutPercentage или некорректном значении стратегия не применяется.
 * - При отсутствии стабильного идентификатора в контексте возвращается базовое value.
 * - При value === false флаг всегда отключён независимо от процента.
 */
import type { FeatureFlagMetadata } from '../../../core/config/feature-flags';
import type { FeatureContext } from '../FeatureContext';
import type { IFeatureStrategy } from './IFeatureStrategy';

const MIN_PERCENT = 0;
const MAX_PERCENT = 100;

function computeDeterministicBucket(identifier: string, flagKey: string): number {
  const input = `${flagKey}:${identifier}`;
  let hash = 0;

  for (let i = 0; i < input.length; i += 1) {
    hash = (hash * 31 + input.charCodeAt(i)) >>> 0;
  }

  return hash % 100;
}

function getStableIdentifier(context?: FeatureContext): string | undefined {
  if (!context) {
    return undefined;
  }

  return context.userId ?? context.tenantId ?? context.sessionId;
}

export class PercentageStrategy implements IFeatureStrategy {
  supports(metadata: FeatureFlagMetadata): boolean {
    const percentage = metadata.rolloutPercentage;

    if (typeof percentage !== 'number' || Number.isNaN(percentage)) {
      return false;
    }

    // 0% и 100% можно выразить через базовое булево значение, поэтому
    // стратегия нужна только для "частичных" rollout'ов.
    return percentage > MIN_PERCENT && percentage < MAX_PERCENT;
  }

  isEnabled(params: {
    flagKey: string;
    value: boolean;
    metadata: FeatureFlagMetadata;
    context?: FeatureContext;
  }): boolean {
    const { flagKey, value, metadata, context } = params;

    // Если базовое значение false — стратегия его только ужесточает.
    if (!value) {
      return false;
    }

    if (!this.supports(metadata)) {
      return value;
    }

    const percentage = metadata.rolloutPercentage;

    if (percentage === undefined || percentage <= MIN_PERCENT) {
      return false;
    }
    if (percentage >= MAX_PERCENT) {
      return true;
    }

    const identifier = getStableIdentifier(context);
    if (!identifier) {
      // Нет стабильного идентификатора — возвращаем глобальное значение флага.
      return value;
    }

    const bucket = computeDeterministicBucket(identifier, flagKey);

    return bucket < percentage;
  }
}