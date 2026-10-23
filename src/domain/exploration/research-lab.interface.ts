/**
 * IResearchLabOrchestrator — Domain port for multi-agent research lab.
 *
 * Coordinates a multi-phase research pipeline:
 * Professor → Postdoc → ML Engineer → Reviewers → Revision loop.
 * Each phase is handled by a specialized agent persona.
 *
 * @layer Domain (port contract)
 * @see Book Ch.21 "Agent Laboratory" — multi-agent research orchestrator
 * @see IReviewerPanel (src/domain/evaluation/reviewer-panel.interface.ts)
 * @see IAgentDialogueLoop (src/domain/mas/agent-dialogue-loop.interface.ts)
 */

import type { CorrelationId } from '../../core/types/branded';
import type { PanelResult } from '../evaluation/reviewer-panel.interface';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Configuration for a research lab session.
 */
export interface LabConfig {
  readonly topic: string;
  readonly maxPhases: number;              // default 4
  readonly useReviewPanel: boolean;        // enable multi-persona review
  readonly maxIterations: number;          // revision iterations
  readonly phaseTimeoutMs?: number;        // per-phase timeout
  readonly returnPartialOnFailure: boolean; // return partial results on crash
}

/**
 * Output of a single research phase.
 */
export interface LabPhase {
  readonly name: string;
  readonly agent: string;                  // ProfessorAgent, PostdocAgent, etc.
  readonly output: string;
  readonly durationMs: number;
}

/**
 * Final result of a research lab session.
 */
export interface LabResult {
  readonly finalPaper: string;
  readonly phases: readonly LabPhase[];
  readonly reviewResult?: PanelResult;
  readonly iterations: number;
  readonly totalDurationMs: number;
}

// ── Interface ──────────────────────────────────────────────────────

/**
 * Agent Laboratory — multi-agent research orchestrator.
 * Coordinates ProfessorAgent → PostdocAgent → MLEngineerAgent → ReviewersAgent.
 *
 * @see DI_TOKENS.IResearchLabOrchestrator
 */
export interface IResearchLabOrchestrator {
  /**
   * Conduct a full multi-phase research session.
   *
   * @param config        — lab configuration (topic, phases, review settings)
   * @param correlationId — request correlation ID for tracing
   * @returns Complete lab result with all phase outputs and optional review
   */
  conductResearch(
    config: LabConfig,
    correlationId: CorrelationId,
  ): Promise<LabResult>;
}
