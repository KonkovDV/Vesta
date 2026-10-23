/**
 * IMem0Provider — Domain port for Mem0 memory provider.
 *
 * Defines the unified interface for Mem0 SDK operations (Platform + OSS modes).
 * Infrastructure layer implements this contract via UnifiedMem0Provider.
 *
 * Extracted from infrastructure/memory/provider/UnifiedMem0Provider.ts
 * to enforce Clean Architecture layer boundaries (Application→Domain, not Application→Infrastructure).
 *
 * @module domain/memory
 * @layer Domain
 */

import type { EnhancedMemoryResult, MemoryAddResult } from './MemoryScope';

// ── SDK Option Interfaces ──────────────────────────────────────────

/** Options for add operations. Extended with all Mem0 SDK parameters. */
export interface Mem0AddOptions {
  user_id: string;
  run_id?: string;
  agent_id?: string;
  app_id?: string;
  custom_instructions?: string;
  custom_categories?: Array<Record<string, string>>;
  enable_graph?: boolean;
  output_format?: string;
  source?: string;
  /** Key-value metadata to attach to the memory. */
  metadata?: Record<string, unknown>;
  /** If false, store raw text without LLM extraction. Default: true. */
  infer?: boolean;
  /** Auto-expire date in "YYYY-MM-DD" format. Platform only. */
  expiration_date?: string;
  /** Custom Unix epoch timestamp for the memory. */
  timestamp?: number;
  /** Fire-and-forget (non-blocking) mode. Platform only. */
  async_mode?: boolean;
  /** Mark memory as immutable (cannot be updated/merged). */
  immutable?: boolean;
  /** v2 JSON filters with AND/OR/NOT operators. */
  filters?: Record<string, unknown>;
  /** API version: "v1" or "v2" (contextual add). */
  api_version?: string;
}

/** Options for search operations. Extended with all Mem0 SDK parameters. */
export interface Mem0SearchOptions {
  user_id: string;
  run_id?: string;
  agent_id?: string;
  app_id?: string;
  top_k?: number;
  threshold?: number;
  limit?: number;
  keyword_search?: boolean;
  reranking?: boolean;
  source?: string;
  /** Enable graph-based entity search. Platform only. */
  enable_graph?: boolean;
  /** Server-side precision filtering. Adds ~200-300ms latency. */
  filter_memories?: boolean;
  /** v2 JSON filters with AND/OR/NOT operators. */
  filters?: Record<string, unknown>;
  /** Filter by memory categories. */
  categories?: string[];
  /** Select specific fields in results. */
  fields?: string[];
  /** Search only by metadata, skip semantic search. */
  only_metadata_based_search?: boolean;
  /** API version: "v1" or "v2". */
  api_version?: string;
}

/** Options for list operations. Extended with all Mem0 SDK parameters. */
export interface Mem0ListOptions {
  user_id: string;
  run_id?: string;
  agent_id?: string;
  app_id?: string;
  page?: number;
  page_size?: number;
  source?: string;
  /** v2 JSON filters with AND/OR/NOT operators. */
  filters?: Record<string, unknown>;
  /** Include memories matching pattern. */
  includes?: string;
  /** Exclude memories matching pattern. */
  excludes?: string;
  /** Filter memories from this date (ISO string). */
  start_date?: string;
  /** Filter memories until this date (ISO string). */
  end_date?: string;
  /** API version: "v1" or "v2". */
  api_version?: string;
}

/** Options for update operations. */
export interface Mem0UpdateOptions {
  text?: string;
  metadata?: Record<string, unknown>;
  timestamp?: number | string;
}

/** Feedback type for memory quality signals. */
export type Mem0FeedbackType = 'POSITIVE' | 'NEGATIVE' | 'VERY_NEGATIVE';

/** Options for feedback on a memory. */
export interface Mem0FeedbackOptions {
  memory_id: string;
  feedback: Mem0FeedbackType;
  feedback_reason?: string;
}

/** Memory history entry — tracks changes over time. */
export interface Mem0HistoryEntry {
  id: string;
  memory_id: string;
  old_memory: string | null;
  new_memory: string | null;
  event: string;
  created_at?: string;
  updated_at?: string;
}

/** Entity (user/agent/app/run) info from the entities endpoint. */
export interface Mem0Entity {
  id: string;
  name: string;
  type: string;
  total_memories: number;
  created_at?: string;
  updated_at?: string;
}

/** Batch update item. */
export interface Mem0BatchUpdateItem {
  memoryId: string;
  text: string;
}

// ── Unified Provider Interface ─────────────────────────────────────

/**
 * Unified Mem0 provider interface — full SDK surface.
 * Covers all 24 Mem0 features: CRUD, graph, feedback, batch, history, export.
 *
 * Domain port — implemented by infrastructure UnifiedMem0Provider.
 */
export interface IMem0Provider {
  // ── Core CRUD ────────────────────────────────────────────────────
  add(
    messages: Array<{ role: string; content: string }>,
    options: Mem0AddOptions,
  ): Promise<MemoryAddResult>;

  search(query: string, options: Mem0SearchOptions): Promise<EnhancedMemoryResult[]>;

  get(memoryId: string): Promise<EnhancedMemoryResult>;

  getAll(options: Mem0ListOptions): Promise<EnhancedMemoryResult[]>;

  delete(memoryId: string): Promise<void>;

  // ── Extended Operations (Platform only) ──────────────────────────

  /** Update memory text, metadata, or timestamp. */
  update(memoryId: string, options: Mem0UpdateOptions): Promise<EnhancedMemoryResult>;

  /** Delete all memories matching the given scope. */
  deleteAll(options: Mem0ListOptions): Promise<void>;

  /** Get change history for a specific memory. */
  history(memoryId: string): Promise<Mem0HistoryEntry[]>;

  /** Send quality feedback (POSITIVE/NEGATIVE/VERY_NEGATIVE) on a memory. */
  feedback(options: Mem0FeedbackOptions): Promise<void>;

  /** Batch update up to 1000 memories at once. */
  batchUpdate(items: Mem0BatchUpdateItem[]): Promise<void>;

  /** Batch delete up to 1000 memories at once. */
  batchDelete(memoryIds: string[]): Promise<void>;
}
