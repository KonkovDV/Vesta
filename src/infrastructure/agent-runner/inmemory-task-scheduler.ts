/**
 * In-Memory Task Scheduler
 * Infrastructure layer implementation with priority-based scheduling.
 * Layer: Infrastructure
 *
 * Provides priority queue, backpressure handling, and retry logic.
 */

import { EventEmitter } from 'events';
import {
  ITaskScheduler,
  TaskQueueStats,
  TaskFilter,
  ScheduledTask,
  BackpressureSignal,
  TaskSchedulerConfig,
  ITaskRetryPolicy,
  ExponentialBackoffRetryPolicy,
  SchedulerPausedError,
  TaskDequeueTimeoutError,
} from '../../domain/agent-runner/task-scheduler.port';
import {
  AgentTask,
  TaskId,
  TaskPriority,
  TaskResult,
  TaskStatus,
  BackpressureError,
  TaskNotFoundError,
} from '../../domain/agent-runner/agent-runner.port';

/**
 * Priority queue entry
 */
interface PriorityQueueEntry {
  task: AgentTask;
  priority: number;
  queuedAt: Date;
}

/**
 * In-memory task scheduler implementation
 */
export class InMemoryTaskScheduler extends EventEmitter implements ITaskScheduler {
  private queue: PriorityQueueEntry[] = [];
  private runningTasks = new Map<TaskId, ScheduledTask>();
  private completedTasks = new Map<TaskId, ScheduledTask>();
  private isPaused = false;
  private isInitialized = false;
  private retryPolicy: ITaskRetryPolicy;
  private stats = {
    totalCompleted: 0,
    totalFailed: 0,
    totalWaitTimeMs: 0,
    totalExecutionTimeMs: 0,
  };

  constructor(private config: TaskSchedulerConfig) {
    super();
    this.retryPolicy = new ExponentialBackoffRetryPolicy();
  }

  /**
   * Initialize the scheduler
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) {
      return;
    }
    this.isInitialized = true;
    this.emit('initialized');
  }

  /**
   * Shutdown the scheduler gracefully
   */
  async shutdown(): Promise<void> {
    this.isInitialized = false;
    
    // Cancel all pending tasks
    for (const entry of this.queue) {
      this.emit('taskCancelled', { taskId: entry.task.id });
    }
    this.queue = [];

    // Wait for running tasks to complete (with timeout)
    const runningCount = this.runningTasks.size;
    if (runningCount > 0) {
      this.emit('waitingForTasks', { count: runningCount });
      await this.waitForRunningTasks(5000);
    }

    this.emit('shutdown');
  }

  /**
   * Schedule a task for execution
   */
  async schedule(task: AgentTask): Promise<TaskId> {
    this.ensureInitialized();

    if (this.isPaused) {
      throw new SchedulerPausedError();
    }

    // Check backpressure
    if (!this.canAcceptTask()) {
      throw new BackpressureError(
        'Task queue is at capacity',
        this.queue.length,
        this.config.maxQueueSize,
      );
    }

    const priority = this.calculatePriority(task);
    const entry: PriorityQueueEntry = {
      task,
      priority,
      queuedAt: new Date(),
    };

    // Insert in priority order (higher priority first)
    const insertIndex = this.queue.findIndex(e => e.priority < priority);
    if (insertIndex === -1) {
      this.queue.push(entry);
    } else {
      this.queue.splice(insertIndex, 0, entry);
    }

    this.emit('taskScheduled', { taskId: task.id, priority: task.priority });
    
    return task.id;
  }

  /**
   * Cancel a scheduled or running task
   */
  async cancel(taskId: TaskId): Promise<boolean> {
    // Remove from queue if pending
    const queueIndex = this.queue.findIndex(e => e.task.id === taskId);
    if (queueIndex !== -1) {
      this.queue.splice(queueIndex, 1);
      this.emit('taskCancelled', { taskId });
      return true;
    }

    // Cancel if running
    const runningTask = this.runningTasks.get(taskId);
    if (runningTask) {
      runningTask.status = 'CANCELLED';
      this.runningTasks.delete(taskId);
      this.completedTasks.set(taskId, runningTask);
      this.emit('taskCancelled', { taskId });
      return true;
    }

    return false;
  }

