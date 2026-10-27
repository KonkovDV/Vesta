/**
 * Postgres-based implementation of MasExecutionStore.
 *
 * Layer: Infrastructure (technical implementation over PostgreSQL + EventStore/Outbox).
 *
 * Responsibilities:
 * - persist MasTaskExecution / MasExecutionStep state in dedicated tables;
 * - expose MasExecutionStore contract for core/application layers;
 * - emit typed durable-execution events via IOutbox / IEventStore (best-effort).
 */

import { Pool, type PoolConfig, type PoolClient } from 'pg';
import { getConfig } from '../../config';
import { buildPgSslConfig } from '../persistence/pg-ssl-config';
import { tryJsonParse } from '../../core/utils/json';
import { mapExecutionErrorToCategory } from '../../domain/mas/services/mas-error-taxonomy';
import { incrementMasErrorsTotal } from '../../monitoring/mas-metrics';
import {
  isValidPostgresIdentifier,
  qualifyIdentifier,
} from '../database/postgres-identifiers';
import { requireQualifiedTables, runtimeDdlEnabled } from '../database/runtime-ddl';
import {
  castToMasTaskStatus,
  castToMasExecutionStatus,
  castToMasExecutionStepKind,
  isMasTaskStatus,
} from '../../domain/mas/guards/mas-type-guards';
import { isNonNullObject } from '../../core/guards/type-guards';
import { logger } from '../logging/logger';

import type { MasExecutionStore } from '../../domain/mas/MasExecutionStore';
import type { MasTaskExecutionInit } from '../../domain/mas/MasTaskExecutionInit';
import type { MasTaskExecution } from '../../domain/mas/MasTaskExecution';
import type { MasExecutionStep } from '../../domain/mas/MasExecutionStep';
import { MasExecutionStepKind } from '../../domain/mas/MasExecutionStepKind';
import type { MasStepStatusUpdate } from '../../domain/mas/MasStepStatusUpdate';
import type { MasExecutionError } from '../../domain/mas/MasExecutionError';
import type { MasRecoveryQuery } from '../../domain/mas/MasRecoveryQuery';
import { attachDurableSloDiagnosticsToError } from '../../domain/mas/mas-diagnostics';
import { MasTaskStatus } from '../../domain/mas/MasTaskStatus';
import { MasExecutionStatus } from '../../domain/mas/MasExecutionStatus';
import type { RequestContextSnapshot } from '../../domain/mas/RequestContextSnapshot';
import type { MasResultRef } from '../../domain/mas/MasResultRef';

import type { DomainEvent, IEventStore } from '../../domain/events/event-store.interface';
import { EventFactory } from '../../domain/events/event-store.interface';
import type { IOutbox } from '../../domain/events/outbox.interface';

import type {
  MasTaskExecutionCreatedEventPayload,
  MasTaskExecutionStartedEventPayload,
  MasTaskExecutionCompletedEventPayload,
  MasTaskExecutionFailedEventPayload,
  MasTaskExecutionCancelledEventPayload,
  MasExecutionStepStartedEventPayload,
  MasExecutionStepCompletedEventPayload,
  MasExecutionStepFailedEventPayload,
  MasExecutionErrorPayload,
} from '../../domain/events/mas/MasTaskExecutionEvents';

interface PostgresMasExecutionStoreConfig {
  connection: PoolConfig;
  schema?: string;
  taskExecutionsTable?: string;
  stepsTable?: string;
}

function getStatementTimeout(connection: PoolConfig): number {
  const candidate = (connection as Record<string, unknown>).statementTimeoutMs;
  return typeof candidate === 'number' && Number.isFinite(candidate) ? candidate : 30000;
}

function toEnvRecord(config: Record<string, unknown>): Record<string, string | undefined> {
  const entries = Object.entries(config).map(([key, value]) => [
    key,
    typeof value === 'string' ? value : undefined,
  ]);
  return Object.fromEntries(entries);
}

const DEFAULT_SCHEMA = 'mas';
const DEFAULT_TASK_EXECUTIONS_TABLE = 'task_executions';
const DEFAULT_STEPS_TABLE = 'execution_steps';

interface TaskExecutionRow {
  task_execution_id: string;
  task_id: string;
  session_id: string;
  status: string;
  current_step_id: string | null;
  attempts: number;
  last_error: unknown | null;
  request_context_snapshot: unknown;
  timeouts: unknown;
  meta: unknown;
  created_at: Date;
  updated_at: Date;
  locked_by: string | null;
  lock_expires_at: Date | null;
  version: number;
}

interface StepRow {
  step_id: string;
  task_execution_id: string;
  step_index: number;
  kind: string;
  status: string;
  attempts: number;
  max_attempts: number | null;
  idempotency_key: string;
  input_snapshot: unknown;
  result_ref: unknown | null;
  error: unknown | null;
  started_at: Date | null;
  completed_at: Date | null;
  last_heartbeat_at: Date | null;
  memory_policy: string | null;
  policy_decision_ref: string | null;
}

export class PostgresMasExecutionStore implements MasExecutionStore {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly taskExecutionsTable: string;
  private readonly stepsTable: string;
  private readonly qualifiedTaskExecutionsTable: string;
  private readonly qualifiedStepsTable: string;

  constructor(
    private readonly cfg: PostgresMasExecutionStoreConfig,
    private readonly eventStore?: IEventStore,
    private readonly outbox?: IOutbox,
  ) {
    this.schema = cfg.schema || DEFAULT_SCHEMA;
    this.taskExecutionsTable =
      cfg.taskExecutionsTable || DEFAULT_TASK_EXECUTIONS_TABLE;
    this.stepsTable = cfg.stepsTable || DEFAULT_STEPS_TABLE;

    if (!isValidPostgresIdentifier(this.schema)) {
      throw new Error(
        `Invalid PostgreSQL MAS schema name: "${this.schema}"`,
      );
    }
    if (!isValidPostgresIdentifier(this.taskExecutionsTable)) {
      throw new Error(
        `Invalid PostgreSQL MAS task_executions table name: "${this.taskExecutionsTable}"`,
      );
    }
    if (!isValidPostgresIdentifier(this.stepsTable)) {
      throw new Error(
        `Invalid PostgreSQL MAS execution_steps table name: "${this.stepsTable}"`,
      );
    }

    this.qualifiedTaskExecutionsTable = qualifyIdentifier(
      this.schema,
      this.taskExecutionsTable,
      'PostgresMasExecutionStore.task_executions',
    );
    this.qualifiedStepsTable = qualifyIdentifier(
      this.schema,
      this.stepsTable,
      'PostgresMasExecutionStore.execution_steps',
    );

    this.pool = new Pool({
      ...cfg.connection,
      keepAlive: cfg.connection.keepAlive ?? true,
      keepAliveInitialDelayMillis: cfg.connection.keepAliveInitialDelayMillis ?? 10000,
      statement_timeout: getStatementTimeout(cfg.connection),
    });
    this.pool.on('error', err => {
       
      logger.error('PostgresMasExecutionStore connection error', { error: err.message });
    });
  }

