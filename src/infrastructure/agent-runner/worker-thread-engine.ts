/**
 * Worker Thread Engine
 * Infrastructure layer implementation for managing worker thread pools.
 * Layer: Infrastructure
 *
 * Manages pool of worker threads for true parallelism.
 * Offloads CPU-intensive tasks from main thread.
 * Communicates via MessageChannel.
 */

import { Worker, MessageChannel, MessagePort } from 'worker_threads';
import { EventEmitter } from 'events';
import * as path from 'path';
import { IToolRegistry, CallToolMessage, ToolResultMessage } from '../../domain/agents/tools.interface';
import { IToolExecutionPolicy } from '../../domain/security/tool-execution-policy.interface';
import type { IIntentMisalignmentDetector, MisalignmentVerdict } from '../../domain/security/IIntentMisalignmentDetector';
import type { IAgentEventStream, AgentAction } from '../../domain/agents/IAgentEventStream';
import type { IExecutionProvenanceTracer } from '../../domain/agents/IExecutionProvenanceTracer';
import type { ISuccessLedgerStore } from '../../domain/memory/ISuccessLedgerStore';
import type {
  IS2iLessonExtractor,
  RootCauseCategory,
  SuccessLedgerEntry,
} from '../../domain/agents/IS2iLessonExtractor';
import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';
import { IdGenerator } from '../../core/utils/IdGenerator';

class ToolBridgeInitializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolBridgeInitializationError';
  }
}

class ToolPolicyDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolPolicyDeniedError';
  }
}

class IntentMisalignmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'IntentMisalignmentError';
  }
}

// ... (existing interfaces)

/**
 * Worker thread configuration
 */
export interface WorkerConfig {
  minPoolSize: number;
  maxPoolSize: number;
  idleTimeoutMs: number;
  taskTimeoutMs: number;
  maxTasksPerWorker: number;
  resourceLimits: {
    maxMemoryMb: number;
    maxCpuPercent: number;
  };
}

/**
 * Queued task definition
 */
interface QueuedTask {
  taskId: string;
  payload: unknown;
  timeoutMs: number;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  startTime: number;
  timeoutHandle?: NodeJS.Timeout;
}

/**
 * Worker instance with metadata
 */
interface WorkerInstance {
  id: string;
  worker: Worker;
  port: MessagePort;
  status: 'idle' | 'busy' | 'terminating';
  taskCount: number;
  lastActivityAt: Date;
  currentTaskId?: string;
  currentTask?: QueuedTask;
  handlers: {
    message: (message: WorkerResponseMessage) => void;
    error: (error: Error) => void;
    exit: (code: number) => void;
  };
}

/**
 * Task message for worker
 */
export interface WorkerTaskMessage {
  type: 'EXECUTE';
  taskId: string;
  payload: unknown;
  timeoutMs: number;
  resourceLimits: {
    maxMemoryMb: number;
    maxCpuPercent: number;
  };
}

/**
 * Worker response message
 */
export interface WorkerResponseMessage {
  type: 'COMPLETE' | 'ERROR' | 'PROGRESS';
  taskId: string;
  payload?: unknown;
  error?: {
    message: string;
    code: string;
    stack?: string;
  };
  progress?: {
    percent: number;
    message?: string;
  };
}

/**
 * Worker pool statistics
 */
export interface WorkerPoolStats {
  totalWorkers: number;
  idleWorkers: number;
  busyWorkers: number;
  terminatingWorkers: number;
  pendingTasks: number;
  completedTasks: number;
  failedTasks: number;
  averageExecutionTimeMs: number;
}

export interface WorkerThreadPuaRuntimeHooks {
  intentMisalignmentDetector?: IIntentMisalignmentDetector;
  agentEventStream?: IAgentEventStream;
  executionProvenanceTracer?: IExecutionProvenanceTracer;
  successLedgerStore?: ISuccessLedgerStore;
  s2iLessonExtractor?: Pick<IS2iLessonExtractor, 'extractLesson' | 'checkTriggers' | 'registerAntiRationalizationTrigger'>;
}

