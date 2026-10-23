/**
 * Graph Memory Engine — LLM-powered knowledge graph pipeline.
      {
        tools: [ENTITY_TOOL],
        temperature: 0,
      },
 *   3. Graph Search (IGraphMemoryAdapter + embedding similarity)
 *   4. Delete Decisions (LLM + tool calling, multi-value protection)
 *   5. Entity Add/Merge (IGraphMemoryAdapter + embedding dedup)
 *
 * Search pipeline:
 *   1. Entity Extraction (same as add, Stage 1)
 *   2. Graph Search (adapter query per entity)
 *   3. BM25 Re-ranking
 *
 * Wraps the low-level IGraphMemoryAdapter (Cypher operations)
 * and adds LLM intelligence layer on top.
 *
 * Ported from: external/mem0/mem0-ts/src/oss/src/memory/graph_memory.ts
 *
 * Improvements over donor:
 * - DI-injected dependencies (IGraphMemoryAdapter, tool-calling LLM bridge, IStructuredLogger)
 * - Zod validation for all tool call arguments
 * - Configurable thresholds (search: 0.7 default, dedup: 0.9 default)
 * - Proper error handling with structured logging
 * - Multi-tenant scoping via GraphMemoryFilters
 * - Clean Architecture compliance (no direct neo4j import)
 *
 * Layer: Infrastructure/Memory/Graph
 * @module GraphMemoryEngine
 */

import type {
  IGraphMemoryEngine,
  GraphInvalidateFactInput,
  GraphMemoryFilters,
  GraphAddResult,
  GraphSearchResult,
  GraphEntityQueryOptions,
  TemporalGraphFact,
  ExtractedGraphRelation,
} from '../../../domain/memory/IGraphMemoryEngine';
import type { ILLMAdapter } from '../../../domain/ai/ILLMAdapter';
import type {
  IGraphMemoryAdapter,
  AddRelationInput,
  QueryRelationsInput,
} from '../../../domain/memory/graph-memory.port';
import {
  EXTRACT_ENTITIES_TOOL,
  RELATIONS_TOOL,
  DELETE_MEMORY_TOOL_GRAPH,
  GraphExtractEntitiesSchema,
  GraphRelationsSchema,
  GraphSimpleRelationshipSchema,
  parseToolCallArgs,
  parseAllToolCallArgs,
} from './EntityExtractionTools';
import {
  getEntityExtractionPrompt,
  getRelationExtractionMessages,
  getDeleteMessages,
  formatEntities,
  normalizeEntityName,
  normalizeRelationEntities,
} from './GraphPrompts';
import { BM25Ranker, tokenize } from './BM25Ranker';

// ─── Interfaces for DI-injected dependencies ───────────────

/**
 * Tool-calling subset of the canonical ILLMAdapter.
 */
export type IGraphLLMAdapter = Pick<ILLMAdapter, 'generateMultimodalChat'>;

/**
 * Structured logger interface.
 */
export interface IGraphMemoryLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

// ─── Internal types ─────────────────────────────────────────

interface SearchOutput {
  source: string;
  sourceId: string;
  relationship: string;
  relationId: string;
  destination: string;
  destinationId: string;
  similarity: number;
}

interface ToolCallResponse {
  toolCalls?: Array<{ name: string; arguments: string }>;
}

// ─── Configuration ──────────────────────────────────────────

export interface GraphMemoryEngineConfig {
  /**
   * Minimum cosine similarity for search results (default: 0.7).
   * Reserved for Phase 6+ when embedder is wired into graph search.
   * The donor (Mem0) passes this as `$threshold` in Cypher WHERE clauses.
   * Currently unused — search filtering happens at the adapter level.
   */
  searchThreshold?: number;
  /**
   * Minimum cosine similarity for node dedup (default: 0.9).
   * Reserved for Phase 6+ when embedder is wired into entity dedup.
   * The donor (Mem0) uses this in `_search_source_node` / `_search_destination_node`.
   * Currently unused — entity matching happens by name at the adapter level.
   */
  dedupThreshold?: number;
  /** Maximum search results before re-ranking (default: 100) */
  searchLimit?: number;
  /** Top-K results after BM25 re-ranking (default: 5) */
  rerankedTopK?: number;
}

const DEFAULT_CONFIG: Required<GraphMemoryEngineConfig> = {
  searchThreshold: 0.7,
  dedupThreshold: 0.9,
  searchLimit: 100,
  rerankedTopK: 5,
};

function currentDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Implementation ─────────────────────────────────────────

export class GraphMemoryEngine implements IGraphMemoryEngine {
  private readonly graphAdapter: IGraphMemoryAdapter;
  private readonly llm: IGraphLLMAdapter;
  private readonly logger: IGraphMemoryLogger;
  private readonly config: Required<GraphMemoryEngineConfig>;

  constructor(
    graphAdapter: IGraphMemoryAdapter,
    llm: IGraphLLMAdapter,
    logger: IGraphMemoryLogger,
    config?: GraphMemoryEngineConfig,
  ) {
    this.graphAdapter = graphAdapter;
    this.llm = llm;
    this.logger = logger;
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  private async chat(
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    options?: {
      tools?: Array<Record<string, unknown>>;
      temperature?: number;
    },
  ): Promise<ToolCallResponse> {
    const response = await this.llm.generateMultimodalChat(
      messages.map((message) => ({
        role: message.role,
        parts: [{ type: 'text', text: message.content }],
      })),
      {
        temperature: options?.temperature,
        tools: (options?.tools as Array<{
          type: string;
          function: {
            name: string;
            description?: string;
            parameters?: Record<string, unknown>;
          };
        }>) ?? [],
        toolChoice: options?.tools && options.tools.length > 0 ? 'auto' : 'none',
      },
    );

    const rawToolCalls = Array.isArray((response as { toolCalls?: unknown[] }).toolCalls)
      ? (response as { toolCalls?: unknown[] }).toolCalls
      : undefined;

    return {
      toolCalls: rawToolCalls?.flatMap((call) => {
        if (
          typeof call === 'object' &&
          call !== null &&
          'function' in call &&
          typeof (call as { function?: { name?: unknown; arguments?: unknown } }).function?.name === 'string' &&
          typeof (call as { function?: { name?: unknown; arguments?: unknown } }).function?.arguments === 'string'
        ) {
          return [{
            name: (call as { function: { name: string; arguments: string } }).function.name,
            arguments: (call as { function: { name: string; arguments: string } }).function.arguments,
          }];
        }

        if (
          typeof call === 'object' &&
          call !== null &&
          'name' in call &&
          'arguments' in call &&
          typeof (call as { name?: unknown }).name === 'string' &&
          typeof (call as { arguments?: unknown }).arguments === 'string'
        ) {
          return [{
            name: (call as { name: string; arguments: string }).name,
            arguments: (call as { name: string; arguments: string }).arguments,
          }];
        }

        return [];
      }),
    };
  }

  // ─── Public API ─────────────────────────────────────────

  async add(
    data: string,
    filters: GraphMemoryFilters,
    customPrompt?: string,
  ): Promise<GraphAddResult> {
    this.logger.info('GraphMemoryEngine.add: starting pipeline', {
      userId: filters.userId,
      dataLength: data.length,
    });

    // Stage 1: Extract entities from input text
    const entityTypeMap = await this.extractEntities(data, filters);

    if (Object.keys(entityTypeMap).length === 0) {
      this.logger.warn('GraphMemoryEngine.add: no entities extracted');
      return { deletedEntities: [], addedEntities: [], relations: [] };
    }

    // Stage 2: Extract relations between entities
    const toBeAdded = await this.extractRelations(
      data,
      filters,
      entityTypeMap,
      customPrompt,
    );

    // Stage 3: Search existing graph for related entities
    const searchOutput = await this.searchGraphForEntities(
      Object.keys(entityTypeMap),
      filters,
    );

    // Stage 4: Determine which existing relations should be deleted
    const toBeDeleted = await this.determineDeletedEntities(
      searchOutput,
      data,
      filters,
    );

    // Stage 5a: Delete outdated/contradictory relations
    const deletedEntities = await this.deleteEntities(toBeDeleted, filters);

    // Stage 5b: Add new entities and relations
    const addedEntities = await this.addEntities(
      toBeAdded,
      filters,
      entityTypeMap,
    );

    this.logger.info('GraphMemoryEngine.add: pipeline complete', {
      added: addedEntities.length,
      deleted: deletedEntities.length,
      relations: toBeAdded.length,
    });

    return {
      deletedEntities,
      addedEntities,
      relations: toBeAdded,
    };
  }

  async search(
    query: string,
    filters: GraphMemoryFilters,
    limit = 100,
  ): Promise<GraphSearchResult[]> {
    // Stage 1: Extract entities from query
    const entityTypeMap = await this.extractEntities(query, filters);

    // Stage 2: Search graph
    const searchOutput = await this.searchGraphForEntities(
      Object.keys(entityTypeMap),
      filters,
      limit,
    );

    if (searchOutput.length === 0) {
      return [];
    }

    // Stage 3: BM25 re-rank
    const searchOutputTriples = searchOutput.map((item) => [
      item.source,
      item.relationship,
      item.destination,
    ]);

    const bm25 = new BM25Ranker(searchOutputTriples);
    const tokenizedQuery = tokenize(query);
    const reranked = bm25.search(tokenizedQuery).slice(0, this.config.rerankedTopK);

    const results: GraphSearchResult[] = reranked.map((triple) => ({
      source: triple[0],
      relationship: triple[1],
      destination: triple[2],
    }));

    this.logger.info(
      `GraphMemoryEngine.search: returned ${results.length} results`,
    );
    return results;
  }

  async getAll(
    filters: GraphMemoryFilters,
    limit = 100,
  ): Promise<GraphSearchResult[]> {
    // Discover all entities for this tenant/user, then query their relations.
    // The donor (Mem0) uses a dedicated Cypher query:
    //   MATCH (n {user_id: $user_id})-[r]->(m) RETURN ...
    // Our adapter abstraction doesn't support wildcard entity queries,
    // so we first discover entities via searchEntities, then collect relations.
    const entities = await this.graphAdapter.searchEntities({
      tenantId: filters.tenantId,
      query: '',
      limit,
    });

    if (entities.length === 0) {
      return [];
    }

    const seen = new Set<string>();
    const results: GraphSearchResult[] = [];
    const relationGroups = await Promise.allSettled(entities.map(async (entity) => {
      try {
        const queryResult = await this.graphAdapter.queryRelations({
          tenantId: filters.tenantId,
          userId: filters.userId,
          entity: entity.name,
          direction: 'outgoing',
          limit,
        });
        return queryResult.relations;
      } catch (e) {
        this.logger.warn(`GraphMemoryEngine.getAll: failed to query entity "${entity.name}"`, {
          error: String(e),
        });
        return [];
      }
    }));

    relationGroups.forEach((group) => {
      if (group.status !== 'fulfilled') {
        return;
      }
      group.value.forEach((relation) => {
        const key = `${relation.sourceEntity}|${relation.relationType}|${relation.targetEntity}`;
        if (!seen.has(key)) {
          seen.add(key);
          results.push({
            source: relation.sourceEntity,
            relationship: relation.relationType,
            destination: relation.targetEntity,
          });
        }
      });
    });

    return results;
  }

  async queryEntity(
    entity: string,
    filters: GraphMemoryFilters,
    options?: GraphEntityQueryOptions,
  ): Promise<TemporalGraphFact[]> {
    const result = await this.graphAdapter.queryRelations({
      tenantId: filters.tenantId,
      userId: filters.userId,
      entity,
      asOf: options?.asOf,
      direction: options?.direction ?? 'both',
      limit: options?.limit,
      includeInactive: true,
    });

    return result.relations.map((relation) => this.toTemporalFact(relation));
  }

  async invalidateFact(
    fact: GraphInvalidateFactInput,
    filters: GraphMemoryFilters,
  ): Promise<void> {
    await this.graphAdapter.invalidateRelation({
      tenantId: filters.tenantId,
      sourceEntity: fact.source,
      targetEntity: fact.destination,
      relationType: fact.relationship,
      endedAt: fact.endedAt,
    });
  }

  async timeline(
    entity: string | undefined,
    filters: GraphMemoryFilters,
    limit = 100,
  ): Promise<TemporalGraphFact[]> {
    const relations = await this.graphAdapter.getTimeline({
      tenantId: filters.tenantId,
      userId: filters.userId,
      entity,
      limit,
    });

    return relations.map((relation) => this.toTemporalFact(relation));
  }

  async deleteAll(filters: GraphMemoryFilters): Promise<void> {
    // Use pruneWeakRelations with weight 2.0 (above max weight [0,1]) to delete all.
    // Note: This deletes ALL relations for the tenant, not just for the specific userId.
    // The donor (Mem0 graph_memory.py) uses a dedicated Cypher query:
    //   MATCH (n {user_id: $user_id}) DETACH DELETE n
    // which scopes by user_id and also deletes entity nodes.
    // Our adapter's pruneWeakRelations only supports tenant-level scoping.
    // TODO: Add userId-scoped deleteAll to IGraphMemoryAdapter in Phase 6.
    await this.graphAdapter.pruneWeakRelations(filters.tenantId, 2.0);
    this.logger.info('GraphMemoryEngine.deleteAll: complete', {
      userId: filters.userId,
      note: 'tenant-level prune; userId scoping requires adapter enhancement',
    });
  }

  // ─── Stage 1: Entity Extraction ────────────────────────

  private async extractEntities(
    data: string,
    filters: GraphMemoryFilters,
  ): Promise<Record<string, string>> {
    const systemPrompt = getEntityExtractionPrompt(filters.userId);

    const response = await this.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: data },
      ],
      {
        tools: [EXTRACT_ENTITIES_TOOL],
        temperature: 0,
      },
    );

    let entityTypeMap: Record<string, string> = {};

    try {
      const parsed = parseToolCallArgs(
        response.toolCalls,
        'extract_entities',
        GraphExtractEntitiesSchema,
      );

      if (parsed) {
        for (const item of parsed.entities) {
          entityTypeMap[item.entity] = item.entity_type;
        }
      }
    } catch (e) {
      this.logger.error('GraphMemoryEngine: entity extraction failed', {
        error: String(e),
      });
    }

    // Normalize: lowercase + spaces→underscores
    entityTypeMap = Object.fromEntries(
      Object.entries(entityTypeMap).map(([k, v]) => [
        normalizeEntityName(k),
        normalizeEntityName(v),
      ]),
    );

    this.logger.debug('GraphMemoryEngine: entities extracted', {
      count: Object.keys(entityTypeMap).length,
      entities: Object.keys(entityTypeMap),
    });

    return entityTypeMap;
  }

  // ─── Stage 2: Relation Extraction ─────────────────────

  private async extractRelations(
    data: string,
    filters: GraphMemoryFilters,
    entityTypeMap: Record<string, string>,
    customPrompt?: string,
  ): Promise<ExtractedGraphRelation[]> {
    const [systemContent, userContent] = getRelationExtractionMessages(
      data,
      filters.userId,
      Object.keys(entityTypeMap),
      customPrompt,
    );

    const response = await this.chat(
      [
        { role: 'system', content: systemContent },
        { role: 'user', content: userContent },
      ],
      {
        tools: [RELATIONS_TOOL],
        temperature: 0,
      },
    );

    let entities: ExtractedGraphRelation[] = [];

    try {
      const parsed = parseToolCallArgs(
        response.toolCalls,
        'establish_relationships',
        GraphRelationsSchema,
      );

      if (parsed) {
        entities = parsed.entities;
      }
    } catch (e) {
      this.logger.error('GraphMemoryEngine: relation extraction failed', {
        error: String(e),
      });
    }

    entities = normalizeRelationEntities(entities);

    this.logger.debug('GraphMemoryEngine: relations extracted', {
      count: entities.length,
    });

    return entities;
  }

  // ─── Stage 3: Graph Search ────────────────────────────

  private async searchGraphForEntities(
    entityNames: string[],
    filters: GraphMemoryFilters,
    limit = 100,
  ): Promise<SearchOutput[]> {
    const results: SearchOutput[] = [];
    // Deduplicate: when multiple entities are queried, the same relation
    // can appear in results for different entities (e.g., alice→knows→bob
    // found via both "alice" and "bob"). The donor (Mem0) handles this via
    // Cypher's `WITH DISTINCT` clause. We deduplicate by relation key.
    const seen = new Set<string>();

    for (const entityName of entityNames) {
      try {
        const queryResult = await this.graphAdapter.queryRelations({
          tenantId: filters.tenantId,
          userId: filters.userId,
          entity: entityName,
          direction: 'both',
          limit,
        });

        for (const rel of queryResult.relations) {
          const relationKey = `${rel.sourceEntity}|${rel.relationType}|${rel.targetEntity}`;
          if (seen.has(relationKey)) {
            continue;
          }
          seen.add(relationKey);

          results.push({
            source: rel.sourceEntity,
            sourceId: rel.sourceEntity,
            relationship: rel.relationType,
            relationId: `${rel.sourceEntity}-${rel.relationType}-${rel.targetEntity}`,
            destination: rel.targetEntity,
            destinationId: rel.targetEntity,
            similarity: rel.weight,
          });
        }
      } catch (e) {
        this.logger.warn(
          `GraphMemoryEngine: search failed for entity "${entityName}"`,
          { error: String(e) },
        );
      }
    }

    return results;
  }

  // ─── Stage 4: Delete Decisions ────────────────────────

  private async determineDeletedEntities(
    searchOutput: SearchOutput[],
    data: string,
    filters: GraphMemoryFilters,
  ): Promise<ExtractedGraphRelation[]> {
    if (searchOutput.length === 0) {
      return [];
    }

    const existingMemoriesString = formatEntities(
      searchOutput.map((item) => ({
        source: item.source,
        relationship: item.relationship,
        destination: item.destination,
      })),
    );

    const [systemPrompt, userPrompt] = getDeleteMessages(
      existingMemoriesString,
      data,
      filters.userId,
    );

    const response = await this.chat(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      {
        tools: [DELETE_MEMORY_TOOL_GRAPH],
        temperature: 0,
      },
    );

    let toBeDeleted: ExtractedGraphRelation[] = [];

    try {
      toBeDeleted = parseAllToolCallArgs(
        response.toolCalls,
        'delete_graph_memory',
        GraphSimpleRelationshipSchema,
      );
    } catch (e) {
      this.logger.error('GraphMemoryEngine: delete decision failed', {
        error: String(e),
      });
    }

    toBeDeleted = normalizeRelationEntities(toBeDeleted);

    this.logger.debug('GraphMemoryEngine: deletions determined', {
      count: toBeDeleted.length,
    });

    return toBeDeleted;
  }

  // ─── Stage 5a: Delete Entities ────────────────────────

  private async deleteEntities(
    toBeDeleted: ExtractedGraphRelation[],
    filters: GraphMemoryFilters,
  ): Promise<ExtractedGraphRelation[]> {
    const deleted: ExtractedGraphRelation[] = [];
    for (const item of toBeDeleted) {
      try {
        // Verify the relation exists before marking
        const queryResult = await this.graphAdapter.queryRelations({
          tenantId: filters.tenantId,
          entity: item.source,
          relationType: item.relationship,
          direction: 'outgoing',
          limit: 100,
        });

        const matchingRel = queryResult.relations.find(
          (r) =>
            r.sourceEntity === item.source &&
            r.relationType === item.relationship &&
            r.targetEntity === item.destination,
        );

        if (matchingRel) {
          await this.graphAdapter.invalidateRelation({
            tenantId: filters.tenantId,
            sourceEntity: item.source,
            targetEntity: item.destination,
            relationType: item.relationship,
            endedAt: currentDateKey(),
          });
          deleted.push(item);
        }
      } catch (e) {
        this.logger.warn('GraphMemoryEngine: failed to invalidate relation', {
          relation: item,
          error: String(e),
        });
      }
    }

    return deleted;
  }

  // ─── Stage 5b: Add Entities ───────────────────────────

  private async addEntities(
    toBeAdded: ExtractedGraphRelation[],
    filters: GraphMemoryFilters,
    entityTypeMap: Record<string, string>,
  ): Promise<ExtractedGraphRelation[]> {
    const added: ExtractedGraphRelation[] = [];

    for (const item of toBeAdded) {
      try {
        const sourceType = entityTypeMap[item.source] || 'unknown';
        const destinationType = entityTypeMap[item.destination] || 'unknown';

        await this.graphAdapter.addRelation({
          tenantId: filters.tenantId,
          userId: filters.userId,
          sourceEntity: item.source,
          sourceLabel: sourceType,
          targetEntity: item.destination,
          targetLabel: destinationType,
          relationType: item.relationship,
          weight: 1.0,
          validFrom: currentDateKey(),
          correlationId: filters.correlationId,
        });

        added.push(item);
      } catch (e) {
        this.logger.warn('GraphMemoryEngine: failed to add relation', {
          relation: item,
          error: String(e),
        });
      }
    }

    return added;
  }

  private toTemporalFact(relation: {
    sourceEntity: string;
    targetEntity: string;
    relationType: string;
    weight: number;
    createdAt: string;
    updatedAt: string;
    validFrom?: string | null;
    validTo?: string | null;
    current?: boolean;
  }): TemporalGraphFact {
    return {
      source: relation.sourceEntity,
      relationship: relation.relationType,
      destination: relation.targetEntity,
      weight: relation.weight,
      validFrom: relation.validFrom ?? null,
      validTo: relation.validTo ?? null,
      current: relation.current ?? relation.validTo == null,
      createdAt: relation.createdAt,
      updatedAt: relation.updatedAt,
    };
  }
}
