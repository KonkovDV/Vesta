/**
 * PostgreSQL Event Store - минимальная реализация интерфейса интерфейса IEventStore
 * Layer: Infrastructure
 */

import { Pool, PoolConfig } from 'pg';
import type {
  IEventStore,
  DomainEvent,
  SaveEventsOptions,
  SaveEventsResult,
  EventStoreStats,
  Snapshot,
} from '../../domain/events/event-store.interface';
import type { SemanticEventResult, EventEmbeddingUpdate } from '../../domain/memory/IEventVectorizer';
import { applyEventUpcasters } from '../../domain/events/event-upcaster-registry';
import { getOrCreateCounter, getOrCreateGauge, getOrCreateHistogram } from '../../monitoring';
import { buildPgSslConfig } from '../persistence/pg-ssl-config';
import {
  getMetricsConfig,
} from '../../core/config/app-config';
import { CorrelationIdProvider } from '../../core/correlation/correlation';
import { isValidPostgresIdentifier, qualifyIdentifier } from '../database/postgres-identifiers';
import { requireQualifiedTables, runtimeDdlEnabled } from '../database/runtime-ddl';
import { endPool } from '../database/end-pool';
import { lockAggregateForWrite } from './postgres-outbox';
import { getConfig } from '../../config';
import { tryJsonParse } from '../../core/utils/json';
import { ConcurrencyError } from '../../domain/errors/DomainError';
import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';

import type {
  CommitCursor,
  CommittedEventsPage,
  ICommitOrderReader,
  IConsumerCursorStore,
} from '../../domain/events/commit-order.port';

export type { CommitCursor } from '../../domain/events/commit-order.port';

interface PostgresEventStoreConfig {
  connection: PoolConfig;
  schema?: string;
  eventsTable?: string;
  snapshotsTable?: string;
}

const DEFAULT_SCHEMA = 'event_store';
const DEFAULT_EVENTS_TABLE = 'events';
const DEFAULT_SNAPSHOTS_TABLE = 'snapshots';

// Prometheus metrics for Event Store (global register); guarded centrally via getMetricsConfig().enabled and not in tests
const {
  JEST_WORKER_ID,
  NODE_ENV,
  EVENT_STORE_LOGS,
} = getConfig();
const isTestEnv = Boolean(JEST_WORKER_ID || NODE_ENV === 'test');
const { enabled, eventLatencyBucketsMs } = getMetricsConfig();
const ES_METRICS_ON = enabled && !isTestEnv;

/** Columns the domain event needs. The embedding vector stays out of these reads. */
const EVENT_READ_COLUMNS =
  'event_id, event_type, aggregate_id, aggregate_version, correlation_id, causation_id, timestamp, schema_version, payload, metadata, gsn';

const ES_APPENDS_TOTAL = getOrCreateCounter(
  'event_store_appends_total',
  'Total domain events appended',
  ['event_type'],
);
const ES_APPEND_LATENCY_MS = getOrCreateHistogram(
  'event_store_append_latency_ms',
  'Latency of saving events batch (ms)',
  [],
  eventLatencyBucketsMs,
);
const ES_LATEST_GSN_GAUGE = getOrCreateGauge(
  'event_store_latest_gsn',
  'Latest global sequence number (GSN) in the event store',
  ['schema', 'write_primary_mode'],
);
const ES_GSN_LAG_HISTOGRAM = getOrCreateHistogram(
  'event_store_gsn_lag',
  'Lag in GSN between latest GSN and caller cursor (fromExclusiveGsn)',
  ['write_primary_mode'],
);
const ES_CONCURRENCY_CONFLICTS_TOTAL = getOrCreateCounter(
  'event_store_concurrency_conflicts_total',
  'Total number of Event Store concurrency conflicts grouped by reason, mode and constraint',
  ['reason', 'write_primary_mode', 'constraint'],
);
const ES_APPENDS_FAILED_TOTAL = getOrCreateCounter(
  'event_store_appends_failed_total',
  'Total number of failed Event Store append operations grouped by error class and mode',
  ['error_class', 'write_primary_mode'],
);
const ES_GET_EVENTS_BY_GSN_RANGE_LATENCY_MS = getOrCreateHistogram(
  'event_store_get_events_by_gsn_range_latency_ms',
  'Latency of getEventsByGsnRange (ms)',
  ['write_primary_mode', 'has_cursor'],
  eventLatencyBucketsMs,
);
const ES_MODE_STATE_GAUGE = getOrCreateGauge(
  'event_store_mode_state',
  'Current Event Store mode state per schema. The value is 1: one events table.',
  ['schema', 'write_primary_mode'],
);