  /**
   * Get the next task for execution
   */
  async dequeue(workerId: string, timeoutMs: number = 5000): Promise<AgentTask | null> {
    this.ensureInitialized();

    const startTime = Date.now();
    
    while (Date.now() - startTime < timeoutMs) {
      if (this.isPaused) {
        await this.sleep(100);
        continue;
      }

      const entry = this.queue.shift();
      if (entry) {
        const waitTime = Date.now() - entry.queuedAt.getTime();
        this.stats.totalWaitTimeMs += waitTime;

        const scheduledTask: ScheduledTask = {
          task: entry.task,
          status: 'RUNNING',
          queuedAt: entry.queuedAt,
          startedAt: new Date(),
          workerId,
          retryCount: 0,
        };

        this.runningTasks.set(entry.task.id, scheduledTask);
        this.emit('taskStarted', { taskId: entry.task.id, workerId });

        return entry.task;
      }

      // Wait a bit before trying again
      await this.sleep(100);
    }

    throw new TaskDequeueTimeoutError(timeoutMs);
  }

  /**
   * Mark task as completed
   */
  async complete(taskId: TaskId, result: TaskResult): Promise<void> {
    const task = this.runningTasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    task.status = 'COMPLETED';
    task.completedAt = new Date();
    
    const executionTime = result.executionTimeMs;
    this.stats.totalCompleted++;
    this.stats.totalExecutionTimeMs += executionTime;

    this.runningTasks.delete(taskId);
    this.completedTasks.set(taskId, task);

    this.emit('taskCompleted', { taskId, executionTimeMs: executionTime });
  }

  /**
   * Mark task as failed
   */
  async fail(taskId: TaskId, error: Error, retryable: boolean): Promise<void> {
    const task = this.runningTasks.get(taskId);
    if (!task) {
      throw new TaskNotFoundError(taskId);
    }

    this.runningTasks.delete(taskId);

    if (retryable && this.retryPolicy.shouldRetry(task.retryCount + 1, error)) {
      // Retry the task
      task.retryCount++;
      task.error = error.message;
      
      const delay = this.retryPolicy.getRetryDelay(task.retryCount);
      
      this.emit('taskRetrying', { 
        taskId, 
        attempt: task.retryCount, 
        delayMs: delay,
      });

      setTimeout(() => {
        task.status = 'PENDING';
        task.startedAt = undefined;
        task.workerId = undefined;
        task.error = undefined;
        
        const priority = this.calculatePriority(task.task);
        const entry: PriorityQueueEntry = {
          task: task.task,
          priority: priority - task.retryCount, // Lower priority for retries
          queuedAt: new Date(),
        };
        
        this.queue.push(entry);
      }, delay);
    } else {
      // Mark as failed
      task.status = 'FAILED';
      task.completedAt = new Date();
      task.error = error.message;
      this.stats.totalFailed++;
      
      this.completedTasks.set(taskId, task);
      this.emit('taskFailed', { taskId, error: error.message });
    }
  }

  /**
   * Acknowledge task processing
   */
  async acknowledge(taskId: TaskId, status: TaskStatus): Promise<void> {
    // In-memory scheduler doesn't need explicit acknowledgement
    this.emit('taskAcknowledged', { taskId, status });
  }

  /**
   * Get current queue statistics
   */
  getStats(): TaskQueueStats {
    const byPriority: Record<TaskPriority, number> = {
      LOW: 0,
      NORMAL: 0,
      HIGH: 0,
      CRITICAL: 0,
    };

    for (const entry of this.queue) {
      byPriority[entry.task.priority]++;
    }

    const avgWaitTime = this.queue.length > 0
      ? this.stats.totalWaitTimeMs / (this.stats.totalCompleted + this.stats.totalFailed || 1)
      : 0;

    const avgExecutionTime = this.stats.totalCompleted > 0
      ? this.stats.totalExecutionTimeMs / this.stats.totalCompleted
      : 0;

    return {
      totalQueued: this.queue.length,
      totalRunning: this.runningTasks.size,
      totalCompleted: this.stats.totalCompleted,
      totalFailed: this.stats.totalFailed,
      byPriority,
      averageWaitTimeMs: avgWaitTime,
      averageExecutionTimeMs: avgExecutionTime,
    };
  }

  /**
   * Get task details
   */
  async getTask(taskId: TaskId): Promise<ScheduledTask | undefined> {
    // Check queue
    const queued = this.queue.find(e => e.task.id === taskId);
    if (queued) {
      return {
        task: queued.task,
        status: 'QUEUED',
        queuedAt: queued.queuedAt,
        retryCount: 0,
      };
    }

    // Check running
    const running = this.runningTasks.get(taskId);
    if (running) return running;

    // Check completed
    const completed = this.completedTasks.get(taskId);
    if (completed) return completed;

    return undefined;
  }

