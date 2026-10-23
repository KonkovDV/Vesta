/**
 * RecoveryStrategyAdapter — Infrastructure adapter for IRecoveryStrategy.
 *
 * Provides pluggable recovery actions for multi-step agentic flows.
 * Strategy selection is based on error type and attempt count:
 * - Attempt 1: retry-different-model
 * - Attempt 2: fallback-simpler
 * - Attempt 3+: escalate-to-human
 * - Non-critical steps with specific errors: skip-step
 *
 * Best Practices Applied (March 2026):
 * - correlationId in all log entries (Hard Rule #6)
 * - No side effects in selectAction (pure decision logic)
 *
 * DI: constructor(logger) — 1 arg
 *
 * @layer Infrastructure (implements Domain port)
 * @see IRecoveryStrategy (src/domain/execution/recovery-strategy.interface.ts)
 * @see Book Ch.12 "Exception Handling and Recovery"
 */

import type {
  IRecoveryStrategy,
  RecoveryAction,
  RecoveryContext,
  RecoveryResult,
} from '../../domain/execution/recovery-strategy.interface';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';

/** Errors that indicate a non-critical skip is safe */
const SKIPPABLE_ERRORS = ['OPTIONAL_STEP_FAILED', 'ENRICHMENT_UNAVAILABLE'];

/** Errors that suggest trying a different model */
const MODEL_ERRORS = ['RATE_LIMIT', 'MODEL_UNAVAILABLE', 'TIMEOUT', 'CONTEXT_LENGTH_EXCEEDED'];

export class RecoveryStrategyAdapter implements IRecoveryStrategy {
  constructor(
    private readonly logger: ILogger,
  ) {}

  selectAction(error: Error, context: RecoveryContext): RecoveryAction {
    const errorCode = (error as { code?: string }).code ?? error.message;

    // Non-critical step failures → skip
    if (SKIPPABLE_ERRORS.some((e) => errorCode.includes(e))) {
      return 'skip-step';
    }

    // Model-related errors on first attempt → try different model
    if (context.attemptNumber <= 1 && MODEL_ERRORS.some((e) => errorCode.includes(e))) {
      return 'retry-different-model';
    }

    // Second attempt → fallback to simpler approach
    if (context.attemptNumber <= 2) {
      return 'fallback-simpler';
    }

    // All retries exhausted → escalate
    return 'escalate-to-human';
  }

  async execute(
    action: RecoveryAction,
    context: RecoveryContext,
    correlationId: CorrelationId,
  ): Promise<RecoveryResult> {
    this.logger.info('Recovery action executing', {
      correlationId,
      action,
      step: context.step,
      flow: context.flow,
      attemptNumber: context.attemptNumber,
    });

    switch (action) {
      case 'retry-different-model':
        return {
          action,
          success: true,
          fallbackModel: 'gpt-4o-mini',
          output: undefined,
        };

      case 'skip-step':
        this.logger.warn('Skipping failed step', {
          correlationId,
          step: context.step,
          flow: context.flow,
        });
        return {
          action,
          success: true,
          output: `[Step "${context.step}" skipped due to non-critical failure]`,
        };

      case 'fallback-simpler':
        return {
          action,
          success: true,
          output: `[Fallback: simplified processing for "${context.step}"]`,
        };

      case 'escalate-to-human':
        this.logger.warn('Escalating to human review', {
          correlationId,
          step: context.step,
          flow: context.flow,
          attemptNumber: context.attemptNumber,
        });
        return {
          action,
          success: false,
          output: undefined,
        };

      default:
        return { action, success: false };
    }
  }
}
