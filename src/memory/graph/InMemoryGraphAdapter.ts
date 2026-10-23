/**
 * In-Memory Graph Adapter — fallback for development/testing.
 * 
 * Stores entities and relationships in memory.
 * Not suitable for production, use Neo4jGraphAdapter instead.
 * 
 * Layer: Memory/Infrastructure
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
} from './types';
import type { TenantId } from '../../domain/memory/session-types';

/**
 * In-memory storage for graph data.
 */
interface GraphStore {
  entities: Map<string, GraphEntity>;
  relations: GraphRelation[];
}

export class InMemoryGraphAdapter implements IGraphMemoryAdapter {
  private stores: Map<TenantId, GraphStore> = new Map();

  private static readonly ACTIVE_VALID_TO: null = null;

  private getStore(tenantId: TenantId): GraphStore {
    let store = this.stores.get(tenantId);
    if (!store) {
      store = { entities: new Map(), relations: [] };
      this.stores.set(tenantId, store);
    }
    return store;
  }

  private makeEntityKey(tenantId: TenantId, entityId: string): string {
    return `${tenantId}:${entityId}`;
  }

  private normalizeRelation(relation: GraphRelation): GraphRelation {
    return {
      ...relation,
      validFrom: relation.validFrom ?? null,
      validTo: relation.validTo ?? InMemoryGraphAdapter.ACTIVE_VALID_TO,
      current: relation.validTo == null,
    };
  }

  private isRelationVisible(relation: GraphRelation, input: QueryRelationsInput): boolean {
    const normalized = this.normalizeRelation(relation);

    if (input.asOf) {
      const startsBefore = normalized.validFrom == null || normalized.validFrom <= input.asOf;
      const endsAfter = normalized.validTo == null || normalized.validTo >= input.asOf;
      return startsBefore && endsAfter;
    }

    if (input.includeInactive) {
      return true;
    }

    return normalized.validTo == null;
  }

  async addRelation(input: AddRelationInput): Promise<void> {
    const store = this.getStore(input.tenantId);
    const now = new Date().toISOString();

    // Create source entity if not exists
    const sourceKey = this.makeEntityKey(input.tenantId, input.sourceEntity);
    if (!store.entities.has(sourceKey)) {
      store.entities.set(sourceKey, {
        id: input.sourceEntity,
        label: input.sourceLabel || 'Entity',
        name: input.sourceEntity,
        tenantId: input.tenantId,
        userId: input.userId,
      });
    }

    // Create target entity if not exists
    const targetKey = this.makeEntityKey(input.tenantId, input.targetEntity);
    if (!store.entities.has(targetKey)) {
      store.entities.set(targetKey, {
        id: input.targetEntity,
        label: input.targetLabel || 'Entity',
        name: input.targetEntity,
        tenantId: input.tenantId,
        userId: input.userId,
      });
    }

    // Check if relation already exists
    const existingIndex = store.relations.findIndex(
      r =>
        r.sourceEntity === input.sourceEntity &&
        r.targetEntity === input.targetEntity &&
        r.relationType === input.relationType &&
        r.validTo == null
    );

    if (existingIndex >= 0) {
      // Update existing relation
      store.relations[existingIndex] = {
        ...store.relations[existingIndex],
        weight: input.weight ?? store.relations[existingIndex].weight,
        updatedAt: now,
        validFrom: input.validFrom ?? store.relations[existingIndex].validFrom ?? null,
        validTo: input.validTo ?? store.relations[existingIndex].validTo ?? null,
        current: (input.validTo ?? store.relations[existingIndex].validTo) == null,
        properties: { ...store.relations[existingIndex].properties, ...input.properties },
      };
    } else {
      // Create new relation
      store.relations.push({
        sourceEntity: input.sourceEntity,
        targetEntity: input.targetEntity,
        relationType: input.relationType,
        weight: input.weight ?? 0.5,
        createdAt: now,
        updatedAt: now,
        validFrom: input.validFrom ?? now.slice(0, 10),
        validTo: input.validTo ?? InMemoryGraphAdapter.ACTIVE_VALID_TO,
        current: input.validTo == null,
        properties: input.properties,
      });
    }
  }

