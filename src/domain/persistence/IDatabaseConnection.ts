/**
 * IDatabaseConnection - интерфейс для работы с базой данных
 * Layer: Domain (бизнес-логика)
 *
 * Определяет контракт для выполнения запросов к базе данных.
 * Следует принципу Dependency Inversion - Domain не зависит от конкретной СУБД.
 *
 * @example
 * ```typescript
 * // Application Layer использует интерфейс
 * class UserRepository {
 *   constructor(private db: IDatabaseConnection) {}
 *
 *   async findById(id: string): Promise<User | null> {
 *     const rows = await this.db.query<User>(
 *       'SELECT * FROM users WHERE id = $1',
 *       [id]
 *     );
 *     return rows[0] || null;
 *   }
 * }
 * ```
 */

import { Timestamp } from '../../core/types';

/**
 * Результат выполнения запроса
 */
export type QueryResult<T> = {
  /** Строки результата */
  rows: T[];
  /** Количество затронутых строк */
  rowCount: number;
  /** Метаданные запроса */
  metadata?: QueryMetadata;
};

/**
 * Метаданные запроса
 */
export interface QueryMetadata {
  /** Время выполнения в миллисекундах */
  executionTimeMs: number;
  /** Использованный SQL */
  sql: string;
  /** Параметры запроса */
  parameters: unknown[];
  /** Время выполнения */
  executedAt: Timestamp;
}

/**
 * Опции транзакции
 */
export interface TransactionOptions {
  /** Уровень изоляции */
  isolationLevel?: 'READ_UNCOMMITTED' | 'READ_COMMITTED' | 'REPEATABLE_READ' | 'SERIALIZABLE';
  /** Таймаут в миллисекундах */
  timeoutMs?: number;
  /** Только чтение */
  readOnly?: boolean;
  /** Abort signal для отмены транзакции (A-016) */
  signal?: AbortSignal;
}

/**
 * Состояние подключения
 */
export enum ConnectionState {
  CONNECTED = 'connected',
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  ERROR = 'error',
}

/**
 * Информация о подключении
 */
export interface ConnectionInfo {
  /** Состояние подключения */
  state: ConnectionState;
  /** Время последнего подключения */
  connectedAt?: Timestamp;
  /** Время последней активности */
  lastActivityAt?: Timestamp;
  /** Количество активных транзакций */
  activeTransactions: number;
  /** Статистика подключения */
  stats?: ConnectionStats;
}

/**
 * Статистика подключения
 */
export interface ConnectionStats {
  /** Общее количество запросов */
  totalQueries: number;
  /** Количество успешных запросов */
  successfulQueries: number;
  /** Количество ошибок */
  errorCount: number;
  /** Среднее время выполнения */
  averageExecutionTimeMs: number;
  /** Максимальное время выполнения */
  maxExecutionTimeMs: number;
}

/**
 * IDatabaseConnection - интерфейс для работы с базой данных
 *
 * Определяет операции для выполнения SQL запросов и управления транзакциями
 * без привязки к конкретной СУБД. Реализация этого интерфейса будет в Infrastructure слое
 * и может использовать PostgreSQL, MySQL, SQLite, или другие базы данных.
 */
export interface IDatabaseConnection {
  /**
   * Выполнить SQL запрос
   *
   * @param sql - SQL запрос
   * @param params - Параметры запроса
   * @returns Результат выполнения запроса
   *
   * @example
   * ```typescript
   * const users = await db.query<User>(
   *   'SELECT id, name, email FROM users WHERE active = $1',
   *   [true]
   * );
   * ```
   */
  query<T = unknown>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;

  /**
   * Выполнить запрос, возвращающий одну строку
   *
   * @param sql - SQL запрос
   * @param params - Параметры запроса
   * @returns Первая строка результата или null
   *
   * @example
   * ```typescript
   * const user = await db.queryOne<User>(
   *   'SELECT * FROM users WHERE id = $1',
   *   [userId]
   * );
   * ```
   */
  queryOne<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;

