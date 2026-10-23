/**
 * PrometheusMetricsAdapter - адаптер для Prometheus метрик
 * Layer: Infrastructure (внешние зависимости)
 *
 * Реализует интерфейс IBusinessMetrics с использованием Prometheus.
 * Предоставляет типобезопасный интерфейс для сбора и экспорта метрик.
 *
 * Принципы:
 * - Инфраструктурная абстракция - скрывает детали Prometheus
 * - Типобезопасность - строгая типизация метрик
 * - Производительность - эффективное хранение и экспорт
 * - Наблюдаемость - интеграция с мониторингом
 *
 * @example
 * ```typescript
 * // Регистрация в DI контейнере
 * container.register<IBusinessMetrics>('IBusinessMetrics', () =>
 *   new PrometheusMetricsAdapter({
 *     prefix: 'microphoenix_',
 *     defaultLabels: { service: 'conversation-service' }
 *   })
 * );
 *
 * // Использование в доменном коде
 * class ConversationService {
 *   constructor(private metrics: IBusinessMetrics) {}
 *
 *   async createConversation(command: CreateConversationCommand) {
 *     const timer = this.metrics.startTimer('conversation_creation');
 *
 *     try {
 *       const conversation = await this.repository.save(command);
 *       this.metrics.recordSuccess('conversation_created', {
 *         entityId: conversation.id,
 *         userId: command.userId
 *       });
 *       return conversation;
 *     } catch (error) {
 *       this.metrics.recordError('conversation_creation_failed', error);
 *       throw error;
 *     } finally {
 *       timer.stop();
 *     }
 *   }
 * }
 * ```
 */

import {
  IBusinessMetrics,
  MetricContext,
  OperationalMetric,
  ITimer,
  ICounter,
  IGauge,
  IHistogram,
  BusinessMetricsFactory,
  BusinessMetricsUtils,
} from '../../domain/metrics/IBusinessMetrics';
import type { IMetricsPort } from '../../domain/metrics/IMetricsPort';
import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';

/**
 * Конфигурация Prometheus адаптера
 */
export interface PrometheusConfig {
  /**
   * Префикс для всех метрик
   */
  prefix?: string;

  /**
   * Метки по умолчанию для всех метрик
   */
  defaultLabels?: Record<string, string>;

  /**
   * Интервал сбора метрик (мс)
   */
  collectInterval?: number;

  /**
   * Максимальный размер реестра метрик
   */
  maxRegistrySize?: number;

  /**
   * Включить детальное логирование
   */
  enableDebugLogging?: boolean;
}

/**
 * Внутренняя метрика Prometheus
 */
interface PrometheusMetric {
  name: string;
  type: 'counter' | 'gauge' | 'histogram' | 'summary';
  help: string;
  labels: Record<string, string>;
  values: Map<string, number>;
  timestamps: Map<string, number>;
  buckets?: number[];
}

/**
 * Таймер для измерения времени
 */
class PrometheusTimer implements ITimer {
  private startTime: number;

  constructor(
    private metrics: PrometheusMetricsAdapter,
    private operation: string,
    private context: MetricContext
  ) {
    this.startTime = performance.now();
  }

  stop(): void {
    const duration = performance.now() - this.startTime;
    this.metrics.recordLatency(this.operation, duration, 'ms', this.context);
  }

  record(): void {
    const duration = performance.now() - this.startTime;
    this.metrics.recordLatency(this.operation, duration, 'ms', this.context);
  }
}

/**
 * Счетчик операций
 */
class PrometheusCounter implements ICounter {
  private value = 0;

  constructor(
    private metrics: PrometheusMetricsAdapter,
    private metric: OperationalMetric,
    private context: MetricContext
  ) {}

  increment(value: number = 1): void {
    this.value += value;
    this.metrics.gauge(this.metric, this.value, this.context);
  }

  reset(): void {
    this.value = 0;
    this.metrics.gauge(this.metric, 0, this.context);
  }
}

/**
 * Измеритель значений
 */
class PrometheusGauge implements IGauge {
  constructor(
    private metrics: PrometheusMetricsAdapter,
    private metric: OperationalMetric,
    private context: MetricContext
  ) {}

  set(value: number): void {
    this.metrics.gauge(this.metric, value, this.context);
  }

  increment(value: number = 1): void {
    // В реальной реализации нужно хранить текущее значение
    // Для простоты используем gauge напрямую
    this.metrics.gauge(this.metric, value, this.context);
  }

