/**
 * ICircuitBreaker - интерфейс для Circuit Breaker паттерна
 * Layer: Domain (бизнес-логика)
 *
 * SSOT & НАЗНАЧЕНИЕ:
 * - Официальный доменный контракт для Circuit Breaker.
 * - Реализации располагаются в Infrastructure-слое и подключаются через
 *   общий DI bootstrap; не создавать здесь альтернативных runtime-цепочек.
 * - Используется как extension point для защищённых интеграций с внешними сервисами.
 *
 * Circuit Breaker предотвращает каскадные сбои в распределенных системах.
 * Защищает систему от длительных простоев при сбоях внешних сервисов.
 *
 * Принципы:
 * - Интерфейс определяется в Domain слое
 * - Реализация в Infrastructure слое
 * - Поддерживает три состояния: CLOSED, OPEN, HALF_OPEN
 * - Автоматический переход между состояниями на основе метрик
 *
 * @example
 * ```typescript
 * // Application Layer использует Circuit Breaker
 * class ExternalApiService {
 *   constructor(private circuitBreaker: ICircuitBreaker) {}
 *   
 *   async callExternalApi(request: ApiRequest) {
 *     return await this.circuitBreaker.execute(async () => {
 *       return await this.httpClient.request(request);
 *     });
 *   }
 * }
 * ```
 */

/**
 * Состояния Circuit Breaker
 */
export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Причина срабатывания Circuit Breaker
 */
export type CircuitBreakerReason = 
  | 'FAILURE_THRESHOLD_EXCEEDED'
  | 'TIMEOUT_EXCEEDED'
  | 'ERROR_RATE_EXCEEDED'
  | 'MANUAL_OPEN'
  | 'FORCED_OPEN';

/**
 * Результат выполнения операции через Circuit Breaker
 */
export interface CircuitBreakerResult<T> {
  /** Успешность операции */
  success: boolean;
  /** Результат операции (если успешно) */
  data?: T;
  /** Ошибка (если неуспешно) */
  error?: Error;
  /** Был ли Circuit Breaker открыт */
  circuitBreakerWasOpen: boolean;
  /** Время выполнения в миллисекундах */
  durationMs: number;
}

/**
 * Метрики Circuit Breaker
 */
export interface CircuitBreakerMetrics {
  /** Текущее состояние */
  state: CircuitBreakerState;
  /** Количество успешных вызовов */
  successes: number;
  /** Количество неудачных вызовов */
  failures: number;
  /** Количество таймаутов */
  timeouts: number;
  /** Процент ошибок (0-100) */
  errorRate: number;
  /** Время последнего сбоя */
  lastFailureAt?: Date;
  /** Время последнего успеха */
  lastSuccessAt?: Date;
  /** Количество отклоненных вызовов (когда OPEN) */
  rejectedCalls: number;
  /** Время перехода в текущее состояние */
  stateChangedAt: Date;
  /** Количество переходов HALF_OPEN → CLOSED */
  halfOpenToClosed: number;
  /** Количество переходов HALF_OPEN → OPEN */
  halfOpenToOpen: number;
}

/**
 * Опции Circuit Breaker
 */
export interface CircuitBreakerOptions {
  /** Порог ошибок для открытия (по умолчанию: 50) */
  failureThreshold?: number;
  /** Порог таймаутов для открытия (по умолчанию: 50) */
  timeoutThreshold?: number;
  /** Процент ошибок для открытия (по умолчанию: 50) */
  errorRateThreshold?: number;
  /** Время в OPEN состоянии перед переходом в HALF_OPEN (мс, по умолчанию: 60000) */
  openTimeoutMs?: number;
  /** Таймаут выполнения операции (мс, по умолчанию: 30000) */
  operationTimeoutMs?: number;
  /** Минимальное количество вызовов для оценки (по умолчанию: 10) */
  minimumCalls?: number;
  /** Размер скользящего окна (по умолчанию: 100) */
  slidingWindowSize?: number;
  /** Включен ли Circuit Breaker (по умолчанию: true) */
  enabled?: boolean;
  /** Имя Circuit Breaker для метрик */
  name?: string;
}

/**
 * Информация о срабатывании Circuit Breaker
 */
export interface CircuitBreakerTripInfo {
  /** Причина срабатывания */
  reason: CircuitBreakerReason;
  /** Время срабатывания */
  trippedAt: Date;
  /** Метрики на момент срабатывания */
  metrics: CircuitBreakerMetrics;
  /** Последняя ошибка */
  lastError?: Error;
}

/**
 * Обработчик событий Circuit Breaker
 */
export interface CircuitBreakerEventHandler {
  /**
   * Вызывается при открытии Circuit Breaker
   * 
   * @param info - Информация о срабатывании
   */
  onOpen?(info: CircuitBreakerTripInfo): void;

  /**
   * Вызывается при закрытии Circuit Breaker
   * 
   * @param metrics - Текущие метрики
   */
  onClose?(metrics: CircuitBreakerMetrics): void;

  /**
   * Вызывается при переходе в HALF_OPEN
   * 
   * @param metrics - Текущие метрики
   */
  onHalfOpen?(metrics: CircuitBreakerMetrics): void;

