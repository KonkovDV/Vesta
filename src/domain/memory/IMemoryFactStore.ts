/**
 * Bitemporal fact store.
 * Layer: Domain
 *
 * recordProposed is the only write. Callers reach it with a MemoryFactProposed
 * event that has already been appended to the event store.
 */

import type { DomainEvent } from '../events/event-store.interface';

export type MemoryFactGateReason =
  | 'missing_source'
  | 'low_confidence'
  | 'untrusted_unconfirmed'
  | 'invalid_payload';

export interface MemoryFactProposalInput {
  tenantId: string;
  userId: string;
  source: string;
  relationship: string;
  destination: string;
  /** Upstream message, run, or tool event. Required provenance before the proposal event exists. */
  originEventId: string;
  /** 0..1. Below MEMORY_FACT_MIN_CONFIDENCE the proposal needs confirmed. */
  confidence: number;
  weight?: number;
  /** Human accepted a low-confidence fact or text taken from an untrusted marker. */
  confirmed?: boolean;
  /** Checked for an untrusted marker and then discarded. It is not stored. */
  evidence?: string;
  validFrom?: string | null;
  validTo?: string | null;
  correlationId?: string;
}

export interface MemoryFactRecord {
  id: string;
  tenantId: string;
  userId: string;
  source: string;
  relationship: string;
  destination: string;
  weight: number;
  validFrom: string | null;
  validTo: string | null;
  recordedAt: string;
  invalidatedAt: string | null;
  supersededBy: string | null;
  sourceEventId: string;
  current: boolean;
}

export interface MemoryFactQuery {
  tenantId: string;
  userId: string;
  entity?: string;
  limit?: number;
}

export type MemoryFactWriteResult =
  | {
      written: true;
      fact: MemoryFactRecord;
      /** Open row closed by this call. Null when the event was already stored. */
      supersededId: string | null;
    }
  | { written: false; reason: MemoryFactGateReason };

export interface IMemoryFactStore {
  recordProposed(event: DomainEvent): Promise<MemoryFactWriteResult>;
  findOpen(query: MemoryFactQuery): Promise<MemoryFactRecord[]>;
}
