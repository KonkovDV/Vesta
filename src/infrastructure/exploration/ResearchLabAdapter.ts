/**
 * ResearchLabAdapter — Infrastructure adapter for IResearchLabOrchestrator.
 *
 * Orchestrates a multi-phase research pipeline:
 *   Phase 1: Literature Review (ProfessorAgent)
 *   Phase 2: Hypothesis & Plan (PostdocAgent)
 *   Phase 3: Experiment Design (MLEngineerAgent)
 *   Phase 4: Writing & Synthesis (WriterAgent)
 *   Phase 5: Review (optional, via IReviewerPanel)
 *
 * Best Practices Applied (March 2026):
 * - Sequential phase execution with per-phase timeout
 * - Partial result return on failure (returnPartialOnFailure)
 * - IReviewerPanel integration for multi-persona peer review
 * - correlationId in all log entries (Hard Rule #6)
 * - temperature varies per phase: literature 0.2, hypothesis 0.5, writing 0.7
 *
 * DI: constructor(llmFactory, reviewerPanel, logger) — 3 args
 *
 * @layer Infrastructure (implements Domain port)
 * @see IResearchLabOrchestrator (src/domain/exploration/research-lab.interface.ts)
 * @see Book Ch.21 "Agent Laboratory" — multi-agent research orchestrator
 */

import type {
  IResearchLabOrchestrator,
  LabConfig,
  LabPhase,
  LabResult,
} from '../../domain/exploration/research-lab.interface';
import type { IReviewerPanel, ReviewerPersona } from '../../domain/evaluation/reviewer-panel.interface';
import type { ILLMAdapterFactory } from '../../domain/ai/ILLMAdapterFactory';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';

// ── Phase definitions ──────────────────────────────────────────────

interface PhaseSpec {
  readonly name: string;
  readonly agent: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly buildPrompt: (topic: string, previousOutputs: readonly string[]) => string;
}

const RESEARCH_PHASES: readonly PhaseSpec[] = [
  {
    name: 'literature_review',
    agent: 'ProfessorAgent',
    temperature: 0.2,
    maxTokens: 2048,
    buildPrompt: (topic: string) => [
      'You are ProfessorAgent, a senior research director.',
      `Conduct a comprehensive literature review on: "${topic}"`,
      '',
      'Identify key papers, frameworks, and open questions.',
      'Structure your response as:',
      '1. Background and current state',
      '2. Key findings from literature',
      '3. Open questions and research gaps',
      '4. Suggested research directions',
    ].join('\n'),
  },
  {
    name: 'hypothesis_formation',
    agent: 'PostdocAgent',
    temperature: 0.5,
    maxTokens: 1536,
    buildPrompt: (topic: string, prev: readonly string[]) => [
      'You are PostdocAgent, a research scientist.',
      `Based on the literature review below, formulate research hypotheses on: "${topic}"`,
      '',
      '=== LITERATURE REVIEW ===',
      prev[0] ?? 'No prior output.',
      '',
      'Provide:',
      '1. Primary hypothesis',
      '2. Secondary hypotheses',
      '3. Experimental approach',
      '4. Expected outcomes',
    ].join('\n'),
  },
  {
    name: 'experiment_design',
    agent: 'MLEngineerAgent',
    temperature: 0.3,
    maxTokens: 1536,
    buildPrompt: (topic: string, prev: readonly string[]) => [
      'You are MLEngineerAgent, a technical implementer.',
      `Design experiments to test the hypotheses below on: "${topic}"`,
      '',
      '=== HYPOTHESES ===',
      prev[1] ?? 'No prior output.',
      '',
      'Provide:',
      '1. Experiment methodology',
      '2. Metrics and evaluation criteria',
      '3. Implementation plan',
      '4. Expected results and baselines',
    ].join('\n'),
  },
  {
    name: 'writing',
    agent: 'WriterAgent',
    temperature: 0.7,
    maxTokens: 4096,
    buildPrompt: (topic: string, prev: readonly string[]) => [
      'You are WriterAgent, a scientific writer.',
      `Write a comprehensive research report on: "${topic}"`,
      '',
      '=== LITERATURE REVIEW ===',
      prev[0] ?? '',
      '',
      '=== HYPOTHESES ===',
      prev[1] ?? '',
      '',
      '=== EXPERIMENT DESIGN ===',
      prev[2] ?? '',
      '',
      'Write a structured paper with:',
      '1. Abstract',
      '2. Introduction',
      '3. Methodology',
      '4. Results (based on experiment design)',
      '5. Discussion',
      '6. Conclusion',
    ].join('\n'),
  },
] as const;

/** Default reviewer personas for research review. */
const DEFAULT_REVIEWERS: readonly ReviewerPersona[] = [
  {
    name: 'Reviewer-1',
    role: 'Technical Rigor Expert',
    systemPrompt: 'You are a harsh but fair reviewer who focuses on technical correctness and methodology.',
    focusArea: 'technical rigor',
  },
  {
    name: 'Reviewer-2',
    role: 'Impact & Significance Expert',
    systemPrompt: 'You are a critical reviewer who values real-world impact and significance.',
    focusArea: 'impact and significance',
  },
  {
    name: 'Reviewer-3',
    role: 'Novelty & Innovation Expert',
    systemPrompt: 'You are an open-minded reviewer who rewards innovation and novel approaches.',
    focusArea: 'novelty and innovation',
  },
] as const;