/**
 * Worker Thread Engine - manages pool of worker threads
 */
export class WorkerThreadEngine extends EventEmitter {
  private workers: Map<string, WorkerInstance> = new Map();
  private taskQueue: QueuedTask[] = [];
  private stats = {
    completedTasks: 0,
    failedTasks: 0,
    totalExecutionTimeMs: 0,
  };
  private idleCheckInterval?: NodeJS.Timeout;
  private isShuttingDown = false;
  private workerScriptPath: string;

  constructor(
    private config: WorkerConfig,
    workerScriptPath?: string,
    private toolRegistry?: IToolRegistry, // Optional for now
    private toolPolicy?: IToolExecutionPolicy, // Optional for now
    private readonly logger?: IStructuredLogger,
    private readonly puaRuntime?: WorkerThreadPuaRuntimeHooks,
  ) {
    super();
    this.workerScriptPath = workerScriptPath || this.getDefaultWorkerScriptPath();
  }

  /**
   * Initialize the worker pool
   */
  async initialize(): Promise<void> {
    if (this.isShuttingDown) {
      throw new Error('Cannot initialize: engine is shutting down');
    }

    // Create minimum pool size
    const initPromises: Promise<void>[] = [];
    for (let i = 0; i < this.config.minPoolSize; i++) {
      initPromises.push(this.createWorker());
    }
    const initResults = await Promise.allSettled(initPromises);
    const initFailure = initResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (initFailure) {
      throw initFailure.reason;
    }

    // Start idle worker cleanup
    this.idleCheckInterval = setInterval(() => {
      this.cleanupIdleWorkers();
    }, this.config.idleTimeoutMs);

    this.emit('initialized', { poolSize: this.config.minPoolSize });
  }

  /**
   * Shutdown all workers gracefully
   */
  async shutdown(timeoutMs: number = 30000): Promise<void> {
    this.isShuttingDown = true;

    // Clear idle check interval
    if (this.idleCheckInterval) {
      clearInterval(this.idleCheckInterval);
      this.idleCheckInterval = undefined;
    }

    // Reject pending tasks
    const pendingTasks = [...this.taskQueue];
    this.taskQueue = [];
    for (const task of pendingTasks) {
      task.reject(new Error('Worker pool is shutting down'));
    }

    // Terminate all workers
    const terminatePromises = Array.from(this.workers.values()).map(worker =>
      this.terminateWorker(worker.id, timeoutMs),
    );

    const terminateResults = await Promise.allSettled(terminatePromises);
    const terminateFailure = terminateResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (terminateFailure) {
      throw terminateFailure.reason;
    }
    this.workers.clear();

    this.emit('shutdown');
  }

  /**
   * Execute a task in a worker thread
   * @param taskId - Unique task identifier
   * @param payload - Task payload data
   * @param timeoutMs - Optional timeout override
   * @param signal - Optional AbortSignal for Deep Preemption (ADR-013)
   */
  async execute<T>(
    taskId: string,
    payload: unknown,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (this.isShuttingDown) {
      throw new Error('Cannot execute: engine is shutting down');
    }

    // Deep Preemption: Check if already aborted
    if (signal?.aborted) {
      throw new Error(`Task ${taskId} aborted before execution: ${signal.reason ?? 'No reason'}`);
    }

    return new Promise((resolve, reject) => {
      const taskTimeout = timeoutMs || this.config.taskTimeoutMs;
      
      const task: QueuedTask = {
        taskId,
        payload,
        timeoutMs: taskTimeout,
        resolve: resolve as (result: unknown) => void,
        reject,
        startTime: Date.now(),
      };

      this.taskQueue.push(task);

      // Deep Preemption: Listen for abort signal
      if (signal) {
        signal.addEventListener('abort', () => {
          const taskIndex = this.taskQueue.indexOf(task);
          if (taskIndex !== -1) {
            // Task still in queue - remove and reject
            this.taskQueue.splice(taskIndex, 1);
            reject(new Error(`Task ${taskId} aborted: ${signal.reason ?? 'Operation cancelled'}`));
          } else {
            // Task already assigned to worker - need to terminate worker
            const busyWorker = Array.from(this.workers.values()).find(w => w.currentTaskId === taskId);
            if (busyWorker) {
              this.emit('taskAborted', { taskId, workerId: busyWorker.id });
              // Force terminate the worker to stop the task
              this.terminateWorker(busyWorker.id, 1000).catch(err => {
                console.error(`[WorkerThreadEngine] Failed to terminate worker ${busyWorker.id}:`, err);
              });
              reject(new Error(`Task ${taskId} aborted: ${signal.reason ?? 'Operation cancelled'}`));
            }
          }
        }, { once: true });
      }

      this.processQueue();
    });
  }

