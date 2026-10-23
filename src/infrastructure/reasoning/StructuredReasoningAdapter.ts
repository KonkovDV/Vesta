/**
 * StructuredReasoningAdapter — Infrastructure adapter for IStructuredReasoningProtocol.
 *
 * Implements the 5-phase CoT: Decompose → Plan → Execute → Verify → Synthesize.
 * Each phase is a distinct LLM call. Verify phase uses ILlmJudge.
 * All reasoning is recorded in ICoTScratchpad for auditability.
 *
 * @layer Infrastructure (implements Domain port)
 * @see IStructuredReasoningProtocol (src/domain/reasoning/structured-reasoning.interface.ts)
 * @see Book Ch.17 "Reasoning" — 5-phase structured CoT (pp.330-355)
 */

import type {
  IStructuredReasoningProtocol,
  StructuredReasoningConfig,
  StructuredReasoningResult,
  PhaseResult,
  ReasoningPhase,
} from '../../domain/reasoning/structured-reasoning.interface';
import type { ILLMAdapterFactory } from '../../domain/ai/ILLMAdapterFactory';
import type { ICoTScratchpad } from '../../domain/reasoning/ICoTScratchpad';
import type { ILlmJudge, EvaluationRubric } from '../../domain/evaluation/llm-judge.interface';
import type { ILogger } from '../../core/decorators/ILogger';
import type { IEventStore, DomainEvent } from '../../domain/events/event-store.interface';
import { EventFactory } from '../../domain/events/event-store.interface';
import type { CorrelationId } from '../../core/types/branded';
import { ReasoningTimeoutError } from '../../domain/errors/agentic-errors';

// ── Phase numbers (1-indexed) ───────────────────────────────────────

const PHASE_ORDER: readonly ReasoningPhase[] = [
  'decompose', 'plan', 'execute', 'verify', 'synthesize',
] as const;

// ── Prompt builders ─────────────────────────────────────────────────

function buildDecomposePrompt(task: string, context?: string): string {
  const parts = [
    'You are an expert problem solver. Break the following task into distinct sub-problems.',
    '',
    '=== TASK ===',
    task,
  ];
  if (context) {
    parts.push('', '=== CONTEXT ===', context);
  }
  parts.push(
    '',
    'List each sub-problem on a separate line. Be specific and actionable.',
    'Output only the numbered sub-problems.',
  );
  return parts.join('\n');
}

function buildPlanPrompt(task: string, subProblems: string): string {
  return [
    'You are an expert planner. Create a step-by-step plan to solve each sub-problem.',
    '',
    '=== ORIGINAL TASK ===',
    task,
    '',
    '=== SUB-PROBLEMS ===',
    subProblems,
    '',
    'For each sub-problem, provide concrete steps. Be specific about methods and approaches.',
  ].join('\n');
}

function buildExecutePrompt(task: string, plan: string): string {
  return [
    'You are an expert executor. Solve each step of the plan thoroughly.',
    '',
    '=== ORIGINAL TASK ===',
    task,
    '',
    '=== PLAN ===',
    plan,
    '',
    'Execute each step in order. Provide complete, detailed solutions.',
  ].join('\n');
}

function buildSynthesizePrompt(task: string, solution: string, verifyFeedback?: string): string {
  const parts = [
    'You are an expert synthesizer. Combine the sub-solutions into a final, coherent answer.',
    '',
    '=== ORIGINAL TASK ===',
    task,
    '',
    '=== SUB-SOLUTIONS ===',
    solution,
  ];
  if (verifyFeedback) {
    parts.push('', '=== VERIFICATION FEEDBACK ===', verifyFeedback);
    parts.push('Address any issues noted in the verification.');
  }
  parts.push('', 'Provide a complete, polished final answer.');
  return parts.join('\n');
}

// ── Adapter ─────────────────────────────────────────────────────────

