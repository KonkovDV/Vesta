/**
 * AgentBudgetAdapter — Infrastructure adapter for IAgentBudget.
 *
 * Composes ITokenomicsController for token/cost limits and adds
 * time-based and tool-call-based stopping conditions.
 *
 * Best Practices Applied (March 2026):
 * - Composition over inheritance: delegates token/cost to ITokenomicsController
 * - correlationId in all log entries (Hard Rule #6)
 * - Transient lifecycle: one budget per flow execution
 *
 * DI: constructor(tokenomics, logger) — 2 args
 *
 * @layer Infrastructure (implements Domain port)
 * @see IAgentBudget (src/domain/execution/agent-budget.interface.ts)
 * @see Book Ch.12 "Exception Handling" + Anthropic "Stopping Conditions"
 */

import type {
  IAgentBudget,
  AgentBudgetConfig,
  RemainingBudget,
  BudgetExhaustionReason,
} from '../../domain/execution/agent-budget.interface';
import type { ITokenomicsController } from '../../domain/finops/ITokenomicsController';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';

export class AgentBudgetAdapter implements IAgentBudget {
  private config: AgentBudgetConfig | null = null;
  private configCorrelationId: CorrelationId | null = null;
  private startTime = 0;
  private toolCallCount = 0;
  private exhaustedCallbacks: Array<(reason: BudgetExhaustionReason) => void> = [];
  private exhausted = false;

  constructor(
    private readonly tokenomics: ITokenomicsController,
    private readonly logger: ILogger,
  ) {}

  configure(config: AgentBudgetConfig, correlationId: CorrelationId): void {
    this.config = config;
    this.configCorrelationId = correlationId;
    this.startTime = Date.now();
    this.toolCallCount = 0;
    this.exhausted = false;

    this.logger.info('Agent budget configured', {
      correlationId,
      maxDurationMs: config.maxDurationMs,
      maxToolCalls: config.maxToolCalls,
      tokenomicsScopeId: config.tokenomicsScopeId,
    });
  }

  recordToolCall(): void {
    this.toolCallCount++;
    this.checkExhaustion();
  }

  isExhausted(): boolean {
    if (this.exhausted) return true;
    this.checkExhaustion();
    return this.exhausted;
  }

  getExhaustionReason(): BudgetExhaustionReason | null {
    if (!this.config) return null;

    if (this.config.maxDurationMs !== undefined) {
      const elapsed = Date.now() - this.startTime;
      if (elapsed >= this.config.maxDurationMs) return 'max_duration';
    }

    if (this.config.maxToolCalls !== undefined) {
      if (this.toolCallCount >= this.config.maxToolCalls) return 'max_tool_calls';
    }

    if (this.config.tokenomicsScopeId) {
      const routing = this.tokenomics.requestModelRouting(this.config.tokenomicsScopeId);
      if (!routing.allowed) return 'max_cost';
    }

    return null;
  }

  getRemainingBudget(): RemainingBudget {
    if (!this.config) {
      return {};
    }

    const result: {
      durationMs?: number;
      toolCalls?: number;
      tokensRemaining?: number;
      costRemaining?: number;
    } = {};

    if (this.config.maxDurationMs !== undefined) {
      const elapsed = Date.now() - this.startTime;
      result.durationMs = Math.max(0, this.config.maxDurationMs - elapsed);
    }

    if (this.config.maxToolCalls !== undefined) {
      result.toolCalls = Math.max(0, this.config.maxToolCalls - this.toolCallCount);
    }

    // FIX: H-008 — Populate tokensRemaining/costRemaining from ITokenomicsController.
    // Previously these fields were declared in RemainingBudget but never set.
    if (this.config.tokenomicsScopeId) {
      const remaining = this.tokenomics.getBudgetRemaining(this.config.tokenomicsScopeId);
      if (remaining) {
        result.tokensRemaining = remaining.tokensRemaining;
        result.costRemaining = remaining.costRemainingUsd;
      }
    }

    return result;
  }

  onExhausted(callback: (reason: BudgetExhaustionReason) => void): void {
    this.exhaustedCallbacks.push(callback);
  }

  // ── Private ──────────────────────────────────────────────────────────

  private checkExhaustion(): void {
    if (this.exhausted) return;

    const reason = this.getExhaustionReason();
    if (reason) {
      this.exhausted = true;
      this.logger.warn('Agent budget exhausted', {
        correlationId: this.configCorrelationId,
        reason,
        toolCallCount: this.toolCallCount,
        elapsedMs: Date.now() - this.startTime,
      });

      for (const cb of this.exhaustedCallbacks) {
        try {
          cb(reason);
        } catch (err) {
          this.logger.debug('Budget exhaustion callback error (non-fatal)', {
            correlationId: this.configCorrelationId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
  }
}
