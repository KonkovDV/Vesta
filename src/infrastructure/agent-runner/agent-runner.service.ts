/**
 * Agent Runner Service
 * Infrastructure layer implementation of IAgentRunner.
 * Layer: Infrastructure
 *
 * Runs the biological agent loop in Worker Threads for true parallelism.
 * Integrates with TaskScheduler and SandboxedExecutor.
 */

import { EventEmitter } from 'events';
import {
  IAgentRunner,
  AgentTask,
  TaskId,
  AgentRunnerStatus,
  AgentRunnerState,
  AgentRunnerConfig,
  TaskCompleteHandler,
  StateChangeHandler,
  AgentRunnerErrorHandler,
  TaskResult,
  BackpressureError,
  TaskNotFoundError,
  InvalidRunnerStateError,
} from '../../domain/agent-runner/agent-runner.port';
import { ITaskScheduler } from '../../domain/agent-runner/task-scheduler.port';
import { ISandboxedExecutor } from '../../domain/sandbox/sandboxed-executor.port';
import { WorkerThreadEngine, WorkerConfig } from './worker-thread-engine';
import * as path from 'path';
import { IToolRegistry } from '../../domain/agents/tools.interface';
import { IToolExecutionPolicy } from '../../domain/security/tool-execution-policy.interface';
import type { IIntentMisalignmentDetector } from '../../domain/security/IIntentMisalignmentDetector';
import type { IAgentEventStream } from '../../domain/agents/IAgentEventStream';
import type { IExecutionProvenanceTracer } from '../../domain/agents/IExecutionProvenanceTracer';
import type { IS2iLessonExtractor } from '../../domain/agents/IS2iLessonExtractor';
import type { ISuccessLedgerStore } from '../../domain/memory/ISuccessLedgerStore';

/**
 * Agent runner service options
 */
export interface AgentRunnerOptions {
  agentId: string;
  scheduler: ITaskScheduler;
  sandboxExecutor?: ISandboxedExecutor;
  workerConfig?: Partial<WorkerConfig>;
  maxConcurrentTasks?: number;
  gracefulShutdownTimeoutMs?: number;
  enableWorkerThreads?: boolean;
  toolRegistry?: IToolRegistry;
  toolPolicy?: IToolExecutionPolicy;
  intentMisalignmentDetector?: IIntentMisalignmentDetector;
  agentEventStream?: IAgentEventStream;
  executionProvenanceTracer?: IExecutionProvenanceTracer;
  successLedgerStore?: ISuccessLedgerStore;
  s2iLessonExtractor?: IS2iLessonExtractor;
}

/**
 * Agent Runner Service implementation
 */
export class AgentRunnerService extends EventEmitter implements IAgentRunner {
  private readonly MAX_COMPLETED_TASKS = 1000;
  private state: AgentRunnerState = 'IDLE';
  private scheduler: ITaskScheduler;
  private sandboxExecutor?: ISandboxedExecutor;
  private workerEngine?: WorkerThreadEngine;
  private runningTasks = new Set<TaskId>();
  private completedTasks = new Map<TaskId, TaskResult>();
  private isShuttingDown = false;
  private shutdownPromise?: Promise<void>;
  private taskCompleteHandlers: Set<TaskCompleteHandler> = new Set();
  private stateChangeHandlers: Set<StateChangeHandler> = new Set();
  private errorHandlers: Set<AgentRunnerErrorHandler> = new Set();
  /** Deep Preemption: AbortControllers for running tasks (ADR-013) */
  private taskAbortControllers = new Map<TaskId, AbortController>();
  // Symmetric listener cleanup — prevents EventEmitter leaks (OOM-008)
  private onWorkerTaskComplete?: (data: { taskId: string; executionTimeMs: number }) => void;
  private onWorkerTaskError?: (data: { taskId: string }) => void;
  private onSchedulerTaskStarted?: (data: { taskId: TaskId; workerId: string }) => void;
  private onSchedulerTaskCompleted?: (data: { taskId: TaskId; executionTimeMs: number }) => void;
  private onSchedulerTaskFailed?: (data: { taskId: TaskId; error: string }) => void;
  private stats = {
    completed: 0,
    failed: 0,
    totalExecutionTimeMs: 0,
  };

