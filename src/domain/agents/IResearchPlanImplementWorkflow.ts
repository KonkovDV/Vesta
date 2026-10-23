/**
 * Research-Plan-Implement (RPI) Workflow — 3-phase development methodology.
 *
 * Models the structured approach: Research → Plan → Implement with
 * validation gates between each phase. Integrates with ITaskDecomposer
 * for plan generation and ITokenomicsController for budget governance.
 *
 * @layer Domain (port)
 * @module agents
 * @pattern CC-003 RPI Workflow (FITNESS-K: 77.5)
 * @see src/application/agents/core/task-decomposer.ts — ITaskDecomposer composition
 * @see src/domain/finops/ITokenomicsController.ts — FinOps cost governance
 */

import type { CorrelationId } from '../../core/types/branded';

// ── RPI Phase ──────────────────────────────────────────────────────

/**
 * The three phases of the RPI development workflow.
 */
export type RpiPhase = 'research' | 'plan' | 'implement';

// ── Research Artifact ──────────────────────────────────────────────

/**
 * Output of the Research phase — gathered context and analysis.
 */
export interface ResearchArtifact {
  /** Unique artifact identifier. */
  readonly artifactId: string;
  /** Summary of research findings. */
  readonly summary: string;
  /** Key files/interfaces discovered during research. */
  readonly discoveredFiles: ReadonlyArray<string>;
  /** Identified constraints and dependencies. */
  readonly constraints: ReadonlyArray<string>;
  /** Estimated complexity (1-10). */
  readonly estimatedComplexity: number;
  /** Raw research notes (unstructured). */
  readonly notes?: string;
}

// ── Plan Artifact ──────────────────────────────────────────────────

/**
 * Output of the Plan phase — structured execution plan.
 */
export interface PlanArtifact {
  /** Unique artifact identifier. */
  readonly artifactId: string;
  /** Ordered list of implementation steps. */
  readonly steps: ReadonlyArray<PlanStep>;
  /** Files that will be created or modified. */
  readonly affectedFiles: ReadonlyArray<string>;
  /** Estimated token cost for implementation (USD). */
  readonly estimatedCostUsd: number;
  /** Research artifact that informed this plan. */
  readonly researchArtifactId: string;
}

/**
 * A single step in the implementation plan.
 */
export interface PlanStep {
  /** 0-based step index. */
  readonly stepIndex: number;
  /** Step description. */
  readonly description: string;
  /** Target file path. */
  readonly targetFile: string;
  /** Type of change. */
  readonly changeType: 'create' | 'modify' | 'delete';
  /** Dependencies on other steps (by index). */
  readonly dependsOn: ReadonlyArray<number>;
}

// ── Implement Artifact ─────────────────────────────────────────────

/**
 * Output of the Implement phase — execution results.
 */
export interface ImplementArtifact {
  /** Unique artifact identifier. */
  readonly artifactId: string;
  /** Plan artifact that guided this implementation. */
  readonly planArtifactId: string;
  /** Steps that were successfully executed. */
  readonly completedSteps: ReadonlyArray<number>;
  /** Steps that failed. */
  readonly failedSteps: ReadonlyArray<{ stepIndex: number; error: string }>;
  /** Actual cost incurred (USD). */
  readonly actualCostUsd: number;
  /** Whether all steps completed successfully. */
  readonly isComplete: boolean;
}

// ── Validation Gate ────────────────────────────────────────────────

/**
 * Validation gate between RPI phases.
 * Gates enforce quality and budget constraints before phase transitions.
 */
export interface ValidationGate {
  /** Phase that produced the artifact being validated. */
  readonly fromPhase: RpiPhase;
  /** Phase that will execute if the gate passes. */
  readonly toPhase: RpiPhase;
  /** Gate criteria (human-readable). */
  readonly criteria: ReadonlyArray<string>;
  /** Maximum allowed cost to proceed (USD). 0 = no limit. */
  readonly maxCostUsd: number;
}

