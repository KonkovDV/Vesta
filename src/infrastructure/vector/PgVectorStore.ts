/**
 * PgVectorStore - инфраструктурная реализация IVectorStore поверх PostgreSQL/pgvector.
 *
 * Layer: Infrastructure
 *
 * Цели:
 * - предоставить узкий, стабильный адаптер для MEM-NEXT retrieval без протечки деталей драйвера;
 * - опираться на существующий IDatabaseConnection / PostgresAdapter и AsyncLocalStorage;
 * - добавить минимальное observability-покрытие (метрики + структурированный лог).
 */

import type {
  IDatabaseConnection,
  QueryResult,
} from '../../domain/persistence/IDatabaseConnection';
import type {
  IVectorStore,
  VectorDocument,
  VectorSearchQuery,
  VectorSearchResult,
} from '../../domain/memory/IVectorStore';
import { qualifyIdentifier, validateAndQuoteIdentifier } from '../database/postgres-identifiers';
import { logger } from '../logging/logger';
import { getOrCreateCounter, getOrCreateHistogram } from '../../monitoring';

function textField(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const LONG_TERM_COLUMN_FIELDS = new Set(['tenantId', 'tenant_id', 'userId', 'user_id', 'content', 'type']);

/** These values have their own columns in long_term_memories and stay out of the JSONB copy. */
function withoutColumnFields(metadata: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !LONG_TERM_COLUMN_FIELDS.has(key)),
  );
}

type PgVectorStoreOperation = 'upsert' | 'search' | 'delete';
type PgVectorStoreOutcome = 'success' | 'error';

const pgVectorRequestsTotal = getOrCreateCounter(
  'memory_pgvector_requests_total',
  'Total PgVectorStore operations by type and outcome',
  ['operation', 'outcome'],
);

const pgVectorRequestDurationSeconds = getOrCreateHistogram(
  'memory_pgvector_request_duration_seconds',
  'Duration of PgVectorStore operations in seconds',
  ['operation', 'outcome'],
);

export interface PgVectorStoreConfig {
  schema?: string;
  /**
   * `memory_vectors` is the legacy vector table. Memory rows are written to
   * `long_term_memories`. Pass that name so upsert and search use one table.
   */
  table?: string;
  idColumn?: string;
  embeddingColumn?: string;
  metadataColumn?: string;
  namespaceColumn?: string;
  /**
   * Lower bound for `hnsw.ef_search` in tenant-filtered search; the session uses max(topK, efSearch).
   * 40 reached recall@10 = 1.0 on the memory-scale bench (10 tenants × 1000 rows, 1536 dims).
   */
  efSearch?: number;
}

const DEFAULT_EF_SEARCH = 40;

interface VectorRow {
  id: string;
  namespace: string | null;
  metadata: Record<string, unknown> | null;
  distance: number;
}

/**
 * PgVectorStore реализует доменный контракт IVectorStore через SQL/pgvector.
 *
 * Важно:
 * - использует только IDatabaseConnection (без прямой работы с Pool/PoolClient);
 * - в транзакциях повторно использует активный клиент через PostgresAdapter.getActivePgClient();
 * - не создает собственный пул и не ломает UoW-инварианты.
 */
export class PgVectorStore implements IVectorStore {
  private readonly log = logger.child({ component: 'PgVectorStore' });

  private readonly qualifiedTable: string;
  private readonly idColumn: string;
  private readonly embeddingColumn: string;
  private readonly metadataColumn: string;
  private readonly namespaceColumn: string;
  /** Legacy `memory_vectors` shape. `long_term_memories` is the memory table. */
  private readonly usesLongTermMemories: boolean;
  private readonly minEfSearch: number;

