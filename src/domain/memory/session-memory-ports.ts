/**
 * Memory-layer interfaces and ports for Phase 11 (Session memory, HSG, Vector).
 *
 * This module defines the core abstractions described in
 * 03-IMPLEMENTATION/phase-11-memory-details/memory-adapter-architecture.md
 * and memory-api-contract.md.
 *
 * Layer: Domain
 */

import type {
  CorrelationId,
  HSGPointer,
  HSGPrimarySector,
  SessionConfig,
  SessionContext,
  SessionId,
  SessionMessage,
  SessionMessageMetadata,
  SessionMetadata,
  TenantId,
  UserId,
  VectorPointer,
  WorkingMemoryEntry,
} from './session-types';

/**
 * Store for session lifecycle and SessionContext persistence/caching.
 */
export interface SessionMemoryStore {
  /**
   * Create or load a session record in a storage/cache layer.
   *
   * Idempotent by {tenant_id, external_session_ref} when provided.
   */
  createSessionRecord(input: {
    tenant_id: TenantId;
    user_id: UserId;
    external_session_ref?: string;
    initial_context?: Record<string, unknown>;
    config_override?: Partial<SessionConfig>;
  }): Promise<{
    session: SessionContext;
    created: boolean;
    loaded_working_memory: number;
  }>;

  /**
   * Load existing session context or return null if not found.
   */
  loadSession(tenant_id: TenantId, session_id: SessionId): Promise<SessionContext | null>;

  /**
   * Persist current SessionContext state.
   */
  saveSession(context: SessionContext): Promise<void>;

  /**
   * Mark session as archived and release any hot caches/resources.
   */
  archiveSession(tenant_id: TenantId, session_id: SessionId): Promise<void>;

  /**
   * Lightweight metadata lookup for diagnostics and MAS.
   */
  getSessionMetadata(tenant_id: TenantId, session_id: SessionId): Promise<SessionMetadata | null>;
}

/**
 * Store for working memory entries (short-term summaries, episodic references,
 * user profile snapshots bound to a session).
 */
export interface WorkingMemoryStore {
  appendWorkingMemoryEntries(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    entries: WorkingMemoryEntry[];
    correlation_id?: CorrelationId;
  }): Promise<void>;

  getWorkingMemory(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    limit?: number;
  }): Promise<WorkingMemoryEntry[]>;

  /**
   * Select top-k working memories for current context using prioritization
   * patterns (recency/importance/relevance/frequency).
   */
  prioritizeWorkingMemory(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    user_id: UserId;
    current_context: string;
    top_k?: number;
  }): Promise<WorkingMemoryEntry[]>;
}

/**
 * Store for long-term semantic memory: user profile, preferences, skills and
 * other cross-session knowledge.
 */
export interface LongTermMemoryStore {
  upsertUserProfileEntries(input: {
    tenant_id: TenantId;
    user_id: UserId;
    entries: WorkingMemoryEntry[];
    correlation_id?: CorrelationId;
  }): Promise<void>;

  /**
   * Query long-term user context (profile/preferences/skills) for enriching
   * a newly created or active session.
   */
  queryLongTermContext(input: {
    tenant_id: TenantId;
    user_id: UserId;
    query: string;
    limit?: number;
  }): Promise<WorkingMemoryEntry[]>;

  /**
   * Aggregated timeline of messages and consolidations for diagnostics and
   * migration tooling.
   */
  getSessionTimeline(input: {
    tenant_id: TenantId;
    session_id: SessionId;
  }): Promise<SessionMessage[]>;
}

/**
 * Input payload for adding a node to an HSG sector.
 */
export interface HSGAddToSectorInput {
  tenant_id: TenantId;
  user_id?: UserId;
  session_id?: SessionId;
  primary_sector: HSGPrimarySector;
  sectors?: string[];
  content: string;
  metadata?: Record<string, unknown>;
  correlation_id?: CorrelationId;
}

export interface HSGQueryInput {
  tenant_id: TenantId;
  user_id?: UserId;
  session_id?: SessionId;
  sector?: HSGPrimarySector | HSGPrimarySector[];
  query: string;
  filters?: Record<string, unknown>;
  limit?: number;
  correlation_id?: CorrelationId;
}

export interface HSGQueryResultItem {
  pointer: HSGPointer;
  score: number;
  content: string;
  metadata: Record<string, unknown>;
}

export interface HSGClient {
  addToSector(input: HSGAddToSectorInput): Promise<HSGPointer>;

  getMemory(input: {
    tenant_id: TenantId;
    hsg_id: string;
    correlation_id?: CorrelationId;
  }): Promise<{
    pointer: HSGPointer;
    content: string;
    metadata: Record<string, unknown>;
  } | null>;

  query(input: HSGQueryInput): Promise<HSGQueryResultItem[]>;

  createRelationship(input: {
    tenant_id: TenantId;
    source_id: string;
    target_id: string;
    relationship: string;
    weight?: number;
    metadata?: Record<string, unknown>;
    correlation_id?: CorrelationId;
  }): Promise<void>;
}

export interface VectorUpsertInput {
  tenant_id: TenantId;
  user_id?: UserId;
  session_id?: SessionId;
  collection: string;
  vector: number[];
  payload: Record<string, unknown>;
  correlation_id?: CorrelationId;
}

export interface VectorSearchInput {
  tenant_id: TenantId;
  user_id?: UserId;
  session_id?: SessionId;
  collection: string;
  query_vector: number[];
  filters?: Record<string, unknown>;
  limit?: number;
  correlation_id?: CorrelationId;
}

export interface VectorSearchResultItem {
  pointer: VectorPointer;
  score: number;
  payload: Record<string, unknown>;
}

export interface VectorClient {
  upsertVector(input: VectorUpsertInput): Promise<VectorPointer>;
  search(input: VectorSearchInput): Promise<VectorSearchResultItem[]>;
}

export interface SectorClassificationResult {
  primary_sector: HSGPrimarySector;
  sectors: string[];
  confidence: number;
}

export interface SectorClassifier {
  classify(input: {
    content: string;
    tenant_id?: TenantId;
    user_id?: UserId;
    session_id?: SessionId;
    correlation_id?: CorrelationId;
  }): Promise<SectorClassificationResult>;
}

export type MemoryRoutingTarget = 'hsg' | 'vector' | 'hsg+vector' | 'none';

export type MemoryEntryKind =
  | 'episodic'
  | 'reflective'
  | 'user_profile'
  | 'preference'
  | 'knowledge';

export interface RoutingDecision {
  target: MemoryRoutingTarget;
  vector_collection?: string;
  hsg_primary_sector?: HSGPrimarySector;
  additional_sectors?: string[];
}

export interface MemoryRoutingPolicy {
  decideForMessage(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    user_id?: UserId;
    role: SessionMessage['role'];
    content: string;
    metadata?: SessionMessageMetadata;
    correlation_id?: CorrelationId;
  }): Promise<RoutingDecision>;

  decideForWorkingMemoryEntry(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    user_id?: UserId;
    entry: WorkingMemoryEntry;
    correlation_id?: CorrelationId;
  }): Promise<RoutingDecision>;
}