  /**
   * Get current pool statistics
   */
  getStats(): WorkerPoolStats {
    const idleWorkers = Array.from(this.workers.values()).filter(w => w.status === 'idle').length;
    const busyWorkers = Array.from(this.workers.values()).filter(w => w.status === 'busy').length;
    const terminatingWorkers = Array.from(this.workers.values()).filter(w => w.status === 'terminating').length;

    const avgExecutionTime = this.stats.completedTasks > 0
      ? this.stats.totalExecutionTimeMs / this.stats.completedTasks
      : 0;

    return {
      totalWorkers: this.workers.size,
      idleWorkers,
      busyWorkers,
      terminatingWorkers,
      pendingTasks: this.taskQueue.length,
      completedTasks: this.stats.completedTasks,
      failedTasks: this.stats.failedTasks,
      averageExecutionTimeMs: avgExecutionTime,
    };
  }

  /**
   * Scale the worker pool
   */
  async scale(targetSize: number): Promise<void> {
    const currentSize = this.workers.size;

    if (targetSize > currentSize) {
      // Scale up
      const addCount = Math.min(targetSize - currentSize, this.config.maxPoolSize - currentSize);
      const createPromises: Promise<void>[] = [];
      for (let i = 0; i < addCount; i++) {
        createPromises.push(this.createWorker());
      }
      const createResults = await Promise.allSettled(createPromises);
      const createFailure = createResults.find(
        (result): result is PromiseRejectedResult => result.status === 'rejected',
      );
      if (createFailure) {
        throw createFailure.reason;
      }
      this.emit('scaled', { direction: 'up', count: addCount, newSize: this.workers.size });
    } else if (targetSize < currentSize) {
      // Scale down - mark excess idle workers for termination
      const removeCount = currentSize - targetSize;
      let removed = 0;

      for (const worker of this.workers.values()) {
        if (worker.status === 'idle' && removed < removeCount) {
          worker.status = 'terminating';
          removed++;
        }
      }

      this.emit('scaled', { direction: 'down', count: removed, newSize: this.workers.size - removed });
    }
  }

  /**
   * Get available capacity for new tasks
   */
  getAvailableCapacity(): number {
    const idleWorkers = Array.from(this.workers.values()).filter(w => w.status === 'idle').length;
    const canCreate = this.config.maxPoolSize - this.workers.size;
    return idleWorkers + canCreate;
  }

  /**
   * Create a new worker
   */
  private async createWorker(): Promise<void> {
    const workerId = IdGenerator.generateWithPrefix('worker');
    
    const { port1, port2 } = new MessageChannel();
    
    const worker = new Worker(this.workerScriptPath, {
      workerData: {
        workerId,
        resourceLimits: this.config.resourceLimits,
      },
    });

    // Define handlers as bound functions for cleanup
    const messageHandler = (message: WorkerResponseMessage): void => {
      this.handleWorkerMessage(workerInstance, message);
    };

    const errorHandler = (error: Error): void => {
      this.emit('workerError', { workerId, error });
      this.replaceWorker(workerInstance);
    };

    const exitHandler = (code: number): void => {
      if (code !== 0 && !this.isShuttingDown) {
        this.emit('workerCrashed', { workerId, exitCode: code });
        this.workers.delete(workerId);
        // Create replacement if needed
        if (!this.isShuttingDown && this.workers.size < this.config.minPoolSize) {
          this.createWorker()
            .catch((err) => this.emit('workerError', { workerId, error: err }));
        }
      }
    };

    const workerInstance: WorkerInstance = {
      id: workerId,
      worker,
      port: port1,
      status: 'idle',
      taskCount: 0,
      lastActivityAt: new Date(),
      handlers: {
        message: messageHandler,
        error: errorHandler,
        exit: exitHandler,
      },
    };

    // Send port to worker
    worker.postMessage({ type: 'PORT', port: port2 }, [port2]);

    // Register event listeners
    port1.on('message', messageHandler);
    worker.on('error', errorHandler);
    worker.on('exit', exitHandler);

    this.workers.set(workerId, workerInstance);
    this.emit('workerCreated', { workerId });
  }

