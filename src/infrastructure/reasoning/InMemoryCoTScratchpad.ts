/**
 * InMemoryCoTScratchpad — Infrastructure implementation of ICoTScratchpad.
 *
 * In-memory store for Chain-of-Thought reasoning entries. Agents record
 * structured reasoning before executing dangerous/costly tool calls.
 * The AuditorAgent can query these entries for full decision interpretability.
 *
 * @module infrastructure/reasoning
 * @phase Horizon 1 — Chain-of-Thought Scratchpads
 *
 * Design:
 * - Append-only in-memory store with LRU eviction
 * - Indexed by agentId+correlationId+action for O(1) lookup
 * - Auto-purge of expired entries
 * - Thread-safe: all mutations are synchronous
 */

import type {
  ICoTScratchpad,
  ScratchpadEntry,
  ScratchpadQuery,
  ScratchpadConfig,
  ActionRiskLevel,
} from '../../domain/reasoning/ICoTScratchpad';
import type { IEventStore, DomainEvent } from '../../domain/events/event-store.interface';
import { EventFactory } from '../../domain/events/event-store.interface';
import type { CorrelationId } from '../../core/types/branded';
import { IdGenerator } from '../../core/utils/IdGenerator';

// ── Logger ─────────────────────────────────────────────────────────

interface IScratchpadLogger {
  info(message: string): void;
  warn(message: string): void;
  debug?(message: string): void;
}

// ── Default Config ─────────────────────────────────────────────────

export const DEFAULT_SCRATCHPAD_CONFIG: ScratchpadConfig = {
  entryTtlMs: 3_600_000, // 1 hour
  maxEntries: 5000,
  mandatoryRiskLevels: ['high', 'critical'],
  mandatoryTools: [],
  publishEvents: true,
};

// ── Risk Level Ordering ────────────────────────────────────────────

const RISK_ORDER: Record<ActionRiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// ── Implementation ─────────────────────────────────────────────────

export class InMemoryCoTScratchpad implements ICoTScratchpad {
  private readonly entries = new Map<string, ScratchpadEntry>();
  /** Quick lookup index: `agentId|correlationId|action` → entryId. */
  private readonly lookupIndex = new Map<string, string>();

  constructor(
    private readonly config: ScratchpadConfig = DEFAULT_SCRATCHPAD_CONFIG,
    private readonly logger?: IScratchpadLogger,
    /** FIX-R05: Optional IEventStore for publishing reasoning events (Outbox pattern) */
    private readonly eventStore?: IEventStore,
  ) {}

  // ── Record ─────────────────────────────────────────────────────

  async record(
    entry: Omit<ScratchpadEntry, 'entryId' | 'createdAt' | 'expiresAt' | 'wasExecuted' | 'executionOutcome'>,
  ): Promise<ScratchpadEntry> {
    // Evict if at capacity
    if (this.entries.size >= this.config.maxEntries) {
      this.evictOldest();
    }

    const now = new Date();
    const fullEntry: ScratchpadEntry = {
      ...entry,
      entryId: IdGenerator.generateWithPrefix('cot'),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.config.entryTtlMs),
      wasExecuted: false,
    };

    this.entries.set(fullEntry.entryId, fullEntry);

    // Index for fast lookup
    const indexKey = this.buildIndexKey(entry.agentId, entry.correlationId, entry.plannedAction);
    this.lookupIndex.set(indexKey, fullEntry.entryId);

    this.logger?.info(
      `[cot-scratchpad] Recorded entry ${fullEntry.entryId}: ` +
      `agent=${entry.agentId}, action=${entry.plannedAction}, risk=${entry.riskLevel}, ` +
      `steps=${entry.reasoningChain.length}`,
    );

