import type { ExtractedLesson, SamuleLevel } from '../../../domain/agents/IS2iLessonExtractor';
import type { ILessonStore } from '../../../domain/memory/ILessonStore';
import type { ConsolidatedPrinciple } from '../../../domain/memory/IWisdomConsolidator';
import type { IDatabaseConnection } from '../../../domain/persistence/IDatabaseConnection';
import { requirePublicTables, runtimeDdlEnabled } from '../../database/runtime-ddl';
import { safeJsonParse } from '../../../core/utils/json';

const LESSONS_TABLE = 'learning_extracted_lessons';
const PRINCIPLES_TABLE = 'learning_consolidated_principles';

interface PayloadRow {
  payload: string;
}

export class PostgresLessonStore implements ILessonStore {
  private schemaInitialized = false;

  constructor(private readonly db: IDatabaseConnection) {}

  async saveLesson(lesson: ExtractedLesson): Promise<void> {
    await this.ensureSchema();

    await this.db.execute(
      `INSERT INTO ${LESSONS_TABLE} (lesson_id, level, root_cause_category, extracted_at, payload)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (lesson_id) DO UPDATE SET
         level = EXCLUDED.level,
         root_cause_category = EXCLUDED.root_cause_category,
         extracted_at = EXCLUDED.extracted_at,
         payload = EXCLUDED.payload`,
      [
        lesson.lessonId,
        lesson.level,
        lesson.rootCauseCategory,
        lesson.extractedAt,
        JSON.stringify(lesson),
      ],
    );
  }

  async listLessons(level?: SamuleLevel): Promise<readonly ExtractedLesson[]> {
    await this.ensureSchema();

    const rows = level
      ? await this.db.query<PayloadRow>(
        `SELECT payload FROM ${LESSONS_TABLE}
         WHERE level = $1
         ORDER BY extracted_at DESC NULLS LAST`,
        [level],
      )
      : await this.db.query<PayloadRow>(
        `SELECT payload FROM ${LESSONS_TABLE}
         ORDER BY extracted_at DESC NULLS LAST`,
      );

    return rows.rows
      .map((row) => safeJsonParse<ExtractedLesson>(row.payload))
      .filter((row): row is ExtractedLesson => row !== null);
  }

  async savePrinciple(principle: ConsolidatedPrinciple): Promise<void> {
    await this.ensureSchema();

    await this.db.execute(
      `INSERT INTO ${PRINCIPLES_TABLE} (principle_id, root_cause_category, consolidated_at, payload)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (principle_id) DO UPDATE SET
         root_cause_category = EXCLUDED.root_cause_category,
         consolidated_at = EXCLUDED.consolidated_at,
         payload = EXCLUDED.payload`,
      [
        principle.principleId,
        principle.rootCauseCategory,
        principle.consolidatedAt,
        JSON.stringify(principle),
      ],
    );
  }

  async listPrinciples(rootCauseCategory?: string): Promise<readonly ConsolidatedPrinciple[]> {
    await this.ensureSchema();

    const rows = rootCauseCategory
      ? await this.db.query<PayloadRow>(
        `SELECT payload FROM ${PRINCIPLES_TABLE}
         WHERE root_cause_category = $1
         ORDER BY consolidated_at DESC NULLS LAST`,
        [rootCauseCategory],
      )
      : await this.db.query<PayloadRow>(
        `SELECT payload FROM ${PRINCIPLES_TABLE}
         ORDER BY consolidated_at DESC NULLS LAST`,
      );

    return rows.rows
      .map((row) => safeJsonParse<ConsolidatedPrinciple>(row.payload))
      .filter((row): row is ConsolidatedPrinciple => row !== null);
  }

  private async ensureSchema(): Promise<void> {
    if (this.schemaInitialized) {
      return;
    }

    if (!runtimeDdlEnabled()) {
      await requirePublicTables(this.db, [LESSONS_TABLE, PRINCIPLES_TABLE]);
      this.schemaInitialized = true;
      return;
    }

    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS ${LESSONS_TABLE} (
         lesson_id TEXT PRIMARY KEY,
         level TEXT NOT NULL,
         root_cause_category TEXT NOT NULL,
         extracted_at TIMESTAMPTZ NULL,
         payload TEXT NOT NULL
       )`,
    );

    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS ${PRINCIPLES_TABLE} (
         principle_id TEXT PRIMARY KEY,
         root_cause_category TEXT NOT NULL,
         consolidated_at TIMESTAMPTZ NULL,
         payload TEXT NOT NULL
       )`,
    );

    this.schemaInitialized = true;
  }
}