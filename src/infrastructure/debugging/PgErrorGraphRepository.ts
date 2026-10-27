/**
 * PgErrorGraphRepository — PostgreSQL + pgvector implementation of IErrorGraphRepository.
 *
 * Stores error graph nodes, AST patterns, and fixes in PostgreSQL tables.
 * Uses pgvector for semantic similarity search on error embeddings.
 *
 * Tables:
 *   error_graph_errors    — ErrorGraphNode rows (id PK, embedding vector(1536))
 *   error_graph_patterns  — ASTPatternNode rows
 *   error_graph_fixes     — FixNode rows
 *
 * @layer Infrastructure
 * @implements IErrorGraphRepository (Domain port)
 * @see src/domain/debugging/IErrorGraphRepository.ts
 * @see PLANS/06_BLUEPRINTS/ERROR_DEBUGGING_EVOLUTION_SOTA_2026.md §6
 */

import type { CorrelationId } from '@/ai-types';
import type { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import { requirePublicTables, runtimeDdlEnabled } from '../database/runtime-ddl';
import type {
  IErrorGraphRepository,
  ErrorGraphNode,
  ASTPatternNode,
  FixNode,
  ErrorContextQuery,
  ErrorContextResult,
  ErrorCategory,
  ErrorSeverity,
  ErrorStatus,
} from '../../domain/debugging/IErrorGraphRepository';

// ── Logger (subset of IStructuredLogger) ──────────────────────────

interface ILogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ── Constants ─────────────────────────────────────────────────────

/** HNSW index DDL for pgvector cosine similarity (SOTA 2026, m=16, ef_construction=64). */
const HNSW_INDEX_DDL_EMBEDDING = `
  CREATE INDEX IF NOT EXISTS idx_error_graph_embedding_hnsw
  ON error_graph_errors
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
`;

/** HNSW index DDL for AST structural embedding (Multi-Vector SOTA 2026). */
const HNSW_INDEX_DDL_AST = `
  CREATE INDEX IF NOT EXISTS idx_error_graph_ast_embedding_hnsw
  ON error_graph_errors
  USING hnsw (ast_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
`;

/** HNSW index DDL for temporal lifecycle embedding (Multi-Vector SOTA 2026). */
const HNSW_INDEX_DDL_TEMPORAL = `
  CREATE INDEX IF NOT EXISTS idx_error_graph_temporal_embedding_hnsw
  ON error_graph_errors
  USING hnsw (temporal_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
`;

/**
 * Blending factor for hybrid scoring: alpha * semantic + (1-alpha) * severity.
 * 0.6 = semantic distance dominates but severity still matters.
 */
const SEMANTIC_BLEND_ALPHA = 0.6;

/**
 * Ensemble weights for multi-vector scoring (SOTA 2026: Multi-Vector AST Embeddings).
 * semantic(0.5) + structural(0.3) + temporal(0.2) = 1.0
 */
const ENSEMBLE_WEIGHT_SEMANTIC = 0.5;
const ENSEMBLE_WEIGHT_AST = 0.3;
const ENSEMBLE_WEIGHT_TEMPORAL = 0.2;

// ── Row Types ─────────────────────────────────────────────────────

interface ErrorRow {
  id: string;
  summary: string;
  affected_files: string[];
  root_cause: string;
  rule: string;
  test_trap: string | null;
  category: string;
  severity: string;
  status: string;
  discovered_at: string;
  fixed_at: string | null;
  verification: string | null;
  embedding: string | null;
  ast_embedding: string | null;
  temporal_embedding: string | null;
  recurrence_count: number;
}

interface PatternRow {
  id: string;
  pattern: string;
  description: string;
  error_ids: string[];
}

interface FixRow {
  id: string;
  error_id: string;
  description: string;
  ast_patch: string | null;
}

// ── Implementation ────────────────────────────────────────────────

export class PgErrorGraphRepository implements IErrorGraphRepository {
  private schemaInitialized = false;

  constructor(
    private readonly db: IDatabaseConnection,
    private readonly logger?: ILogger,
  ) {}

  /**
   * Ensure HNSW indices exist for all 3 vector spaces. Call once at startup.
   * Safe to call multiple times (IF NOT EXISTS).
   */
  async ensureHnswIndex(): Promise<void> {
    await this.ensureSchema();
    if (!runtimeDdlEnabled()) return;
    const indices = [
      { name: 'embedding', ddl: HNSW_INDEX_DDL_EMBEDDING },
      { name: 'ast_embedding', ddl: HNSW_INDEX_DDL_AST },
      { name: 'temporal_embedding', ddl: HNSW_INDEX_DDL_TEMPORAL },
    ];

    for (const { name, ddl } of indices) {
      try {
        await this.db.query(ddl);
        this.logger?.info(`HNSW index ensured on error_graph_errors.${name}`);
      } catch (err) {
        this.logger?.warn(`HNSW index creation skipped for ${name} (pgvector may not be installed)`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── Ingest Methods ────────────────────────────────────────────

  async ingestError(node: ErrorGraphNode, correlationId: CorrelationId): Promise<void> {
    await this.ensureSchema();

    const embeddingValue = node.embedding
      ? `[${node.embedding.join(',')}]`
      : null;
    const astEmbeddingValue = node.astEmbedding
      ? `[${node.astEmbedding.join(',')}]`
      : null;
    const temporalEmbeddingValue = node.temporalEmbedding
      ? `[${node.temporalEmbedding.join(',')}]`
      : null;

    await this.db.query(
      `INSERT INTO error_graph_errors
        (id, summary, affected_files, root_cause, rule, test_trap,
         category, severity, status, discovered_at, fixed_at, verification,
         embedding, ast_embedding, temporal_embedding, recurrence_count)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               $13::vector, $14::vector, $15::vector, $16)
       ON CONFLICT (id) DO UPDATE SET
         summary = EXCLUDED.summary,
         affected_files = EXCLUDED.affected_files,
         root_cause = EXCLUDED.root_cause,
         rule = EXCLUDED.rule,
         test_trap = EXCLUDED.test_trap,
         category = EXCLUDED.category,
         severity = EXCLUDED.severity,
         status = EXCLUDED.status,
         discovered_at = EXCLUDED.discovered_at,
         fixed_at = EXCLUDED.fixed_at,
         verification = EXCLUDED.verification,
         embedding = EXCLUDED.embedding,
         ast_embedding = EXCLUDED.ast_embedding,
         temporal_embedding = EXCLUDED.temporal_embedding,
         recurrence_count = EXCLUDED.recurrence_count`,
      [
        node.id,
        node.summary,
        node.affectedFiles,
        node.rootCause,
        node.rule,
        node.testTrap ?? null,
        node.category,
        node.severity,
        node.status,
        node.discoveredAt,
        node.fixedAt ?? null,
        node.verification ?? null,
        embeddingValue,
        astEmbeddingValue,
        temporalEmbeddingValue,
        node.recurrenceCount ?? 0,
      ],
    );

    this.logger?.info('Ingested error node', { errorId: node.id, correlationId });
  }

  async ingestPattern(pattern: ASTPatternNode, correlationId: CorrelationId): Promise<void> {
    await this.ensureSchema();

    await this.db.query(
      `INSERT INTO error_graph_patterns (id, pattern, description, error_ids)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         pattern = EXCLUDED.pattern,
         description = EXCLUDED.description,
         error_ids = EXCLUDED.error_ids`,
      [pattern.id, pattern.pattern, pattern.description, pattern.errorIds],
    );

    this.logger?.info('Ingested AST pattern', { patternId: pattern.id, correlationId });
  }

  async ingestFix(fix: FixNode, correlationId: CorrelationId): Promise<void> {
    await this.ensureSchema();

    await this.db.query(
      `INSERT INTO error_graph_fixes (id, error_id, description, ast_patch)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         error_id = EXCLUDED.error_id,
         description = EXCLUDED.description,
         ast_patch = EXCLUDED.ast_patch`,
      [fix.id, fix.errorId, fix.description, fix.astPatch ?? null],
    );

    this.logger?.info('Ingested fix', { fixId: fix.id, errorId: fix.errorId, correlationId });
  }

  // ── Query Methods ─────────────────────────────────────────────

  async queryByContext(
    query: ErrorContextQuery,
    correlationId: CorrelationId,
  ): Promise<ErrorContextResult> {
    await this.ensureSchema();

    const limit = query.limit ?? 5;
    const conditions: string[] = ['$1 = ANY(e.affected_files)'];
    const params: unknown[] = [query.filePath];
    let paramIdx = 2;

    if (query.categories && query.categories.length > 0) {
      conditions.push(`e.category = ANY($${paramIdx})`);
      params.push(query.categories);
      paramIdx++;
    }

    if (query.statuses && query.statuses.length > 0) {
      conditions.push(`e.status = ANY($${paramIdx})`);
      params.push(query.statuses);
      paramIdx++;
    }

    // Hybrid scoring: cosine distance (semantic) + severity weight
    // If embedding parameter provided, use HNSW-accelerated cosine distance
    // SOTA 2026: Multi-vector ensemble search across 3 vector spaces
    const hasEmbedding = query.embedding && query.embedding.length > 0;
    const hasAstEmbedding = query.astEmbedding && query.astEmbedding.length > 0;
    const hasTemporalEmbedding = query.temporalEmbedding && query.temporalEmbedding.length > 0;
    const hasAnyVector = hasEmbedding || hasAstEmbedding || hasTemporalEmbedding;
    let orderClause: string;

    if (hasAnyVector) {
      // SOTA 2026: Ensemble Multi-Vector Ranking
      // Combined score = w_sem * cosine(embedding) + w_ast * cosine(ast) + w_temp * cosine(temporal)
      // Blended with severity: alpha * vector_score + (1-alpha) * severity_rank
      const vectorTerms: string[] = [];
      let totalWeight = 0;
      const semanticEmbedding = query.embedding;
      const structuralEmbedding = query.astEmbedding;
      const temporalEmbedding = query.temporalEmbedding;

      if (semanticEmbedding) {
        params.push(`[${semanticEmbedding.join(',')}]`);
        vectorTerms.push(`${ENSEMBLE_WEIGHT_SEMANTIC} * (e.embedding <=> $${paramIdx}::vector)`);
        totalWeight += ENSEMBLE_WEIGHT_SEMANTIC;
        paramIdx++;
      }

      if (structuralEmbedding) {
        params.push(`[${structuralEmbedding.join(',')}]`);
        vectorTerms.push(`${ENSEMBLE_WEIGHT_AST} * (e.ast_embedding <=> $${paramIdx}::vector)`);
        totalWeight += ENSEMBLE_WEIGHT_AST;
        paramIdx++;
      }

      if (temporalEmbedding) {
        params.push(`[${temporalEmbedding.join(',')}]`);
        vectorTerms.push(`${ENSEMBLE_WEIGHT_TEMPORAL} * (e.temporal_embedding <=> $${paramIdx}::vector)`);
        totalWeight += ENSEMBLE_WEIGHT_TEMPORAL;
        paramIdx++;
      }

      // Normalize weights when not all vectors are present
      const normalizedVectorExpr = totalWeight > 0
        ? `(${vectorTerms.join(' + ')}) / ${totalWeight}`
        : '0';

      orderClause = `
        ORDER BY
          (
            ${SEMANTIC_BLEND_ALPHA} * ${normalizedVectorExpr} +
            ${1 - SEMANTIC_BLEND_ALPHA} * (
              CASE e.severity
                WHEN 'CRITICAL' THEN 0.0
                WHEN 'HIGH' THEN 0.25
                WHEN 'MEDIUM' THEN 0.5
                WHEN 'LOW' THEN 0.75
              END
            )
          ) ASC`;
    } else {
      // Fallback: severity-based ordering (no embedding available)
      orderClause = `
        ORDER BY
          CASE e.severity
            WHEN 'CRITICAL' THEN 0
            WHEN 'HIGH' THEN 1
            WHEN 'MEDIUM' THEN 2
            WHEN 'LOW' THEN 3
          END,
          e.discovered_at DESC`;
    }

    const whereClause = conditions.join(' AND ');
    params.push(limit);

    const errorsResult = await this.db.query<ErrorRow>(
      `SELECT * FROM error_graph_errors e
       WHERE ${whereClause}
       ${orderClause}
       LIMIT $${paramIdx}`,
      params,
    );

    const errors = errorsResult.rows.map((r) => this.rowToErrorNode(r));
    const errorIds = errors.map((e) => e.id);

    // Fetch related patterns
    const patternsResult = errorIds.length > 0
      ? await this.db.query<PatternRow>(
          `SELECT * FROM error_graph_patterns WHERE error_ids && $1`,
          [errorIds],
        )
      : { rows: [] };

    const patterns = patternsResult.rows.map((r) => this.rowToPattern(r));

    // Fetch related fixes
    const fixesResult = errorIds.length > 0
      ? await this.db.query<FixRow>(
          `SELECT * FROM error_graph_fixes WHERE error_id = ANY($1)`,
          [errorIds],
        )
      : { rows: [] };

    const fixes = fixesResult.rows.map((r) => this.rowToFix(r));

    // Simple relevance scoring: severity-based, or cosine-derived when embedding present
    const scores = errors.map((e) => this.severityScore(e.severity));

    this.logger?.info('queryByContext', {
      filePath: query.filePath,
      resultsCount: errors.length,
      usedSemanticSearch: !!hasAnyVector,
      vectorsUsed: [
        hasEmbedding ? 'semantic' : null,
        hasAstEmbedding ? 'ast' : null,
        hasTemporalEmbedding ? 'temporal' : null,
      ].filter(Boolean),
      correlationId,
    });

    return { errors, patterns, fixes, scores };
  }

  async getById(errorId: string): Promise<ErrorGraphNode | null> {
    await this.ensureSchema();

    const row = await this.db.queryOne<ErrorRow>(
      'SELECT * FROM error_graph_errors WHERE id = $1',
      [errorId],
    );
    return row ? this.rowToErrorNode(row) : null;
  }

  async getByFile(filePath: string): Promise<readonly ErrorGraphNode[]> {
    await this.ensureSchema();

    const result = await this.db.query<ErrorRow>(
      'SELECT * FROM error_graph_errors WHERE $1 = ANY(affected_files) ORDER BY discovered_at DESC',
      [filePath],
    );
    return result.rows.map((r) => this.rowToErrorNode(r));
  }

  async getStats(): Promise<Record<ErrorStatus, number>> {
    await this.ensureSchema();

    const result = await this.db.query<{ status: string; count: string }>(
      'SELECT status, COUNT(*) as count FROM error_graph_errors GROUP BY status',
    );

    const stats: Record<ErrorStatus, number> = {
      OPEN: 0,
      FIXED: 0,
      WONT_FIX: 0,
      MONITORING: 0,
    };

    for (const row of result.rows) {
      const status = row.status as ErrorStatus;
      if (status in stats) {
        stats[status] = parseInt(row.count, 10);
      }
    }

    return stats;
  }

  // ── Private Helpers ───────────────────────────────────────────

  private async ensureSchema(): Promise<void> {
    if (this.schemaInitialized) {
      return;
    }

    if (!runtimeDdlEnabled()) {
      await requirePublicTables(this.db, ['error_graph_errors', 'error_graph_patterns', 'error_graph_fixes']);
      this.schemaInitialized = true;
      return;
    }

    await this.db.execute('CREATE EXTENSION IF NOT EXISTS vector');
    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS error_graph_errors (
         id TEXT PRIMARY KEY,
         summary TEXT NOT NULL,
         affected_files TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
         root_cause TEXT NOT NULL,
         rule TEXT NOT NULL,
         test_trap TEXT NULL,
         category TEXT NOT NULL,
         severity TEXT NOT NULL,
         status TEXT NOT NULL,
         discovered_at TIMESTAMPTZ NOT NULL,
         fixed_at TIMESTAMPTZ NULL,
         verification TEXT NULL,
         embedding vector(1536) NULL,
         ast_embedding vector(1536) NULL,
         temporal_embedding vector(1536) NULL,
         recurrence_count INTEGER NOT NULL DEFAULT 0
       )`,
    );
    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS error_graph_patterns (
         id TEXT PRIMARY KEY,
         pattern TEXT NOT NULL,
         description TEXT NOT NULL,
         error_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]
       )`,
    );
    await this.db.execute(
      `CREATE TABLE IF NOT EXISTS error_graph_fixes (
         id TEXT PRIMARY KEY,
         error_id TEXT NOT NULL,
         description TEXT NOT NULL,
         ast_patch TEXT NULL
       )`,
    );

    this.schemaInitialized = true;
  }

  private rowToErrorNode(row: ErrorRow): ErrorGraphNode {
    return {
      id: row.id,
      summary: row.summary,
      affectedFiles: row.affected_files,
      rootCause: row.root_cause,
      rule: row.rule,
      testTrap: row.test_trap ?? undefined,
      category: row.category as ErrorCategory,
      severity: row.severity as ErrorSeverity,
      status: row.status as ErrorStatus,
      discoveredAt: row.discovered_at,
      fixedAt: row.fixed_at ?? undefined,
      verification: row.verification ?? undefined,
      embedding: row.embedding ? this.parseEmbedding(row.embedding) : undefined,
      astEmbedding: row.ast_embedding ? this.parseEmbedding(row.ast_embedding) : undefined,
      temporalEmbedding: row.temporal_embedding ? this.parseEmbedding(row.temporal_embedding) : undefined,
      recurrenceCount: row.recurrence_count ?? 0,
    };
  }

  private rowToPattern(row: PatternRow): ASTPatternNode {
    return {
      id: row.id,
      pattern: row.pattern,
      description: row.description,
      errorIds: row.error_ids,
    };
  }

  private rowToFix(row: FixRow): FixNode {
    return {
      id: row.id,
      errorId: row.error_id,
      description: row.description,
      astPatch: row.ast_patch ?? undefined,
    };
  }

  private parseEmbedding(raw: string): readonly number[] {
    try {
      const cleaned = raw.replace(/^\[|\]$/g, '');
      return cleaned.split(',').map(Number);
    } catch {
      return [];
    }
  }

  private severityScore(severity: ErrorSeverity): number {
    switch (severity) {
      case 'CRITICAL': return 1.0;
      case 'HIGH': return 0.8;
      case 'MEDIUM': return 0.5;
      case 'LOW': return 0.3;
    }
  }
}
