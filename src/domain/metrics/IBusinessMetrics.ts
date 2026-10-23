/**
 * IBusinessMetrics - интерфейс для бизнес-метрик
 * Layer: Domain (бизнес-логика)
 * 
 * Определяет стандартизированный интерфейс для сбора и публикации бизнес-метрик.
 * Поддерживает как операционные, так и бизнес-показатели.
 * 
 * Принципы:
 * - Доменная чистота - метрики не зависят от инфраструктуры
 * - Типобезопасность - строгая типизация метрик
 * - Гранулярность - детализированные метрики по сущностям
 * - Контекстность - метрики содержат бизнес-контекст
 * 
 * @example
 * ```typescript
 * // Сбор метрик в доменном коде
 * class Conversation {
 *   constructor(
 *     private metrics: IBusinessMetrics
 *   ) {}
 * 
 *   async sendMessage(message: Message) {
 *     const startTime = performance.now();
 *     
 *     try {
 *       this.validateMessage(message);
 *       this.persist(message);
 *       
 *       this.metrics.recordSuccess('message_sent', {
 *         conversationId: this.id,
 *         messageType: message.type,
 *         userId: message.userId
 *       });
 *     } catch (error) {
 *       this.metrics.recordError('message_send_failed', error, {
 *         conversationId: this.id,
 *         userId: message.userId
 *       });
 *       throw error;
 *     } finally {
 *       const duration = performance.now() - startTime;
 *       this.metrics.recordLatency('message_processing', duration);
 *     }
 *   }
 * }
 * ```
 */

/**
 * Типы бизнес-метрик
 */
export type MetricType = 
  | 'counter'     // Счетчик (увеличивается)
  | 'gauge'       // Измеритель (может увеличиваться/уменьшаться)
  | 'histogram'   // Гистограмма (распределение значений)
  | 'timer'       // Таймер (время выполнения)
  | 'event';      // Событие (дискретное событие)

/**
 * Базовые операционные метрики
 */
export type OperationalMetric = 
  // API метрики
  | 'api_requests_total'
  | 'api_requests_duration'
  | 'api_requests_rate'
  | 'api_response_size'
  
  // Бизнес метрики
  | 'conversations_created'
  | 'messages_sent'
  | 'messages_received'
  | 'users_active_daily'
  | 'users_active_monthly'
  | 'retention_rate'
  | 'churn_rate'
  
  // Производительность
  | 'database_queries_total'
  | 'database_query_duration'
  | 'cache_hit_ratio'
  | 'memory_usage'
  | 'cpu_usage'
  
  // Безопасность
  | 'auth_failures'
  | 'rate_limit_exceeded'
  | 'security_events'
  | 'suspicious_activities'
  
  // Качество сервиса
  | 'error_rate'
  | 'success_rate'
  | 'sla_violations'
  | 'uptime_percentage';

/**
 * Контекст метрики
 */
export interface MetricContext {
  /**
   * Идентификатор сущности
   */
  entityId?: string;
  
  /**
   * Тип сущности
   */
  entityType?: string;
  
  /**
   * Идентификатор пользователя
   */
  userId?: string;
  
  /**
   * Идентификатор сессии
   */
  sessionId?: string;
  
  /**
   * Географический регион
   */
  region?: string;
  
  /**
   * Версия API
   */
  apiVersion?: string;
  
  /**
   * Дополнительные теги
   */
  tags?: Record<string, string | number | boolean>;
  
  /**
   * Временная метка
   */
  timestamp?: Date;
  
  /**
   * Correlation ID для трассировки
   */
  correlationId?: string;
}

/**
 * Значение метрики
 */
export interface MetricValue {
  /**
   * Название метрики
   */
  name: string;
  
  /**
   * Тип метрики
   */
  type: MetricType;
  
  /**
   * Значение
   */
  value: number;
  
  /**
   * Единица измерения
   */
  unit?: string;
  
  /**
   * Контекст метрики
   */
  context: MetricContext;
  
