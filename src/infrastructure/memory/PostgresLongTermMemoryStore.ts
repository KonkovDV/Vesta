/**
 * PostgresLongTermMemoryStore
 * Infrastructure implementation of LongTermMemoryStore using PostgreSQL + tsvector.
 *
 * Layer: Infrastructure
 */
import { v5 as uuidv5 } from 'uuid';
import { LongTermMemoryStore } from '../../domain/memory/session-memory-ports';
import type {
  IProfileMemory,
  ProfileMemoryEntry,
  ProfileMemoryEntryType,
  ProfileMemorySnapshotInput,
  ProfileMemoryWriteResult,
  SearchProfileMemoryInput,
  WriteProfileMemoryInput,
} from '../../domain/memory/IProfileMemory';
import { bestMemoryWindow, selectMemoryRounds } from '../../domain/memory/memory-snippet';
import type {
  EvaluationMemoryPlane,
  EvaluationMemoryRunRecord,
  EvaluationMemoryVerdict,
  EvaluationPlaneScorecard,
  EvaluationPlaneScorecardInput,
  IEvaluationMemory,
  RecordEvaluationRunInput,
} from '../../domain/memory/IEvaluationMemory';

// Specific namespace for LongTermMemory entries to ensure deterministic IDs
const LTM_NAMESPACE = '1b671a64-40d5-491e-99b0-da01ff1f3341';
import {
  TenantId,
  UserId,
  WorkingMemoryEntry,
  WorkingMemoryEntryType,
  CorrelationId,
  SessionId,
  SessionMessage,
} from '../../domain/memory/session-types';
import { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import { withSearchMemorySpan } from '../../monitoring';
import { safeJsonParse } from '../../core/utils/json';
import type { ILogger } from '../../core/decorators/ILogger';
import type {
  IMemoryEmbeddingIndexer,
  IUnembeddedMemorySource,
  MemoryEmbeddingTarget,
} from '../../domain/memory/IMemoryEmbeddingIndexer';

interface DbMemoryRow {
  id: string;
  tenant_id: string;
  user_id: string;
  content: string;
  type: string;
  metadata: unknown; // JSONB (parsed by pg)
  created_at: Date;
  // search_vector handled by DB
}

interface EvaluationScorecardRow {
  plane: string;
  total_runs: number | string;
  pass_count: number | string;
  fail_count: number | string;
  inconclusive_count: number | string;
  average_score: number | string | null;
  latest_run_at: Date | string | null;
}

const DEFAULT_EVALUATION_TENANT_ID = 'global';
const DEFAULT_EVALUATION_USER_ID = 'system';
const EVALUATION_MEMORY_TYPE = 'evaluation_run';
const EVALUATION_MEMORY_PLANES: readonly EvaluationMemoryPlane[] = [
  'working',
  'summary',
  'episodic',
  'semantic',
  'procedural',
  'profile',
  'archival',
  'graph',
  'reflective',
  'governance',
  'evaluation',
];
const EVALUATION_MEMORY_VERDICTS: readonly EvaluationMemoryVerdict[] = [
  'pass',
  'fail',
  'inconclusive',
];

function toMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    return safeJsonParse<Record<string, unknown>>(value, {}) ?? {};
  }

  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function toImportance(value: unknown): number {
  if (typeof value === 'number') return value;
  return 0.5;
}

function toEntryType(value: string): WorkingMemoryEntryType {
  switch (value) {
    case 'consolidated_context':
    case 'episodic_reference':
    case 'user_profile':
    case 'preference':
      return value;
    default:
      return 'episodic_reference';
  }
}

function isProfileEntryType(value: string): value is ProfileMemoryEntryType {
  return value === 'user_profile' || value === 'preference';
}

function isEvaluationMemoryPlane(value: string): value is EvaluationMemoryPlane {
  return EVALUATION_MEMORY_PLANES.includes(value as EvaluationMemoryPlane);
}

function isEvaluationMemoryVerdict(value: string): value is EvaluationMemoryVerdict {
  return EVALUATION_MEMORY_VERDICTS.includes(value as EvaluationMemoryVerdict);
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return undefined;
}

function toIsoTimestamp(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string') {
    return value;
  }

  return undefined;
}

