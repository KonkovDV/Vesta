/**
 * MAS Runtime Core - Task Orchestrator.
 *
 * Layer: Application (business orchestration).
 *
 * Responsibilities:
 * - Manage the lifecycle of a Multi-Agent Session (Start -> Decompose -> Execute -> Persist).
 * - Handle retries, durable execution, and error classification.
 * - Coordinate with AgentRouter for agent selection.
 */
import {
  type IRequestContext,
} from '../../core/context/IRequestContext';
import {
  createMasSessionContextFromRequest,
} from '../mas/context/mas-request-context';
import {
  createBackgroundRequestContext,
} from '../agents/context/mas-background-context';
import type {
  IMasSessionStore,
  MasSessionState,
} from '../agents/state/mas-session-store';
import type { MasSessionId } from '../../core/context/IRequestContext';
import type {
  MasRequest,
  MasResponse,
  MasSessionContext,
  MasTask,
  MasTaskPlan,
  ExecutionStrategyType,
  MasTaskStatus,
} from '../mas/types/mas-types';
import type {
  MasterAgentExecutionOptions,
} from '../agents/core/master-agent';
import {
  AgentRouter,
} from '../routing/AgentRouter';
import type { ITaskDecomposer } from '../agents/core/task-decomposer';
import type {
  IExecutionStrategy,
  ExecutionStrategyContext,
  ExecutionStepResult,
  TaskExecutor,
} from '../agents/core/execution-strategy';
import type {
  IMasRuntimePolicyService,
  NonDurableRetryPolicy,
} from '../agents/core/mas-runtime-policy.service';
import {
  recordMasOrchestration,
  type MasOrchestrationOutcome,
  incrementMasSessionsTotal,
  recordMasSessionDuration,
  incrementMasErrorsTotal,
  incrementMasTasksTotal,
  recordMasTaskDuration,
  incrementMasAgentRequestsTotal,
  recordMasAgentRequestDuration,
  getPolicyEvaluationsCounter,
  getPolicyDenialsCounter,
} from '../mas/observability/mas-metrics';
import type {
  PolicyDecision,
  PolicyDecisionStatus,
} from '../security/policy-engine';
import {
  emitMasSessionStarted,
  emitMasSessionCompleted,
  emitMasSessionFailed,
  emitMasTaskPlanCreated,
  emitMasTaskPlanFailed,
  emitMasTaskStarted,
  emitMasTaskCompleted,
  emitMasTaskFailed,
} from '../mas/events/mas-events';
import type {
  MasDurableExecutionService,
  MasStepResultMeta,
  MasTaskDescriptor,
} from '../../domain/mas/services/MasDurableExecutionService';
import type { MasTaskExecution } from '../../domain/mas/MasTaskExecution';
import type { MasStepDescriptor } from '../../domain/mas/MasStepDescriptor';
import { MasExecutionStepKind } from '../../domain/mas/MasExecutionStepKind';
import type { RequestContextSnapshot } from '../../domain/mas/RequestContextSnapshot';
import type { MasExecutionError } from '../../domain/mas/MasExecutionError';
import type { MasErrorCategory } from '../../domain/mas/services/mas-error-types';
import { mapExecutionErrorToCategory } from '../../domain/mas/services/mas-error-taxonomy';
import { isNonNullObject } from '../../core/guards/type-guards';
import type { CircuitBreakerKey } from '../../core/resilience/CircuitBreakerKey';
import { serializeCircuitBreakerKey } from '../../core/resilience/CircuitBreakerKey';
import type { EventStoreService } from '../services/EventStoreService';
import type {
  IAutonomousExecutionLoop,
  LoopTask,
} from '../../domain/agents/IAutonomousExecutionLoop';

const DEFAULT_TASK_TIMEOUT_MS = 60_000;
const MAS_PREFLIGHT_POLICY_SOURCE = 'mas_preflight';
const masPolicyEvaluations = getPolicyEvaluationsCounter();
const masPolicyDenials = getPolicyDenialsCounter();

class MasCoordinationTestError extends Error {
    constructor() {
      super('OBS_P0_MAS_COORDINATION_FAILURE');
      this.name = 'MasCoordinationTestError';
    }
}

export class TaskOrchestrator {
  constructor(
    private readonly taskDecomposer: ITaskDecomposer,
    private readonly agentRouter: AgentRouter,
    private readonly sessionStore: IMasSessionStore | undefined,
    private readonly strategies: Map<ExecutionStrategyType, IExecutionStrategy>,
    private readonly defaultExecutionStrategy: IExecutionStrategy,
    private readonly masRuntimePolicyService: IMasRuntimePolicyService,
    private readonly durableExecutionService?: MasDurableExecutionService,
    private readonly eventStoreService?: EventStoreService,
    private readonly autonomousExecutionLoop?: IAutonomousExecutionLoop,
  ) {}