  /**
   * Временная метка
   */
  timestamp: Date;
  
  /**
   * Описание метрики
   */
  description?: string;
}

/**
 * Интерфейс для бизнес-метрик
 */
export interface IBusinessMetrics {
  /**
   * Записать счетчик (увеличить на 1 или на указанное значение)
   */
  increment(
    metric: OperationalMetric,
    context?: MetricContext,
    value?: number
  ): void;
  
  /**
   * Записать измеритель
   */
  gauge(
    metric: OperationalMetric,
    value: number,
    context?: MetricContext
  ): void;
  
  /**
   * Записать гистограмму
   */
  histogram(
    metric: OperationalMetric,
    value: number,
    buckets?: number[],
    context?: MetricContext
  ): void;
  
  /**
   * Записать таймер
   */
  timer(
    metric: OperationalMetric,
    duration: number,
    unit?: 'ms' | 's' | 'm',
    context?: MetricContext
  ): void;
  
  /**
   * Записать событие
   */
  event(
    name: string,
    properties?: Record<string, unknown>,
    context?: MetricContext
  ): void;
  
  /**
   * Записать успешную операцию
   */
  recordSuccess(
    operation: string,
    context?: MetricContext
  ): void;
  
  /**
   * Записать ошибку
   */
  recordError(
    operation: string,
    error: unknown,
    context?: MetricContext
  ): void;
  
  /**
   * Записать бизнес-событие
   */
  recordBusinessEvent(
    eventType: string,
    properties: Record<string, unknown>,
    context?: MetricContext
  ): void;
  
  /**
   * Записать задержку операции
   */
  recordLatency(
    operation: string,
    duration: number,
    unit?: 'ms' | 's' | 'm',
    context?: MetricContext
  ): void;
  
  /**
   * Записать пользовательскую активность
   */
  recordUserActivity(
    userId: string,
    activity: string,
    properties?: Record<string, unknown>,
    context?: MetricContext
  ): void;
  
  /**
   * Записать метрику производительности
   */
  recordPerformance(
    component: string,
    metric: string,
    value: number,
    unit?: string,
    context?: MetricContext
  ): void;
  
  /**
   * Записать метрику качества
   */
  recordQuality(
    service: string,
    qualityMetric: string,
    value: number,
    target?: number,
    context?: MetricContext
  ): void;
  
  /**
   * Начать измерение времени операции
   */
  startTimer(operation: string, context?: MetricContext): ITimer;
  
  /**
   * Создать счетчик операции
   */
  createCounter(
    metric: OperationalMetric,
    context?: MetricContext
  ): ICounter;
  
  /**
   * Создать измеритель
   */
  createGauge(
    metric: OperationalMetric,
    context?: MetricContext
  ): IGauge;
  
  /**
   * Создать гистограмму
   */
  createHistogram(
    metric: OperationalMetric,
    buckets?: number[],
    context?: MetricContext
  ): IHistogram;
}

/**
 * Интерфейс таймера
 */
export interface ITimer {
  /**
   * Остановить таймер и записать метрику
   */
  stop(): void;
  
  /**
   * Записать время без остановки
   */
  record(): void;
}

/**
 * Интерфейс счетчика
 */
export interface ICounter {
  /**
   * Увеличить счетчик
   */
  increment(value?: number): void;
  
  /**
   * Сбросить счетчик
   */
  reset(): void;
}

/**
 * Интерфейс измерителя
 */
export interface IGauge {
  /**
   * Установить значение
   */
  set(value: number): void;
  
  /**
   * Увеличить на значение
   */
  increment(value?: number): void;
  
  /**
   * Уменьшить на значение
   */
  decrement(value?: number): void;
}

/**
 * Интерфейс гистограммы
 */
export interface IHistogram {
  /**
   * Записать значение
   */
  observe(value: number): void;
}

/**
 * Фабрика для создания метрик
 */