export class PostgresEventStore implements IEventStore, ICommitOrderReader, IConsumerCursorStore {
  private readonly pool: Pool;
  private readonly onPoolError: (err: Error) => void;
  private readonly schema: string;
  private readonly eventsTable: string;
  private readonly snapshotsTable: string;
  private readonly qualifiedEventsTable: string;
  private readonly qualifiedSnapshotsTable: string;
  private readonly qualifiedCursorsTable: string;

  constructor(private readonly cfg: PostgresEventStoreConfig, private readonly logger?: IStructuredLogger) {
    this.pool = new Pool({
      ...cfg.connection,
      keepAlive: cfg.connection.keepAlive ?? true,
      keepAliveInitialDelayMillis: cfg.connection.keepAliveInitialDelayMillis ?? 10000,
      statement_timeout: ((cfg.connection as Record<string, unknown>).statementTimeoutMs ?? 30000) as number,
    });
    this.onPoolError = (err: Error) => {
      this.logger?.error('PostgresEventStore connection error', { error: err.message });
      if (!this.logger) {
        console.error('PostgresEventStore connection error:', err);
      }
    };
    this.pool.on('error', this.onPoolError);
    this.schema = cfg.schema || DEFAULT_SCHEMA;
    this.eventsTable = cfg.eventsTable || DEFAULT_EVENTS_TABLE;
    this.snapshotsTable = cfg.snapshotsTable || DEFAULT_SNAPSHOTS_TABLE;

    if (!isValidPostgresIdentifier(this.schema)) {
      throw new Error(`Invalid PostgreSQL Event Store schema name: "${this.schema}"`);
    }
    if (!isValidPostgresIdentifier(this.eventsTable)) {
      throw new Error(`Invalid PostgreSQL Event Store events table name: "${this.eventsTable}"`);
    }
    if (!isValidPostgresIdentifier(this.snapshotsTable)) {
      throw new Error(
        `Invalid PostgreSQL Event Store snapshots table name: "${this.snapshotsTable}"`,
      );
    }

    this.qualifiedEventsTable = qualifyIdentifier(
      this.schema,
      this.eventsTable,
      'PostgresEventStore.events',
    );
    this.qualifiedSnapshotsTable = qualifyIdentifier(
      this.schema,
      this.snapshotsTable,
      'PostgresEventStore.snapshots',
    );
    this.qualifiedCursorsTable = qualifyIdentifier(
      this.schema,
      'consumer_cursors',
      'PostgresEventStore.consumerCursors',
    );
  }

