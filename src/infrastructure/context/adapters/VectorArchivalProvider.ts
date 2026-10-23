/**
 * VectorArchivalProvider — pgvector-based Tier 3 archival search for S-MMU.
 *
 * Implements IArchivalMemory using PostgreSQL pgvector extension for
 * cosine similarity search over documentation embeddings.
 *
 * Features:
 * - HNSW index for O(log n) approximate nearest neighbor search
 * - Configurable embedding adapter (OpenAI or local fallback)
 * - Output includes source, score, and token count for budget management
 * - Graceful degradation when pgvector table doesn't exist
 *
 * @layer Infrastructure (Context / Adapters)
 * @since v2.9.0 — Phase 2 (V3 Context Engineering)
 * @see PLANS/DOCS_AUDIT_2026/PHASE_2_DENSE_EMBEDDINGS.md
 */

import type { IArchivalMemory, ArchivalMemoryStatus } from '../../../domain/memory/IArchivalMemory';
import type { IDatabaseConnection } from '../../../domain/persistence/IDatabaseConnection';
import type { IEmbeddingAdapter } from '../embedding/IEmbeddingAdapter';
import type { ILogger } from '../../../core/decorators/ILogger';

/**
 * Row shape returned from the doc_embeddings HNSW search query.
 */
interface EmbeddingSearchRow {
  content: string;
  source: string;
  tokens: number;
  updated_at: string;
  score: number;
}

export class VectorArchivalProvider implements IArchivalMemory {
  private readonly db: IDatabaseConnection;
  private readonly embedder: IEmbeddingAdapter;
  private readonly logger?: ILogger;
  private tableExists: boolean | null = null;

  constructor(
    db: IDatabaseConnection,
    embedder: IEmbeddingAdapter,
    logger?: ILogger,
  ) {
    this.db = db;
    this.embedder = embedder;
    this.logger = logger;
  }

  /**
   * Search documentation embeddings by cosine similarity.
   *
   * Embeds the query, then queries pgvector with `<=>` (cosine distance)
   * operator and HNSW index for fast approximate results.
   *
   * @param query - Search query text
   * @param maxResults - Maximum results to return
   * @param _tenantId - Not used yet (multi-tenant planned)
   * @returns Ranked search results with cosine similarity scores
   */
  async search(
    query: string,
    maxResults: number,
    _tenantId?: string,
  ): Promise<ReadonlyArray<{
    content: string;
    source: string;
    score: number;
    tokens: number;
    updatedAt: string;
  }>> {
    // Check if table exists (cached after first check)
    if (!(await this.ensureTableExists())) {
      return [];
    }

    try {
      // Embed the search query
      const [embedding] = await this.embedder.embed([query]);
      if (!embedding || embedding.length === 0) {
        this.logger?.warn('VectorArchivalProvider: embedding returned empty vector for query');
        return [];
      }

      const vectorStr = `[${embedding.join(',')}]`;

      const result = await this.db.query<EmbeddingSearchRow>(
        `SELECT content, source, tokens, updated_at,
                1 - (embedding <=> $1::vector) AS score
         FROM doc_embeddings
         ORDER BY embedding <=> $1::vector
         LIMIT $2`,
        [vectorStr, maxResults],
      );

      return result.rows.map(r => ({
        content: r.content,
        source: r.source,
        score: r.score,
        tokens: r.tokens,
        updatedAt: r.updated_at,
      }));
    } catch (err) {
      this.logger?.error('VectorArchivalProvider.search failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Get the count of indexed documentation chunks.
   */
  async getItemCount(): Promise<number> {
    if (!(await this.ensureTableExists())) return 0;

    try {
      const result = await this.db.queryScalar<number>(
        'SELECT COUNT(*)::int FROM doc_embeddings',
      );
      return result ?? 0;
    } catch (err) {
      this.logger?.error('VectorArchivalProvider.getItemCount failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    }
  }

  async getStatus(): Promise<ArchivalMemoryStatus> {
    const available = await this.ensureTableExists();
    if (!available) {
      return {
        available: false,
        itemCount: 0,
      };
    }

    return {
      available: true,
      itemCount: await this.getItemCount(),
    };
  }

  /**
   * Check if the doc_embeddings table exists (cached).
   * Returns false if pgvector is not installed — graceful degradation.
   */
  private async ensureTableExists(): Promise<boolean> {
    if (this.tableExists !== null) return this.tableExists;

    try {
      const result = await this.db.queryScalar<boolean>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.tables
           WHERE table_name = 'doc_embeddings'
         )`,
      );
      this.tableExists = result === true;
      if (!this.tableExists) {
        this.logger?.warn('VectorArchivalProvider: doc_embeddings table not found. Run migration to enable Tier 3.');
      }
      return this.tableExists;
    } catch (err) {
      this.logger?.warn('VectorArchivalProvider: table check failed, disabling Tier 3', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.tableExists = false;
      return false;
    }
  }
}