  async executeSessionStep(sessionId: string): Promise<void> {
    const startTime = process.hrtime.bigint();

    // 1. Load Session State
    const sessionState = await this.sessionStore?.getSession(sessionId as MasSessionId);
    if (!sessionState) {
        throw new Error(`Session ${sessionId} not found`);
    }
    
    // 2. Resume execution
    const session = sessionState.session as unknown as MasSessionContext;

    if (!session.plan || !session.plan.tasks) {
        console.warn(`[TaskOrchestrator] Resuming session ${sessionId}: No plan found. Marking as completed.`);
        const updatedState = { ...sessionState, status: 'completed' as const, updatedAt: new Date().toISOString() };
        await this.sessionStore?.saveSession(updatedState);
        return;
    }

    const hasPendingTasks = session.plan.tasks.some(t => t.status === 'pending' || t.status === 'in_progress');
    if (!hasPendingTasks) {
        // Nothing to do
        const updatedState = { ...sessionState, status: 'completed' as const, updatedAt: new Date().toISOString() };
        await this.sessionStore?.saveSession(updatedState);
        return;
    }

    // 3. Reconstruct Context
    const backgroundContext = createBackgroundRequestContext(session);
    
    // 4. Reconstruct Request (Minimal)
    const request: MasRequest = {
        scenario: (session.metadata?.scenario as string) ?? 'unknown_resumed_scenario',
        useCase: (session.metadata?.use_case as string) ?? (session.metadata?.useCase as string),
        payload: session.initialInput,
        session,
        metadata: { ...session.metadata, resumed: true }
    };

    // 5. Select Strategy and Resume
    // Use the strategy originally requested (if stored) or default
    const strategyType = (session.plan.metadata?.executionStrategyType as ExecutionStrategyType) ?? 'sequential';
    const strategy = this.selectExecutionStrategy(strategyType);

    const execContext: ExecutionStrategyContext = {
        request,
        session,
    };

    // 6. Create Executor (Resume-aware persistence is handled inside)
    const executor = this.createTaskExecutor(
        request,
        backgroundContext,
        session,
        strategy,
        // For background resumption, we typically assume non-durable policy for *transient* retries,
        // relying on the outer loop for long-term durability.
        this.masRuntimePolicyService.getNonDurableRetryPolicy({
             scenarioId: request.scenario,
             tenantId: String(session.tenantId)
        })
    );

    try {
        await strategy.executePlan(session.plan, execContext, executor);
        
        // Final check: if all done, mark session completed
        const allDone = session.plan.tasks.every(t => t.status === 'completed' || t.status === 'skipped');
        if (allDone) {
             const updatedState = { 
                 ...sessionState, 
                 status: 'completed' as const, 
                 updatedAt: new Date().toISOString(),
                 session 
             };
             await this.sessionStore?.saveSession(updatedState);
             
             const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;
             
             await emitMasSessionCompleted({
                session,
                scenario: request.scenario,
                useCase: request.useCase,
                resultSummary: null,
                plan: session.plan,
                requestContext: backgroundContext,
                eventStoreService: this.eventStoreService,
                durationSeconds,
             });
        }
    } catch (error) {
         console.error(`[TaskOrchestrator] Resumption failed for session ${sessionId}`, error);
         
         const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;

         // Ensure we propagate failure status if fatal
         await emitMasSessionFailed({
            session,
            scenario: request.scenario,
            useCase: request.useCase,
            error,
            failureStage: 'execution',
            requestContext: backgroundContext,
            eventStoreService: this.eventStoreService,
            durationSeconds,
            diagnostics: {
                resumption: true,
                rawError: error instanceof Error ? error.message : String(error)
            }
         });
         throw error;
    }
  }