  decrement(value: number = 1): void {
    this.metrics.gauge(this.metric, -value, this.context);
  }
}

/**
 * Гистограмма распределений
 */
class PrometheusHistogram implements IHistogram {
  constructor(
    private metrics: PrometheusMetricsAdapter,
    private metric: OperationalMetric,
    private buckets: number[],
    private context: MetricContext
  ) {}

  observe(value: number): void {
    this.metrics.histogram(this.metric, value, this.buckets, this.context);
  }
}

/**
 * Адаптер метрик для Prometheus
 */
export class PrometheusMetricsAdapter implements IBusinessMetrics, IMetricsPort {
  private registry = new Map<string, PrometheusMetric>();
  private config: Required<PrometheusConfig>;
  private collectInterval?: NodeJS.Timeout;

  constructor(config: PrometheusConfig = {}, private readonly logger?: IStructuredLogger) {
    this.config = {
      prefix: config.prefix || 'microphoenix_',
      defaultLabels: config.defaultLabels || {},
      collectInterval: config.collectInterval || 60000, // 1 минута
      maxRegistrySize: config.maxRegistrySize || 10000,
      enableDebugLogging: config.enableDebugLogging || false,
    };

    this.startCollection();
  }

  /**
   * Записать счетчик
   */
  increment(
    metric: OperationalMetric,
    context: MetricContext = {},
    value: number = 1
  ): void {
    const fullContext = this.mergeContext(context);
    const key = this.createMetricKey(metric, fullContext);

    let prometheusMetric = this.registry.get(key);
    if (!prometheusMetric) {
      prometheusMetric = this.createMetric(metric, 'counter', fullContext);
      this.registry.set(key, prometheusMetric);
    }

    const labelKey = this.createLabelKey(fullContext);
    const currentValue = prometheusMetric.values.get(labelKey) || 0;
    prometheusMetric.values.set(labelKey, currentValue + value);
    prometheusMetric.timestamps.set(labelKey, Date.now());

    this.logDebug(`Incremented ${metric}: ${currentValue + value}`);
  }

  /**
   * Записать измеритель
   */
  gauge(
    metric: OperationalMetric,
    value: number,
    context: MetricContext = {}
  ): void {
    if (!BusinessMetricsUtils.validateMetricValue(value, 'gauge')) {
      this.logDebug(`Invalid gauge value for ${metric}: ${value}`);
      return;
    }

    const fullContext = this.mergeContext(context);
    const key = this.createMetricKey(metric, fullContext);

    let prometheusMetric = this.registry.get(key);
    if (!prometheusMetric) {
      prometheusMetric = this.createMetric(metric, 'gauge', fullContext);
      this.registry.set(key, prometheusMetric);
    }

    const labelKey = this.createLabelKey(fullContext);
    prometheusMetric.values.set(labelKey, value);
    prometheusMetric.timestamps.set(labelKey, Date.now());

    this.logDebug(`Gauge ${metric}: ${value}`);
  }

  /**
   * Записать гистограмму
   */
  histogram(
    metric: OperationalMetric,
    value: number,
    buckets: number[] = [0.1, 0.5, 1, 2.5, 5, 10],
    context: MetricContext = {}
  ): void {
    if (!BusinessMetricsUtils.validateMetricValue(value, 'histogram')) {
      this.logDebug(`Invalid histogram value for ${metric}: ${value}`);
      return;
    }

    const fullContext = this.mergeContext(context);
    const key = this.createMetricKey(metric, fullContext);

    let prometheusMetric = this.registry.get(key);
    if (!prometheusMetric) {
      prometheusMetric = this.createMetric(metric, 'histogram', fullContext, buckets);
      this.registry.set(key, prometheusMetric);
    }

    // Простая реализация гистограммы - считаем попадания в бакеты
    const labelKey = this.createLabelKey(fullContext);
    for (const bucket of buckets) {
      if (value <= bucket) {
        const bucketKey = `${labelKey}_bucket_${bucket}`;
        const currentCount = prometheusMetric.values.get(bucketKey) || 0;
        prometheusMetric.values.set(bucketKey, currentCount + 1);
        prometheusMetric.timestamps.set(bucketKey, Date.now());
      }
    }

    // Общее количество
    const countKey = `${labelKey}_count`;
    const currentCount = prometheusMetric.values.get(countKey) || 0;
    prometheusMetric.values.set(countKey, currentCount + 1);
    prometheusMetric.timestamps.set(countKey, Date.now());

    // Сумма
    const sumKey = `${labelKey}_sum`;
    const currentSum = prometheusMetric.values.get(sumKey) || 0;
    prometheusMetric.values.set(sumKey, currentSum + value);
    prometheusMetric.timestamps.set(sumKey, Date.now());

    this.logDebug(`Histogram ${metric}: ${value}`);
  }