  constructor(
    private readonly db: IDatabaseConnection,
    config: PgVectorStoreConfig = {},
  ) {
    const schema = config.schema ?? 'public';
    const table = config.table ?? 'memory_vectors';
    this.usesLongTermMemories = table === 'long_term_memories';
    const efSearch = config.efSearch ?? DEFAULT_EF_SEARCH;
    if (!Number.isInteger(efSearch) || efSearch < 1 || efSearch > 1000) {
      throw new Error('PgVectorStore.efSearch must be an integer from 1 to 1000');
    }
    this.minEfSearch = efSearch;

    this.qualifiedTable = qualifyIdentifier(schema, table, 'PgVectorStore.table');

    this.idColumn = validateAndQuoteIdentifier(
      config.idColumn ?? 'id',
      'PgVectorStore.idColumn',
    );
    this.embeddingColumn = validateAndQuoteIdentifier(
      config.embeddingColumn ?? 'embedding',
      'PgVectorStore.embeddingColumn',
    );
    this.metadataColumn = validateAndQuoteIdentifier(
      config.metadataColumn ?? 'metadata',
      'PgVectorStore.metadataColumn',
    );
    this.namespaceColumn = validateAndQuoteIdentifier(
      config.namespaceColumn ?? 'namespace',
      'PgVectorStore.namespaceColumn',
    );
  }