  async runScenario(
    request: MasRequest,
    requestContext: IRequestContext,
    options?: MasterAgentExecutionOptions,
  ): Promise<MasResponse> {
    const startTime = process.hrtime.bigint();
    const session = createMasSessionContextFromRequest(request, requestContext);
    const requestContextTenantId = requestContext.getTenantId();
    this.recordMasPolicyDecisionSnapshot(session, request.scenario);

    const nonDurablePolicy =
      this.masRuntimePolicyService.getNonDurableRetryPolicy({
        scenarioId: request.scenario,
        tenantId:
          typeof session.tenantId !== 'undefined'
            ? String(session.tenantId)
            : undefined,
      });

    const durableExecutionService = this.durableExecutionService;
    const durableTasksByMasTaskId =
      durableExecutionService != null
        ? new Map<MasTask['id'], MasTaskExecution>()
        : undefined;
    const durableRequestContextSnapshot: RequestContextSnapshot | undefined =
      durableExecutionService != null
        ? this.buildRequestContextSnapshot(session, requestContext, request)
        : undefined;

    let outcome: MasOrchestrationOutcome = 'success';
    let failureStageForSession: 'decomposition' | 'execution' | 'unknown' =
      'unknown';

    const retryState = {
      consecutiveTransientErrors: 0,
      sessionCircuitOpen: false,
    };

    incrementMasSessionsTotal({
      scenario: request.scenario,
      outcome: 'started',
    });

    try {
      await emitMasSessionStarted({
        session,
        scenario: request.scenario,
        useCase: request.useCase,
        requestContext,
        requestMetadata: request.metadata,
        eventStoreService: this.eventStoreService,
      });

      const masTestMode =
        request.metadata && typeof request.metadata === 'object'
          ? (request.metadata as { masTestMode?: string }).masTestMode
          : undefined;

      if (masTestMode === 'force_error') {
        throw new Error('OBS_P0_MAS_FORCED_ERROR');
      }

      let plan: MasTaskPlan;

      if (options?.planHint) {
        plan = options.planHint;
      } else {
        try {
          if (masTestMode === 'coordination_failure') {
            throw new MasCoordinationTestError();
          }

          plan = await this.taskDecomposer.decomposeTask({
            request: {
              ...request,
              session,
            },
            session,
          });
        } catch (error) {
          outcome = 'decomposition_error';
          failureStageForSession = 'decomposition';

          const failureCategory = this.classifyError(error, 'decomposition');

          incrementMasErrorsTotal({
            component: 'task_decomposer',
            errorType: failureCategory,
          });

          const failureResponse = this.buildErrorResponse(
            error,
            session,
            failureCategory,
          );

          const failureDiagnostics =
            failureResponse.diagnostics as Record<string, unknown>;

          await emitMasTaskPlanFailed({
            session,
            request,
            error,
            diagnostics: failureDiagnostics,
            eventStoreService: this.eventStoreService,
          });

          if (masTestMode === 'coordination_failure') {
             const durationSecondsForTask =
               Number(process.hrtime.bigint() - startTime) / 1e9;
 
             await emitMasTaskFailed({
               session,
               taskId: 'coordination_failure',
               scenario: request.scenario,
               useCase: request.useCase,
               taskType: 'coordination',
               agentId: 'mas_master_agent_v1',
               durationSeconds: durationSecondsForTask,
               error,
               requestContext,
               eventStoreService: this.eventStoreService,
             });
 
             throw error;
           }

          const durationSecondsForEvents =
            Number(process.hrtime.bigint() - startTime) / 1e9;

          await emitMasSessionFailed({
            session,
            scenario: request.scenario,
            useCase: request.useCase,
            durationSeconds: durationSecondsForEvents,
            error,
            failureStage: 'decomposition',
            diagnostics: failureDiagnostics,
            requestContext,
            eventStoreService: this.eventStoreService,
          });

          return failureResponse;
        }
      }

      await emitMasTaskPlanCreated({
        session,
        request,
        plan,
        eventStoreService: this.eventStoreService,
      });

      // Persist plan for durable execution
      session.plan = plan;
      session.initialInput = request.payload;
      await this.persistSessionStateSafe(session);

      for (const task of plan.tasks ?? []) {
        incrementMasTasksTotal({
          scenario: request.scenario,
          taskType: task.type,
          outcome: 'started',
        });
      }

      const strategy = this.selectExecutionStrategy(request.strategy);
      const execContext: ExecutionStrategyContext = {
        request,
        session,
      };

      const executor = this.createTaskExecutor(
           request,
           requestContext,
           session,
           strategy,
           nonDurablePolicy,
           durableExecutionService,
           durableTasksByMasTaskId,
           durableRequestContextSnapshot
      );

      const executionResult = await strategy.executePlan(
        plan,
        execContext,
        executor,
      );

      const executedPlan: MasTaskPlan = executionResult.plan;
      const durableDiagnostics =
        durableExecutionService &&
        durableTasksByMasTaskId &&
        durableTasksByMasTaskId.size > 0
          ? {
              tasks: Array.from(durableTasksByMasTaskId.values()).map(
                taskExecution => {
                  const lastError =
                    taskExecution.lastError ??
                    [...taskExecution.steps]
                      .reverse()
                      .find(step => step.error)?.error;

                  return {
                    taskExecutionId: taskExecution.taskExecutionId,
                    taskId: taskExecution.taskId,
                    status: taskExecution.status,
                    lastErrorCode: lastError?.code,
                  };
                },
              ),
            }
          : undefined;

      const response: MasResponse = {
        success: executionResult.success,
        result: {
          tasks: executedPlan.tasks,
          plan: executedPlan,
          planMetadata: executedPlan.metadata,
        },
        session,
        messages: [
          {
            role: 'system',
            content: 'MAS execution completed (skeleton)',
          },
        ],
        diagnostics: {
          execution: {
            strategy: strategy.type,
            success: executionResult.success,
            steps: executionResult.steps.map(step => ({
              taskId: step.task.id,
              status: step.task.status,
              success: step.success,
              skipped: step.skipped === true,
            })),
          },
          ...(durableDiagnostics ? { durable: durableDiagnostics } : {}),
        },
      };

       const durationSecondsForEvents =
        Number(process.hrtime.bigint() - startTime) / 1e9;

      await emitMasSessionCompleted({
        session,
        scenario: request.scenario,
        useCase: request.useCase,
        durationSeconds: durationSecondsForEvents,
        resultSummary: null,
        plan: executedPlan,
        requestContext,
        eventStoreService: this.eventStoreService,
      });

      return response;

    } catch (error) {
       outcome = 'error';
       failureStageForSession = 'execution';
 
       const failureCategory = this.classifyError(error, 'execution');
 
       incrementMasErrorsTotal({
         component: 'master_agent',
         errorType: failureCategory,
       });

       // Circuit Breaker Handling
       const durableExecutionServiceForError = this.durableExecutionService;
       const isCircuitOpenAtSession = this.isCircuitOpenError(error);
       const alreadyHandledDurable =
         typeof error === 'object' &&
         error !== null &&
         (error as { __masDurableHandled?: boolean }).__masDurableHandled === true;
 
       if (
         durableExecutionServiceForError &&
         isCircuitOpenAtSession &&
         !alreadyHandledDurable
       ) {
         try {
           const now = new Date();
           const cbContext = this.tryExtractCircuitBreakerContext(error);
           const circuitOpenError = error as Error & {
             __masDurableHandled?: boolean;
           };
           const details: Record<string, unknown> = {
             scenario: request.scenario,
             useCase: request.useCase,
             masTaskId: 'unknown',
             errorName: circuitOpenError.name,
             ...(cbContext ? { cb: cbContext } : {}),
           };
 
           const masError: MasExecutionError = {
             code: 'CIRCUIT_OPEN',
             message: circuitOpenError.message,
             details,
             firstOccurredAt: now,
             lastOccurredAt: now,
           };
 
           await durableExecutionServiceForError.blockStep(
             'unknown_task',
             'unknown_step',
             masError,
             requestContext,
           );
 
           circuitOpenError.__masDurableHandled = true;
         } catch {
           // Ignore errors in error handling
         }
       }
 
       const durationSecondsForEvents =
         Number(process.hrtime.bigint() - startTime) / 1e9;
 
       await emitMasSessionFailed({
         session,
         scenario: request.scenario,
         useCase: request.useCase,
         durationSeconds: durationSecondsForEvents,
         error,
         failureStage: 'execution',
         diagnostics: {
           failure_category: failureCategory,
           failure_source: 'master_agent',
           effective_max_non_durable_retries:
             nonDurablePolicy.maxNonDurableRetries,
           effective_max_consecutive_transient_errors_per_session:
             nonDurablePolicy.maxConsecutiveTransientErrorsPerSession,
         },
         requestContext,
         eventStoreService: this.eventStoreService,
       });
 
       throw error;
    } finally {
        await this.persistSessionStateSafe(session);
 
        const durationSeconds =
            Number(process.hrtime.bigint() - startTime) / 1e9;
        const sessionOutcome = outcome === 'success' ? 'completed' : 'failed';
 
        recordMasSessionDuration({
            scenario: request.scenario,
            outcome: sessionOutcome,
            durationSeconds,
        });
 
        incrementMasSessionsTotal({
            scenario: request.scenario,
            outcome: sessionOutcome,
        });
 
        recordMasOrchestration({
            scenario: request.scenario,
            useCase: request.useCase,
            outcome,
            durationSeconds,
            masSessionId: String(session.masSessionId),
            tenantId:
            typeof session.tenantId !== 'undefined'
                ? String(session.tenantId)
                : undefined,
            userId:
            typeof session.userId !== 'undefined'
                ? String(session.userId)
                : undefined,
            masFlowType: 'mas_master_agent_v1',
        });
    }
  }

