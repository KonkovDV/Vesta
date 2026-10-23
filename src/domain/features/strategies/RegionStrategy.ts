/**
 * Стратегия регионального включения feature-флага.
 * Layer: Domain
 *
 * Включает флаг только для регионов из allowlist в метаданных.
 *
 * Поведение:
 * - Если regions не заданы или пусты — стратегия не применяется.
 * - Если базовое значение value === false — флаг всегда отключён.
 * - Если в контексте нет region — возвращается базовое value.
 * - Если region присутствует и он не в списке — флаг отключён.
 */
import type { FeatureFlagMetadata } from '../../../core/config/feature-flags';
import type { FeatureContext } from '../FeatureContext';
import type { IFeatureStrategy } from './IFeatureStrategy';

function normalizeRegions(regions?: string[]): string[] {
  if (!Array.isArray(regions)) {
    return [];
  }

  return regions
    .map(region => region.trim())
    .filter(region => region.length > 0);
}

export class RegionStrategy implements IFeatureStrategy {
  supports(metadata: FeatureFlagMetadata): boolean {
    const regions = normalizeRegions(metadata.regions);

    return regions.length > 0;
  }

  isEnabled(params: {
    flagKey: string;
    value: boolean;
    metadata: FeatureFlagMetadata;
    context?: FeatureContext;
  }): boolean {
    const { value, metadata, context } = params;

    if (!value) {
      return false;
    }

    if (!this.supports(metadata)) {
      return value;
    }

    const regions = normalizeRegions(metadata.regions);
    const region = context?.region;

    if (!region) {
      // Нет информации о регионе — не изменяем базовое значение.
      return value;
    }

    return regions.includes(region);
  }
}