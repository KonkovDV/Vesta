/**
 * IScheduledTaskRunner — Domain port for cron-based recurring task execution.
 *
 * CC-016 Scheduled Task Runner: enables agents to schedule recurring prompts
 * on a cron-like schedule (up to 3 days), set one-time reminders, and poll
 * external systems (deployments, PRs, builds) at regular intervals.
 *
 * Distinct from CC-009 (IAutonomousExecutionLoop): CC-009 handles bounded
 * iterative execution within a single task, while CC-016 manages a SCHEDULER
 * for recurring tasks over extended time periods with cron semantics.
 *
 * SOTA 2026 Basis: Claude Code v2.1.71 `/loop` command enables cron-tool
 * scheduling for recurring monitoring — deployment polling, PR babysitting,
 * build checks — running autonomously for up to 3 days.
 *
 * Sub-capabilities:
 *   1. Schedule Management — register/cancel/list recurring schedules
 *   2. Execution Tracking — track each invocation with status/output
 *   3. Duration Bounds — max lifetime per schedule (default: 3 days)
 *   4. One-Shot Reminders — deferred single-execution tasks
 *   5. Disable Control — global kill switch via env var
 *
 * @layer Domain (Agents)
 * @pattern CC-016 Scheduled Task Runner (FITNESS-K: 74)
 * @see src/domain/agents/IAutonomousExecutionLoop.ts — bounded iterative execution (CC-009)
 * @see src/domain/agents/ISharedTaskList.ts — cross-agent task coordination (CC-013)
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Schedule Types ─────────────────────────────────────────────────

/**
 * Cron-like schedule expression.
 * Supports standard 5-field cron syntax or human-readable intervals.
 */
export type ScheduleExpression =
  | { readonly type: 'cron'; readonly expression: string }
  | { readonly type: 'interval'; readonly intervalMs: number }
  | { readonly type: 'once'; readonly executeAt: string };

/**
 * Current status of a scheduled task.
 */
export type ScheduledTaskStatus =
  | 'active'
  | 'paused'
  | 'completed'
  | 'cancelled'
  | 'expired';

/**
 * Reason a scheduled task was terminated.
 */
export type ScheduleTerminationReason =
  | 'completed'
  | 'cancelled'
  | 'max_lifetime_exceeded'
  | 'max_executions_reached'
  | 'error'
  | 'disabled_globally';

// ── Schedule Definition ────────────────────────────────────────────

/**
 * Definition of a scheduled recurring task.
 */
export interface ScheduledTaskDefinition {
  /** Unique schedule identifier. */
  readonly scheduleId: string;
  /** Human-readable description of the scheduled task. */
  readonly description: string;
  /** The prompt/instruction to execute on each tick. */
  readonly prompt: string;
  /** Agent ID responsible for execution. */
  readonly agentId: string;
  /** When/how often to execute. */
  readonly schedule: ScheduleExpression;
  /** Maximum lifetime of this schedule in milliseconds (default: 3 days). */
  readonly maxLifetimeMs: number;
  /** Maximum number of executions before auto-completion. */
  readonly maxExecutions?: number;
  /** ISO timestamp when the schedule was created. */
  readonly createdAt: string;
}

// ── Execution Record ───────────────────────────────────────────────

/**
 * Record of a single scheduled execution tick.
 */
export interface ScheduledExecutionRecord {
  /** Unique execution identifier. */
  readonly executionId: string;
  /** Parent schedule ID. */
  readonly scheduleId: string;
  /** 0-based execution index within this schedule. */
  readonly executionIndex: number;
  /** ISO timestamp when execution started. */
  readonly startedAt: string;
  /** ISO timestamp when execution completed. */
  readonly completedAt?: string;
  /** Whether this execution was successful. */
  readonly success: boolean;
  /** Output/result from this execution. */
  readonly output?: unknown;
  /** Error message if execution failed. */
  readonly error?: string;
}

// ── Schedule Result ────────────────────────────────────────────────

/**
 * Summary result of a schedule's lifecycle.
 */
export interface ScheduleLifecycleResult {
  /** Schedule ID. */
  readonly scheduleId: string;
  /** Why the schedule ended. */
  readonly terminationReason: ScheduleTerminationReason;
  /** Total executions performed. */
  readonly totalExecutions: number;
  /** Total lifetime in milliseconds. */
  readonly totalLifetimeMs: number;
  /** Count of successful executions. */
  readonly successCount: number;
  /** Count of failed executions. */
  readonly failureCount: number;
  /** All execution records (for audit/replay). */
  readonly executions: ReadonlyArray<ScheduledExecutionRecord>;
}

// ── Schedule Status Snapshot ───────────────────────────────────────

/**
 * Current status snapshot of an active schedule.
 */
export interface ScheduleStatusSnapshot {
  /** Schedule ID. */
  readonly scheduleId: string;
  /** Current status. */
  readonly status: ScheduledTaskStatus;
  /** Total executions so far. */
  readonly executionCount: number;
  /** Elapsed time since schedule creation (ms). */
  readonly elapsedMs: number;
  /** Remaining lifetime (ms). */
  readonly remainingMs: number;
  /** Next scheduled execution (ISO timestamp), if applicable. */
  readonly nextExecutionAt?: string;
  /** Last execution record, if any. */
  readonly lastExecution?: ScheduledExecutionRecord;
}

// ── Domain Port ────────────────────────────────────────────────────

/** Maximum schedule lifetime: 3 days in milliseconds. */
export const MAX_SCHEDULE_LIFETIME_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * Domain port for scheduled recurring task execution.
 *
 * Manages cron-like schedules that run agent prompts at regular intervals
 * or at specific times. Each schedule has a bounded lifetime (max 3 days)
 * and produces an audit trail of execution records.
 *
 * @pattern CC-016 Scheduled Task Runner — cron-based long-running agent scheduling
 */
/** @experimental — no production consumer. Registered only when ENABLE_EXPERIMENTAL_PORTS=true. */
export interface IScheduledTaskRunner {
  /**
   * Register a new scheduled task.
   * @param definition - Schedule definition with cron/interval/once expression.
   * @param correlationId - Request correlation for tracing.
   * @returns The schedule ID of the registered task.
   */
  schedule(
    definition: ScheduledTaskDefinition,
    correlationId: CorrelationId,
  ): Promise<string>;

  /**
   * Cancel an active schedule.
   * @param scheduleId - Schedule to cancel.
   * @param correlationId - Request correlation for tracing.
   * @returns Lifecycle result if the schedule existed, undefined if not found.
   */
  cancel(
    scheduleId: string,
    correlationId: CorrelationId,
  ): Promise<ScheduleLifecycleResult | undefined>;

  /**
   * Get current status of a schedule.
   * @param scheduleId - Schedule to query.
   * @returns Status snapshot or undefined if not found.
   */
  getStatus(scheduleId: string): ScheduleStatusSnapshot | undefined;

  /**
   * List all active schedules for an agent.
   * @param agentId - Agent whose schedules to list.
   * @returns Array of status snapshots.
   */
  listByAgent(agentId: string): ReadonlyArray<ScheduleStatusSnapshot>;

  /**
   * List all active schedules across all agents.
   * @returns Array of status snapshots.
   */
  listAll(): ReadonlyArray<ScheduleStatusSnapshot>;
}
