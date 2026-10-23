/**
 * Утилиты для работы с метаданными feature-флагов.
 * Layer: Domain
 *
 * Чистые функции без побочных эффектов:
 * - проверка консистентности словаря метаданных;
 * - детекция циклов зависимостей между флагами.
 */
import type {
  FeatureFlags,
  FeatureFlagMetadata,
} from '../../core/config/feature-flags';

export interface MetadataConsistencyResult {
  missingInMetadata: string[];
  extraInMetadata: string[];
}

export type FeatureFlagMetadataMap = Record<keyof FeatureFlags, FeatureFlagMetadata>;

/**
 * Проверяет согласованность набора метаданных с текущим набором флагов.
 *
 * Возвращает списки:
 * - missingInMetadata — флаги, для которых нет записей в metadata;
 * - extraInMetadata — ключи в metadata, которых нет в FeatureFlags.
 */
export function validateMetadataConsistency(
  flags: FeatureFlags,
  metadata: FeatureFlagMetadataMap,
): MetadataConsistencyResult {
  const flagKeys = Object.keys(flags);
  const metadataKeys = Object.keys(metadata);

  const missingInMetadata = flagKeys.filter(key => !(key in metadata));
  const extraInMetadata = metadataKeys.filter(key => !(key in flags));

  return { missingInMetadata, extraInMetadata };
}

/**
 * Поиск цикла в зависимостях feature-флагов.
 *
 * ВАЖНО:
 * - функция предназначена для диагностических сценариев и unit-тестов;
 * - не должна бросать исключения и не вносит побочных эффектов;
 * - при обнаружении цикла возвращает путь вида [A, B, C, A].
 */
export function findDependencyCycle(
  startFlag: keyof FeatureFlags,
  metadata: FeatureFlagMetadataMap,
): Array<keyof FeatureFlags> | null {
  const stack: (keyof FeatureFlags)[] = [];
  const visited = new Set<keyof FeatureFlags>();

  const dfs = (flag: keyof FeatureFlags): Array<keyof FeatureFlags> | null => {
    if (stack.includes(flag)) {
      const cycleStartIndex = stack.indexOf(flag);
      return stack.slice(cycleStartIndex).concat(flag);
    }

    if (visited.has(flag)) {
      return null;
    }

    visited.add(flag);
    stack.push(flag);

    const meta = metadata[flag];
    if (meta && Array.isArray(meta.requires)) {
      for (const dep of meta.requires) {
        if (typeof dep !== 'string') {
          // Неверная запись в requires — пропускаем.
           
          continue;
        }

        const depKey = dep as keyof FeatureFlags;
        const cycle = dfs(depKey);
        if (cycle) {
          return cycle;
        }
      }
    }

    stack.pop();
    return null;
  };

  return dfs(startFlag);
}