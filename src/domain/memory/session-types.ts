/**
 * Session-related types for Memory layer (Phase 11).
 *
 * This file is the TypeScript counterpart of the Session Memory API contract
 * described in 03-IMPLEMENTATION/phase-11-memory-details/memory-api-contract.md
 * and patterns in 03-IMPLEMENTATION/phase-11-memory-details/session-management-guide.md.
 *
 * Layer: Domain
 */

export type TenantId = string;
export type UserId = string;
export type SessionId = string;
export type CorrelationId = string;

export type SessionRole = 'user' | 'assistant' | 'system' | 'tool';
export type SessionModality = 'text' | 'image' | 'audio' | 'video' | 'mixed';

export interface PolicyBudget {
  tokens?: number;
  usd?: number;
}

export type PolicySensitivity = 'public' | 'internal' | 'confidential' | 'restricted';

export interface PolicyMetadata {
  /**
   * Optional budget limits for this operation (tokens / USD).
   */
  budget?: PolicyBudget;
  /**
   * Sensitivity / classification level for the content.
   */
  sensitivity?: PolicySensitivity;
  /**
   * Policy decisions that affected this operation (allow/deny, redactions, etc.).
   */
  decisions?: string[];
  /**
   * Internal engine tags for routing / policy engines (no concrete engine names here).
   */
  engine_tags?: string[];
}

export interface SessionMessageMetadata extends Record<string, unknown> {
  /**
   * Optional structured policy metadata stored under metadata.policy in the contract.
   */
  policy?: PolicyMetadata;
}

export interface SessionMessage {
  message_id: string;
  session_id: SessionId;
  tenant_id: TenantId;
  user_id?: UserId;
  role: SessionRole;
  modality: SessionModality;
  content: string;
  /**
   * ISO8601 timestamp string.
   */
  created_at: string;
  /**
   * Number of tokens in content for the target LLM.
   */
  token_count: number;
  /**
   * Arbitrary metadata, including optional policy information.
   */
  metadata: SessionMessageMetadata;
}

export type HSGPrimarySector =
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'emotional'
  | 'reflective';

export interface HSGPointer {
  primary_sector: HSGPrimarySector;
  sectors: string[];
  hsg_id: string;
  graph_tags?: string[];
}

export interface VectorPointer {
  /**
   * Logical collection name in the vector store (e.g. "session_memories", "user_profile").
   */
  collection: string;
  vector_id: string;
  embedding_dim?: number;
}

export type WorkingMemoryEntryType =
  | 'consolidated_context'
  | 'episodic_reference'
  | 'user_profile'
  | 'preference';

export interface WorkingMemoryEntry {
  type: WorkingMemoryEntryType;
  /**
   * Human-readable summary or description.
   */
  summary: string;
  /**
   * Number of original messages that were consolidated into this entry (if applicable).
   */
  original_count?: number;
  /**
   * ISO8601 timestamp string representing when this entry was created.
   */
  timestamp: string;
  /**
   * Importance score in range [0, 1].
   */
  importance: number;
  /**
   * Decayed salience score in range [0, 1].
   * Starts equal to importance, decays over time based on sector.
   * Used for memory prioritization.
   */
  salience?: number;
  /**
   * ISO8601 timestamp of last access/retrieval.
   * Used for decay calculation.
   */
  last_seen_at?: string;
  /**
   * Optional pointer to the corresponding node in HSG.
   */
  hsg_pointer?: HSGPointer;
  /**
   * Optional pointer to the corresponding vector record.
   */
  vector_pointer?: VectorPointer;
  /**
   * Optional arbitrary metadata for extension.
   */
  metadata?: Record<string, unknown>;
}

export interface SessionConfig {
  /**
   * Hard limit on number of tokens in the active context window.
   */
  max_context_tokens: number;
  /**
   * Threshold of tokens after which consolidation should be triggered.
   */
  consolidation_threshold: number;
  /**
   * Upper bound for number of messages in the context window.
   */
  max_messages: number;
  /**
   * Whether sliding window pattern is enabled for this session.
   */
  sliding_window: boolean;
  /**
   * Whether additional compression of historical context is enabled.
   */
  enable_compression: boolean;
  /**
   * Retention policy in days for this session.
   */
  retention_days: number;
}

export enum SessionState {
  INITIALIZING = 'initializing',
  ACTIVE = 'active',
  CONSOLIDATING = 'consolidating',
  ARCHIVED = 'archived',
  ERROR = 'error',
}

export interface SessionMetadata {
  session_id: SessionId;
  tenant_id: TenantId;
  user_id: UserId;
  /**
   * ISO8601 timestamp when the session was started.
   */
  started_at: string;
  /**
   * ISO8601 timestamp of the last activity in the session.
   */
  last_activity: string;
  message_count: number;
  total_tokens: number;
  state: SessionState;
  /**
   * Optional high-level summary of the current session context.
   */
  context_summary?: string;
}

/**
 * In-memory representation of a session used by SessionMemoryManager
 * and SessionMemoryStore.
 */
export interface SessionContext {
  metadata: SessionMetadata;
  /**
   * Sliding window of recent messages for this session.
   */
  context_window: SessionMessage[];
  /**
   * Working memory entries (summaries, user profile, preferences, etc.).
   */
  working_memory: WorkingMemoryEntry[];
  /**
   * Effective configuration for this session.
   */
  config: SessionConfig;
}