  private getSchedulerEventEmitter(): Pick<EventEmitter, 'on' | 'off'> | undefined {
    const candidate = this.scheduler as Partial<Pick<EventEmitter, 'on' | 'off'>>;

    if (typeof candidate.on !== 'function' || typeof candidate.off !== 'function') {
      return undefined;
    }

    return candidate as Pick<EventEmitter, 'on' | 'off'>;
  }

  constructor(private options: AgentRunnerOptions) {
    super();
    this.scheduler = options.scheduler;
    this.sandboxExecutor = options.sandboxExecutor;

    // Set up scheduler event listeners
    this.setupSchedulerListeners();
  }

  /**
   * Start the agent runner
   */
  async start(): Promise<void> {
    if (this.state !== 'IDLE' && this.state !== 'STOPPED') {
      throw new InvalidRunnerStateError(
        'Cannot start: runner is not in IDLE or STOPPED state',
        this.state,
        ['IDLE', 'STOPPED'],
      );
    }

    this.setState('RUNNING');

    // Initialize scheduler
    await this.scheduler.initialize();

    // Initialize worker thread engine if enabled
    if (this.options.enableWorkerThreads !== false) {
      await this.initializeWorkerEngine();
    }

    // Start the main processing loop
    void this.runLoop();

    this.emit('started');
  }

  /**
   * Stop the agent runner gracefully
   */
  async stop(): Promise<void> {
    if (this.isShuttingDown) {
      return this.shutdownPromise!;
    }

    if (this.state !== 'RUNNING' && this.state !== 'PAUSED') {
      return;
    }

    this.isShuttingDown = true;
    this.setState('SHUTTING_DOWN');

    // Deep Preemption: Abort all running tasks immediately (ADR-013)
    for (const [taskId, abortController] of this.taskAbortControllers) {
      abortController.abort(`Agent ${this.options.agentId} is stopping`);
      this.emit('taskAborted', { taskId, reason: 'shutdown' });
    }
    this.taskAbortControllers.clear();

    this.shutdownPromise = this.performShutdown();
    return this.shutdownPromise;
  }

  /**
   * Pause task processing
   */
  async pause(): Promise<void> {
    if (this.state !== 'RUNNING') {
      throw new InvalidRunnerStateError(
        'Cannot pause: runner is not RUNNING',
        this.state,
        ['RUNNING'],
      );
    }

    await this.scheduler.pause();
    this.setState('PAUSED');
  }

  /**
   * Resume task processing
   */
  async resume(): Promise<void> {
    if (this.state !== 'PAUSED') {
      throw new InvalidRunnerStateError(
        'Cannot resume: runner is not PAUSED',
        this.state,
        ['PAUSED'],
      );
    }

    await this.scheduler.resume();
    this.setState('RUNNING');
  }

  /**
   * Submit a new task
   */
  async submitTask(task: AgentTask): Promise<TaskId> {
    if (this.state !== 'RUNNING') {
      throw new InvalidRunnerStateError(
        'Cannot submit task: runner is not RUNNING',
        this.state,
        ['RUNNING'],
      );
    }

    // Check backpressure through scheduler
    if (!this.scheduler.canAcceptTask()) {
      const stats = this.scheduler.getStats();
      throw new BackpressureError(
        'Task queue is at capacity',
        stats.totalQueued,
        stats.totalQueued + 100, // estimated max
      );
    }

    await this.scheduler.schedule(task);
    this.emit('taskSubmitted', { taskId: task.id });

    return task.id;
  }

  /**
   * Cancel a task
   */
  async cancelTask(taskId: TaskId): Promise<boolean> {
    this.runningTasks.delete(taskId);
    return this.scheduler.cancel(taskId);
  }