    // FIX-R05: Publish reasoning event to IEventStore when configured
    if (this.config.publishEvents && this.eventStore) {
      try {
        const event = EventFactory.createBaseEvent(
          `cot-${entry.agentId}`,
          'agentic.cot.recorded',
          {
            entryId: fullEntry.entryId,
            agentId: entry.agentId,
            plannedAction: entry.plannedAction,
            riskLevel: entry.riskLevel,
            reasoningSteps: entry.reasoningChain.length,
            sessionId: entry.sessionId,
          },
          entry.correlationId,
        );
        await this.eventStore.saveEvents([event]);
      } catch (err) {
        // Non-blocking: event publish failure must not prevent scratchpad write
        this.logger?.warn(
          `[cot-scratchpad] Failed to publish event for ${fullEntry.entryId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    return fullEntry;
  }

  // ── Mark Executed ──────────────────────────────────────────────

  async markExecuted(entryId: string, outcome: ScratchpadEntry['executionOutcome']): Promise<void> {
    const entry = this.entries.get(entryId);
    if (!entry) {
      this.logger?.warn(`[cot-scratchpad] Cannot mark unknown entry: ${entryId}`);
      return;
    }

    entry.wasExecuted = true;
    entry.executionOutcome = outcome;

    this.logger?.debug?.('[cot-scratchpad] Entry ' + entryId + ' executed: ' + String(outcome ?? 'unknown'));
  }

  // ── Lookup ─────────────────────────────────────────────────────

  hasEntryFor(params: {
    agentId: string;
    correlationId: string;
    plannedAction: string;
  }): boolean {
    const indexKey = this.buildIndexKey(params.agentId, params.correlationId, params.plannedAction);
    const entryId = this.lookupIndex.get(indexKey);
    if (!entryId) return false;

    const entry = this.entries.get(entryId);
    if (!entry) return false;

    // Check expiry
    if (entry.expiresAt.getTime() < Date.now()) {
      this.entries.delete(entryId);
      this.lookupIndex.delete(indexKey);
      return false;
    }

    return true;
  }

  // ── Query ──────────────────────────────────────────────────────

  query(options: ScratchpadQuery): ScratchpadEntry[] {
    let results = Array.from(this.entries.values());

    // Apply filters
    if (options.agentId) {
      results = results.filter((e) => e.agentId === options.agentId);
    }
    if (options.sessionId) {
      results = results.filter((e) => e.sessionId === options.sessionId);
    }
    if (options.correlationId) {
      results = results.filter((e) => e.correlationId === options.correlationId);
    }
    if (options.plannedAction) {
      results = results.filter((e) => e.plannedAction === options.plannedAction);
    }
    if (options.minRiskLevel) {
      const minOrder = RISK_ORDER[options.minRiskLevel];
      results = results.filter((e) => RISK_ORDER[e.riskLevel] >= minOrder);
    }
    if (options.since) {
      const sinceTime = options.since.getTime();
      results = results.filter((e) => e.createdAt.getTime() >= sinceTime);
    }

    // Sort by creation time (newest first)
    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    // Apply limit
    if (options.limit && options.limit > 0) {
      results = results.slice(0, options.limit);
    }

    return results;
  }

  getById(entryId: string): ScratchpadEntry | undefined {
    return this.entries.get(entryId);
  }

  // ── Purge ──────────────────────────────────────────────────────

  purgeExpired(): number {
    const now = Date.now();
    let purged = 0;

    for (const [entryId, entry] of this.entries) {
      if (entry.expiresAt.getTime() < now) {
        this.entries.delete(entryId);
        const indexKey = this.buildIndexKey(entry.agentId, entry.correlationId, entry.plannedAction);
        this.lookupIndex.delete(indexKey);
        purged++;
      }
    }

    if (purged > 0) {
      this.logger?.info(`[cot-scratchpad] Purged ${purged} expired entries`);
    }

    return purged;
  }

  // ── Stats ──────────────────────────────────────────────────────

  getStats(): {
    totalEntries: number;
    entriesByRiskLevel: Record<ActionRiskLevel, number>;
    entriesExecuted: number;
    entriesBlocked: number;
    oldestEntryAge: number;
  } {
    const byRisk: Record<ActionRiskLevel, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    let executed = 0;
    let blocked = 0;
    let oldestTime = Date.now();

    for (const entry of this.entries.values()) {
      byRisk[entry.riskLevel]++;
      if (entry.wasExecuted) executed++;
      if (entry.executionOutcome === 'blocked') blocked++;
      if (entry.createdAt.getTime() < oldestTime) {
        oldestTime = entry.createdAt.getTime();
      }
    }

    return {
      totalEntries: this.entries.size,
      entriesByRiskLevel: byRisk,
      entriesExecuted: executed,
      entriesBlocked: blocked,
      oldestEntryAge: this.entries.size > 0 ? Date.now() - oldestTime : 0,
    };
  }

  // ── Dispose ────────────────────────────────────────────────────

  dispose(): void {
    this.entries.clear();
    this.lookupIndex.clear();
    this.logger?.info('[cot-scratchpad] Disposed — all state cleared');
  }

  // ── Helpers ────────────────────────────────────────────────────

  private buildIndexKey(agentId: string, correlationId: string, action: string): string {
    return `${agentId}|${correlationId}|${action}`;
  }

  private evictOldest(): void {
    // Find oldest non-executed entry
    let oldestId: string | undefined;
    let oldestTime = Infinity;

    for (const [id, entry] of this.entries) {
      if (!entry.wasExecuted && entry.createdAt.getTime() < oldestTime) {
        oldestTime = entry.createdAt.getTime();
        oldestId = id;
      }
    }

    // Fall back to oldest entry regardless
    if (!oldestId) {
      for (const [id, entry] of this.entries) {
        if (entry.createdAt.getTime() < oldestTime) {
          oldestTime = entry.createdAt.getTime();
          oldestId = id;
        }
      }
    }

    if (oldestId) {
      const entry = this.entries.get(oldestId)!;
      this.entries.delete(oldestId);
      const indexKey = this.buildIndexKey(entry.agentId, entry.correlationId, entry.plannedAction);
      this.lookupIndex.delete(indexKey);
      this.logger?.debug?.(`[cot-scratchpad] Evicted oldest entry: ${oldestId}`);
    }
  }
}
