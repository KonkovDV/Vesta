/**
 * Стратегия временного окна для feature-флага.
 * Layer: Domain
 *
 * Активирует флаг только в интервале между startTime и endTime.
 *
 * Поведение:
 * - При отсутствии timeWindow или обоих полей (startTime/endTime) стратегия не применяется.
 * - При value === false флаг всегда отключён.
 * - При некорректных датах (невозможный формат) стратегия не применяется и возвращается value.
 */
import type {
  FeatureFlagMetadata,
  FeatureFlagTimeWindowConfig,
} from '../../../core/config/feature-flags';
import type { FeatureContext } from '../FeatureContext';
import type { IFeatureStrategy } from './IFeatureStrategy';

function parseTime(value?: string): Date | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date;
}

function isNowWithinWindow(now: Date, window?: FeatureFlagTimeWindowConfig): boolean | null {
  if (!window) {
    return null;
  }

  const start = parseTime(window.startTime);
  const end = parseTime(window.endTime);

  if (!start && !end) {
    return null;
  }

  if (start && now < start) {
    return false;
  }

  if (end && now > end) {
    return false;
  }

  return true;
}

export class TimeWindowStrategy implements IFeatureStrategy {
  supports(metadata: FeatureFlagMetadata): boolean {
    const window = metadata.timeWindow;
    if (!window) {
      return false;
    }

    // Стратегия имеет смысл только если задано хотя бы одно граничное значение.
    return Boolean(window.startTime || window.endTime);
  }

  isEnabled(params: {
    flagKey: string;
    value: boolean;
    metadata: FeatureFlagMetadata;
    context?: FeatureContext;
  }): boolean {
    const { value, metadata } = params;

    if (!value) {
      return false;
    }

    if (!this.supports(metadata)) {
      return value;
    }

    const now = new Date();
    const result = isNowWithinWindow(now, metadata.timeWindow);

    // null означает, что окно по факту некорректно сконфигурировано (оба конца пустые
    // или нераспознаваемые даты) — в этом случае не вмешиваемся.
    if (result === null) {
      return value;
    }

    if (!result) {
      return false;
    }

    return value;
  }
}