  /**
   * Get current status
   */
  getStatus(): AgentRunnerStatus {
    const schedulerStats = this.scheduler.getStats();
    const avgExecutionTime = this.stats.completed > 0
      ? this.stats.totalExecutionTimeMs / this.stats.completed
      : 0;

    return {
      state: this.state,
      agentId: this.options.agentId as unknown as import('../../domain/agent-runner/agent-runner.port').AgentId,
      queuedTasks: schedulerStats.totalQueued,
      runningTasks: this.runningTasks.size,
      completedTasks: this.stats.completed,
      failedTasks: this.stats.failed,
      averageExecutionTimeMs: avgExecutionTime,
      isHealthy: this.state === 'RUNNING' && (schedulerStats.totalCompleted === 0 || schedulerStats.totalFailed < schedulerStats.totalCompleted * 0.1),
      lastActivityAt: this.stats.completed > 0 ? new Date() : undefined,
    };
  }

  /**
   * Get task result
   */
  async getTaskResult(taskId: TaskId): Promise<TaskResult | undefined> {
    const result = this.completedTasks.get(taskId);
    if (result) {
      this.completedTasks.delete(taskId);
    }
    return result;
  }

  /**
   * Add completed task with bounded map size
   */
  private addCompletedTask(taskId: TaskId, result: TaskResult): void {
    if (this.completedTasks.size >= this.MAX_COMPLETED_TASKS) {
      const firstKey = this.completedTasks.keys().next().value;
      if (firstKey !== undefined) {
        this.completedTasks.delete(firstKey);
      }
    }
    this.completedTasks.set(taskId, result);
  }

  /**
   * Register event handler
   */
  on(event: 'taskComplete', handler: TaskCompleteHandler): this;
  on(event: 'stateChange', handler: StateChangeHandler): this;
  on(event: 'error', handler: AgentRunnerErrorHandler): this;
  on(event: string, handler: unknown): this {
    switch (event) {
      case 'taskComplete':
        this.taskCompleteHandlers.add(handler as TaskCompleteHandler);
        break;
      case 'stateChange':
        this.stateChangeHandlers.add(handler as StateChangeHandler);
        break;
      case 'error':
        this.errorHandlers.add(handler as AgentRunnerErrorHandler);
        break;
      default:
        super.on(event, handler as (...args: unknown[]) => void);
    }
    return this;
  }

  /**
   * Remove event handler
   */
  off(event: 'taskComplete', handler: TaskCompleteHandler): this;
  off(event: 'stateChange', handler: StateChangeHandler): this;
  off(event: 'error', handler: AgentRunnerErrorHandler): this;
  off(event: string, handler: unknown): this {
    switch (event) {
      case 'taskComplete':
        this.taskCompleteHandlers.delete(handler as TaskCompleteHandler);
        break;
      case 'stateChange':
        this.stateChangeHandlers.delete(handler as StateChangeHandler);
        break;
      case 'error':
        this.errorHandlers.delete(handler as AgentRunnerErrorHandler);
        break;
      default:
        super.off(event, handler as (...args: unknown[]) => void);
    }
    return this;
  }

  /**
   * Initialize worker thread engine
   */
  private async initializeWorkerEngine(): Promise<void> {
    const workerScriptPath = path.join(__dirname, 'worker-scripts', 'task-worker.js');
    
    const config: WorkerConfig = {
      minPoolSize: 2,
      maxPoolSize: this.options.maxConcurrentTasks || 10,
      idleTimeoutMs: 30000,
      taskTimeoutMs: 300000,
      maxTasksPerWorker: 100,
      resourceLimits: {
        maxMemoryMb: 512,
        maxCpuPercent: 80,
      },
      ...this.options.workerConfig,
    };

    this.workerEngine = new WorkerThreadEngine(
        config, 
        workerScriptPath,
        this.options.toolRegistry,
        this.options.toolPolicy,
        undefined,
        {
          intentMisalignmentDetector: this.options.intentMisalignmentDetector,
          agentEventStream: this.options.agentEventStream,
          executionProvenanceTracer: this.options.executionProvenanceTracer,
          successLedgerStore: this.options.successLedgerStore,
          s2iLessonExtractor: this.options.s2iLessonExtractor,
        },
    );

    // Bind handlers for symmetric cleanup (OOM-008)
    this.onWorkerTaskComplete = ({ taskId, executionTimeMs }) => {
      this.runningTasks.delete(taskId as TaskId);
      this.stats.completed++;
      this.stats.totalExecutionTimeMs += executionTimeMs;
    };
    this.onWorkerTaskError = ({ taskId }) => {
      this.runningTasks.delete(taskId as TaskId);
      this.stats.failed++;
    };

    this.workerEngine.on('taskComplete', this.onWorkerTaskComplete);
    this.workerEngine.on('taskError', this.onWorkerTaskError);

    await this.workerEngine.initialize();
  }