  /**
   * Вызывается при успешном вызове в HALF_OPEN
   * 
   * @param metrics - Текущие метрики
   */
  onHalfOpenSuccess?(metrics: CircuitBreakerMetrics): void;

  /**
   * Вызывается при неудачном вызове в HALF_OPEN
   * 
   * @param error - Ошибка
   * @param metrics - Текущие метрики
   */
  onHalfOpenFailure?(error: Error, metrics: CircuitBreakerMetrics): void;
}

/**
 * ICircuitBreaker - интерфейс для Circuit Breaker
 * 
 * @example
 * ```typescript
 * // Создание и использование Circuit Breaker
 * const circuitBreaker = container.resolve<ICircuitBreaker>('ICircuitBreaker');
 * 
 * // Выполнение операции
 * const result = await circuitBreaker.execute(
 *   async () => await externalApi.call(),
 *   { timeoutMs: 5000 }
 * );
 * 
 * if (result.success) {
 *   console.log('Success:', result.data);
 * } else {
 *   console.error('Failed:', result.error);
 * }
 * 
 * // Получение метрик
 * const metrics = circuitBreaker.getMetrics();
 * console.log('Current state:', metrics.state);
 * console.log('Error rate:', metrics.errorRate);
 * 
 * // Ручное управление
 * await circuitBreaker.forceOpen('Manual open for maintenance');
 * await circuitBreaker.forceClose();
 * ```
 */
export interface ICircuitBreaker {
  /**
   * Выполнить операцию через Circuit Breaker
   * 
   * @param operation - Операция для выполнения
   * @param options - Опции выполнения
   * @returns Результат операции
   * 
   * @example
   * ```typescript
   * const result = await circuitBreaker.execute(
   *   async () => await api.call(),
   *   { timeoutMs: 5000 }
   * );
   * ```
   */
  execute<T>(
    operation: () => Promise<T>,
    options?: { timeoutMs?: number }
  ): Promise<CircuitBreakerResult<T>>;

  /**
   * Получить текущие метрики
   * 
   * @returns Текущие метрики
   * 
   * @example
   * ```typescript
   * const metrics = circuitBreaker.getMetrics();
   * console.log('State:', metrics.state);
   * ```
   */
  getMetrics(): CircuitBreakerMetrics;

  /**
   * Получить текущее состояние
   * 
   * @returns Текущее состояние
   * 
   * @example
   * ```typescript
   * const state = circuitBreaker.getState();
   * if (state === 'OPEN') {
   *   // Circuit Breaker открыт
   * }
   * ```
   */
  getState(): CircuitBreakerState;

  /**
   * Принудительно открыть Circuit Breaker
   * 
   * @param reason - Причина открытия
   * @returns true если успешно
   * 
   * @example
   * ```typescript
   * await circuitBreaker.forceOpen('Maintenance');
   * ```
   */
  forceOpen(reason: string): Promise<boolean>;

  /**
   * Принудительно закрыть Circuit Breaker
   * 
   * @returns true если успешно
   * 
   * @example
   * ```typescript
   * await circuitBreaker.forceClose();
   * ```
   */
  forceClose(): Promise<boolean>;

  /**
   * Сбросить метрики и состояние
   * 
   * @returns true если успешно
   * 
   * @example
   * ```typescript
   * await circuitBreaker.reset();
   * ```
   */
  reset(): Promise<boolean>;

  /**
   * Добавить обработчик событий
   * 
   * @param handler - Обработчик событий
   * @returns ID обработчика
   * 
   * @example
   * ```typescript
   * circuitBreaker.addEventHandler({
   *   onOpen: (info) => console.log('Circuit opened:', info.reason),
   *   onClose: (metrics) => console.log('Circuit closed')
   * });
   * ```
   */
  addEventHandler(handler: CircuitBreakerEventHandler): string;

  /**
   * Удалить обработчик событий
   * 
   * @param handlerId - ID обработчика
   * @returns true если успешно
   * 
   * @example
   * ```typescript
   * circuitBreaker.removeEventHandler(handlerId);
   * ```
   */
  removeEventHandler(handlerId: string): boolean;

  /**
   * Проверить, разрешен ли вызов (не в OPEN состоянии)
   * 
   * @returns true если вызов разрешен
   * 
   * @example
   * ```typescript
   * if (circuitBreaker.isCallAllowed()) {
   *   // Можно выполнять операцию
   * }
   * ```
   */
  isCallAllowed(): boolean;

  /**
   * Получить информацию о последнем срабатывании
   * 
   * @returns Информация о срабатывании или null
   * 
   * @example
   * ```typescript
   * const tripInfo = circuitBreaker.getLastTripInfo();
   * if (tripInfo) {
   *   console.log('Last trip reason:', tripInfo.reason);
   * }
   * ```
   */
  getLastTripInfo(): CircuitBreakerTripInfo | null;

  /**
   * Проверить здоровье Circuit Breaker
   * 
   * @returns true если здоров
   * 
   * @example
   * ```typescript
   * if (await circuitBreaker.isHealthy()) {
   *   // Circuit Breaker работает
   * }
   * ```
   */
  isHealthy(): Promise<boolean>;

  /**
   * Закрыть Circuit Breaker
   * 
   * @example
   * ```typescript
   * await circuitBreaker.close();
   * ```
   */
  close(): Promise<void>;
}