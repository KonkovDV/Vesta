import { safeJsonParse } from '../../../core/utils/json';
import type { ITipStore, TipFeedbackState, TipStoreFilter } from '../../../domain/memory/ITipStore';
import type { StructuredTip } from '../../../domain/memory/IContextualTipGenerator';
import type { IDatabaseConnection } from '../../../domain/persistence/IDatabaseConnection';

const TIPS_TABLE = 'learning_structured_tips';
const FEEDBACK_TABLE = 'learning_tip_feedback';

interface PayloadRow {
  payload: string;
}

export class PostgresTipStore implements ITipStore {
  private schemaInitialized = false;

  constructor(private readonly db: IDatabaseConnection) {}

  async saveTip(tip: StructuredTip): Promise<void> {
    await this.ensureSchema();

    await this.db.execute(
      `INSERT INTO ${TIPS_TABLE} (tip_id, category, task_domain, priority, generated_at, payload)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tip_id) DO UPDATE SET
         category = EXCLUDED.category,
         task_domain = EXCLUDED.task_domain,
         priority = EXCLUDED.priority,
         generated_at = EXCLUDED.generated_at,
         payload = EXCLUDED.payload`,
      [
        tip.tipId,
        tip.category,
        tip.taskDomain ?? null,
        tip.priority,
        tip.generatedAt,
        JSON.stringify(tip),
      ],
    );
  }

  async listTips(filter?: TipStoreFilter): Promise<readonly StructuredTip[]> {
    await this.ensureSchema();

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter?.category) {
      params.push(filter.category);
      clauses.push(`category = $${params.length}`);
    }

    if (filter?.taskDomain) {
      params.push(filter.taskDomain);
      clauses.push(`task_domain = $${params.length}`);
    }

    if (filter?.minPriority !== undefined) {
      params.push(filter.minPriority);
      clauses.push(`priority >= $${params.length}`);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = await this.db.query<PayloadRow>(
      `SELECT payload FROM ${TIPS_TABLE}
       ${whereClause}
       ORDER BY priority DESC, generated_at DESC NULLS LAST`,
      params,
    );

    return rows.rows
      .map((row) => safeJsonParse<StructuredTip>(row.payload))
      .filter((row): row is StructuredTip => row !== null);
  }

  async recordTipFeedback(feedback: TipFeedbackState): Promise<void> {
    await this.ensureSchema();

    await this.db.execute(
      `INSERT INTO ${FEEDBACK_TABLE} (tip_id, used, helpful, recorded_at, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tip_id) DO UPDATE SET
         used = EXCLUDED.used,
         helpful = EXCLUDED.helpful,
         recorded_at = EXCLUDED.recorded_at,
         payload = EXCLUDED.payload`,
      [
        feedback.tipId,
        feedback.used,
        feedback.helpful,
        feedback.recordedAt,
        JSON.stringify(feedback),
      ],
    );
  }

  async listTipFeedback(): Promise<readonly TipFeedbackState[]> {
    await this.ensureSchema();

    const rows = await this.db.query<PayloadRow>(
      `SELECT payload FROM ${FEEDBACK_TABLE}
       ORDER BY recorded_at DESC NULLS LAST`,
    );

    return rows.rows
      .map((row) => safeJsonParse<TipFeedbackState>(row.payload))
      .filter((row): row is TipFeedbackState => row !== null);
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaInitialized) {
      return;
    }

    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS ${TIPS_TABLE} (
         tip_id TEXT PRIMARY KEY,
         category TEXT NOT NULL,
         task_domain TEXT NULL,
         priority DOUBLE PRECISION NOT NULL,
         generated_at TIMESTAMPTZ NULL,
         payload TEXT NOT NULL
       )`,
    );

    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS ${FEEDBACK_TABLE} (
         tip_id TEXT PRIMARY KEY,
         used BOOLEAN NOT NULL,
         helpful BOOLEAN NOT NULL,
         recorded_at TIMESTAMPTZ NOT NULL,
         payload TEXT NOT NULL
       )`,
    );

    this.schemaInitialized = true;
  }
}