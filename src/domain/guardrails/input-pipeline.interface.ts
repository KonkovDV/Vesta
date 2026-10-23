/**
 * IInputGuardrailPipeline — Domain port for input guardrail orchestration.
 *
 * Pipeline of input guardrails: prompt injection, content policy, etc.
 * Orchestrates multiple scanners in sequence, stops on first block.
 *
 * Default Input Pipeline Stages:
 *   Stage 1: IPromptInjectionScanner (EXISTING — 133 LOC, 12 patterns)
 *   Stage 2: ContentLengthGuard
 *   Stage 3: TopicBlocker (LLM-based via ILlmJudge.judgeBinary)
 *
 * @layer Domain (depends only on Core)
 * @see Book Ch.18 "Safety & Security" — Input Guardrail Pipeline
 * @see NeMo Guardrails v0.20 5-layer model — L1 Input Rails
 */

import type { CorrelationId } from '../../core/types/branded';
import type { PipelineResult } from './guardrail-types';

// ── Port Interface ──────────────────────────────────────────────────

/**
 * Orchestrates a pipeline of input guardrails.
 * Runs each check in sequence, stops on first blocking violation.
 */
export interface IInputGuardrailPipeline {
  /**
   * Process input through all pipeline stages.
   *
   * @param input — the user input to validate
   * @param correlationId — request correlation ID for tracing
   * @returns Pipeline result indicating allowed/blocked with check details
   */
  process(
    input: string,
    correlationId: CorrelationId,
  ): Promise<PipelineResult>;
}
