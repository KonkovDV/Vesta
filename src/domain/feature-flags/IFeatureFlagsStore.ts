/**
 * IFeatureFlagsStore - персистентное хранилище конфигурации feature flags
 * Layer: Domain
 *
 * Предоставляет минимальный контракт для чтения/записи конфигурации
 * feature flags без привязки к конкретному типу хранилища.
 * Реализации живут в Infrastructure-слое (PostgreSQL, in-memory и т.п.).
 */

import type { FeatureFlags } from '../../core/config/feature-flags';

/**
 * Минимальный контракт персистентного хранилища фич-флагов.
 *
 * Важно:
 * - Интерфейс не навязывает формат хранения (JSON, столбцы БД и т.п.).
 * - Application-слой работает только с этим интерфейсом,
 *   а детали SQL/таблиц инкапсулированы в инфраструктурных адаптерах.
 */
export interface IFeatureFlagsStore {
  /**
   * Загрузить фич-флаги из персистентного хранилища.
   *
   * @returns Partial<FeatureFlags> или null, если записи ещё нет.
   */
  loadFlags(): Promise<Partial<FeatureFlags> | null>;

  /**
   * Сохранить полный снимок FeatureFlags атомарно.
   *
   * Application-слой всегда передаёт полный набор флагов,
   * чтобы избежать расхождений между storage и in-memory состоянием.
   */
  saveFlags(flags: FeatureFlags): Promise<void>;
}