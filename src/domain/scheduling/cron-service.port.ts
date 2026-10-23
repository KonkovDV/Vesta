/**
 * Cron Service Domain Port
 *
 * Defines the contract for persistent cron job scheduling with support
 * for cron expressions, interval-based, and one-shot scheduling.
 *
 * @layer Domain
 * @phase 12 — Cron Scheduling Engine (OpenClaw extraction)
 * @donor external/openclaw/src/cron/types.ts (126L) — adapted to DI + Clean Architecture
 * @see PLANS/04_BACKLOG/OPENCLAW_EXTRACTION_PLAN_V1.md — Phase 12
 */

import { EntityNotFoundError, ValidationError, InfrastructureError } from '../errors/DomainError';

// ─── Error Types ─────────────────────────────────────────────────────────────

export class CronJobNotFoundError extends EntityNotFoundError {
  constructor(jobId: string, options?: { correlationId?: string }) {
    super('CronJob', jobId, { correlationId: options?.correlationId });
  }
}

export class CronScheduleValidationError extends ValidationError {
  constructor(message: string, options?: { correlationId?: string }) {
    super(`Cron schedule validation: ${message}`, [{ field: 'schedule', message }], {
      correlationId: options?.correlationId,
    });
  }
}

export class CronJobExecutionError extends InfrastructureError {
  constructor(
    jobId: string,
    message: string,
    options?: { correlationId?: string; cause?: Error },
  ) {
    super(`Cron job ${jobId} execution failed: ${message}`, {
      correlationId: options?.correlationId,
      metadata: { jobId },
      cause: options?.cause,
    });
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

/**
 * Three kinds of schedules supported.
 */
export type CronSchedule =
  | { readonly kind: 'at'; readonly at: string }
  | { readonly kind: 'every'; readonly everyMs: number }
  | { readonly kind: 'cron'; readonly expr: string; readonly tz?: string; readonly staggerMs?: number };

/**
 * Cron job state machine.
 */
export type CronJobState = 'active' | 'paused' | 'completed' | 'failed';

/**
 * Persistent cron job entity.
 */
export interface CronJob {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly schedule: CronSchedule;
  readonly handler: string;
  readonly payload: Record<string, unknown>;
  readonly state: CronJobState;
  readonly priority: number;
  readonly maxRuns?: number;
  readonly runCount: number;
  readonly lastRunAt?: Date;
  readonly nextRunAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Input for creating a new cron job.
 */
export interface CreateCronJobInput {
  readonly tenantId: string;
  readonly name: string;
  readonly schedule: CronSchedule;
  readonly handler: string;
  readonly payload?: Record<string, unknown>;
  readonly priority?: number;
  readonly maxRuns?: number;
}

/**
 * Input for updating an existing cron job.
 */
export interface UpdateCronJobInput {
  readonly schedule?: CronSchedule;
  readonly handler?: string;
  readonly payload?: Record<string, unknown>;
  readonly state?: CronJobState;
  readonly priority?: number;
  readonly maxRuns?: number;
}

/**
 * Cron run log entry.
 */
export interface CronRunLogEntry {
  readonly id: string;
  readonly jobId: string;
  readonly startedAt: Date;
  readonly finishedAt?: Date;
  readonly status: 'running' | 'completed' | 'failed' | 'timeout';
  readonly durationMs?: number;
  readonly error?: string;
  readonly result?: Record<string, unknown>;
}

/**
 * Filter for listing cron jobs.
 */
export interface CronJobFilter {
  readonly tenantId?: string;
  readonly state?: CronJobState;
  readonly handler?: string;
  readonly limit?: number;
  readonly offset?: number;
}

// ─── Port Interfaces ─────────────────────────────────────────────────────────

/**
 * Domain port for cron job service operations.
 */
export interface ICronService {
  /** Create a new cron job */
  create(input: CreateCronJobInput): Promise<CronJob>;

  /** Update an existing cron job */
  update(jobId: string, input: UpdateCronJobInput): Promise<CronJob>;

  /** Delete a cron job */
  delete(jobId: string): Promise<void>;

  /** Get a cron job by ID */
  getById(jobId: string): Promise<CronJob>;

  /** List cron jobs with filtering */
  list(filter?: CronJobFilter): Promise<{ jobs: CronJob[]; total: number }>;

  /** Pause a cron job */
  pause(jobId: string): Promise<CronJob>;

  /** Resume a paused cron job */
  resume(jobId: string): Promise<CronJob>;

  /** Run a cron job immediately (out of schedule) */
  runNow(jobId: string): Promise<CronRunLogEntry>;

  /** Get run log for a job */
  getRunLog(jobId: string, limit?: number): Promise<CronRunLogEntry[]>;

  /** Get service health */
  getHealth(): { status: 'healthy' | 'degraded' | 'unhealthy'; activeJobs: number; failedJobs: number; nextRunAt?: Date };
}

/**
 * Domain port for cron job persistence.
 */
export interface ICronJobRepository {
  /** Save a new cron job */
  save(job: CronJob): Promise<CronJob>;

  /** Find a job by ID */
  findById(jobId: string): Promise<CronJob | null>;

  /** Find jobs matching filter */
  find(filter: CronJobFilter): Promise<{ jobs: CronJob[]; total: number }>;

  /** Update a job */
  update(jobId: string, updates: Partial<CronJob>): Promise<CronJob>;

  /** Delete a job */
  delete(jobId: string): Promise<void>;

  /** Find pending jobs (due for execution, ordered by next_run_at) */
  findPending(limit: number): Promise<CronJob[]>;

  /** Claim a job for execution (SELECT ... FOR UPDATE SKIP LOCKED) */
  claimJob(jobId: string): Promise<CronJob | null>;

  /** Log a run entry */
  logRun(entry: CronRunLogEntry): Promise<void>;

  /** Get run log entries for a job */
  getRunLog(jobId: string, limit: number): Promise<CronRunLogEntry[]>;

  /** Find by tenant and name (unique constraint) */
  findByTenantAndName(tenantId: string, name: string): Promise<CronJob | null>;
}

// ─── CronTimerManager Port (CRIT-3 fix: decouple Application from Infrastructure) ──

/**
 * Domain port for cron timer lifecycle management.
 * Application layer depends on this interface, Infrastructure provides implementation.
 */
export interface ICronTimerManager {
  /** Start polling / arming timers */
  start(): void;

  /** Graceful shutdown: drain running jobs, disarm timers */
  drain(timeoutMs?: number): Promise<void>;

  /** Execute a job immediately (out of schedule) */
  runJobNow(job: CronJob): Promise<CronRunLogEntry>;

  /** Get timer subsystem health */
  getHealth(): {
    activeTimers: number;
    runningJobs: number;
    maxConcurrency: number;
    consecutiveOverruns: Map<string, number>;
    status: 'healthy' | 'degraded' | 'unhealthy';
    nextPollAt?: Date;
  };
}

// ─── Normalizer Functions Port (CRIT-2 fix: pure validation belongs in domain) ──

/**
 * Domain port for cron job input normalization.
 * Pure validation/coercion functions — no infrastructure dependencies.
 */
export interface ICronJobNormalizer {
  normalizeCreateInput(input: CreateCronJobInput): CreateCronJobInput;
  normalizeUpdateInput(input: UpdateCronJobInput): UpdateCronJobInput;
}
