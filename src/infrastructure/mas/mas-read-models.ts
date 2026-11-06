import type { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import { requireQualifiedTables, runtimeDdlEnabled } from '../database/runtime-ddl';

/**
 * Tables mas_session_read_model and mas_task_stats_read_model live in the
 * baseline migration. Startup checks them. DB_RUNTIME_DDL=true restores CREATE.
 */
export class MasReadModelsRepository {
  private readonly schema: string;
  private readonly sessionTable: string;
  private readonly taskStatsTable: string;

  constructor(private readonly db: IDatabaseConnection, schema = 'mas_runtime') {
    this.schema = schema;
    this.sessionTable = `${this.schema}.mas_session_read_model`;
    this.taskStatsTable = `${this.schema}.mas_task_stats_read_model`;
  }

  async initialize(): Promise<void> {
    if (!runtimeDdlEnabled()) {
      await requireQualifiedTables(
        (sql, params) => this.db.query<{ schema_name: string; table_name: string }>(sql, params),
        [this.sessionTable, this.taskStatsTable],
      );
      return;
    }

    await this.db.execute(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${this.sessionTable} (
        mas_session_id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        scenario_id TEXT,
        status VARCHAR(32) NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ,
        last_error_category TEXT,
        tasks_total INT DEFAULT 0,
        tasks_failed INT DEFAULT 0
      );
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_mas_session_read_model_tenant_status_started
        ON ${this.sessionTable} (tenant_id, status, started_at DESC);
    `);

    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${this.taskStatsTable} (
        tenant_id TEXT NOT NULL,
        scenario_id TEXT NOT NULL,
        window_start TIMESTAMPTZ NOT NULL,
        window_end TIMESTAMPTZ NOT NULL,
        tasks_started INT NOT NULL,
        tasks_completed INT NOT NULL,
        tasks_failed INT NOT NULL,
        PRIMARY KEY (tenant_id, scenario_id, window_start, window_end)
      );
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_mas_task_stats_read_model_window
        ON ${this.taskStatsTable} (tenant_id, scenario_id, window_start, window_end);
    `);
  }
}
