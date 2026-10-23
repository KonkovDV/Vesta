import { Pool, type PoolConfig } from 'pg';
import {
  IEventGapDetector,
  EventGap,
  EventGapScanResult,
} from '../../domain/events/event-gap-detector.interface';
import { isValidPostgresIdentifier, qualifyIdentifier } from '../database/postgres-identifiers';
import { getConfig } from '../../config';
import { buildPgSslConfig } from '../persistence/pg-ssl-config';

const DEFAULT_EVENT_STORE_SCHEMA = 'event_store';
const DEFAULT_EVENT_STORE_EVENTS_TABLE = 'events';
const DEFAULT_OUTBOX_SCHEMA = 'outbox';
const DEFAULT_OUTBOX_TABLE = 'messages';

export class PostgresEventGapDetector implements IEventGapDetector {
  private readonly eventStoreSchema: string;
  private readonly eventStoreEventsTable: string;
  private readonly outboxSchema: string;
  private readonly outboxTable: string;
  private readonly qualifiedEventsTable: string;
  private readonly qualifiedOutboxTable: string;

  constructor(private readonly pool: Pool) {
    this.eventStoreSchema = DEFAULT_EVENT_STORE_SCHEMA;
    this.eventStoreEventsTable = DEFAULT_EVENT_STORE_EVENTS_TABLE;
    this.outboxSchema = DEFAULT_OUTBOX_SCHEMA;
    this.outboxTable = DEFAULT_OUTBOX_TABLE;

    if (!isValidPostgresIdentifier(this.eventStoreSchema)) {
      throw new Error(`Invalid PostgreSQL Event Store schema name: "${this.eventStoreSchema}"`);
    }
    if (!isValidPostgresIdentifier(this.eventStoreEventsTable)) {
      throw new Error(
        `Invalid PostgreSQL Event Store events table name: "${this.eventStoreEventsTable}"`,
      );
    }
    if (!isValidPostgresIdentifier(this.outboxSchema)) {
      throw new Error(`Invalid PostgreSQL Outbox schema name: "${this.outboxSchema}"`);
    }
    if (!isValidPostgresIdentifier(this.outboxTable)) {
      throw new Error(`Invalid PostgreSQL Outbox table name: "${this.outboxTable}"`);
    }

    this.qualifiedEventsTable = qualifyIdentifier(
      this.eventStoreSchema,
      this.eventStoreEventsTable,
      'PostgresEventGapDetector.events',
    );
    this.qualifiedOutboxTable = qualifyIdentifier(
      this.outboxSchema,
      this.outboxTable,
      'PostgresEventGapDetector.outbox',
    );
  }

  async getLatestGsn() {
    const res = await this.pool.query(
      `SELECT MAX(gsn) AS max_gsn FROM ${this.qualifiedEventsTable} WHERE gsn IS NOT NULL`,
    );

    const raw = res.rows[0]?.max_gsn as unknown;

    if (raw === null || raw === undefined) {
      return null;
    }

    const numeric = typeof raw === 'number' ? raw : Number(raw);

    if (Number.isNaN(numeric)) {
      return null;
    }

    return numeric as number | null;
  }