export class BusinessMetricsFactory {
  /**
   * Создать контекст метрики
   */
  static createContext(
    options?: {
      entityId?: string;
      entityType?: string;
      userId?: string;
      sessionId?: string;
      region?: string;
      apiVersion?: string;
      correlationId?: string;
      tags?: Record<string, string | number | boolean>;
    }
  ): MetricContext {
    return {
      entityId: options?.entityId,
      entityType: options?.entityType,
      userId: options?.userId,
      sessionId: options?.sessionId,
      region: options?.region,
      apiVersion: options?.apiVersion,
      correlationId: options?.correlationId,
      tags: options?.tags,
      timestamp: new Date(),
    };
  }
  
  /**
   * Создать контекст для пользователя
   */
  static userContext(
    userId: string,
    sessionId?: string,
    additionalContext?: Partial<MetricContext>
  ): MetricContext {
    return {
      ...additionalContext,
      userId,
      sessionId,
      timestamp: new Date(),
    };
  }
  
  /**
   * Создать контекст для сущности
   */
  static entityContext(
    entityType: string,
    entityId: string,
    additionalContext?: Partial<MetricContext>
  ): MetricContext {
    return {
      ...additionalContext,
      entityType,
      entityId,
      timestamp: new Date(),
    };
  }
  
  /**
   * Создать контекст для операции
   */
  static operationContext(
    operation: string,
    additionalContext?: Partial<MetricContext>
  ): MetricContext {
    return {
      ...additionalContext,
      tags: {
        ...additionalContext?.tags,
        operation,
      },
      timestamp: new Date(),
    };
  }
}

/**
 * Утилиты для работы с метриками
 */
export class BusinessMetricsUtils {
  /**
   * Проверить, является ли операция успешной
   */
  static isOperationSuccess(result: { success: boolean; error?: Error }): boolean {
    return result.success && !result.error;
  }
  
  /**
   * Type guard для проверки наличия cause property
   */
  static hasCauseProperty(error: unknown): error is Error & { cause: unknown } {
    return error instanceof Error && 'cause' in error && error.cause !== undefined;
  }

  /**
   * Type guard для проверки валидности ошибки
   */
  static isValidError(error: unknown): error is Error {
    return error instanceof Error && typeof error.message === 'string';
  }

  /**
   * Извлечь метрики из ошибки
   */
  static extractErrorMetrics(error: unknown): Record<string, unknown> {
    if (!this.isValidError(error)) {
      return {
        errorType: 'UnknownError',
        errorMessage: String(error),
        errorStack: undefined,
        hasCause: false,
        cause: undefined,
      };
    }
    
    return {
      errorType: error.constructor.name,
      errorMessage: error.message,
      errorStack: error.stack,
      hasCause: this.hasCauseProperty(error),
      cause: this.hasCauseProperty(error) ? error.cause : undefined,
    };
  }

  /**
   * Безопасно извлечь сообщение из ошибки
   */
  static safeErrorMessage(error: unknown): string {
    if (this.isValidError(error)) {
      return error.message;
    }
    return String(error);
  }

  /**
   * Безопасно извлечь стек из ошибки
   */
  static safeErrorStack(error: unknown): string | undefined {
    if (this.isValidError(error)) {
      return error.stack;
    }
    return undefined;
  }
  
  /**
   * Создать уникальный ключ метрики
   */
  static createMetricKey(name: string, context: MetricContext): string {
    const tags = Object.entries(context.tags || {})
      .map(([key, value]) => `${key}:${value}`)
      .join(',');
    
    return tags ? `${name}{${tags}}` : name;
  }
  
  /**
   * Валидировать значение метрики
   */
  static validateMetricValue(value: number, type: MetricType): boolean {
    if (isNaN(value) || !isFinite(value)) {
      return false;
    }
    
    switch (type) {
      case 'counter':
      case 'gauge':
        return value >= 0;
      case 'histogram':
      case 'timer':
        return value > 0;
      default:
        return true;
    }
  }
}