  /**
   * Executes an operation with retry logic for optimistic lock failures.
   * Implements exponential backoff for concurrent access scenarios.
   */
  private async executeWithOptimisticLockRetry<T>(
    operation: () => Promise<T>,
    maxRetries: number = 3,
    baseDelayMs: number = 10,
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        
        // Check if this is an optimistic lock failure
        if (lastError.message.includes('optimistic lock failed')) {
          if (attempt < maxRetries - 1) {
            // Exponential backoff: 10ms, 20ms, 40ms
            const delay = baseDelayMs * Math.pow(2, attempt);
            await new Promise(resolve => setTimeout(resolve, delay));
            continue;
          }
        }
        
        // Not an optimistic lock error or exhausted retries
        throw lastError;
      }
    }

    throw lastError ?? new Error('Unexpected retry exhaustion');
  }

  /**
   * Optional initialization helper to create schema/tables if they do not exist.
   *
   * NOTE:
   * - Not part of MasExecutionStore interface; called explicitly from bootstrap
   *   when needed.
   */
  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      if (!runtimeDdlEnabled()) {
        await requireQualifiedTables(
          (sql, params) => client.query(sql, params),
          [
            `${this.schema}.${this.taskExecutionsTable}`,
            `${this.schema}.${this.stepsTable}`,
            `${this.schema}.event_outbox`,
          ],
        );
        return;
      }
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.${this.taskExecutionsTable} (
          task_execution_id VARCHAR(255) PRIMARY KEY,
          task_id VARCHAR(255) NOT NULL,
          session_id VARCHAR(255) NOT NULL,
          status VARCHAR(32) NOT NULL,
          current_step_id VARCHAR(255),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error JSONB,
          request_context_snapshot JSONB NOT NULL,
          timeouts JSONB NOT NULL,
          meta JSONB NOT NULL,
          created_at TIMESTAMP NOT NULL,
          updated_at TIMESTAMP NOT NULL,
          locked_by VARCHAR(255),
          lock_expires_at TIMESTAMP,
          version INTEGER NOT NULL DEFAULT 1
        );
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.${this.stepsTable} (
          step_id VARCHAR(255) PRIMARY KEY,
          task_execution_id VARCHAR(255) NOT NULL REFERENCES ${this.schema}.${this.taskExecutionsTable}(task_execution_id) ON DELETE CASCADE,
          step_index INTEGER NOT NULL,
          kind VARCHAR(32) NOT NULL,
          status VARCHAR(32) NOT NULL,
          attempts INTEGER NOT NULL,
          max_attempts INTEGER,
          idempotency_key VARCHAR(255) NOT NULL,
          input_snapshot JSONB NOT NULL,
          result_ref JSONB,
          error JSONB,
          started_at TIMESTAMP,
          completed_at TIMESTAMP,
          last_heartbeat_at TIMESTAMP,
          memory_policy VARCHAR(32),
          policy_decision_ref VARCHAR(255)
        );
      `);
      // Add UNIQUE constraints for idempotency and ordering guarantees
      // Use safe IF NOT EXISTS pattern to avoid deadlocks during concurrent initialization
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'uk_mas_step_task_index'
          ) THEN
            ALTER TABLE ${this.schema}.${this.stepsTable}
            ADD CONSTRAINT uk_mas_step_task_index UNIQUE (task_execution_id, step_index);
          END IF;
        END $$;
      `);
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'uk_mas_step_task_idempotency'
          ) THEN
            ALTER TABLE ${this.schema}.${this.stepsTable}
            ADD CONSTRAINT uk_mas_step_task_idempotency UNIQUE (task_execution_id, idempotency_key);
          END IF;
        END $$;
      `);
      // Create event_outbox table for transactional event persistence
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.event_outbox (
          id SERIAL PRIMARY KEY,
          event_id VARCHAR(255) NOT NULL UNIQUE,
          event_type VARCHAR(255) NOT NULL,
          aggregate_id VARCHAR(255) NOT NULL,
          payload JSONB NOT NULL,
          occurred_at TIMESTAMP NOT NULL,
          correlation_id VARCHAR(255),
          created_at TIMESTAMP NOT NULL DEFAULT NOW(),
          processed_at TIMESTAMP,
          processing_attempts INTEGER NOT NULL DEFAULT 0
        );
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_mas_event_outbox_unprocessed
          ON ${this.schema}.event_outbox(processed_at, created_at)
          WHERE processed_at IS NULL;
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_mas_event_outbox_aggregate
          ON ${this.schema}.event_outbox(aggregate_id);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_mas_task_status
          ON ${this.schema}.${this.taskExecutionsTable}(status, updated_at);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_mas_task_session
          ON ${this.schema}.${this.taskExecutionsTable}(session_id);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_mas_step_task
          ON ${this.schema}.${this.stepsTable}(task_execution_id, step_index);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_mas_step_status
          ON ${this.schema}.${this.stepsTable}(status, last_heartbeat_at);
      `);
    } catch (err: unknown) {
      const pgError = err as { code?: string };
      if (pgError?.code === '23505') {
        // DDL race: another process already created the schema/tables.
        return;
      }
      throw err;
    } finally {
      client.release();
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const res = await this.pool.query('SELECT 1');
      return res.rowCount === 1;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  // ---------------------------------------------------------------------------
  // MasExecutionStore implementation
  // ---------------------------------------------------------------------------

  async startTaskExecution(init: MasTaskExecutionInit): Promise<MasTaskExecution> {
    const now = new Date();
    const taskExecutionId = this.generateTaskExecutionId(init.taskId, init.sessionId);
    const status = init.status ?? MasTaskStatus.Pending;

    const task: MasTaskExecution = {
      taskExecutionId,
      taskId: init.taskId,
      sessionId: init.sessionId,
      status,
      currentStepId: null,
      steps: [],
      attempts: 0,
      lastError: undefined,
      requestContextSnapshot: init.requestContextSnapshot,
      timeouts: init.timeouts ?? {},
      meta: init.meta ?? {},
      createdAt: now,
      updatedAt: now,
      lockedBy: undefined,
      lockExpiresAt: undefined,
    };

    await this.pool.query(
      `
      INSERT INTO ${this.schema}.${this.taskExecutionsTable}
        (task_execution_id, task_id, session_id, status, current_step_id,
         attempts, last_error, request_context_snapshot, timeouts, meta,
         created_at, updated_at, locked_by, lock_expires_at, version)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
      `,
      [
        task.taskExecutionId,
        task.taskId,
        task.sessionId,
        task.status,
        null,
        task.attempts,
        null,
        JSON.stringify(task.requestContextSnapshot),
        JSON.stringify(task.timeouts),
        JSON.stringify(task.meta),
        task.createdAt,
        task.updatedAt,
        null,
        null,
        1, // Initial version
      ],
    );

    await this.emitTaskCreatedEvent(task);

    return task;
  }

  async getTaskExecution(taskExecutionId: string): Promise<MasTaskExecution | null> {
    const client = await this.pool.connect();
    try {
      const taskRes = await client.query<TaskExecutionRow>(
        `
        SELECT task_execution_id, task_id, session_id, status, current_step_id,
               attempts, last_error, request_context_snapshot, timeouts, meta,
               created_at, updated_at, locked_by, lock_expires_at, version
        FROM ${this.schema}.${this.taskExecutionsTable}
        WHERE task_execution_id = $1
        `,
        [taskExecutionId],
      );

      if (taskRes.rowCount === 0) {
        return null;
      }

      const stepRes = await client.query<StepRow>(
        `
        SELECT step_id, task_execution_id, step_index, kind, status,
               attempts, max_attempts, idempotency_key,
               input_snapshot, result_ref, error,
               started_at, completed_at, last_heartbeat_at,
               memory_policy, policy_decision_ref
        FROM ${this.schema}.${this.stepsTable}
        WHERE task_execution_id = $1
        ORDER BY step_index ASC
        `,
        [taskExecutionId],
      );

      return this.mapTaskRow(taskRes.rows[0], stepRes.rows);
    } finally {
      client.release();
    }
  }

  async findActiveTasksForRecovery(query: MasRecoveryQuery): Promise<MasTaskExecution[]> {
    const effectiveStatuses =
      query.taskStatuses && query.taskStatuses.length > 0
        ? query.taskStatuses
        : [MasTaskStatus.Running];

    const params: unknown[] = [];
    const whereParts: string[] = ['status = ANY($1)'];
    params.push(effectiveStatuses);

    if (query.updatedBefore) {
      whereParts.push('updated_at < $2');
      params.push(query.updatedBefore);
    }

    if (query.sessionIdEquals) {
      whereParts.push(
        `session_id = $${params.length + 1}`,
      );
      params.push(query.sessionIdEquals);
    }

    const limitClause =
      typeof query.maxTasks === 'number' && query.maxTasks > 0
        ? `LIMIT ${query.maxTasks}`
        : '';

    const sql = `
      SELECT task_execution_id, task_id, session_id, status, current_step_id,
             attempts, last_error, request_context_snapshot, timeouts, meta,
             created_at, updated_at, locked_by, lock_expires_at, version
      FROM ${this.schema}.${this.taskExecutionsTable}
      WHERE ${whereParts.join(' AND ')}
      ORDER BY updated_at ASC
      ${limitClause}
    `;

    const client = await this.pool.connect();
    try {
      const taskRes = await client.query<TaskExecutionRow>(sql, params);
      if (taskRes.rowCount === 0) {
        return [];
      }

      const ids = taskRes.rows.map(row => row.task_execution_id);
      const stepRes = await client.query<StepRow>(
        `
        SELECT step_id, task_execution_id, step_index, kind, status,
               attempts, max_attempts, idempotency_key,
               input_snapshot, result_ref, error,
               started_at, completed_at, last_heartbeat_at,
               memory_policy, policy_decision_ref
        FROM ${this.schema}.${this.stepsTable}
        WHERE task_execution_id = ANY($1)
        ORDER BY task_execution_id ASC, step_index ASC
        `,
        [ids],
      );

      const stepsByTask = new Map<string, StepRow[]>();
      for (const row of stepRes.rows) {
        const list = stepsByTask.get(row.task_execution_id) ?? [];
        list.push(row);
        stepsByTask.set(row.task_execution_id, list);
      }

      return taskRes.rows.map(row =>
        this.mapTaskRow(row, stepsByTask.get(row.task_execution_id) ?? []),
      );
    } finally {
      client.release();
    }
  }

  async appendStep(
    taskExecutionId: string,
    step: MasExecutionStep,
  ): Promise<MasTaskExecution> {
    return this.executeWithOptimisticLockRetry(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        const taskRowRes = await client.query<TaskExecutionRow>(
          `
          SELECT task_execution_id, task_id, session_id, status, current_step_id,
                 attempts, last_error, request_context_snapshot, timeouts, meta,
                 created_at, updated_at, locked_by, lock_expires_at, version
          FROM ${this.schema}.${this.taskExecutionsTable}
          WHERE task_execution_id = $1
          FOR UPDATE
          `,
          [taskExecutionId],
        );

        if (taskRowRes.rowCount === 0) {
          throw new Error(
            `PostgresMasExecutionStore.appendStep: taskExecution ${taskExecutionId} not found`,
          );
        }

        const taskRow = taskRowRes.rows[0];

        const indexRes = await client.query<{ idx: number }>(
          `
          SELECT COALESCE(MAX(step_index), -1) + 1 AS idx
          FROM ${this.schema}.${this.stepsTable}
          WHERE task_execution_id = $1
          `,
          [taskExecutionId],
        );
        const computedIndex = indexRes.rows[0]?.idx ?? 0;

        const attemptsForInsert =
          step.attempts > 0 ? step.attempts : 1;

        const now = new Date();
        const status = step.status ?? MasExecutionStatus.InProgress;

        await client.query(
          `
          INSERT INTO ${this.schema}.${this.stepsTable}
            (step_id, task_execution_id, step_index, kind, status,
             attempts, max_attempts, idempotency_key,
             input_snapshot, result_ref, error,
             started_at, completed_at, last_heartbeat_at,
             memory_policy, policy_decision_ref)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
          `,
          [
            step.stepId,
            taskExecutionId,
            computedIndex,
            step.kind,
            status,
            attemptsForInsert,
            step.maxAttempts ?? null,
            step.idempotencyKey,
            JSON.stringify(step.inputSnapshot ?? null),
            step.resultRef ? JSON.stringify(step.resultRef) : null,
            step.error ? JSON.stringify(step.error) : null,
            step.startedAt ?? now,
            step.completedAt ?? null,
            step.lastHeartbeatAt ?? now,
            step.memoryPolicy ?? null,
            step.policyDecisionRef ?? null,
          ],
        );

        const newStatus =
          taskRow.status === MasTaskStatus.Pending
            ? MasTaskStatus.Running
            : castToMasTaskStatus(taskRow.status);

        const updateResult = await client.query(
          `
          UPDATE ${this.schema}.${this.taskExecutionsTable}
          SET status = $2,
              current_step_id = $3,
              updated_at = $4,
              version = version + 1
          WHERE task_execution_id = $1 AND version = $5
          `,
          [taskExecutionId, newStatus, step.stepId, now, taskRow.version],
        );

        if (updateResult.rowCount === 0) {
          throw new Error(
            `PostgresMasExecutionStore.appendStep: optimistic lock failed for taskExecution ${taskExecutionId}`,
          );
        }

        // Build refreshed task for event emission
        const refreshed = await this.getTaskExecution(taskExecutionId);
        if (!refreshed) {
          throw new Error(
            `PostgresMasExecutionStore.appendStep: taskExecution ${taskExecutionId} disappeared after insert`,
          );
        }

        // Emit events inside transaction (before COMMIT)
        const events: DomainEvent[] = [];
        const taskStartedEvent = this.buildTaskStartedIfNeededEvent(taskRow, refreshed);
        if (taskStartedEvent) events.push(taskStartedEvent);
        const stepStartedEvent = this.buildStepStartedEvent(refreshed, this.findStep(refreshed, step.stepId), attemptsForInsert);
        if (stepStartedEvent) events.push(stepStartedEvent);

        if (events.length > 0) {
          await this.persistEventsWithClient(client, events);
        }

        await client.query('COMMIT');

        return refreshed;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback errors
        }
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async updateStepStatus(
    update: MasStepStatusUpdate,
  ): Promise<MasTaskExecution> {
    return this.executeWithOptimisticLockRetry(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        const stepRes = await client.query<StepRow>(
          `
          SELECT step_id, task_execution_id, step_index, kind, status,
                 attempts, max_attempts, idempotency_key,
                 input_snapshot, result_ref, error,
                 started_at, completed_at, last_heartbeat_at,
                 memory_policy, policy_decision_ref
          FROM ${this.schema}.${this.stepsTable}
          WHERE step_id = $1 AND task_execution_id = $2
          FOR UPDATE
          `,
          [update.stepId, update.taskExecutionId],
        );

        if (stepRes.rowCount === 0) {
          throw new Error(
            `PostgresMasExecutionStore.updateStepStatus: step ${update.stepId} for taskExecution ${update.taskExecutionId} not found`,
          );
        }

        const existingStep = stepRes.rows[0];
        const now = new Date();

        const newStatus = update.status;
        const newAttempts =
          typeof update.attempts === 'number'
            ? update.attempts
            : existingStep.attempts;

        const completedAt =
          update.completedAt ??
          (this.isTerminalStepStatus(newStatus)
            ? now
            : existingStep.completed_at);

        const lastHeartbeatAt =
          update.lastHeartbeatAt ?? now;

        const mergedError =
          update.error === null
            ? null
            : update.error
            ? update.error
            : existingStep.error;

        const resultRef =
          update.resultRef ?? existingStep.result_ref;

        await client.query(
          `
          UPDATE ${this.schema}.${this.stepsTable}
          SET status = $3,
              attempts = $4,
              result_ref = $5,
              error = $6,
              completed_at = $7,
              last_heartbeat_at = $8
          WHERE step_id = $1 AND task_execution_id = $2
          `,
          [
            update.stepId,
            update.taskExecutionId,
            newStatus,
            newAttempts,
            resultRef ? JSON.stringify(resultRef) : null,
            mergedError ? JSON.stringify(mergedError) : null,
            completedAt,
            lastHeartbeatAt,
          ],
        );

        // Get current version for optimistic locking
        const versionRes = await client.query<{ version: number }>(
          `
          SELECT version FROM ${this.schema}.${this.taskExecutionsTable}
          WHERE task_execution_id = $1
          FOR UPDATE
          `,
          [update.taskExecutionId],
        );

        if (versionRes.rowCount === 0) {
          throw new Error(
            `PostgresMasExecutionStore.updateStepStatus: taskExecution ${update.taskExecutionId} not found during version check`,
          );
        }

        const currentVersion = versionRes.rows[0].version;

        const updateResult = await client.query(
          `
          UPDATE ${this.schema}.${this.taskExecutionsTable}
          SET current_step_id = CASE
                                  WHEN $3 IN ('Completed','Failed','Cancelled','Skipped')
                                    THEN NULL
                                  ELSE current_step_id
                                END,
              updated_at = $4,
              version = version + 1
          WHERE task_execution_id = $1 AND version = $5
          `,
          [update.taskExecutionId, update.stepId, newStatus, now, currentVersion],
        );

        if (updateResult.rowCount === 0) {
          throw new Error(
            `PostgresMasExecutionStore.updateStepStatus: optimistic lock failed for taskExecution ${update.taskExecutionId}`,
          );
        }

        const refreshed = await this.getTaskExecution(update.taskExecutionId);
        if (!refreshed) {
          throw new Error(
            `PostgresMasExecutionStore.updateStepStatus: taskExecution ${update.taskExecutionId} disappeared after update`,
          );
        }

        const mappedStep = this.findStep(refreshed, update.stepId);

        // Emit events inside transaction (before COMMIT)
        const events: DomainEvent[] = [];
        if (mappedStep) {
          if (newStatus === MasExecutionStatus.Completed) {
            const event = this.buildStepCompletedEvent(refreshed, mappedStep);
            if (event) events.push(event);
          } else if (newStatus === MasExecutionStatus.Failed) {
            const event = this.buildStepFailedEvent(refreshed, mappedStep);
            if (event) events.push(event);
          }
        }

        if (events.length > 0) {
          await this.persistEventsWithClient(client, events);
        }

        await client.query('COMMIT');

        return refreshed;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore
        }
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async markTaskCompleted(taskExecutionId: string): Promise<MasTaskExecution> {
    return this.executeWithOptimisticLockRetry(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        // Get current version for optimistic locking
        const versionRes = await client.query<{ version: number }>(
          `
          SELECT version FROM ${this.schema}.${this.taskExecutionsTable}
          WHERE task_execution_id = $1
          FOR UPDATE
          `,
          [taskExecutionId],
        );

        if (versionRes.rowCount === 0) {
          throw new Error(
            `PostgresMasExecutionStore.markTaskCompleted: taskExecution ${taskExecutionId} not found`,
          );
        }

        const currentVersion = versionRes.rows[0].version;
        const now = new Date();

        const updateResult = await client.query(
          `
          UPDATE ${this.schema}.${this.taskExecutionsTable}
          SET status = $2,
              updated_at = $3,
              current_step_id = NULL,
              last_error = NULL,
              version = version + 1
          WHERE task_execution_id = $1 AND version = $4
          `,
          [taskExecutionId, MasTaskStatus.Completed, now, currentVersion],
        );

        if (updateResult.rowCount === 0) {
          throw new Error(
            `PostgresMasExecutionStore.markTaskCompleted: optimistic lock failed for taskExecution ${taskExecutionId}`,
          );
        }

        const refreshed = await this.getTaskExecution(taskExecutionId);
        if (!refreshed) {
          throw new Error(
            `PostgresMasExecutionStore.markTaskCompleted: taskExecution ${taskExecutionId} not found after update`,
          );
        }

        // Emit events inside transaction (before COMMIT)
        const event = this.buildTaskCompletedEvent(refreshed);
        if (event) {
          await this.persistEventsWithClient(client, [event]);
        }

        await client.query('COMMIT');

        return refreshed;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback errors
        }
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async markTaskFailed(
    taskExecutionId: string,
    error: MasExecutionError,
  ): Promise<MasTaskExecution> {
    incrementMasErrorsTotal({
      component: 'durable_execution',
      errorType: mapExecutionErrorToCategory(error),
    });

    return this.executeWithOptimisticLockRetry(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        // Get current version for optimistic locking
        const versionRes = await client.query<{ version: number }>(
          `
          SELECT version FROM ${this.schema}.${this.taskExecutionsTable}
          WHERE task_execution_id = $1
          FOR UPDATE
          `,
          [taskExecutionId],
        );

        if (versionRes.rowCount === 0) {
          throw new Error(
            `PostgresMasExecutionStore.markTaskFailed: taskExecution ${taskExecutionId} not found`,
          );
        }

        const currentVersion = versionRes.rows[0].version;
        const now = new Date();

        const updateResult = await client.query(
          `
          UPDATE ${this.schema}.${this.taskExecutionsTable}
          SET status = $2,
              updated_at = $3,
              last_error = $4,
              version = version + 1
          WHERE task_execution_id = $1 AND version = $5
          `,
          [taskExecutionId, MasTaskStatus.Failed, now, JSON.stringify(error), currentVersion],
        );

        if (updateResult.rowCount === 0) {
          throw new Error(
            `PostgresMasExecutionStore.markTaskFailed: optimistic lock failed for taskExecution ${taskExecutionId}`,
          );
        }

        const refreshed = await this.getTaskExecution(taskExecutionId);
        if (!refreshed) {
          throw new Error(
            `PostgresMasExecutionStore.markTaskFailed: taskExecution ${taskExecutionId} not found after update`,
          );
        }

        // Emit events inside transaction (before COMMIT)
        const event = this.buildTaskFailedEvent(refreshed);
        if (event) {
          await this.persistEventsWithClient(client, [event]);
        }

        await client.query('COMMIT');

        return refreshed;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback errors
        }
        throw error;
      } finally {
        client.release();
      }
    });
  }

  async markTaskCancelled(
    taskExecutionId: string,
    reason: string,
  ): Promise<MasTaskExecution> {
    return this.executeWithOptimisticLockRetry(async () => {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');

        // Get current version for optimistic locking
        const versionRes = await client.query<{ version: number }>(
          `
          SELECT version FROM ${this.schema}.${this.taskExecutionsTable}
          WHERE task_execution_id = $1
          FOR UPDATE
          `,
          [taskExecutionId],
        );

        if (versionRes.rowCount === 0) {
          throw new Error(
            `PostgresMasExecutionStore.markTaskCancelled: taskExecution ${taskExecutionId} not found`,
          );
        }

        const currentVersion = versionRes.rows[0].version;
        const now = new Date();
        const error: MasExecutionError = {
          code: 'TASK_CANCELLED',
          message: reason,
          details: {
            taskExecutionId,
          },
          firstOccurredAt: now,
          lastOccurredAt: now,
        };

        incrementMasErrorsTotal({
          component: 'durable_execution',
          errorType: mapExecutionErrorToCategory(error),
        });

        const updateResult = await client.query(
          `
          UPDATE ${this.schema}.${this.taskExecutionsTable}
          SET status = $2,
              updated_at = $3,
              last_error = $4,
              version = version + 1
          WHERE task_execution_id = $1 AND version = $5
          `,
          [taskExecutionId, MasTaskStatus.Cancelled, now, JSON.stringify(error), currentVersion],
        );

        if (updateResult.rowCount === 0) {
          throw new Error(
            `PostgresMasExecutionStore.markTaskCancelled: optimistic lock failed for taskExecution ${taskExecutionId}`,
          );
        }

        const refreshed = await this.getTaskExecution(taskExecutionId);
        if (!refreshed) {
          throw new Error(
            `PostgresMasExecutionStore.markTaskCancelled: taskExecution ${taskExecutionId} not found after update`,
          );
        }

        // Emit events inside transaction (before COMMIT)
        const event = this.buildTaskCancelledEvent(refreshed, reason);
        if (event) {
          await this.persistEventsWithClient(client, [event]);
        }

        await client.query('COMMIT');

        return refreshed;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore rollback errors
        }
        throw error;
      } finally {
        client.release();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Mapping helpers
  // ---------------------------------------------------------------------------

  private mapTaskRow(
    row: TaskExecutionRow,
    stepRows: StepRow[],
  ): MasTaskExecution {
    const snapshot: RequestContextSnapshot =
      this.parseJson<RequestContextSnapshot>(row.request_context_snapshot) ?? {
        correlationId: 'unknown',
        masSessionId: 'unknown',
      };
    const timeouts = this.parseJson<MasTaskExecution['timeouts']>(
      row.timeouts,
    );
    const meta = this.parseJson<Record<string, unknown>>(row.meta);
    const lastError: MasExecutionError | undefined =
      row.last_error != null
        ? this.parseJson<MasExecutionError>(row.last_error)
        : undefined;

    const steps = stepRows.map(s => this.mapStepRow(s));

    const baseTask: MasTaskExecution = {
      taskExecutionId: row.task_execution_id,
      taskId: row.task_id,
      sessionId: row.session_id,
      status: castToMasTaskStatus(row.status),
      currentStepId: row.current_step_id,
      steps,
      attempts: row.attempts,
      lastError,
      requestContextSnapshot: snapshot,
      timeouts: timeouts ?? {},
      meta: meta ?? {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lockedBy: row.locked_by ?? undefined,
      lockExpiresAt: row.lock_expires_at ?? undefined,
      version: row.version ?? 1,
    };

    const enrichedLastError =
      baseTask.lastError != null
        ? attachDurableSloDiagnosticsToError(baseTask.lastError, baseTask)
        : null;

    const enrichedSteps = baseTask.steps.map(step =>
      step.error
        ? {
            ...step,
            error: attachDurableSloDiagnosticsToError(step.error, baseTask),
          }
        : step,
    );

    return {
      ...baseTask,
      lastError: enrichedLastError ?? undefined,
      steps: enrichedSteps,
    };
  }

  private mapStepRow(row: StepRow): MasExecutionStep {
    const inputSnapshot = this.parseJson<unknown>(row.input_snapshot);
    const resultRef =
      row.result_ref != null
        ? this.parseJson<MasResultRef>(row.result_ref)
        : undefined;
    const error =
      row.error != null
        ? this.parseJson<MasExecutionError>(row.error)
        : undefined;

    // Validate kind cast (optional runtime check could be added here)

    return {
      stepId: row.step_id,
      taskExecutionId: row.task_execution_id,
      index: row.step_index,
      kind: castToMasExecutionStepKind(row.kind),
      status: castToMasExecutionStatus(row.status),
      attempts: row.attempts,
      maxAttempts: row.max_attempts ?? undefined,
      idempotencyKey: row.idempotency_key,
      inputSnapshot,
      resultRef,
      error,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      lastHeartbeatAt: row.last_heartbeat_at ?? undefined,
      memoryPolicy: row.memory_policy as MasExecutionStep['memoryPolicy'],
      policyDecisionRef: row.policy_decision_ref ?? undefined,
    };
  }

  private buildExecutionErrorPayload(
    error: MasExecutionError | null | undefined,
    fallbackCode: string,
    fallbackMessage: string,
  ): MasExecutionErrorPayload {
    const baseError: MasExecutionError =
      error ??
      {
        code: fallbackCode,
        message: fallbackMessage,
        details: {},
        firstOccurredAt: new Date(),
        lastOccurredAt: new Date(),
      };

    const rawDetails = isNonNullObject(baseError.details) ? baseError.details : {};
    const existingCategory =
      typeof rawDetails.masErrorCategory === 'string'
        ? rawDetails.masErrorCategory
        : undefined;

    const details: Record<string, unknown> = {
      ...rawDetails,
      masErrorCategory: existingCategory,
    };

    return {
      code: baseError.code,
      message: baseError.message,
      details,
      first_occurred_at: baseError.firstOccurredAt.toISOString(),
      last_occurred_at: baseError.lastOccurredAt.toISOString(),
    };
  }

  private parseJson<T>(value: unknown): T | undefined {
    if (value == null) {
      return undefined;
    }
    if (typeof value !== 'string') {
      return value as T;
    }
    const parsed = tryJsonParse<T>(value);
    if (parsed.ok) {
      return parsed.value;
    }
     
    logger.error('PostgresMasExecutionStore: failed to parse JSON column', {
      error: parsed.error.message,
    });
    return undefined;
  }

  private findStep(
    execution: MasTaskExecution,
    stepId: string,
  ): MasExecutionStep | undefined {
    return execution.steps.find(s => s.stepId === stepId);
  }

  private isTerminalStepStatus(status: MasExecutionStatus): boolean {
    return (
      status === MasExecutionStatus.Completed ||
      status === MasExecutionStatus.Failed ||
      status === MasExecutionStatus.Cancelled ||
      status === MasExecutionStatus.Skipped
    );
  }

  private generateTaskExecutionId(taskId: string, sessionId: string): string {
    const safeTask = taskId.replace(/[^a-zA-Z0-9_-]/g, '_');
    const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_');
    return `mas_exec_${safeTask}_${safeSession}_${Date.now()}`;
  }

  // ---------------------------------------------------------------------------
  // Typed durable-execution events (best-effort)
  // ---------------------------------------------------------------------------

  private async emitTaskCreatedEvent(
    task: MasTaskExecution,
  ): Promise<void> {
    const snapshot = task.requestContextSnapshot;
    const payload: MasTaskExecutionCreatedEventPayload = {
      mas_session_id:
        snapshot.masSessionId ?? task.sessionId,
      mas_trace_id: snapshot.masTraceId,
      scenario: (task.meta?.scenario as string | undefined) ?? undefined,
      use_case: (task.meta?.useCase as string | undefined) ?? undefined,
      tenant_id: snapshot.tenantId,
      user_id: snapshot.userId,
      correlation_id: snapshot.correlationId,
      correlation_source: 'mas_context',
      timestamp: new Date().toISOString(),
      task_id: task.taskId,
      task_execution_id: task.taskExecutionId,
      status: task.status,
      attempts: task.attempts,
      timeouts: {
        task_timeout_ms: task.timeouts.taskTimeoutMs,
        step_timeout_ms: task.timeouts.stepTimeoutMs,
      },
      meta: task.meta,
    };

    const event = EventFactory.createBaseEvent<MasTaskExecutionCreatedEventPayload>(
      task.taskExecutionId,
      'mas.task_execution.created',
      payload,
      snapshot.correlationId,
    );

    await this.persistEvents([event]);
  }

  private async emitTaskStartedIfNeeded(
    previousRow: TaskExecutionRow,
    refreshed: MasTaskExecution,
  ): Promise<void> {
    if (
      previousRow.status === refreshed.status ||
      refreshed.status !== MasTaskStatus.Running
    ) {
      return;
    }

    const snapshot = refreshed.requestContextSnapshot;

    const payload: MasTaskExecutionStartedEventPayload = {
      mas_session_id:
        snapshot.masSessionId ?? refreshed.sessionId,
      mas_trace_id: snapshot.masTraceId,
      scenario: (refreshed.meta?.scenario as string | undefined) ?? undefined,
      use_case: (refreshed.meta?.useCase as string | undefined) ?? undefined,
      tenant_id: snapshot.tenantId,
      user_id: snapshot.userId,
      correlation_id: snapshot.correlationId,
      correlation_source: 'mas_context',
      timestamp: new Date().toISOString(),
      task_id: refreshed.taskId,
      task_execution_id: refreshed.taskExecutionId,
      previous_status: castToMasTaskStatus(previousRow.status),
      status: 'Running',
      attempts: refreshed.attempts,
    };

    const event = EventFactory.createBaseEvent<MasTaskExecutionStartedEventPayload>(
      refreshed.taskExecutionId,
      'mas.task_execution.started',
      payload,
      snapshot.correlationId,
    );

    await this.persistEvents([event]);
  }

  private async emitTaskCompletedEvent(
    task: MasTaskExecution,
  ): Promise<void> {
    const snapshot = task.requestContextSnapshot;

    const payload: MasTaskExecutionCompletedEventPayload = {
      mas_session_id:
        snapshot.masSessionId ?? task.sessionId,
      mas_trace_id: snapshot.masTraceId,
      scenario: (task.meta?.scenario as string | undefined) ?? undefined,
      use_case: (task.meta?.useCase as string | undefined) ?? undefined,
      tenant_id: snapshot.tenantId,
      user_id: snapshot.userId,
      correlation_id: snapshot.correlationId,
      correlation_source: 'mas_context',
      timestamp: new Date().toISOString(),
      task_id: task.taskId,
      task_execution_id: task.taskExecutionId,
      previous_status: undefined,
      status: 'Completed',
      attempts: task.attempts,
    };

    const event = EventFactory.createBaseEvent<MasTaskExecutionCompletedEventPayload>(
      task.taskExecutionId,
      'mas.task_execution.completed',
      payload,
      snapshot.correlationId,
    );

    await this.persistEvents([event]);
  }

  private async emitTaskFailedEvent(
    task: MasTaskExecution,
  ): Promise<void> {
    const snapshot = task.requestContextSnapshot;

    const errorPayload = this.buildExecutionErrorPayload(
      task.lastError,
      'TASK_FAILED',
      'Durable task execution failed',
    );

    const reasonCode =
      task.lastError && task.lastError.details
        ? (task.lastError.details as { reasonCode?: unknown }).reasonCode
        : undefined;

    const payload: MasTaskExecutionFailedEventPayload = {
      mas_session_id:
        snapshot.masSessionId ?? task.sessionId,
      mas_trace_id: snapshot.masTraceId,
      scenario: (task.meta?.scenario as string | undefined) ?? undefined,
      use_case: (task.meta?.useCase as string | undefined) ?? undefined,
      tenant_id: snapshot.tenantId,
      user_id: snapshot.userId,
      correlation_id: snapshot.correlationId,
      correlation_source: 'mas_context',
      timestamp: new Date().toISOString(),
      task_id: task.taskId,
      task_execution_id: task.taskExecutionId,
      previous_status: undefined,
      status: 'Failed',
      attempts: task.attempts,
      error: errorPayload,
    };

    const event = EventFactory.createBaseEvent<MasTaskExecutionFailedEventPayload>(
      task.taskExecutionId,
      'mas.task_execution.failed',
      payload,
      snapshot.correlationId,
    );

    await this.persistEvents([event]);
  }

  private async emitTaskCancelledEvent(
    task: MasTaskExecution,
    reason: string,
  ): Promise<void> {
    const snapshot = task.requestContextSnapshot;

    const payload: MasTaskExecutionCancelledEventPayload = {
      mas_session_id:
        snapshot.masSessionId ?? task.sessionId,
      mas_trace_id: snapshot.masTraceId,
      scenario: (task.meta?.scenario as string | undefined) ?? undefined,
      use_case: (task.meta?.useCase as string | undefined) ?? undefined,
      tenant_id: snapshot.tenantId,
      user_id: snapshot.userId,
      correlation_id: snapshot.correlationId,
      correlation_source: 'mas_context',
      timestamp: new Date().toISOString(),
      task_id: task.taskId,
      task_execution_id: task.taskExecutionId,
      previous_status: undefined,
      status: 'Cancelled',
      attempts: task.attempts,
      reason,
    };

    const event = EventFactory.createBaseEvent<MasTaskExecutionCancelledEventPayload>(
      task.taskExecutionId,
      'mas.task_execution.cancelled',
      payload,
      snapshot.correlationId,
    );

    await this.persistEvents([event]);
  }

  private async emitStepStartedEvent(
    task: MasTaskExecution,
    step: MasExecutionStep | undefined,
    attempts: number,
  ): Promise<void> {
    if (!step) {
      return;
    }

    const snapshot = task.requestContextSnapshot;

    const payload: MasExecutionStepStartedEventPayload = {
      mas_session_id:
        snapshot.masSessionId ?? task.sessionId,
      mas_trace_id: snapshot.masTraceId,
      scenario: (task.meta?.scenario as string | undefined) ?? undefined,
      use_case: (task.meta?.useCase as string | undefined) ?? undefined,
      tenant_id: snapshot.tenantId,
      user_id: snapshot.userId,
      correlation_id: snapshot.correlationId,
      correlation_source: 'mas_context',
      timestamp: new Date().toISOString(),
      task_id: task.taskId,
      task_execution_id: task.taskExecutionId,
      step_id: step.stepId,
      step_index: step.index,
      step_kind: this.mapStepKindToEventKind(step.kind),
      status: 'InProgress',
      attempts,
    };

    const event = EventFactory.createBaseEvent<MasExecutionStepStartedEventPayload>(
      task.taskExecutionId,
      'mas.execution_step.started',
      payload,
      snapshot.correlationId,
    );

    await this.persistEvents([event]);
  }

  private async emitStepCompletedEvent(
    task: MasTaskExecution,
    step: MasExecutionStep,
  ): Promise<void> {
    const snapshot = task.requestContextSnapshot;

    const resultRef =
      step.resultRef != null
        ? {
            provider: step.resultRef.provider,
            ref_id: step.resultRef.refId,
            locator: step.resultRef.locator,
            correlation_id: step.resultRef.correlationId,
            metadata: step.resultRef.metadata,
          }
        : undefined;

    const payload: MasExecutionStepCompletedEventPayload = {
      mas_session_id:
        snapshot.masSessionId ?? task.sessionId,
      mas_trace_id: snapshot.masTraceId,
      scenario: (task.meta?.scenario as string | undefined) ?? undefined,
      use_case: (task.meta?.useCase as string | undefined) ?? undefined,
      tenant_id: snapshot.tenantId,
      user_id: snapshot.userId,
      correlation_id: snapshot.correlationId,
      correlation_source: 'mas_context',
      timestamp: new Date().toISOString(),
      task_id: task.taskId,
      task_execution_id: task.taskExecutionId,
      step_id: step.stepId,
      step_index: step.index,
      step_kind: this.mapStepKindToEventKind(step.kind),
      status: 'Completed',
      attempts: step.attempts,
      result_ref: resultRef,
      policy_decision_ref: step.policyDecisionRef,
    };

    const event = EventFactory.createBaseEvent<MasExecutionStepCompletedEventPayload>(
      task.taskExecutionId,
      'mas.execution_step.completed',
      payload,
      snapshot.correlationId,
    );

    await this.persistEvents([event]);
  }

  private async emitStepFailedEvent(
    task: MasTaskExecution,
    step: MasExecutionStep,
  ): Promise<void> {
    const snapshot = task.requestContextSnapshot;

    const errorPayload = this.buildExecutionErrorPayload(
      step.error,
      'STEP_FAILED',
      'Durable execution step failed',
    );

    const payload: MasExecutionStepFailedEventPayload = {
      mas_session_id:
        snapshot.masSessionId ?? task.sessionId,
      mas_trace_id: snapshot.masTraceId,
      scenario: (task.meta?.scenario as string | undefined) ?? undefined,
      use_case: (task.meta?.useCase as string | undefined) ?? undefined,
      tenant_id: snapshot.tenantId,
      user_id: snapshot.userId,
      correlation_id: snapshot.correlationId,
      correlation_source: 'mas_context',
      timestamp: new Date().toISOString(),
      task_id: task.taskId,
      task_execution_id: task.taskExecutionId,
      step_id: step.stepId,
      step_index: step.index,
      step_kind: this.mapStepKindToEventKind(step.kind),
      status: 'Failed',
      attempts: step.attempts,
      error: errorPayload,
      can_retry:
        typeof step.maxAttempts === 'number'
          ? step.attempts < step.maxAttempts
          : undefined,
    };

    const event = EventFactory.createBaseEvent<MasExecutionStepFailedEventPayload>(
      task.taskExecutionId,
      'mas.execution_step.failed',
      payload,
      snapshot.correlationId,
    );

    await this.persistEvents([event]);
  }

  private mapStepKindToEventKind(kind: MasExecutionStepKind): 'LLM_CALL' | 'TOOL_CALL' | 'SUB_AGENT' | 'DECISION' | 'AGGREGATION' | 'SYSTEM' {
    switch (kind) {
      case MasExecutionStepKind.LLM:
        return 'LLM_CALL';
      case MasExecutionStepKind.TOOL:
        return 'TOOL_CALL';
      case MasExecutionStepKind.AGENT:
        return 'SUB_AGENT';
      case MasExecutionStepKind.SYSTEM:
        return 'SYSTEM';
      case MasExecutionStepKind.MEMORY:
        return 'DECISION';
      default:
        return 'SYSTEM';
    }
  }

  /**
   * Persist events to the outbox table within a transaction using the provided client.
   * This ensures atomic event persistence with database operations.
   */
  private async persistEventsWithClient(client: PoolClient, events: DomainEvent[]): Promise<void> {
    if (!events.length) {
      return;
    }

    // Use outbox table for transactional event persistence
    const outboxTable = `${this.schema}.event_outbox`;

    for (const event of events) {
      await client.query(
        `INSERT INTO ${outboxTable} (event_id, event_type, aggregate_id, payload, occurred_at, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          event.eventId,
          event.eventType ?? event.type,
          event.aggregateId,
          JSON.stringify(event.payload),
          event.timestamp,
          event.correlationId ?? null,
        ],
      );
    }
  }

  private async persistEvents(events: DomainEvent[]): Promise<void> {
    if (!events.length) {
      return;
    }

    try {
      if (this.outbox) {
        await this.outbox.saveEventsWithOutbox(events);
        return;
      }

      if (this.eventStore) {
        await this.eventStore.saveEvents(events, {
          transactional: true,
          validateEvents: true,
        });
      }
    } catch (error) {
      // Durable Execution must not break main persistence flow due to telemetry issues.
       
      logger.error(
        'PostgresMasExecutionStore: failed to persist durable-execution events',
        { error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Event builder methods (return DomainEvent for transactional persistence)
  // ---------------------------------------------------------------------------

  private buildTaskStartedIfNeededEvent(
    previousRow: TaskExecutionRow,
    refreshed: MasTaskExecution,
  ): DomainEvent | null {
    if (
      previousRow.status === refreshed.status ||
      refreshed.status !== MasTaskStatus.Running
    ) {
      return null;
    }

    const snapshot = refreshed.requestContextSnapshot;

    const payload: MasTaskExecutionStartedEventPayload = {
      mas_session_id: snapshot.masSessionId ?? refreshed.sessionId,
      mas_trace_id: snapshot.masTraceId,
      scenario: (refreshed.meta?.scenario as string | undefined) ?? undefined,
      use_case: (refreshed.meta?.useCase as string | undefined) ?? undefined,
      tenant_id: snapshot.tenantId,
      user_id: snapshot.userId,
      correlation_id: snapshot.correlationId,
      correlation_source: 'mas_context',
      timestamp: new Date().toISOString(),
      task_id: refreshed.taskId,
      task_execution_id: refreshed.taskExecutionId,
      previous_status: castToMasTaskStatus(previousRow.status),
      status: 'Running',
      attempts: refreshed.attempts,
    };

    return EventFactory.createBaseEvent<MasTaskExecutionStartedEventPayload>(
      refreshed.taskExecutionId,
      'mas.task_execution.started',
      payload,
      snapshot.correlationId,
    );
  }

  private buildStepStartedEvent(
    task: MasTaskExecution,
    step: MasExecutionStep | undefined,
    attempts: number,
  ): DomainEvent | null {
    if (!step) {
      return null;
    }

    const snapshot = task.requestContextSnapshot;

    const payload: MasExecutionStepStartedEventPayload = {
      mas_session_id: snapshot.masSessionId ?? task.sessionId,
      mas_trace_id: snapshot.masTraceId,
      scenario: (task.meta?.scenario as string | undefined) ?? undefined,
      use_case: (task.meta?.useCase as string | undefined) ?? undefined,
      tenant_id: snapshot.tenantId,
      user_id: snapshot.userId,
      correlation_id: snapshot.correlationId,
      correlation_source: 'mas_context',
      timestamp: new Date().toISOString(),
      task_id: task.taskId,
      task_execution_id: task.taskExecutionId,
      step_id: step.stepId,
      step_index: step.index,
      step_kind: this.mapStepKindToEventKind(step.kind),
      status: 'InProgress',
      attempts,
    };

    return EventFactory.createBaseEvent<MasExecutionStepStartedEventPayload>(
      task.taskExecutionId,
      'mas.execution_step.started',
      payload,
      snapshot.correlationId,
    );
  }

  private buildStepCompletedEvent(
    task: MasTaskExecution,
    step: MasExecutionStep,
  ): DomainEvent | null {
    const snapshot = task.requestContextSnapshot;

    const resultRef =
      step.resultRef != null
        ? {
            provider: step.resultRef.provider,
            ref_id: step.resultRef.refId,
            locator: step.resultRef.locator,
            correlation_id: step.resultRef.correlationId,
            metadata: step.resultRef.metadata,
          }
        : undefined;

    const payload: MasExecutionStepCompletedEventPayload = {
      mas_session_id: snapshot.masSessionId ?? task.sessionId,
      mas_trace_id: snapshot.masTraceId,
      scenario: (task.meta?.scenario as string | undefined) ?? undefined,
      use_case: (task.meta?.useCase as string | undefined) ?? undefined,
      tenant_id: snapshot.tenantId,
      user_id: snapshot.userId,
      correlation_id: snapshot.correlationId,
      correlation_source: 'mas_context',
      timestamp: new Date().toISOString(),
      task_id: task.taskId,
      task_execution_id: task.taskExecutionId,
      step_id: step.stepId,
      step_index: step.index,
      step_kind: this.mapStepKindToEventKind(step.kind),
      status: 'Completed',
      attempts: step.attempts,
      result_ref: resultRef,
      policy_decision_ref: step.policyDecisionRef,
    };

    return EventFactory.createBaseEvent<MasExecutionStepCompletedEventPayload>(
      task.taskExecutionId,
      'mas.execution_step.completed',
      payload,
      snapshot.correlationId,
    );
  }

  private buildStepFailedEvent(
    task: MasTaskExecution,
    step: MasExecutionStep,
  ): DomainEvent | null {
    const snapshot = task.requestContextSnapshot;

    const errorPayload = this.buildExecutionErrorPayload(
      step.error,
      'STEP_FAILED',
      'Durable execution step failed',
    );

    const payload: MasExecutionStepFailedEventPayload = {
      mas_session_id: snapshot.masSessionId ?? task.sessionId,
      mas_trace_id: snapshot.masTraceId,
      scenario: (task.meta?.scenario as string | undefined) ?? undefined,
      use_case: (task.meta?.useCase as string | undefined) ?? undefined,
      tenant_id: snapshot.tenantId,
      user_id: snapshot.userId,
      correlation_id: snapshot.correlationId,
      correlation_source: 'mas_context',
      timestamp: new Date().toISOString(),
      task_id: task.taskId,
      task_execution_id: task.taskExecutionId,
      step_id: step.stepId,
      step_index: step.index,
      step_kind: this.mapStepKindToEventKind(step.kind),
      status: 'Failed',
      attempts: step.attempts,
      error: errorPayload,
      can_retry:
        typeof step.maxAttempts === 'number'
          ? step.attempts < step.maxAttempts
          : undefined,
    };

    return EventFactory.createBaseEvent<MasExecutionStepFailedEventPayload>(
      task.taskExecutionId,
      'mas.execution_step.failed',
      payload,
      snapshot.correlationId,
    );
  }

  private buildTaskCompletedEvent(
    task: MasTaskExecution,
  ): DomainEvent | null {
    const snapshot = task.requestContextSnapshot;

    const payload: MasTaskExecutionCompletedEventPayload = {
      mas_session_id: snapshot.masSessionId ?? task.sessionId,
      mas_trace_id: snapshot.masTraceId,
      scenario: (task.meta?.scenario as string | undefined) ?? undefined,
      use_case: (task.meta?.useCase as string | undefined) ?? undefined,
      tenant_id: snapshot.tenantId,
      user_id: snapshot.userId,
      correlation_id: snapshot.correlationId,
      correlation_source: 'mas_context',
      timestamp: new Date().toISOString(),
      task_id: task.taskId,
      task_execution_id: task.taskExecutionId,
      previous_status: undefined,
      status: 'Completed',
      attempts: task.attempts,
    };

    return EventFactory.createBaseEvent<MasTaskExecutionCompletedEventPayload>(
      task.taskExecutionId,
      'mas.task_execution.completed',
      payload,
      snapshot.correlationId,
    );
  }

  private buildTaskFailedEvent(
    task: MasTaskExecution,
  ): DomainEvent | null {
    const snapshot = task.requestContextSnapshot;

    const errorPayload = this.buildExecutionErrorPayload(
      task.lastError,
      'TASK_FAILED',
      'Durable task execution failed',
    );

    const payload: MasTaskExecutionFailedEventPayload = {
      mas_session_id: snapshot.masSessionId ?? task.sessionId,
      mas_trace_id: snapshot.masTraceId,
      scenario: (task.meta?.scenario as string | undefined) ?? undefined,
      use_case: (task.meta?.useCase as string | undefined) ?? undefined,
      tenant_id: snapshot.tenantId,
      user_id: snapshot.userId,
      correlation_id: snapshot.correlationId,
      correlation_source: 'mas_context',
      timestamp: new Date().toISOString(),
      task_id: task.taskId,
      task_execution_id: task.taskExecutionId,
      previous_status: undefined,
      status: 'Failed',
      attempts: task.attempts,
      error: errorPayload,
    };

    return EventFactory.createBaseEvent<MasTaskExecutionFailedEventPayload>(
      task.taskExecutionId,
      'mas.task_execution.failed',
      payload,
      snapshot.correlationId,
    );
  }

  private buildTaskCancelledEvent(
    task: MasTaskExecution,
    reason: string,
  ): DomainEvent | null {
    const snapshot = task.requestContextSnapshot;

    const payload: MasTaskExecutionCancelledEventPayload = {
      mas_session_id: snapshot.masSessionId ?? task.sessionId,
      mas_trace_id: snapshot.masTraceId,
      scenario: (task.meta?.scenario as string | undefined) ?? undefined,
      use_case: (task.meta?.useCase as string | undefined) ?? undefined,
      tenant_id: snapshot.tenantId,
      user_id: snapshot.userId,
      correlation_id: snapshot.correlationId,
      correlation_source: 'mas_context',
      timestamp: new Date().toISOString(),
      task_id: task.taskId,
      task_execution_id: task.taskExecutionId,
      previous_status: undefined,
      status: 'Cancelled',
      attempts: task.attempts,
      reason,
    };

    return EventFactory.createBaseEvent<MasTaskExecutionCancelledEventPayload>(
      task.taskExecutionId,
      'mas.task_execution.cancelled',
      payload,
      snapshot.correlationId,
    );
  }
}

/**
 * Factory for creating PostgresMasExecutionStore from environment configuration.
 */
export function createPostgresMasExecutionStoreFromEnv(
  eventStore?: IEventStore,
  outbox?: IOutbox,
): PostgresMasExecutionStore {
  const cfg = getConfig();

  const port =
    cfg.DB_PORT && cfg.DB_PORT.length > 0
      ? Number.parseInt(cfg.DB_PORT, 10)
      : undefined;

  const ssl = buildPgSslConfig(toEnvRecord(cfg as Record<string, unknown>));

  const connection: PoolConfig = {
    connectionString: cfg.DATABASE_URL,
    host: cfg.DB_HOST,
    port,
    database: cfg.DB_NAME,
    user: cfg.DB_USER,
    password: cfg.DB_PASSWORD,
    ssl,
  };

  const rawSchema =
    (cfg as unknown as { MAS_EXECUTION_SCHEMA?: unknown }).MAS_EXECUTION_SCHEMA;
  const rawTaskExecutionsTable =
    (cfg as unknown as { MAS_EXECUTION_TASKS_TABLE?: unknown })
      .MAS_EXECUTION_TASKS_TABLE;
  const rawStepsTable =
    (cfg as unknown as { MAS_EXECUTION_STEPS_TABLE?: unknown })
      .MAS_EXECUTION_STEPS_TABLE;

  const storeConfig: PostgresMasExecutionStoreConfig = {
    connection,
    schema:
      typeof rawSchema === 'string' && rawSchema.trim().length > 0
        ? rawSchema.trim()
        : DEFAULT_SCHEMA,
    taskExecutionsTable:
      typeof rawTaskExecutionsTable === 'string' &&
      rawTaskExecutionsTable.trim().length > 0
        ? rawTaskExecutionsTable.trim()
        : DEFAULT_TASK_EXECUTIONS_TABLE,
    stepsTable:
      typeof rawStepsTable === 'string' && rawStepsTable.trim().length > 0
        ? rawStepsTable.trim()
        : DEFAULT_STEPS_TABLE,
  };

  const store = new PostgresMasExecutionStore(
    storeConfig,
    eventStore,
    outbox,
  );

  // Initialize schema/tables best-effort; errors are surfaced to caller.
  void store.initialize().catch(error => {
     
    console.error(
      'PostgresMasExecutionStore: failed to initialize schema/tables',
      error,
    );
  });

  return store;
}


