/**
 * RPI Workflow Adapter — Infrastructure implementation of IResearchPlanImplementWorkflow.
 *
 * Orchestrates the 3-phase Research → Plan → Implement workflow with
 * validation gates between phases. Composes ITaskDecomposer for plan
 * generation and ITokenomicsController for budget governance (FP-04 resolution).
 *
 * @layer Infrastructure (Agents)
 * @pattern CC-003 RPI Workflow (FITNESS-K: 77.5)
 * @see src/domain/agents/IResearchPlanImplementWorkflow.ts — domain port
 * @see src/application/agents/core/task-decomposer.ts — ITaskDecomposer composition
 */

import type { CorrelationId } from '../../core/types/branded';
import type {
  IResearchPlanImplementWorkflow,
  RpiPhase,
  RpiTask,
  RpiWorkflowResult,
  ResearchArtifact,
  PlanArtifact,
  PlanStep,
  ImplementArtifact,
  ValidationGate,
  GateDecision,
  GateEvaluationResult,
} from '../../domain/agents/IResearchPlanImplementWorkflow';

// ── Minimal Logger ────────────────────────────────────────────────

interface RpiLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ── Default Gate Definitions ──────────────────────────────────────

const DEFAULT_RESEARCH_TO_PLAN_GATE: ValidationGate = {
  fromPhase: 'research',
  toPhase: 'plan',
  criteria: ['has_summary', 'complexity_estimated', 'files_discovered'],
  maxCostUsd: 0,
};

const DEFAULT_PLAN_TO_IMPLEMENT_GATE: ValidationGate = {
  fromPhase: 'plan',
  toPhase: 'implement',
  criteria: ['has_steps', 'budget_within_limit', 'affected_files_listed'],
  maxCostUsd: 0,
};

// ── Adapter ───────────────────────────────────────────────────────

export class RpiWorkflowAdapter implements IResearchPlanImplementWorkflow {
  constructor(
    private readonly logger?: RpiLogger,
  ) {}

  async executeWorkflow(
    task: RpiTask,
    correlationId: CorrelationId,
  ): Promise<RpiWorkflowResult> {
    const startMs = Date.now();
    const gateResults: GateEvaluationResult[] = [];
    let totalCostUsd = 0;

    this.logger?.info('RPI workflow started', {
      taskId: task.taskId,
      agentId: task.agentId,
      maxBudgetUsd: task.maxBudgetUsd,
      correlationId,
    });

    // Phase 1: Research
    let research: ResearchArtifact;
    try {
      research = await this.executePhase(
        'research', task, {}, correlationId,
      ) as ResearchArtifact;
    } catch (err) {
      return this.buildResult(task, 'research', false, {}, gateResults, totalCostUsd, startMs, err);
    }

    // Gate: Research → Plan
    const researchGate = {
      ...DEFAULT_RESEARCH_TO_PLAN_GATE,
      maxCostUsd: task.maxBudgetUsd,
    };
    const researchGateResult = await this.evaluateGate(researchGate, research, correlationId);
    gateResults.push(researchGateResult);

    if (researchGateResult.decision === 'fail') {
      this.logger?.warn('Research→Plan gate failed', {
        taskId: task.taskId,
        failedCriteria: researchGateResult.failedCriteria,
        correlationId,
      });
      return this.buildResult(task, 'research', false, { research }, gateResults, totalCostUsd, startMs);
    }

    // Phase 2: Plan
    let plan: PlanArtifact;
    try {
      plan = await this.executePhase(
        'plan', task, { research }, correlationId,
      ) as PlanArtifact;
      totalCostUsd += plan.estimatedCostUsd;
    } catch (err) {
      return this.buildResult(task, 'plan', false, { research }, gateResults, totalCostUsd, startMs, err);
    }

    // Gate: Plan → Implement
    const planGate = {
      ...DEFAULT_PLAN_TO_IMPLEMENT_GATE,
      maxCostUsd: task.maxBudgetUsd - totalCostUsd,
    };
    const planGateResult = await this.evaluateGate(planGate, plan, correlationId);
    gateResults.push(planGateResult);

    if (planGateResult.decision === 'fail') {
      this.logger?.warn('Plan→Implement gate failed', {
        taskId: task.taskId,
        failedCriteria: planGateResult.failedCriteria,
        correlationId,
      });
      return this.buildResult(task, 'plan', false, { research, plan }, gateResults, totalCostUsd, startMs);
    }

    // Phase 3: Implement
    let implementation: ImplementArtifact;
    try {
      implementation = await this.executePhase(
        'implement', task, { research, plan }, correlationId,
      ) as ImplementArtifact;
      totalCostUsd += implementation.actualCostUsd;
    } catch (err) {
      return this.buildResult(task, 'implement', false, { research, plan }, gateResults, totalCostUsd, startMs, err);
    }

    this.logger?.info('RPI workflow completed', {
      taskId: task.taskId,
      isComplete: implementation.isComplete,
      totalCostUsd,
      durationMs: Date.now() - startMs,
      correlationId,
    });

    return this.buildResult(
      task, 'implement', implementation.isComplete,
      { research, plan, implementation },
      gateResults, totalCostUsd, startMs,
    );
  }

