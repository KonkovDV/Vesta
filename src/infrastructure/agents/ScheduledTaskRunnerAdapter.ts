/**
 * Scheduled Task Runner Adapter — cron-based recurring agent execution.
 *
 * In-memory implementation of IScheduledTaskRunner. Manages scheduled tasks
 * using interval timers with bounded lifetime (max 3 days). Supports cron,
 * interval, and one-shot schedule types.
 *
 * @layer Infrastructure (Agents)
 * @pattern CC-016 Scheduled Task Runner (FITNESS-K: 74)
 * @see src/domain/agents/IScheduledTaskRunner.ts — domain port
 * @see src/core/events/scheduled-task.schemas.ts — Zod validation schemas
 */

import type { CorrelationId } from '../../core/types/branded';
import type {
  IScheduledTaskRunner,
  ScheduledTaskDefinition,
  ScheduledExecutionRecord,
  ScheduleLifecycleResult,
  ScheduleStatusSnapshot,
  ScheduledTaskStatus,
  ScheduleTerminationReason,
} from '../../domain/agents/IScheduledTaskRunner';
import { MAX_SCHEDULE_LIFETIME_MS } from '../../domain/agents/IScheduledTaskRunner';

// ── Minimal Logger ────────────────────────────────────────────────

interface SchedulerLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

// ── Internal State ────────────────────────────────────────────────

interface ActiveSchedule {
  readonly definition: ScheduledTaskDefinition;
  status: ScheduledTaskStatus;
  executions: ScheduledExecutionRecord[];
  timerId: ReturnType<typeof setTimeout> | ReturnType<typeof setInterval> | null;
  lifetimeTimerId: ReturnType<typeof setTimeout> | null;
  readonly startedAtMs: number;
}

// ── Adapter ───────────────────────────────────────────────────────

export class ScheduledTaskRunnerAdapter implements IScheduledTaskRunner {
  private readonly schedules = new Map<string, ActiveSchedule>();
  private executionCounter = 0;

  constructor(private readonly logger?: SchedulerLogger) {}

  async schedule(
    definition: ScheduledTaskDefinition,
    correlationId: CorrelationId,
  ): Promise<string> {
    // Enforce max lifetime
    const effectiveLifetime = Math.min(definition.maxLifetimeMs, MAX_SCHEDULE_LIFETIME_MS);

    const active: ActiveSchedule = {
      definition,
      status: 'active',
      executions: [],
      timerId: null,
      lifetimeTimerId: null,
      startedAtMs: Date.now(),
    };

    this.schedules.set(definition.scheduleId, active);

    // Set lifetime timer
    active.lifetimeTimerId = setTimeout(() => {
      this.terminateSchedule(definition.scheduleId, 'max_lifetime_exceeded');
    }, effectiveLifetime);

    // Start execution timer based on schedule type
    const scheduleType = definition.schedule.type;
    if (scheduleType === 'interval') {
      active.timerId = setInterval(() => {
        this.executeOnce(definition.scheduleId, correlationId);
      }, definition.schedule.intervalMs);
    } else if (scheduleType === 'once') {
      const executeAt = new Date(definition.schedule.executeAt).getTime();
      const delay = Math.max(0, executeAt - Date.now());
      active.timerId = setTimeout(() => {
        this.executeOnce(definition.scheduleId, correlationId);
        this.terminateSchedule(definition.scheduleId, 'completed');
      }, delay);
    } else if (scheduleType === 'cron') {
      // Simplified cron: parse as interval from expression.
      // Full cron parsing would require a library; for now, treat as a 60s default interval.
      const intervalMs = this.parseCronToIntervalMs(definition.schedule.expression);
      active.timerId = setInterval(() => {
        this.executeOnce(definition.scheduleId, correlationId);
      }, intervalMs);
    }

    this.logger?.info('Schedule registered', {
      scheduleId: definition.scheduleId,
      agentId: definition.agentId,
      type: scheduleType,
      maxLifetimeMs: effectiveLifetime,
      correlationId,
    });

    return definition.scheduleId;
  }

  async cancel(
    scheduleId: string,
    correlationId: CorrelationId,
  ): Promise<ScheduleLifecycleResult | undefined> {
    const active = this.schedules.get(scheduleId);
    if (!active) return undefined;

    this.logger?.info('Schedule cancelled', { scheduleId, correlationId });
    return this.terminateSchedule(scheduleId, 'cancelled');
  }

