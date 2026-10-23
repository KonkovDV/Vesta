/**
 * Autonomous Loop Adapter — bounded iterative agent execution.
 *
 * Orchestrates check→execute→verify cycles with hard budget/time/iteration
 * bounds. Composes IStallDetector for progress monitoring (FP-05 resolution).
 *
 * @layer Infrastructure (Agents)
 * @pattern CC-009 Autonomous Execution Loop (FITNESS-K: 82.5)
 * @see src/domain/agents/IAutonomousExecutionLoop.ts — domain port
 * @see src/infrastructure/agents/StallDetectorAdapter.ts — stall detection
 */

import type { CorrelationId } from '../../core/types/branded';
import type {
  IAutonomousExecutionLoop,
  IStallDetector,
  LoopTask,
  LoopExecutionResult,
  LoopTerminationReason,
  IterationSnapshot,
  LoopIterationResult,
} from '../../domain/agents/IAutonomousExecutionLoop';
import type { ICognitiveLoadGovernor } from '../../domain/agents/ICognitiveLoadGovernor';
import type { IAgentEventStream } from '../../domain/agents/IAgentEventStream';
import { ACTION_WEIGHTS } from './CognitiveLoadGovernorAdapter';

// ── Minimal Logger ────────────────────────────────────────────────

interface LoopLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ── Adapter ───────────────────────────────────────────────────────

export class AutonomousLoopAdapter implements IAutonomousExecutionLoop {
  /** Active loops indexed by taskId for abort/status queries. */
  private readonly activeTasks = new Map<string, {
    aborted: boolean;
    latestSnapshot: IterationSnapshot | null;
  }>();

  constructor(
    private readonly stallDetector: IStallDetector,
    private readonly logger?: LoopLogger,
    private readonly cognitiveLoadGovernor?: ICognitiveLoadGovernor,
    private readonly agentEventStream?: IAgentEventStream,
  ) {}