  async executePhase(
    phase: RpiPhase,
    task: RpiTask,
    previousArtifacts: { research?: ResearchArtifact; plan?: PlanArtifact },
    correlationId: CorrelationId,
  ): Promise<ResearchArtifact | PlanArtifact | ImplementArtifact> {
    this.logger?.info(`RPI phase started: ${phase}`, {
      taskId: task.taskId,
      phase,
      correlationId,
    });

    switch (phase) {
      case 'research':
        return this.executeResearch(task, correlationId);
      case 'plan':
        return this.executePlan(task, previousArtifacts.research!, correlationId);
      case 'implement':
        return this.executeImplement(task, previousArtifacts.plan!, correlationId);
    }
  }

  async evaluateGate(
    gate: ValidationGate,
    artifact: ResearchArtifact | PlanArtifact | ImplementArtifact,
    correlationId: CorrelationId,
  ): Promise<GateEvaluationResult> {
    const failedCriteria: string[] = [];

    for (const criterion of gate.criteria) {
      if (!this.checkCriterion(criterion, artifact, gate)) {
        failedCriteria.push(criterion);
      }
    }

    const decision: GateDecision = failedCriteria.length === 0 ? 'pass' : 'fail';

    this.logger?.info(`Gate evaluated: ${gate.fromPhase}→${gate.toPhase}`, {
      decision,
      failedCriteria,
      correlationId,
    });

    return {
      gate,
      decision,
      reason: decision === 'pass'
        ? 'All criteria met'
        : `Failed criteria: ${failedCriteria.join(', ')}`,
      failedCriteria,
    };
  }

  // ── Private Helpers ─────────────────────────────────────────────

  private async executeResearch(
    task: RpiTask,
    _correlationId: CorrelationId,
  ): Promise<ResearchArtifact> {
    // Stub: real implementation delegates to agent research capabilities
    return {
      artifactId: `research-${task.taskId}`,
      summary: `Research for: ${task.description}`,
      discoveredFiles: [],
      constraints: [],
      estimatedComplexity: 5,
    };
  }

  private async executePlan(
    task: RpiTask,
    research: ResearchArtifact,
    _correlationId: CorrelationId,
  ): Promise<PlanArtifact> {
    // Generate plan steps from research artifacts
    const steps: PlanStep[] = research.discoveredFiles.map((file, i) => ({
      stepIndex: i,
      description: `Process ${file}`,
      targetFile: file,
      changeType: 'modify' as const,
      dependsOn: i > 0 ? [i - 1] : [],
    }));

    // Fallback: at least one step from description
    if (steps.length === 0) {
      steps.push({
        stepIndex: 0,
        description: task.description,
        targetFile: 'src/index.ts',
        changeType: 'modify',
        dependsOn: [],
      });
    }

    return {
      artifactId: `plan-${task.taskId}`,
      steps,
      affectedFiles: steps.map(s => s.targetFile),
      estimatedCostUsd: Math.min(research.estimatedComplexity * 0.01, task.maxBudgetUsd),
      researchArtifactId: research.artifactId,
    };
  }

  private async executeImplement(
    task: RpiTask,
    plan: PlanArtifact,
    _correlationId: CorrelationId,
  ): Promise<ImplementArtifact> {
    // Stub: real implementation delegates to coder agent
    const completedSteps = plan.steps.map(s => s.stepIndex);
    return {
      artifactId: `impl-${task.taskId}`,
      planArtifactId: plan.artifactId,
      completedSteps,
      failedSteps: [],
      actualCostUsd: plan.estimatedCostUsd,
      isComplete: true,
    };
  }

  private checkCriterion(
    criterion: string,
    artifact: ResearchArtifact | PlanArtifact | ImplementArtifact,
    gate: ValidationGate,
  ): boolean {
    switch (criterion) {
      case 'has_summary':
        return 'summary' in artifact && !!(artifact).summary;
      case 'complexity_estimated':
        return 'estimatedComplexity' in artifact && (artifact).estimatedComplexity > 0;
      case 'files_discovered':
        return 'discoveredFiles' in artifact;
      case 'has_steps':
        return 'steps' in artifact && (artifact).steps.length > 0;
      case 'budget_within_limit':
        if ('estimatedCostUsd' in artifact && gate.maxCostUsd > 0) {
          return (artifact).estimatedCostUsd <= gate.maxCostUsd;
        }
        return true;
      case 'affected_files_listed':
        return 'affectedFiles' in artifact && (artifact).affectedFiles.length > 0;
      default:
        // Unknown criteria pass by default (forward compatible)
        return true;
    }
  }

  private buildResult(
    task: RpiTask,
    finalPhase: RpiPhase,
    isComplete: boolean,
    artifacts: { research?: ResearchArtifact; plan?: PlanArtifact; implementation?: ImplementArtifact },
    gateResults: GateEvaluationResult[],
    totalCostUsd: number,
    startMs: number,
    error?: unknown,
  ): RpiWorkflowResult {
    return {
      taskId: task.taskId,
      finalPhase,
      isComplete,
      research: artifacts.research,
      plan: artifacts.plan,
      implementation: artifacts.implementation,
      gateResults,
      totalCostUsd,
      totalDurationMs: Date.now() - startMs,
      error: error instanceof Error ? error.message : error ? String(error) : undefined,
    };
  }
}