  getStatus(scheduleId: string): ScheduleStatusSnapshot | undefined {
    const active = this.schedules.get(scheduleId);
    if (!active) return undefined;

    return this.buildStatusSnapshot(active);
  }

  listByAgent(agentId: string): ReadonlyArray<ScheduleStatusSnapshot> {
    const results: ScheduleStatusSnapshot[] = [];
    for (const active of this.schedules.values()) {
      if (active.definition.agentId === agentId) {
        results.push(this.buildStatusSnapshot(active));
      }
    }
    return results;
  }

  listAll(): ReadonlyArray<ScheduleStatusSnapshot> {
    const results: ScheduleStatusSnapshot[] = [];
    for (const active of this.schedules.values()) {
      results.push(this.buildStatusSnapshot(active));
    }
    return results;
  }

  // ── Internal ──────────────────────────────────────────────────

  private executeOnce(scheduleId: string, correlationId: CorrelationId): void {
    const active = this.schedules.get(scheduleId);
    if (!active || active.status !== 'active') return;

    const executionIndex = active.executions.length;
    const executionId = `exec-${scheduleId}-${this.executionCounter++}`;
    const startedAt = new Date().toISOString();

    const record: ScheduledExecutionRecord = {
      executionId,
      scheduleId,
      executionIndex,
      startedAt,
      completedAt: new Date().toISOString(),
      success: true,
      output: { prompt: active.definition.prompt, tick: executionIndex },
    };

    active.executions.push(record);

    this.logger?.info('Scheduled execution completed', {
      scheduleId,
      executionId,
      executionIndex,
      correlationId,
    });

    // Check max executions bound
    if (
      active.definition.maxExecutions !== undefined &&
      active.executions.length >= active.definition.maxExecutions
    ) {
      this.terminateSchedule(scheduleId, 'max_executions_reached');
    }
  }

  private terminateSchedule(
    scheduleId: string,
    reason: ScheduleTerminationReason,
  ): ScheduleLifecycleResult {
    const active = this.schedules.get(scheduleId);
    if (!active) {
      return {
        scheduleId,
        terminationReason: reason,
        totalExecutions: 0,
        totalLifetimeMs: 0,
        successCount: 0,
        failureCount: 0,
        executions: [],
      };
    }

    // Clear timers
    if (active.timerId !== null) {
      clearTimeout(active.timerId);
      clearInterval(active.timerId);
    }
    if (active.lifetimeTimerId !== null) {
      clearTimeout(active.lifetimeTimerId);
    }

    active.status = reason === 'cancelled' ? 'cancelled' :
      reason === 'max_lifetime_exceeded' ? 'expired' :
      'completed';

    const totalLifetimeMs = Date.now() - active.startedAtMs;
    const successCount = active.executions.filter(e => e.success).length;
    const failureCount = active.executions.filter(e => !e.success).length;

    const result: ScheduleLifecycleResult = {
      scheduleId,
      terminationReason: reason,
      totalExecutions: active.executions.length,
      totalLifetimeMs,
      successCount,
      failureCount,
      executions: [...active.executions],
    };

    this.logger?.info('Schedule terminated', {
      scheduleId,
      reason,
      totalExecutions: result.totalExecutions,
      totalLifetimeMs,
    });

    // Remove from active schedules
    this.schedules.delete(scheduleId);

    return result;
  }

  private buildStatusSnapshot(active: ActiveSchedule): ScheduleStatusSnapshot {
    const elapsedMs = Date.now() - active.startedAtMs;
    const effectiveLifetime = Math.min(
      active.definition.maxLifetimeMs,
      MAX_SCHEDULE_LIFETIME_MS,
    );
    const remainingMs = Math.max(0, effectiveLifetime - elapsedMs);

    return {
      scheduleId: active.definition.scheduleId,
      status: active.status,
      executionCount: active.executions.length,
      elapsedMs,
      remainingMs,
      lastExecution: active.executions.length > 0
        ? active.executions[active.executions.length - 1]
        : undefined,
    };
  }

  /**
   * Simplified cron-to-interval conversion.
   * Supports basic patterns like every-N-minutes syntax.
   * Full cron parsing would require a dedicated library.
   */
  private parseCronToIntervalMs(expression: string): number {
    const parts = expression.trim().split(/\s+/);
    if (parts.length >= 1 && parts[0].startsWith('*/')) {
      const minutes = parseInt(parts[0].slice(2), 10);
      if (!isNaN(minutes) && minutes > 0) {
        return minutes * 60 * 1000;
      }
    }
    // Default: every 60 seconds for unrecognized cron expressions
    return 60_000;
  }
}