  private createTaskExecutor(
     request: MasRequest,
     requestContext: IRequestContext,
     session: MasSessionContext,
     strategy: IExecutionStrategy,
     nonDurablePolicy: NonDurableRetryPolicy,
     durableExecutionService?: MasDurableExecutionService,
     durableTasksByMasTaskId?: Map<MasTask['id'], MasTaskExecution>,
     durableRequestContextSnapshot?: RequestContextSnapshot,
  ): TaskExecutor {
      const retryState = {
        consecutiveTransientErrors: 0,
        sessionCircuitOpen: false,
      };

      return {
        executeTask: async (task, context) => {
          // A-019 Durable Persistence Fix:
          // We wrap the execution to ensure that AFTER the task is done (success or fail),
          // we explicitly update the session plan and save it.
          // This ensures that if the server crashes, we know this task is done.
          
          let result: ExecutionStepResult;

          if (!durableExecutionService && this.autonomousExecutionLoop) {
            result = await this.executeWithAutonomousLoop({
              task,
              context,
              request,
              requestContext,
              session,
              strategy,
              retryState,
              policy: nonDurablePolicy,
            });
          } else if (!durableExecutionService) {
            result = await this.executeWithRetry({
              task,
              context,
              request,
              requestContext,
              session,
              strategy,
              retryState,
              policy: nonDurablePolicy,
            });
          } else {
             result = await this.executeWrapper({
                task,
                context,
                request,
                requestContext,
                session,
                strategy,
                durableExecutionService,
                durableTasksByMasTaskId,
                durableRequestContextSnapshot,
            });
          }

          // --- SYNC STATE TO SESSION PLAN ---
            /* istanbul ignore next -- session.plan is required before task execution starts */
            if (session.plan && session.plan.tasks) {
               const taskIndex = session.plan.tasks.findIndex(t => t.id === task.id);
               if (taskIndex >= 0) {
                   // Mutate the session plan reference directly
                   const original = session.plan.tasks[taskIndex];
                   session.plan.tasks[taskIndex] = {
                       ...original,
                       status: result.task.status,
                       // Merge any other metadata if needed
                   };
                   
                   // CRITICAL: Persist immediately
                   await this.persistSessionStateSafe(session);
               }
          }
          
          return result;
        },
      };
  }

  private async executeWithAutonomousLoop(params: {
    task: MasTask;
    context: ExecutionStrategyContext;
    request: MasRequest;
    requestContext: IRequestContext;
    session: MasSessionContext;
    strategy: IExecutionStrategy;
    retryState: {
      consecutiveTransientErrors: number;
      sessionCircuitOpen: boolean;
    };
    policy: NonDurableRetryPolicy;
  }): Promise<ExecutionStepResult> {
    /* istanbul ignore next -- defensive fallback: createTaskExecutor guards this path at line 647 */
    if (!this.autonomousExecutionLoop) {
      return this.executeWithRetry(params);
    }

    const {
      task,
      request,
      requestContext,
      retryState,
      policy,
    } = params;

    if (retryState.sessionCircuitOpen) {
      const skippedTask: MasTask = {
        ...task,
        status: 'skipped',
      };

      return {
        task: skippedTask,
        success: false,
        skipped: true,
        failureReason: 'unknown',
        result: null,
        error: 'MAS session circuit breaker is OPEN; task execution skipped by MasterAgentV1.',
      };
    }

    const maxAttempts = policy.maxNonDurableRetries + 1;
    let lastRetryableError: unknown;

    const loopTask: LoopTask = {
      taskId: String(task.id),
      description: task.description,
      initialInput: request.payload,
      agentId: 'mas_non_durable_executor',
      bounds: {
        maxIterations: maxAttempts,
        maxDurationMs: DEFAULT_TASK_TIMEOUT_MS * maxAttempts,
        maxBudgetUsd: Math.max(0.01, maxAttempts * 0.01),
        progressThreshold: 0.01,
        stallWindowSize: Math.max(
          2,
          policy.maxConsecutiveTransientErrorsPerSession,
        ),
      },
      executeIteration: async () => {
        try {
          const result = await this.executeWrapper({
            task,
            context: params.context,
            request,
            requestContext,
            session: params.session,
            strategy: params.strategy,
            durableExecutionService: undefined,
            durableTasksByMasTaskId: undefined,
            durableRequestContextSnapshot: undefined,
          });

          retryState.consecutiveTransientErrors = 0;
          return {
            completed: true,
            output: result,
            progressDelta: 1,
            isProgressing: true,
            costUsd: 0.01,
          };
        } catch (error) {
          lastRetryableError = error;

          const category = this.classifyError(error, 'execution');
          const errorCode =
            error &&
            typeof error === 'object' &&
            (error as { code?: unknown }).code &&
            typeof (error as { code?: unknown }).code === 'string'
              ? (error as { code: string }).code
              : undefined;
          const isCategoryAllowed = policy.allowedErrorCategories.includes(
            category,
          );
          const isCodeDisallowed =
            errorCode != null &&
            policy.disallowedRetryErrorCodes.includes(errorCode);
          const isCircuitOpen = this.isCircuitOpenError(error);
          const isTransient =
            isCategoryAllowed && !isCodeDisallowed && !isCircuitOpen;

          if (isTransient) {
            retryState.consecutiveTransientErrors += 1;
          } else {
            retryState.consecutiveTransientErrors = 0;
          }

          if (
            isTransient &&
            retryState.consecutiveTransientErrors >=
              policy.maxConsecutiveTransientErrorsPerSession
          ) {
            retryState.sessionCircuitOpen = true;
          }

          if (isTransient && !retryState.sessionCircuitOpen) {
            return {
              completed: false,
              output: error,
              progressDelta: 0,
              isProgressing: false,
              costUsd: 0.01,
            };
          }

          throw error;
        }
      },
    };

    const loopResult = await this.autonomousExecutionLoop.run(
      loopTask,
      requestContext.getCorrelationId(),
    );

    if (loopResult.terminationReason === 'completed') {
      const finalOutput = loopResult.finalOutput;
      if (
        finalOutput &&
        typeof finalOutput === 'object' &&
        'task' in finalOutput &&
        'success' in finalOutput &&
        'result' in finalOutput
      ) {
        return finalOutput as ExecutionStepResult;
      }
    }

    if (
      loopResult.terminationReason === 'max_iterations' ||
      loopResult.terminationReason === 'max_duration' ||
      loopResult.terminationReason === 'budget_exhausted' ||
      loopResult.terminationReason === 'stall_detected' ||
      loopResult.terminationReason === 'external_abort' ||
      loopResult.terminationReason === 'error'
    ) {
      const failedTask: MasTask = {
        ...task,
        status: 'failed',
      };

      return {
        task: failedTask,
        success: false,
        skipped: false,
        failureReason: 'executor_error',
        result: null,
        error:
          lastRetryableError ??
          new Error(
            loopResult.error ?? `MAS autonomous loop terminated: ${loopResult.terminationReason}`,
          ),
      };
    }

    throw lastRetryableError ?? new Error(loopResult.error ?? 'MAS autonomous loop failed');
  }

