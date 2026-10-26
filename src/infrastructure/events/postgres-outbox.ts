/**
 * PostgreSQL Outbox - реализация паттерна надежной доставки событий
 * Layer: Infrastructure (техническая реализация)
 *
 * Реализует Transactional Outbox для транзакционного связывания записи доменных событий
 * в Event Store и создания сообщений в Outbox в рамках одной транзакции PostgreSQL.
 * Затем Outbox-воркер публикует события в Event Bus.
 */

import { randomUUID } from 'node:crypto';
import { Pool, PoolClient, PoolConfig } from 'pg';
import {
  IOutbox,
  OutboxMessage,
  OutboxConfig,
  OutboxStats,
  PublishResult,
  OutboxStatus,
  OutboxError,
  OutboxUtils,
  type OutboxSaveOptions,
} from '../../domain/events/outbox.interface';
import { ConcurrencyError } from '../../domain/errors/DomainError';
import { DomainEvent } from '../../domain/events/event-store.interface';
import { IEventBus } from '../../domain/events/event-bus.interface';
import { getOrCreateCounter, getOrCreateHistogram } from '../../monitoring';
import { getMetricsConfig } from '../../core/config/app-config';
import { isValidPostgresIdentifier, qualifyIdentifier } from '../database/postgres-identifiers';
import { getConfig } from '../../config';
import { tryJsonParse } from '../../core/utils/json';
import { IdGenerator } from '../../core/utils/IdGenerator';
import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';
import {
  DEFAULT_OUTBOX_CB_TIMEOUT_MS,
  DEFAULT_OUTBOX_CB_SUCCESS_THRESHOLD,
  DEFAULT_OUTBOX_CB_FAILURE_THRESHOLD,
} from '../config/config';
 
 // Prometheus metrics for Outbox (global register); guarded centrally via getMetricsConfig().enabled and not in tests
 const { JEST_WORKER_ID, NODE_ENV, OUTBOX_LOGS } = getConfig();
 const isTestEnv = Boolean(JEST_WORKER_ID || NODE_ENV === 'test');
 const { enabled, eventLatencyBucketsMs } = getMetricsConfig();
 const OUTBOX_METRICS_ON = enabled && !isTestEnv;

const OUTBOX_DLQ_TOTAL = getOrCreateCounter(
  'outbox_dlq_total',
  'Total outbox messages moved to DLQ',
  ['event_type']
);
const OUTBOX_ENQUEUED_TOTAL = getOrCreateCounter(
  'outbox_enqueued_total',
  'Total outbox messages enqueued',
  ['event_type']
);
const OUTBOX_PUBLISHED_TOTAL = getOrCreateCounter(
  'outbox_published_total',
  'Total outbox messages published',
  ['event_type']
);
const OUTBOX_PUBLISH_LATENCY_MS = getOrCreateHistogram(
  'outbox_publish_latency_ms',
  'Outbox publish latency (ms)',
  ['event_type'],
  eventLatencyBucketsMs
);
const OUTBOX_FAILED_TOTAL = getOrCreateCounter(
  'outbox_failed_total',
  'Total outbox publish failures',
  ['event_type']
);
const OUTBOX_LOCKED_ROWS_TOTAL = getOrCreateCounter(
  'outbox_locked_rows_total',
  'Total outbox rows picked up for processing (contention proxy)',
  []
);

/**
 * Конфигурация PostgreSQL Outbox
 */
export interface PostgreSQLOutboxConfig extends OutboxConfig {
  /** Настройки подключения к PostgreSQL */
  connection: PoolConfig;
  /** Название схемы базы данных для Outbox */
  schema?: string;
  /** Название таблицы outbox */
  outboxTable?: string;
  /** Название таблицы dead letter queue */
  dlqTable?: string;
  /** Размер пула соединений */
  poolSize?: number;
  /** Таймаут circuit breaker (мс) перед переходом из OPEN в HALF_OPEN */
  circuitBreakerTimeoutMs?: number;
  /** Количество успешных батчей в HALF_OPEN для возврата в CLOSED */
  circuitBreakerSuccessThreshold?: number;
  /** Seconds before a PROCESSING row can be claimed again. */
  processingLeaseSeconds?: number;
  /** Upper bound of the retry delay; retryDelayMs is the first delay and doubles per failure. Default 5 min. */
  retryMaxDelayMs?: number;

  /** Настройки схемы Event Store (куда пишутся события) */
  eventStoreConfig?: {
    schema?: string;
    eventsTable?: string;
  };
}

/**
 * SQL схема для создания таблиц Outbox
 * Расширена полями: event_timestamp, aggregate_version, causation_id
 */
export const OUTBOX_SCHEMA = `
-- Таблица для хранения сообщений outbox
CREATE TABLE IF NOT EXISTS ${'${schema}'}.${'${outboxTable}'} (
  message_id VARCHAR(255) PRIMARY KEY,
  event_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  aggregate_id VARCHAR(255) NOT NULL,
  aggregate_version INTEGER NOT NULL,
  correlation_id VARCHAR(255) NOT NULL,
  causation_id VARCHAR(255),
  idempotency_key VARCHAR(255),
  event_timestamp TIMESTAMP NOT NULL,
  event_payload JSONB NOT NULL,
  event_metadata JSONB,
  event_gsn BIGINT,
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_retry_at TIMESTAMP,
  published_at TIMESTAMP,
  last_error TEXT,
  transaction_id VARCHAR(255),
  metadata JSONB,
 
  -- Constraints
  CONSTRAINT positive_version CHECK (aggregate_version > 0),
  CONSTRAINT valid_status CHECK (status IN ('PENDING', 'PROCESSING', 'PUBLISHED', 'FAILED', 'DEAD_LETTER')),
  CONSTRAINT positive_retry_count CHECK (retry_count >= 0),
 
  -- Индексы для производительности
  CONSTRAINT unique_event_id UNIQUE (event_id)
);
 
-- Индексы для быстрого поиска и упорядочивания
CREATE INDEX IF NOT EXISTS idx_outbox_status ON ${'${schema}'}.${'${outboxTable}'}(status);
CREATE INDEX IF NOT EXISTS idx_outbox_retry_count ON ${'${schema}'}.${'${outboxTable}'}(status, retry_count, created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_created_at ON ${'${schema}'}.${'${outboxTable}'}(created_at);
CREATE INDEX IF NOT EXISTS idx_outbox_aggregate_id ON ${'${schema}'}.${'${outboxTable}'}(aggregate_id);
CREATE INDEX IF NOT EXISTS idx_outbox_correlation_id ON ${'${schema}'}.${'${outboxTable}'}(correlation_id);
CREATE INDEX IF NOT EXISTS idx_outbox_event_type ON ${'${schema}'}.${'${outboxTable}'}(event_type);
CREATE INDEX IF NOT EXISTS idx_outbox_transaction ON ${'${schema}'}.${'${outboxTable}'}(transaction_id);
CREATE INDEX IF NOT EXISTS idx_outbox_idempotency_key ON ${'${schema}'}.${'${outboxTable}'}(idempotency_key);

-- Таблица для Dead Letter Queue
CREATE TABLE IF NOT EXISTS ${'${schema}'}.${'${dlqTable}'} (
  dlq_message_id VARCHAR(255) PRIMARY KEY,
  original_message_id VARCHAR(255) NOT NULL,
  event_id VARCHAR(255) NOT NULL,
  event_type VARCHAR(100) NOT NULL,
  aggregate_id VARCHAR(255) NOT NULL,
  aggregate_version INTEGER NOT NULL,
  correlation_id VARCHAR(255) NOT NULL,
  idempotency_key VARCHAR(255),
  event_payload JSONB NOT NULL,
  event_metadata JSONB,
  failure_reason TEXT NOT NULL,
  original_retry_count INTEGER NOT NULL,
  moved_to_dlq_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  replay_attempts INTEGER NOT NULL DEFAULT 0,
  last_replay_at TIMESTAMP,
  metadata JSONB,

  CONSTRAINT positive_original_retry_count CHECK (original_retry_count >= 0),
  CONSTRAINT positive_replay_attempts CHECK (replay_attempts >= 0)
);

-- Индексы для DLQ
CREATE INDEX IF NOT EXISTS idx_dlq_moved_at ON ${'${schema}'}.${'${dlqTable}'}(moved_to_dlq_at);
CREATE INDEX IF NOT EXISTS idx_dlq_event_type ON ${'${schema}'}.${'${dlqTable}'}(event_type);
CREATE INDEX IF NOT EXISTS idx_dlq_original_message ON ${'${schema}'}.${'${dlqTable}'}(original_message_id);
`;