  /**
   * List tasks matching filter
   */
  async listTasks(filter?: TaskFilter, limit: number = 100): Promise<ScheduledTask[]> {
    const results: ScheduledTask[] = [];

    // Add queued tasks
    for (const entry of this.queue) {
      if (this.matchesFilter(entry.task, 'QUEUED', filter)) {
        results.push({
          task: entry.task,
          status: 'QUEUED',
          queuedAt: entry.queuedAt,
          retryCount: 0,
        });
      }
    }

    // Add running tasks
    for (const task of this.runningTasks.values()) {
      if (this.matchesFilter(task.task, 'RUNNING', filter)) {
        results.push(task);
      }
    }

    // Add completed tasks (limited)
    for (const task of this.completedTasks.values()) {
      if (this.matchesFilter(task.task, task.status, filter)) {
        results.push(task);
      }
    }

    return results.slice(0, limit);
  }

  /**
   * Get current backpressure status
   */
  getBackpressureStatus(): BackpressureSignal {
    const queueUtilization = this.queue.length / this.config.maxQueueSize;
    
    let recommendedAction: 'accept' | 'throttle' | 'reject';
    if (queueUtilization >= this.config.backpressureThresholds.rejection) {
      recommendedAction = 'reject';
    } else if (queueUtilization >= this.config.backpressureThresholds.critical) {
      recommendedAction = 'throttle';
    } else {
      recommendedAction = 'accept';
    }

    return {
      isActive: queueUtilization >= this.config.backpressureThresholds.warning,
      queueUtilization,
      rejectionRate: this.stats.totalFailed / (this.stats.totalCompleted + this.stats.totalFailed || 1),
      recommendedAction,
    };
  }

  /**
   * Check if scheduler can accept new tasks
   */
  canAcceptTask(): boolean {
    if (this.isPaused) return false;
    
    const utilization = this.queue.length / this.config.maxQueueSize;
    return utilization < this.config.backpressureThresholds.rejection;
  }

  /**
   * Pause task scheduling
   */
  async pause(): Promise<void> {
    this.isPaused = true;
    this.emit('paused');
  }

  /**
   * Resume task scheduling
   */
  async resume(): Promise<void> {
    this.isPaused = false;
    this.emit('resumed');
  }

  /**
   * Calculate priority score for a task
   */
  private calculatePriority(task: AgentTask): number {
    const weights = this.config.priorityWeights;
    const basePriority = weights[task.priority] || weights.NORMAL;
    
    // Age bonus (older tasks get higher priority)
    const ageMs = Date.now() - task.createdAt.getTime();
    const ageBonus = Math.min(Math.floor(ageMs / 60000), 10); // Max 10 point bonus across 10 full minutes
    
    return basePriority + ageBonus;
  }

  /**
   * Check if task matches filter
   */
  private matchesFilter(
    task: AgentTask,
    status: TaskStatus,
    filter?: TaskFilter,
  ): boolean {
    if (!filter) return true;

    if (filter.status && filter.status !== status) return false;
    if (filter.priority && filter.priority !== task.priority) return false;
    if (filter.agentId && filter.agentId !== task.agentId) return false;
    if (filter.correlationId && filter.correlationId !== task.correlationId) return false;
    if (filter.createdAfter && task.createdAt < filter.createdAfter) return false;
    if (filter.createdBefore && task.createdAt > filter.createdBefore) return false;

    return true;
  }

  /**
   * Wait for running tasks to complete
   */
  private async waitForRunningTasks(timeoutMs: number): Promise<void> {
    const startTime = Date.now();
    while (this.runningTasks.size > 0 && Date.now() - startTime < timeoutMs) {
      await this.sleep(100);
    }
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Ensure scheduler is initialized
   */
  private ensureInitialized(): void {
    if (!this.isInitialized) {
      throw new Error('Task scheduler not initialized');
    }
  }
}

/**
 * Default scheduler configuration
 */
export const DEFAULT_SCHEDULER_CONFIG: TaskSchedulerConfig = {
  maxQueueSize: 1000,
  maxConcurrentTasks: 10,
  defaultTaskTimeoutMs: 30000,
  maxTaskTimeoutMs: 300000,
  priorityWeights: {
    LOW: 1,
    NORMAL: 5,
    HIGH: 10,
    CRITICAL: 20,
  },
  enableBackpressure: true,
  backpressureThresholds: {
    warning: 0.7,
    critical: 0.85,
    rejection: 0.95,
  },
};
