/**
 * In-memory memory_facts writer for a process that has no database.
 * Layer: Infrastructure
 *
 * Same gate and supersede rules as PostgresMemoryFactStore.
 */

import { IdGenerator } from '../../core/utils/IdGenerator';
import type { DomainEvent } from '../../domain/events/event-store.interface';
import type {
  IMemoryFactStore,
  MemoryFactQuery,
  MemoryFactRecord,
  MemoryFactWriteResult,
} from '../../domain/memory/IMemoryFactStore';
import {
  assessMemoryFactEvent,
  memoryFactOpenLimit,
} from '../../domain/memory/memory-fact-policy';

export class InMemoryMemoryFactStore implements IMemoryFactStore {
  private readonly facts: MemoryFactRecord[] = [];

  async recordProposed(event: DomainEvent): Promise<MemoryFactWriteResult> {
    const assessed = assessMemoryFactEvent(event);
    if (!assessed.ok) {
      return { written: false, reason: assessed.reason };
    }

    const existing = this.facts.find((fact) => fact.sourceEventId === event.eventId);
    if (existing) {
      return { written: true, fact: copyFact(existing), supersededId: null };
    }

    const payload = assessed.value;
    const now = new Date().toISOString();
    const openIndex = this.facts.findIndex((fact) =>
      fact.current
      && fact.tenantId === payload.tenantId
      && fact.userId === payload.userId
      && fact.source === payload.source
      && fact.relationship === payload.relationship
      && fact.destination === payload.destination,
    );

    const created: MemoryFactRecord = {
      id: IdGenerator.generate(),
      tenantId: payload.tenantId,
      userId: payload.userId,
      source: payload.source,
      relationship: payload.relationship,
      destination: payload.destination,
      weight: payload.weight,
      validFrom: payload.validFrom,
      validTo: payload.validTo,
      recordedAt: now,
      invalidatedAt: null,
      supersededBy: null,
      sourceEventId: event.eventId,
      current: true,
    };

    let supersededId: string | null = null;
    if (openIndex >= 0) {
      const previous = this.facts[openIndex];
      supersededId = previous.id;
      this.facts[openIndex] = {
        ...previous,
        current: false,
        invalidatedAt: previous.recordedAt > now ? previous.recordedAt : now,
        supersededBy: created.id,
      };
    }

    this.facts.push(created);
    return { written: true, fact: copyFact(created), supersededId };
  }

  async findOpen(query: MemoryFactQuery): Promise<MemoryFactRecord[]> {
    const tenantId = query.tenantId.trim();
    const userId = query.userId.trim();
    if (tenantId.length === 0 || userId.length === 0) return [];

    const limit = memoryFactOpenLimit(query.limit);
    if (limit === 0) return [];

    const entity = query.entity?.trim() ?? '';
    return this.facts
      .filter((fact) =>
        fact.current
        && fact.tenantId === tenantId
        && fact.userId === userId
        && (entity.length === 0
          || fact.source === entity
          || fact.relationship === entity
          || fact.destination === entity),
      )
      .sort((left, right) => right.recordedAt.localeCompare(left.recordedAt))
      .slice(0, limit)
      .map(copyFact);
  }
}

function copyFact(fact: MemoryFactRecord): MemoryFactRecord {
  return { ...fact };
}