  /**
   * Идемпотентный upsert набора документов в таблицу pgvector.
   *
   * Legacy `memory_vectors` conflicts on (id, namespace). `long_term_memories` conflicts on id.
   */
  async upsertEmbeddings(documents: VectorDocument[]): Promise<void> {
    if (!documents.length) {
      return;
    }

    const started = process.hrtime.bigint();
    const operation: PgVectorStoreOperation = 'upsert';

    try {
      const values: unknown[] = [];
      const tuples: string[] = [];
      const sql = this.usesLongTermMemories
        ? this.longTermUpsertSql(documents, tuples, values)
        : this.legacyUpsertSql(documents, tuples, values);

      await this.db.execute(sql, values);
      this.observe(operation, 'success', started);
    } catch (error) {
      this.log.warn('PgVectorStore upsertEmbeddings failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.observe(operation, 'error', started);
      throw error;
    }
  }

  /**
   * Логическое удаление документов по id в рамках namespace.
   */
  async deleteByIds(ids: string[], namespace?: string): Promise<void> {
    if (!ids.length) {
      return;
    }

    const started = process.hrtime.bigint();
    const operation: PgVectorStoreOperation = 'delete';

    try {
      const whereNamespace = !this.usesLongTermMemories && namespace
        ? `AND ${this.namespaceColumn} = $2::text`
        : this.usesLongTermMemories && namespace
          ? `AND tenant_id = $2::text`
          : '';

      const sql = `
        DELETE FROM ${this.qualifiedTable}
        WHERE ${this.idColumn}${this.usesLongTermMemories ? '::text' : ''} = ANY($1::text[])
        ${whereNamespace}
      `;

      const params: unknown[] = [ids];
      if (namespace) {
        params.push(namespace);
      }

      await this.db.execute(sql, params);
      this.observe(operation, 'success', started);
    } catch (error) {
      this.log.warn('PgVectorStore deleteByIds failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.observe(operation, 'error', started);
      throw error;
    }
  }

  /**
   * Векторный поиск по pgvector с сортировкой по embedding <=> queryEmbedding.
   * Оператор обязан совпадать с классом индекса: в миграциях это `vector_cosine_ops`,
   * а `<->` при таком индексе даёт полный перебор таблицы.
   *
   * Возвращает score в виде 1 / (1 + distance), чтобы сохранить монотонность без
   * жёсткой привязки к конкретной метрике pgvector.
   */
  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    if (this.usesLongTermMemories && !query.namespace) {
      // long_term_memories holds every tenant: a search without a tenant returns nothing.
      return [];
    }

    if (!this.usesLongTermMemories) {
      return this.searchWithinSession(query);
    }

    if (typeof this.db.transaction !== 'function') {
      throw new Error(
        'PgVectorStore: filtered HNSW search needs IDatabaseConnection.transaction',
      );
    }

    return this.db.transaction(() => this.searchWithinSession(query));
  }

  private hnswEfSearch(topK: number): number {
    const value = Math.ceil(Number(topK));
    if (!Number.isInteger(value) || value < 1 || value > 10000) {
      throw new Error('PgVectorStore: topK must be a positive integer up to 10000');
    }
    // pgvector rejects ef_search above 1000; iterative scan keeps filling the page past it.
    return Math.min(1000, Math.max(value, this.minEfSearch));
  }

  /** `hnsw.ef_search` stays at least max(topK, efSearch) so a tenant filter can still fill the page. */
  private async applyFilteredHnswSession(topK: number): Promise<void> {
    const efSearch = this.hnswEfSearch(topK);
    await this.db.execute(`SELECT set_config('hnsw.iterative_scan', 'relaxed_order', true)`);
    await this.db.execute(`SELECT set_config('hnsw.ef_search', $1, true)`, [String(efSearch)]);
  }

  private async searchWithinSession(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    const started = process.hrtime.bigint();
    const operation: PgVectorStoreOperation = 'search';

    try {
      const vectorLiteral = this.toVectorLiteral(query.queryEmbedding);
      const { userId, types, metadataFilters } = this.splitFilters(query.filters);

      const params: unknown[] = [];
      params.push(query.namespace ?? null); // $1
      params.push(
        metadataFilters && Object.keys(metadataFilters).length > 0
          ? metadataFilters
          : null,
      ); // $2
      params.push(vectorLiteral); // $3
      params.push(query.topK); // $4
      if (this.usesLongTermMemories) {
        params.push(userId ?? null); // $5
        params.push(types ?? null); // $6
        await this.applyFilteredHnswSession(query.topK);
      }

      const sql = this.usesLongTermMemories
        ? `
        SELECT
          ${this.idColumn}::text AS id,
          NULL::text AS namespace,
          COALESCE(${this.metadataColumn}, '{}'::jsonb) || jsonb_build_object('content', content) AS metadata,
          ${this.embeddingColumn} <=> $3::vector AS distance
        FROM ${this.qualifiedTable}
        WHERE
          ${this.embeddingColumn} IS NOT NULL
          AND tenant_id = $1::text
          AND ($5::text IS NULL OR user_id = $5::text)
          AND ($6::text[] IS NULL OR type = ANY($6::text[]))
          AND (
            $2::jsonb IS NULL
            OR ${this.metadataColumn} @> $2::jsonb
          )
        ORDER BY distance ASC
        LIMIT $4
      `
        : `
        SELECT
          ${this.idColumn} AS id,
          ${this.namespaceColumn} AS namespace,
          ${this.metadataColumn} AS metadata,
          ${this.embeddingColumn} <=> $3::vector AS distance
        FROM ${this.qualifiedTable}
        WHERE
          ($1::text IS NULL OR ${this.namespaceColumn} = $1::text)
          AND (
            $2::jsonb IS NULL
            OR ${this.metadataColumn} @> $2::jsonb
          )
        ORDER BY distance ASC
        LIMIT $4
      `;

      const result: QueryResult<VectorRow> = await this.db.query<VectorRow>(
        sql,
        params,
      );

      const mapped: VectorSearchResult[] = result.rows.map((row) => {
        const distance = typeof row.distance === 'number' ? row.distance : 0;
        const score = Number.isFinite(distance) ? 1 / (1 + distance) : 0;

        return {
          id: row.id,
          score,
          metadata: row.metadata ?? undefined,
          namespace: row.namespace ?? undefined,
        };
      });

      this.observe(operation, 'success', started);
      return mapped;
    } catch (error) {
      this.log.warn('PgVectorStore search failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.observe(operation, 'error', started);
      throw error;
    }
  }

  /**
   * In long_term_memories mode `filters.userId` maps to the `user_id` column and
   * `filters.types` (string[]) to the `type` column.
   * Every other key stays a JSONB containment filter on metadata. A `userId` or `types`
   * of another shape stays a containment filter too, so it narrows the result instead
   * of silently widening it to every user of the tenant.
   */
  private splitFilters(filters: VectorSearchQuery['filters']): {
    userId?: string;
    types?: string[];
    metadataFilters?: Record<string, unknown>;
  } {
    if (!filters || !this.usesLongTermMemories) {
      return { metadataFilters: filters };
    }
    const { userId, types, ...rest } = filters;
    const metadataFilters: Record<string, unknown> = { ...rest };
    const split: { userId?: string; types?: string[] } = {};

    if (typeof userId === 'string' && userId.length > 0) {
      split.userId = userId;
    } else if (userId !== undefined) {
      metadataFilters.userId = userId;
    }

    if (Array.isArray(types)) {
      const typeList = types.filter((type): type is string => typeof type === 'string' && type.length > 0);
      if (typeList.length > 0) {
        split.types = typeList;
      }
    } else if (types !== undefined) {
      metadataFilters.types = types;
    }

    return { ...split, metadataFilters };
  }

  /**
   * Legacy `memory_vectors` upsert. Kept for callers that still pass that table.
   */
  private legacyUpsertSql(
    documents: VectorDocument[],
    tuples: string[],
    values: unknown[],
  ): string {
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      const offset = i * 4;
      tuples.push(`($${offset + 1}, $${offset + 2}::vector, $${offset + 3}::jsonb, $${offset + 4}::text)`);
      values.push(doc.id);
      values.push(this.toVectorLiteral(doc.embedding));
      values.push(doc.metadata ?? {});
      values.push(doc.namespace ?? '');
    }

    return `
        INSERT INTO ${this.qualifiedTable} (
          ${this.idColumn},
          ${this.embeddingColumn},
          ${this.metadataColumn},
          ${this.namespaceColumn}
        )
        VALUES ${tuples.join(', ')}
        ON CONFLICT (${this.idColumn}, ${this.namespaceColumn})
        DO UPDATE SET
          ${this.embeddingColumn} = EXCLUDED.${this.embeddingColumn},
          ${this.metadataColumn} = EXCLUDED.${this.metadataColumn}
      `;
  }

  /**
   * Write into `long_term_memories`, the same table search reads.
   * `metadata.tenantId`, `metadata.userId`, and `metadata.content` are required.
   * `namespace` is accepted as the tenant id when `tenantId` is absent.
   */
  private longTermUpsertSql(
    documents: VectorDocument[],
    tuples: string[],
    values: unknown[],
  ): string {
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      const meta = doc.metadata ?? {};
      const tenantId = textField(meta, 'tenantId') ?? textField(meta, 'tenant_id') ?? doc.namespace;
      const userId = textField(meta, 'userId') ?? textField(meta, 'user_id');
      const content = textField(meta, 'content');
      if (!tenantId || !userId || !content) {
        throw new Error(
          'PgVectorStore long_term_memories upsert requires metadata.tenantId, metadata.userId, and metadata.content',
        );
      }
      const offset = i * 7;
      tuples.push(
        `($${offset + 1}::uuid, $${offset + 2}, $${offset + 3}, $${offset + 4}, $${offset + 5}::vector, $${offset + 6}::jsonb, $${offset + 7})`,
      );
      values.push(
        doc.id,
        tenantId,
        userId,
        content,
        this.toVectorLiteral(doc.embedding),
        withoutColumnFields(meta),
        textField(meta, 'type') ?? 'general',
      );
    }

    return `
        INSERT INTO ${this.qualifiedTable} AS existing (
          ${this.idColumn},
          tenant_id,
          user_id,
          content,
          ${this.embeddingColumn},
          ${this.metadataColumn},
          type
        )
        VALUES ${tuples.join(', ')}
        ON CONFLICT (${this.idColumn})
        DO UPDATE SET
          ${this.embeddingColumn} = EXCLUDED.${this.embeddingColumn},
          ${this.metadataColumn} = COALESCE(existing.${this.metadataColumn}, '{}'::jsonb) || EXCLUDED.${this.metadataColumn},
          content = EXCLUDED.content
      `;
  }

  /**
   * Преобразует массив чисел в безопасный литерал pgvector, например: [0.1,0.2,0.3].
   */
  private toVectorLiteral(embedding: number[]): string {
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error('PgVectorStore: embedding must be a non-empty array');
    }

    const values = embedding.map((value) => {
      const num = Number(value);
      if (!Number.isFinite(num)) {
        throw new Error('PgVectorStore: embedding contains non-finite value');
      }
      return num;
    });

    return `[${values.join(',')}]`;
  }

  private observe(
    operation: PgVectorStoreOperation,
    outcome: PgVectorStoreOutcome,
    startedAt: bigint,
  ): void {
    try {
      const elapsedNs = process.hrtime.bigint() - startedAt;
      const durationSeconds = Number(elapsedNs) / 1e9;

      pgVectorRequestsTotal.labels({ operation, outcome }).inc();
      pgVectorRequestDurationSeconds
        .labels({ operation, outcome })
        .observe(durationSeconds);
    } catch {
      // metrics must never break business logic
    }
  }
}