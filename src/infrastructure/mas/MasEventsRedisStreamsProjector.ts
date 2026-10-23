import type { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import { getConfig } from '../../config';
import { tryJsonParse } from '../../core/utils/json';
import type { MasRedisStreamsClient, MasStreamEntry } from './MasRedisStreamsClient';
import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';

export interface MasEventsRedisStreamsProjectorOptions {
  groupName?: string;
  consumerName?: string;
  batchSize?: number;
  blockMs?: number;
  idleSleepMs?: number;
  taskStatsWindowMinutes?: number;
}

/**
 * Minimal Postgres-backed read models for R2.3 MAS pilot:
 * - mas_session_read_model
 * - mas_task_stats_read_model
 *
 * Layer: Infrastructure (CQRS read side, analytics/observability only).
 */
export class MasReadModelsRepository {
  private readonly schema: string;
  private readonly sessionTable: string;
  private readonly taskStatsTable: string;

  constructor(private readonly db: IDatabaseConnection, schema = 'mas_runtime') {
    this.schema = schema;
    this.sessionTable = `${this.schema}.mas_session_read_model`;
    this.taskStatsTable = `${this.schema}.mas_task_stats_read_model`;
  }

  async initialize(): Promise<void> {
    // Schema
    await this.db.execute(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);

    // MAS Session Read Model (see T010_cqrs_read_models)
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${this.sessionTable} (
        mas_session_id UUID PRIMARY KEY,
        tenant_id UUID NOT NULL,
        scenario_id TEXT,
        status VARCHAR(32) NOT NULL,
        started_at TIMESTAMPTZ NOT NULL,
        completed_at TIMESTAMPTZ,
        failed_at TIMESTAMPTZ,
        last_error_category TEXT,
        tasks_total INT DEFAULT 0,
        tasks_failed INT DEFAULT 0
      );
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_mas_session_read_model_tenant_status_started
        ON ${this.sessionTable} (tenant_id, status, started_at DESC);
    `);

    // MAS Task Stats Read Model (see T010_cqrs_read_models)
    await this.db.execute(`
      CREATE TABLE IF NOT EXISTS ${this.taskStatsTable} (
        tenant_id UUID NOT NULL,
        scenario_id TEXT NOT NULL,
        window_start TIMESTAMPTZ NOT NULL,
        window_end TIMESTAMPTZ NOT NULL,
        tasks_started INT NOT NULL,
        tasks_completed INT NOT NULL,
        tasks_failed INT NOT NULL,
        PRIMARY KEY (tenant_id, scenario_id, window_start, window_end)
      );
    `);

    await this.db.execute(`
      CREATE INDEX IF NOT EXISTS idx_mas_task_stats_read_model_window
        ON ${this.taskStatsTable} (tenant_id, scenario_id, window_start, window_end);
    `);
  }

  async upsertSessionStarted(params: {
    masSessionId: string;
    tenantId: string;
    scenarioId?: string;
    startedAt: Date;
  }): Promise<void> {
    const { masSessionId, tenantId, scenarioId, startedAt } = params;

    await this.db.execute(
      `
      INSERT INTO ${this.sessionTable} (
        mas_session_id,
        tenant_id,
        scenario_id,
        status,
        started_at,
        tasks_total,
        tasks_failed
      )
      VALUES ($1, $2, $3, 'started', $4, 0, 0)
      ON CONFLICT (mas_session_id) DO UPDATE
      SET
        tenant_id = COALESCE(EXCLUDED.tenant_id, ${this.sessionTable}.tenant_id),
        scenario_id = COALESCE(EXCLUDED.scenario_id, ${this.sessionTable}.scenario_id),
        started_at = LEAST(${this.sessionTable}.started_at, EXCLUDED.started_at),
        status = CASE
          WHEN ${this.sessionTable}.status IN ('completed', 'failed') THEN ${this.sessionTable}.status
          ELSE 'started'
        END
      `,
      [masSessionId, tenantId, scenarioId ?? null, startedAt],
    );
  }

  async applySessionCompleted(params: {
    masSessionId: string;
    tenantId: string;
    scenarioId?: string;
    completedAt: Date;
    tasksTotal?: number;
    tasksCompleted?: number;
    tasksFailedFromPayload?: number;
  }): Promise<void> {
    const {
      masSessionId,
      tenantId,
      scenarioId,
      completedAt,
      tasksTotal,
      tasksCompleted,
      tasksFailedFromPayload,
    } = params;

    await this.db.execute(
      `
      INSERT INTO ${this.sessionTable} (
        mas_session_id,
        tenant_id,
        scenario_id,
        status,
        started_at,
        completed_at,
        tasks_total,
        tasks_failed
      )
      VALUES ($1, $2, $3, 'completed', $4, $5, COALESCE($6, 0), COALESCE($7, 0))
      ON CONFLICT (mas_session_id) DO UPDATE
      SET
        tenant_id = COALESCE(EXCLUDED.tenant_id, ${this.sessionTable}.tenant_id),
        scenario_id = COALESCE(EXCLUDED.scenario_id, ${this.sessionTable}.scenario_id),
        status = 'completed',
        completed_at = COALESCE(${this.sessionTable}.completed_at, EXCLUDED.completed_at),
        tasks_total = COALESCE($6, ${this.sessionTable}.tasks_total),
        tasks_failed = COALESCE($7, ${this.sessionTable}.tasks_failed)
      `,
      [
        masSessionId,
        tenantId,
        scenarioId ?? null,
        completedAt, // used as fallback started_at
        completedAt,
        tasksTotal ?? null,
        // Prefer payload tasks_failed if provided; otherwise keep existing
        tasksFailedFromPayload ?? null,
      ],
    );
  }

  async applySessionFailed(params: {
    masSessionId: string;
    tenantId: string;
    scenarioId?: string;
    failedAt: Date;
    lastErrorCategory?: string;
  }): Promise<void> {
    const { masSessionId, tenantId, scenarioId, failedAt, lastErrorCategory } = params;

    await this.db.execute(
      `
      INSERT INTO ${this.sessionTable} (
        mas_session_id,
        tenant_id,
        scenario_id,
        status,
        started_at,
        failed_at,
        last_error_category
      )
      VALUES ($1, $2, $3, 'failed', $4, $5, $6)
      ON CONFLICT (mas_session_id) DO UPDATE
      SET
        tenant_id = COALESCE(EXCLUDED.tenant_id, ${this.sessionTable}.tenant_id),
        scenario_id = COALESCE(EXCLUDED.scenario_id, ${this.sessionTable}.scenario_id),
        status = 'failed',
        failed_at = COALESCE(${this.sessionTable}.failed_at, EXCLUDED.failed_at),
        last_error_category = COALESCE(EXCLUDED.last_error_category, ${this.sessionTable}.last_error_category)
      `,
      [masSessionId, tenantId, scenarioId ?? null, failedAt, failedAt, lastErrorCategory ?? null],
    );
  }

  async applyTaskPlanCreated(params: {
    masSessionId: string;
    tenantId: string;
    scenarioId?: string;
    tasksTotal: number;
    occurredAt: Date;
  }): Promise<void> {
    const { masSessionId, tenantId, scenarioId, tasksTotal, occurredAt } = params;

    await this.db.execute(
      `
      INSERT INTO ${this.sessionTable} (
        mas_session_id,
        tenant_id,
        scenario_id,
        status,
        started_at,
        tasks_total
      )
      VALUES ($1, $2, $3, 'started', $4, $5)
      ON CONFLICT (mas_session_id) DO UPDATE
      SET
        tenant_id = COALESCE(EXCLUDED.tenant_id, ${this.sessionTable}.tenant_id),
        scenario_id = COALESCE(EXCLUDED.scenario_id, ${this.sessionTable}.scenario_id),
        started_at = LEAST(${this.sessionTable}.started_at, EXCLUDED.started_at),
        tasks_total = $5
      `,
      [masSessionId, tenantId, scenarioId ?? null, occurredAt, tasksTotal],
    );
  }

  async incrementSessionTasksFailed(params: {
    masSessionId: string;
    occurredAt: Date;
  }): Promise<void> {
    const { masSessionId, occurredAt } = params;

    await this.db.execute(
      `
      INSERT INTO ${this.sessionTable} (
        mas_session_id,
        tenant_id,
        scenario_id,
        status,
        started_at,
        tasks_total,
        tasks_failed
      )
      VALUES ($1, gen_random_uuid(), NULL, 'started', $2, 0, 1)
      ON CONFLICT (mas_session_id) DO UPDATE
      SET
        tasks_failed = ${this.sessionTable}.tasks_failed + 1,
        started_at = LEAST(${this.sessionTable}.started_at, EXCLUDED.started_at)
      `,
      [masSessionId, occurredAt],
    );
  }

  async applyTaskStatsDelta(params: {
    tenantId: string;
    scenarioId: string;
    windowStart: Date;
    windowEnd: Date;
    startedDelta?: number;
    completedDelta?: number;
    failedDelta?: number;
  }): Promise<void> {
    const {
      tenantId,
      scenarioId,
      windowStart,
      windowEnd,
      startedDelta = 0,
      completedDelta = 0,
      failedDelta = 0,
    } = params;

    if (!startedDelta && !completedDelta && !failedDelta) {
      return;
    }

    await this.db.execute(
      `
      INSERT INTO ${this.taskStatsTable} (
        tenant_id,
        scenario_id,
        window_start,
        window_end,
        tasks_started,
        tasks_completed,
        tasks_failed
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (tenant_id, scenario_id, window_start, window_end) DO UPDATE
      SET
        tasks_started = ${this.taskStatsTable}.tasks_started + EXCLUDED.tasks_started,
        tasks_completed = ${this.taskStatsTable}.tasks_completed + EXCLUDED.tasks_completed,
        tasks_failed = ${this.taskStatsTable}.tasks_failed + EXCLUDED.tasks_failed
      `,
      [
        tenantId,
        scenarioId,
        windowStart,
        windowEnd,
        startedDelta,
        completedDelta,
        failedDelta,
      ],
    );
  }
}

/**
 * MAS Events → Redis Streams → CQRS projectors (R2.3 pilot).
 *
 * - Consumer group: mas-events-projectors
 * - Stream: mas:events
 * - Read models: mas_session_read_model, mas_task_stats_read_model (Postgres)
 */
export class MasEventsRedisStreamsProjector {
  private readonly groupName: string;
  private readonly consumerName: string;
  private readonly batchSize: number;
  private readonly blockMs: number;
  private readonly idleSleepMs: number;
  private readonly taskStatsWindowMinutes: number;

  private running = false;
  private loopPromise?: Promise<void>;

  constructor(
    private readonly streamsClient: MasRedisStreamsClient,
    private readonly repo: MasReadModelsRepository,
    options: MasEventsRedisStreamsProjectorOptions = {},
    private readonly logger?: IStructuredLogger,
  ) {
    const cfg = getConfig();

    this.groupName = options.groupName ?? 'mas-events-projectors';
    this.consumerName =
      options.consumerName ??
      `mas-projector-${process.pid}-${Date.now().toString(36)}`;
    this.batchSize = options.batchSize ?? 50;
    this.blockMs = options.blockMs ?? 5000;
    this.idleSleepMs = options.idleSleepMs ?? 1000;

    const windowRaw =
      typeof options.taskStatsWindowMinutes === 'number'
        ? options.taskStatsWindowMinutes
        : (() => {
            const envValue = cfg.MAS_TASK_STATS_WINDOW_MINUTES;
            if (typeof envValue === 'string' && envValue.trim().length > 0) {
              const n = Number.parseInt(envValue, 10);
              return Number.isFinite(n) && n > 0 ? n : 60;
            }
            return 60;
          })();

    this.taskStatsWindowMinutes = windowRaw;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    await this.repo.initialize();
    await this.streamsClient.ensureConsumerGroup(this.groupName);

    this.running = true;
    this.loopPromise = this.runLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = undefined;
    }
  }

  async close(): Promise<void> {
    await this.stop();
  }

  /**
   * Single iteration (useful for tests).
   */
  async runOnce(): Promise<void> {
    const entries = await this.streamsClient.readGroup(
      this.groupName,
      this.consumerName,
      this.batchSize,
      this.blockMs,
    );

    if (!entries.length) {
      return;
    }

    const ackIds: string[] = [];

    for (const entry of entries) {
      try {
        await this.projectEntry(entry);
        ackIds.push(entry.id);
      } catch (error) {
         
        this.logger?.error(
          '[MasEventsRedisStreamsProjector] Failed to project MAS event from Streams',
          { id: entry.id, error: String(error) },
        );
      }
    }

    if (ackIds.length) {
      await this.streamsClient.ack(this.groupName, ackIds);
    }
  }

  private async runLoop(): Promise<void> {
     
    while (this.running) {
      try {
        await this.runOnce();
      } catch (error) {
         
        this.logger?.error(
          '[MasEventsRedisStreamsProjector] Error in projection loop',
          { error: String(error) },
        );
        await this.sleep(this.idleSleepMs);
      }
    }
  }

  private async projectEntry(entry: MasStreamEntry): Promise<void> {
    // Atomic idempotency check: SET NX ensures only the first worker processes the event
    const processedKey = `projector:processed:${entry.id}`;
    const redis = this.streamsClient.getRedis();
    const setOk = await redis.set(processedKey, '1', 'EX', 86400, 'NX');
    if (setOk === null) {
      return; // Already processed by another worker
    }

    const { fields } = entry;

    const eventType = fields.event_type;
    if (!eventType) {
      return;
    }

    const timestamp =
      (fields.timestamp && new Date(fields.timestamp)) || new Date();
    const payload = this.parsePayload(fields.payload);
    const tenantId = this.nonEmptyString(fields.tenant_id);
    const scenario = this.nonEmptyString(fields.scenario);
    const masSessionId = this.nonEmptyString(
      fields.mas_session_id || fields.session_id,
    );

    // Session read model requires tenant + session identifiers.
    switch (eventType) {
      case 'mas.session.started':
        if (!tenantId || !masSessionId) return;
        await this.repo.upsertSessionStarted({
          masSessionId,
          tenantId,
          scenarioId: scenario || undefined,
          startedAt: timestamp,
        });
        break;

      case 'mas.session.completed': {
        if (!tenantId || !masSessionId) return;
        const tasksTotal =
          typeof payload.tasks_total === 'number' ? payload.tasks_total : undefined;
        const tasksCompleted =
          typeof payload.tasks_completed === 'number'
            ? payload.tasks_completed
            : undefined;
        const tasksFailedFromPayload =
          typeof payload.tasks_failed === 'number'
            ? payload.tasks_failed
            : undefined;

        await this.repo.applySessionCompleted({
          masSessionId,
          tenantId,
          scenarioId: scenario || undefined,
          completedAt: timestamp,
          tasksTotal,
          tasksCompleted,
          tasksFailedFromPayload,
        });
        break;
      }

      case 'mas.session.failed': {
        if (!tenantId || !masSessionId) return;

        const diagnostics =
          (payload.diagnostics as { failure_category?: unknown } | undefined) ??
          undefined;
        const lastErrorCategory =
          diagnostics && typeof diagnostics.failure_category === 'string'
            ? diagnostics.failure_category
            : undefined;

        await this.repo.applySessionFailed({
          masSessionId,
          tenantId,
          scenarioId: scenario || undefined,
          failedAt: timestamp,
          lastErrorCategory,
        });
        break;
      }

      case 'mas.task.plan_created': {
        if (!tenantId || !masSessionId) return;
        const tasksTotal =
          typeof payload.tasks_total === 'number' ? payload.tasks_total : undefined;
        if (typeof tasksTotal !== 'number') {
          return;
        }
        await this.repo.applyTaskPlanCreated({
          masSessionId,
          tenantId,
          scenarioId: scenario || undefined,
          tasksTotal,
          occurredAt: timestamp,
        });
        break;
      }

      case 'mas.task.failed': {
        const sessionIdFromPayload = this.nonEmptyString(
          payload.mas_session_id || payload.session_id,
        );
        const effectiveSessionId = masSessionId || sessionIdFromPayload;
        if (effectiveSessionId) {
          await this.repo.incrementSessionTasksFailed({
            masSessionId: effectiveSessionId,
            occurredAt: timestamp,
          });
        }
        break;
      }

      default:
        break;
    }

    // Task stats read model aggregations by window
    if (
      eventType === 'mas.task.started' ||
      eventType === 'mas.task.completed' ||
      eventType === 'mas.task.failed'
    ) {
      if (!tenantId || !scenario) {
        return;
      }
      const { windowStart, windowEnd } = this.computeWindow(timestamp);
      const deltas = {
        startedDelta: eventType === 'mas.task.started' ? 1 : 0,
        completedDelta: eventType === 'mas.task.completed' ? 1 : 0,
        failedDelta: eventType === 'mas.task.failed' ? 1 : 0,
      };
      await this.repo.applyTaskStatsDelta({
        tenantId,
        scenarioId: scenario,
        windowStart,
        windowEnd,
        ...deltas,
      });
    }
  }

  private computeWindow(timestamp: Date): { windowStart: Date; windowEnd: Date } {
    const windowMinutes = this.taskStatsWindowMinutes;
    const windowMs = windowMinutes * 60_000;
    const t = timestamp.getTime();
    const windowStartMs = Math.floor(t / windowMs) * windowMs;
    const windowEndMs = windowStartMs + windowMs;
    return {
      windowStart: new Date(windowStartMs),
      windowEnd: new Date(windowEndMs),
    };
  }

  private parsePayload(raw: string | undefined): Record<string, unknown> {
    if (!raw) {
      return {};
    }
    const parsed = tryJsonParse<unknown>(raw);
    if (parsed.ok && parsed.value && typeof parsed.value === 'object') {
      return parsed.value as Record<string, unknown>;
    }
    return {};
  }

  private nonEmptyString(value: unknown): string {
    if (value == null) return '';
    const s = String(value).trim();
    return s.length > 0 ? s : '';
  }

  private async sleep(ms: number): Promise<void> {
    if (ms <= 0) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}