/**
 * PostgreSQL writer for memory_facts (migration 013).
 * Layer: Infrastructure
 *
 * Inserts a row only for a MemoryFactProposed event. A new open triple
 * closes the previous one in the same transaction.
 */

import type { DomainEvent } from '../../domain/events/event-store.interface';
import type {
  IMemoryFactStore,
  MemoryFactQuery,
  MemoryFactRecord,
  MemoryFactWriteResult,
} from '../../domain/memory/IMemoryFactStore';
import type { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import type { MemoryFactProposedPayload } from '../../core/events/memory-fact.schemas';
import {
  assessMemoryFactEvent,
  memoryFactOpenLimit,
} from '../../domain/memory/memory-fact-policy';

interface MemoryFactRow {
  id: string;
  tenant_id: string;
  user_id: string;
  source: string;
  relationship: string;
  destination: string;
  weight: number | string;
  valid_from: Date | string | null;
  valid_to: Date | string | null;
  recorded_at: Date | string;
  invalidated_at: Date | string | null;
  superseded_by: string | null;
  source_event_id: string;
}

type FactDb = Pick<IDatabaseConnection, 'query' | 'execute' | 'transaction'>;

const SELECT_COLUMNS = `
  id, tenant_id, user_id, source, relationship, destination, weight,
  valid_from, valid_to, recorded_at, invalidated_at, superseded_by, source_event_id
`;

export class PostgresMemoryFactStore implements IMemoryFactStore {
  constructor(private readonly db: FactDb) {}

  async recordProposed(event: DomainEvent): Promise<MemoryFactWriteResult> {
    const assessed = assessMemoryFactEvent(event);
    if (!assessed.ok) {
      return { written: false, reason: assessed.reason };
    }

    try {
      const written = await this.writeOnce(event.eventId, assessed.value);
      return { written: true, fact: written.fact, supersededId: written.supersededId };
    } catch (error) {
      if (!isOpenTripleConflict(error)) throw error;
    }

    const retried = await this.writeOnce(event.eventId, assessed.value);
    return { written: true, fact: retried.fact, supersededId: retried.supersededId };
  }

  async findOpen(query: MemoryFactQuery): Promise<MemoryFactRecord[]> {
    const tenantId = query.tenantId.trim();
    const userId = query.userId.trim();
    if (tenantId.length === 0 || userId.length === 0) return [];

    const limit = memoryFactOpenLimit(query.limit);
    if (limit === 0) return [];

    const entity = query.entity?.trim() ?? '';
    const result = await this.db.query<MemoryFactRow>(
      `SELECT ${SELECT_COLUMNS}
       FROM memory_facts
       WHERE tenant_id = $1
         AND user_id = $2
         AND invalidated_at IS NULL
         AND ($3::text IS NULL OR source = $3 OR relationship = $3 OR destination = $3)
       ORDER BY recorded_at DESC
       LIMIT $4`,
      [tenantId, userId, entity.length === 0 ? null : entity, limit],
    );

    return result.rows.map(mapRow);
  }

  private async writeOnce(
    eventId: string,
    payload: MemoryFactProposedPayload,
  ): Promise<{ fact: MemoryFactRecord; supersededId: string | null }> {
    return this.db.transaction(async () => {
      const existing = await this.db.query<MemoryFactRow>(
        `SELECT ${SELECT_COLUMNS}
         FROM memory_facts
         WHERE source_event_id = $1
         LIMIT 1`,
        [eventId],
      );
      const already = existing.rows[0];
      if (already) {
        return { fact: mapRow(already), supersededId: null };
      }

      const open = await this.db.query<{ id: string }>(
        `SELECT id
         FROM memory_facts
         WHERE tenant_id = $1
           AND user_id = $2
           AND source = $3
           AND relationship = $4
           AND destination = $5
           AND invalidated_at IS NULL
         FOR UPDATE`,
        [payload.tenantId, payload.userId, payload.source, payload.relationship, payload.destination],
      );
      const previousId = open.rows[0]?.id ?? null;
      if (previousId) {
        await this.db.execute(
          `UPDATE memory_facts
           SET invalidated_at = GREATEST(now(), recorded_at)
           WHERE id = $1 AND invalidated_at IS NULL`,
          [previousId],
        );
      }

      const inserted = await this.db.query<MemoryFactRow>(
        `INSERT INTO memory_facts (
           tenant_id, user_id, source, relationship, destination, weight,
           valid_from, valid_to, source_event_id
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${SELECT_COLUMNS}`,
        [
          payload.tenantId,
          payload.userId,
          payload.source,
          payload.relationship,
          payload.destination,
          payload.weight,
          payload.validFrom,
          payload.validTo,
          eventId,
        ],
      );
      const row = inserted.rows[0];
      if (!row) {
        throw new Error('memory_facts insert returned no row');
      }

      if (previousId) {
        await this.db.execute(
          `UPDATE memory_facts SET superseded_by = $1 WHERE id = $2`,
          [row.id, previousId],
        );
      }

      return { fact: mapRow(row), supersededId: previousId };
    });
  }
}

function mapRow(row: MemoryFactRow): MemoryFactRecord {
  const weight = typeof row.weight === 'number' ? row.weight : Number(row.weight);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    source: row.source,
    relationship: row.relationship,
    destination: row.destination,
    weight: Number.isFinite(weight) ? weight : 0,
    validFrom: asIso(row.valid_from),
    validTo: asIso(row.valid_to),
    recordedAt: asIso(row.recorded_at) ?? new Date(0).toISOString(),
    invalidatedAt: asIso(row.invalidated_at),
    supersededBy: row.superseded_by,
    sourceEventId: row.source_event_id,
    current: row.invalidated_at == null,
  };
}

function asIso(value: Date | string | null): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function isOpenTripleConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('uq_memory_facts_open_triple');
}