/**
 * Result of a validation gate evaluation.
 */
export type GateDecision = 'pass' | 'fail' | 'retry';

/**
 * Full gate evaluation result with reasoning.
 */
export interface GateEvaluationResult {
  /** The gate that was evaluated. */
  readonly gate: ValidationGate;
  /** Decision: pass, fail, or retry. */
  readonly decision: GateDecision;
  /** Reason for the decision. */
  readonly reason: string;
  /** Failing criteria (empty if passed). */
  readonly failedCriteria: ReadonlyArray<string>;
}

// ── RPI Task ───────────────────────────────────────────────────────

/**
 * A task definition fed into the RPI workflow.
 */
export interface RpiTask {
  /** Unique task identifier. */
  readonly taskId: string;
  /** Task description / user request. */
  readonly description: string;
  /** Agent ID executing this workflow. */
  readonly agentId: string;
  /** Maximum total budget (USD). */
  readonly maxBudgetUsd: number;
  /** Roles assigned to this workflow (e.g., 'requirement-parser', 'senior-software-engineer'). */
  readonly roles?: ReadonlyArray<string>;
}

// ── RPI Workflow Result ────────────────────────────────────────────

/**
 * Final result of the RPI workflow execution.
 */
export interface RpiWorkflowResult {
  /** The task that was executed. */
  readonly taskId: string;
  /** Final phase reached. */
  readonly finalPhase: RpiPhase;
  /** Whether the workflow completed all 3 phases. */
  readonly isComplete: boolean;
  /** Research output (always present if research phase ran). */
  readonly research?: ResearchArtifact;
  /** Plan output (present if plan phase ran). */
  readonly plan?: PlanArtifact;
  /** Implementation output (present if implement phase ran). */
  readonly implementation?: ImplementArtifact;
  /** Gate evaluation results (between phases). */
  readonly gateResults: ReadonlyArray<GateEvaluationResult>;
  /** Total cost incurred across all phases (USD). */
  readonly totalCostUsd: number;
  /** Total duration in milliseconds. */
  readonly totalDurationMs: number;
  /** Error details if workflow failed. */
  readonly error?: string;
}

// ── Domain Port ────────────────────────────────────────────────────

/**
 * Domain port for the Research-Plan-Implement development workflow.
 *
 * Orchestrates three sequential phases with validation gates between them.
 * Each phase produces typed artifacts that feed into the next phase.
 * Gates enforce quality, cost, and completeness constraints.
 *
 * @pattern CC-003 RPI Workflow — structured 3-phase development methodology
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface IResearchPlanImplementWorkflow {
  /**
   * Execute the full RPI workflow for a task.
   * Runs Research → Gate → Plan → Gate → Implement sequentially.
   * @param task - Task definition with budget constraints.
   * @param correlationId - Request correlation for tracing.
   * @returns Full workflow result with artifacts from each phase.
   */
  executeWorkflow(
    task: RpiTask,
    correlationId: CorrelationId,
  ): Promise<RpiWorkflowResult>;

  /**
   * Execute a single phase of the workflow.
   * Used for retry scenarios after a gate failure.
   * @param phase - The phase to execute.
   * @param task - Task definition.
   * @param previousArtifacts - Artifacts from previous phases.
   * @param correlationId - Request correlation for tracing.
   */
  executePhase(
    phase: RpiPhase,
    task: RpiTask,
    previousArtifacts: { research?: ResearchArtifact; plan?: PlanArtifact },
    correlationId: CorrelationId,
  ): Promise<ResearchArtifact | PlanArtifact | ImplementArtifact>;

  /**
   * Evaluate a validation gate between phases.
   * @param gate - Gate definition with criteria.
   * @param artifact - The artifact to validate.
   * @param correlationId - Request correlation for tracing.
   */
  evaluateGate(
    gate: ValidationGate,
    artifact: ResearchArtifact | PlanArtifact,
    correlationId: CorrelationId,
  ): Promise<GateEvaluationResult>;
}