  /**
   * Terminate a worker
   */
  private async terminateWorker(workerId: string, timeoutMs: number): Promise<void> {
    const worker = this.workers.get(workerId);
    if (!worker) return;

    worker.status = 'terminating';

    // Cleanup event listeners to prevent memory leaks
    worker.port.off('message', worker.handlers.message);
    worker.worker.off('error', worker.handlers.error);
    worker.worker.off('exit', worker.handlers.exit);

    // Defensive: remove any other listeners
    worker.worker.removeAllListeners();

    // Give worker a chance to complete current task
    const terminateTimeout = setTimeout(() => {
      worker.worker.terminate()
        .catch(() => { /* best-effort termination */ });
    }, timeoutMs);

    try {
      worker.port.postMessage({ type: 'SHUTDOWN' });
      await new Promise<void>((resolve) => {
        worker.worker.once('exit', () => resolve());
      });
    } catch {
      worker.worker.terminate()
        .catch(() => { /* best-effort termination */ });
    } finally {
      clearTimeout(terminateTimeout);
      this.workers.delete(workerId);
    }
  }

  /**
   * Replace a crashed or error worker
   */
  private replaceWorker(workerInstance: WorkerInstance): void {
    this.workers.delete(workerInstance.id);
    if (!this.isShuttingDown) {
      this.createWorker()
        .catch((err) => console.error(`[WorkerThreadEngine] Failed to replace worker:`, err));
    }
  }

  /**
   * Process the task queue
   */
  private processQueue(): void {
    if (this.taskQueue.length === 0) return;

    // Find available worker
    const availableWorker = Array.from(this.workers.values()).find(
      w => w.status === 'idle' && w.taskCount < this.config.maxTasksPerWorker,
    );

    if (!availableWorker) {
      // Try to scale up if possible
      if (this.workers.size < this.config.maxPoolSize) {
        this.createWorker()
          .then(() => this.processQueue())
          .catch((err) => this.emit('workerError', { workerId: 'pool-scaleup', error: err }));
      }
      return;
    }

    const task = this.taskQueue.shift();
    if (!task) return;

    // Assign task to worker
    availableWorker.status = 'busy';
    availableWorker.currentTaskId = task.taskId;
    availableWorker.taskCount++;

    const timeoutHandle = setTimeout(() => {
      this.handleTaskTimeout(availableWorker, task);
    }, task.timeoutMs);

    // Store timeout handle for cleanup
    (task as unknown as { timeoutHandle: NodeJS.Timeout }).timeoutHandle = timeoutHandle;

    availableWorker.port.postMessage({
      type: 'EXECUTE',
      taskId: task.taskId,
      payload: task.payload,
      timeoutMs: task.timeoutMs,
      resourceLimits: this.config.resourceLimits,
    });

    // Store resolve/reject for later
    availableWorker.currentTask = task;

    // Process next item in queue
    setImmediate(() => this.processQueue());
  }

