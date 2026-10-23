/**
 * Graph Memory Adapter Interface and Types.
 * 
 * Provides abstraction for graph database operations (Neo4j, Memgraph).
 * Used for entity relationship tracking across memories.
 * 
 * Layer: Domain
 */

import type { TenantId, UserId, SessionId, CorrelationId } from './session-types';

/**
 * Relationship between two entities in the graph.
 */
export interface GraphRelation {
  /** Source entity identifier */
  sourceEntity: string;
  /** Target entity identifier */
  targetEntity: string;
  /** Type of relationship (e.g., 'WORKS_AT', 'KNOWS', 'SIMILAR_TO') */
  relationType: string;
  /** Relationship strength/weight [0, 1] */
  weight: number;
  /** When the relationship was created */
  createdAt: string;
  /** When the relationship was last updated */
  updatedAt: string;
  /** When the fact became valid */
  validFrom?: string | null;
  /** When the fact stopped being valid */
  validTo?: string | null;
  /** Whether the fact is currently active */
  current?: boolean;
  /** Additional properties */
  properties?: Record<string, unknown>;
}

/**
 * Entity node in the graph.
 */
export interface GraphEntity {
  /** Entity identifier */
  id: string;
  /** Entity label/type (e.g., 'Person', 'Organization', 'Concept') */
  label: string;
  /** Entity name for display */
  name: string;
  /** Tenant this entity belongs to */
  tenantId: TenantId;
  /** User this entity is associated with (optional) */
  userId?: UserId;
  /** Additional properties */
  properties?: Record<string, unknown>;
}

/**
 * Input for adding a relationship.
 */
export interface AddRelationInput {
  tenantId: TenantId;
  userId?: UserId;
  sessionId?: SessionId;
  sourceEntity: string;
  sourceLabel?: string;
  targetEntity: string;
  targetLabel?: string;
  relationType: string;
  weight?: number;
  validFrom?: string;
  validTo?: string | null;
  properties?: Record<string, unknown>;
  correlationId?: CorrelationId;
}

/**
 * Input for querying relationships.
 */
export interface QueryRelationsInput {
  tenantId: TenantId;
  userId?: UserId;
  entity: string;
  relationType?: string;
  direction?: 'outgoing' | 'incoming' | 'both';
  depth?: number;
  limit?: number;
  asOf?: string;
  includeInactive?: boolean;
  correlationId?: CorrelationId;
}

export interface InvalidateRelationInput {
  tenantId: TenantId;
  sourceEntity: string;
  targetEntity: string;
  relationType: string;
  endedAt?: string;
}

export interface GraphTimelineInput {
  tenantId: TenantId;
  userId?: UserId;
  entity?: string;
  limit?: number;
}

/**
 * Result of relationship query.
 */
export interface QueryRelationsResult {
  relations: GraphRelation[];
  entities: GraphEntity[];
  totalCount: number;
}

/**
 * Graph Memory Adapter interface.
 * 
 * Implementations: Neo4jGraphAdapter, MemgraphAdapter, InMemoryGraphAdapter
 */
export interface IGraphMemoryAdapter {
  /**
   * Add or update a relationship between entities.
   * Creates entities if they don't exist.
   */
  addRelation(input: AddRelationInput): Promise<void>;

  /**
   * Query relationships for an entity.
   */
  queryRelations(input: QueryRelationsInput): Promise<QueryRelationsResult>;

  /**
   * Mark an active relationship as no longer valid.
   */
  invalidateRelation(input: InvalidateRelationInput): Promise<void>;

  /**
   * Get chronological facts for an entity or tenant.
   */
  getTimeline(input: GraphTimelineInput): Promise<GraphRelation[]>;

  /**
   * Reinforce (increase weight) of a relationship.
   */
  reinforceRelation(input: {
    tenantId: TenantId;
    sourceEntity: string;
    targetEntity: string;
    relationType: string;
    boostAmount?: number;
  }): Promise<void>;

  /**
   * Get entity by ID.
   */
  getEntity(tenantId: TenantId, entityId: string): Promise<GraphEntity | null>;

  /**
   * Search entities by name or properties.
   */
  searchEntities(input: {
    tenantId: TenantId;
    query: string;
    label?: string;
    limit?: number;
  }): Promise<GraphEntity[]>;

  /**
   * Delete relationships below minimum weight threshold (pruning).
   */
  pruneWeakRelations(tenantId: TenantId, minWeight: number): Promise<number>;

  /**
   * Health check for the graph database connection.
   */
  healthCheck(): Promise<boolean>;
}