export const DROP_OUTBOX_SCHEMA = `
DROP TABLE IF EXISTS ${'${schema}'}.${'${outboxTable}'} CASCADE;
DROP TABLE IF EXISTS ${'${schema}'}.${'${dlqTable}'} CASCADE;
`;

interface OutboxRow {
  message_id: string;
  event_id: string;
  event_type: string;
  aggregate_id: string;
  aggregate_version: number;
  correlation_id: string;
  causation_id: string | null;
  idempotency_key: string | null;
  event_timestamp: string;
  event_payload: string;
  event_metadata: string | null;
  retry_count: number;
  created_at: string;
  lease_token?: string | null;
}

interface DlqRow {
  dlq_message_id: string;
  original_message_id: string;
  event_id: string;
  event_type: string;
  aggregate_id: string;
  aggregate_version: number;
  correlation_id: string;
  idempotency_key: string | null;
  event_payload: string;
  event_metadata: string | null;
  failure_reason: string;
  original_retry_count: number;
  moved_to_dlq_at: string;
  replay_attempts: number;
  last_replay_at: string | null;
  metadata: string | null;
}

/**
 * PostgreSQL Outbox реализация
 */
export class PostgreSQLOutbox implements IOutbox {
  private readonly pool: Pool;
  private readonly schema: string;
  private readonly outboxTable: string;
  private readonly dlqTable: string;
  private readonly eventStoreSchema: string;
  private readonly eventStoreEventsTable: string;
  private readonly qualifiedOutboxTable: string;
  private readonly qualifiedDlqTable: string;
  private readonly qualifiedEventStoreEventsTable: string;
  private readonly config: Required<PostgreSQLOutboxConfig>;
  private isInitialized = false;
  private processingInterval?: NodeJS.Timeout;
  private isProcessing = false;
  private isWorkerRunning = false;
  private _closed = false;
  /** Symmetric listener cleanup — prevents EventEmitter leaks (OOM-008) */
  private readonly onPoolError: (err: Error) => void;

  // Простой circuit breaker для защиты от деградировавшего Event Bus.
  // Пороговые значения и таймаут инициализируются из конфигурации в конструкторе.
  private readonly circuitBreaker = {
    state: 'CLOSED' as 'CLOSED' | 'OPEN' | 'HALF_OPEN',
    failureCount: 0,
    successCount: 0,
    lastFailureTime: 0,
    timeout: 0,
    successThreshold: 0,
    failureThreshold: 0,
  };

  constructor(
    private readonly postgresConfig: PostgreSQLOutboxConfig,
    // eventStore не используется напрямую (запись в таблицу Event Store делаем SQL), но оставляем для health-check совместимости
    private readonly _eventStoreUnused: unknown,
    private readonly eventBus: IEventBus,
    private readonly logger?: IStructuredLogger
  ) {
    this.schema = postgresConfig.schema || 'outbox';
    this.outboxTable = postgresConfig.outboxTable || 'messages';
    this.dlqTable = postgresConfig.dlqTable || 'dead_letter_queue';
    this.eventStoreSchema = postgresConfig.eventStoreConfig?.schema || 'event_store';
    this.eventStoreEventsTable = postgresConfig.eventStoreConfig?.eventsTable || 'events';

    // Fail-fast on misconfigured identifiers and precompute qualified names.
    if (!isValidPostgresIdentifier(this.schema)) {
      throw new Error(`Invalid PostgreSQL schema name for Outbox: "${this.schema}"`);
    }
    if (!isValidPostgresIdentifier(this.outboxTable)) {
      throw new Error(`Invalid PostgreSQL outbox table name: "${this.outboxTable}"`);
    }
    if (!isValidPostgresIdentifier(this.dlqTable)) {
      throw new Error(`Invalid PostgreSQL DLQ table name: "${this.dlqTable}"`);
    }
    if (!isValidPostgresIdentifier(this.eventStoreSchema)) {
      throw new Error(`Invalid PostgreSQL Event Store schema name: "${this.eventStoreSchema}"`);
    }
    if (!isValidPostgresIdentifier(this.eventStoreEventsTable)) {
      throw new Error(
        `Invalid PostgreSQL Event Store events table name: "${this.eventStoreEventsTable}"`,
      );
    }

    this.qualifiedOutboxTable = qualifyIdentifier(
      this.schema,
      this.outboxTable,
      'PostgreSQLOutbox.outbox',
    );
    this.qualifiedDlqTable = qualifyIdentifier(
      this.schema,
      this.dlqTable,
      'PostgreSQLOutbox.dlq',
    );
    this.qualifiedEventStoreEventsTable = qualifyIdentifier(
      this.eventStoreSchema,
      this.eventStoreEventsTable,
      'PostgreSQLOutbox.event_store',
    );

    this.config = {
      maxRetries: postgresConfig.maxRetries ?? 3,
      retryDelayMs: postgresConfig.retryDelayMs ?? 1000,
      batchSize: postgresConfig.batchSize ?? 10,
      processingIntervalMs: postgresConfig.processingIntervalMs ?? 1000,
      processingTimeoutMs: postgresConfig.processingTimeoutMs ?? 30000,
      enableDeadLetterQueue: postgresConfig.enableDeadLetterQueue !== false,
      // connection/poolSize и поля ниже просто прокидываем далее (Required требует)
      connection: postgresConfig.connection,
      schema: this.schema,
      outboxTable: this.outboxTable,
      dlqTable: this.dlqTable,
      poolSize: postgresConfig.poolSize ?? 10,
      circuitBreakerTimeoutMs:
        postgresConfig.circuitBreakerTimeoutMs ?? DEFAULT_OUTBOX_CB_TIMEOUT_MS,
      circuitBreakerSuccessThreshold:
        postgresConfig.circuitBreakerSuccessThreshold ?? DEFAULT_OUTBOX_CB_SUCCESS_THRESHOLD,
      circuitBreakerFailureThreshold:
        postgresConfig.circuitBreakerFailureThreshold ?? DEFAULT_OUTBOX_CB_FAILURE_THRESHOLD,
      processingLeaseSeconds: postgresConfig.processingLeaseSeconds ?? 300,
      retryMaxDelayMs: postgresConfig.retryMaxDelayMs ?? 300_000,
      eventStoreConfig: {
        schema: this.eventStoreSchema,
        eventsTable: this.eventStoreEventsTable
      }
    };
 
    // Синхронизируем параметры circuit breaker с финальной конфигурацией
    this.circuitBreaker.timeout = this.config.circuitBreakerTimeoutMs;
    this.circuitBreaker.successThreshold = this.config.circuitBreakerSuccessThreshold;
    this.circuitBreaker.failureThreshold = this.config.circuitBreakerFailureThreshold;
 
    this.pool = new Pool({
      ...this.config.connection,
      max: this.config.poolSize,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
      keepAlive: true,
      keepAliveInitialDelayMillis: 10000,
      statement_timeout: 30000,
    });

    // Bind handler for symmetric cleanup (OOM-008)
    this.onPoolError = (err: Error) => {
      console.error('PostgreSQL Outbox connection error:', err);
    };
    this.pool.on('error', this.onPoolError);
  }