  /**
   * Выполнить запрос, возвращающий скалярное значение
   *
   * @param sql - SQL запрос
   * @param params - Параметры запроса
   * @returns Скалярное значение
   *
   * @example
   * ```typescript
   * const count = await db.queryScalar<number>(
   *   'SELECT COUNT(*) FROM users WHERE active = $1',
   *   [true]
   * );
   * ```
   */
  queryScalar<T = unknown>(sql: string, params?: unknown[]): Promise<T | null>;

  /**
   * Выполнить запрос на изменение данных
   *
   * @param sql - SQL запрос (INSERT, UPDATE, DELETE)
   * @param params - Параметры запроса
   * @returns Количество затронутых строк
   *
   * @example
   * ```typescript
   * const affectedRows = await db.execute(
   *   'UPDATE users SET last_login = $1 WHERE id = $2',
   *   [new Date(), userId]
   * );
   * ```
   */
  execute(sql: string, params?: unknown[]): Promise<number>;

  /**
   * Выполнить код в транзакции
   *
   * @param callback - Функция, выполняемая в транзакции
   * @param options - Опции транзакции
   * @returns Результат выполнения callback
   *
   * @example
   * ```typescript
   * const result = await db.transaction(async () => {
   *   const user = await db.queryOne('SELECT * FROM users WHERE id = $1', [id]);
   *   await db.execute('UPDATE users SET balance = balance - 100 WHERE id = $1', [id]);
   *   await db.execute('INSERT INTO transactions (user_id, amount) VALUES ($1, $2)', [id, -100]);
   *   return user;
   * });
   * ```
   */
  transaction<T>(
    callback: () => Promise<T>,
    options?: TransactionOptions
  ): Promise<T>;

  /**
   * Проверить существование таблицы
   *
   * @param tableName - Имя таблицы
   * @returns true если таблица существует
   */
  tableExists(tableName: string): Promise<boolean>;

  /**
   * Получить информацию о схеме таблицы
   *
   * @param tableName - Имя таблицы
   * @returns Схема таблицы
   */
  getTableSchema(tableName: string): Promise<TableSchema | null>;

  /**
   * Получить информацию о подключении
   *
   * @returns Информация о подключении
   */
  getConnectionInfo(): Promise<ConnectionInfo>;

  /**
   * Проверить доступность подключения
   *
   * @returns true если подключение активно
   */
  isConnected(): Promise<boolean>;

  /**
   * Закрыть подключение
   */
  close(): Promise<void>;
}

/**
 * Схема таблицы
 */
export interface TableSchema {
  /** Имя таблицы */
  name: string;
  /** Колонки таблицы */
  columns: TableColumn[];
  /** Индексы */
  indexes: TableIndex[];
  /** Ограничения */
  constraints: TableConstraint[];
}

/**
 * Колонка таблицы
 */
export interface TableColumn {
  /** Имя колонки */
  name: string;
  /** Тип данных */
  type: string;
  /** Nullable */
  nullable: boolean;
  /** Значение по умолчанию */
  defaultValue?: unknown;
  /** Первичный ключ */
  primaryKey: boolean;
  /** Автоинкремент */
  autoIncrement: boolean;
}

/**
 * Индекс таблицы
 */
export interface TableIndex {
  /** Имя индекса */
  name: string;
  /** Колонки индекса */
  columns: string[];
  /** Уникальный индекс */
  unique: boolean;
}

/**
 * Ограничение таблицы
 */
export interface TableConstraint {
  /** Имя ограничения */
  name: string;
  /** Тип ограничения */
  type: 'PRIMARY_KEY' | 'FOREIGN_KEY' | 'UNIQUE' | 'CHECK';
  /** Колонки */
  columns: string[];
  /** Ссылка для внешнего ключа */
  references?: {
    table: string;
    columns: string[];
  };
}