  /**
   * Записать таймер
   */
  timer(
    metric: OperationalMetric,
    duration: number,
    unit: 'ms' | 's' | 'm' = 'ms',
    context: MetricContext = {}
  ): void {
    const durationMs = this.convertToMs(duration, unit);
    this.histogram(metric, durationMs, undefined, context);
  }

  /**
   * Записать событие
   */
  event(
    name: string,
    properties: Record<string, unknown> = {},
    context: MetricContext = {}
  ): void {
    const fullContext = this.mergeContext(context);
    const key = this.createMetricKey(name as OperationalMetric, fullContext);

    let prometheusMetric = this.registry.get(key);
    if (!prometheusMetric) {
      prometheusMetric = this.createMetric(name as OperationalMetric, 'counter', fullContext);
      this.registry.set(key, prometheusMetric);
    }

    const labelKey = this.createLabelKey(fullContext);
    const currentValue = prometheusMetric.values.get(labelKey) || 0;
    prometheusMetric.values.set(labelKey, currentValue + 1);
    prometheusMetric.timestamps.set(labelKey, Date.now());

    // Добавить свойства как дополнительные метки
    Object.entries(properties).forEach(([propKey, propValue]) => {
      const propLabelKey = `${labelKey}_${propKey}_${String(propValue)}`;
      prometheusMetric.values.set(propLabelKey, 1);
      prometheusMetric.timestamps.set(propLabelKey, Date.now());
    });

    this.logDebug(`Event ${name}: ${JSON.stringify(properties)}`);
  }

  /**
   * Записать успешную операцию
   */
  recordSuccess(
    operation: string,
    context: MetricContext = {}
  ): void {
    this.increment(`${operation}_success` as OperationalMetric, context);
  }

  /**
   * Записать ошибку
   */
  recordError(
    operation: string,
    error: unknown,
    context: MetricContext = {}
  ): void {
    const errorMetrics = BusinessMetricsUtils.extractErrorMetrics(error);
    const rawErrorType = BusinessMetricsUtils.isValidError(error) ? error.constructor.name : 'UnknownError';
    
    // 🎯 ДИАГНОСТИКА: Проверка кардинальности метрик ошибок
    const uniqueErrorTypes = this.getUniqueErrorTypesCount();
    const normalizedErrorType = this.normalizeErrorType(rawErrorType);
    
    console.log('[PrometheusMetricsAdapter] DIAGNOSTIC:', {
      operation,
      originalErrorType: rawErrorType,
      normalizedErrorType: normalizedErrorType,
      uniqueErrorTypesCount: uniqueErrorTypes,
      // Предупреждение при высокой кардинальности
      highCardinalityWarning: uniqueErrorTypes > 50 ? 'WARNING: High cardinality detected!' : 'OK',
      // Проверяем, нужно ли сэмплирование
      shouldSample: uniqueErrorTypes > 100,
      // Проверяем, используется ли нормализация
      usingNormalization: rawErrorType !== normalizedErrorType
    });

    this.increment(`${operation}_error` as OperationalMetric, {
      ...context,
      tags: {
        ...context.tags,
        error_type: normalizedErrorType,
      },
    });

    // Записать детали ошибки как событие (сэмплируем при высокой кардинальности)
    if (uniqueErrorTypes <= 100 || Math.random() < 0.1) { // 10% sampling при >100 типов
      this.event(`${operation}_error_details`, errorMetrics, context);
    }
  }

  /**
   * Записать бизнес-событие
   */
  recordBusinessEvent(
    eventType: string,
    properties: Record<string, unknown>,
    context: MetricContext = {}
  ): void {
    this.event(`business_${eventType}`, properties, context);
  }

  /**
   * Записать задержку операции
   */
  recordLatency(
    operation: string,
    duration: number,
    unit: 'ms' | 's' | 'm' = 'ms',
    context: MetricContext = {}
  ): void {
    this.timer(`${operation}_latency` as OperationalMetric, duration, unit, context);
  }