  /**
   * Handle messages from workers
   */
  private handleWorkerMessage(
    workerInstance: WorkerInstance,
    message: WorkerResponseMessage,
  ): void {
    const task = workerInstance.currentTask;

    switch (message.type) {
      case 'COMPLETE':
        this.handleTaskComplete(workerInstance, task, message.payload);
        break;
      case 'ERROR':
        this.handleTaskError(workerInstance, task, message.error);
        break;
      case 'PROGRESS':
        this.emit('taskProgress', {
          taskId: message.taskId,
          progress: message.progress,
        });
        break;
      // @ts-ignore - Dynamic check for CALL_TOOL
      case 'CALL_TOOL':
         this.handleToolCall(workerInstance, message as unknown as CallToolMessage)
           .catch((err) => this.emit('workerError', { workerId: workerInstance.id, error: err }));
         break;
    }
  }

  /**
   * Handle task completion
   */
  private handleTaskComplete(
    workerInstance: WorkerInstance,
    task: QueuedTask | undefined,
    result: unknown,
  ): void {
    if (task) {
      clearTimeout(task.timeoutHandle);
      const executionTime = Date.now() - task.startTime;
      this.stats.completedTasks++;
      this.stats.totalExecutionTimeMs += executionTime;
      task.resolve(result);
      this.emit('taskComplete', { taskId: task.taskId, executionTimeMs: executionTime });
    }

    this.releaseWorker(workerInstance);
  }

  /**
   * Handle task error
   */
  private handleTaskError(
    workerInstance: WorkerInstance,
    task: QueuedTask | undefined,
    error?: { message: string; code: string; stack?: string },
  ): void {
    if (task) {
      clearTimeout(task.timeoutHandle);
      this.stats.failedTasks++;
      const err = new Error(error?.message || 'Unknown worker error');
      if (error?.stack) err.stack = error.stack;
      (err as unknown as { code: string }).code = error?.code || 'WORKER_ERROR';
      task.reject(err);
      this.emit('taskError', { taskId: task.taskId, error: err });
    }

    this.releaseWorker(workerInstance);
  }

  /**
   * Handle task timeout
   */
  private handleTaskTimeout(
    workerInstance: WorkerInstance,
    task: QueuedTask,
  ): void {
    this.stats.failedTasks++;
    const error = new Error(`Task ${task.taskId} timed out after ${task.timeoutMs}ms`);
    (error as unknown as { code: string }).code = 'TASK_TIMEOUT';
    task.reject(error);
    this.emit('taskTimeout', { taskId: task.taskId, timeoutMs: task.timeoutMs });

    // Terminate and replace the worker
    this.replaceWorker(workerInstance);
  }

  /**
   * Release worker back to pool
   */
  private releaseWorker(workerInstance: WorkerInstance): void {
    workerInstance.status = 'idle';
    workerInstance.currentTaskId = undefined;
    workerInstance.lastActivityAt = new Date();
    workerInstance.currentTask = undefined;

    // Process next task if available
    setImmediate(() => this.processQueue());
  }

  /**
   * Cleanup idle workers beyond minimum pool size
   */
  private cleanupIdleWorkers(): void {
    const now = Date.now();
    const idleTimeout = this.config.idleTimeoutMs;

    for (const worker of this.workers.values()) {
      if (
        worker.status === 'idle' &&
        this.workers.size > this.config.minPoolSize &&
        now - worker.lastActivityAt.getTime() > idleTimeout
      ) {
        worker.status = 'terminating';
        this.terminateWorker(worker.id, 5000)
          .catch((err) => this.logger?.error(`[WorkerThreadEngine] Idle cleanup termination failed for ${worker.id}:`, { error: String(err) }));
      }
    }
  }

  /**
   * Get default worker script path
   */
  private getDefaultWorkerScriptPath(): string {
    return path.join(__dirname, 'worker-scripts', 'task-worker.js');
  }