  async queryRelations(input: QueryRelationsInput): Promise<QueryRelationsResult> {
    const store = this.getStore(input.tenantId);
    const depth = input.depth ?? 1;
    const limit = input.limit ?? 100;
    const direction = input.direction ?? 'both';

    const visitedEntities = new Set<string>();
    const resultRelations: GraphRelation[] = [];
    const queue: { entity: string; currentDepth: number }[] = [{ entity: input.entity, currentDepth: 0 }];

    while (queue.length > 0 && resultRelations.length < limit) {
      const { entity, currentDepth } = queue.shift()!;
      if (currentDepth >= depth) continue;

      const outgoing = direction !== 'incoming' 
        ? store.relations.filter(r => 
            r.sourceEntity === entity &&
            (!input.relationType || r.relationType === input.relationType) &&
            this.isRelationVisible(r, input)
          )
        : [];

      const incoming = direction !== 'outgoing'
        ? store.relations.filter(r =>
            r.targetEntity === entity &&
            (!input.relationType || r.relationType === input.relationType) &&
            this.isRelationVisible(r, input)
          )
        : [];

      for (const rel of [...outgoing, ...incoming]) {
        if (resultRelations.length >= limit) break;
        
        const relKey = `${rel.sourceEntity}-${rel.relationType}-${rel.targetEntity}`;
        if (!visitedEntities.has(relKey)) {
          visitedEntities.add(relKey);
          resultRelations.push(this.normalizeRelation(rel));

          // Add connected entity to queue for deeper traversal
          const nextEntity = rel.sourceEntity === entity ? rel.targetEntity : rel.sourceEntity;
          if (!visitedEntities.has(nextEntity)) {
            queue.push({ entity: nextEntity, currentDepth: currentDepth + 1 });
          }
        }
      }
    }

    // Collect unique entities
    const entityIds = new Set<string>();
    entityIds.add(input.entity);
    for (const rel of resultRelations) {
      entityIds.add(rel.sourceEntity);
      entityIds.add(rel.targetEntity);
    }

    const entities: GraphEntity[] = [];
    for (const id of entityIds) {
      const entity = store.entities.get(this.makeEntityKey(input.tenantId, id));
      if (entity) entities.push(entity);
    }

    return {
      relations: resultRelations,
      entities,
      totalCount: resultRelations.length,
    };
  }

  async invalidateRelation(input: InvalidateRelationInput): Promise<void> {
    const store = this.getStore(input.tenantId);
    const endedAt = input.endedAt ?? new Date().toISOString().slice(0, 10);
    const updatedAt = new Date().toISOString();

    for (const relation of store.relations) {
      if (
        relation.sourceEntity === input.sourceEntity &&
        relation.targetEntity === input.targetEntity &&
        relation.relationType === input.relationType &&
        relation.validTo == null
      ) {
        relation.validTo = endedAt;
        relation.updatedAt = updatedAt;
        relation.current = false;
      }
    }
  }

  async getTimeline(input: GraphTimelineInput): Promise<GraphRelation[]> {
    const store = this.getStore(input.tenantId);
    const filtered = store.relations
      .filter((relation) => {
        if (!input.entity) {
          return true;
        }

        return relation.sourceEntity === input.entity || relation.targetEntity === input.entity;
      })
      .map((relation) => this.normalizeRelation(relation))
      .sort((left, right) => {
        const leftKey = left.validFrom ?? left.createdAt;
        const rightKey = right.validFrom ?? right.createdAt;
        return leftKey.localeCompare(rightKey);
      });

    return filtered.slice(0, input.limit ?? filtered.length);
  }

  async reinforceRelation(input: {
    tenantId: TenantId;
    sourceEntity: string;
    targetEntity: string;
    relationType: string;
    boostAmount?: number;
  }): Promise<void> {
    const store = this.getStore(input.tenantId);
    const boost = input.boostAmount ?? 0.05;

    const relation = store.relations.find(
      r =>
        r.sourceEntity === input.sourceEntity &&
        r.targetEntity === input.targetEntity &&
        r.relationType === input.relationType
    );

    if (relation) {
      relation.weight = Math.min(1.0, relation.weight + boost);
      relation.updatedAt = new Date().toISOString();
    }
  }

  async getEntity(tenantId: TenantId, entityId: string): Promise<GraphEntity | null> {
    const store = this.getStore(tenantId);
    return store.entities.get(this.makeEntityKey(tenantId, entityId)) ?? null;
  }

  async searchEntities(input: {
    tenantId: TenantId;
    query: string;
    label?: string;
    limit?: number;
  }): Promise<GraphEntity[]> {
    const store = this.getStore(input.tenantId);
    const limit = input.limit ?? 10;
    const queryLower = input.query.toLowerCase();

    const results: GraphEntity[] = [];
    for (const entity of store.entities.values()) {
      if (results.length >= limit) break;
      
      const matchesQuery = entity.name.toLowerCase().includes(queryLower) ||
        entity.id.toLowerCase().includes(queryLower);
      const matchesLabel = !input.label || entity.label === input.label;
      
      if (matchesQuery && matchesLabel) {
        results.push(entity);
      }
    }

    return results;
  }

  async pruneWeakRelations(tenantId: TenantId, minWeight: number): Promise<number> {
    const store = this.getStore(tenantId);
    const originalCount = store.relations.length;
    store.relations = store.relations.filter(r => r.weight >= minWeight);
    return originalCount - store.relations.length;
  }

  async healthCheck(): Promise<boolean> {
    return true;
  }

  /**
   * Clear all data for a tenant (for testing).
   */
  clearTenant(tenantId: TenantId): void {
    this.stores.delete(tenantId);
  }

  /**
   * Clear all data (for testing).
   */
  clearAll(): void {
    this.stores.clear();
  }
}
