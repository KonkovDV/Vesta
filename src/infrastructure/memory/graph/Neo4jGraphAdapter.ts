/**
 * Neo4j Graph Adapter — Production implementation.
 * 
 * Stores entities and relationships in Neo4j graph database.
 * 
 * Layer: Infrastructure/Memory
 */

import type {
  IGraphMemoryAdapter,
  GraphEntity,
  GraphRelation,
  AddRelationInput,
  GraphTimelineInput,
  InvalidateRelationInput,
  QueryRelationsInput,
  QueryRelationsResult,
} from '../../../domain/memory/graph-memory.port';
import type { TenantId } from '../../../domain/memory/session-types';
import type { GraphStoreConfig } from '../../../config/schema/definitions/graph.schema';

/**
 * Neo4j driver types (imported at runtime if neo4j-driver is available).
 */
interface Neo4jDriver {
  session(config?: { database?: string }): Neo4jSession;
  close(): Promise<void>;
}

interface Neo4jSession {
  run(query: string, params?: Record<string, unknown>): Promise<Neo4jResult>;
  close(): Promise<void>;
}

interface Neo4jResult {
  records: Array<{
    get(key: string): unknown;
    toObject(): Record<string, unknown>;
  }>;
}

export class Neo4jGraphAdapter implements IGraphMemoryAdapter {
  private driver: Neo4jDriver | null = null;
  private readonly config: GraphStoreConfig;

  constructor(config: GraphStoreConfig) {
    this.config = config;
  }

  /**
   * Lazy initialization of Neo4j driver.
   */
  private async getDriver(): Promise<Neo4jDriver> {
    if (this.driver) return this.driver;

    if (!this.config.neo4j) {
      throw new Error('Neo4j configuration is missing');
    }

    // Dynamic import to avoid bundling neo4j-driver if not used
    const neo4j = await import('neo4j-driver');
    this.driver = neo4j.default.driver(
      this.config.neo4j.url,
      neo4j.default.auth.basic(this.config.neo4j.username, this.config.neo4j.password)
    );

    return this.driver;
  }

  private async runQuery(cypher: string, params: Record<string, unknown> = {}): Promise<Neo4jResult> {
    const driver = await this.getDriver();
    const session = driver.session({ database: this.config.neo4j?.database });
    
    try {
      return await session.run(cypher, params);
    } finally {
      await session.close();
    }
  }

  async addRelation(input: AddRelationInput): Promise<void> {
    const now = new Date().toISOString();
    const validFrom = input.validFrom ?? now.slice(0, 10);
    const validTo = input.validTo ?? null;
    
    const cypher = `
      MERGE (source:Entity {id: $sourceId, tenantId: $tenantId})
      ON CREATE SET source.label = $sourceLabel, source.name = $sourceId, source.createdAt = $now
      
      MERGE (target:Entity {id: $targetId, tenantId: $tenantId})
      ON CREATE SET target.label = $targetLabel, target.name = $targetId, target.createdAt = $now
      
      OPTIONAL MATCH (source)-[existing:${input.relationType}]->(target)
      WHERE existing.validTo IS NULL
      FOREACH (_ IN CASE WHEN existing IS NULL THEN [1] ELSE [] END |
        CREATE (source)-[created:${input.relationType} {
          weight: $weight,
          createdAt: $now,
          updatedAt: $now,
          validFrom: $validFrom,
          validTo: $validTo
        }]->(target)
        SET created += $properties
      )
      FOREACH (_ IN CASE WHEN existing IS NOT NULL THEN [1] ELSE [] END |
        SET existing.weight = $weight,
            existing.updatedAt = $now,
            existing.validFrom = coalesce(existing.validFrom, $validFrom),
            existing.validTo = $validTo
        SET existing += $properties
      )
    `;

    await this.runQuery(cypher, {
      tenantId: input.tenantId,
      sourceId: input.sourceEntity,
      sourceLabel: input.sourceLabel || 'Entity',
      targetId: input.targetEntity,
      targetLabel: input.targetLabel || 'Entity',
      weight: input.weight ?? 0.5,
      now,
      validFrom,
      validTo,
      properties: input.properties || {},
    });
  }

