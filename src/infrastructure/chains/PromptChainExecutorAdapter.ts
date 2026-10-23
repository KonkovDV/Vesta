/**
 * PromptChainExecutorAdapter — Infrastructure Adapter
 *
 * Executes a sequential chain of prompt steps via ILLMAdapterFactory.
 * Each step pipes its output to the next via {{prev_output}} placeholder.
 * Steps can be conditionally skipped (ADK conditional routing, Ch.2).
 *
 * Best Practices Applied (March 2026):
 * - Atom of Thoughts (Teng et al., NeurIPS 2025): each step is self-contained,
 *   with explicit context passing via template variables
 * - ADK conditional routing: condition function per step for branching
 * - Template variable validation before execution (fail-fast)
 * - onStepComplete callback for streaming progress
 * - Token tracking across all steps
 *
 * DI: constructor(llmFactory: ILLMAdapterFactory, logger: ILogger) — 2 args
 *
 * @see Book Ch.1 "Building Blocks" — Prompt Chain Pipeline
 * @see Book Ch.2 "ADK" — Conditional Routing
 */

import type { CorrelationId } from '../../core/types/branded';
import type { ILogger } from '../../core/decorators/ILogger';
import type { ILLMAdapterFactory } from '../../domain/ai/ILLMAdapterFactory';
import type {
  IPromptChainExecutor,
  ChainStep,
  ChainContext,
  ChainResult,
} from '../../domain/chains/prompt-chain.interface';
import { ChainStepFailedError } from '../../domain/errors/agentic-errors';

export class PromptChainExecutorAdapter implements IPromptChainExecutor {
  constructor(
    private readonly llmFactory: ILLMAdapterFactory,
    private readonly logger: ILogger,
  ) {}

  async executeChain(
    steps: readonly ChainStep[],
    input: string,
    correlationId: CorrelationId,
    onStepComplete?: (stepName: string, output: string) => void,
  ): Promise<ChainResult> {
    const startTime = Date.now();

    this.logger.info('PromptChainExecutor.executeChain', {
      correlationId,
      totalSteps: steps.length,
    });

    // Validate template variables before execution (fail-fast)
    this.validateTemplateVars(steps, input, correlationId);

    const stepOutputs: Record<string, string> = {};
    const skippedSteps: string[] = [];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let prevOutput = input;
    let stepsExecuted = 0;

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const context: ChainContext = {
        steps: { ...stepOutputs },
        currentStep: i,
        input,
      };

      // Conditional routing (ADK Ch.2) — skip step if condition is false
      if (step.condition && !step.condition(context)) {
        skippedSteps.push(step.name);
        this.logger.info('PromptChainExecutor.stepSkipped', {
          correlationId,
          stepName: step.name,
          stepNumber: i + 1,
        });
        continue;
      }

      // Resolve template variables in prompt
      const resolvedPrompt = this.resolveTemplate(step.prompt, {
        prev_output: prevOutput,
        input,
        ...stepOutputs,
      });

      try {
        // Create LLM adapter (with optional per-step model override)
        const { adapter } = await this.llmFactory.createAdapterWithFailover(
          step.model,
        );

        const result = await adapter.generateText(resolvedPrompt, {
          temperature: 0.7,
          maxTokens: 4096,
        });
        const output = result.text;

        // Track tokens
        totalInputTokens += result.usage?.promptTokens ?? 0;
        totalOutputTokens += result.usage?.completionTokens ?? 0;

        // Validate step output if validator is provided
        if (step.validator && !step.validator(output)) {
          throw new ChainStepFailedError(
            `Step "${step.name}" output failed validation`,
            step.name,
            i + 1,
            correlationId,
          );
        }

        stepOutputs[step.outputKey] = output;
        prevOutput = output;
        stepsExecuted++;

        this.logger.info('PromptChainExecutor.stepCompleted', {
          correlationId,
          stepName: step.name,
          stepNumber: i + 1,
          outputLength: output.length,
        });

        // Streaming progress callback
        if (onStepComplete) {
          onStepComplete(step.name, output);
        }
      } catch (error) {
        if (error instanceof ChainStepFailedError) throw error;
        throw new ChainStepFailedError(
          `Step "${step.name}" failed: ${(error as Error).message}`,
          step.name,
          i + 1,
          correlationId,
        );
      }
    }

    const durationMs = Date.now() - startTime;
    const finalOutput = prevOutput;

    this.logger.info('PromptChainExecutor.chainCompleted', {
      correlationId,
      stepsExecuted,
      skippedSteps: skippedSteps.length,
      durationMs,
    });

    return {
      steps: stepOutputs,
      finalOutput,
      stepsExecuted,
      skippedSteps,
      totalTokens: { input: totalInputTokens, output: totalOutputTokens },
      durationMs,
    };
  }

  /** Validate that all declared templateVars are resolvable */
  private validateTemplateVars(
    steps: readonly ChainStep[],
    input: string,
    correlationId: CorrelationId,
  ): void {
    const availableKeys = new Set<string>(['prev_output', 'input']);

    for (const step of steps) {
      if (step.templateVars) {
        for (const varName of step.templateVars) {
          if (!availableKeys.has(varName)) {
            throw new ChainStepFailedError(
              `Template variable "{{${varName}}}" in step "${step.name}" is not available. Available: [${[...availableKeys].join(', ')}]`,
              step.name,
              0,
              correlationId,
            );
          }
        }
      }
      // After this step, its outputKey becomes available
      availableKeys.add(step.outputKey);
    }
  }

  /**
   * Resolve {{placeholder}} template variables in prompt text.
   * FIX-R04: Single-pass replacement with value escaping to prevent
   * recursive template injection when prev_output contains {{...}} patterns.
   */
  private resolveTemplate(
    template: string,
    vars: Record<string, string>,
  ): string {
    // Single-pass: collect all replacements, then apply
    // This prevents values containing {{...}} from being expanded recursively
    return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
      const value = vars[key];
      if (value === undefined) return match;
      // Escape any {{ and }} in the value to prevent re-expansion
      return value.replace(/\{\{/g, '\u007B\u007B').replace(/\}\}/g, '\u007D\u007D');
    });
  }
}
