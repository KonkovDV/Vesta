/**
 * IRetryPolicy - интерфейс для Retry Policy паттерна
 * Layer: Domain (бизнес-логика)
 *
 * SSOT & НАЗНАЧЕНИЕ:
 * - Официальный доменный контракт для стратегий повторов.
 * - Реализации должны находиться в Infrastructure-слое и регистрироваться через
 *   общий DI bootstrap (src/infrastructure/di/bootstrap.ts).
 * - Не использовать как место для локальных мини-реализаций или альтернативного
 *   контейнера; это extension point, а не отдельный runtime.
 *
 * Принципы:
 * - Интерфейс определяется в Domain слое
 * - Реализация в Infrastructure слое
 * - Поддерживает различные стратегии повторов
 * - Интегрируется с Circuit Breaker
 *
 * @example
 * ```typescript
 * // Application Layer использует Retry Policy
 * class ExternalApiService {
 *   constructor(
 *     private retryPolicy: IRetryPolicy,
 *     private circuitBreaker: ICircuitBreaker
 *   ) {}
 *   
 *   async callExternalApi(request: ApiRequest) {
 *     return await this.retryPolicy.execute(
 *       async () => await this.circuitBreaker.execute(
 *         async () => await this.httpClient.request(request)
 *       ),
 *       { maxAttempts: 3, backoff: 'exponential' }
 *     );
 *   }
 * }
 * ```
 */

/**
 * Стратегия задержки между попытками
 */
export type BackoffStrategy = 
  | 'fixed'        // Фиксированная задержка
  | 'exponential'  // Экспоненциальная задержка
  | 'linear'       // Линейная задержка
  | 'jitter';      // Случайная задержка (jitter)

/**
 * Причина сбоя операции
 */
export type RetryFailureReason = 
  | 'ERROR'        // Ошибка при выполнении
  | 'TIMEOUT'      // Превышен таймаут
  | 'CIRCUIT_OPEN' // Circuit Breaker открыт
  | 'ABORTED';     // Операция прервана

/**
 * Результат выполнения операции с повторами
 */
export interface RetryResult<T> {
  /** Успешность операции */
  success: boolean;
  /** Результат операции (если успешно) */
  data?: T;
  /** Ошибка (если неуспешно) */
  error?: Error;
  /** Количество попыток */
  attempts: number;
  /** Общее время выполнения в миллисекундах */
  totalDurationMs: number;
  /** Были ли повторные попытки */
  hasRetries: boolean;
  /** Причина последнего сбоя */
  lastFailureReason?: RetryFailureReason;
}

/**
 * Информация о попытке
 */
export interface AttemptInfo {
  /** Номер попытки (начиная с 1) */
  attemptNumber: number;
  /** Время начала попытки */
  startedAt: Date;
  /** Длительность попытки в миллисекундах */
  durationMs: number;
  /** Была ли попытка успешной */
  success: boolean;
  /** Ошибка (если неуспешно) */
  error?: Error;
}

/**
 * Опции Retry Policy
 */
export interface RetryOptions {
  /** Максимальное количество попыток (по умолчанию: 3) */
  maxAttempts?: number;
  /** Стратегия задержки (по умолчанию: 'exponential') */
  backoff?: BackoffStrategy;
  /** Базовая задержка в миллисекундах (по умолчанию: 1000) */
  baseDelayMs?: number;
  /** Максимальная задержка в миллисекундах (по умолчанию: 30000) */
  maxDelayMs?: number;
  /** Фактор экспоненциального увеличения (по умолчанию: 2) */
  exponentialFactor?: number;
  /** Максимальный фактор jitter (0-1, по умолчанию: 0.5) */
  jitterFactor?: number;
  /** Таймаут одной попытки в миллисекундах (по умолчанию: 30000) */
  attemptTimeoutMs?: number;
  /** Таймаут всей операции в миллисекундах (по умолчанию: 120000) */
  totalTimeoutMs?: number;
  /** Функция для определения, нужно ли повторять при данной ошибке */
  shouldRetry?: (error: Error, attemptNumber: number) => boolean;
  /** Функция обратного вызова перед попыткой */
  onBeforeAttempt?: (attemptNumber: number) => void;
  /** Функция обратного вызова после попытки */
  onAfterAttempt?: (info: AttemptInfo) => void;
  /** Функция обратного вызова при успехе */
  onSuccess?: (result: unknown, attempts: number) => void;
  /** Функция обратного вызова при окончательной неудаче */
  onFailure?: (error: Error, attempts: number) => void;
  /** Интеграция с Circuit Breaker */
  circuitBreaker?: {
    /** Проверять Circuit Breaker перед каждой попыткой */
    checkBeforeEachAttempt?: boolean;
    /** Открывать Circuit Breaker при превышении порога */
    openOnThreshold?: boolean;
  };
  /** Имя операции для логирования и метрик */
  operationName?: string;
}