export class StructuredReasoningAdapter implements IStructuredReasoningProtocol {
  constructor(
    private readonly llmFactory: ILLMAdapterFactory,
    private readonly scratchpad: ICoTScratchpad,
    private readonly judge: ILlmJudge,
    private readonly logger: ILogger,
    private readonly eventStore: IEventStore,
  ) {}

  async reason(
    task: string,
    context: string | undefined,
    config: StructuredReasoningConfig,
    correlationId: CorrelationId,
  ): Promise<StructuredReasoningResult> {
    const startMs = Date.now();
    const phases: PhaseResult[] = [];
    let totalTokens = 0;
    let retries = 0;
    const maxRetries = config.maxRetries ?? 1;
    const verifyThreshold = config.verifyThreshold ?? 6;

    this.logger.info('StructuredReasoning starting', {
      correlationId,
      skipVerify: config.skipVerify,
      maxRetries,
    });

    try {
      // Phase 1: Decompose
      const decompose = await this.runPhase(
        'decompose', buildDecomposePrompt(task, context), config, correlationId,
      );
      phases.push(decompose);
      totalTokens += decompose.inputTokens + decompose.outputTokens;

      // Phase 2: Plan
      const plan = await this.runPhase(
        'plan', buildPlanPrompt(task, decompose.content), config, correlationId,
      );
      phases.push(plan);
      totalTokens += plan.inputTokens + plan.outputTokens;

      // Phase 3: Execute (with optional retry loop if verify fails)
      let execute = await this.runPhase(
        'execute', buildExecutePrompt(task, plan.content), config, correlationId,
      );
      phases.push(execute);
      totalTokens += execute.inputTokens + execute.outputTokens;

      // Phase 4: Verify (optional)
      let verifyPassed: boolean | null = null;
      let verifyScore: number | null = null;
      let verifyFeedback: string | undefined;

      if (!config.skipVerify) {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          const verifyResult = await this.verifyPhase(
            task, execute.content, config, correlationId,
          );
          verifyPassed = verifyResult.score >= verifyThreshold;
          verifyScore = verifyResult.score;
          verifyFeedback = verifyResult.feedback;

          // Emit verify phase event
          const verifyPhaseResult: PhaseResult = {
            phase: 'verify',
            phaseNumber: 4,
            content: verifyResult.feedback,
            inputTokens: 0,
            outputTokens: 0,
            durationMs: verifyResult.durationMs,
          };
          phases.push(verifyPhaseResult);

          await this.emitPhaseEvent(verifyPhaseResult, correlationId);

          if (verifyPassed || attempt === maxRetries) break;

          // Re-execute with verification feedback
          retries++;
          this.logger.info('StructuredReasoning verify failed, re-executing', {
            correlationId,
            attempt: attempt + 1,
            score: verifyScore,
            threshold: verifyThreshold,
          });

          execute = await this.runPhase(
            'execute',
            buildExecutePrompt(task, plan.content) +
              `\n\n=== PREVIOUS ISSUES ===\n${verifyFeedback}\nFix the issues above.`,
            config,
            correlationId,
          );
          phases.push(execute);
          totalTokens += execute.inputTokens + execute.outputTokens;
        }
      }

      // Phase 5: Synthesize
      const synthesize = await this.runPhase(
        'synthesize',
        buildSynthesizePrompt(task, execute.content, verifyFeedback),
        config,
        correlationId,
      );
      phases.push(synthesize);
      totalTokens += synthesize.inputTokens + synthesize.outputTokens;

      // Record in scratchpad for auditability
      await this.recordScratchpad(task, phases, correlationId);

      const totalDurationMs = Date.now() - startMs;

      this.logger.info('StructuredReasoning completed', {
        correlationId,
        totalPhases: phases.length,
        totalTokens,
        totalDurationMs,
        verifyPassed,
        retries,
      });

      return {
        answer: synthesize.content,
        phases,
        totalTokens,
        totalDurationMs,
        verifyPassed,
        verifyScore,
        retries,
      };
    } catch (error) {
      this.logger.error('StructuredReasoning failed', {
        correlationId,
        phasesCompleted: phases.length,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof ReasoningTimeoutError) throw error;

      throw new ReasoningTimeoutError(
        `Structured reasoning failed: ${error instanceof Error ? error.message : String(error)}`,
        correlationId,
      );
    }
  }

