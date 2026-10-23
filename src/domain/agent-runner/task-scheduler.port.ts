/**
 * Task Scheduler Port
 * Domain layer contract for task scheduling and queue management.
 * Layer: Domain
 *
 * Provides priority-based scheduling with backpressure handling.
 */

import { AgentTask, TaskId, TaskPriority, TaskResult, TaskStatus, BackpressureError } from './agent-runner.port';
import type { CorrelationId } from '../routing/IRoutingContext';

/**
 * Task queue statistics
 */
export interface TaskQueueStats {
  totalQueued: number;
  totalRunning: number;
  totalCompleted: number;
  totalFailed: number;
  byPriority: Record<TaskPriority, number>;
  averageWaitTimeMs: number;
  averageExecutionTimeMs: number;
}

/**
 * Task filter options
 */
export interface TaskFilter {
  status?: TaskStatus;
  priority?: TaskPriority;
  agentId?: string;
  correlationId?: CorrelationId;
  createdAfter?: Date;
  createdBefore?: Date;
}

/**
 * Scheduled task with metadata
 */
export interface ScheduledTask {
  task: AgentTask;
  status: TaskStatus;
  queuedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
  workerId?: string;
  retryCount: number;
  error?: string;
}

/**
 * Backpressure signal
 */
export interface BackpressureSignal {
  isActive: boolean;
  queueUtilization: number;
  rejectionRate: number;
  recommendedAction: 'accept' | 'throttle' | 'reject';
}

/**
 * Task scheduler configuration
 */
export interface TaskSchedulerConfig {
  maxQueueSize: number;
  maxConcurrentTasks: number;
  defaultTaskTimeoutMs: number;
  maxTaskTimeoutMs: number;
  priorityWeights: Record<TaskPriority, number>;
  enableBackpressure: boolean;
  backpressureThresholds: {
    warning: number;
    critical: number;
    rejection: number;
  };
}

/**
 * Core Task Scheduler interface
 */
export interface ITaskScheduler {
  /**
   * Initialize the scheduler
   */
  initialize(): Promise<void>;

  /**
   * Shutdown the scheduler gracefully
   */
  shutdown(): Promise<void>;

  /**
   * Schedule a task for execution
   * @throws BackpressureError if queue is at capacity
   */
  schedule(task: AgentTask): Promise<TaskId>;

  /**
   * Cancel a scheduled or running task
   */
  cancel(taskId: TaskId): Promise<boolean>;

  /**
   * Get the next task for execution (called by workers)
   */
  dequeue(workerId: string, timeoutMs?: number): Promise<AgentTask | null>;

  /**
   * Mark task as completed
   */
  complete(taskId: TaskId, result: TaskResult): Promise<void>;

  /**
   * Mark task as failed (may trigger retry)
   */
  fail(taskId: TaskId, error: Error, retryable: boolean): Promise<void>;

  /**
   * Acknowledge task processing (for queue systems)
   */
  acknowledge(taskId: TaskId, status: TaskStatus): Promise<void>;

  /**
   * Get current queue statistics
   */
  getStats(): TaskQueueStats;

  /**
   * Get task details
   */
  getTask(taskId: TaskId): Promise<ScheduledTask | undefined>;

  /**
   * List tasks matching filter
   */
  listTasks(filter?: TaskFilter, limit?: number): Promise<ScheduledTask[]>;

  /**
   * Get current backpressure status
   */
  getBackpressureStatus(): BackpressureSignal;

  /**
   * Check if scheduler can accept new tasks
   */
  canAcceptTask(): boolean;

  /**
   * Pause task scheduling (existing tasks continue)
   */
  pause(): Promise<void>;

  /**
   * Resume task scheduling
   */
  resume(): Promise<void>;
}

/**
 * Task retry policy
 */
export interface ITaskRetryPolicy {
  /**
   * Calculate delay before next retry
   */
  getRetryDelay(attemptNumber: number): number;

  /**
   * Check if task should be retried
   */
  shouldRetry(attemptNumber: number, error: Error): boolean;

  /**
   * Get maximum retry attempts
   */
  getMaxRetries(): number;
}

/**
 * Exponential backoff retry policy
 */
export class ExponentialBackoffRetryPolicy implements ITaskRetryPolicy {
  constructor(
    private maxRetries: number = 3,
    private baseDelayMs: number = 1000,
    private maxDelayMs: number = 30000,
    private backoffMultiplier: number = 2,
  ) {}

  getRetryDelay(attemptNumber: number): number {
    const delay = this.baseDelayMs * Math.pow(this.backoffMultiplier, attemptNumber - 1);
    const jitter = Math.random() * 1000;
    return Math.min(delay + jitter, this.maxDelayMs);
  }

  shouldRetry(attemptNumber: number, error: Error): boolean {
    if (attemptNumber >= this.maxRetries) return false;
    
    // Don't retry on certain errors
    const nonRetryableErrors = [
      'ValidationError',
      'PermissionDeniedError',
      'TaskNotFoundError',
    ];
    
    return !nonRetryableErrors.includes(error.name);
  }

  getMaxRetries(): number {
    return this.maxRetries;
  }
}

/**
 * Error thrown when scheduler is paused
 */
export class SchedulerPausedError extends Error {
  constructor() {
    super('Task scheduler is paused');
    this.name = 'SchedulerPausedError';
  }
}

/**
 * Error thrown when task dequeue times out
 */
export class TaskDequeueTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Task dequeue timed out after ${timeoutMs}ms`);
    this.name = 'TaskDequeueTimeoutError';
  }
}