// ── Adapter ─────────────────────────────────────────────────────────

export class ResearchLabAdapter implements IResearchLabOrchestrator {
  constructor(
    private readonly llmFactory: ILLMAdapterFactory,
    private readonly reviewerPanel: IReviewerPanel,
    private readonly logger: ILogger,
  ) {}

  async conductResearch(
    config: LabConfig,
    correlationId: CorrelationId,
  ): Promise<LabResult> {
    const startMs = Date.now();

    this.logger.info('ResearchLabAdapter.conductResearch.start', {
      correlationId,
      topic: config.topic,
      maxPhases: config.maxPhases,
      useReviewPanel: config.useReviewPanel,
    });

    const { adapter: llm } = await this.llmFactory.createAdapterWithFailover();
    const phases: LabPhase[] = [];
    const outputs: string[] = [];
    const maxPhases = Math.min(config.maxPhases, RESEARCH_PHASES.length);

    // Execute research phases sequentially
    for (let i = 0; i < maxPhases; i++) {
      const phaseSpec = RESEARCH_PHASES[i];

      try {
        const phaseOutput = await this.executePhase(
          llm,
          phaseSpec,
          config.topic,
          outputs,
          config.phaseTimeoutMs,
          correlationId,
        );
        phases.push(phaseOutput);
        outputs.push(phaseOutput.output);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn('ResearchLabAdapter.phaseFailed', {
          correlationId,
          phase: phaseSpec.name,
          agent: phaseSpec.agent,
          error: message,
        });

        if (config.returnPartialOnFailure) {
          return this.buildPartialResult(phases, outputs, config, startMs);
        }
        throw error;
      }
    }

    // Optional review phase
    let reviewResult = undefined;
    if (config.useReviewPanel && outputs.length > 0) {
      try {
        const finalPaper = outputs[outputs.length - 1];
        const plan = outputs[1] ?? config.topic;
        reviewResult = await this.reviewerPanel.review(
          finalPaper,
          plan,
          DEFAULT_REVIEWERS,
          correlationId,
        );

        this.logger.info('ResearchLabAdapter.reviewComplete', {
          correlationId,
          consensus: reviewResult.consensus,
          averageScore: reviewResult.averageScore,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn('ResearchLabAdapter.reviewFailed', {
          correlationId,
          error: message,
        });
      }
    }

    const totalDurationMs = Date.now() - startMs;

    this.logger.info('ResearchLabAdapter.conductResearch.complete', {
      correlationId,
      phasesCompleted: phases.length,
      totalDurationMs,
    });

    return {
      finalPaper: outputs[outputs.length - 1] ?? '',
      phases,
      reviewResult,
      iterations: 1,
      totalDurationMs,
    };
  }

  // ── Private helpers ─────────────────────────────────────────────

  private async executePhase(
    llm: { generateText: (prompt: string, options?: { temperature?: number; maxTokens?: number }) => Promise<{ text: string }> },
    spec: PhaseSpec,
    topic: string,
    previousOutputs: readonly string[],
    timeoutMs: number | undefined,
    correlationId: CorrelationId,
  ): Promise<LabPhase> {
    const phaseStartMs = Date.now();

    this.logger.info('ResearchLabAdapter.executePhase.start', {
      correlationId,
      phase: spec.name,
      agent: spec.agent,
    });

    const prompt = spec.buildPrompt(topic, previousOutputs);

    let result: { text: string };
    if (timeoutMs) {
      // FIX-S2-05: clearTimeout on success to prevent timer leak (F-001 pattern)
      let timerId: ReturnType<typeof setTimeout> | undefined;
      try {
        result = await Promise.race([
          llm.generateText(prompt, { temperature: spec.temperature, maxTokens: spec.maxTokens }),
          new Promise<never>((_, reject) => {
            timerId = setTimeout(() => reject(new Error(`Phase "${spec.name}" timeout after ${timeoutMs}ms`)), timeoutMs);
          }),
        ]);
      } finally {
        if (timerId) clearTimeout(timerId);
      }
    } else {
      result = await llm.generateText(prompt, { temperature: spec.temperature, maxTokens: spec.maxTokens });
    }

    const durationMs = Date.now() - phaseStartMs;

    this.logger.info('ResearchLabAdapter.executePhase.complete', {
      correlationId,
      phase: spec.name,
      agent: spec.agent,
      durationMs,
      outputLength: result.text.length,
    });

    return {
      name: spec.name,
      agent: spec.agent,
      output: result.text,
      durationMs,
    };
  }

  private buildPartialResult(
    phases: readonly LabPhase[],
    outputs: readonly string[],
    config: LabConfig,
    startMs: number,
  ): LabResult {
    return {
      finalPaper: outputs[outputs.length - 1] ?? `[Partial] Research on "${config.topic}" interrupted after ${phases.length} phases.`,
      phases,
      iterations: 1,
      totalDurationMs: Date.now() - startMs,
    };
  }
}
