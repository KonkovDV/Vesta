/**
 * ITokenomicsController — Domain port for AI FinOps cost governance.
 *
 * Central coordination point connecting token budget management,
 * model routing (downgrade/upgrade), and HITL escalation.
 * Prevents runaway swarm spending by enforcing per-agent and
 * per-session budget tiers with automatic circuit-breaker-style
 * response to cost overruns.
 *
 * @layer Domain (port contract)
 * @phase Horizon 2.2 — FinOps for AI Agents
 *
 * Tiers of response (escalating severity):
 *   1. OK       — under warningThreshold, no action
 *   2. WARNING  — over warningThreshold → emit BudgetWarningEvent,
 *                 optionally downgrade model tier
 *   3. DOWNGRADE — over downgradeThreshold → force cheap model,
 *                  emit ModelDowngradedEvent
 *   4. FROZEN   — over hardLimitUsd → freeze agent,
 *                  emit AgentFrozenEvent, escalate to HITL
 *
 * Integration points:
 *   - SessionCostTracker  (existing billing accumulator)
 *   - LlmCircuitBreakerAdapter (existing per-provider CB)
 *   - IUserApprovalInterceptor (existing HITL escalation)
 *   - IEventBus (outbox-first event publishing)
 */

// ── Budget Policy ──────────────────────────────────────────────────

/**
 * Budget policy for a single agent or session scope.
 * Immutable configuration — set once, enforced throughout.
 */
export interface TokenomicsBudgetPolicy {
  /** Unique policy identifier. */
  readonly policyId: string;

  /** Human-readable label (e.g. "default-agent", "premium-session"). */
  readonly label: string;

  /**
   * Maximum total cost in USD before hard-freeze.
   * Exceeding this triggers AgentFrozenEvent + HITL.
   */
  readonly hardLimitUsd: number;

  /**
   * Cost threshold (USD) that triggers BudgetWarningEvent.
   * Must be < hardLimitUsd.
   */
  readonly warningThresholdUsd: number;

  /**
   * Cost threshold (USD) that triggers automatic model downgrade.
   * Must be >= warningThresholdUsd and < hardLimitUsd.
   */
  readonly downgradeThresholdUsd: number;

  /**
   * Maximum total tokens across all calls before warning.
   * 0 = no token-based limit (cost-only governance).
   */
  readonly maxTotalTokens: number;

  /**
   * Maximum tokens per single LLM call. Prevents prompt-bombing.
   * 0 = no per-call limit.
   */
  readonly maxTokensPerCall: number;

  /**
   * Maximum number of LLM calls per session/agent. Prevents infinite loops.
   * 0 = unlimited.
   */
  readonly maxCallCount: number;

  /**
   * Preferred (expensive) model for normal operation.
   * Format: "provider/model" (e.g. "anthropic/claude-sonnet-4-20250514").
   */
  readonly preferredModel: string;

  /**
   * Downgrade model for cost-saving mode.
   * Format: "provider/model" (e.g. "anthropic/claude-haiku-3").
   */
  readonly downgradeModel: string;

  /**
   * Whether to auto-escalate to HITL on freeze (vs. just blocking).
   */
  readonly escalateToHitlOnFreeze: boolean;

  /**
   * Time window in ms for sliding-window cost calculation.
   * 0 = cumulative (no window). Default: 0.
   */
  readonly slidingWindowMs: number;
}

// ── Agent Spend State ──────────────────────────────────────────────

/**
 * Current spend tier / enforcement level.
 */
export type SpendTier = 'ok' | 'warning' | 'downgraded' | 'frozen';

/**
 * Real-time spend state for a tracked agent/session.
 */
export interface AgentSpendState {
  /** Agent or session identifier (scope key). */
  readonly scopeId: string;

  /** Active policy ID. */
  readonly policyId: string;

  /** Current enforcement tier. */
  readonly tier: SpendTier;

  /** Cumulative cost in USD. */
  readonly totalCostUsd: number;

  /** Cumulative tokens consumed. */
  readonly totalTokens: number;

  /** Number of LLM calls made. */
  readonly callCount: number;

  /** Active model key ("provider/model"). */
  readonly activeModel: string;

  /** Whether model was downgraded from preferred. */
  readonly isDowngraded: boolean;

  /** Whether the agent is frozen (no more calls allowed). */
  readonly isFrozen: boolean;

  /** When the agent was first tracked. */
  readonly firstActivityAt: string;

  /** When the last LLM call was recorded. */
  readonly lastActivityAt: string;

  /** When tier last changed. */
  readonly tierChangedAt: string;