  /**
   * Main processing loop
   */
  private async runLoop(): Promise<void> {
    const workerId = `agent-${this.options.agentId}`;

    while (!this.isShuttingDown) {
      try {
        if (this.state === 'PAUSED') {
          await this.sleep(1000);
          continue;
        }

        // Dequeue next task
        const task = await this.scheduler.dequeue(workerId, 5000);
        
        if (task) {
          this.runningTasks.add(task.id);
          
          // Execute task
          if (this.workerEngine) {
            await this.executeInWorker(task);
          } else {
            // SEC-12: Log reduced isolation when worker threads unavailable
            this.emit('warn', { message: 'Executing in-process (no worker thread isolation)', taskId: task.id });
            await this.executeInProcess(task);
          }
        } else {
          // No task available — brief backoff to prevent tight spin loop (OOM-008)
          await this.sleep(100);
        }
      } catch (error) {
        if (error instanceof Error && error.name === 'TaskDequeueTimeoutError') {
          // No task available, continue
          continue;
        }

        this.emit('error', error);
        for (const handler of this.errorHandlers) {
          handler(error as Error);
        }

        // Brief pause on error
        await this.sleep(1000);
      }
    }
  }

  /**
   * Execute task in worker thread
   */
  private async executeInWorker(task: AgentTask): Promise<void> {
    if (!this.workerEngine) return;

    const startTime = Date.now();

    // Deep Preemption: Create AbortController for this task (ADR-013)
    const abortController = new AbortController();
    this.taskAbortControllers.set(task.id, abortController);

    try {
      const result = await this.workerEngine.execute<unknown>(
        task.id,
        {
          type: 'sandbox',
          code: JSON.stringify(task.payload),
          timeoutMs: task.timeoutMs,
        },
        task.timeoutMs,
        abortController.signal,  // Pass signal for Deep Preemption
      );

      const executionTimeMs = Date.now() - startTime;

      const taskResult: TaskResult = {
        taskId: task.id,
        status: 'COMPLETED',
        output: result,
        executionTimeMs,
        attempts: 1,
        completedAt: new Date(),
      };

      await this.scheduler.complete(task.id, taskResult);
      this.addCompletedTask(task.id, taskResult);

      // Notify handlers
      for (const handler of this.taskCompleteHandlers) {
        handler(taskResult);
      }
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;

      const taskResult: TaskResult = {
        taskId: task.id,
        status: 'FAILED',
        error: {
          message: (error as Error).message,
          code: 'EXECUTION_ERROR',
          stack: (error as Error).stack,
        },
        executionTimeMs,
        attempts: 1,
        completedAt: new Date(),
      };

      await this.scheduler.fail(task.id, error as Error, true);
      this.addCompletedTask(task.id, taskResult);

      // Notify handlers
      for (const handler of this.taskCompleteHandlers) {
        handler(taskResult);
      }
    } finally {
      this.runningTasks.delete(task.id);
      // Deep Preemption: Cleanup abort controller
      this.taskAbortControllers.delete(task.id);
    }
  }

