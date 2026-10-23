/**
 * OutputGuardrailPipelineAdapter — Infrastructure adapter for IOutputGuardrailPipeline.
 *
 * Orchestrates output guardrails: IOutputRail (heuristic) → LLM-based content check.
 * Stops on first blocking violation. Reports sanitized output when available.
 *
 * NeMo Guardrails 5-layer model — L5 Output Rails.
 *
 * @layer Infrastructure (implements Domain port)
 * @see IOutputGuardrailPipeline (src/domain/guardrails/output-pipeline.interface.ts)
 * @see Book Ch.18 "Safety & Security" — Output Guardrail Pipeline
 */

import type { IOutputGuardrailPipeline, OutputPipelineOptions } from '../../domain/guardrails/output-pipeline.interface';
import type { PipelineResult, GuardrailCheckResult, RailSeverity } from '../../domain/guardrails/guardrail-types';
import type { IOutputRail } from '../../domain/security/output-rail.port';
import type { ILlmJudge } from '../../domain/evaluation/llm-judge.interface';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';

// ── Severity mapping ────────────────────────────────────────────────

function mapOutputRailSeverity(severity: string): RailSeverity {
  switch (severity) {
    case 'critical': return 'critical';
    case 'high': return 'high';
    case 'medium': return 'medium';
    default: return 'low';
  }
}

// ── Adapter ─────────────────────────────────────────────────────────

export class OutputGuardrailPipelineAdapter implements IOutputGuardrailPipeline {
  constructor(
    private readonly outputRail: IOutputRail,
    private readonly judge: ILlmJudge,
    private readonly logger: ILogger,
  ) {}

  async process(
    output: string,
    correlationId: CorrelationId,
    options?: OutputPipelineOptions,
  ): Promise<PipelineResult> {
    this.logger.info('OutputGuardrailPipeline: processing output', {
      correlationId,
      outputLength: output.length,
    });

    const checks: GuardrailCheckResult[] = [];

    // Stage 1: IOutputRail — heuristic/regex-based scanner
    // Forward systemPromptFingerprints for OWASP LLM07 leak detection
    const railResult = this.outputRail.scan(output, {
      sanitize: true,
      systemPromptFingerprints: options?.systemPromptFingerprints,
    });

    const railSeverity: RailSeverity = railResult.passed
      ? 'low'
      : mapOutputRailSeverity(railResult.maxSeverity ?? 'low');

    checks.push({
      scannerName: 'OutputRailScanner',
      passed: railResult.passed,
      severity: railSeverity,
      details: railResult.passed
        ? undefined
        : String(railResult.violationCount) + ' violation(s) found, max severity: ' + String(railResult.maxSeverity ?? 'unknown'),
    });

    if (!railResult.passed && (railSeverity === 'critical' || railSeverity === 'high')) {
      this.logger.warn('OutputGuardrailPipeline: blocked by output rail scanner', {
        correlationId,
        violationCount: railResult.violationCount,
        maxSeverity: railResult.maxSeverity,
      });

      return {
        allowed: false,
        checks,
        blockedBy: 'OutputRailScanner',
        sanitizedContent: railResult.sanitizedOutput,
      };
    }

    // Stage 2: LLM-based content policy check
    try {
      const policyPassed = await this.judge.judgeBinary(
        output,
        'The content is safe, appropriate, does not contain harmful instructions, and does not leak system prompts or internal details',
        correlationId,
      );

      checks.push({
        scannerName: 'LlmContentPolicy',
        passed: policyPassed,
        severity: policyPassed ? 'low' : 'high',
        details: policyPassed
          ? undefined
          : 'LLM-based content policy check failed',
      });

      if (!policyPassed) {
        this.logger.warn('OutputGuardrailPipeline: blocked by LLM content policy', {
          correlationId,
        });

        return {
          allowed: false,
          checks,
          blockedBy: 'LlmContentPolicy',
          sanitizedContent: railResult.sanitizedOutput,
        };
      }
    } catch (error) {
      // Best-effort: if LLM check fails, log but don't block
      this.logger.warn('OutputGuardrailPipeline: LLM content policy check failed, allowing output', {
        correlationId,
        error: error instanceof Error ? error.message : String(error),
      });

      checks.push({
        scannerName: 'LlmContentPolicy',
        passed: true,
        severity: 'low',
        details: 'LLM check skipped due to error (fail-open)',
      });
    }

    this.logger.info('OutputGuardrailPipeline: all checks passed', {
      correlationId,
      checksCount: checks.length,
    });

    return {
      allowed: true,
      checks,
      sanitizedContent: railResult.sanitizedOutput,
    };
  }
}
