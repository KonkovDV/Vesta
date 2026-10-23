/**
 * InputGuardrailPipelineAdapter — Infrastructure adapter for IInputGuardrailPipeline.
 *
 * Orchestrates input guardrails in sequence: prompt injection scanner → content length → etc.
 * Stops on first blocking violation. Emits guardrail events for audit.
 *
 * NeMo Guardrails 5-layer model — L1 Input Rails.
 *
 * @layer Infrastructure (implements Domain port)
 * @see IInputGuardrailPipeline (src/domain/guardrails/input-pipeline.interface.ts)
 * @see Book Ch.18 "Safety & Security" — Input Guardrail Pipeline
 */

import type { IInputGuardrailPipeline } from '../../domain/guardrails/input-pipeline.interface';
import type { PipelineResult, GuardrailCheckResult, RailSeverity } from '../../domain/guardrails/guardrail-types';
import type { IPromptInjectionScanner } from '../../domain/security/prompt-injection-scanner.port';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';

// ── Constants ───────────────────────────────────────────────────────

/** Max input length (characters) before triggering content length guard */
const MAX_INPUT_LENGTH = 100_000;

// ── Adapter ─────────────────────────────────────────────────────────

export class InputGuardrailPipelineAdapter implements IInputGuardrailPipeline {
  constructor(
    private readonly injectionScanner: IPromptInjectionScanner,
    private readonly logger: ILogger,
  ) {}

  async process(
    input: string,
    correlationId: CorrelationId,
  ): Promise<PipelineResult> {
    this.logger.info('InputGuardrailPipeline: processing input', {
      correlationId,
      inputLength: input.length,
    });

    const checks: GuardrailCheckResult[] = [];

    // Stage 1: Prompt Injection Scanner (existing)
    const injectionResult = this.injectionScanner.detectSuspiciousPatterns(input);
    const injectionSeverity: RailSeverity = injectionResult.hasSuspiciousContent
      ? (injectionResult.confidence >= 0.8 ? 'critical' : 'high')
      : 'low';

    checks.push({
      scannerName: 'PromptInjectionScanner',
      passed: !injectionResult.hasSuspiciousContent,
      severity: injectionSeverity,
      details: injectionResult.hasSuspiciousContent
        ? `Detected ${injectionResult.matchCount} suspicious pattern(s), confidence: ${injectionResult.confidence}`
        : undefined,
    });

    if (injectionResult.hasSuspiciousContent && injectionResult.confidence >= 0.8) {
      this.logger.warn('InputGuardrailPipeline: blocked by injection scanner', {
        correlationId,
        matchCount: injectionResult.matchCount,
        confidence: injectionResult.confidence,
      });

      return {
        allowed: false,
        checks,
        blockedBy: 'PromptInjectionScanner',
      };
    }

    // Stage 2: Content Length Guard
    const lengthPassed = input.length <= MAX_INPUT_LENGTH;
    checks.push({
      scannerName: 'ContentLengthGuard',
      passed: lengthPassed,
      severity: lengthPassed ? 'low' : 'high',
      details: lengthPassed
        ? undefined
        : `Input length ${input.length} exceeds max ${MAX_INPUT_LENGTH}`,
    });

    if (!lengthPassed) {
      this.logger.warn('InputGuardrailPipeline: blocked by content length guard', {
        correlationId,
        inputLength: input.length,
        maxLength: MAX_INPUT_LENGTH,
      });

      return {
        allowed: false,
        checks,
        blockedBy: 'ContentLengthGuard',
      };
    }

    this.logger.info('InputGuardrailPipeline: all checks passed', {
      correlationId,
      checksCount: checks.length,
    });

    return {
      allowed: true,
      checks,
    };
  }
}
