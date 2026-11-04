/**
 * PostgresFeatureFlagsStore - персистентное хранилище фич-флагов в PostgreSQL
 * Layer: Infrastructure
 *
 * Реализация IFeatureFlagsStore поверх IDatabaseConnection.
 * Хранит один JSON-blob с конфигурацией флагов в таблице app_feature_flags.
 */

import type { IFeatureFlagsStore } from '../../domain/feature-flags/IFeatureFlagsStore';
import type { FeatureFlags } from '../../core/config/feature-flags';
import type { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import { safeJsonParse } from '../../core/utils/json';
import { requirePublicTables, runtimeDdlEnabled } from '../database/runtime-ddl';

const FEATURE_FLAGS_DB_TABLE = 'app_feature_flags';
const FEATURE_FLAGS_DB_ROW_ID = 'default';

export class PostgresFeatureFlagsStore implements IFeatureFlagsStore {
  private dbSchemaInitialized = false;

  constructor(private readonly db: IDatabaseConnection) {}

  /**
   * Загрузить фич-флаги из PostgreSQL.
   *
   * Возвращает partial-конфигурацию или null, если записи нет.
   */
  async loadFlags(): Promise<Partial<FeatureFlags> | null> {
    await this.ensureSchema();

    const row = await this.db.queryOne<{ flags: string }>(
      `SELECT flags FROM ${FEATURE_FLAGS_DB_TABLE} WHERE id = $1`,
      [FEATURE_FLAGS_DB_ROW_ID]
    );

    if (!row || !row.flags) {
      return null;
    }

    const parsed = safeJsonParse<Partial<FeatureFlags>>(row.flags);
    if (!parsed) {
      return null;
    }

    return parsed;
  }

  /**
   * Сохранить полный снимок FeatureFlags в PostgreSQL.
   */
  async saveFlags(flags: FeatureFlags): Promise<void> {
    await this.ensureSchema();

    await this.db.execute(
      `INSERT INTO ${FEATURE_FLAGS_DB_TABLE} (id, flags, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (id) DO UPDATE SET flags = EXCLUDED.flags, updated_at = NOW()`,
      [FEATURE_FLAGS_DB_ROW_ID, JSON.stringify(flags)]
    );
  }

  /**
   * Таблица `app_feature_flags` создаётся миграцией `001_consolidated.sql`.
   * Без DB_RUNTIME_DDL=true store только проверяет, что таблица есть,
   * и иначе бросает «Apply migrations». С флагом шлёт прежний CREATE TABLE IF NOT EXISTS.
   */
  private async ensureSchema(): Promise<void> {
    if (this.dbSchemaInitialized) {
      return;
    }

    if (!runtimeDdlEnabled()) {
      await requirePublicTables(this.db, [FEATURE_FLAGS_DB_TABLE]);
      this.dbSchemaInitialized = true;
      return;
    }

    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS ${FEATURE_FLAGS_DB_TABLE} (
         id TEXT PRIMARY KEY,
         flags TEXT NOT NULL,
         updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
       )`
    );
    this.dbSchemaInitialized = true;
  }
}