  /** If frozen, the HITL request ID (if escalated). */
  readonly hitlRequestId?: string;
}

// ── LLM Call Record ────────────────────────────────────────────────

/**
 * Describes a single LLM call for cost tracking purposes.
 */
export interface LlmCallRecord {
  /** Provider name (e.g. "anthropic", "openai"). */
  readonly provider: string;

  /** Model name (e.g. "claude-sonnet-4-20250514"). */
  readonly model: string;

  /** Input tokens consumed. */
  readonly inputTokens: number;

  /** Output tokens generated. */
  readonly outputTokens: number;

  /** Total cost of this call in USD. */
  readonly costUsd: number;

  /** When the call completed. */
  readonly completedAt: string;

  /** Duration of the LLM call in ms. */
  readonly durationMs: number;

  /** Optional correlation ID. */
  readonly correlationId?: string;
}

// ── Budget Remaining (FIX: H-008) ─────────────────────────────────

/**
 * Remaining budget across token and cost dimensions.
 * Computed from policy limits minus current spend.
 */
export interface BudgetRemaining {
  /** Remaining tokens (policy.maxTotalTokens - state.totalTokens). Undefined if no token limit. */
  readonly tokensRemaining?: number;
  /** Remaining cost in USD (policy.hardLimitUsd - state.totalCostUsd). */
  readonly costRemainingUsd: number;
}

// ── Model Routing Decision ─────────────────────────────────────────

/**
 * Result of asking the controller which model to use.
 */
export interface ModelRoutingDecision {
  /** Whether the call is allowed. */
  readonly allowed: boolean;

  /** The model to use ("provider/model"). */
  readonly model: string;

  /** Whether this model was downgraded from preferred. */
  readonly isDowngraded: boolean;

  /** Current spend tier. */
  readonly tier: SpendTier;

  /**
   * If not allowed, the reason why.
   */
  readonly reason?: string;

  /**
   * Current spend state snapshot.
   */
  readonly spendState: AgentSpendState;
}

// ── FinOps Events ──────────────────────────────────────────────────

/**
 * Base envelope for all tokenomics events.
 */
export interface TokenomicsEvent {
  readonly eventType: TokenomicsEventType;
  readonly scopeId: string;
  readonly policyId: string;
  readonly timestamp: string;
}

export type TokenomicsEventType =
  | 'budget_warning'
  | 'model_downgraded'
  | 'model_restored'
  | 'agent_frozen'
  | 'agent_unfrozen'
  | 'call_rejected';

export interface BudgetWarningEvent extends TokenomicsEvent {
  readonly eventType: 'budget_warning';
  readonly totalCostUsd: number;
  readonly thresholdUsd: number;
  readonly percentUsed: number;
}

export interface ModelDowngradedEvent extends TokenomicsEvent {
  readonly eventType: 'model_downgraded';
  readonly fromModel: string;
  readonly toModel: string;
  readonly totalCostUsd: number;
  readonly reason: string;
}

export interface ModelRestoredEvent extends TokenomicsEvent {
  readonly eventType: 'model_restored';
  readonly fromModel: string;
  readonly toModel: string;
  readonly reason: string;
}

export interface AgentFrozenEvent extends TokenomicsEvent {
  readonly eventType: 'agent_frozen';
  readonly totalCostUsd: number;
  readonly hardLimitUsd: number;
  readonly callCount: number;
  readonly hitlRequestId?: string;
}

export interface AgentUnfrozenEvent extends TokenomicsEvent {
  readonly eventType: 'agent_unfrozen';
  readonly unfrozenBy: string;
  readonly newBudgetUsd?: number;
}

export interface CallRejectedEvent extends TokenomicsEvent {
  readonly eventType: 'call_rejected';
  readonly reason: string;
  readonly tier: SpendTier;
  readonly totalCostUsd: number;
}

// ── Callback types ─────────────────────────────────────────────────

export type TokenomicsEventCallback = (event: TokenomicsEvent) => void;

// ── Aggregate Statistics ───────────────────────────────────────────

export interface TokenomicsStats {
  /** Total tracked scopes (agents/sessions). */
  readonly trackedScopes: number;

  /** Scopes currently in each tier. */
  readonly tierDistribution: Record<SpendTier, number>;

  /** Total cost across all scopes (USD). */
  readonly totalCostUsd: number;

  /** Total tokens across all scopes. */
  readonly totalTokens: number;

  /** Total LLM calls across all scopes. */
  readonly totalCalls: number;

