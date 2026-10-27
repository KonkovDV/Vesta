import type { ContrastiveTrajectoryEntry } from '../../../domain/memory/IContrastiveLessonLearner';
import type { ITrajectoryStore } from '../../../domain/memory/ITrajectoryStore';
import type { TrajectoryIntelligenceResult } from '../../../domain/memory/ITrajectoryIntelligenceExtractor';
import type { IDatabaseConnection } from '../../../domain/persistence/IDatabaseConnection';
import { requirePublicTables, runtimeDdlEnabled } from '../../database/runtime-ddl';
import { safeJsonParse } from '../../../core/utils/json';

const INTELLIGENCE_TABLE = 'learning_trajectory_intelligence';
const CONTRASTIVE_TABLE = 'learning_contrastive_trajectories';

interface PayloadRow {
  payload: string;
}

export class PostgresTrajectoryStore implements ITrajectoryStore {
  private schemaInitialized = false;

  constructor(private readonly db: IDatabaseConnection) {}

  async saveIntelligence(result: TrajectoryIntelligenceResult): Promise<void> {
    await this.ensureSchema();

    await this.db.execute(
      `INSERT INTO ${INTELLIGENCE_TABLE} (trajectory_id, outcome_classification, analyzed_at, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (trajectory_id) DO UPDATE SET
         outcome_classification = EXCLUDED.outcome_classification,
         analyzed_at = EXCLUDED.analyzed_at,
         payload = EXCLUDED.payload`,
      [
        result.trajectoryId,
        result.outcomeClassification,
        result.analyzedAt,
        JSON.stringify(result),
      ],
    );
  }

  async listIntelligence(limit = 100): Promise<readonly TrajectoryIntelligenceResult[]> {
    await this.ensureSchema();

    const queryLimit = Math.max(1, limit);
    const rows = await this.db.query<PayloadRow>(
      `SELECT payload FROM ${INTELLIGENCE_TABLE}
       ORDER BY analyzed_at DESC NULLS LAST
       LIMIT $1`,
      [queryLimit],
    );

    return rows.rows
      .map((row) => safeJsonParse<TrajectoryIntelligenceResult>(row.payload))
      .filter((row): row is TrajectoryIntelligenceResult => row !== null);
  }

  async saveContrastiveTrajectory(entry: ContrastiveTrajectoryEntry): Promise<void> {
    await this.ensureSchema();

    await this.db.execute(
      `INSERT INTO ${CONTRASTIVE_TABLE} (trajectory_id, root_cause_category, outcome, recorded_at, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (trajectory_id) DO UPDATE SET
         root_cause_category = EXCLUDED.root_cause_category,
         outcome = EXCLUDED.outcome,
         recorded_at = EXCLUDED.recorded_at,
         payload = EXCLUDED.payload`,
      [
        entry.trajectoryId,
        entry.rootCauseCategory,
        entry.outcome,
        entry.recordedAt,
        JSON.stringify(entry),
      ],
    );
  }

  async listContrastiveByCategory(rootCauseCategory: string): Promise<readonly ContrastiveTrajectoryEntry[]> {
    await this.ensureSchema();

    const rows = await this.db.query<PayloadRow>(
      `SELECT payload FROM ${CONTRASTIVE_TABLE}
       WHERE root_cause_category = $1
       ORDER BY recorded_at DESC NULLS LAST`,
      [rootCauseCategory],
    );

    return rows.rows
      .map((row) => safeJsonParse<ContrastiveTrajectoryEntry>(row.payload))
      .filter((row): row is ContrastiveTrajectoryEntry => row !== null);
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaInitialized) {
      return;
    }

    if (!runtimeDdlEnabled()) {
      await requirePublicTables(this.db, [INTELLIGENCE_TABLE, CONTRASTIVE_TABLE]);
      this.schemaInitialized = true;
      return;
    }

    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS ${INTELLIGENCE_TABLE} (
         trajectory_id TEXT PRIMARY KEY,
         outcome_classification TEXT NOT NULL,
         analyzed_at TIMESTAMPTZ NULL,
         payload TEXT NOT NULL
       )`,
    );

    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS ${CONTRASTIVE_TABLE} (
         trajectory_id TEXT PRIMARY KEY,
         root_cause_category TEXT NOT NULL,
         outcome TEXT NOT NULL,
         recorded_at TIMESTAMPTZ NULL,
         payload TEXT NOT NULL
       )`,
    );

    this.schemaInitialized = true;
  }
}