  async queryRelations(input: QueryRelationsInput): Promise<QueryRelationsResult> {
    const depth = input.depth ?? this.config.maxTraversalDepth ?? 2;
    const limit = input.limit ?? 100;
    const temporalWhere = input.asOf
      ? '(r.validFrom IS NULL OR r.validFrom <= $asOf) AND (r.validTo IS NULL OR r.validTo >= $asOf)'
      : input.includeInactive
        ? '1 = 1'
        : 'r.validTo IS NULL';

    let matchPattern: string;
    if (input.direction === 'outgoing') {
      matchPattern = '(e)-[r]->(connected)';
    } else if (input.direction === 'incoming') {
      matchPattern = '(connected)-[r]->(e)';
    } else {
      matchPattern = '(e)-[r]-(connected)';
    }

    const cypher = `
      MATCH (e:Entity {id: $entityId, tenantId: $tenantId})
      CALL apoc.path.subgraphAll(e, {
        maxLevel: $depth,
        relationshipFilter: $relationType
      }) YIELD relationships, nodes
      
      UNWIND relationships AS r
      WITH r, startNode(r) AS source, endNode(r) AS target
      WHERE ${temporalWhere}
      
      RETURN DISTINCT
        source.id AS sourceEntity,
        type(r) AS relationType,
        target.id AS targetEntity,
        r.weight AS weight,
        r.createdAt AS createdAt,
        r.updatedAt AS updatedAt,
        r.validFrom AS validFrom,
        r.validTo AS validTo,
        CASE WHEN r.validTo IS NULL THEN true ELSE false END AS current
      LIMIT $limit
    `;

    try {
      const result = await this.runQuery(cypher, {
        entityId: input.entity,
        tenantId: input.tenantId,
        depth,
        relationType: input.relationType || null,
        asOf: input.asOf,
        limit,
      });

      const relations: GraphRelation[] = result.records.map(record => ({
        sourceEntity: record.get('sourceEntity') as string,
        targetEntity: record.get('targetEntity') as string,
        relationType: record.get('relationType') as string,
        weight: (record.get('weight') as number) ?? 0.5,
        createdAt: record.get('createdAt') as string,
        updatedAt: record.get('updatedAt') as string,
        validFrom: (record.get('validFrom') as string | null | undefined) ?? null,
        validTo: (record.get('validTo') as string | null | undefined) ?? null,
        current: Boolean(record.get('current') as boolean | undefined ?? true),
      }));

      // Get unique entity IDs
      const entityIds = new Set<string>();
      entityIds.add(input.entity);
      relations.forEach(r => {
        entityIds.add(r.sourceEntity);
        entityIds.add(r.targetEntity);
      });

      // Fetch entity details
      const entities = await this.fetchEntities(input.tenantId, Array.from(entityIds));

      return {
        relations,
        entities,
        totalCount: relations.length,
      };
    } catch (error) {
      // Fallback for when APOC is not available
      const simpleCypher = `
        MATCH (e:Entity {id: $entityId, tenantId: $tenantId})
        MATCH ${matchPattern}
        WHERE connected.tenantId = $tenantId
        ${input.relationType ? `AND type(r) = $relationType` : ''}
        AND ${temporalWhere}
        RETURN DISTINCT
          CASE WHEN startNode(r) = e THEN e.id ELSE connected.id END AS sourceEntity,
          type(r) AS relationType,
          CASE WHEN endNode(r) = e THEN e.id ELSE connected.id END AS targetEntity,
          r.weight AS weight,
          r.createdAt AS createdAt,
          r.updatedAt AS updatedAt,
          r.validFrom AS validFrom,
          r.validTo AS validTo,
          CASE WHEN r.validTo IS NULL THEN true ELSE false END AS current
        LIMIT $limit
      `;

      const result = await this.runQuery(simpleCypher, {
        entityId: input.entity,
        tenantId: input.tenantId,
        relationType: input.relationType,
        asOf: input.asOf,
        limit,
      });

      const relations: GraphRelation[] = result.records.map(record => ({
        sourceEntity: record.get('sourceEntity') as string,
        targetEntity: record.get('targetEntity') as string,
        relationType: record.get('relationType') as string,
        weight: (record.get('weight') as number) ?? 0.5,
        createdAt: record.get('createdAt') as string,
        updatedAt: record.get('updatedAt') as string,
        validFrom: (record.get('validFrom') as string | null | undefined) ?? null,
        validTo: (record.get('validTo') as string | null | undefined) ?? null,
        current: Boolean(record.get('current') as boolean | undefined ?? true),
      }));

      const entityIds = new Set<string>();
      entityIds.add(input.entity);
      relations.forEach(r => {
        entityIds.add(r.sourceEntity);
        entityIds.add(r.targetEntity);
      });

      const entities = await this.fetchEntities(input.tenantId, Array.from(entityIds));

      return { relations, entities, totalCount: relations.length };
    }
  }