  /**
   * Записать пользовательскую активность
   */
  recordUserActivity(
    userId: string,
    activity: string,
    properties: Record<string, unknown> = {},
    context: MetricContext = {}
  ): void {
    this.event(`user_${activity}`, {
      user_id: userId,
      ...properties,
    }, {
      ...context,
      userId,
    });
  }

  /**
   * Записать метрику производительности
   */
  recordPerformance(
    component: string,
    metric: string,
    value: number,
    unit: string = '',
    context: MetricContext = {}
  ): void {
    const metricName = `performance_${component}_${metric}` as OperationalMetric;
    this.gauge(metricName, value, {
      ...context,
      tags: {
        ...context.tags,
        unit,
        component,
      },
    });
  }

  /**
   * Записать метрику качества
   */
  recordQuality(
    service: string,
    qualityMetric: string,
    value: number,
    target: number = 0,
    context: MetricContext = {}
  ): void {
    const metricName = `quality_${service}_${qualityMetric}` as OperationalMetric;
    this.gauge(metricName, value, {
      ...context,
      tags: {
        ...context.tags,
        service,
        target: target.toString(),
      },
    });

    // Записать отклонение от цели
    if (target > 0) {
      const deviation = Math.abs(value - target) / target;
      this.gauge(`${metricName}_deviation` as OperationalMetric, deviation, context);
    }
  }

  /**
   * Начать измерение времени операции
   */
  startTimer(operation: string, context: MetricContext = {}): ITimer {
    return new PrometheusTimer(this, operation, context);
  }

  /**
   * Создать счетчик операции
   */
  createCounter(
    metric: OperationalMetric,
    context: MetricContext = {}
  ): ICounter {
    return new PrometheusCounter(this, metric, context);
  }

  /**
   * Создать измеритель
   */
  createGauge(
    metric: OperationalMetric,
    context: MetricContext = {}
  ): IGauge {
    return new PrometheusGauge(this, metric, context);
  }

  /**
   * Создать гистограмму
   */
  createHistogram(
    metric: OperationalMetric,
    buckets: number[] = [0.1, 0.5, 1, 2.5, 5, 10],
    context: MetricContext = {}
  ): IHistogram {
    return new PrometheusHistogram(this, metric, buckets, context);
  }