  /**
   * Инициализация Outbox с валидацией схемы БД
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    const client = await this.pool.connect();
    try {
      // 1. Создание схемы
      await client.query(`CREATE SCHEMA IF NOT EXISTS ${this.schema}`);
      
      // 2. Валидация существующих таблиц перед созданием
      await this.validateSchemaBeforeInit(client);
      
      // 3. Создание таблиц
      await client.query(
        OUTBOX_SCHEMA
          .replaceAll('${schema}', this.schema)
          .replaceAll('${outboxTable}', this.outboxTable)
          .replaceAll('${dlqTable}', this.dlqTable)
      );
      
      // 3a. Обновление схемы для поддержки event_gsn (денормализация GSN из Event Store)
      await client.query(`
        ALTER TABLE ${this.schema}.${this.outboxTable}
        ADD COLUMN IF NOT EXISTS event_gsn BIGINT
      `);
      await client.query(`
        ALTER TABLE ${this.schema}.${this.outboxTable}
        ADD COLUMN IF NOT EXISTS idempotency_key VARCHAR(255)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_outbox_status_gsn
        ON ${this.schema}.${this.outboxTable}(status, event_gsn);
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS idx_outbox_event_gsn
        ON ${this.schema}.${this.outboxTable}(event_gsn);
      `);
      // Same columns as the outbox section of 001_consolidated.sql.
      await client.query(`
        ALTER TABLE ${this.schema}.${this.outboxTable}
        ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now()
      `);
      await client.query(`
        ALTER TABLE ${this.schema}.${this.outboxTable}
        ADD COLUMN IF NOT EXISTS lease_token TEXT
      `);
      
      // 4. Проверка успешности создания
      await this.verifySchemaAfterInit(client);

      console.log('✅ PostgreSQL Outbox initialized successfully');
      this.isInitialized = true;
    } catch (error) {
      // Ignore concurrent DDL race (23505 = unique_violation) during initialization
      const pgError = error as { code?: string };
      if (pgError?.code === '23505') {
        console.log('ℹ️ Concurrent DDL race detected (23505), continuing initialization');
        this.isInitialized = true;
      } else {
        console.error('❌ Failed to initialize PostgreSQL Outbox:', error);
        throw OutboxError.configurationError('Failed to initialize: ' + String(error));
      }
    } finally {
      client.release();
    }
  }

  /**
   * Валидация схемы БД перед инициализацией с защитой от SQL injection
   */
  private async validateSchemaBeforeInit(client: PoolClient): Promise<void> {
    // Валидация имени схемы
    if (!this.isValidIdentifier(this.schema)) {
      throw new Error(`Invalid schema name: ${this.schema}`);
    }
    
    // Валидация имен таблиц
    if (!this.isValidIdentifier(this.outboxTable)) {
      throw new Error(`Invalid outbox table name: ${this.outboxTable}`);
    }
    
    if (!this.isValidIdentifier(this.dlqTable)) {
      throw new Error(`Invalid DLQ table name: ${this.dlqTable}`);
    }

    // Проверяем существование таблиц и их совместимость
    const tables = [this.outboxTable, this.dlqTable];
    
    for (const table of tables) {
      const exists = await this.tableExists(client, this.schema, table);
      if (exists) {
        await this.validateTableCompatibility(client, this.schema, table);
      }
    }
  }

  /**
   * Проверка валидности SQL идентификатора (обёртка над общим helper'ом).
   */
  private isValidIdentifier(identifier: string): boolean {
    return isValidPostgresIdentifier(identifier);
  }