  async invalidateRelation(input: InvalidateRelationInput): Promise<void> {
    const endedAt = input.endedAt ?? new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    const cypher = `
      MATCH (source:Entity {id: $sourceId, tenantId: $tenantId})-[r:${input.relationType}]->(target:Entity {id: $targetId})
      WHERE r.validTo IS NULL
      SET r.validTo = $endedAt,
          r.updatedAt = $now
      RETURN count(r) AS invalidated
    `;

    await this.runQuery(cypher, {
      tenantId: input.tenantId,
      sourceId: input.sourceEntity,
      targetId: input.targetEntity,
      endedAt,
      now,
    });
  }

  async getTimeline(input: GraphTimelineInput): Promise<GraphRelation[]> {
    const cypher = input.entity
      ? `
        MATCH (source:Entity)-[r]->(target:Entity)
        WHERE source.tenantId = $tenantId
          AND (source.id = $entityId OR target.id = $entityId)
        RETURN source.id AS sourceEntity,
               type(r) AS relationType,
               target.id AS targetEntity,
               r.weight AS weight,
               r.createdAt AS createdAt,
               r.updatedAt AS updatedAt,
               r.validFrom AS validFrom,
               r.validTo AS validTo,
               CASE WHEN r.validTo IS NULL THEN true ELSE false END AS current
        ORDER BY coalesce(r.validFrom, r.createdAt) ASC
        LIMIT $limit
      `
      : `
        MATCH (source:Entity {tenantId: $tenantId})-[r]->(target:Entity)
        RETURN source.id AS sourceEntity,
               type(r) AS relationType,
               target.id AS targetEntity,
               r.weight AS weight,
               r.createdAt AS createdAt,
               r.updatedAt AS updatedAt,
               r.validFrom AS validFrom,
               r.validTo AS validTo,
               CASE WHEN r.validTo IS NULL THEN true ELSE false END AS current
        ORDER BY coalesce(r.validFrom, r.createdAt) ASC
        LIMIT $limit
      `;

    const result = await this.runQuery(cypher, {
      tenantId: input.tenantId,
      entityId: input.entity,
      limit: input.limit ?? 100,
    });

    return result.records.map((record) => ({
      sourceEntity: record.get('sourceEntity') as string,
      targetEntity: record.get('targetEntity') as string,
      relationType: record.get('relationType') as string,
      weight: (record.get('weight') as number) ?? 0.5,
      createdAt: record.get('createdAt') as string,
      updatedAt: record.get('updatedAt') as string,
      validFrom: (record.get('validFrom') as string | null | undefined) ?? null,
      validTo: (record.get('validTo') as string | null | undefined) ?? null,
      current: Boolean(record.get('current') as boolean | undefined ?? true),
    }));
  }