  private async executeWithRetry(params: {
    task: MasTask;
    context: ExecutionStrategyContext;
    request: MasRequest;
    requestContext: IRequestContext;
    session: MasSessionContext;
    strategy: IExecutionStrategy;
    retryState: {
      consecutiveTransientErrors: number;
      sessionCircuitOpen: boolean;
    };
    policy: NonDurableRetryPolicy;
  }): Promise<ExecutionStepResult> {
    const {
      task,
      request,
      requestContext,
      session,
      retryState,
      policy,
    } = params;

    if (retryState.sessionCircuitOpen) {
      const skippedTask: MasTask = {
        ...task,
        status: 'skipped',
      };

      return {
        task: skippedTask,
        success: false,
        skipped: true,
        failureReason: 'unknown',
        result: null,
        error: 'MAS session circuit breaker is OPEN; task execution skipped by MasterAgentV1.',
      };
    }

    const maxAttempts = policy.maxNonDurableRetries + 1;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const result = await this.executeWrapper({
            ...params,
            durableExecutionService: undefined,
            durableTasksByMasTaskId: undefined,
            durableRequestContextSnapshot: undefined,
        });

        retryState.consecutiveTransientErrors = 0;
        return result;
      } catch (error) {
        const category = this.classifyError(error, 'execution');
        const errorCode =
            error &&
            typeof error === 'object' &&
            (error as { code?: unknown }).code &&
            typeof (error as { code?: unknown }).code === 'string'
              ? (error as { code: string }).code
              : undefined;
          const isCategoryAllowed = policy.allowedErrorCategories.includes(
            category,
          );
          const isCodeDisallowed =
            errorCode != null &&
            policy.disallowedRetryErrorCodes.includes(errorCode);
          const isCircuitOpen = this.isCircuitOpenError(error);
          const isTransient =
            isCategoryAllowed && !isCodeDisallowed && !isCircuitOpen;
  
          if (isTransient) {
            retryState.consecutiveTransientErrors += 1;
          } else {
            retryState.consecutiveTransientErrors = 0;
          }
  
          if (
            isTransient &&
            retryState.consecutiveTransientErrors >=
              policy.maxConsecutiveTransientErrorsPerSession
          ) {
            retryState.sessionCircuitOpen = true;
          }
  
          if (
            isTransient &&
            attempt < maxAttempts &&
            !retryState.sessionCircuitOpen
          ) {
            continue;
          }

        throw error;
      }
    }

    /* istanbul ignore next -- unreachable: for-loop always returns (success) or throws (error) */
    return {
      task: { ...task, status: 'failed' as const },
      success: false,
      skipped: false,
      failureReason: 'executor_error' as const,
      result: null,
      error: new Error('MAS task failed after exhausting transient retries in TaskOrchestrator'),
    };
  }

  private async executeWrapper(params: {
    task: MasTask;
    context: ExecutionStrategyContext;
    request: MasRequest;
    requestContext: IRequestContext;
    session: MasSessionContext;
    strategy: IExecutionStrategy;
    durableExecutionService?: MasDurableExecutionService;
    durableTasksByMasTaskId?: Map<MasTask['id'], MasTaskExecution>;
    durableRequestContextSnapshot?: RequestContextSnapshot;
  }): Promise<ExecutionStepResult> {
    const {
      task,
      request,
      requestContext,
      session,
      strategy,
      durableExecutionService,
      durableTasksByMasTaskId,
      durableRequestContextSnapshot,
    } = params;

    // Use Router instead of hardcoded default
    // We expect Router to do the work now
    const stepStart = process.hrtime.bigint();
    let outcome: 'success' | 'error' = 'success';
    let lastError: unknown | undefined;

    let taskExecutionId: string | undefined;
    let stepId: string | undefined;
    
    // In original code, agentLabel was 'mas_generic_agent_v1'. 
    // Now it will be properly populated by AgentRouter.
    let agentLabel = 'mas_orchestrator_pending';
    const taskType = task.type ?? 'other';

    try {
        // Durable Execution Setup
        if (
            durableExecutionService &&
            durableTasksByMasTaskId &&
            durableRequestContextSnapshot
        ) {
            try {
                let taskExecution = durableTasksByMasTaskId.get(task.id);
                if (!taskExecution) {
                    const descriptor: MasTaskDescriptor = {
                      taskId: String(task.id),
                      sessionId: String(session.masSessionId),
                      requestContextSnapshot: durableRequestContextSnapshot,
                      timeouts: {
                        taskTimeoutMs: DEFAULT_TASK_TIMEOUT_MS,
                        stepTimeoutMs: DEFAULT_TASK_TIMEOUT_MS,
                      },
                      meta: {
                        ...(request.metadata ?? {}),
                        scenario: request.scenario,
                        useCase: request.useCase,
                      },
                    };
                    taskExecution =
                      await durableExecutionService.startNewTask(descriptor);
                    durableTasksByMasTaskId.set(task.id, taskExecution);
                  }
        
                  taskExecutionId = taskExecution.taskExecutionId;
        
                  const stepDescriptor: MasStepDescriptor = {
                    kind: MasExecutionStepKind.SYSTEM,
                    idempotencyKey: this.buildStepIdempotencyKey(
                      taskExecutionId,
                      task,
                    ),
                    inputSnapshot: {
                      scenario: request.scenario,
                      useCase: request.useCase,
                      masSessionId: String(session.masSessionId),
                      masTaskId: String(task.id),
                    },
                  };
        
                  const step = await durableExecutionService.startStep(
                    taskExecutionId,
                    stepDescriptor,
                    requestContext,
                  );
                  stepId = step.stepId;
            } catch (durableError) {
                // Best effort
                  
                 console.error(
                    '[TaskOrchestrator] Failed to start MAS durable execution step',
                    {
                      masTaskId: String(task.id),
                      masSessionId: String(session.masSessionId),
                      error: durableError
                    },
                  );
                  taskExecutionId = undefined;
                  stepId = undefined;
            }
        }

        // --- CORE DELEGATION TO ROUTER ---
        const selectionResult = await this.agentRouter.selectBestAgent(
            task, 
            session, 
            { scenario: request.scenario, useCase: request.useCase }, 
            requestContext
        );

        if (selectionResult.agent) {
            agentLabel = selectionResult.agent.name || selectionResult.agent.id;
        }

        // We emit START event *after* we (conceptually) know who is doing it, 
        // effectively replacing the start in executeSingleTask.
        // Actually, original code emitted start *before* agent selection in executeSingleTask?
        // Checking original: executeTaskOnce -> emitMasTaskStarted -> executeSingleTask -> findAgents.
        // So original emitted start with 'mas_generic_agent_v1'.
        // We can respect that or improve it. Let's respect original flow but maybe look up agent first?
        // No, let's allow "mas_generic_agent_v1" if we haven't selected yet, or strictly follow original order.
        // Original: emitMasTaskStarted(agentId: 'mas_generic_agent_v1')
        // We will emit it here.
        await emitMasTaskStarted({
            session,
            taskId: String(task.id),
            scenario: request.scenario,
            useCase: request.useCase,
            taskType,
            agentId: 'mas_generic_agent_v1', // Keeping strictly close to original behavior for now
            requestContext,
            eventStoreService: this.eventStoreService,
        });

        if (!selectionResult.success) {
            // Mapping router failure to a failed execution step result
            lastError = selectionResult.error || 'Agent selection failed';
            outcome = 'error';
            
            const failureResult: ExecutionStepResult = {
                task: { ...task, status: 'failed' as const },
                success: false,
                result: null,
                error: lastError,
            };
            
            // Durable Failure Logic for agent selection failure
            if (durableExecutionService) {
                try {
                    const now = new Date();
                    const effectiveTaskExecutionId = taskExecutionId ?? 'unknown_task';
                    const effectiveStepId = stepId ?? 'unknown_step';
                    
                    const masError: MasExecutionError = {
                        code: 'AGENT_SELECTION_FAILED',
                        message: String(lastError),
                        details: {
                            scenario: request.scenario,
                            useCase: request.useCase,
                            masTaskId: String(task.id),
                        },
                        firstOccurredAt: now,
                        lastOccurredAt: now,
                    };
                    
                    const updatedExecution = await durableExecutionService.failStep(
                        effectiveTaskExecutionId,
                        effectiveStepId,
                        masError,
                        requestContext,
                    );
                    if (durableTasksByMasTaskId && taskExecutionId) {
                        durableTasksByMasTaskId.set(task.id, updatedExecution);
                    }
                } catch {
                    // ignore
                }
            }
            
            return failureResult;
        }

        const successResult: ExecutionStepResult = {
            task: selectionResult.task, // Updated status and metadata
            success: true,
            result: {
                agentId: selectionResult.agent?.id,
                agentName: selectionResult.agent?.name,
                contextMessages: selectionResult.contextMetadata?.messages ?? 0,
                contextKnowledgeSnippets: selectionResult.contextMetadata?.knowledgeSnippets ?? 0
            }
        };

        const result = successResult;
        outcome = 'success';

        // Durable Completion
        if (durableExecutionService && taskExecutionId && stepId) {
             try {
                const stepMeta: MasStepResultMeta = {
                    meta: {
                      masTaskStatus: result.task.status,
                      failureReason: result.failureReason,
                      skipped: result.skipped === true,
                    },
                  };

                  const updatedExecution = await durableExecutionService.completeStep(
                    taskExecutionId,
                    stepId,
                    stepMeta,
                    requestContext,
                  );
                  /* istanbul ignore next -- durable map is created alongside durable execution service */
                  if (durableTasksByMasTaskId) {
                    durableTasksByMasTaskId.set(task.id, updatedExecution);
                  }
             } catch (durableError) {
                // Log and swallow
             }
        }

        return result;

    } catch (error) {
        outcome = 'error';
        lastError = error;

        // Durable Failure Logic
        if (durableExecutionService) {
            // ... (Copying circuit breaker logic from original)
            try {
                const now = new Date();
                const isCircuitOpen = this.isCircuitOpenError(error);
                const effectiveTaskExecutionId = taskExecutionId ?? 'unknown_task';
                const effectiveStepId = stepId ?? 'unknown_step';

                if (isCircuitOpen) {
                     // ... blockStep logic
                     const circuitOpenError = error as Error & {
                       __masDurableHandled?: boolean;
                     };
                     const cbContext = this.tryExtractCircuitBreakerContext(error);
                      const details: Record<string, unknown> = {
                        scenario: request.scenario,
                        useCase: request.useCase,
                        masTaskId: String(task.id),
                        errorName: circuitOpenError.name,
                        ...(cbContext ? { cb: cbContext } : {}),
                      };
          
                      const masError: MasExecutionError = {
                        code: 'CIRCUIT_OPEN',
                        message: circuitOpenError.message,
                        details,
                        firstOccurredAt: now,
                        lastOccurredAt: now,
                      };
          
                      const updatedExecution = await durableExecutionService.blockStep(
                        effectiveTaskExecutionId,
                        effectiveStepId,
                        masError,
                        requestContext,
                      );

                        if (durableTasksByMasTaskId && taskExecutionId) {
                            durableTasksByMasTaskId.set(task.id, updatedExecution);
                        }
                } else {
                    // ... failStep logic
                    const masError: MasExecutionError = {
                        code: 'STEP_EXECUTION_EXCEPTION',
                        message:
                          'MAS task execution step threw an exception in TaskOrchestrator',
                        details: {
                          scenario: request.scenario,
                          useCase: request.useCase,
                          masTaskId: String(task.id),
                          errorName: error instanceof Error ? error.name : undefined,
                          errorMessage:
                            error instanceof Error ? error.message : String(error),
                        },
                        firstOccurredAt: now,
                        lastOccurredAt: now,
                      };
          
                      const updatedExecution = await durableExecutionService.failStep(
                        effectiveTaskExecutionId,
                        effectiveStepId,
                        masError,
                        requestContext,
                      );
                      if (durableTasksByMasTaskId && taskExecutionId) {
                        durableTasksByMasTaskId.set(task.id, updatedExecution);
                      }
                }

                if (isCircuitOpen) {
                  (error as Error & { __masDurableHandled?: boolean }).__masDurableHandled = true;
                } else if (typeof error === 'object' && error !== null) {
                  (error as { __masDurableHandled?: boolean }).__masDurableHandled = true;
                }

            } catch {
                // ignore
            }
        }

        throw error;
    } finally {
        const durationSeconds = Number(process.hrtime.bigint() - stepStart) / 1e9;
        const taskOutcome: 'completed' | 'failed' = outcome === 'success' ? 'completed' : 'failed';

        try {
            if (taskOutcome === 'completed') {
                await emitMasTaskCompleted({
                    session,
                    taskId: String(task.id),
                    scenario: request.scenario,
                    useCase: request.useCase,
                    taskType,
                    agentId: agentLabel,
                    durationSeconds,
                    requestContext,
                    eventStoreService: this.eventStoreService,
                  });
            } else {
                await emitMasTaskFailed({
                    session,
                    taskId: String(task.id),
                    scenario: request.scenario,
                    useCase: request.useCase,
                    taskType,
                    agentId: agentLabel,
                    durationSeconds,
                    error: lastError,
                    requestContext,
                    eventStoreService: this.eventStoreService,
                  });
            }
        } catch {
            // ignore
        }

        recordMasTaskDuration({
            scenario: request.scenario,
            taskType,
            outcome: taskOutcome,
            durationSeconds,
          });
    
          incrementMasTasksTotal({
            scenario: request.scenario,
            taskType,
            outcome: taskOutcome,
          });
    
          incrementMasAgentRequestsTotal({
            agent: agentLabel,
            strategy: strategy.type,
            outcome,
          });
    
          recordMasAgentRequestDuration({
            agent: agentLabel,
            strategy: strategy.type,
            outcome,
            durationSeconds,
          });
    }
  }

  // --- Helpers ---

  private selectExecutionStrategy(
    strategyType?: ExecutionStrategyType | string,
  ): IExecutionStrategy {
    const requestedType =
      (strategyType as ExecutionStrategyType | undefined) ?? 'sequential';

    const strategy =
      this.strategies.get(requestedType) ??
      this.strategies.get('sequential');

    return strategy ?? this.defaultExecutionStrategy;
  }

  private buildRequestContextSnapshot(
    session: MasSessionContext,
    requestContext: IRequestContext,
    request: MasRequest,
  ): RequestContextSnapshot {
    const correlationId = String(
      requestContext.getCorrelationId() ?? session.correlationId,
    );

    const tenantId =
      typeof session.tenantId !== 'undefined'
        ? String(session.tenantId)
        : requestContext.getTenantId()
        ? String(requestContext.getTenantId())
        : undefined;

    const userId =
      typeof session.userId !== 'undefined'
        ? String(session.userId)
        : requestContext.getUserId()
        ? String(requestContext.getUserId())
        : undefined;

    return {
      correlationId,
      tenantId,
      userId,
      masSessionId: String(session.masSessionId),
      masTraceId: session.masTraceId
        ? String(session.masTraceId)
        : undefined,
      meta: {
        scenario: request.scenario,
        useCase: request.useCase,
      },
    };
  }

  private buildStepIdempotencyKey(
    taskExecutionId: string,
    task: MasTask,
  ): string {
    return `${taskExecutionId}:${String(task.id)}`;
  }

  private async persistSessionStateSafe(
    session: MasSessionContext,
  ): Promise<void> {
    if (!this.sessionStore) {
      return;
    }

    const { requestContext, ...rest } = session;
    const nowIso = new Date().toISOString();

    const state: MasSessionState = {
      sessionId: session.masSessionId,
      session: rest,
      version: 0,
      createdAt: nowIso,
      updatedAt: nowIso,
    };

    try {
      await this.sessionStore.saveSession(state);
    } catch {
      // Persistence errors must not affect MAS orchestration.
    }
  }

  private isCircuitOpenError(err: unknown): boolean {
    if (!(err instanceof Error)) {
      return false;
    }

    const anyErr = err as { code?: unknown; message?: unknown };

    if (anyErr.code === 'CIRCUIT_OPEN') {
      return true;
    }

    if (
      typeof anyErr.message === 'string' &&
      anyErr.message.includes('Circuit breaker is OPEN')
    ) {
      return true;
    }

    return false;
  }

  private tryExtractCircuitBreakerContext(
    error: unknown,
  ): {
    key: CircuitBreakerKey;
    serializedKey: string;
    breakerName?: string;
  } | null {
    if (!this.isCircuitOpenError(error)) {
      return null;
    }

    /* istanbul ignore next -- defensive: isCircuitOpenError requires Error (always object) */
    if (typeof error !== 'object' || error === null) {
      return null;
    }

    const anyErr = error as {
      breakerKey?: CircuitBreakerKey;
      breakerName?: string;
    };

    const key = anyErr.breakerKey;
    if (!key) {
      return null;
    }

    return {
      key,
      serializedKey: serializeCircuitBreakerKey(key),
      breakerName: anyErr.breakerName,
    };
  }

  private classifyError(
    error: unknown,
    stage: 'decomposition' | 'execution' | 'unknown' = 'unknown',
  ): MasErrorCategory {
    // R1-C1: if error is already normalized as MasExecutionError, use unified
    // durable taxonomy for classification instead of heuristics.
    if (error && typeof error === 'object') {
      const err = error as Record<string, unknown>;

      if (
        typeof err.code === 'string' &&
        err.firstOccurredAt instanceof Date &&
        err.lastOccurredAt instanceof Date
      ) {
        return mapExecutionErrorToCategory(
          error as MasExecutionError,
        );
      }
    }

    if (stage === 'decomposition') {
      return 'decomposition';
    }

    if (this.isNamedError(error, 'MemoryGovernanceError')) {
      return 'memory';
    }

    if (
      this.isNamedError(error, 'PluginResolveError') ||
      this.isNamedError(error, 'PluginSandboxTimeoutError') ||
      this.isNamedError(error, 'PluginManifestValidationError') ||
      this.isNamedError(error, 'PluginCorrelationFallbackError')
    ) {
      return 'plugin';
    }

    if (
      this.isNamedError(error, 'PolicyEngineError') ||
      this.isNamedError(error, 'PolicyEvaluationError')
    ) {
      return 'policy';
    }

    if (this.isCircuitOpenError(error)) {
      return 'session_state';
    }

    if (stage === 'execution') {
      return 'execution';
    }

    if (error instanceof Error) {
      return 'execution';
    }

    return 'unknown';
  }

  private isNamedError(error: unknown, name: string): boolean {
    return error instanceof Error && error.name === name;
  }

  private buildErrorResponse(
    error: unknown,
    session: MasSessionContext,
    category?: MasErrorCategory,
  ): MasResponse {
    const asError = error instanceof Error ? error : undefined;
    const failureCategory =
      category ?? this.classifyError(error, 'decomposition');

    return {
      success: false,
      result: null,
      session,
      diagnostics: {
        reason: 'task_decomposition_failed',
        errorMessage:
          asError?.message ?? 'Unknown error during task decomposition',
        errorName: asError?.name,
        failure_category: failureCategory,
      },
      messages: [
        {
          role: 'system',
          content:
            'MAS execution failed during task decomposition (skeleton)',
        },
      ],
    };
  }

    private recordMasPolicyDecisionSnapshot(
      session: MasSessionContext,
      scenario?: string,
    ): void {
      try {
        const decision = this.extractPolicyDecision(session, 'mas.preflight');
        if (!decision || !decision.status) {
          return;
        }

        const status = decision.status;
        const rawScenario =
          typeof scenario === 'string' && scenario.trim().length > 0
            ? scenario.trim()
            : 'unknown';
        const resourceLabel = `mas.scenario.${rawScenario}`;

        masPolicyEvaluations.inc({
          status,
          source: MAS_PREFLIGHT_POLICY_SOURCE,
          resource: resourceLabel,
        });

        if (status === 'deny') {
          const rawReason = decision.reasons?.[0];
          const reason = this.normalizePolicyDenialReasonForMetrics(rawReason);
          masPolicyDenials.inc({
            reason,
            severity: this.derivePolicySeverity(reason),
            source: MAS_PREFLIGHT_POLICY_SOURCE,
          });
        }
      } catch {
        // MAS policy telemetry must never break orchestration.
      }
    }

    private extractPolicyDecision(
      session: MasSessionContext,
      key: string,
    ): PolicyDecision | undefined {
      const record = session.policyDecisions?.decisions ?? {};
      const rawDecision = record[key];
      if (rawDecision && typeof rawDecision === 'object') {
        const candidate = rawDecision as PolicyDecision;
        if (candidate.status) {
          return candidate;
        }
      }
      return undefined;
    }

    private normalizePolicyDenialReasonForMetrics(
      rawReason: string | undefined,
    ): string {
      if (!rawReason) {
        return 'other';
      }
      const reason = rawReason.toLowerCase();

      if (reason.includes('internal_error')) {
        return 'internal_error';
      }
      if (reason.includes('sanction')) {
        return 'sanctions';
      }
      if (reason.includes('budget') && reason.includes('exceed')) {
        return 'budget_exceeded';
      }
      if (reason.includes('region') && reason.includes('restrict')) {
        return 'region_restricted';
      }
      if (reason.includes('risk') && reason.includes('high')) {
        return 'risk_high';
      }
      if (
        reason.includes('limit') ||
        reason.includes('quota') ||
        reason.includes('exceed') ||
        reason.includes('capped')
      ) {
        return 'limit_exceeded';
      }
      if (reason.includes('deny') || reason.includes('violation')) {
        return 'policy_denied';
      }
      return 'other';
    }

    private derivePolicySeverity(reason: string): 'critical' | 'warning' | 'info' {
      const lowered = reason.toLowerCase();

      if (
        lowered.includes('internal_error') ||
        lowered.includes('sanction') ||
        lowered.includes('deny') ||
        lowered.includes('violation')
      ) {
        return 'critical';
      }
      if (
        lowered.includes('limit') ||
        lowered.includes('constraint') ||
        lowered.includes('quota') ||
        lowered.includes('exceed') ||
        lowered.includes('capped') ||
        lowered.includes('budget') ||
        (lowered.includes('risk') && lowered.includes('high'))
      ) {
        return 'warning';
      }
      return 'info';
    }
}

import type { InjectionToken } from '../../core/di/public-types';

/**
 * DI token for resolving TaskOrchestrator from the shared container.
 */
export const taskOrchestratorToken = Symbol('TaskOrchestrator') as InjectionToken<TaskOrchestrator>;
