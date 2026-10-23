/**
 * IStructuredReasoningProtocol — Domain port for 5-phase Chain-of-Thought reasoning.
 *
 * Phases: Decompose → Plan → Execute → Verify → Synthesize
 * Each phase is a distinct LLM call with structured output.
 * Full chain is recorded in ICoTScratchpad for auditability.
 *
 * @layer Domain (port contract)
 * @see Book Ch.17 "Reasoning" — 5-phase structured CoT (pp.330-355)
 * @see Book Ch.4 "Reflection" — verify phase uses reflection pattern
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Types ──────────────────────────────────────────────────────────

/** The 5 phases of structured reasoning, executed sequentially. */
export type ReasoningPhase = 'decompose' | 'plan' | 'execute' | 'verify' | 'synthesize';

/**
 * Configuration for a structured reasoning execution.
 */
export interface StructuredReasoningConfig {
  /** Model to use for each phase. If omitted, uses default model. */
  readonly model?: string;
  /** Per-phase timeout in ms. Default: 30_000. */
  readonly phaseTimeoutMs?: number;
  /** If true, skip the Verify phase (faster but less reliable). */
  readonly skipVerify?: boolean;
  /** Verification threshold (0-10). If verify score < threshold, re-execute. Default: 6. */
  readonly verifyThreshold?: number;
  /** Max re-execute attempts when verify fails. Default: 1 (total 2 attempts). */
  readonly maxRetries?: number;
}

/**
 * Result of a single reasoning phase.
 */
export interface PhaseResult {
  /** Which phase produced this result. */
  readonly phase: ReasoningPhase;
  /** 1-based phase number (1=decompose, ... 5=synthesize). */
  readonly phaseNumber: number;
  /** Output content from this phase. */
  readonly content: string;
  /** Tokens used in this phase (input). */
  readonly inputTokens: number;
  /** Tokens used in this phase (output). */
  readonly outputTokens: number;
  /** Duration of this phase in ms. */
  readonly durationMs: number;
}

/**
 * Final result of the full 5-phase reasoning protocol.
 */
export interface StructuredReasoningResult {
  /** Final synthesized answer. */
  readonly answer: string;
  /** Results from each phase (for audit trail). */
  readonly phases: readonly PhaseResult[];
  /** Total tokens used across all phases. */
  readonly totalTokens: number;
  /** Total execution time in ms. */
  readonly totalDurationMs: number;
  /** Whether the verify phase passed (null if skipped). */
  readonly verifyPassed: boolean | null;
  /** Verify score if verify phase ran (null if skipped). */
  readonly verifyScore: number | null;
  /** Number of execute→verify retry cycles performed. */
  readonly retries: number;
}

// ── Interface ──────────────────────────────────────────────────────

/**
 * 5-Phase Structured Reasoning Protocol.
 *
 * Book Ch.17: "For complex problems, breaking reasoning into explicit phases
 * with verification produces dramatically better results than single-shot."
 *
 * Depends on:
 *   - ILLMAdapterFactory — LLM calls per phase
 *   - ICoTScratchpad — records reasoning chain for auditability
 *   - ILlmJudge — verify phase uses LLM-as-Judge for self-evaluation
 *
 * @see DI_TOKENS.IStructuredReasoningProtocol
 */
export interface IStructuredReasoningProtocol {
  /**
   * Execute the full 5-phase reasoning protocol for a given task.
   *
   * Phases:
   * 1. **Decompose** — break complex problem into sub-problems
   * 2. **Plan** — create step-by-step approach for each sub-problem
   * 3. **Execute** — solve each sub-problem following the plan
   * 4. **Verify** — evaluate correctness of the solution (optional, uses ILlmJudge)
   * 5. **Synthesize** — combine sub-solutions into final answer
   *
   * @param task — the problem/question to reason about
   * @param context — optional additional context (documents, code, etc.)
   * @param config — execution configuration
   * @param correlationId — request correlation ID for tracing
   * @returns Structured reasoning result with all phases
   */
  reason(
    task: string,
    context: string | undefined,
    config: StructuredReasoningConfig,
    correlationId: CorrelationId,
  ): Promise<StructuredReasoningResult>;
}