/**
 * IRetryPolicy - интерфейс для Retry Policy
 * 
 * @example
 * ```typescript
 * // Создание и использование Retry Policy
 * const retryPolicy = container.resolve<IRetryPolicy>('IRetryPolicy');
 * 
 * // Простое выполнение с повторами
 * const result = await retryPolicy.execute(
 *   async () => await externalApi.call(),
 *   { maxAttempts: 3, backoff: 'exponential' }
 * );
 * 
 * if (result.success) {
 *   console.log('Success after', result.attempts, 'attempts');
 * } else {
 *   console.error('Failed after', result.attempts, 'attempts');
 * }
 * 
 * // Выполнение с Circuit Breaker
 * const result = await retryPolicy.executeWithCircuitBreaker(
 *   async () => await externalApi.call(),
 *   circuitBreaker,
 *   { maxAttempts: 3 }
 * );
 * 
 * // Проверка, нужно ли повторять при конкретной ошибке
 * const shouldRetry = retryPolicy.shouldRetryError(
 *   new Error('Connection timeout'),
 *   1
 * );
 * ```
 */
export interface IRetryPolicy {
  /**
   * Выполнить операцию с повторными попытками при сбое
   * 
   * @param operation - Операция для выполнения
   * @param options - Опции повторов
   * @returns Результат операции
   * 
   * @example
   * ```typescript
   * const result = await retryPolicy.execute(
   *   async () => await api.call(),
   *   { maxAttempts: 3, backoff: 'exponential' }
   * );
   * ```
   */
  execute<T>(
    operation: () => Promise<T>,
    options?: RetryOptions
  ): Promise<RetryResult<T>>;

  /**
   * Выполнить операцию с повторами и Circuit Breaker
   * 
   * @param operation - Операция для выполнения
   * @param circuitBreaker - Circuit Breaker для защиты
   * @param options - Опции повторов
   * @returns Результат операции
   * 
   * @example
   * ```typescript
   * const result = await retryPolicy.executeWithCircuitBreaker(
   *   async () => await api.call(),
   *   circuitBreaker,
   *   { maxAttempts: 3 }
   * );
   * ```
   */
  executeWithCircuitBreaker<T>(
    operation: () => Promise<T>,
    circuitBreaker: { isAvailable?: () => boolean | Promise<boolean>; getState?: () => string }, // ICircuitBreaker, но избегаем циклической зависимости
    options?: RetryOptions
  ): Promise<RetryResult<T>>;

  /**
   * Проверить, нужно ли повторять операцию при данной ошибке
   * 
   * @param error - Ошибка
   * @param attemptNumber - Номер попытки
   * @returns true если нужно повторять
   * 
   * @example
   * ```typescript
   * if (retryPolicy.shouldRetryError(error, 1)) {
   *   // Повторить операцию
   * }
   * ```
   */
  shouldRetryError(error: Error, attemptNumber: number): boolean;

  /**
   * Рассчитать задержку перед следующей попыткой
   * 
   * @param attemptNumber - Номер попытки
   * @param options - Опции повторов
   * @returns Задержка в миллисекундах
   * 
   * @example
   * ```typescript
   * const delay = retryPolicy.calculateDelay(2, { backoff: 'exponential' });
   * await sleep(delay);
   * ```
   */
  calculateDelay(attemptNumber: number, options?: RetryOptions): number;

  /**
   * Получить статистику по операциям
   * 
   * @returns Статистика
   * 
   * @example
   * ```typescript
   * const stats = retryPolicy.getStats();
   * console.log('Total attempts:', stats.totalAttempts);
   * ```
   */
  getStats(): {
    totalOperations: number;
    successfulOperations: number;
    failedOperations: number;
    totalAttempts: number;
    averageAttemptsPerOperation: number;
    totalRetries: number;
  };

  /**
   * Сбросить статистику
   * 
   * @returns true если успешно
   * 
   * @example
   * ```typescript
   * await retryPolicy.resetStats();
   * ```
   */
  resetStats(): Promise<boolean>;

  /**
   * Проверить здоровье Retry Policy
   * 
   * @returns true если здоров
   * 
   * @example
   * ```typescript
   * if (await retryPolicy.isHealthy()) {
   *   // Retry Policy работает
   * }
   * ```
   */
  isHealthy(): Promise<boolean>;

  /**
   * Закрыть Retry Policy
   * 
   * @example
   * ```typescript
   * await retryPolicy.close();
   * ```
   */
  close(): Promise<void>;
}