/**
 * Mem0MemoryProviderBridge — Backward-compatible bridge from IMem0Provider to IMemoryProvider.
 *
 * Implements the domain `IMemoryProvider` interface by delegating to the new
 * `IMem0Provider` (UnifiedMem0Provider). This ensures all existing consumers
 * (CompositeMemoryProvider, BaseSwarmAgent, PlannerAgent, LLMBackedChatService, etc.)
 * continue to work without modification.
 *
 * Key bridging:
 * - `add(content, context)` → `provider.add([{role:'user', content}], options)`
 * - `retrieve(query, context, limit)` → `provider.search(query, options)`
 * - `getHistory(context, limit)` → `provider.getAll(options)` (maps getHistory to getAll)
 * - `delete(id, context)` → `provider.delete(id)`
 * - `reset(context)` → iterates getAll() → delete() each (Mem0 SDK has no bulk deleteAll)
 *
 * @module infrastructure/memory/provider
 *
 * Resolves Atomic Threat #1: getHistory vs getAll interface mismatch.
 * See: src/domain/memory/IMemoryProvider.ts (requires getHistory)
 *      src/infrastructure/memory/provider/UnifiedMem0Provider.ts (has only getAll)
 */

import type {
  IMemoryProvider,
  MemoryContext,
  MemoryResult,
} from '../../../domain/memory/IMemoryProvider';
import type {
  IMem0Provider,
  Mem0AddOptions,
  Mem0SearchOptions,
  Mem0ListOptions,
} from './UnifiedMem0Provider';

// ── Logger ─────────────────────────────────────────────────────────

interface IBridgeLogger {
  info(message: string): void;
  warn(message: string): void;
  debug?(message: string): void;
}

// ── Bridge ─────────────────────────────────────────────────────────

/**
 * Bridges the new IMem0Provider interface to the legacy IMemoryProvider contract.
 *
 * This is a Structural Adapter (GoF) that translates between:
 * - Domain layer (IMemoryProvider): add(string), retrieve(), getHistory(), delete(id, ctx), reset(ctx)
 * - Infrastructure layer (IMem0Provider): add(messages[]), search(), getAll(), get(), delete(id)
 *
 * Delegates to UnifiedMem0Provider (SDK-based dual-mode).
 */
export class Mem0MemoryProviderBridge implements IMemoryProvider {
  constructor(
    private readonly provider: IMem0Provider,
    private readonly defaultUserId: string,
    private readonly defaultSource: string = 'MICROPHOENIX',
    private readonly logger?: IBridgeLogger,
  ) {}

  /**
   * Add a memory via the unified provider.
   *
   * Bridges: IMemoryProvider.add(string, MemoryContext) → IMem0Provider.add(messages[], Mem0AddOptions)
   */
  async add(content: string, context: MemoryContext): Promise<void> {
    const options: Mem0AddOptions = {
      user_id: context.userId || this.defaultUserId,
      run_id: context.sessionId,
      source: this.defaultSource,
      output_format: 'v1.1',
    };

    await this.provider.add(
      [{ role: 'user', content }],
      options,
    );
  }

  /**
   * Retrieve relevant memories via semantic search.
   *
   * Bridges: IMemoryProvider.retrieve() → IMem0Provider.search()
   * Converts EnhancedMemoryResult → MemoryResult (domain type).
   */
  async retrieve(query: string, context: MemoryContext, limit?: number): Promise<MemoryResult[]> {
    const options: Mem0SearchOptions = {
      user_id: context.userId || this.defaultUserId,
      run_id: context.sessionId,
      top_k: limit ?? 5,
      keyword_search: true,
      reranking: true,
      source: this.defaultSource,
    };

    const results = await this.provider.search(query, options);

    return results.map((r) => ({
      id: r.id,
      content: r.content,
      score: r.score,
      source: 'vector' as const,
      metadata: r.metadata,
      timestamp: r.createdAt ? new Date(r.createdAt) : undefined,
    }));
  }

  /**
   * Get chronological history for a session/context.
   *
   * Bridges: IMemoryProvider.getHistory() → IMem0Provider.getAll()
   *
   * This is the critical bridge for Atomic Threat #1:
   * The domain IMemoryProvider requires getHistory(), but IMem0Provider
   * only has getAll(). We map getHistory to getAll with session run_id scoping.
   */
  async getHistory(context: MemoryContext, limit?: number): Promise<MemoryResult[]> {
    const options: Mem0ListOptions = {
      user_id: context.userId || this.defaultUserId,
      run_id: context.sessionId,
      page_size: limit,
      source: this.defaultSource,
    };

    const results = await this.provider.getAll(options);

    return results.map((r) => ({
      id: r.id,
      content: r.content,
      source: 'vector' as const,
      metadata: r.metadata,
      timestamp: r.createdAt ? new Date(r.createdAt) : undefined,
    }));
  }

  /**
   * Delete a memory by ID.
   *
   * Bridges: IMemoryProvider.delete(id, context) → IMem0Provider.delete(id)
   * Note: IMem0Provider.delete() does not require context — ID is sufficient.
   */
  async delete(id: string, _context: MemoryContext): Promise<void> {
    await this.provider.delete(id);
  }

  /**
   * Reset/clear all memories for a context.
   *
   * Uses provider.deleteAll() when available (both platform and OSS support it).
   * Falls back to batch delete (platform) or sequential delete (OSS).
   */
  async reset(context: MemoryContext): Promise<void> {
    const options: Mem0ListOptions = {
      user_id: context.userId || this.defaultUserId,
      run_id: context.sessionId,
      source: this.defaultSource,
    };

    try {
      // Prefer deleteAll() — both platform and OSS providers implement it
      await this.provider.deleteAll(options);
      this.logger?.info(
        `[mem0-bridge] Reset all memories for user ${options.user_id}`,
      );
    } catch (err) {
      // Fallback: try batch delete (platform) or sequential delete
      this.logger?.warn(`[mem0-bridge] deleteAll failed, falling back to batch/sequential: ${String(err)}`);
      try {
        const allMemories = await this.provider.getAll(options);
        if (allMemories.length === 0) return;

        const memoryIds = allMemories.map((m) => m.id);

        // Try batch delete first (platform, up to 1000 at a time)
        try {
          await this.provider.batchDelete(memoryIds);
          this.logger?.info(`[mem0-bridge] Batch deleted ${memoryIds.length} memories`);
        } catch {
          // Final fallback: sequential deletion
          this.logger?.info(`[mem0-bridge] Sequential delete ${memoryIds.length} memories`);
          for (const id of memoryIds) {
            try {
              await this.provider.delete(id);
            } catch (delErr) {
              this.logger?.warn(`[mem0-bridge] Failed to delete memory ${id}: ${String(delErr)}`);
            }
          }
        }
      } catch (listErr) {
        this.logger?.warn(`[mem0-bridge] Reset failed: ${String(listErr)}`);
        throw listErr;
      }
    }
  }
}