  async run(task: LoopTask, correlationId: CorrelationId): Promise<LoopExecutionResult> {
    const startMs = Date.now();
    const iterations: IterationSnapshot[] = [];
    let cumulativeCostUsd = 0;
    let terminationReason: LoopTerminationReason = 'completed';
    let completedExplicitly = false;
    let finalOutput: unknown;
    let errorMsg: string | undefined;
    let previousOutput: unknown = task.initialInput;
    const session = this.agentEventStream?.createSession(task.agentId, `autonomous-loop:${task.taskId}`, {
      correlationId,
      taskId: task.taskId,
    });

    this.activeTasks.set(task.taskId, { aborted: false, latestSnapshot: null });
    this.cognitiveLoadGovernor?.reset();
    this.cognitiveLoadGovernor?.enterPhase('resolve');
    this.cognitiveLoadGovernor?.recordAction({
      actionType: 'delegate',
      probePhase: 'resolve',
      weight: ACTION_WEIGHTS.delegate,
      timestamp: new Date().toISOString(),
      intentAligned: true,
    });
    if (session) {
      this.agentEventStream?.recordAction(session.sessionId, 'agent_message', {
        event: 'autonomous_loop_started',
        taskId: task.taskId,
        correlationId,
      });
    }

    this.logger?.info('Autonomous loop started', {
      taskId: task.taskId,
      agentId: task.agentId,
      maxIterations: task.bounds.maxIterations,
      maxDurationMs: task.bounds.maxDurationMs,
      maxBudgetUsd: task.bounds.maxBudgetUsd,
      correlationId,
    });

    try {
      for (let i = 0; i < task.bounds.maxIterations; i++) {
        // Check external abort
        const state = this.activeTasks.get(task.taskId);
        if (state?.aborted) {
          terminationReason = 'external_abort';
          break;
        }

        // Check duration bound
        const elapsedMs = Date.now() - startMs;
        if (elapsedMs >= task.bounds.maxDurationMs) {
          terminationReason = 'max_duration';
          break;
        }

        // Check budget bound
        if (cumulativeCostUsd >= task.bounds.maxBudgetUsd) {
          terminationReason = 'budget_exhausted';
          break;
        }

        // Execute iteration (real callback when provided, otherwise synthetic fallback)
        const elapsedBeforeIteration = Date.now() - startMs;
        const iterationResult: LoopIterationResult = task.executeIteration
          ? await task.executeIteration({
              iterationIndex: i,
              previousOutput,
              elapsedMs: elapsedBeforeIteration,
              cumulativeCostUsd,
              correlationId,
            })
          : {
              output: task.initialInput,
              progressDelta: i === 0 ? 1.0 : 0.1,
              isProgressing: true,
              costUsd: 0.001,
              completed: false,
            };

        const iterationCost = iterationResult.costUsd ?? 0.001;
        cumulativeCostUsd += iterationCost;

        const progressDelta = iterationResult.progressDelta ?? (i === 0 ? 1.0 : 0.1);
        const output = typeof iterationResult.output === 'undefined'
          ? previousOutput
          : iterationResult.output;
        const isProgressing = iterationResult.isProgressing ?? progressDelta > 0;

        const snapshot: IterationSnapshot = {
          iterationIndex: i,
          elapsedMs: Date.now() - startMs,
          cumulativeCostUsd,
          progressDelta,
          output,
          isProgressing,
        };

        iterations.push(snapshot);
        previousOutput = output;
        finalOutput = output;
        this.cognitiveLoadGovernor?.recordAction({
          actionType: 'delegate',
          probePhase: 'resolve',
          weight: ACTION_WEIGHTS.delegate,
          timestamp: new Date().toISOString(),
          intentAligned: true,
        });

        const throttle = this.cognitiveLoadGovernor?.checkThrottle();
        if (throttle?.active) {
          this.logger?.warn('Cognitive throttle active in autonomous loop', {
            taskId: task.taskId,
            recommendation: throttle.recommendation,
            currentLoad: throttle.currentLoad,
            correlationId,
          });
          if (session) {
            this.agentEventStream?.recordObservation(session.sessionId, 'error', {
              event: 'cognitive_throttle',
              taskId: task.taskId,
              recommendation: throttle.recommendation,
              currentLoad: throttle.currentLoad,
            });
          }
          if (throttle.recommendation === 'escalate') {
            terminationReason = 'stall_detected';
            break;
          }
        }

        // Update active task state
        if (state) {
          state.latestSnapshot = snapshot;
        }

        if (iterationResult.completed === true) {
          terminationReason = 'completed';
          completedExplicitly = true;
          break;
        }

        // Check stall detection
        const stallResult = this.stallDetector.detectStall(iterations, task.bounds);
        if (stallResult.isStalled) {
          this.logger?.warn('Stall detected in autonomous loop', {
            taskId: task.taskId,
            consecutiveStalls: stallResult.consecutiveStalls,
            recommendation: stallResult.recommendation,
            correlationId,
          });

          if (stallResult.recommendation === 'abort') {
            terminationReason = 'stall_detected';
            break;
          }
        }
      }

      // If we exhausted all iterations without explicit completion
      if (!completedExplicitly && iterations.length >= task.bounds.maxIterations) {
        terminationReason = 'max_iterations';
      }
    } catch (err) {
      terminationReason = 'error';
      errorMsg = err instanceof Error ? err.message : String(err);
      this.logger?.error('Autonomous loop error', {
        taskId: task.taskId,
        error: errorMsg,
        correlationId,
      });
      if (session) {
        this.agentEventStream?.recordObservation(session.sessionId, 'error', {
          event: 'autonomous_loop_error',
          taskId: task.taskId,
          error: errorMsg,
          correlationId,
        });
      }
    } finally {
      this.activeTasks.delete(task.taskId);
      if (session) {
        this.agentEventStream?.recordAction(session.sessionId, 'finish', {
          taskId: task.taskId,
          terminationReason,
          correlationId,
        });
        this.agentEventStream?.closeSession(
          session.sessionId,
          terminationReason === 'completed' || terminationReason === 'max_iterations' ? 'completed' : 'failed',
        );
      }
    }

    const result: LoopExecutionResult = {
      terminationReason,
      totalIterations: iterations.length,
      totalDurationMs: Date.now() - startMs,
      totalCostUsd: cumulativeCostUsd,
      iterations,
      finalOutput,
      error: errorMsg,
    };

    this.logger?.info('Autonomous loop terminated', {
      taskId: task.taskId,
      reason: terminationReason,
      iterations: iterations.length,
      totalCostUsd: cumulativeCostUsd,
      correlationId,
    });

    return result;
  }

  async abort(taskId: string, correlationId: CorrelationId): Promise<void> {
    const state = this.activeTasks.get(taskId);
    if (state) {
      state.aborted = true;
      this.logger?.info('Autonomous loop abort requested', { taskId, correlationId });
    }
  }

  getStatus(taskId: string): IterationSnapshot | null {
    return this.activeTasks.get(taskId)?.latestSnapshot ?? null;
  }
}