  /** Number of model downgrades triggered. */
  readonly totalDowngrades: number;

  /** Number of agents currently frozen. */
  readonly totalFrozen: number;

  /** Total HITL escalations. */
  readonly totalHitlEscalations: number;

  /** Total calls rejected. */
  readonly totalCallsRejected: number;
}

// ── Port Interface ─────────────────────────────────────────────────

/**
 * Domain port for AI FinOps cost governance.
 *
 * Usage:
 * ```typescript
 * const controller = container.resolve<ITokenomicsController>('ITokenomicsController');
 *
 * // Register an agent with a budget policy
 * controller.registerScope('agent-coder-1', DEFAULT_POLICY);
 *
 * // Before each LLM call, ask for routing decision
 * const decision = controller.requestModelRouting('agent-coder-1');
 * if (!decision.allowed) throw new Error(decision.reason);
 * // ... make LLM call using decision.model ...
 *
 * // After each LLM call, record the result
 * controller.recordCall('agent-coder-1', { provider, model, inputTokens, outputTokens, costUsd, ... });
 * ```
 */
export interface ITokenomicsController {
  /**
   * Register a scope (agent or session) with a budget policy.
   * Idempotent — re-registering updates the policy.
   */
  registerScope(scopeId: string, policy: TokenomicsBudgetPolicy): void;

  /**
   * Remove a scope from tracking. Clears all state.
   */
  unregisterScope(scopeId: string): void;

  /**
   * Get the routing decision for the next LLM call.
   * Returns which model to use (or blocks if frozen).
   */
  requestModelRouting(scopeId: string): ModelRoutingDecision;

  /**
   * Record a completed LLM call and update spend state.
   * May trigger tier transitions and events.
   */
  recordCall(scopeId: string, call: LlmCallRecord): AgentSpendState;

  /**
   * Manually unfreeze a frozen agent (admin/HITL action).
   * Optionally sets a new budget (extends hardLimit).
   */
  unfreezeAgent(scopeId: string, unfrozenBy: string, additionalBudgetUsd?: number): AgentSpendState;

  /**
   * Manually restore preferred model for a downgraded agent.
   */
  restorePreferredModel(scopeId: string): AgentSpendState;

  /**
   * Get the current spend state for a scope.
   */
  getSpendState(scopeId: string): AgentSpendState | undefined;

  /**
   * FIX: H-008 — Compute remaining budget (tokens + cost) for a scope.
   * Returns undefined if scope is unregistered.
   * Used by AgentBudgetAdapter.getRemainingBudget() to populate
   * tokensRemaining and costRemaining fields.
   */
  getBudgetRemaining(scopeId: string): BudgetRemaining | undefined;

  /**
   * Get all tracked spend states.
   */
  getAllSpendStates(): AgentSpendState[];

  /**
   * Get aggregate statistics.
   */
  getStats(): TokenomicsStats;

  /**
   * Subscribe to tokenomics events.
   */
  onEvent(callback: TokenomicsEventCallback): void;

  /**
   * Dispose of resources.
   */
  dispose(): void;
}

// ── Default Policy Factory ─────────────────────────────────────────

/**
 * Sensible defaults for a standard agent budget.
 * ~$5 budget with downgrade at $3, warning at $2.
 */
export const DEFAULT_BUDGET_POLICY: TokenomicsBudgetPolicy = {
  policyId: 'default',
  label: 'Default Agent Budget',
  hardLimitUsd: 5.0,
  warningThresholdUsd: 2.0,
  downgradeThresholdUsd: 3.0,
  maxTotalTokens: 2_000_000,
  maxTokensPerCall: 200_000,
  maxCallCount: 100,
  preferredModel: 'anthropic/claude-sonnet-4-20250514',
  downgradeModel: 'anthropic/claude-haiku-3',
  escalateToHitlOnFreeze: true,
  slidingWindowMs: 0,
};

/**
 * Premium policy — higher limits for trusted / supervised agents.
 */
export const PREMIUM_BUDGET_POLICY: TokenomicsBudgetPolicy = {
  policyId: 'premium',
  label: 'Premium Agent Budget',
  hardLimitUsd: 50.0,
  warningThresholdUsd: 20.0,
  downgradeThresholdUsd: 35.0,
  maxTotalTokens: 20_000_000,
  maxTokensPerCall: 500_000,
  maxCallCount: 500,
  preferredModel: 'anthropic/claude-sonnet-4-20250514',
  downgradeModel: 'anthropic/claude-haiku-3',
  escalateToHitlOnFreeze: true,
  slidingWindowMs: 0,
};