  /**
   * Handle RPC Tool Call from Worker
   */
  private async handleToolCall(
      workerInstance: WorkerInstance,
      message: CallToolMessage
  ): Promise<void> {
    const { id, tool, args, agentId } = message;
    const resolvedAgentId = agentId ?? 'unknown-agent';
    const resolvedTaskId = workerInstance.currentTaskId ?? id ?? 'unknown-task';
    
    // Default context
    // In a real system, we should track the active agentId per worker/task
    const context = {
        agentId: resolvedAgentId,
      sessionId: `pua-${String(resolvedTaskId)}`,
        config: {},
        workspaceRoot: this.resolveWorkspaceRootFromPayload(workerInstance.currentTask?.payload)
    };

    const argsSummary = this.summarizeValue(args);
    const taskIntent = this.buildTaskIntent(workerInstance, tool, argsSummary);
    const sessionId = this.createAgentEventSession(
      context.agentId,
      taskIntent,
      workerInstance,
      tool,
      id,
    ) ?? context.sessionId;
    context.sessionId = sessionId;

    let toolAction: AgentAction | undefined;
    let sessionClosed = false;
    let misalignmentVerdict: MisalignmentVerdict | undefined;
    let policyReason: string | undefined;

    try {
        if (!this.toolRegistry || !this.toolPolicy) {
        throw new ToolBridgeInitializationError('Tool Bridge not initialized on Host.');
        }

        toolAction = this.recordAgentAction(sessionId, 'tool_call', {
          toolName: tool,
          workerId: workerInstance.id,
          taskId: workerInstance.currentTaskId,
          callId: id,
          argsSummary,
        });

        if (this.puaRuntime?.intentMisalignmentDetector) {
          misalignmentVerdict = this.puaRuntime.intentMisalignmentDetector.analyze(
            tool,
            argsSummary,
            taskIntent,
          );

          if (misalignmentVerdict.alignment === 'misaligned') {
            throw new IntentMisalignmentError(
              `IntentMisalignment: Tool '${tool}' diverges from task intent. ${misalignmentVerdict.summary}`,
            );
          }
        }

        // 1. Policy Check
        const policyResult = await this.toolPolicy.evaluate({
            toolName: tool,
            agentId: context.agentId,
            arguments: args as Record<string, unknown>,
            sessionId: context.sessionId
        });

        if (!policyResult.allowed) {
          policyReason = policyResult.reason;
          throw new ToolPolicyDeniedError(
            'ToolPolicy: Access denied for tool \'' + tool + '\'. Reason: ' + (policyResult.reason ?? 'Unknown policy reason'),
          );
        }

        // 2. Execute
        const executionArgs = policyResult.modifiedArguments ?? args;
        const result = await this.toolRegistry.execute(tool, executionArgs, context);

        const successClaim = `Tool '${tool}' executed successfully`;
        const successCitationId = this.recordToolOutcomeEvidence(
          tool,
          sessionId,
          `tool-result-${id}`,
          successClaim,
          this.summarizeValue(result),
        );

        this.recordAgentObservation(sessionId, 'tool_result', {
          toolName: tool,
          workerId: workerInstance.id,
          callId: id,
          resultPreview: this.summarizeValue(result),
          citationId: successCitationId,
        }, toolAction?.eventId);

        // 3. Respond
        const response: ToolResultMessage = {
            type: 'TOOL_RESULT',
            id,
            result
        };
        workerInstance.port.postMessage(response);
        this.closeAgentEventSession(sessionId, 'completed');
        sessionClosed = true;

    } catch (error: unknown) {
        const rootCauseCategory = this.classifyToolError(error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        const errorClaim = this.buildErrorClaim(tool, error, misalignmentVerdict, policyReason);
        const errorCitationId = this.recordToolOutcomeEvidence(
          tool,
          sessionId,
          `tool-error-${id}`,
          errorClaim,
          errorMessage,
        );

        this.recordAgentObservation(sessionId, 'error', {
          toolName: tool,
          workerId: workerInstance.id,
          callId: id,
          errorMessage,
          citationId: errorCitationId,
          rootCauseCategory,
          misalignmentVerdict,
        }, toolAction?.eventId);

        const successLedgerEntry = await this.persistSuccessLedgerEntry({
          sessionId,
          toolName: tool,
          agentId: context.agentId,
          rootCauseCategory,
          summary: errorClaim,
          affectedFiles: [],
        });

        // Wire anti-rationalization trigger into S2I when intent misalignment
        // detects a rationalization bypass with a matched excuse
        if (
          misalignmentVerdict?.worstCase?.isRationalizationBypass &&
          misalignmentVerdict.worstCase.matchedExcuse &&
          this.puaRuntime?.s2iLessonExtractor?.registerAntiRationalizationTrigger
        ) {
          this.puaRuntime.s2iLessonExtractor.registerAntiRationalizationTrigger(
            misalignmentVerdict.worstCase.matchedExcuse,
            successLedgerEntry.entryId,
          );
        }

        const response: ToolResultMessage = {
            type: 'TOOL_RESULT',
            id,
            error: {
                code: 'TOOL_EXECUTION_ERROR',
          message: errorMessage
            }
        };
        workerInstance.port.postMessage(response);
        this.closeAgentEventSession(sessionId, 'failed');
        sessionClosed = true;
    } finally {
        if (!sessionClosed) {
          this.closeAgentEventSession(sessionId, 'failed');
        }
    }
  }

  private summarizeValue(value: unknown, maxLength: number = 300): string {
    if (typeof value === 'string') {
      return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
    }

    try {
      const serialized = JSON.stringify(value);
      if (!serialized) {
        return String(value);
      }
      return serialized.length > maxLength ? `${serialized.slice(0, maxLength)}...` : serialized;
    } catch {
      return String(value);
    }
  }

  private buildTaskIntent(workerInstance: WorkerInstance, toolName: string, argsSummary: string): string {
    const payload = workerInstance.currentTask?.payload;
    if (typeof payload === 'string' && payload.trim().length > 0) {
      return this.summarizeValue(payload, 500);
    }

    if (payload && typeof payload === 'object') {
      const maybeRecord = payload as Record<string, unknown>;
      if (typeof maybeRecord.code === 'string' && maybeRecord.code.trim().length > 0) {
        return this.summarizeValue(maybeRecord.code, 500);
      }
      return this.summarizeValue(payload, 500);
    }

    return `task:${workerInstance.currentTaskId || 'unknown'} tool:${toolName} args:${argsSummary}`;
  }

  private resolveWorkspaceRootFromPayload(payload: unknown): string {
    if (payload && typeof payload === 'object') {
      const record = payload as Record<string, unknown>;

      if (typeof record.workspaceRoot === 'string' && record.workspaceRoot.trim().length > 0) {
        return record.workspaceRoot;
      }

      const metadataWorkspaceRoot = (record.metadata as Record<string, unknown> | undefined)?.workspaceRoot;
      if (typeof metadataWorkspaceRoot === 'string' && metadataWorkspaceRoot.trim().length > 0) {
        return metadataWorkspaceRoot;
      }

      const contextWorkspaceRoot = (record.context as Record<string, unknown> | undefined)?.workspaceRoot;
      if (typeof contextWorkspaceRoot === 'string' && contextWorkspaceRoot.trim().length > 0) {
        return contextWorkspaceRoot;
      }
    }

    return process.cwd();
  }

  private createAgentEventSession(
    agentId: string,
    taskIntent: string,
    workerInstance: WorkerInstance,
    toolName: string,
    callId: string,
  ): string | undefined {
    try {
      return this.puaRuntime?.agentEventStream?.createSession(agentId, taskIntent, {
        workerId: workerInstance.id,
        taskId: workerInstance.currentTaskId,
        toolName,
        callId,
      }).sessionId;
    } catch (error) {
      this.logger?.warn('Failed to create PUA event session', {
        workerId: workerInstance.id,
        toolName,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private closeAgentEventSession(sessionId: string, status: 'completed' | 'failed'): void {
    try {
      this.puaRuntime?.agentEventStream?.closeSession(sessionId, status);
    } catch (error) {
      this.logger?.warn('Failed to close PUA event session', {
        sessionId,
        status,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recordAgentAction(
    sessionId: string,
    kind: 'tool_call',
    payload: Record<string, unknown>,
  ): AgentAction | undefined {
    try {
      return this.puaRuntime?.agentEventStream?.recordAction(sessionId, kind, payload);
    } catch (error) {
      this.logger?.warn('Failed to record PUA action', {
        sessionId,
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private recordAgentObservation(
    sessionId: string,
    kind: 'tool_result' | 'error',
    payload: Record<string, unknown>,
    sourceActionId?: string,
  ): void {
    try {
      this.puaRuntime?.agentEventStream?.recordObservation(sessionId, kind, payload, sourceActionId);
    } catch (error) {
      this.logger?.warn('Failed to record PUA observation', {
        sessionId,
        kind,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private recordToolOutcomeEvidence(
    toolName: string,
    sessionId: string,
    chunkId: string,
    claim: string,
    contentSnippet: string,
  ): string | undefined {
    try {
      const tracer = this.puaRuntime?.executionProvenanceTracer;
      if (!tracer) {
        return undefined;
      }

      const terminalRecord = tracer.recordTerminalOutput(
        `tool:${toolName}`,
        chunkId,
        1,
        1,
        contentSnippet,
        sessionId,
      );
      return tracer.createCitation(claim, 'terminal', terminalRecord.recordId, 1, 1).citationId;
    } catch (error) {
      this.logger?.warn('Failed to record tool provenance evidence', {
        toolName,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async persistSuccessLedgerEntry(params: {
    sessionId: string;
    toolName: string;
    agentId: string;
    rootCauseCategory: RootCauseCategory;
    summary: string;
    affectedFiles: readonly string[];
  }): Promise<SuccessLedgerEntry> {
    const entry: SuccessLedgerEntry = {
      entryId: IdGenerator.generateWithPrefix('success-ledger'),
      winningFlavor: 'runtime-pua-guardrail',
      winningStep: 4,
      rootCauseCategory: params.rootCauseCategory,
      lessonsLearned: params.summary,
      trajectoryScore: 6,
      reliabilityLevel: 0.6,
      affectedFiles: params.affectedFiles,
      timestamp: new Date().toISOString(),
      sessionId: params.sessionId,
    };

    const s2iLessonExtractor = this.puaRuntime?.s2iLessonExtractor;
    if (s2iLessonExtractor) {
      try {
        await s2iLessonExtractor.extractLesson(entry);
        s2iLessonExtractor.checkTriggers();
        return entry;
      } catch (error) {
        this.logger?.warn('S2I runtime extraction failed; falling back to Success Ledger persistence', {
          entryId: entry.entryId,
          toolName: params.toolName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!this.puaRuntime?.successLedgerStore) {
      return entry;
    }

    try {
      await this.puaRuntime.successLedgerStore.saveEntry(entry);
      return entry;
    } catch (error) {
      this.logger?.warn('Failed to persist Success Ledger entry', {
        entryId: entry.entryId,
        toolName: params.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return entry;
  }

  private classifyToolError(error: unknown): RootCauseCategory {
    if (error instanceof IntentMisalignmentError) {
      return 'assumption';
    }
    if (error instanceof ToolPolicyDeniedError) {
      return 'architecture';
    }
    if (error instanceof ToolBridgeInitializationError) {
      return 'dependency';
    }
    return 'integration';
  }

  private buildErrorClaim(
    toolName: string,
    error: unknown,
    misalignmentVerdict?: MisalignmentVerdict,
    policyReason?: string,
  ): string {
    if (error instanceof IntentMisalignmentError) {
      return `Intent misalignment denied tool '${toolName}': ${misalignmentVerdict?.summary ?? error.message}`;
    }
    if (error instanceof ToolPolicyDeniedError) {
      return `Policy denied tool '${toolName}': ${policyReason ?? error.message}`;
    }
    return `Tool '${toolName}' failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Error thrown when worker pool is at capacity
 */
export class WorkerPoolExhaustedError extends Error {
  constructor(
    message: string,
    public readonly poolSize: number,
    public readonly pendingTasks: number,
  ) {
    super(message);
    this.name = 'WorkerPoolExhaustedError';
  }
}
