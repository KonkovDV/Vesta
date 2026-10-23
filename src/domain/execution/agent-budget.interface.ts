/**
 * IAgentBudget — Domain interface for agent execution budget management.
 *
 * Composes (NOT replaces) ITokenomicsController with time and tool-call limits.
 * Designed for agentic flows that need multi-dimensional stopping conditions:
 * - Token budget (delegated to ITokenomicsController)
 * - Cost budget (delegated to ITokenomicsController)
 * - Duration budget (new: wall-clock time limit)
 * - Tool call budget (new: max tool invocations)
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @see Book Ch.12 "Exception Handling and Recovery" — stopping conditions
 * @see Anthropic Guide "Building Effective Agents" — budget/stopping
 * @see CC-13 (Master Plan §8.13)
 */

import type { CorrelationId } from '@/ai-types';

/**
 * Configuration for agent budget limits.
 * All fields optional — only configured limits are enforced.
 */
export interface AgentBudgetConfig {
  /** Wall-clock time limit in milliseconds */
  readonly maxDurationMs?: number;
  /** Maximum number of tool invocations */
  readonly maxToolCalls?: number;
  /** Scope ID for ITokenomicsController delegation (token/cost limits) */
  readonly tokenomicsScopeId?: string;
}

/**
 * Remaining budget across all dimensions.
 */
export interface RemainingBudget {
  readonly durationMs?: number;
  readonly toolCalls?: number;
  readonly tokensRemaining?: number;
  readonly costRemaining?: number;
}

/**
 * Reason why budget was exhausted.
 */
export type BudgetExhaustionReason =
  | 'max_duration'
  | 'max_tool_calls'
  | 'max_tokens'
  | 'max_cost';

/**
 * Agent budget manager — multi-dimensional stopping conditions for agentic flows.
 * Lifecycle: transient (one budget per flow execution).
 */
export interface IAgentBudget {
  /** Configure budget limits for this flow execution. */
  configure(config: AgentBudgetConfig, correlationId: CorrelationId): void;

  /** Record a tool call against the budget. */
  recordToolCall(): void;

  /** Check if any budget dimension is exhausted. */
  isExhausted(): boolean;

  /** Get the reason for exhaustion (null if not exhausted). */
  getExhaustionReason(): BudgetExhaustionReason | null;

  /** Get remaining budget across all dimensions. */
  getRemainingBudget(): RemainingBudget;

  /** Register a callback invoked when budget is exhausted. */
  onExhausted(callback: (reason: BudgetExhaustionReason) => void): void;
}