  async scanGsnWindow(
    fromExclusiveGsn: number | null,
    limit: number,
  ) {
    const safeLimit =
      typeof limit === 'number' && Number.isFinite(limit) && limit > 0 ? limit : 1;

    const gaps: EventGap[] = [];

    // 1. Читаем окно событий по GSN
    const eventsRes = await this.pool.query(
      `SELECT gsn, event_id, aggregate_id, event_type
         FROM ${this.qualifiedEventsTable}
        WHERE gsn IS NOT NULL
          AND ($1 IS NULL OR gsn > $1)
        ORDER BY gsn ASC
        LIMIT $2`,
      [fromExclusiveGsn, safeLimit],
    );

    const events = (eventsRes.rows || []).map((row) => {
      const numericGsn =
        typeof row.gsn === 'number' ? row.gsn : row.gsn != null ? Number(row.gsn) : null;

      if (numericGsn == null || Number.isNaN(numericGsn)) {
        return null;
      }

      return {
        gsn: numericGsn as number,
        eventId: String(row.event_id),
        aggregateId: String(row.aggregate_id),
        eventType: String(row.event_type),
      };
    }).filter((row) => row !== null) as Array<{
      gsn: number;
      eventId: string;
      aggregateId: string;
      eventType: string;
    }>;

    const totalEventsScanned = events.length;
    let windowToGsn: number | null = null;

    if (events.length > 0) {
      windowToGsn = events[events.length - 1].gsn;

      // 1a. ES_GSN_GAP: ищем разрывы между соседними GSN
      let prevGsn: number | null = null;
      for (const ev of events) {
        if (prevGsn != null) {
          const delta = ev.gsn - prevGsn;
          if (delta > 1) {
            gaps.push({
              kind: 'ES_GSN_GAP',
              fromGsn: prevGsn,
              toGsn: ev.gsn,
              detectedAt: new Date(),
            });
          }
        }
        prevGsn = ev.gsn;
      }
    }

    let totalOutboxScanned = 0;

    // 2. ES_OUTBOX_MISSING: события в Event Store без записи в outbox.messages
    if (windowToGsn != null) {
      const missingRes = await this.pool.query(
        `SELECT e.gsn, e.event_id, e.aggregate_id, e.event_type
           FROM ${this.qualifiedEventsTable} e
           LEFT JOIN ${this.qualifiedOutboxTable} m
             ON m.event_id = e.event_id
          WHERE e.gsn IS NOT NULL
            AND ($1 IS NULL OR e.gsn > $1)
            AND NOT (e.gsn > $3)
            AND m.event_id IS NULL
          ORDER BY e.gsn ASC
          LIMIT $2`,
        [fromExclusiveGsn, safeLimit, windowToGsn],
      );

      totalOutboxScanned += missingRes.rows.length;

      for (const row of missingRes.rows) {
        const numericGsn =
          typeof row.gsn === 'number' ? row.gsn : row.gsn != null ? Number(row.gsn) : null;

        if (numericGsn == null || Number.isNaN(numericGsn)) {
          continue;
        }

        gaps.push({
          kind: 'ES_OUTBOX_MISSING',
          fromGsn: numericGsn as number,
          toGsn: numericGsn as number,
          eventId: String(row.event_id),
          aggregateId: String(row.aggregate_id),
          eventType: String(row.event_type),
          detectedAt: new Date(),
        });
      }
    }

    // 3. OUTBOX_ORPHAN: outbox.messages без соответствующего события в Event Store
    const orphanRes = await this.pool.query(
      `SELECT m.event_gsn,
              m.message_id,
              m.event_id,
              m.aggregate_id,
              m.event_type,
              m.status
         FROM ${this.qualifiedOutboxTable} m
         LEFT JOIN ${this.qualifiedEventsTable} e
           ON e.event_id = m.event_id
        WHERE ($1 IS NULL OR m.event_gsn > $1)
          AND e.event_id IS NULL
        ORDER BY m.event_gsn ASC NULLS LAST
        LIMIT $2`,
      [fromExclusiveGsn, safeLimit],
    );

    totalOutboxScanned += orphanRes.rows.length;

    for (const row of orphanRes.rows) {
      const numericGsn =
        typeof row.event_gsn === 'number'
          ? row.event_gsn
          : row.event_gsn != null
          ? Number(row.event_gsn)
          : null;

      gaps.push({
        kind: 'OUTBOX_ORPHAN',
        fromGsn: numericGsn ?? undefined,
        toGsn: numericGsn ?? undefined,
        outboxMessageId: String(row.message_id),
        eventId: row.event_id ? String(row.event_id) : undefined,
        aggregateId: row.aggregate_id ? String(row.aggregate_id) : undefined,
        eventType: row.event_type ? String(row.event_type) : undefined,
        outboxStatus: String(row.status),
        detectedAt: new Date(),
      });
    }

    const result: EventGapScanResult = {
      fromGsn: fromExclusiveGsn ?? null,
      toGsn: windowToGsn,
      totalEventsScanned,
      totalOutboxScanned,
      gaps,
    };

    return result;
  }
}

export function createPostgresEventGapDetectorFromEnv(): IEventGapDetector {
  const cfg = getConfig();

  if (cfg.NODE_ENV === 'test') {
    return {
      async scanGsnWindow(fromExclusiveGsn: number | null): Promise<EventGapScanResult> {
        return {
          fromGsn: fromExclusiveGsn,
          toGsn: null,
          totalEventsScanned: 0,
          totalOutboxScanned: 0,
          gaps: [],
        };
      },
      async getLatestGsn(): Promise<number | null> {
        return null;
      },
    };
  }

  const port =
    cfg.DB_PORT && cfg.DB_PORT.length > 0
      ? Number.parseInt(cfg.DB_PORT, 10)
      : undefined;

  const ssl = buildPgSslConfig(cfg as unknown as Record<string, string | undefined>);

  const poolConfig: PoolConfig = {
    connectionString: cfg.DATABASE_URL,
    host: cfg.DB_HOST,
    port,
    database: cfg.DB_NAME,
    user: cfg.DB_USER,
    password: cfg.DB_PASSWORD,
    ssl,
  };

  const pool = new Pool({
    ...poolConfig,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    statement_timeout: 30000,
  });

  return new PostgresEventGapDetector(pool);
}