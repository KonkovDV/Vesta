/**
 * Graph Memory Engine — Domain Port
 *
 * High-level graph memory operations: add data to knowledge graph,
 * search graph by query, retrieve all relations, delete by user.
 *
 * Implementations wrap a low-level IGraphMemoryAdapter and add
 * LLM-driven entity extraction, relation establishment, dedup,
 * and BM25 re-ranking.
 *
 * Layer: Domain/Memory
 * @module IGraphMemoryEngine
 */

import type { TenantId, UserId, CorrelationId } from './session-types';

/**
 * Filters for scoping graph operations to a user/tenant.
 */
export interface GraphMemoryFilters {
  tenantId: TenantId;
  userId: UserId;
  correlationId?: CorrelationId;
}

/**
 * Single extracted entity with its type.
 */
export interface ExtractedGraphEntity {
  entity: string;
  entityType: string;
}

/**
 * Single extracted relation triple.
 */
export interface ExtractedGraphRelation {
  source: string;
  relationship: string;
  destination: string;
}

/**
 * Result of adding data to the graph.
 */
export interface GraphAddResult {
  /** Entities deleted during reconciliation */
  deletedEntities: ExtractedGraphRelation[];
  /** Entities/relations added to the graph */
  addedEntities: ExtractedGraphRelation[];
  /** All relations extracted from input */
  relations: ExtractedGraphRelation[];
}

/**
 * Single search result triple.
 */
export interface GraphSearchResult {
  source: string;
  relationship: string;
  destination: string;
}

/**
 * Point-in-time filter for a single entity in the temporal graph.
 */
export interface GraphEntityQueryOptions {
  asOf?: string;
  direction?: 'outgoing' | 'incoming' | 'both';
  limit?: number;
}

/**
 * Identity of a fact to close.
 */
export interface GraphInvalidateFactInput {
  source: string;
  relationship: string;
  destination: string;
  endedAt?: string;
}

/**
 * One temporal edge returned by queryEntity and timeline.
 */
export interface TemporalGraphFact {
  source: string;
  relationship: string;
  destination: string;
  weight: number;
  validFrom: string | null;
  validTo: string | null;
  current: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * Graph Memory Engine — high-level graph operations with LLM intelligence.
 *
 * Wraps IGraphMemoryAdapter and adds:
 * - LLM-driven entity extraction (self-reference resolution)
 * - LLM-driven relation establishment
 * - LLM-driven delete reconciliation (multi-value relation protection)
 * - Embedding-based node deduplication (cosine 0.9)
 * - BM25 re-ranking for search results
 */
export interface IGraphMemoryEngine {
  /**
   * Add data to the knowledge graph.
   *
   * Pipeline: extract entities → extract relations → search existing →
   * determine deletions → apply deletions → add new entities/relations.
   *
   * @param data - Natural language text to extract knowledge from
   * @param filters - Tenant/user scoping
   * @param customPrompt - Optional custom prompt for relation extraction
   * @returns Added and deleted entities with all extracted relations
   */
  add(
    data: string,
    filters: GraphMemoryFilters,
    customPrompt?: string,
  ): Promise<GraphAddResult>;

  /**
   * Search the knowledge graph.
   *
   * Pipeline: extract entities from query → search graph by embedding →
   * BM25 re-rank results.
   *
   * @param query - Natural language search query
   * @param filters - Tenant/user scoping
   * @param limit - Maximum number of results (default: 100)
   * @returns Re-ranked search results
   */
  search(
    query: string,
    filters: GraphMemoryFilters,
    limit?: number,
  ): Promise<GraphSearchResult[]>;

  /**
   * Get all relations for a user.
   *
   * @param filters - Tenant/user scoping
   * @param limit - Maximum number of results (default: 100)
   */
  getAll(
    filters: GraphMemoryFilters,
    limit?: number,
  ): Promise<GraphSearchResult[]>;

  /**
   * Delete all graph data for a user.
   *
   * @param filters - Tenant/user scoping
   */
  deleteAll(filters: GraphMemoryFilters): Promise<void>;

  /**
   * Relations touching one entity, optionally as of a date.
   */
  queryEntity(
    entity: string,
    filters: GraphMemoryFilters,
    options?: GraphEntityQueryOptions,
  ): Promise<TemporalGraphFact[]>;

  /**
   * Close a fact by setting its end date.
   */
  invalidateFact(
    fact: GraphInvalidateFactInput,
    filters: GraphMemoryFilters,
  ): Promise<void>;

  /**
   * Chronological facts for an entity, or for the whole user when entity is omitted.
   */
  timeline(
    entity: string | undefined,
    filters: GraphMemoryFilters,
    limit?: number,
  ): Promise<TemporalGraphFact[]>;
}
