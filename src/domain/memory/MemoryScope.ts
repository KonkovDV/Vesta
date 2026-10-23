/**
 * MemoryScope — Value Object for memory scope discrimination.
 *
 * Defines whether a memory operation targets session-scoped (ephemeral),
 * long-term (user-scoped persistent), or both scopes simultaneously.
 *
 * @module domain/memory
 * @phase Phase 1 — Foundation
 *
 * Ported from OpenClaw external/mem0/openclaw/index.ts:700-710
 * (scope parameter used in memory_search, memory_list, auto-recall)
 */

// ── Memory Scope ───────────────────────────────────────────────────

/**
 * Discriminator for memory operation scope.
 *
 * - `session`   — current session only (scoped via run_id)
 * - `long-term` — user-scoped persistent memories (no run_id)
 * - `all`       — both scopes combined with deduplication
 */
export type MemoryScope = 'session' | 'long-term' | 'all';

// ── Extended Memory Context ────────────────────────────────────────

/**
 * Extended memory context with scope and runId support.
 * Backward-compatible with the base MemoryContext from IMemoryProvider.
 *
 * - `scope`  — discriminates session vs long-term operations
 * - `runId`  — session identifier for session-scoped memories
 * - `source` — origin tag for filtering (e.g., "MICROPHOENIX")
 */
export interface EnhancedMemoryContext {
  userId: string;
  sessionId: string;
  tenantId?: string;
  traceId?: string;
  correlationId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
  /** Memory scope discriminator. Default: 'all'. */
  scope?: MemoryScope;
  /** Session run identifier for session-scoped memories. */
  runId?: string;
  /** Origin source tag for filtering. Default: 'MICROPHOENIX'. */
  source?: string;
}

// ── Enhanced Memory Provider ───────────────────────────────────────

/**
 * Extended memory result with category and scope information.
 * Ported from OpenClaw MemoryItem (index.ts:83-92).
 */
export interface EnhancedMemoryResult {
  id: string;
  content: string;
  score?: number;
  categories?: string[];
  source?: string;
  metadata?: Record<string, unknown>;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Result of an add/store operation with event tracking.
 * Ported from OpenClaw AddResultItem (index.ts:94-98).
 */
export interface MemoryAddResultItem {
  id: string;
  memory: string;
  event: 'ADD' | 'UPDATE' | 'DELETE' | 'NOOP';
}

/**
 * Aggregate add result.
 * Ported from OpenClaw AddResult (index.ts:100-102).
 */
export interface MemoryAddResult {
  results: MemoryAddResultItem[];
}

// ── Wave 4 CC-004: Memory Storage Scope ────────────────────────────

/**
 * Physical/logical storage tier for memory entries.
 * Additive extension — does not modify the existing MemoryScope type.
 *
 * - `user`    — persists across all workspaces and conversations
 * - `project` — scoped to the current repository/workspace
 * - `local`   — scoped to the current conversation/session
 *
 * @pattern CC-004 Hierarchical Memory Scoping
 */
export type MemoryStorageScope = 'user' | 'project' | 'local';

/**
 * Memory entry with explicit storage scope metadata.
 */
export interface ScopedMemoryEntry {
  /** Memory entry identifier. */
  readonly id: string;
  /** Content of the memory entry. */
  readonly content: string;
  /** Storage tier this entry belongs to. */
  readonly storageScope: MemoryStorageScope;
  /** Relevance score when returned from search. */
  readonly score?: number;
  /** Additional metadata. */
  readonly metadata?: Record<string, unknown>;
  /** ISO 8601 creation timestamp. */
  readonly createdAt?: string;
}

/**
 * Priority configuration for memory scope merging.
 * Higher priority scopes override lower ones on conflict.
 */
export interface ScopePriorityConfig {
  /** Priority ordering (first = highest priority). Default: ['local', 'project', 'user']. */
  readonly order: ReadonlyArray<MemoryStorageScope>;
  /** Maximum entries to return per scope. */
  readonly maxPerScope?: number;
  /** Whether to deduplicate across scopes. Default: true. */
  readonly deduplicate?: boolean;
}