  async initialize(): Promise<void> {
    const client = await this.pool.connect();
    try {
      if (!runtimeDdlEnabled()) {
        await requireQualifiedTables(
          (sql, params) => client.query(sql, params),
          [`${this.schema}.${this.eventsTable}`, `${this.schema}.${this.snapshotsTable}`],
        );
        return;
      }
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.${this.eventsTable} (
          event_id VARCHAR(255) PRIMARY KEY,
          event_type VARCHAR(100) NOT NULL,
          aggregate_id VARCHAR(255) NOT NULL,
          aggregate_version INTEGER NOT NULL,
          correlation_id VARCHAR(255) NOT NULL,
          causation_id VARCHAR(255),
          timestamp TIMESTAMP NOT NULL,
          schema_version INTEGER NOT NULL DEFAULT 1,
          payload JSONB NOT NULL,
          metadata JSONB
        );
      `);
      await client.query(`
        ALTER TABLE ${this.schema}.${this.eventsTable}
        ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1
      `);
      await client.query(`
        ALTER TABLE ${this.schema}.${this.eventsTable}
        ADD COLUMN IF NOT EXISTS gsn BIGINT
      `);
      await client.query(`
        CREATE SEQUENCE IF NOT EXISTS event_store_events_gsn_seq;
      `);
      await client.query(`
        ALTER TABLE ${this.schema}.${this.eventsTable}
        ALTER COLUMN gsn SET DEFAULT nextval('event_store_events_gsn_seq')
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_events_gsn
        ON ${this.schema}.${this.eventsTable}(gsn);
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_events_agg_id_version_unique
        ON ${this.schema}.${this.eventsTable}(aggregate_id, aggregate_version);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_events_correlation ON ${this.schema}.${this.eventsTable}(correlation_id);
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.schema}.${this.snapshotsTable} (
          aggregate_id VARCHAR(255) PRIMARY KEY,
          version INTEGER NOT NULL,
          timestamp TIMESTAMP NOT NULL,
          data JSONB NOT NULL,
          metadata JSONB
        );
      `);
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
    this.pool.off('error', this.onPoolError);
    await endPool(this.pool);
  }

  async saveEvents(events: DomainEvent[], options?: SaveEventsOptions): Promise<SaveEventsResult> {
    if (!events || events.length === 0) {
      return {
        success: true,
        savedCount: 0,
        savedAt: new Date(),
        aggregateVersion: 0,
        savedEvents: [],
      };
    }

    const aggregateId = events[0].aggregateId;
    const opStart = Date.now();
    const maxAttempts = 5;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const client = await this.pool.connect();
      try {
        await client.query('BEGIN');
        // Writers of one aggregate queue on a transaction lock, then read the
        // committed maximum version. Locking only the previous head row misses
        // an insert that landed after that row. READ COMMITTED is enough: the
        // unique version index rejects a duplicate, and this lock stops the race.
        await lockAggregateForWrite(client, aggregateId);

        const versionSourceTable = `${this.schema}.${this.eventsTable}`;

        const latestRes = await client.query(
          `SELECT COALESCE(MAX(aggregate_version), 0) AS v
           FROM ${versionSourceTable}
           WHERE aggregate_id = $1`,
          [aggregateId],
        );
        const currentVersion =
          latestRes.rowCount && latestRes.rows[0]?.v != null
            ? parseInt(String(latestRes.rows[0].v), 10)
            : 0;

        if (typeof options?.expectedAggregateVersion === 'number') {
          if (currentVersion !== options.expectedAggregateVersion) {
            const conflictError = new ConcurrencyError(
              `Aggregate ${aggregateId} version conflict: expected ${options.expectedAggregateVersion}, actual ${currentVersion}`,
              {
                metadata: {
                  aggregateId,
                  expectedVersion: options.expectedAggregateVersion,
                  actualVersion: currentVersion,
                },
              },
            );

            if (ES_METRICS_ON) {
              this.recordConcurrencyConflictMetrics('aggregate_version');
              this.recordAppendFailedMetrics(conflictError);
            }

            throw conflictError;
          }
        }

        let nextVersion = currentVersion;

        // A-008 FIX: Use batch INSERT to prevent pool starvation
        // Build all event data first, then insert in a single query for the primary table
        const eventData = events.map((e, idx) => {
          const version = currentVersion + idx + 1;
          const normalizedCorrelationId =
            typeof e.correlationId === 'string' && CorrelationIdProvider.isValid(e.correlationId)
              ? e.correlationId.trim()
              : CorrelationIdProvider.generate();
          const schemaVersion =
            typeof e.schemaVersion === 'number' && e.schemaVersion > 0 ? e.schemaVersion : 1;

          return {
            eventId: e.eventId,
            type: e.type,
            aggregateId: e.aggregateId,
            version,
            correlationId: normalizedCorrelationId,
            causationId: e.causationId || null,
            timestamp: e.timestamp,
            schemaVersion,
            payload: JSON.stringify(e.payload || {}),
            metadata: e.metadata ? JSON.stringify(e.metadata) : null,
          };
        });

        nextVersion = currentVersion + events.length;

        const canonicalResult = await client.query(
          `INSERT INTO ${this.schema}.${this.eventsTable}
             (event_id, event_type, aggregate_id, aggregate_version, correlation_id, causation_id, timestamp, schema_version, payload, metadata)
           SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::text[], $7::timestamp[], $8::int[], $9::jsonb[], $10::jsonb[])
           AS t(event_id, event_type, aggregate_id, aggregate_version, correlation_id, causation_id, timestamp, schema_version, payload, metadata)
           RETURNING gsn`,
          [
            eventData.map(e => e.eventId),
            eventData.map(e => e.type),
            eventData.map(e => e.aggregateId),
            eventData.map(e => e.version),
            eventData.map(e => e.correlationId),
            eventData.map(e => e.causationId),
            eventData.map(e => e.timestamp),
            eventData.map(e => e.schemaVersion),
            eventData.map(e => e.payload),
            eventData.map(e => e.metadata),
          ],
        );

        if (canonicalResult.rows.length !== events.length) {
          throw new Error(
            `[PostgresEventStore] Batch insert returned ${canonicalResult.rows.length} rows, expected ${events.length}`,
          );
        }

        // Build saved events list and emit metrics/logs
        const saved: Array<{ eventId: string; type: string }> = [];
        for (let i = 0; i < events.length; i++) {
          const e = events[i];
          const data = eventData[i];
          saved.push({ eventId: e.eventId, type: e.type });

          if (ES_METRICS_ON) {
            ES_APPENDS_TOTAL.labels(e.type).inc();
          }
          if (EVENT_STORE_LOGS === 'json') {
            this.logger?.info('event_store_append', {
              event_type: e.type,
              event_id: e.eventId,
              aggregate_id: e.aggregateId,
              correlation_id: data.correlationId,
              ts: new Date().toISOString(),
            });
          }
        }

        await client.query('COMMIT');

        if (ES_METRICS_ON) {
          ES_APPEND_LATENCY_MS.observe(Date.now() - opStart);
        }
        if (EVENT_STORE_LOGS === 'json') {
          this.logger?.info('event_store_commit', {
            saved_count: saved.length,
            aggregate_id: aggregateId,
            ts: new Date().toISOString(),
          });
        }

        return {
          success: true,
          savedCount: saved.length,
          savedAt: new Date(),
          aggregateVersion: nextVersion,
          savedEvents: saved,
        };
      } catch (error) {
        // ROLLBACK best-effort — ошибки при откате игнорируем
        try {
          await client.query('ROLLBACK');
        } catch {
          // ignore
        }

        const pgError = error as { code?: string; constraint?: string };
        // 40001/40P01 — сериализация/дедлок, перезапускаем транзакцию с экспоненциальным backoff
        if (pgError?.code === '40001' || pgError?.code === '40P01') {
          const delay = 10 * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // 23505 — нарушение уникальности (например, по (aggregate_id, aggregate_version))
        if (pgError?.code === '23505') {
          const conflictError = new ConcurrencyError(
            'Event version conflict detected while saving events',
            {
              metadata: {
                aggregateId,
                constraint: pgError.constraint,
              },
            },
          );

          if (ES_METRICS_ON) {
            this.recordConcurrencyConflictMetrics('aggregate_version', pgError.constraint);
            this.recordAppendFailedMetrics(conflictError);
          }

          throw conflictError;
        }

        if (ES_METRICS_ON && !(error instanceof ConcurrencyError)) {
          this.recordAppendFailedMetrics(error);
        }

        throw error;
      } finally {
        client.release();
      }
    }
 
    const finalError = new Error(
      'Failed to save events after retrying concurrent write conflicts',
    );
 
    if (ES_METRICS_ON) {
      this.recordAppendFailedMetrics(finalError);
    }
 
    throw finalError;
  }

  private async getCanonicalEvents(
    aggregateId: string,
    fromVersion = 1,
  ): Promise<DomainEvent[]> {
    const res = await this.pool.query(
      `SELECT ${EVENT_READ_COLUMNS}
       FROM ${this.schema}.${this.eventsTable}
       WHERE aggregate_id = $1 AND aggregate_version >= $2
       ORDER BY aggregate_version ASC`,
      [aggregateId, fromVersion],
    );

    return res.rows.map(rowToEvent);
  }

  /**
   * True when this aggregate already has one event of the type.
   * The common path reads no payload.
   */
  async hasEventOfType(aggregateId: string, eventType: string): Promise<boolean> {
    const res = await this.pool.query(
      `SELECT 1
       FROM ${this.schema}.${this.eventsTable}
       WHERE aggregate_id = $1 AND event_type = $2
       LIMIT 1`,
      [aggregateId, eventType],
    );
    return (res.rowCount ?? res.rows.length) > 0;
  }

  async getEvents(aggregateId: string, fromVersion = 1): Promise<DomainEvent[]> {
    return this.getCanonicalEvents(aggregateId, fromVersion);
  }

  async getEventsByCorrelationId(correlationId: string): Promise<DomainEvent[]> {
    const res = await this.pool.query(
      `SELECT ${EVENT_READ_COLUMNS} FROM ${this.schema}.${this.eventsTable} WHERE correlation_id = $1 ORDER BY timestamp ASC`,
      [correlationId]
    );
    return res.rows.map(rowToEvent);
  }

  async getEventsByCausationId(causationId: string): Promise<DomainEvent[]> {
    const res = await this.pool.query(
      `SELECT ${EVENT_READ_COLUMNS} FROM ${this.schema}.${this.eventsTable} WHERE causation_id = $1 ORDER BY timestamp ASC`,
      [causationId]
    );
    return res.rows.map(rowToEvent);
  }

  async getEventsByType(type: string, fromDate?: Date): Promise<DomainEvent[]> {
    const params: unknown[] = [type];
    let sql = `SELECT ${EVENT_READ_COLUMNS} FROM ${this.schema}.${this.eventsTable} WHERE event_type = $1`;
    if (fromDate) {
      sql += ' AND timestamp >= $2';
      params.push(fromDate);
    }
    sql += ' ORDER BY timestamp ASC';
    const res = await this.pool.query(sql, params);
    return res.rows.map(rowToEvent);
  }

  async getEventsByGsnRange(
    fromExclusiveGsn: number | null,
    limit: number,
  ): Promise<DomainEvent[]> {
    const safeLimit =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : 1;
 
    const gsnSourceTable = `${this.schema}.${this.eventsTable}`;
 
    const params: unknown[] = [];
    let whereClause = 'gsn IS NOT NULL';
 
    const hasCursor =
      typeof fromExclusiveGsn === 'number' && Number.isFinite(fromExclusiveGsn);
 
    if (hasCursor) {
      whereClause += ' AND gsn > $1';
      params.push(fromExclusiveGsn);
    }
 
    const limitParamIndex = params.length + 1;
 
    const opStart = ES_METRICS_ON ? Date.now() : 0;
 
    const res = await this.pool.query(
      ES_METRICS_ON
        ? `SELECT e.event_id, e.event_type, e.aggregate_id, e.aggregate_version, e.correlation_id, e.causation_id, e.timestamp, e.schema_version, e.payload, e.metadata, e.gsn, latest.max_gsn
           FROM (SELECT MAX(gsn) AS max_gsn FROM ${gsnSourceTable} WHERE gsn IS NOT NULL) latest
           LEFT JOIN LATERAL (
             SELECT ${EVENT_READ_COLUMNS}
             FROM ${gsnSourceTable}
             WHERE ${whereClause}
             ORDER BY gsn ASC
             LIMIT $${limitParamIndex}
           ) e ON true`
        : `SELECT ${EVENT_READ_COLUMNS}
           FROM ${gsnSourceTable}
           WHERE ${whereClause}
           ORDER BY gsn ASC
           LIMIT $${limitParamIndex}`,
      [...params, safeLimit],
    );

    const events = res.rows.filter((row) => row.event_id != null).map(rowToEvent);
    const latestGsn = ES_METRICS_ON ? gsnNumber(res.rows[0]?.max_gsn) : null;
 
    if (ES_METRICS_ON) {
      try {
        const durationMs = Date.now() - opStart;
 
        ES_GET_EVENTS_BY_GSN_RANGE_LATENCY_MS.labels(
          'events',
          hasCursor ? 'true' : 'false',
        ).observe(durationMs);
      } catch {
        // Observability must never break core Event Store flows.
      }
    }
 
    this.recordEventStoreLagMetrics(
      latestGsn,
      typeof fromExclusiveGsn === 'number' && Number.isFinite(fromExclusiveGsn)
        ? fromExclusiveGsn
        : null,
    );
 
    return events;
  }

  /**
   * Events in commit order after `cursor`, never past a transaction that may still
   * commit. Unlike a gsn range this does not skip an event whose transaction drew
   * a lower gsn and committed later (MP-K23). Needs migration 003. Canonical table only.
   */
  async getCommittedEventsAfter(cursor: CommitCursor | null, limit = 500): Promise<CommittedEventsPage> {
    // Rows below the snapshot xmin come first in (tx_id, gsn) order; those are released.
    // One row past the page shows whether a committed row waits behind an open transaction.
    const res = await this.pool.query(
      `SELECT ${EVENT_READ_COLUMNS}, tx_id::text AS tx_id,
              tx_id < pg_snapshot_xmin(pg_current_snapshot()) AS released
         FROM ${this.qualifiedEventsTable}
        WHERE (tx_id, gsn) > ($1::xid8, $2::bigint)
        ORDER BY tx_id, gsn
        LIMIT $3`,
      [cursor?.txId ?? '0', cursor?.gsn ?? 0, limit + 1],
    );
    const firstHeld = res.rows.findIndex((row) => row.released !== true);
    const releasedRows = res.rows.slice(0, Math.min(limit, firstHeld === -1 ? res.rows.length : firstHeld));
    const events = releasedRows.map(rowToEvent);
    const last = releasedRows.at(-1) as { tx_id: string; gsn: string | number } | undefined;
    const held = firstHeld === -1 ? undefined : (res.rows[firstHeld] as { timestamp: string });
    return {
      events,
      cursor: last ? { txId: String(last.tx_id), gsn: Number(last.gsn) } : cursor,
      ...(held ? { heldSince: new Date(held.timestamp) } : {}),
    };
  }

  /** Needs migration 004. */
  async loadConsumerCursor(consumer: string): Promise<CommitCursor | null> {
    const res = await this.pool.query(
      `SELECT tx_id::text AS tx_id, gsn FROM ${this.qualifiedCursorsTable} WHERE consumer = $1`,
      [consumer],
    );
    const row = res.rows[0] as { tx_id: string; gsn: string | number } | undefined;
    return row ? { txId: row.tx_id, gsn: Number(row.gsn) } : null;
  }

  /** Moves the cursor forward only; an older position is ignored. Needs migration 004. */
  async saveConsumerCursor(consumer: string, cursor: CommitCursor): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.qualifiedCursorsTable} AS c (consumer, tx_id, gsn)
       VALUES ($1, $2::xid8, $3::bigint)
       ON CONFLICT (consumer) DO UPDATE SET tx_id = EXCLUDED.tx_id, gsn = EXCLUDED.gsn, updated_at = now()
        WHERE (c.tx_id, c.gsn) < (EXCLUDED.tx_id, EXCLUDED.gsn)`,
      [consumer, cursor.txId, cursor.gsn],
    );
  }

  async getLatestGsn(): Promise<number | null> {
    const gsnSourceTable = `${this.schema}.${this.eventsTable}`;

    const res = await this.pool.query(
      `SELECT MAX(gsn) AS max_gsn FROM ${gsnSourceTable} WHERE gsn IS NOT NULL`,
    );

    const numeric = gsnNumber(res.rows[0]?.max_gsn);
    if (numeric !== null) {
      this.recordEventStoreLagMetrics(numeric);
    }
    return numeric;
  }

  async getLatestEventVersion(aggregateId: string): Promise<number> {
    const versionSourceTable = `${this.schema}.${this.eventsTable}`;

    const res = await this.pool.query(
      `SELECT COALESCE(MAX(aggregate_version), 0) AS v FROM ${versionSourceTable} WHERE aggregate_id = $1`,
      [aggregateId],
    );
    return parseInt(res.rows[0]?.v || '0', 10);
  }

  async exists(aggregateId: string): Promise<boolean> {
    const versionSourceTable = `${this.schema}.${this.eventsTable}`;

    const res = await this.pool.query(
      `SELECT 1 FROM ${versionSourceTable} WHERE aggregate_id = $1 LIMIT 1`,
      [aggregateId],
    );
    return (res.rowCount ?? 0) > 0;
  }

  async getEventCount(aggregateId: string): Promise<number> {
    const versionSourceTable = `${this.schema}.${this.eventsTable}`;

    const res = await this.pool.query(
      `SELECT COUNT(*) AS cnt FROM ${versionSourceTable} WHERE aggregate_id = $1`,
      [aggregateId],
    );
    return parseInt(res.rows[0]?.cnt || '0', 10);
  }

  async *getEventStream(aggregateId: string, fromVersion = 1): AsyncIterable<DomainEvent> {
    const events = await this.getEvents(aggregateId, fromVersion);
    for (const e of events) {
      yield e;
    }
  }

  async getStats(): Promise<EventStoreStats> {
    const statsSourceTable = `${this.schema}.${this.eventsTable}`;

    const res = await this.pool.query(
      `SELECT COUNT(*) AS total, MAX(timestamp) AS last FROM ${statsSourceTable}`,
    );
    const totalEvents = parseInt(res.rows[0]?.total || '0', 10);
    return {
      totalEvents,
      totalAggregates: 0,
      eventsByType: {},
      averageEventSize: 0,
      lastEventAt: res.rows[0]?.last ? new Date(res.rows[0].last) : undefined,
      totalSize: 0,
      totalSnapshots: 0,
    };
  }

  private recordEventStoreLagMetrics(
    latestGsn: number | null,
    fromExclusiveGsn?: number | null,
  ): void {
    if (!ES_METRICS_ON) {
      return;
    }

    try {
      const modeCode = 1;

      ES_MODE_STATE_GAUGE.set(
        {
          schema: this.schema,
          write_primary_mode: 'events',
        },
        modeCode,
      );

      if (latestGsn == null) {
        return;
      }

      ES_LATEST_GSN_GAUGE.set(
        {
          schema: this.schema,
          write_primary_mode: 'events',
        },
        latestGsn,
      );

      if (
        typeof fromExclusiveGsn === 'number' &&
        Number.isFinite(fromExclusiveGsn) &&
        fromExclusiveGsn >= 0 &&
        fromExclusiveGsn <= latestGsn
      ) {
        const lag = latestGsn - fromExclusiveGsn;

        ES_GSN_LAG_HISTOGRAM.labels('events').observe(lag);
      }
    } catch {
      // Observability must never break core Event Store flows.
    }
  }

  private recordAppendFailedMetrics(error: unknown): void {
    if (!ES_METRICS_ON) {
      return;
    }

    try {
      const errorClass = error instanceof ConcurrencyError ? 'ConcurrencyError' : 'Other';

      ES_APPENDS_FAILED_TOTAL.labels(errorClass, 'events').inc();
    } catch {
      // Observability must never break core Event Store flows.
    }
  }

  private recordConcurrencyConflictMetrics(reason: string, constraint?: string): void {
    if (!ES_METRICS_ON) {
      return;
    }

    try {
      ES_CONCURRENCY_CONFLICTS_TOTAL.labels(
        reason,
        'events',
        constraint || '',
      ).inc();
    } catch {
      // Observability must never break core Event Store flows.
    }
  }

  async saveSnapshot(aggregateId: string, version: number, snapshot: Record<string, unknown>): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${this.schema}.${this.snapshotsTable} (aggregate_id, version, timestamp, data)
       VALUES ($1,$2, CURRENT_TIMESTAMP, $3)
       ON CONFLICT (aggregate_id) DO UPDATE SET version = EXCLUDED.version, timestamp = CURRENT_TIMESTAMP, data = EXCLUDED.data`,
      [aggregateId, version, JSON.stringify(snapshot)]
    );
  }

  /**
   * Snapshot plus only the events after it, in one query.
   */
  async loadAggregate(aggregateId: string): Promise<{ snapshot: Snapshot | null; events: DomainEvent[] }> {
    const res = await this.pool.query(
      `SELECT
         s.version AS snapshot_version,
         s.timestamp AS snapshot_timestamp,
         s.data AS snapshot_data,
         s.metadata AS snapshot_metadata,
         e.event_id,
         e.event_type,
         e.aggregate_id,
         e.aggregate_version,
         e.correlation_id,
         e.causation_id,
         e.timestamp,
         e.schema_version,
         e.payload,
         e.metadata,
         e.gsn
       FROM (SELECT $1::text AS aggregate_id) AS requested
       LEFT JOIN LATERAL (
         SELECT version, timestamp, data, metadata
         FROM ${this.qualifiedSnapshotsTable}
         WHERE aggregate_id = requested.aggregate_id
         ORDER BY version DESC
         LIMIT 1
       ) s ON true
       LEFT JOIN ${this.qualifiedEventsTable} e
         ON e.aggregate_id = requested.aggregate_id
        AND e.aggregate_version >= COALESCE(s.version, 0) + 1
       ORDER BY e.aggregate_version ASC NULLS FIRST`,
      [aggregateId],
    );

    return rowsToAggregateLoad(aggregateId, res.rows);
  }

  async getSnapshot(aggregateId: string, maxVersion?: number): Promise<Snapshot | null> {
    const params: unknown[] = [aggregateId];
    let sql = `SELECT aggregate_id, version, timestamp, data, metadata FROM ${this.schema}.${this.snapshotsTable} WHERE aggregate_id = $1`;
    if (maxVersion != null) {
      sql += ' AND version <= $2';
      params.push(maxVersion);
    }
    sql += ' ORDER BY version DESC LIMIT 1';
    const res = await this.pool.query(sql, params);
    if (res.rowCount === 0) return null;
    const row = res.rows[0];
    return {
      aggregateId: row.aggregate_id,
      version: row.version,
      timestamp: new Date(row.timestamp),
      data: parseJsonColumnValue(row.data) as Record<string, unknown>,
      metadata:
        row.metadata !== undefined && row.metadata !== null
          ? (parseJsonColumnValue(row.metadata) as Record<string, unknown>)
          : undefined,
    };
  }

  // ─── Semantic Event Sourcing (Этап 6) ───────────────────

  async updateEventEmbeddings(updates: EventEmbeddingUpdate[]): Promise<void> {
    if (updates.length === 0) return;

    // Batch UPDATE via unnest(): single SQL statement instead of N+1 loop.
    // Atomicity is guaranteed by single-statement transaction (no BEGIN/COMMIT needed).
    const eventIds = updates.map((u) => u.eventId);
    const embeddings = updates.map((u) => `[${u.embedding.join(',')}]`);

    await this.pool.query(
      `UPDATE ${this.qualifiedEventsTable} AS e
       SET semantic_embedding = v.emb::vector
       FROM unnest($1::text[], $2::text[]) AS v(eid, emb)
       WHERE e.event_id = v.eid`,
      [eventIds, embeddings],
    );
  }

  async getSemanticallySimilarEvents(
    queryVector: number[],
    limit: number,
    options?: { namespace?: string; minSimilarity?: number },
  ): Promise<SemanticEventResult[]> {
    const vectorSql = `[${queryVector.join(',')}]`;

    let sql = `
      SELECT event_id, event_type, payload, timestamp, aggregate_id,
             1 - (semantic_embedding <=> $1::vector) AS similarity
      FROM ${this.qualifiedEventsTable}
      WHERE semantic_embedding IS NOT NULL`;

    const params: unknown[] = [vectorSql];
    let paramIdx = 2;

    if (options?.minSimilarity !== undefined) {
      sql += ` AND 1 - (semantic_embedding <=> $1::vector) >= $${paramIdx}`;
      params.push(options.minSimilarity);
      paramIdx++;
    }

    sql += ` ORDER BY semantic_embedding <=> $1::vector LIMIT $${paramIdx}`;
    params.push(limit);

    const res = await this.pool.query(sql, params);
    return res.rows.map((row: Record<string, unknown>) => ({
      eventId: row.event_id as string,
      type: row.event_type as string,
      payload: parseJsonColumnValue(row.payload) as Record<string, unknown>,
      timestamp: new Date(row.timestamp as string),
      aggregateId: row.aggregate_id as string,
      similarity: Number(row.similarity),
    }));
  }
}

export function createPostgreSQLEventStore(config: PostgresEventStoreConfig): IEventStore {
  return new PostgresEventStore(config);
}

export function createPostgreSQLEventStoreFromEnv(): IEventStore {
  const config = getConfig();

  const port =
    config.DB_PORT && config.DB_PORT.length > 0
      ? Number.parseInt(config.DB_PORT, 10)
      : undefined;

  const ssl = buildPgSslConfig(config as unknown as Record<string, string | undefined>);

  const cfg: PostgresEventStoreConfig = {
    connection: {
      connectionString: config.DATABASE_URL,
      host: config.DB_HOST,
      port,
      database: config.DB_NAME,
      user: config.DB_USER,
      password: config.DB_PASSWORD,
      ssl,
    },
    schema: config.EVENT_STORE_SCHEMA || DEFAULT_SCHEMA,
    eventsTable: config.EVENT_STORE_EVENTS_TABLE || DEFAULT_EVENTS_TABLE,
    snapshotsTable: config.EVENT_STORE_SNAPSHOTS_TABLE || DEFAULT_SNAPSHOTS_TABLE,
  };

  return new PostgresEventStore(cfg);
}

function parseJsonColumnValue(value: unknown): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  const result = tryJsonParse<unknown>(value);
  if (result.ok) {
    return result.value;
  }
  // @audit-ok: module-level utility, no DI context
  console.error('Failed to parse JSON column in PostgresEventStore', {
    error: result.error.message,
  });
  return value;
}

function gsnNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  return Number.isNaN(numeric) ? null : numeric;
}

function rowsToAggregateLoad(
  aggregateId: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): { snapshot: Snapshot | null; events: DomainEvent[] } {
  const first = rows[0];
  const snapshotVersion = first?.snapshot_version;
  const snapshot = snapshotVersion == null
    ? null
    : {
        aggregateId,
        version: Number(snapshotVersion),
        timestamp: new Date(String(first.snapshot_timestamp)),
        data: parseJsonColumnValue(first.snapshot_data) as Record<string, unknown>,
        metadata:
          first.snapshot_metadata == null
            ? undefined
            : (parseJsonColumnValue(first.snapshot_metadata) as Record<string, unknown>),
      };

  const events = rows
    .filter((row) => row.event_id != null)
    .map((row) => rowToEvent({
      event_id: String(row.event_id),
      event_type: String(row.event_type),
      aggregate_id: String(row.aggregate_id),
      aggregate_version: Number(row.aggregate_version),
      correlation_id: (row.correlation_id ?? null) as string | null,
      causation_id: (row.causation_id ?? null) as string | null,
      timestamp: String(row.timestamp),
      schema_version: (row.schema_version ?? null) as number | null,
      payload: row.payload,
      metadata: row.metadata,
      gsn: (row.gsn ?? null) as number | null,
    }));

  return { snapshot, events };
}

function rowToEvent(row: {
  event_id: string;
  event_type: string;
  aggregate_id: string;
  aggregate_version: number;
  correlation_id?: string | null;
  causation_id?: string | null;
  timestamp: string;
  schema_version?: number | null;
  payload: unknown;
  metadata?: unknown;
  gsn?: number | null;
}): DomainEvent {
  const schemaVersion =
    typeof row.schema_version === 'number' && row.schema_version > 0 ? row.schema_version : 1;

  const baseEvent = {
    eventId: row.event_id,
    type: row.event_type,
    eventType: row.event_type,
    aggregateId: row.aggregate_id,
    aggregateVersion: row.aggregate_version,
    correlationId: typeof row.correlation_id === 'string' ? row.correlation_id : '',
    causationId: row.causation_id || undefined,
    timestamp: new Date(row.timestamp),
    payload: parseJsonColumnValue(row.payload),
    metadata:
      row.metadata !== undefined && row.metadata !== null
        ? parseJsonColumnValue(row.metadata)
        : undefined,
    schemaVersion,
  } as DomainEvent;

  const event = applyEventUpcasters(baseEvent);

  // Normalize GSN coming from PostgreSQL BIGINT columns (driver often returns them as strings).
  const rawGsn = (row as unknown as { gsn?: unknown }).gsn;

  if (rawGsn !== undefined && rawGsn !== null) {
    const numericGsn =
      typeof rawGsn === 'number'
        ? rawGsn
        : typeof rawGsn === 'bigint'
        ? Number(rawGsn)
        : Number(rawGsn);

    if (Number.isFinite(numericGsn)) {
      event.gsn = numericGsn;
    }
  }

  return event;
}

function generateCorrelationId(): string {
  return CorrelationIdProvider.generate();
}