  /**
   * Проверка существования таблицы
   */
  private async tableExists(client: PoolClient, schema: string, table: string): Promise<boolean> {
    const result = await client.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = $2
      )`,
      [schema, table]
    );
    return result.rows[0].exists;
  }

  /**
   * Валидация совместимости существующей таблицы
   */
  private async validateTableCompatibility(client: PoolClient, schema: string, table: string): Promise<void> {
    const requiredColumns = table === this.outboxTable
      ? ['message_id', 'event_id', 'event_type', 'aggregate_id', 'status']
      : ['dlq_message_id', 'original_message_id', 'event_id', 'failure_reason'];
    
    const result = await client.query(
      `SELECT column_name
       FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2`,
      [schema, table]
    );
    
    const existingColumns = result.rows.map(row => row.column_name);
    const missingColumns = requiredColumns.filter(col => !existingColumns.includes(col));
    
    if (missingColumns.length > 0) {
      throw new Error(
        `Table ${schema}.${table} exists but missing required columns: ${missingColumns.join(', ')}`
      );
    }
  }

  /**
   * Проверка схемы после инициализации
   */
  private async verifySchemaAfterInit(client: PoolClient): Promise<void> {
    // Проверяем что все индексы созданы
    const indexes = await client.query(
      `SELECT indexname
       FROM pg_indexes
       WHERE schemaname = $1 AND tablename IN ($2, $3)`,
      [this.schema, this.outboxTable, this.dlqTable]
    );
    
    const indexNames = indexes.rows.map(row => row.indexname);
    const requiredIndexes = [
      `idx_outbox_status`,
      `idx_outbox_retry_count`,
      `idx_outbox_created_at`,
      `idx_outbox_aggregate_id`,
      `idx_outbox_correlation_id`,
      `idx_outbox_event_type`,
      `idx_dlq_moved_at`,
      `idx_dlq_event_type`
    ];
    
    const missingIndexes = requiredIndexes.filter(idx => !indexNames.some(name => name.includes(idx)));
    if (missingIndexes.length > 0) {
      console.warn('Missing indexes detected:', missingIndexes);
    }
  }

  /**
   * Сохранить события в Event Store и создать outbox сообщения (одна транзакция)
   */
  async saveEventsWithOutbox(
    events: DomainEvent[],
    transactionId?: string,
    options?: OutboxSaveOptions,
  ): Promise<OutboxMessage[]> {
    if (!events || events.length === 0) return [];

    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');

      // Вычисление версий агрегатов в рамках ТХ, кешируем для минимизации SELECT
      const outboxMessages = await this.insertEventsAndOutboxBatch(client, events, transactionId, options);

      await client.query('COMMIT');

      this.logger?.log(`💾 Transactional Outbox: saved ${events.length} events and ${outboxMessages.length} outbox messages`);
      return outboxMessages;
    } catch (error) {
      await client.query('ROLLBACK');
      if (error instanceof ConcurrencyError) {
        // The caller decided on a version that is no longer current: it must reload.
        throw error;
      }
      this.logger?.error('❌ Failed to save events with transactional outbox:', { error: String(error) });
      throw OutboxError.publishFailed('saveEventsWithOutbox', error as Error);
    } finally {
      client.release();
    }
  }

  /**
   * Сохранить события, используя уже открытый транзакционный клиент (без BEGIN/COMMIT)
   * Позволяет объединить сохранение read-model и событий + outbox в одну ТХ БД.
   */
  async saveEventsWithOutboxInTxClient(
    client: PoolClient,
    events: DomainEvent[],
    transactionId?: string,
    options?: OutboxSaveOptions,
  ): Promise<OutboxMessage[]> {
    if (!events || events.length === 0) return [];

    return this.insertEventsAndOutboxBatch(client, events, transactionId, options);
  }

  /**
   * Обработать все pending сообщения из outbox с batch processing и circuit breaker
   * ВАЖНО: публикация в EventBus выполняется без удержания соединения с БД.
   */
  async processPendingMessages(batchSize?: number): Promise<PublishResult> {
    // Проверяем circuit breaker
    if (this.circuitBreaker.state === 'OPEN') {
      const now = Date.now();
      if (now - this.circuitBreaker.lastFailureTime > this.circuitBreaker.timeout) {
        // Переходим в HALF_OPEN state
        this.circuitBreaker.state = 'HALF_OPEN';
        this.circuitBreaker.successCount = 0;
        console.log('🔓 Circuit breaker moved to HALF_OPEN state');
      } else {
        console.warn('⚠️ Circuit breaker is OPEN, skipping processing');
        return {
          success: false,
          publishedMessages: [],
          failedMessages: [],
          processingTime: 0
        };
      }
    }

    const size = batchSize || this.config.batchSize;
    const startTime = Date.now();

    try {
      // 1. Короткое подключение к БД только для выборки pending/failed сообщений
      const leaseToken = randomUUID();
      let pendingMessages: OutboxRow[] = [];
      const client = await this.pool.connect();
      try {
        // - A failed row is due only after its backoff (next_attempt_at).
        // - An expired PROCESSING lease counts as an attempt, so a row that kills
        //   its worker every time reaches the dead-letter queue instead of looping.
        // - Only the oldest open version of an aggregate is claimed: v2 is not
        //   published while v1 is pending, in flight, or waiting for a retry. A v1
        //   that used all its retries no longer blocks (with the DLQ disabled it
        //   stays FAILED in this table and would otherwise block v2 forever).
        // - lease_token fences the later PUBLISHED/FAILED update to this claim.
        const result = await client.query<OutboxRow>(
          `WITH claimed AS MATERIALIZED (
             SELECT m.message_id
               FROM ${this.schema}.${this.outboxTable} AS m
              WHERE ((m.status IN ('PENDING', 'FAILED') AND m.retry_count < $1 AND m.next_attempt_at <= now())
                  OR (m.status = 'PROCESSING'
                      AND m.last_retry_at < CURRENT_TIMESTAMP - make_interval(secs => $3)))
                AND NOT EXISTS (
                  SELECT 1
                    FROM ${this.schema}.${this.outboxTable} AS earlier
                   WHERE earlier.aggregate_id = m.aggregate_id
                     AND earlier.aggregate_version < m.aggregate_version
                     AND (earlier.status IN ('PENDING', 'PROCESSING')
                          OR (earlier.status = 'FAILED' AND earlier.retry_count < $1))
                )
              ORDER BY m.created_at ASC
              LIMIT $2
              FOR UPDATE OF m SKIP LOCKED
           )
           UPDATE ${this.schema}.${this.outboxTable} AS o
              SET status = 'PROCESSING',
                  last_retry_at = CURRENT_TIMESTAMP,
                  lease_token = $4,
                  retry_count = o.retry_count + CASE WHEN o.status = 'PROCESSING' THEN 1 ELSE 0 END
             FROM claimed
            WHERE o.message_id = claimed.message_id
            RETURNING o.message_id, o.event_id, o.event_type, o.aggregate_id, o.aggregate_version,
                      o.correlation_id, o.causation_id, o.idempotency_key, o.event_timestamp,
                      o.event_payload, o.event_metadata, o.retry_count, o.created_at, o.lease_token`,
          [this.config.maxRetries, size, this.config.processingLeaseSeconds, leaseToken]
        );
        pendingMessages = result.rows;
        if (OUTBOX_METRICS_ON && pendingMessages.length > 0) {
          OUTBOX_LOCKED_ROWS_TOTAL.inc(pendingMessages.length);
        }
      } finally {
        client.release();
      }

      // The claim size is the parallelism bound. Publishing starts together.
      const publishedMessages: string[] = [];
      const failedMessages: Array<{ messageId: string; error: string }> = [];
      const failedRows: Array<{ row: OutboxRow; error: Error }> = [];

      // A row whose lease expired maxRetries times is not published again. Without
      // a DLQ it ends as FAILED with its retries used, which no later claim selects.
      const poisoned = pendingMessages.filter((row) => row.retry_count >= this.config.maxRetries);
      for (const row of poisoned) {
        if (this.config.enableDeadLetterQueue) {
          await this.moveToDeadLetterQueue(row.message_id, 'Processing lease expired too many times');
        } else {
          await this.markFailures([{ row, error: new Error('Processing lease expired too many times') }], leaseToken);
        }
      }
      pendingMessages = pendingMessages.filter((row) => row.retry_count < this.config.maxRetries);

      const results = await Promise.allSettled(
        pendingMessages.map((row) => this.publishOutboxRow(row)),
      );

      results.forEach((result, index) => {
        const row = pendingMessages[index];
        if (!row) {
          return;
        }
        if (result.status === 'fulfilled') {
          publishedMessages.push(row.message_id);
          return;
        }
        const error = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
        failedRows.push({ row, error });
        failedMessages.push({ messageId: row.message_id, error: error.message });
      });

      const processingTime = Date.now() - startTime;

      if (publishedMessages.length > 0) {
        await this.markBatchAsProcessed(publishedMessages, leaseToken);
      }
      if (failedRows.length > 0) {
        await this.markFailures(failedRows, leaseToken);
      }

      // Обновляем состояние circuit breaker с учётом частичных ошибок
      if (failedMessages.length > 0) {
        this.onFailure();
      } else {
        this.onSuccess();
      }

      return {
        success: true,
        publishedMessages,
        failedMessages,
        processingTime
      };
    } catch (error) {
      this.logger?.error('❌ Failed to process pending messages:', { error: String(error) });

      // Неудачная обработка - обновляем circuit breaker
      this.onFailure();

      return {
        success: false,
        publishedMessages: [],
        failedMessages: [],
        processingTime: Date.now() - startTime
      };
    }
  }

  /**
   * Обработка успешной операции для circuit breaker
   */
  private onSuccess(): void {
    if (this.circuitBreaker.state === 'HALF_OPEN') {
      this.circuitBreaker.successCount++;
      if (this.circuitBreaker.successCount >= this.circuitBreaker.successThreshold) {
        this.circuitBreaker.state = 'CLOSED';
        this.circuitBreaker.failureCount = 0;
        console.log('🔒 Circuit breaker moved to CLOSED state');
      }
    } else if (this.circuitBreaker.state === 'CLOSED') {
      // Сбрасываем счетчик ошибок при успехе
      this.circuitBreaker.failureCount = 0;
    }
  }

  /**
   * Обработка неудачной операции для circuit breaker
   */
  private onFailure(): void {
    this.circuitBreaker.failureCount++;
    this.circuitBreaker.lastFailureTime = Date.now();

    if (this.circuitBreaker.failureCount >= this.circuitBreaker.failureThreshold) {
      this.circuitBreaker.state = 'OPEN';
      console.error('🔴 Circuit breaker moved to OPEN state due to failures');
    }
  }

  /**
   * Получить состояние circuit breaker
   */
  getCircuitBreakerState(): { state: string; failureCount: number; successCount: number } {
    return {
      state: this.circuitBreaker.state,
      failureCount: this.circuitBreaker.failureCount,
      successCount: this.circuitBreaker.successCount,
    };
  }

  /**
   * Обработать конкретное сообщение из outbox
   */
  async processMessage(messageId: string): Promise<boolean> {
    const client = await this.pool.connect();

    let row: OutboxRow | null = null;
    try {
      const messageResult = await client.query<OutboxRow>(
        `SELECT * FROM ${this.schema}.${this.outboxTable} WHERE message_id = $1`,
        [messageId]
      );

      if (messageResult.rows.length === 0) {
        throw OutboxError.messageNotFound(messageId);
      }

      row = messageResult.rows[0];
    } finally {
      client.release();
    }

    if (!row) {
      throw OutboxError.messageNotFound(messageId);
    }

    try {
      await this.publishOutboxRow(row);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      await this.markFailures([{ row, error: failure }]);
      return false;
    }
    await this.markBatchAsProcessed([row.message_id]);
    return true;
  }

  /**
   * Повторить обработку неудачного сообщения
   */
  async retryMessage(messageId: string): Promise<boolean> {
    const client = await this.pool.connect();

    try {
      await client.query(
        `UPDATE ${this.schema}.${this.outboxTable}
         SET status = 'PENDING', last_retry_at = CURRENT_TIMESTAMP, next_attempt_at = now()
         WHERE message_id = $1 AND status = 'FAILED'`,
        [messageId]
      );

      return await this.processMessage(messageId);
    } finally {
      client.release();
    }
  }

  /**
   * Переместить сообщение в Dead Letter Queue
   */
  async moveToDeadLetterQueue(messageId: string, reason: string): Promise<void> {
    if (!this.config.enableDeadLetterQueue) return;

    const client = await this.pool.connect();

    try {
      const messageResult = await client.query(
        `SELECT * FROM ${this.schema}.${this.outboxTable} WHERE message_id = $1`,
        [messageId]
      );

      if (messageResult.rows.length === 0) return;

      const message = messageResult.rows[0];

      await client.query(
        `INSERT INTO ${this.schema}.${this.dlqTable}
         (dlq_message_id, original_message_id, event_id, event_type, aggregate_id,
          aggregate_version, correlation_id, idempotency_key, event_payload, event_metadata, failure_reason, original_retry_count, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [
          IdGenerator.generateWithPrefix('dlq'),
          messageId,
          message.event_id,
          message.event_type,
          message.aggregate_id,
          message.aggregate_version,
          message.correlation_id,
          message.idempotency_key,
          message.event_payload,
          message.event_metadata,
          reason,
          message.retry_count,
          message.metadata
        ]
      );

