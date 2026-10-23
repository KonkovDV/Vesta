/**
 * IRecoveryStrategy — Domain interface for agentic flow failure recovery.
 *
 * Provides pluggable recovery actions for multi-step agentic flows
 * when individual steps fail (LLM timeout, rate limit, parsing error, etc.).
 *
 * Strategies:
 * - retry-different-model: Retry with fallback model (e.g. gpt-4o → claude-3.5-haiku)
 * - skip-step: Skip failed non-critical step, continue pipeline
 * - fallback-simpler: Degrade to simpler approach
 * - escalate-to-human: Route to IUserApprovalInterceptor when all retries exhausted
 *
 * Integrated by: IPromptChainExecutor, IStructuredReasoningProtocol,
 * IDeepResearchService, IResearchLabOrchestrator.
 *
 * @layer Domain (port — implemented by Infrastructure adapter)
 * @see Book Ch.12 "Exception Handling and Recovery"
 * @see CC-11 (Master Plan §8.11)
 */

import type { CorrelationId } from '@/ai-types';

/**
 * Available recovery actions for failed steps.
 */
export type RecoveryAction =
  | 'retry-different-model'
  | 'skip-step'
  | 'fallback-simpler'
  | 'escalate-to-human';

/**
 * Context about the failed step for recovery decision.
 */
export interface RecoveryContext {
  readonly step: string;
  readonly attemptNumber: number;
  readonly flow: string;
  readonly metadata?: Record<string, unknown>;
}

/**
 * Result of executing a recovery action.
 */
export interface RecoveryResult {
  readonly action: RecoveryAction;
  readonly success: boolean;
  readonly output?: unknown;
  readonly fallbackModel?: string;
}

/**
 * Pluggable recovery strategy for agentic flow failures.
 * Lifecycle: singleton.
 */
export interface IRecoveryStrategy {
  /** Select the appropriate recovery action based on error and context. */
  selectAction(error: Error, context: RecoveryContext): RecoveryAction;

  /** Execute the selected recovery action. */
  execute(
    action: RecoveryAction,
    context: RecoveryContext,
    correlationId: CorrelationId,
  ): Promise<RecoveryResult>;
}
