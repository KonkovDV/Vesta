/**
 * SqliteVectorStore
 * Infrastructure implementation of IVectorStore using sqlite-vec extension.
 *
 * Layer: Infrastructure
 */
import Database = require('better-sqlite3');
import * as sqliteVec from 'sqlite-vec';
import { inject, injectable } from 'inversify';
import {
  IVectorStore,
  VectorDocument,
  VectorSearchQuery,
  VectorSearchResult,
} from '../../../domain/memory/IVectorStore';
import { ILogger } from '../../../core/decorators/ILogger';

interface SearchFilters {
  userId?: string;
  types?: string[];
  metadataFilters?: Record<string, unknown>;
}

/**
 * Same keys as PgVectorStore over long_term_memories: `userId` matches the stored
 * userId, `types` the stored type, everything else is a JSON containment filter.
 * A `userId` or `types` value of another shape stays a containment filter, so it
 * narrows the result instead of being dropped.
 */
function splitFilters(filters: VectorSearchQuery['filters']): SearchFilters {
  if (!filters) {
    return {};
  }
  const { userId, types, ...rest } = filters;
  const metadataFilters: Record<string, unknown> = { ...rest };
  const split: SearchFilters = {};

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

  if (Object.keys(metadataFilters).length > 0) {
    split.metadataFilters = metadataFilters;
  }
  return split;
}

/** Postgres `jsonb @>` for parsed JSON: objects by key, arrays by element. */
function jsonContains(value: unknown, pattern: unknown): boolean {
  if (Array.isArray(pattern)) {
    return Array.isArray(value) && pattern.every((item) => value.some((candidate) => jsonContains(candidate, item)));
  }
  if (pattern !== null && typeof pattern === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return false;
    }
    return Object.entries(pattern).every(([key, expected]) =>
      expected === undefined
      || (Object.prototype.hasOwnProperty.call(value, key)
        && jsonContains((value as Record<string, unknown>)[key], expected)));
  }
  return value === pattern;
}

@injectable()
export class SqliteVectorStore implements IVectorStore {
  private db: Database | null = null;
  private readonly dbPath: string;

  constructor(
    @inject('ILogger') private readonly logger: ILogger,
    dbPath: string = ':memory:'
  ) {
    this.dbPath = dbPath;
  }