  /**
   * Экспортировать метрики в формате Prometheus
   */
  exportMetrics(): string {
    const lines: string[] = [];

    for (const [key, metric] of this.registry) {
      // HELP
      lines.push(`# HELP ${metric.name} ${metric.help}`);
      // TYPE
      lines.push(`# TYPE ${metric.name} ${metric.type}`);

      // VALUES
      for (const [labelKey, value] of metric.values) {
        const labels = this.parseLabelKey(labelKey);
        const labelString = Object.entries(labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(',');

        const labelPart = labelString ? `{${labelString}}` : '';
        lines.push(`${metric.name}${labelPart} ${value}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Очистить старые метрики
   */
  cleanup(maxAge: number = 3600000): void { // 1 час по умолчанию
    const now = Date.now();
    const toDelete: string[] = [];

    for (const [key, metric] of this.registry) {
      const timestamps = Array.from(metric.timestamps.values());
      const oldest = Math.min(...timestamps);

      if (now - oldest > maxAge) {
        toDelete.push(key);
      }
    }

    toDelete.forEach(key => this.registry.delete(key));
    this.logDebug(`Cleaned up ${toDelete.length} old metrics`);
  }

  /**
   * Остановить сбор метрик
   */
  stop(): void {
    if (this.collectInterval) {
      clearInterval(this.collectInterval);
      this.collectInterval = undefined;
    }
  }

  private startCollection(): void {
    this.collectInterval = setInterval(() => {
      this.cleanup();
    }, this.config.collectInterval);
  }

  private createMetric(
    metric: OperationalMetric,
    type: 'counter' | 'gauge' | 'histogram' | 'summary',
    context: MetricContext,
    buckets?: number[]
  ): PrometheusMetric {
    return {
      name: this.config.prefix + metric,
      type,
      help: this.getMetricDescription(metric),
      labels: this.extractLabels(context),
      values: new Map(),
      timestamps: new Map(),
      buckets,
    };
  }

  private mergeContext(context: MetricContext): MetricContext {
    return {
      ...context,
      tags: {
        ...this.config.defaultLabels,
        ...context.tags,
      },
      timestamp: context.timestamp || new Date(),
    };
  }

  private createMetricKey(metric: OperationalMetric, context: MetricContext): string {
    return BusinessMetricsUtils.createMetricKey(metric, context);
  }

  private createLabelKey(context: MetricContext): string {
    const labels: Record<string, string> = {};

    // A-011 FIX: Only low-cardinality labels allowed in metric keys
    // High-cardinality fields (userId, sessionId, correlationId) are excluded
    // to prevent Prometheus cardinality explosion
    if (context.entityType) labels.entity_type = context.entityType;
    if (context.region) labels.region = context.region;
    if (context.apiVersion) labels.api_version = context.apiVersion;

    if (context.tags) {
      Object.entries(context.tags).forEach(([key, value]) => {
        labels[key] = String(value);
      });
    }

    return Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}:${value}`)
      .join('|');
  }

  private parseLabelKey(labelKey: string): Record<string, string> {
    const labels: Record<string, string> = {};
    const parts = labelKey.split('|');

    parts.forEach(part => {
      const [key, value] = part.split(':');
      if (key && value) {
        labels[key] = value;
      }
    });

    return labels;
  }

  private extractLabels(context: MetricContext): Record<string, string> {
    const labels: Record<string, string> = {};

    // A-011 FIX: Only low-cardinality labels allowed in Prometheus metrics
    // High-cardinality fields (userId, sessionId, correlationId, entityId) are excluded
    // to prevent Prometheus cardinality explosion and OOM issues
    if (context.entityType) labels.entity_type = context.entityType;
    if (context.region) labels.region = context.region;
    if (context.apiVersion) labels.api_version = context.apiVersion;

    return { ...labels, ...this.config.defaultLabels };
  }

  private convertToMs(duration: number, unit: 'ms' | 's' | 'm'): number {
    switch (unit) {
      case 's': return duration * 1000;
      case 'm': return duration * 60000;
      default: return duration;
    }
  }

  private getMetricDescription(metric: OperationalMetric): string {
    const descriptions: Record<OperationalMetric, string> = {
      api_requests_total: 'Total number of API requests',
      api_requests_duration: 'Duration of API requests',
      api_requests_rate: 'Rate of API requests per second',
      api_response_size: 'Size of API responses in bytes',
      conversations_created: 'Number of conversations created',
      messages_sent: 'Number of messages sent',
      messages_received: 'Number of messages received',
      users_active_daily: 'Number of daily active users',
      users_active_monthly: 'Number of monthly active users',
      retention_rate: 'User retention rate',
      churn_rate: 'User churn rate',
      database_queries_total: 'Total number of database queries',
      database_query_duration: 'Duration of database queries',
      cache_hit_ratio: 'Cache hit ratio',
      memory_usage: 'Memory usage in bytes',
      cpu_usage: 'CPU usage percentage',
      auth_failures: 'Number of authentication failures',
      rate_limit_exceeded: 'Number of rate limit violations',
      security_events: 'Number of security events',
      suspicious_activities: 'Number of suspicious activities detected',
      error_rate: 'Error rate percentage',
      success_rate: 'Success rate percentage',
      sla_violations: 'Number of SLA violations',
      uptime_percentage: 'Service uptime percentage',
    };

    return descriptions[metric] || `Metric for ${metric}`;
  }

  private logDebug(message: string): void {
    if (this.config.enableDebugLogging) {
      this.logger?.debug(`[PrometheusMetrics] ${message}`);
    }
  }

  /**
   * Получить количество уникальных типов ошибок в реестре
   * Используется для диагностики кардинальности метрик
   */
  private getUniqueErrorTypesCount(): number {
    const errorTypes = new Set<string>();
    
    for (const [key, metric] of this.registry) {
      if (key.includes('_error') && metric.labels.error_type) {
        errorTypes.add(metric.labels.error_type);
      }
    }
    
    return errorTypes.size;
  }

  /**
   * Нормализовать тип ошибки для ограничения кардинальности
   * @param errorType Исходный тип ошибки
   * @returns Нормализованный тип ошибки
   */
  private normalizeErrorType(errorType: string): string {
    // Базовая нормализация: убираем динамические суффиксы, оставляем основной тип
    // Например: "DatabaseError_12345" -> "DatabaseError"
    // Например: "TimeoutError_abc123" -> "TimeoutError"
    
    const normalized = errorType.split('_')[0];
    
    // Если тип слишком длинный или содержит специальные символы, используем "UnknownError"
    if (normalized.length > 50 || /[^a-zA-Z0-9]/.test(normalized)) {
      return 'UnknownError';
    }
    
    return normalized || 'UnknownError';
  }
}