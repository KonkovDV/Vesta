/**
 * PostgresAdapter - адаптер для PostgreSQL
 * Layer: Infrastructure
 *
 * Реализует IDatabaseConnection интерфейс для работы с PostgreSQL.
 * Инкапсулирует специфику PostgreSQL и предоставляет унифицированный интерфейс.
 *
 * @example
 * ```typescript
 * import { getDatabaseConfig } from '../config/config';
 *
 * const dbConfig = getDatabaseConfig();
 * const adapter = new PostgresAdapter({
 *   connectionString: dbConfig.connectionString,
 *   ssl: dbConfig.ssl
 * });
 *
 * const users = await adapter.query<User>(
 *   'SELECT * FROM users WHERE active = $1',
 *   [true]
 * );
 * ```
 */

import { Pool, PoolConfig, QueryResult as PgQueryResult, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import {
  IDatabaseConnection,
  QueryResult,
  QueryMetadata,
  TransactionOptions,
  ConnectionState,
  ConnectionInfo,
  ConnectionStats,
  TableSchema,
  TableColumn,
  TableIndex,
  TableConstraint,
} from '../../domain/persistence/IDatabaseConnection';
import { Timestamp, now } from '../../core/types';
import { getDatabaseConfig } from '../config/config';
import { isNonNullObject } from '../../core/guards/type-guards';
import {
  getActivePgClient,
  requireActivePgClient,
  runWithPgClient,
} from './PgClientContext';

// Re-export PgClientContext helpers for backward compatibility.
// Важно: фактический AsyncLocalStorage живёт в PgClientContext.
export { getActivePgClient, requireActivePgClient } from './PgClientContext';
/**
 * Конфигурация PostgreSQL адаптера
 */
export interface PostgresAdapterConfig extends PoolConfig {
  /** Включить логирование запросов */
  enableQueryLogging?: boolean;
  /** Максимальное время выполнения запроса в миллисекундах */
  queryTimeoutMs?: number;
  /** Включить метрики */
  enableMetrics?: boolean;
  /** Строка подключения, если используется */
  connectionString?: string;
  /** SSL options for driver (boolean or options) */
  ssl?: boolean | { rejectUnauthorized?: boolean; ca?: string; cert?: string; key?: string };
  /** Максимальное количество коннекшенов в пуле */
  max?: number;
  /** Таймаут простоя соединения в миллисекундах */
  idleTimeoutMillis?: number;
  /** Таймаут установления соединения в миллисекундах */
  connectionTimeoutMillis?: number;
}

interface ColumnInfo {
  column_name: string;
  data_type: string;
  is_nullable: 'YES' | 'NO';
  column_default: string | null;
  is_primary_key: boolean;
  is_auto_increment: boolean;
}

interface IndexInfo {
  name: string;
  indexdef: string;
  is_unique: boolean;
}

interface ConstraintInfo {
  name: string;
  constraint_type: string;
  column_name: string;
}

interface MetricsCollector {
  gauge(name: string, value: number, tags: Record<string, string>): void;
}

interface MetricsBoundAdapter {
  metrics?: MetricsCollector;
}

/**
 * PostgresAdapter - реализация IDatabaseConnection для PostgreSQL.
 *
 * ВАЖНО:
 * - транзакционный клиент хранится в PgClientContext (AsyncLocalStorage);
 * - все инфраструктурные компоненты (UoW, репозитории, Outbox) используют
 *   один и тот же AsyncLocalStorage экземпляр, зарегистрированный в DI
 *   под токеном 'PgClientContext'.
 */
export class PostgresAdapter implements IDatabaseConnection {
  private pool: Pool;
  private config: PostgresAdapterConfig;
  private connectionState: ConnectionState = ConnectionState.DISCONNECTED;
  private lastActivityAt?: Timestamp;
  private queryCount = 0;
  private errorCount = 0;
  private totalQueryTime = 0;
  private isClosed = false;

  private readonly onPoolConnect = (_client: PoolClient): void => {
    this.connectionState = ConnectionState.CONNECTED;
    this.lastActivityAt = now();
  };

  private readonly onPoolError = (err: Error, _client?: PoolClient): void => {
     
    console.error('PostgreSQL pool error:', err);
    this.connectionState = ConnectionState.ERROR;
    this.errorCount++;
  };

  private readonly onPoolRemove = (_client: PoolClient): void => {
    this.lastActivityAt = now();
  };

  /**
   * Валидация значения таймаута для безопасного использования в SET statement_timeout.
   * Разрешены только положительные целые числа; другие значения приводят к ошибке конфигурации.
   */
  private getValidatedTimeoutMs(value: number | undefined, source: string): number | undefined {
    if (typeof value === 'undefined') {
      return undefined;
    }

    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Invalid timeout value for ${source}`);
    }

    return value;
  }

  /**
   * Проверить, есть ли активный транзакционный контекст PostgreSQL.
   * Использует AsyncLocalStorage PgClientContext.
   */
  public hasActiveContext(): boolean {
    return typeof getActivePgClient() !== 'undefined';
  }

  /**
   * Жёстко получить активный транзакционный клиент PostgreSQL для адаптера.
   * Используется в методах, которые должны выполняться только в рамках
   * существующей транзакции, без fallback на autocommit.
   */
  private requireClient(operation: string = 'PostgresAdapter.requireClient'): PoolClient {
    return requireActivePgClient(operation);
  }

  constructor(config: PostgresAdapterConfig) {
    const mergedConfig: PostgresAdapterConfig = {
      enableQueryLogging: false,
      queryTimeoutMs: 30000,
      enableMetrics: true,
      ...config,
    };

    this.config = {
      ...mergedConfig,
      queryTimeoutMs: this.getValidatedTimeoutMs(
        mergedConfig.queryTimeoutMs,
        'PostgresAdapter.config.queryTimeoutMs',
      ),
    };

    this.pool = new Pool(this.config);

    // Обработчики событий пула через стабильные bound-хендлеры
    this.pool.on('connect', this.onPoolConnect);
    this.pool.on('error', this.onPoolError);
    this.pool.on('remove', this.onPoolRemove);
  }

  /**
   * Opens one pooled connection before the first request.
   * The driver connects on the first query, and PostgreSQL then starts a backend.
   * A failure is reported as false and does not decide whether the process starts.
   */
  async warmup(): Promise<boolean> {
    if (this.isClosed) return false;
    try {
      await this.pool.query('SELECT 1');
      this.connectionState = ConnectionState.CONNECTED;
      return true;
    } catch {
      this.connectionState = ConnectionState.DISCONNECTED;
      return false;
    }
  }

  /**
   * Выполнить SQL запрос
   */
  async query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>> {
    const startTime = process.hrtime.bigint();

    let client: PoolClient | null = null;
    let borrowed = false;

    try {
      const activeClient = getActivePgClient();
      if (activeClient) {
        // Транзакционный путь: используем клиент из PgClientContext.
        client = activeClient;
      } else {
        // Нет активного ALS-контекста — явный autocommit для нетранзакционных сценариев
        // (health-check, фоновые задачи и т.п.).
        client = await this.pool.connect();
        borrowed = true;

        // Установка таймаута запроса (числовое значение, провалидированное на уровне адаптера)
        const timeoutMs = this.getValidatedTimeoutMs(
          this.config.queryTimeoutMs,
          'PostgresAdapter.config.queryTimeoutMs',
        );
        if (typeof timeoutMs === 'number') {
          await client.query(`SET statement_timeout = ${timeoutMs}`);
        }
      }

      const queryStartTime = now();
      const result: PgQueryResult = await (client).query(sql, params || []);

      const endTime = process.hrtime.bigint();
      const executionTimeMs = Number(endTime - startTime) / 1e6;

      // Обновление метрик
      this.queryCount++;
      this.totalQueryTime += executionTimeMs;
      this.lastActivityAt = now();

      // Логирование запроса
      if (this.config.enableQueryLogging) {
        console.log(`[PostgreSQL] Query executed in ${executionTimeMs.toFixed(2)}ms:`, {
          sql: sql.substring(0, 100) + (sql.length > 100 ? '...' : ''),
          params,
          rowCount: result.rowCount,
        });
      }

      const metadata: QueryMetadata = {
        executionTimeMs,
        sql,
        parameters: params || [],
        executedAt: queryStartTime,
      };

      // SAFETY: PostgreSQL returns any[], we trust the query returns correct structure.
      // For critical paths, use repository-level validation with Zod or type guards.
      const rows = Array.isArray(result.rows) ? (result.rows as T[]) : [];
      return {
        rows,
        rowCount: result.rowCount || 0,
        metadata,
      };

    } catch (error) {
      this.errorCount++;
      const endTime = process.hrtime.bigint();
      const executionTimeMs = Number(endTime - startTime) / 1e6;

      if (this.config.enableQueryLogging) {
        console.error(`[PostgreSQL] Query failed in ${executionTimeMs.toFixed(2)}ms:`, {
          sql: sql.substring(0, 100) + (sql.length > 100 ? '...' : ''),
          params,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }

      if (!this.config.enableQueryLogging) {
        console.error(`[PostgreSQL] Query failed (logging forced):`, error);
      }
      throw new Error(`Database query failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      if (borrowed && client) {
        (client).release();
      }
    }
  }

  /**
   * Выполнить запрос, возвращающий одну строку
   */
  async queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null> {
    const result = await this.query<T>(sql, params);
    return result.rows[0] || null;
  }

  /**
   * Выполнить запрос, возвращающий скалярное значение
   */
  async queryScalar<T = unknown>(sql: string, params?: unknown[]): Promise<T | null> {
    const result = await this.queryOne<{ value: T }>(sql, params);
    return result?.value || null;
  }

  /**
   * Выполнить запрос на изменение данных
   */
  async execute(sql: string, params?: unknown[]): Promise<number> {
    const result = await this.query(sql, params);
    return result.rowCount;
  }

  /**
   * Выполнить код в транзакции.
   *
   * Поддерживает вложенные транзакции через SAVEPOINT:
   * - если активного PgClientContext нет — открывает новую транзакцию (BEGIN/COMMIT/ROLLBACK);
   * - если контекст уже есть — использует SAVEPOINT/RELEASE/ROLLBACK TO SAVEPOINT.
   *
   * A-016 FIX: Added abort signal support to prevent orphaned transactions
   */
  async transaction<T>(
    callback: () => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T> {
    const existingClient = getActivePgClient();

    // A-016: Check for abort signal before starting
    if (options?.signal?.aborted) {
      throw new Error(`Transaction aborted before start: ${options.signal.reason}`);
    }

    // Вложенная транзакция: используем SAVEPOINT на уже активном клиенте.
    if (existingClient) {
      const client = existingClient;
      // EV5: Use more descriptive savepoint ID if available via ALS or options
      const rawId = randomUUID();
      const savepointId = `sp_${rawId.replace(/-/g, '')}`;
      
      // A-016: Setup abort handler for nested transaction
      let abortHandler: (() => void) | undefined;
      const cleanupAbortHandler = () => {
        if (abortHandler && options?.signal) {
          options.signal.removeEventListener('abort', abortHandler);
        }
      };

      if (options?.signal) {
        abortHandler = () => {
          console.warn(`[A-016] Nested transaction aborted: ${savepointId}`);
        };
        options.signal.addEventListener('abort', abortHandler, { once: true });
      }

      try {
        await client.query(`SAVEPOINT ${savepointId}`);

        const result = await callback();

        await client.query(`RELEASE SAVEPOINT ${savepointId}`);

        return result;
      } catch (error) {
        try {
          await client.query(`ROLLBACK TO SAVEPOINT ${savepointId}`);
          console.warn(`[PostgresAdapter] Rolled back to savepoint: ${savepointId}`);
        } catch (rollbackError) {
          console.error('Failed to rollback to savepoint:', rollbackError);
        }

        if (error instanceof Error) {
          throw error;
        }

        throw new Error(String(error));
      } finally {
        cleanupAbortHandler();
      }
    }

    // Корневая транзакция: открываем новый клиент и управляем BEGIN/COMMIT/ROLLBACK.
    // A-016: Wrap connection in abort-aware promise to prevent orphaned connections
    const client = await Promise.race([
      this.pool.connect(),
      new Promise<never>((_, reject) => {
        if (options?.signal) {
          const onAbort = () => reject(new Error(`Connection aborted: ${options.signal!.reason}`));
          if (options.signal.aborted) {
            onAbort();
          } else {
            options.signal.addEventListener('abort', onAbort, { once: true });
          }
        }
      }),
    ]);

    // A-016: Setup transaction abort handling
    let transactionAborted = false;
    let abortHandler: (() => void) | undefined;
    
    const setupAbortHandler = () => {
      if (options?.signal) {
        abortHandler = () => {
          transactionAborted = true;
          console.warn('[A-016] Transaction aborted, initiating rollback');
          void (async () => {
            try {
              // Attempt immediate rollback on abort signal
              await client.query('ROLLBACK');
              console.log('[A-016] Rollback completed on abort signal');
            } catch (rollbackError) {
              console.error('[A-016] Failed to rollback on abort:', rollbackError);
            }
          })();
        };
        options.signal.addEventListener('abort', abortHandler, { once: true });
      }
    };

    const cleanupAbortHandler = () => {
      if (abortHandler && options?.signal) {
        options.signal.removeEventListener('abort', abortHandler);
      }
    };

    try {
      if (options?.isolationLevel) {
        const isolationMap: Record<NonNullable<TransactionOptions['isolationLevel']>, string> = {
          READ_UNCOMMITTED: 'READ UNCOMMITTED',
          READ_COMMITTED: 'READ COMMITTED',
          REPEATABLE_READ: 'REPEATABLE READ',
          SERIALIZABLE: 'SERIALIZABLE',
        };
        const level = isolationMap[options.isolationLevel];
        if (level) {
          await client.query(`SET TRANSACTION ISOLATION LEVEL ${level}`);
        }
      }

      const timeoutMs = this.getValidatedTimeoutMs(
        options?.timeoutMs,
        'PostgresAdapter.transaction.timeoutMs',
      );
      if (typeof timeoutMs === 'number') {
        await client.query(`SET statement_timeout = ${timeoutMs}`);
      }

      // A-016: Check abort before BEGIN
      if (transactionAborted || options?.signal?.aborted) {
        throw new Error(`Transaction aborted before BEGIN: ${options?.signal?.reason}`);
      }

      await client.query('BEGIN');

      // A-016: Setup abort handler after transaction starts
      setupAbortHandler();

      // A-016: Wrap callback in abort-aware execution
      const result = await Promise.race([
        runWithPgClient<T>(client, async () => callback()),
        new Promise<never>((_, reject) => {
          if (options?.signal) {
            const checkAbort = () => {
              if (options.signal!.aborted) {
                reject(new Error(`Transaction execution aborted: ${options.signal!.reason}`));
              }
            };
            options.signal.addEventListener('abort', checkAbort, { once: true });
          }
        }),
      ]);

      // A-016: Check if aborted before commit
      if (transactionAborted || options?.signal?.aborted) {
        throw new Error(`Transaction aborted before commit: ${options?.signal?.reason}`);
      }

      if (!options?.readOnly) {
        await client.query('COMMIT');
      } else {
        await client.query('ROLLBACK');
      }

      return result;
    } catch (error) {
      // A-016: Only rollback if not already aborted (abort handler does it)
      if (!transactionAborted) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          console.error('Failed to rollback transaction:', rollbackError);
        }
      }

      if (error instanceof Error) {
        throw error;
      }

      throw new Error(String(error));
    } finally {
      cleanupAbortHandler();
      client.release();
    }
  }

  /**
   * Проверить существование таблицы
   */
  async tableExists(tableName: string): Promise<boolean> {
    const result = await this.queryOne<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = 'public'
        AND table_name = $1
      ) as exists`,
      [tableName]
    );
    return result?.exists || false;
  }

  /**
   * Получить схему таблицы
   */
  async getTableSchema(tableName: string): Promise<TableSchema | null> {
    try {
      // Получение колонок
      const columnsResult = await this.query<ColumnInfo>(`
        SELECT
          column_name,
          data_type,
          is_nullable,
          column_default,
          CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key,
          CASE WHEN seq.sequence_name IS NOT NULL THEN true ELSE false END as is_auto_increment
        FROM information_schema.columns c
        LEFT JOIN (
          SELECT ku.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku
            ON tc.constraint_name = ku.constraint_name
          WHERE tc.constraint_type = 'PRIMARY KEY'
            AND tc.table_name = $1
        ) pk ON c.column_name = pk.column_name
        LEFT JOIN (
          SELECT seq.sequence_name, seq.table_name
          FROM information_schema.sequences seq
          WHERE seq.table_name = $1
        ) seq ON c.table_name = seq.table_name
        WHERE c.table_schema = 'public'
          AND c.table_name = $1
        ORDER BY c.ordinal_position
      `, [tableName]);

      // Получение индексов
      const indexesResult = await this.query<IndexInfo>(`
        SELECT
          indexname as name,
          indexdef,
          indisunique as is_unique
        FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = $1
      `, [tableName]);

      // Получение ограничений
      const constraintsResult = await this.query<ConstraintInfo>(`
        SELECT
          tc.constraint_name as name,
          tc.constraint_type,
          kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
        WHERE tc.table_schema = 'public'
          AND tc.table_name = $1
      `, [tableName]);

      if (columnsResult.rows.length === 0) {
        return null;
      }

      const columns: TableColumn[] = columnsResult.rows.map(row => ({
        name: row.column_name,
        type: row.data_type,
        nullable: row.is_nullable === 'YES',
        defaultValue: row.column_default,
        primaryKey: row.is_primary_key,
        autoIncrement: row.is_auto_increment,
      }));

      const indexes: TableIndex[] = indexesResult.rows
        .filter(row => !row.name.includes('_pkey')) // Исключаем первичные ключи
        .map(row => ({
          name: row.name,
          columns: this.extractColumnsFromIndexDef(row.indexdef),
          unique: row.is_unique,
        }));

      const constraints: TableConstraint[] = constraintsResult.rows.map(row => ({
        name: row.name,
        type: this.mapConstraintType(row.constraint_type),
        columns: [row.column_name],
      }));

      return {
        name: tableName,
        columns,
        indexes,
        constraints,
      };

    } catch (error) {
      console.error(`Failed to get schema for table ${tableName}:`, error);
      return null;
    }
  }

  /**
   * Получить информацию о подключении
   */
  async getConnectionInfo(): Promise<ConnectionInfo> {
    const poolStats = this.pool.totalCount > 0 ? {
      totalConnections: this.pool.totalCount,
      idleConnections: this.pool.idleCount,
      waitingClients: this.pool.waitingCount,
    } : undefined;

    return {
      state: this.connectionState,
      connectedAt: this.connectionState === ConnectionState.CONNECTED ? now() : undefined,
      lastActivityAt: this.lastActivityAt,
      activeTransactions: 0, // PostgreSQL не предоставляет эту информацию напрямую
      stats: poolStats ? {
        totalQueries: this.queryCount,
        successfulQueries: this.queryCount - this.errorCount,
        errorCount: this.errorCount,
        averageExecutionTimeMs: this.queryCount > 0 ? this.totalQueryTime / this.queryCount : 0,
        maxExecutionTimeMs: 0, // Не отслеживаем максимум
        ...poolStats,
      } : undefined,
    };
  }

  /**
   * Проверить доступность подключения
   */
  async isConnected(): Promise<boolean> {
    try {
      await this.queryScalar('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Закрыть подключение
   */
  async close(): Promise<void> {
    if (this.isClosed) {
      return;
    }

    this.pool.off('connect', this.onPoolConnect);
    this.pool.off('error', this.onPoolError);
    this.pool.off('remove', this.onPoolRemove);

    await this.pool.end();
    this.connectionState = ConnectionState.DISCONNECTED;
    this.isClosed = true;
  }

  /**
   * Извлечь имена колонок из определения индекса
   */
  private extractColumnsFromIndexDef(indexdef: string): string[] {
    // Пример: CREATE UNIQUE INDEX index_name ON table_name (column1, column2)
    const match = indexdef.match(/\(([^)]+)\)/);
    if (!match) return [];

    return match[1].split(',').map(col => col.trim().replace(/"/g, ''));
  }

  /**
   * Преобразовать тип ограничения PostgreSQL в унифицированный формат
   */
  private mapConstraintType(constraintType: string): TableConstraint['type'] {
    switch (constraintType) {
      case 'PRIMARY KEY': return 'PRIMARY_KEY';
      case 'FOREIGN KEY': return 'FOREIGN_KEY';
      case 'UNIQUE': return 'UNIQUE';
      case 'CHECK': return 'CHECK';
      default: return 'UNIQUE'; // fallback
    }
  }

  private isTransientError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const code = (error as { code?: string }).code;
    if (!code) return false;
    // PG transient errors
    if (code === '40001' || code === '40P01' || code === '57014') return true;
    if (code.startsWith('08')) return true;
    // Network errors
    if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT') return true;
    return false;
  }

  private collectPoolMetrics(): void {
    const metrics = (this as unknown as MetricsBoundAdapter).metrics;
    if (!metrics) return;
    const tags = { database: this.config.database ?? 'unknown' };
    metrics.gauge('db_pool_total', this.pool.totalCount ?? 0, tags);
    metrics.gauge('db_pool_idle', this.pool.idleCount ?? 0, tags);
    metrics.gauge('db_pool_waiting', this.pool.waitingCount ?? 0, tags);
  }
}

/**
 * Фабричная функция для создания PostgreSQL адаптера
 */
export function createPostgresAdapter(config: PostgresAdapterConfig): IDatabaseConnection {
  return new PostgresAdapter(config);
}

/**
 * Фабричная функция для создания PostgreSQL адаптера из переменных окружения
 */
export function createPostgresAdapterFromEnv(): IDatabaseConnection {
  const c = getDatabaseConfig();

  return new PostgresAdapter({
    connectionString: c.connectionString,
    ssl: c.ssl,
    max: c.max,
    idleTimeoutMillis: c.idleTimeoutMillis,
    connectionTimeoutMillis: c.connectionTimeoutMillis,
    enableQueryLogging: c.enableQueryLogging,
    enableMetrics: c.enableMetrics,
    keepAlive: c.keepAlive,
    keepAliveInitialDelayMillis: c.keepAliveInitialDelayMillis,
    statement_timeout: c.statementTimeoutMs,
  });
}