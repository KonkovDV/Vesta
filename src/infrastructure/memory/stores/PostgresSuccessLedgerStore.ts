import type { SuccessLedgerEntry } from '../../../domain/agents/IS2iLessonExtractor';
import type {
  ISuccessLedgerStore,
  SuccessLedgerEntryFilter,
} from '../../../domain/memory/ISuccessLedgerStore';
import type { IDatabaseConnection } from '../../../domain/persistence/IDatabaseConnection';
import { requirePublicTables, runtimeDdlEnabled } from '../../database/runtime-ddl';
import { safeJsonParse } from '../../../core/utils/json';

const SUCCESS_LEDGER_TABLE = 'learning_success_ledger_entries';

interface PayloadRow {
  payload: string;
}

export class PostgresSuccessLedgerStore implements ISuccessLedgerStore {
  private schemaInitialized = false;

  constructor(private readonly db: IDatabaseConnection) {}

  async saveEntry(entry: SuccessLedgerEntry): Promise<void> {
    await this.ensureSchema();

    await this.db.execute(
      `INSERT INTO ${SUCCESS_LEDGER_TABLE} (
         entry_id,
         root_cause_category,
         session_id,
         timestamp,
         payload
       )
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (entry_id) DO UPDATE SET
         root_cause_category = EXCLUDED.root_cause_category,
         session_id = EXCLUDED.session_id,
         timestamp = EXCLUDED.timestamp,
         payload = EXCLUDED.payload`,
      [
        entry.entryId,
        entry.rootCauseCategory,
        entry.sessionId ?? null,
        entry.timestamp,
        JSON.stringify(entry),
      ],
    );
  }

  async listEntries(filter?: SuccessLedgerEntryFilter): Promise<readonly SuccessLedgerEntry[]> {
    await this.ensureSchema();

    let query = `SELECT payload FROM ${SUCCESS_LEDGER_TABLE}`;
    const whereClauses: string[] = [];
    const params: Array<string> = [];

    if (filter?.rootCauseCategory) {
      params.push(filter.rootCauseCategory);
      whereClauses.push(`root_cause_category = $${params.length}`);
    }

    if (filter?.sessionId) {
      params.push(filter.sessionId);
      whereClauses.push(`session_id = $${params.length}`);
    }

    if (whereClauses.length > 0) {
      query += ` WHERE ${whereClauses.join(' AND ')}`;
    }

    query += ' ORDER BY timestamp DESC NULLS LAST';

    const rows = params.length > 0
      ? await this.db.query<PayloadRow>(query, params)
      : await this.db.query<PayloadRow>(query);

    return rows.rows
      .map((row) => safeJsonParse<SuccessLedgerEntry>(row.payload))
      .filter((row): row is SuccessLedgerEntry => row !== null);
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaInitialized) {
      return;
    }

    if (!runtimeDdlEnabled()) {
      await requirePublicTables(this.db, [SUCCESS_LEDGER_TABLE]);
      this.schemaInitialized = true;
      return;
    }

    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS ${SUCCESS_LEDGER_TABLE} (
         entry_id TEXT PRIMARY KEY,
         root_cause_category TEXT NOT NULL,
         session_id TEXT NULL,
         timestamp TIMESTAMPTZ NOT NULL,
         payload TEXT NOT NULL
       )`,
    );

    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_${SUCCESS_LEDGER_TABLE}_root_cause_category
       ON ${SUCCESS_LEDGER_TABLE} (root_cause_category)`,
    );

    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_${SUCCESS_LEDGER_TABLE}_session_id
       ON ${SUCCESS_LEDGER_TABLE} (session_id)`,
    );

    await this.db.execute(
      `CREATE INDEX IF NOT EXISTS idx_${SUCCESS_LEDGER_TABLE}_timestamp
       ON ${SUCCESS_LEDGER_TABLE} (timestamp DESC)`,
    );

    this.schemaInitialized = true;
  }
}