  /**
   * Execute task in-process (fallback)
   */
  private async executeInProcess(task: AgentTask): Promise<void> {
    const startTime = Date.now();

    try {
      // Simple in-process execution
      const result = await this.executeTaskPayload(task.payload);
      const executionTimeMs = Date.now() - startTime;

      const taskResult: TaskResult = {
        taskId: task.id,
        status: 'COMPLETED',
        output: result,
        executionTimeMs,
        attempts: 1,
        completedAt: new Date(),
      };

      await this.scheduler.complete(task.id, taskResult);
      this.addCompletedTask(task.id, taskResult);

      for (const handler of this.taskCompleteHandlers) {
        handler(taskResult);
      }
    } catch (error) {
      const executionTimeMs = Date.now() - startTime;

      const taskResult: TaskResult = {
        taskId: task.id,
        status: 'FAILED',
        error: {
          message: (error as Error).message,
          code: 'EXECUTION_ERROR',
          stack: (error as Error).stack,
        },
        executionTimeMs,
        attempts: 1,
        completedAt: new Date(),
      };

      await this.scheduler.fail(task.id, error as Error, true);
      this.addCompletedTask(task.id, taskResult);

      for (const handler of this.taskCompleteHandlers) {
        handler(taskResult);
      }
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  /**
   * Execute task payload
   */
  private async executeTaskPayload(payload: unknown): Promise<unknown> {
    // For now, just echo the payload
    // In a real implementation, this would dispatch to appropriate handlers
    return { processed: true, payload };
  }

  /**
   * Perform graceful shutdown
   */
  private async performShutdown(): Promise<void> {
    const timeoutMs = this.options.gracefulShutdownTimeoutMs || 30000;
    const startTime = Date.now();

    // Wait for running tasks to complete
    while (this.runningTasks.size > 0 && Date.now() - startTime < timeoutMs) {
      await this.sleep(100);
    }

    // Shutdown worker engine
    if (this.workerEngine) {
      // Symmetric unsubscription — prevents EventEmitter listener leaks (OOM-008)
      if (this.onWorkerTaskComplete) this.workerEngine.off('taskComplete', this.onWorkerTaskComplete);
      if (this.onWorkerTaskError) this.workerEngine.off('taskError', this.onWorkerTaskError);
      await this.workerEngine.shutdown(timeoutMs / 2);
    }

  // Shutdown scheduler
  const schedulerWithEvents = this.getSchedulerEventEmitter();
  if (schedulerWithEvents && this.onSchedulerTaskStarted) schedulerWithEvents.off('taskStarted', this.onSchedulerTaskStarted);
  if (schedulerWithEvents && this.onSchedulerTaskCompleted) schedulerWithEvents.off('taskCompleted', this.onSchedulerTaskCompleted);
  if (schedulerWithEvents && this.onSchedulerTaskFailed) schedulerWithEvents.off('taskFailed', this.onSchedulerTaskFailed);
    await this.scheduler.shutdown();

    this.setState('STOPPED');
    this.emit('stopped');

    // Remove all listeners to prevent accumulation on restart (OOM-008)
    this.removeAllListeners();
  }

  /**
   * Set state and notify listeners
   */
  private setState(newState: AgentRunnerState): void {
    const oldState = this.state;
    this.state = newState;

    if (oldState !== newState) {
      this.emit('stateChange', newState);
      for (const handler of this.stateChangeHandlers) {
        handler(newState);
      }
    }
  }

  /**
   * Set up scheduler event listeners
   */
  private setupSchedulerListeners(): void {
    const schedulerWithEvents = this.getSchedulerEventEmitter();

    if (!schedulerWithEvents) {
      return;
    }

    // Bind handlers for symmetric cleanup (OOM-008)
    this.onSchedulerTaskStarted = (data: { taskId: TaskId; workerId: string }) => {
      this.emit('taskStarted', data);
    };
    this.onSchedulerTaskCompleted = (data: { taskId: TaskId; executionTimeMs: number }) => {
      this.emit('taskCompleted', data);
    };
    this.onSchedulerTaskFailed = (data: { taskId: TaskId; error: string }) => {
      this.emit('taskFailed', data);
    };

    schedulerWithEvents.on('taskStarted', this.onSchedulerTaskStarted);
    schedulerWithEvents.on('taskCompleted', this.onSchedulerTaskCompleted);
    schedulerWithEvents.on('taskFailed', this.onSchedulerTaskFailed);
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Note: Use DI container to instantiate AgentRunnerService
// Example: container.resolve<IAgentRunner>('IAgentRunner')