  // ── Private helpers ───────────────────────────────────────────────

  private async runPhase(
    phase: ReasoningPhase,
    prompt: string,
    config: StructuredReasoningConfig,
    correlationId: CorrelationId,
  ): Promise<PhaseResult> {
    const phaseStart = Date.now();
    const phaseNumber = PHASE_ORDER.indexOf(phase) + 1;

    const { adapter } = await this.llmFactory.createAdapterWithFailover();
    const result = await adapter.generateText(prompt, {
      maxTokens: 4096,
      temperature: phase === 'verify' ? 0.1 : 0.4,
      timeoutMs: config.phaseTimeoutMs,
    });

    const phaseResult: PhaseResult = {
      phase,
      phaseNumber,
      content: result.text.trim(),
      inputTokens: result.usage?.promptTokens ?? 0,
      outputTokens: result.usage?.completionTokens ?? 0,
      durationMs: Date.now() - phaseStart,
    };

    await this.emitPhaseEvent(phaseResult, correlationId);
    return phaseResult;
  }

  private async verifyPhase(
    task: string,
    solution: string,
    config: StructuredReasoningConfig,
    correlationId: CorrelationId,
  ): Promise<{ score: number; feedback: string; durationMs: number }> {
    const start = Date.now();
    const rubric: EvaluationRubric = {
      criteria: [
        { name: 'correctness', description: 'Is the solution factually correct?', scale: { min: 0, max: 10 }, weight: 2.0 },
        { name: 'completeness', description: 'Does the solution address all sub-problems?', scale: { min: 0, max: 10 }, weight: 1.5 },
        { name: 'coherence', description: 'Is the solution logically coherent?', scale: { min: 0, max: 10 }, weight: 1.0 },
      ],
      outputFormat: 'json',
    };

    const judgment = await this.judge.judge(solution, rubric, correlationId);

    return {
      score: judgment.overallScore,
      feedback: judgment.rationale + (judgment.concerns.length > 0
        ? '\nConcerns: ' + judgment.concerns.join('; ')
        : ''),
      durationMs: Date.now() - start,
    };
  }

  private async emitPhaseEvent(
    phaseResult: PhaseResult,
    correlationId: CorrelationId,
  ): Promise<void> {
    const event = EventFactory.createBaseEvent(
      'structured-reasoning',
      'agentic.reasoning.phase',
      {
        phase: phaseResult.phase,
        phaseNumber: phaseResult.phaseNumber,
        inputTokens: phaseResult.inputTokens,
        outputTokens: phaseResult.outputTokens,
      },
      correlationId,
    );
    await this.eventStore.saveEvents([event]);
  }

  private async recordScratchpad(
    task: string,
    phases: readonly PhaseResult[],
    correlationId: CorrelationId,
  ): Promise<void> {
    try {
      await this.scratchpad.record({
        agentId: 'structured-reasoning',
        sessionId: 'system',
        correlationId: correlationId,
        plannedAction: 'structured-reasoning',
        plannedArguments: { task: task.substring(0, 200) },
        riskLevel: 'low',
        reasoningChain: phases.map((p, i) => ({
          stepNumber: i + 1,
          thought: `Phase ${p.phase}: ${p.content.substring(0, 500)}`,
          confidence: 0.8,
        })),
        conclusion: `Completed ${phases.length} phases`,
        alternatives: [],
        estimatedCost: {
          tokens: phases.reduce((s, p) => s + p.inputTokens + p.outputTokens, 0),
          apiCalls: phases.length,
        },
      });
    } catch {
      // Scratchpad recording is best-effort — don't fail the reasoning
      this.logger.warn('Failed to record scratchpad entry', { correlationId });
    }
  }
}
