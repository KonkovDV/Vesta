/**
 * ICoTScratchpad — Domain port for Chain-of-Thought reasoning scratchpads.
 *
 * Before executing any "dangerous" tool call or high-cost operation,
 * agents are required to record their reasoning in a temporary scratchpad.
 * This makes all agent decisions 100% interpretable by the AuditorAgent
 * and prevents impulsive (hallucination-driven) actions.
 *
 * @layer Domain (port contract)
 * @phase Horizon 1 — Chain-of-Thought Scratchpads
 *
 * Design:
 * - Each agent action gets a ScratchpadEntry with structured reasoning
 * - Entries are immutable once committed (append-only)
 * - AuditorAgent can query scratchpads to trace decision chains
 * - Entries auto-expire after configurable TTL (memory-bounded)
 * - Integration point: IToolExecutionPolicy checks for scratchpad entry
 *   before allowing dangerous operations
 */

// ── Types ──────────────────────────────────────────────────────────

/** Risk level classification for a planned action. */
export type ActionRiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** A single reasoning step in the chain of thought. */
export interface ReasoningStep {
  /** Sequential step number (1-based). */
  stepNumber: number;
  /** The reasoning content for this step. */
  thought: string;
  /** Optional evidence or data supporting this step. */
  evidence?: string;
  /** Confidence level for this step (0-1). */
  confidence: number;
}

/** Complete scratchpad entry for one planned action. */
export interface ScratchpadEntry {
  /** Unique entry ID. */
  entryId: string;
  /** Agent ID that created this entry. */
  agentId: string;
  /** Session context for traceability. */
  sessionId: string;
  /** Correlation ID from RequestContext. */
  correlationId: string;
  /** The tool or action the agent plans to execute. */
  plannedAction: string;
  /** Tool arguments (sanitized — no PII). */
  plannedArguments: Record<string, unknown>;
  /** Risk assessment by the agent. */
  riskLevel: ActionRiskLevel;
  /** Structured chain-of-thought reasoning. */
  reasoningChain: ReasoningStep[];
  /** Summary conclusion: why the agent decided to proceed. */
  conclusion: string;
  /** Alternative actions the agent considered but rejected. */
  alternatives: Array<{
    action: string;
    rejectionReason: string;
  }>;
  /** Estimated resource cost (tokens, compute time, etc.). */
  estimatedCost: {
    tokens?: number;
    computeTimeMs?: number;
    apiCalls?: number;
  };
  /** When the entry was created. */
  createdAt: Date;
  /** When the entry expires (for auto-cleanup). */
  expiresAt: Date;
  /** Whether the planned action was ultimately executed. */
  wasExecuted: boolean;
  /** Outcome after execution (filled post-factum). */
  executionOutcome?: 'success' | 'failure' | 'blocked' | 'timeout';
}

/** Query options for scratchpad retrieval. */
export interface ScratchpadQuery {
  /** Filter by agent ID. */
  agentId?: string;
  /** Filter by session ID. */
  sessionId?: string;
  /** Filter by correlation ID. */
  correlationId?: string;
  /** Filter by risk level (minimum). */
  minRiskLevel?: ActionRiskLevel;
  /** Filter by planned action name. */
  plannedAction?: string;
  /** Maximum entries to return. */
  limit?: number;
  /** Only return entries created after this date. */
  since?: Date;
}

/** Configuration for scratchpad behavior. */
export interface ScratchpadConfig {
  /** TTL for scratchpad entries in milliseconds. Default: 3_600_000 (1 hour). */
  entryTtlMs: number;
  /** Maximum entries to retain in memory. Default: 5000. */
  maxEntries: number;
  /** Risk levels that require mandatory scratchpad entry. Default: ['high', 'critical']. */
  mandatoryRiskLevels: ActionRiskLevel[];
  /** Tool names that always require scratchpad entry regardless of risk. */
  mandatoryTools: string[];
  /** Whether to publish ScratchpadCreated domain events. Default: true. */
  publishEvents: boolean;
}

// ── Port ───────────────────────────────────────────────────────────

/**
 * Domain port for managing Chain-of-Thought scratchpads.
 * Implementations persist reasoning traces for auditability and interpretability.
 */
export interface ICoTScratchpad {
  /**
   * Record a new reasoning scratchpad entry before action execution.
   * @returns The created entry with generated ID and timestamps.
   */
  record(entry: Omit<ScratchpadEntry, 'entryId' | 'createdAt' | 'expiresAt' | 'wasExecuted' | 'executionOutcome'>): Promise<ScratchpadEntry>;

  /**
   * Mark an entry as executed with the given outcome.
   */
  markExecuted(entryId: string, outcome: ScratchpadEntry['executionOutcome']): Promise<void>;

  /**
   * Check whether a scratchpad entry exists for a given action in the current context.
   * Used by IToolExecutionPolicy to enforce mandatory reasoning.
   */
  hasEntryFor(params: {
    agentId: string;
    correlationId: string;
    plannedAction: string;
  }): boolean;

  /**
   * Query scratchpad entries for auditing.
   */
  query(options: ScratchpadQuery): ScratchpadEntry[];

  /**
   * Get a specific entry by ID.
   */
  getById(entryId: string): ScratchpadEntry | undefined;

  /**
   * Purge expired entries. Returns count of purged entries.
   */
  purgeExpired(): number;

  /**
   * Get statistics about the scratchpad store.
   */
  getStats(): {
    totalEntries: number;
    entriesByRiskLevel: Record<ActionRiskLevel, number>;
    entriesExecuted: number;
    entriesBlocked: number;
    oldestEntryAge: number;
  };

  /**
   * Dispose of all resources.
   */
  dispose(): void;
}