      await client.query(
        `DELETE FROM ${this.schema}.${this.outboxTable} WHERE message_id = $1`,
        [messageId]
      );

      if (OUTBOX_METRICS_ON) {
        OUTBOX_DLQ_TOTAL.labels(message.event_type).inc();
      }

      console.log(`📮 Moved message ${messageId} to DLQ: ${reason}`);
    } finally {
      client.release();
    }
  }

  /**
   * Получить сообщения из Dead Letter Queue с мониторингом
   */
  async getDeadLetterMessages(limit?: number): Promise<OutboxMessage[]> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<DlqRow>(
        `SELECT * FROM ${this.schema}.${this.dlqTable}
         ORDER BY moved_to_dlq_at DESC
         LIMIT $1`,
        [limit || 50]
      );

      // Мониторинг размера DLQ
      const dlqSize = await this.getDeadLetterQueueSize(client);
      if (dlqSize > 1000) {
        console.warn(`⚠️ DLQ size is large: ${dlqSize} messages. Consider investigating failures.`);
      }

      return result.rows.map((row) => ({
        messageId: row.dlq_message_id,
        event: {
          eventId: row.event_id,
          type: row.event_type,
          aggregateId: row.aggregate_id,
          correlationId: row.correlation_id,
          timestamp: new Date(row.moved_to_dlq_at),
          aggregateVersion: row.aggregate_version,
          idempotencyKey: row.idempotency_key || undefined,
          payload: safeParse(row.event_payload) as Record<string, unknown>,
          metadata: row.event_metadata ? safeParse(row.event_metadata) as Record<string, unknown> : undefined
        },
        status: 'DEAD_LETTER',
        retryCount: row.replay_attempts,
        createdAt: new Date(row.moved_to_dlq_at),
        lastError: row.failure_reason,
        metadata: row.metadata ? safeParse(row.metadata) as Record<string, unknown> : undefined,

        // causationId / transactionId всё ещё не сохраняются в DLQ схеме
        transactionId: undefined,
        eventTimestamp: new Date(row.moved_to_dlq_at),
        aggregateVersion: row.aggregate_version,
        causationId: undefined
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Получить размер dead letter queue
   */
  async getDeadLetterQueueSize(client?: PoolClient): Promise<number> {
    const dbClient = client || await this.pool.connect();
    const shouldRelease = !client;

    try {
      const result = await dbClient.query(
        `SELECT COUNT(*) as count FROM ${this.schema}.${this.dlqTable}`
      );
      return parseInt(result.rows[0].count, 10);
    } finally {
      if (shouldRelease) {
        dbClient.release();
      }
    }
  }

  /**
   * Получить статистику DLQ (по типам событий и причинам ошибок)
   */
  async getDeadLetterQueueStats(): Promise<{
    total: number;
    byEventType: Record<string, number>;
    byFailureReason: Record<string, number>;
    oldestMessage: Date | null;
  }> {
    const client = await this.pool.connect();

    try {
      const total = await this.getDeadLetterQueueSize(client);

      // Статистика по типам событий
      const eventTypeResult = await client.query(
        `SELECT event_type, COUNT(*) as count
         FROM ${this.schema}.${this.dlqTable}
         GROUP BY event_type
         ORDER BY count DESC`
      );

      const byEventType: Record<string, number> = {};
      for (const row of eventTypeResult.rows) {
        byEventType[row.event_type] = parseInt(row.count, 10);
      }

      // Статистика по причинам ошибок
      const failureReasonResult = await client.query(
        `SELECT failure_reason, COUNT(*) as count
         FROM ${this.schema}.${this.dlqTable}
         GROUP BY failure_reason
         ORDER BY count DESC`
      );

      const byFailureReason: Record<string, number> = {};
      for (const row of failureReasonResult.rows) {
        byFailureReason[row.failure_reason] = parseInt(row.count, 10);
      }

      // Самое старое сообщение
      const oldestResult = await client.query(
        `SELECT MIN(moved_to_dlq_at) as oldest FROM ${this.schema}.${this.dlqTable}`
      );
      const oldestMessage = oldestResult.rows[0].oldest
        ? new Date(oldestResult.rows[0].oldest)
        : null;

      return {
        total,
        byEventType,
        byFailureReason,
        oldestMessage,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Повторить обработку сообщения из Dead Letter Queue
   */
  async replayDeadLetterMessage(messageId: string): Promise<boolean> {
    const client = await this.pool.connect();

    try {
      const messageResult = await client.query(
        `SELECT * FROM ${this.schema}.${this.dlqTable} WHERE dlq_message_id = $1`,
        [messageId]
      );

      if (messageResult.rows.length === 0) {
        throw OutboxError.messageNotFound(messageId);
      }

      const dlqMessage = messageResult.rows[0];

      await client.query(
        `INSERT INTO ${this.schema}.${this.outboxTable}
         (message_id, event_id, event_type, aggregate_id, aggregate_version, correlation_id, causation_id,
          idempotency_key, event_timestamp, event_payload, event_metadata, status, retry_count, transaction_id, metadata)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8, CURRENT_TIMESTAMP, $9, $10, 'PENDING', 0, $11, $12)`,
        [
          IdGenerator.generateWithPrefix('replayed'),
          dlqMessage.event_id,
          dlqMessage.event_type,
          dlqMessage.aggregate_id,
          dlqMessage.aggregate_version,
          dlqMessage.correlation_id,
          null,
          dlqMessage.idempotency_key || null,
          dlqMessage.event_payload,
          dlqMessage.event_metadata,
          dlqMessage.transaction_id || null,
          dlqMessage.metadata || null
        ]
      );

      await client.query(
        `DELETE FROM ${this.schema}.${this.dlqTable} WHERE dlq_message_id = $1`,
        [messageId]
      );

      await client.query(
        `UPDATE ${this.schema}.${this.dlqTable}
         SET replay_attempts = replay_attempts + 1, last_replay_at = CURRENT_TIMESTAMP
         WHERE dlq_message_id = $1`,
        [messageId]
      );

      console.log(`🔄 Replayed DLQ message ${messageId}`);

      return true;
    } finally {
      client.release();
    }
  }

  /**
   * Получить статистику outbox
   */
  async getStats(): Promise<OutboxStats> {
    const client = await this.pool.connect();

    try {
      const result = await client.query(
        `SELECT 
           COUNT(*) as total_messages,
           COUNT(*) FILTER (WHERE status = 'PENDING') as pending_messages,
           COUNT(*) FILTER (WHERE status = 'PROCESSING') as processing_messages,
           COUNT(*) FILTER (WHERE status = 'PUBLISHED') as published_messages,
           COUNT(*) FILTER (WHERE status = 'FAILED') as failed_messages,
           COUNT(*) FILTER (WHERE status = 'DEAD_LETTER') as dead_letter_messages,
           MAX(created_at) as last_message_at
         FROM ${this.schema}.${this.outboxTable}`
      );

      const stats = result.rows[0];

      return {
        totalMessages: parseInt(stats.total_messages || '0', 10),
        pendingMessages: parseInt(stats.pending_messages || '0', 10),
        processingMessages: parseInt(stats.processing_messages || '0', 10),
        publishedMessages: parseInt(stats.published_messages || '0', 10),
        failedMessages: parseInt(stats.failed_messages || '0', 10),
        deadLetterMessages: parseInt(stats.dead_letter_messages || '0', 10),
        averagePublishTime: 0, // TODO: измерять publish time транзакций
        lastMessageAt: stats.last_message_at ? new Date(stats.last_message_at) : undefined
      };
    } finally {
      client.release();
    }
  }

  /**
   * Проверить здоровье outbox (БД + Event Bus)
   */
  async isHealthy(): Promise<boolean> {
    try {
      const client = await this.pool.connect();
      try {
        await client.query('SELECT 1');
        const eventBusHealthy = await this.eventBus.isHealthy();
        return eventBusHealthy;
      } finally {
        client.release();
      }
    } catch (error) {
      console.error('Outbox health check failed:', error);
      return false;
    }
  }

  /**
   * Очистить старые сообщения
   */
  async cleanupOldMessages(olderThanDays: number): Promise<number> {
    const client = await this.pool.connect();

    try {
      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - olderThanDays);

      const publishedResult = await client.query(
        `DELETE FROM ${this.schema}.${this.outboxTable}
         WHERE status = 'PUBLISHED' AND published_at < $1`,
        [cutoffDate]
      );

      const dlqResult = await client.query(
        `DELETE FROM ${this.schema}.${this.dlqTable}
         WHERE moved_to_dlq_at < $1`,
        [cutoffDate]
      );

      const deletedCount = (publishedResult.rowCount || 0) + (dlqResult.rowCount || 0);
      console.log(`🧹 Cleaned up ${deletedCount} old published/DLQ messages`);
      return deletedCount;
    } finally {
      client.release();
    }
  }

  /**
   * Запустить фоновую обработку outbox
   */
  async startProcessing(): Promise<void> {
    if (this.isWorkerRunning) {
      return;
    }

    console.log('🚀 Starting outbox processing...');

    this.isWorkerRunning = true;
    this.processingInterval = setInterval(async () => {
      if (!this.isWorkerRunning) {
        return;
      }

      if (this.isProcessing) {
        return;
      }

      this.isProcessing = true;
      try {
        await this.processPendingMessages();
      } catch (error) {
        console.error('Error in outbox processing:', error);
      } finally {
        this.isProcessing = false;
      }
    }, this.config.processingIntervalMs);
  }

  /**
   * Остановить фоновую обработку outbox
   */
  async stopProcessing(): Promise<void> {
    if (!this.isWorkerRunning) {
      return;
    }

    this.isWorkerRunning = false;

    if (this.processingInterval) {
      clearInterval(this.processingInterval);
      this.processingInterval = undefined;
    }

    console.log('🛑 Stopped outbox processing');
  }

  /**
   * Закрыть outbox
   */
  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    await this.stopProcessing();
    // Symmetric unsubscription — prevents EventEmitter listener leaks (OOM-008)
    this.pool.removeListener('error', this.onPoolError);
    await this.pool.end();
    console.log('📦 PostgreSQL Outbox connections closed');
  }

  // ==============================================================================
  // Вспомогательные методы
  // ==============================================================================

  /**
   * Получить следующую версию агрегата в рамках текущей транзакции
   */
  private async getNextAggregateVersionTx(
    client: PoolClient,
    aggregateId: string,
    cache: Map<string, number>
  ): Promise<number> {
    if (!cache.has(aggregateId)) {
      const res = await client.query(
        `SELECT COALESCE(MAX(aggregate_version), 0) as latest
         FROM ${this.eventStoreSchema}.${this.eventStoreEventsTable}
         WHERE aggregate_id = $1`,
        [aggregateId]
      );
      const latest = parseInt(res.rows[0]?.latest || '0', 10);
      cache.set(aggregateId, latest);
    }

    const next = (cache.get(aggregateId) || 0) + 1;
    cache.set(aggregateId, next);
    return next;
  }

  /**
   * One INSERT per table for the whole batch.
   * A version conflict aborts only this statement (savepoint), then the batch is retried.
   * PostgreSQL otherwise marks the surrounding transaction aborted after 23505.
   */
  private async insertEventsAndOutboxBatch(
    client: PoolClient,
    events: DomainEvent[],
    transactionId?: string,
    options?: OutboxSaveOptions,
  ): Promise<OutboxMessage[]> {
    const maxAttempts = 5;
    const versionCache = new Map<string, number>();
    const expected = options?.expectedAggregateVersion;
    if (expected !== undefined && new Set(events.map((event) => event.aggregateId)).size !== 1) {
      throw new Error('expectedAggregateVersion needs events of exactly one aggregate');
    }

    const attemptWrite = async (attempt: number): Promise<OutboxMessage[]> => {
      await client.query('SAVEPOINT outbox_batch');
      try {
        // Queue every writer of these aggregates until this transaction ends.
        // Locking only the current head misses a row inserted after that head:
        // the waiter still observes the old version and appends another.
        const aggregateIds = [...new Set(events.map((event) => event.aggregateId))].sort();
        await aggregateIds.reduce<Promise<void>>(async (previous, aggregateId) => {
          await previous;
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [aggregateId]);
        }, Promise.resolve());
        if (expected !== undefined) {
          const current = await client.query(
            `SELECT COALESCE(MAX(aggregate_version), 0) AS v
               FROM ${this.eventStoreSchema}.${this.eventStoreEventsTable}
              WHERE aggregate_id = $1`,
            [events[0].aggregateId],
          );
          const actual = Number(current.rows[0]?.v ?? 0);
          if (actual !== expected) {
            throw new ConcurrencyError(
              `Aggregate ${events[0].aggregateId} version conflict: expected ${expected}, actual ${actual}`,
              { metadata: { aggregateId: events[0].aggregateId, expectedVersion: expected, actualVersion: actual } },
            );
          }
        }
        const prepared = await events.reduce<Promise<Array<{ event: DomainEvent; version: number }>>>(
          async (previous, event) => {
            const rows = await previous;
            const version = await this.getNextAggregateVersionTx(client, event.aggregateId, versionCache);
            rows.push({ event, version });
            return rows;
          },
          Promise.resolve([]),
        );

        const inserted = await client.query<{ event_id: string; gsn: number | string | null }>(
          `INSERT INTO ${this.eventStoreSchema}.${this.eventStoreEventsTable}
             (event_id, event_type, aggregate_id, aggregate_version, correlation_id, causation_id, timestamp, payload, metadata)
           SELECT * FROM UNNEST($1::text[], $2::text[], $3::text[], $4::int[], $5::text[], $6::text[], $7::timestamp[], $8::jsonb[], $9::jsonb[])
             AS t(event_id, event_type, aggregate_id, aggregate_version, correlation_id, causation_id, timestamp, payload, metadata)
           RETURNING event_id, gsn`,
          [
            prepared.map((row) => row.event.eventId),
            prepared.map((row) => row.event.type),
            prepared.map((row) => row.event.aggregateId),
            prepared.map((row) => row.version),
            prepared.map((row) => row.event.correlationId),
            prepared.map((row) => row.event.causationId || null),
            prepared.map((row) => row.event.timestamp),
            prepared.map((row) => JSON.stringify(row.event.payload || {})),
            prepared.map((row) => (row.event.metadata ? JSON.stringify(row.event.metadata) : null)),
          ],
        );

        const gsnByEventId = new Map(inserted.rows.map((row) => [row.event_id, row.gsn]));
        const messages = prepared.map(({ event, version }) => OutboxUtils.createOutboxMessage(
          { ...event, aggregateVersion: version },
          transactionId,
          gsnByEventId.get(event.eventId) ?? undefined,
        ));

        await client.query(
          `INSERT INTO ${this.schema}.${this.outboxTable}
             (message_id, event_id, event_type, aggregate_id, aggregate_version, correlation_id, causation_id,
              idempotency_key, event_timestamp, event_payload, event_metadata, event_gsn, status, retry_count, transaction_id, metadata)
           SELECT
             t.message_id, t.event_id, t.event_type, t.aggregate_id, t.aggregate_version, t.correlation_id, t.causation_id,
             t.idempotency_key, t.event_timestamp, t.event_payload, t.event_metadata, t.event_gsn, 'PENDING', 0, t.transaction_id, t.metadata
           FROM UNNEST(
             $1::text[], $2::text[], $3::text[], $4::text[], $5::int[], $6::text[], $7::text[],
             $8::text[], $9::timestamp[], $10::jsonb[], $11::jsonb[], $12::bigint[], $13::text[], $14::jsonb[]
           ) AS t(
             message_id, event_id, event_type, aggregate_id, aggregate_version, correlation_id, causation_id,
             idempotency_key, event_timestamp, event_payload, event_metadata, event_gsn, transaction_id, metadata
           )`,
          [
            messages.map((message) => message.messageId),
            prepared.map((row) => row.event.eventId),
            prepared.map((row) => row.event.type),
            prepared.map((row) => row.event.aggregateId),
            prepared.map((row) => row.version),
            prepared.map((row) => row.event.correlationId),
            prepared.map((row) => row.event.causationId || null),
            prepared.map((row) => row.event.idempotencyKey || null),
            prepared.map((row) => row.event.timestamp),
            prepared.map((row) => JSON.stringify(row.event.payload || {})),
            prepared.map((row) => (row.event.metadata ? JSON.stringify(row.event.metadata) : null)),
            prepared.map((row) => gsnByEventId.get(row.event.eventId) ?? null),
            messages.map(() => transactionId || null),
            messages.map((message) => (message.metadata ? JSON.stringify(message.metadata) : null)),
          ],
        );

        await client.query('RELEASE SAVEPOINT outbox_batch');

        if (OUTBOX_METRICS_ON) {
          prepared.forEach((row) => {
            OUTBOX_ENQUEUED_TOTAL.labels(row.event.type).inc();
          });
        }
        return messages;
      } catch (error: unknown) {
        try {
          await client.query('ROLLBACK TO SAVEPOINT outbox_batch');
        } catch {
          // The transaction may already be finished.
        }
        const pgError = error as { code?: string };
        if (error instanceof ConcurrencyError) {
          throw error;
        }
        if (pgError?.code === '23505' && expected !== undefined) {
          // Re-numbering after a concurrent write would commit a decision made on old state.
          throw new ConcurrencyError(
            `Aggregate ${events[0].aggregateId} version conflict: another writer appended`,
            { metadata: { aggregateId: events[0].aggregateId, expectedVersion: expected } },
          );
        }
        if (pgError?.code === '23505' && attempt < maxAttempts - 1) {
          events.forEach((event) => versionCache.delete(event.aggregateId));
          const delay = 10 * Math.pow(2, attempt);
          await new Promise((resolve) => setTimeout(resolve, delay));
          return attemptWrite(attempt + 1);
        }
        throw error;
      }
    };

    return attemptWrite(0);
  }

  /**
   * Publish one claimed row. The caller marks PUBLISHED or FAILED afterwards,
   * so a poll does not open a database connection per row.
   */
  private async publishOutboxRow(row: OutboxRow): Promise<void> {
    const tStart = Date.now();
    const event: DomainEvent = {
      eventId: row.event_id,
      type: row.event_type,
      aggregateId: row.aggregate_id,
      aggregateVersion: row.aggregate_version || 0,
      correlationId: row.correlation_id,
      causationId: row.causation_id || undefined,
      idempotencyKey: row.idempotency_key || undefined,
      timestamp: new Date(row.event_timestamp),
      payload: safeParse(row.event_payload) as Record<string, unknown>,
      metadata: row.event_metadata ? safeParse(row.event_metadata) as Record<string, unknown> : undefined
    };

    if (OUTBOX_LOGS === 'json') {
      console.info(JSON.stringify({
        msg: 'outbox_publish_attempt',
        message_id: row.message_id,
        event_type: event.type,
        event_id: event.eventId,
        correlation_id: event.correlationId,
        aggregate_id: event.aggregateId,
        ts: new Date().toISOString()
      }));
    }

    await this.eventBus.publish(event);

    if (OUTBOX_METRICS_ON) {
      OUTBOX_PUBLISHED_TOTAL.labels(event.type).inc();
      OUTBOX_PUBLISH_LATENCY_MS.labels(event.type).observe(Date.now() - tStart);
    }

    if (OUTBOX_LOGS === 'json') {
      console.info(JSON.stringify({
        msg: 'outbox_published',
        message_id: row.message_id,
        event_type: event.type,
        event_id: event.eventId,
        correlation_id: event.correlationId,
        aggregate_id: event.aggregateId,
        ts: new Date().toISOString()
      }));
    }
  }

  /**
   * Обновить статус группы успешно опубликованных сообщений (bulk update).
   * Использует один UPDATE с WHERE message_id = ANY($1::text[]), чтобы минимизировать
   * количество краткоживущих подключений к БД.
   */
  private async markBatchAsProcessed(messageIds: string[], leaseToken?: string): Promise<void> {
    if (messageIds.length === 0) {
      return;
    }

    const client = await this.pool.connect();
    try {
      // With a lease token, only rows still held by this claim change. A row another
      // worker re-claimed after our lease expired stays theirs (it is delivered again:
      // at-least-once).
      const result = await client.query(
        `UPDATE ${this.schema}.${this.outboxTable}
         SET status = 'PUBLISHED', published_at = CURRENT_TIMESTAMP, lease_token = NULL
         WHERE message_id = ANY($1::text[])
           AND ($2::text IS NULL OR lease_token = $2::text)`,
        [messageIds, leaseToken ?? null]
      );
      if (leaseToken && (result.rowCount ?? 0) < messageIds.length) {
        this.logger?.warn?.('outbox_lease_lost', {
          expected: messageIds.length,
          marked: result.rowCount ?? 0,
        });
      }
    } finally {
      client.release();
    }
  }

  /**
   * One UPDATE for every row this poll failed to publish.
   * A row that has used its retries then moves to the dead-letter queue.
   */
  private async markFailures(
    failures: ReadonlyArray<{ row: OutboxRow; error: Error }>,
    leaseToken?: string,
  ): Promise<void> {
    if (failures.length === 0) {
      return;
    }
    const client = await this.pool.connect();
    try {
      await client.query(
        `UPDATE ${this.schema}.${this.outboxTable} AS o
            SET retry_count = o.retry_count + 1,
                status = 'FAILED',
                last_error = v.message,
                lease_token = NULL,
                next_attempt_at = now() + make_interval(secs => v.delay_ms / 1000.0)
           FROM unnest($1::text[], $2::text[], $3::int[]) AS v(message_id, message, delay_ms)
          WHERE o.message_id = v.message_id
            AND ($4::text IS NULL OR o.lease_token = $4::text)`,
        [
          failures.map((failure) => failure.row.message_id),
          failures.map((failure) => failure.error.message),
          failures.map((failure) => outboxRetryDelayMs(
            failure.row.retry_count + 1,
            this.config.retryDelayMs,
            this.config.retryMaxDelayMs,
          )),
          leaseToken ?? null,
        ],
      );
    } finally {
      client.release();
    }

    await failures.reduce(async (previous, failure) => {
      await previous;
      await this.noteFailure(failure.row, failure.error);
    }, Promise.resolve());
  }

  private async noteFailure(row: OutboxRow, error: Error): Promise<void> {
    if (OUTBOX_METRICS_ON) {
      const et = (typeof row.event_type === 'string' && row.event_type) || 'unknown';
      OUTBOX_FAILED_TOTAL.labels(et).inc();
    }

    if (OUTBOX_LOGS === 'json') {
      console.error(JSON.stringify({
        msg: 'outbox_publish_failed',
        message_id: row.message_id,
        event_type: row.event_type,
        event_id: row.event_id,
        correlation_id: row.correlation_id,
        error: error.message,
        ts: new Date().toISOString()
      }));
    }

    console.error(`❌ Failed to publish outbox message ${row.message_id}:`, error);

    if (row.retry_count + 1 >= this.config.maxRetries) {
      await this.moveToDeadLetterQueue(row.message_id, `Max retries exceeded: ${error.message}`);
    }
  }
}

/** Delay before attempt `attempt` (1-based): base * 2^(attempt-1), capped, with full jitter. */
export function outboxRetryDelayMs(attempt: number, baseMs: number, maxMs: number): number {
  const exponential = Math.min(maxMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.round(exponential * (0.5 + Math.random() * 0.5));
}

/**
 * Безопасный JSON parse из pg json/jsonb поля
 */
function safeParse(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    const result = tryJsonParse<unknown>(value);
    if (result.ok) {
      return result.value;
    }
    return value;
  }
  return value;
}

/**
 * Фабрика для создания PostgreSQL Outbox
 */
export function createPostgreSQLOutbox(
  config: PostgreSQLOutboxConfig,
  eventStore: unknown, // не используется напрямую
  eventBus: IEventBus
): PostgreSQLOutbox {
  return new PostgreSQLOutbox(config, eventStore, eventBus);
}