function toEvaluationRun(row: DbMemoryRow): EvaluationMemoryRunRecord | undefined {
  if (row.type !== EVALUATION_MEMORY_TYPE) {
    return undefined;
  }

  const payload = toMetadata(row.metadata);
  const plane = typeof payload.plane === 'string' && isEvaluationMemoryPlane(payload.plane)
    ? payload.plane
    : undefined;
  const verdict = typeof payload.verdict === 'string' && isEvaluationMemoryVerdict(payload.verdict)
    ? payload.verdict
    : undefined;

  if (!plane || !verdict) {
    return undefined;
  }

  return {
    runId: typeof payload.runId === 'string' ? payload.runId : row.id,
    plane,
    benchmarkId: typeof payload.benchmarkId === 'string' ? payload.benchmarkId : 'unknown',
    benchmarkVersion: typeof payload.benchmarkVersion === 'string' ? payload.benchmarkVersion : 'unknown',
    summary: row.content,
    verdict,
    timestamp: typeof payload.timestamp === 'string' ? payload.timestamp : row.created_at.toISOString(),
    score: toNumber(payload.score),
    maxScore: toNumber(payload.maxScore),
    model: typeof payload.model === 'string' ? payload.model : undefined,
    config: typeof payload.config === 'object' && payload.config !== null
      ? payload.config as Record<string, unknown>
      : undefined,
    judges: Array.isArray(payload.judges)
      ? payload.judges as EvaluationMemoryRunRecord['judges']
      : undefined,
    aggregate: typeof payload.aggregate === 'object' && payload.aggregate !== null
      ? payload.aggregate as EvaluationMemoryRunRecord['aggregate']
      : undefined,
    metadata: typeof payload.metadata === 'object' && payload.metadata !== null
      ? payload.metadata as Record<string, unknown>
      : undefined,
  };
}

function toProfileEntry(row: DbMemoryRow): ProfileMemoryEntry | undefined {
  if (!isProfileEntryType(row.type)) {
    return undefined;
  }

  const metadata = toMetadata(row.metadata);

  return {
    type: row.type,
    summary: row.content,
    timestamp: row.created_at.toISOString(),
    importance: toImportance(metadata.importance),
    metadata: { ...metadata, db_id: row.id },
  };
}

const MEMORY_CANDIDATE_POOL = 40;
const MEMORY_SNIPPET_BUDGET = 800;

function rerankMemoryRows<T extends { content: string; created_at?: Date }>(rows: T[], query: string, limit: number): T[] {
  const selected = selectMemoryRounds(rows.map((row) => ({
    ...row,
    text: row.content,
    at: row.created_at instanceof Date ? row.created_at.toISOString() : undefined,
  })), query, limit);
  const chosen = selected.length > 0 ? selected : rows.slice(0, limit);
  return chosen.map((row) => ({
    ...row,
    content: row.content.length > MEMORY_SNIPPET_BUDGET
      ? bestMemoryWindow(row.content, query, MEMORY_SNIPPET_BUDGET)
      : row.content,
  }));
}

export type MemoryRetrievalMode = 'lexical' | 'dense' | 'hybrid';

const MEMORY_RRF_K = 60;

export function parseMemoryRetrievalMode(value: string | undefined): MemoryRetrievalMode {
  return value === 'dense' || value === 'hybrid' ? value : 'lexical';
}

/** pgvector literal. Values stay out of the SQL text. */
export function toPgVectorLiteral(values: readonly number[]): string {
  if (values.length === 0 || values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) {
    throw new Error('query embedding must be a non-empty list of finite numbers');
  }
  return `[${values.join(',')}]`;
}

/** Reciprocal rank fusion, k = 60, same constant as the lexical list merger. */
export function fuseMemoryRows<T extends { id: string }>(
  lists: readonly (readonly T[])[],
  limit: number,
): T[] {
  const scores = new Map<string, { score: number; item: T }>();
  for (const list of lists) {
    for (let index = 0; index < list.length; index += 1) {
      const item = list[index];
      const score = 1 / (MEMORY_RRF_K + index + 1);
      const existing = scores.get(item.id);
      if (existing) existing.score += score;
      else scores.set(item.id, { score, item });
    }
  }
  return [...scores.values()]
    .sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id))
    .slice(0, limit)
    .map((entry) => entry.item);
}

export function buildDisjunctiveWebSearchQuery(query: string): string {
  const words = Array.from(new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}_]+/u)
      .filter((token) => token.length >= 3),
  ));
  if (words.length <= 1) {
    return query;
  }
  return words.join(' OR ');
}

