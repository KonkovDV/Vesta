/**
 * IMemoryProvider.ts
 *
 * Domain interface for the Unified Memory Architecture.
 * Abstracts away the underlying storage engine (SQL/OpenMemory, Vector/Mem0, Graph/Neo4j).
 *
 * Design Goals:
 * 1. Explicit Context: Context is passed as an argument, not inferred solely from global state.
 * 2. Hybrid Support: Allows implementations to read/write from multiple sources.
 * 3. Type Safety: Uses branded types where possible.
 */

export interface MemoryContext {
  userId: string;
  sessionId: string;
  tenantId?: string;
  traceId?: string;
  correlationId?: string;
  agentId?: string;
  metadata?: Record<string, unknown>;
}

export type MemorySource = 'postgres' | 'vector' | 'graph' | 'hybrid' | 'system';

export interface MemoryResult {
  id?: string;
  content: string;
  score?: number; // Similarity score (0-1) for vector/hybrid search
  timestamp?: Date;
  source: MemorySource;
  metadata?: Record<string, unknown>;
}

export interface IMemoryProvider {
  /**
   * Add a new memory/thought/message.
   *
   * @param content The text content or structured object to save.
   * @param context The execution context (user, session, etc.).
   */
  add(content: string, context: MemoryContext): Promise<void>;

  /**
   * Retrieve relevant memories based on a semantic query.
   *
   * @param query The search query (natural language).
   * @param context The execution context scope.
   * @param limit Max number of results.
   */
  retrieve(query: string, context: MemoryContext, limit?: number): Promise<MemoryResult[]>;

  /**
   * Get the chronological history for a specific context/session.
   *
   * @param context The execution context (must have sessionId).
   * @param limit Max number of recent messages to return.
   */
  getHistory(context: MemoryContext, limit?: number): Promise<MemoryResult[]>;

  /**
   * Delete a memory by ID.
   */
  delete(id: string, context: MemoryContext): Promise<void>;

  /**
   * Reset/Clear all memories for the given context (e.g. clear session).
   */
  reset(context: MemoryContext): Promise<void>;
}