  async initialize(): Promise<void> {
    try {
      this.logger.info(`[SqliteVectorStore] Initializing database at ${this.dbPath}`);
      this.db = new Database(this.dbPath);
      
      // Load sqlite-vec extension
      sqliteVec.load(this.db);
      
      // Get vector library version
      const version = this.db.prepare('select vec_version() as version').get() as { version: string };
      this.logger.info(`[SqliteVectorStore] sqlite-vec loaded, version: ${version.version}`);

      // Create vectors table
      // We use vec0 virtual table for vector search
      // Schema:
      // id: text primary key
      // embedding: float[384] (assuming standard small model, configurable?)
      // metadata: json
      
      // NOTE: vec0 definition requires dimensions. 
      // For now we hardcode 384 (all-MiniLM-L6-v2 default).
      // Future improvement: make strictly configurable.
      const dim = 384; 

      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS vectors USING vec0(
          id text primary key,
          embedding float[${dim}]
        );
      `);

      // Metadata table for filtering (since vec0 is specialized)
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS vector_metadata (
          id text primary key,
          namespace text,
          payload json,
          created_at text
        );
      `);

      this.logger.info('[SqliteVectorStore] Schema initialized');
    } catch (error) {
      this.logger.error('[SqliteVectorStore] Initialization failed', { error });
      throw error;
    }
  }

  async upsertEmbeddings(documents: VectorDocument[]): Promise<void> {
    if (!this.db) await this.initialize();
    
    const insertVector = this.db!.prepare(`
      INSERT INTO vectors(id, embedding) VALUES (?, ?)
    `);
    
    // We use REPLACE for metadata to handle updates
    const insertMetadata = this.db!.prepare(`
      INSERT OR REPLACE INTO vector_metadata(id, namespace, payload, created_at)
      VALUES (?, ?, ?, ?)
    `);
    // vec0 does not support INSERT OR REPLACE. One prepared DELETE is reused for the batch.
    const deleteVector = this.db!.prepare('DELETE FROM vectors WHERE id = ?');

    const transaction = this.db!.transaction((docs: VectorDocument[]) => {
      for (const doc of docs) {
        deleteVector.run(doc.id);
        
        // Ensure Float32Array
        let vector: Float32Array;
        if (doc.embedding instanceof Float32Array) {
             vector = doc.embedding;
        } else {
             vector = new Float32Array(doc.embedding);
        }

        insertVector.run(doc.id, vector);
        
        // 2. Insert metadata
        insertMetadata.run(
          doc.id,
          doc.namespace || 'default',
          JSON.stringify(doc.metadata || {}),
          new Date().toISOString()
        );
      }
    });

    try {
      transaction(documents);
    } catch (error) {
       this.logger.error('[SqliteVectorStore] Upsert failed', { error });
       throw error;
    }
  }

  async deleteByIds(ids: string[], namespace?: string): Promise<void> {
    if (!this.db) await this.initialize();
    
    const deleteVector = this.db!.prepare('DELETE FROM vectors WHERE id = ?');
    const deleteMetadata = this.db!.prepare('DELETE FROM vector_metadata WHERE id = ?');

    const transaction = this.db!.transaction((idsToDelete: string[]) => {
       for (const id of idsToDelete) {
           deleteVector.run(id);
           deleteMetadata.run(id);
       }
    });

    try {
        transaction(ids);
    } catch (error) {
        this.logger.error('[SqliteVectorStore] Delete failed', { error });
        throw error;
    }
  }

  async search(query: VectorSearchQuery): Promise<VectorSearchResult[]> {
    if (!this.db) await this.initialize();

    // Rows are tenant memories, as in PgVectorStore over long_term_memories:
    // a search without a tenant returns nothing.
    if (!query.namespace || query.topK <= 0) {
      return [];
    }

    const vector = query.queryEmbedding instanceof Float32Array
      ? query.queryEmbedding
      : new Float32Array(query.queryEmbedding);
    const { userId, types, metadataFilters } = splitFilters(query.filters);

    const conditions = ['m.namespace = ?'];
    const params: unknown[] = [vector, query.namespace];
    if (userId) {
      conditions.push("json_extract(m.payload, '$.userId') = ?");
      params.push(userId);
    }
    if (types) {
      conditions.push(`json_extract(m.payload, '$.type') IN (${types.map(() => '?').join(', ')})`);
      params.push(...types);
    }
    if (!metadataFilters) {
      params.push(query.topK);
    }

    // Exact scan with the filters applied before the limit. A vec0 KNN query in
    // sqlite-vec 0.1.x scans every row as well, and its k would cut the page before filtering.
    const rows = this.db!.prepare(`
      SELECT
        v.id AS id,
        vec_distance_l2(v.embedding, ?) AS distance,
        m.namespace AS namespace,
        m.payload AS payload
      FROM vectors v
      JOIN vector_metadata m ON m.id = v.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY distance
      ${metadataFilters ? '' : 'LIMIT ?'}
    `).all(...params) as Array<{ id: string; distance: number; namespace: string; payload: string }>;

    const results: VectorSearchResult[] = [];
    for (const row of rows) {
      const metadata = JSON.parse(row.payload) as Record<string, unknown>;
      if (metadataFilters && !jsonContains(metadata, metadataFilters)) {
        continue;
      }
      results.push({
        id: row.id,
        score: 1 / (1 + row.distance),
        metadata,
        namespace: row.namespace,
      });
      if (results.length >= query.topK) {
        break;
      }
    }

    return results;
  }

  async close(): Promise<void> {
    if (!this.db) {
      return;
    }

    try {
      this.db.close();
    } finally {
      this.db = null;
    }
  }
}