  private async fetchEntities(tenantId: TenantId, entityIds: string[]): Promise<GraphEntity[]> {
    if (entityIds.length === 0) return [];

    const cypher = `
      MATCH (e:Entity)
      WHERE e.tenantId = $tenantId AND e.id IN $entityIds
      RETURN e.id AS id, e.label AS label, e.name AS name, e.tenantId AS tenantId, e.userId AS userId
    `;

    const result = await this.runQuery(cypher, { tenantId, entityIds });
    
    return result.records.map(record => ({
      id: record.get('id') as string,
      label: record.get('label') as string,
      name: record.get('name') as string,
      tenantId: record.get('tenantId') as TenantId,
      userId: record.get('userId') as string | undefined,
    }));
  }

  async reinforceRelation(input: {
    tenantId: TenantId;
    sourceEntity: string;
    targetEntity: string;
    relationType: string;
    boostAmount?: number;
  }): Promise<void> {
    const boost = input.boostAmount ?? 0.05;
    const now = new Date().toISOString();

    const cypher = `
      MATCH (source:Entity {id: $sourceId, tenantId: $tenantId})-[r:${input.relationType}]->(target:Entity {id: $targetId})
      SET r.weight = CASE WHEN r.weight + $boost > 1.0 THEN 1.0 ELSE r.weight + $boost END,
          r.updatedAt = $now
    `;

    await this.runQuery(cypher, {
      tenantId: input.tenantId,
      sourceId: input.sourceEntity,
      targetId: input.targetEntity,
      boost,
      now,
    });
  }

  async getEntity(tenantId: TenantId, entityId: string): Promise<GraphEntity | null> {
    const cypher = `
      MATCH (e:Entity {id: $entityId, tenantId: $tenantId})
      RETURN e.id AS id, e.label AS label, e.name AS name, e.tenantId AS tenantId, e.userId AS userId
    `;

    const result = await this.runQuery(cypher, { entityId, tenantId });
    
    if (result.records.length === 0) return null;

    const record = result.records[0];
    return {
      id: record.get('id') as string,
      label: record.get('label') as string,
      name: record.get('name') as string,
      tenantId: record.get('tenantId') as TenantId,
      userId: record.get('userId') as string | undefined,
    };
  }

  async searchEntities(input: {
    tenantId: TenantId;
    query: string;
    label?: string;
    limit?: number;
  }): Promise<GraphEntity[]> {
    const limit = input.limit ?? 10;

    const cypher = `
      MATCH (e:Entity)
      WHERE e.tenantId = $tenantId
        AND (toLower(e.name) CONTAINS toLower($query) OR toLower(e.id) CONTAINS toLower($query))
        ${input.label ? 'AND e.label = $label' : ''}
      RETURN e.id AS id, e.label AS label, e.name AS name, e.tenantId AS tenantId, e.userId AS userId
      LIMIT $limit
    `;

    const result = await this.runQuery(cypher, {
      tenantId: input.tenantId,
      query: input.query,
      label: input.label,
      limit,
    });

    return result.records.map(record => ({
      id: record.get('id') as string,
      label: record.get('label') as string,
      name: record.get('name') as string,
      tenantId: record.get('tenantId') as TenantId,
      userId: record.get('userId') as string | undefined,
    }));
  }

  async pruneWeakRelations(tenantId: TenantId, minWeight: number): Promise<number> {
    const cypher = `
      MATCH (source:Entity {tenantId: $tenantId})-[r]->(target:Entity)
      WHERE r.weight < $minWeight
      DELETE r
      RETURN count(r) AS deleted
    `;

    const result = await this.runQuery(cypher, { tenantId, minWeight });
    return (result.records[0]?.get('deleted') as number) ?? 0;
  }

  async healthCheck(): Promise<boolean> {
    try {
      await this.runQuery('RETURN 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Close the Neo4j driver connection.
   */
  async close(): Promise<void> {
    if (this.driver) {
      await this.driver.close();
      this.driver = null;
    }
  }
}
