/**
 * IOutputGuardrailPipeline — Domain port for output guardrail orchestration.
 *
 * Pipeline of output guardrails: output rail scanner, PII detection, etc.
 * Orchestrates IOutputRail + other checks.
 *
 * Default Output Pipeline Stages:
 *   Stage 1: IOutputRail (existing regex/heuristic-based scanner)
 *   Stage 2: LLM-based content policy check (via ILlmJudge.judgeBinary)
 *
 * @layer Domain (depends only on Core)
 * @see Book Ch.18 "Safety & Security" — Output Guardrail Pipeline
 * @see NeMo Guardrails v0.20 5-layer model — L5 Output Rails
 */

import type { CorrelationId } from '../../core/types/branded';
import type { PipelineResult } from './guardrail-types';

// ── Options ─────────────────────────────────────────────────────────

/**
 * Optional configuration for output pipeline processing.
 *
 * @owasp LLM07 — `systemPromptFingerprints` enables project-specific
 *   system prompt leak detection (forwarded to IOutputRail.scan()).
 */
export interface OutputPipelineOptions {
  /**
   * Distinctive phrases extracted from the assembled system prompt.
   * If provided, IOutputRail will match these against LLM output
   * to detect system prompt leakage (OWASP LLM07).
   *
   * @see extractSystemPromptFingerprints (core/security/system-prompt-fingerprints.ts)
   */
  readonly systemPromptFingerprints?: readonly string[];
}

// ── Port Interface ──────────────────────────────────────────────────

/**
 * Orchestrates a pipeline of output guardrails.
 * Runs IOutputRail + LLM-based checks in sequence.
 */
export interface IOutputGuardrailPipeline {
  /**
   * Process LLM output through all pipeline stages.
   *
   * @param output — the LLM-generated output to validate
   * @param correlationId — request correlation ID for tracing
   * @param options — optional pipeline configuration (fingerprints, etc.)
   * @returns Pipeline result indicating allowed/blocked with check details
   */
  process(
    output: string,
    correlationId: CorrelationId,
    options?: OutputPipelineOptions,
  ): Promise<PipelineResult>;
}
