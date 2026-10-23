/**
 * Agent Runner Port
 * Domain layer contract for biological agent execution loop.
 * Layer: Domain
 *
 * Defines the contract for running agents independently of the HTTP request/response cycle.
 * Implementations must use Worker Threads for true parallelism.
 */

import type { CorrelationId } from '../routing/IRoutingContext';

/**
 * Unique identifier for a task
 */
import { z } from 'zod';
import { randomUUID } from 'crypto';

/**
 * Unique identifier for a task
 */
export const TaskIdSchema = z.string().uuid().brand('TaskId');
export type TaskId = z.infer<typeof TaskIdSchema>;

export namespace TaskId {
  /**
   * Generates a new valid TaskId (UUID v4)
   */
  export const create = (): TaskId => TaskIdSchema.parse(randomUUID());
  
  /**
   * Validates and parses an existing string into a TaskId
   * @throws ZodError if invalid
   */
  export const parse = (id: string): TaskId => TaskIdSchema.parse(id);
}

/**
 * Unique identifier for an agent
 */
export const AgentIdSchema = z.string().min(1).brand('AgentId');
export type AgentId = z.infer<typeof AgentIdSchema>;

export namespace AgentId {
  /**
   * Validates and parses a string into an AgentId
   * @throws ZodError if invalid
   */
  export const create = (id: string): AgentId => AgentIdSchema.parse(id);
}

/**
 * Agent runner operational states
 */
export type AgentRunnerState = 
  | 'IDLE' 
  | 'RUNNING' 
  | 'PAUSED' 
  | 'SHUTTING_DOWN' 
  | 'STOPPED' 
  | 'ERROR';

/**
 * Task priority levels
 */
export type TaskPriority = 'LOW' | 'NORMAL' | 'HIGH' | 'CRITICAL';

/**
 * Task status
 */
export type TaskStatus = 
  | 'PENDING' 
  | 'QUEUED' 
  | 'RUNNING' 
  | 'COMPLETED' 
  | 'FAILED' 
  | 'CANCELLED' 
  | 'TIMEOUT';

/**
 * Agent task definition
 */
export interface AgentTask {
  id: TaskId;
  agentId: AgentId;
  type: string;
  payload: unknown;
  priority: TaskPriority;
  correlationId: CorrelationId;
  timeoutMs: number;
  maxAttempts: number;
  createdAt: Date;
  scheduledAt?: Date;
}

/**
 * Task execution result
 */
export interface TaskResult {
  taskId: TaskId;
  status: 'COMPLETED' | 'FAILED' | 'CANCELLED' | 'TIMEOUT';
  output?: unknown;
  error?: TaskError;
  executionTimeMs: number;
  attempts: number;
  completedAt: Date;
}

/**
 * Task error details
 */
export interface TaskError {
  message: string;
  code: string;
  stack?: string;
  details?: Record<string, unknown>;
}

/**
 * Agent runner status snapshot
 */
export interface AgentRunnerStatus {
  state: AgentRunnerState;
  agentId: AgentId;
  queuedTasks: number;
  runningTasks: number;
  completedTasks: number;
  failedTasks: number;
  averageExecutionTimeMs: number;
  isHealthy: boolean;
  lastActivityAt?: Date;
}

/**
 * Resource limits for task execution
 */
export interface TaskResourceLimits {
  maxMemoryMb: number;
  maxCpuPercent: number;
  maxExecutionTimeMs: number;
}

/**
 * Backpressure configuration
 */
export interface BackpressureConfig {
  maxQueueSize: number;
  maxConcurrentTasks: number;
  rejectionThreshold: number;
}

/**
 * Agent runner configuration
 */
export interface AgentRunnerConfig {
  agentId: AgentId;
  resourceLimits: TaskResourceLimits;
  backpressure: BackpressureConfig;
  enablePersistence: boolean;
  gracefulShutdownTimeoutMs: number;
}

/**
 * Task completion event handler
 */
export type TaskCompleteHandler = (result: TaskResult) => void;

/**
 * State change event handler
 */
export type StateChangeHandler = (state: AgentRunnerState) => void;

/**
 * Error event handler
 */
export type AgentRunnerErrorHandler = (error: Error) => void;

/**
 * Core Agent Runner interface
 * Runs in Worker Thread for true parallelism
 */
export interface IAgentRunner {
  /**
   * Start the agent runner loop
   */
  start(): Promise<void>;

  /**
   * Stop the agent runner gracefully
   * Waits for running tasks to complete
   */
  stop(): Promise<void>;

  /**
   * Pause task processing (keep runner alive)
   */
  pause(): Promise<void>;

  /**
   * Resume task processing
   */
  resume(): Promise<void>;

  /**
   * Submit a new task for execution
   * @throws BackpressureError if queue is at capacity
   */
  submitTask(task: AgentTask): Promise<TaskId>;

  /**
   * Cancel a pending or running task
   */
  cancelTask(taskId: TaskId): Promise<boolean>;

  /**
   * Get current runner status
   */
  getStatus(): AgentRunnerStatus;

  /**
   * Get task result (if completed)
   */
  getTaskResult(taskId: TaskId): Promise<TaskResult | undefined>;

  /**
   * Register event handlers
   */
  on(event: 'taskComplete', handler: TaskCompleteHandler): void;
  on(event: 'stateChange', handler: StateChangeHandler): void;
  on(event: 'error', handler: AgentRunnerErrorHandler): void;

  /**
   * Remove event handlers
   */
  off(event: 'taskComplete', handler: TaskCompleteHandler): void;
  off(event: 'stateChange', handler: StateChangeHandler): void;
  off(event: 'error', handler: AgentRunnerErrorHandler): void;
}

/**
 * Error thrown when backpressure prevents task submission
 */
export class BackpressureError extends Error {
  constructor(
    message: string,
    public readonly queueSize: number,
    public readonly maxQueueSize: number,
  ) {
    super(message);
    this.name = 'BackpressureError';
  }
}

/**
 * Error thrown when task is not found
 */
export class TaskNotFoundError extends Error {
  constructor(taskId: TaskId) {
    super(`Task not found: ${taskId}`);
    this.name = 'TaskNotFoundError';
  }
}

/**
 * Error thrown when runner is not in valid state for operation
 */
export class InvalidRunnerStateError extends Error {
  constructor(
    message: string,
    public readonly currentState: AgentRunnerState,
    public readonly requiredStates: AgentRunnerState[],
  ) {
    super(message);
    this.name = 'InvalidRunnerStateError';
  }
}
