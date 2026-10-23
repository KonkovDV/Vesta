/**
 * Memory Distillation Types — extracted from legacy Mem0Adapter.
 *
 * These types define the contract for fact distillation (extracting
 * structured facts from conversation messages). Originally part of
 * Mem0Adapter (HTTP client), now standalone domain-level types.
 *
 * @module domain/memory
 */

import type { SessionMessage, TenantId, UserId, SessionId } from './session-types';

/**
 * A single distilled fact extracted from conversation messages.
 */
export interface DistilledFact {
  id: string;
  text: string;
  event: 'ADD' | 'UPDATE' | 'DELETE' | 'NONE';
  old_memory?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Interface for memory distillation (fact extraction from messages).
 */
export interface IMemoryDistiller {
  addMemories(input: {
    tenant_id: TenantId;
    user_id: UserId;
    session_id: SessionId;
    messages: SessionMessage[];
  }): Promise<DistilledFact[]>;

  searchFacts(input: {
    tenant_id: TenantId;
    user_id: UserId;
    session_id?: SessionId;
    query: string;
    limit?: number;
  }): Promise<DistilledFact[]>;
}