export class PostgresLongTermMemoryStore
  implements LongTermMemoryStore, IProfileMemory, IEvaluationMemory, IUnembeddedMemorySource {
  /**
   * @param embeddingIndexer resolved on first write, so the store can be built before the AI module.
   */
  constructor(
    private readonly db: IDatabaseConnection,
    private readonly embeddingIndexer?: () => IMemoryEmbeddingIndexer | undefined,
    private readonly logger?: Pick<ILogger, 'warn'>,
    private readonly retrieval: {
      mode?: MemoryRetrievalMode;
      embedQuery?: (query: string) => Promise<number[] | null>;
    } = {},
  ) {}

  async listUnembedded(limit: number): Promise<ReadonlyArray<MemoryEmbeddingTarget>> {
    const result = await this.db.query<DbMemoryRow>(
      `SELECT id, tenant_id, user_id, content, type, metadata, created_at
       FROM long_term_memories
       WHERE embedding IS NULL
         AND type IN ('user_profile', 'preference', 'evaluation_run')
         AND length(trim(content)) > 0
       ORDER BY created_at ASC
       LIMIT $1`,
      [limit],
    );
    return result.rows.map((row) => ({
      id: row.id,
      tenantId: row.tenant_id,
      userId: row.user_id,
      content: row.content,
      type: row.type,
      metadata: toMetadata(row.metadata),
    }));
  }

  /** A failed embedding keeps the row; `listUnembedded` returns it to the backfill. */
  private async indexEmbeddings(targets: MemoryEmbeddingTarget[]): Promise<void> {
    const indexer = this.embeddingIndexer?.();
    if (!indexer || targets.length === 0) {
      return;
    }
    try {
      await indexer.index(targets);
    } catch (error) {
      this.logger?.warn('Long-term memory embedding failed; rows stay for backfill', {
        rows: targets.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async recordRun(input: RecordEvaluationRunInput): Promise<{ stored: boolean; storedRunId: string }> {
    const tenantId = input.tenantId ?? DEFAULT_EVALUATION_TENANT_ID;
    const userId = input.userId ?? DEFAULT_EVALUATION_USER_ID;
    const { run } = input;
    const deterministicUuid = uuidv5(
      `${tenantId}:${userId}:evaluation:${run.runId}`,
      LTM_NAMESPACE,
    );

    const metadata = {
      ...run,
      tenantId,
      userId,
      correlationId: input.correlationId,
      runId: run.runId,
      source_event_id: input.correlationId ?? run.runId,
      _type: EVALUATION_MEMORY_TYPE,
    };
    await this.db.query(
      `INSERT INTO long_term_memories (
         id, tenant_id, user_id, content, type, metadata, created_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO UPDATE SET
         content = EXCLUDED.content,
         metadata = EXCLUDED.metadata,
         updated_at = NOW()`,
      [
        deterministicUuid,
        tenantId,
        userId,
        run.summary,
        EVALUATION_MEMORY_TYPE,
        JSON.stringify(metadata),
        new Date(run.timestamp),
      ],
    );
    await this.indexEmbeddings([
      {
        id: deterministicUuid,
        tenantId,
        userId,
        content: run.summary,
        type: EVALUATION_MEMORY_TYPE,
        metadata,
      },
    ]);

    return {
      stored: true,
      storedRunId: run.runId,
    };
  }

  async listRuns(input: {
    tenantId?: string;
    userId?: string;
    plane?: EvaluationMemoryPlane;
    benchmarkId?: string;
    verdict?: EvaluationMemoryVerdict;
    limit?: number;
  }): Promise<ReadonlyArray<EvaluationMemoryRunRecord>> {
    const sql = `
      SELECT id, tenant_id, user_id, content, type, metadata, created_at
      FROM long_term_memories
      WHERE type = $1
        AND ($2::text IS NULL OR tenant_id = $2)
        AND ($3::text IS NULL OR user_id = $3)
        AND ($4::text IS NULL OR metadata->>'plane' = $4)
        AND ($5::text IS NULL OR metadata->>'benchmarkId' = $5)
        AND ($6::text IS NULL OR metadata->>'verdict' = $6)
      ORDER BY created_at DESC
      LIMIT $7
    `;

    const result = await this.db.query<DbMemoryRow>(sql, [
      EVALUATION_MEMORY_TYPE,
      input.tenantId ?? null,
      input.userId ?? null,
      input.plane ?? null,
      input.benchmarkId ?? null,
      input.verdict ?? null,
      input.limit ?? 20,
    ]);

    return result.rows
      .map((row) => toEvaluationRun(row))
      .filter((row): row is EvaluationMemoryRunRecord => row !== undefined);
  }

  async getPlaneScorecard(
    input: EvaluationPlaneScorecardInput,
  ): Promise<ReadonlyArray<EvaluationPlaneScorecard>> {
    const requestedPlanes = input.planes?.filter((plane) => isEvaluationMemoryPlane(plane)) ?? [];
    const sql = `
      SELECT
        metadata->>'plane' AS plane,
        COUNT(*) AS total_runs,
        SUM(CASE WHEN metadata->>'verdict' = 'pass' THEN 1 ELSE 0 END) AS pass_count,
        SUM(CASE WHEN metadata->>'verdict' = 'fail' THEN 1 ELSE 0 END) AS fail_count,
        SUM(CASE WHEN metadata->>'verdict' = 'inconclusive' THEN 1 ELSE 0 END) AS inconclusive_count,
        AVG(NULLIF(metadata->>'score', '')::double precision) AS average_score,
        MAX(created_at) AS latest_run_at
      FROM long_term_memories
      WHERE type = $1
        AND ($2::text IS NULL OR tenant_id = $2)
        AND ($3::text IS NULL OR user_id = $3)
        AND ($4::text[] IS NULL OR metadata->>'plane' = ANY($4::text[]))
      GROUP BY metadata->>'plane'
      ORDER BY metadata->>'plane' ASC
    `;

    const result = await this.db.query<EvaluationScorecardRow>(sql, [
      EVALUATION_MEMORY_TYPE,
      input.tenantId ?? null,
      input.userId ?? null,
      requestedPlanes.length > 0 ? requestedPlanes : null,
    ]);

    return result.rows
      .map((row): EvaluationPlaneScorecard | undefined => {
        if (!isEvaluationMemoryPlane(row.plane)) {
          return undefined;
        }

        return {
          plane: row.plane,
          totalRuns: Number(row.total_runs),
          passCount: Number(row.pass_count),
          failCount: Number(row.fail_count),
          inconclusiveCount: Number(row.inconclusive_count),
          averageScore: toNumber(row.average_score),
          latestRunAt: toIsoTimestamp(row.latest_run_at),
        };
      })
      .filter((row): row is EvaluationPlaneScorecard => row !== undefined);
  }

  async writeProfileEntries(input: WriteProfileMemoryInput): Promise<ProfileMemoryWriteResult> {
    const { tenantId, userId, entries, mode = 'merge' } = input;
    let superseded = 0;
    const targets: MemoryEmbeddingTarget[] = [];

    await this.db.transaction(async () => {
      if (mode === 'replace') {
        const deleted = await this.db.query<{ id: string }>(
          `DELETE FROM long_term_memories
           WHERE tenant_id = $1
             AND user_id = $2
             AND type IN ('user_profile', 'preference')`,
          [tenantId, userId],
        );
        superseded = deleted?.rowCount ?? entries.length;
      }

      const rows = entries.map((entry) => {
        const id = uuidv5(`${tenantId}:${userId}:${entry.summary}`, LTM_NAMESPACE);
        const metadata: Record<string, unknown> = {
          ...entry,
          _type: 'user_profile',
          ...(input.correlationId ? { source_event_id: input.correlationId } : {}),
        };
        targets.push({
          id,
          tenantId,
          userId,
          content: entry.summary,
          type: entry.type,
          metadata: {
            ...metadata,
            source: input.correlationId ?? 'unknown',
          },
        });
        return {
          id,
          content: entry.summary,
          type: entry.type,
          metadata: JSON.stringify(metadata),
          createdAt: new Date(entry.timestamp),
        };
      });
      if (rows.length > 0) {
        await this.db.query(
          `INSERT INTO long_term_memories (
             id, tenant_id, user_id, content, type, metadata, created_at
           )
           SELECT * FROM UNNEST(
             $1::uuid[], $2::text[], $3::text[], $4::text[], $5::text[], $6::jsonb[], $7::timestamptz[]
           ) AS t(id, tenant_id, user_id, content, type, metadata, created_at)
           ON CONFLICT (id) DO UPDATE SET
             content = EXCLUDED.content,
             type = EXCLUDED.type,
             metadata = long_term_memories.metadata || EXCLUDED.metadata,
             updated_at = NOW()`,
          [
            rows.map((row) => row.id),
            rows.map(() => tenantId),
            rows.map(() => userId),
            rows.map((row) => row.content),
            rows.map((row) => row.type),
            rows.map((row) => row.metadata),
            rows.map((row) => row.createdAt),
          ],
        );
      }
    });
    await this.indexEmbeddings(targets);

    return {
      written: entries.length,
      superseded,
    };
  }

  async search(input: SearchProfileMemoryInput): Promise<ReadonlyArray<ProfileMemoryEntry>> {
    return withSearchMemorySpan(async () => {
      const { tenantId, userId, query, limit = 5 } = input;
      const rows = await this.rankedRows({ tenantId, userId, query, limit, profileOnly: true });
      return rows
        .map((row) => toProfileEntry(row))
        .filter((row): row is ProfileMemoryEntry => row !== undefined);
    });
  }

  async getProfileSnapshot(
    input: ProfileMemorySnapshotInput,
  ): Promise<ReadonlyArray<ProfileMemoryEntry>> {
    const { tenantId, userId, limit = 20 } = input;
    const requestedTypes = input.types?.filter((type) => isProfileEntryType(type)) ?? [
      'user_profile',
      'preference',
    ];

    const sql = `
      SELECT id, content, type, metadata, created_at
      FROM long_term_memories
      WHERE tenant_id = $1
        AND user_id = $2
        AND type = ANY($4::text[])
      ORDER BY created_at DESC
      LIMIT $3
    `;

    const result = await this.db.query<DbMemoryRow>(sql, [tenantId, userId, limit, requestedTypes]);
    return result.rows
      .map((row) => toProfileEntry(row))
      .filter((row): row is ProfileMemoryEntry => row !== undefined);
  }

  async upsertUserProfileEntries(input: {
    tenant_id: TenantId;
    user_id: UserId;
    entries: WorkingMemoryEntry[];
    correlation_id?: CorrelationId;
  }): Promise<void> {
    const { tenant_id, user_id, entries } = input;

    const profileEntries = entries
      .filter((entry): entry is WorkingMemoryEntry & { type: ProfileMemoryEntryType } =>
        entry.type === 'user_profile' || entry.type === 'preference',
      )
      .map((entry) => ({
        type: entry.type,
        summary: entry.summary,
        importance: entry.importance,
        timestamp: entry.timestamp,
        metadata: entry.metadata,
      }));

    await this.writeProfileEntries({
      tenantId: tenant_id,
      userId: user_id,
      entries: profileEntries,
      mode: 'merge',
      correlationId: input.correlation_id,
    });
  }

  async queryLongTermContext(input: {
    tenant_id: TenantId;
    user_id: UserId;
    query: string;
    limit?: number;
  }): Promise<WorkingMemoryEntry[]> {
    const { tenant_id, user_id, query, limit = 5 } = input;
    const rows = await this.rankedRows({
      tenantId: tenant_id,
      userId: user_id,
      query,
      limit,
      profileOnly: false,
    });

    return rows.map(row => {
      const metadata = toMetadata(row.metadata);
      
      return {
        type: toEntryType(row.type),
        summary: row.content,
        original_count: 1,
        timestamp: row.created_at.toISOString(),
        importance: toImportance(metadata.importance),
        metadata: { ...metadata, db_id: row.id } // Pass DB ID
      };
    });
  }

  private pool(limit: number): number {
    return Math.min(MEMORY_CANDIDATE_POOL, Math.max(limit * 8, limit));
  }

  private async rankedRows(input: {
    tenantId: string;
    userId: string;
    query: string;
    limit: number;
    profileOnly: boolean;
  }): Promise<DbMemoryRow[]> {
    const mode = this.retrieval.mode ?? 'lexical';
    const loadLexical = () => this.lexicalRows(input);
    if (mode === 'lexical') return this.present(await loadLexical(), input.query, input.limit, 'lexical');
    if (mode === 'dense') {
      const vector = await this.retrieval.embedQuery?.(input.query) ?? null;
      if (!vector) {
        this.logger?.warn('Memory retrieval fell back to lexical search', { mode });
        return this.present(await loadLexical(), input.query, input.limit, 'lexical');
      }
      return this.present(await this.denseRows(input, vector), input.query, input.limit, 'dense');
    }
    // Hybrid: the lexical scan does not need the embedding, so it runs while the vector is built.
    const lexicalPromise = loadLexical();
    const vector = await this.retrieval.embedQuery?.(input.query) ?? null;
    if (!vector) {
      this.logger?.warn('Memory retrieval fell back to lexical search', { mode });
      return this.present(await lexicalPromise, input.query, input.limit, 'lexical');
    }
    const [lexicalResult, denseResult] = await Promise.allSettled([
      lexicalPromise,
      this.denseRows(input, vector),
    ]);
    if (lexicalResult.status === 'rejected' && denseResult.status === 'rejected') {
      throw lexicalResult.reason;
    }
    if (lexicalResult.status === 'rejected') {
      this.logger?.warn('Lexical memory search failed; using the dense list', { mode });
      return this.present(denseResult.status === 'fulfilled' ? denseResult.value : [], input.query, input.limit, 'dense');
    }
    if (denseResult.status === 'rejected') {
      this.logger?.warn('Dense memory search failed; using the lexical list', { mode });
      return this.present(lexicalResult.value, input.query, input.limit, 'lexical');
    }
    return this.present(
      fuseMemoryRows([lexicalResult.value, denseResult.value], this.pool(input.limit)),
      input.query,
      input.limit,
      'hybrid',
    );
  }

  private present(rows: DbMemoryRow[], query: string, limit: number, mode: MemoryRetrievalMode): DbMemoryRow[] {
    if (mode === 'lexical') return rerankMemoryRows(rows, query, limit);
    return rows.slice(0, limit).map((row) => ({
      ...row,
      content: row.content.length > MEMORY_SNIPPET_BUDGET
        ? bestMemoryWindow(row.content, query, MEMORY_SNIPPET_BUDGET)
        : row.content,
    }));
  }

  private async lexicalRows(input: {
    tenantId: string;
    userId: string;
    query: string;
    limit: number;
    profileOnly: boolean;
  }): Promise<DbMemoryRow[]> {
    const disjunctiveQuery = buildDisjunctiveWebSearchQuery(input.query);
    const typeClause = input.profileOnly ? `AND type IN ('user_profile', 'preference')` : '';
    const sql = `
      WITH queries AS (
        SELECT websearch_to_tsquery('simple', $3) AS strict_query,
               websearch_to_tsquery('simple', $5) AS loose_query
      )
      SELECT id, content, type, metadata, created_at,
             GREATEST(
               ts_rank(search_vector, queries.strict_query),
               ts_rank(search_vector, queries.loose_query)
             ) AS rank
      FROM long_term_memories
      CROSS JOIN queries
      WHERE tenant_id = $1
        AND user_id = $2
        ${typeClause}
        AND (
          search_vector @@ queries.strict_query
          OR search_vector @@ queries.loose_query
        )
      ORDER BY rank DESC
      LIMIT $4
    `;
    const result = await this.db.query<DbMemoryRow>(sql, [
      input.tenantId,
      input.userId,
      input.query,
      this.pool(input.limit),
      disjunctiveQuery,
    ]);
    return result.rows;
  }

  private async denseRows(input: {
    tenantId: string;
    userId: string;
    limit: number;
    profileOnly: boolean;
  }, vector: readonly number[]): Promise<DbMemoryRow[]> {
    const literal = toPgVectorLiteral(vector);
    const typeClause = input.profileOnly ? `AND type IN ('user_profile', 'preference')` : '';
    const sql = `
      SELECT id, content, type, metadata, created_at
      FROM long_term_memories
      WHERE tenant_id = $1
        AND user_id = $2
        AND embedding IS NOT NULL
        ${typeClause}
      ORDER BY embedding <=> $3::vector ASC
      LIMIT $4
    `;
    const params = [input.tenantId, input.userId, literal, this.pool(input.limit)];
    // set_config is VOLATILE, so the CTE runs before the scan. is_local keeps the
    // setting on this statement. One round trip instead of a transaction plus a query.
    const wrapped = `
      WITH scan AS (
        SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true) AS applied
      )
      ${sql.replace('FROM long_term_memories', 'FROM long_term_memories, scan')}
    `;
    const result = await this.db.query<DbMemoryRow>(wrapped, params);
    return result.rows;
  }

  async getSessionTimeline(input: {
    tenant_id: TenantId;
    session_id: SessionId;
  }): Promise<SessionMessage[]> {
     // This is usually for retrieving "All messages in session"
     // We can query 'messages' table directly.
     const sql = `
       SELECT * FROM messages 
       WHERE conversation_id = $1 OR (metadata->>'session_id')::text = $1
       ORDER BY created_at ASC
     `;
     // Mappers needed.
     // For minimal MVP, return empty or implement mapping.
     // SessionMemoryStore already maps messages.
     return [];
  }
}
