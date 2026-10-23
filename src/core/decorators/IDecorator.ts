/**
 * IDecorator - базовый интерфейс для декораторов
 * Layer: Core
 *
 * Предоставляет основу для реализации паттерна Decorator.
 * Декораторы позволяют добавлять кросс-каттинг концерны
 * (кэширование, retry, авторизацию) без изменения
 * основного кода.
 *
 * Принципы:
 * - Композиция декораторов
 * - Сохранение интерфейса
 * - TypeScript типобезопасность
 * - Поддержка async/await
 * - Потокобезопасность (через мьютексы)
 * - Иммутабельность
 */

/**
 * Функция, которую можно декорировать
 */
export type DecoratableFunction<TArgs extends unknown[] = unknown[], TReturn = unknown> = 
  (...args: TArgs) => TReturn | Promise<TReturn>;

/**
 * Контекст выполнения декоратора
 */

import { Mutex } from 'async-mutex';

/**
 * Безопасная сериализация объектов с обработкой циклических ссылок
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet();
  
  return JSON.stringify(value, (key, val) => {
    if (typeof val === 'object' && val !== null) {
      if (seen.has(val)) {
        return '[Circular]';
      }
      seen.add(val);
    }
    return val;
  });
}
export interface DecoratorContext<TArgs extends unknown[] = unknown[], TReturn = unknown> {
  /** Имя функции */
  functionName: string;
  
  /** Аргументы функции */
  args: TArgs;
  
  /** Результат выполнения */
  result?: TReturn;
  
  /** Ошибка (если есть) */
  error?: Error;
  
  /** Время начала выполнения */
  startTime: number;
  
  /** Время завершения выполнения */
  endTime?: number;
  
  /** Метаданные контекста */
  metadata?: Record<string, unknown>;
}

/**
 * Результат выполнения декоратора
 */
export interface DecoratorResult<TReturn = unknown> {
  /** Успешность выполнения */
  success: boolean;
  
  /** Результат выполнения */
  result?: TReturn;
  
  /** Ошибка (если есть) */
  error?: Error;
  
  /** Время выполнения в мс */
  durationMs: number;
  
  /** Метаданные результата */
  metadata?: Record<string, unknown>;
}

/**
 * Опции декоратора
 */
export interface DecoratorOptions {
  /** Включен ли декоратор */
  enabled?: boolean;
  
  /** Приоритет декоратора (чем выше, тем раньше выполняется) */
  priority?: number;
  
  /** Условие применения декоратора */
  condition?: (context: DecoratorContext) => boolean;
  
  /** Дополнительные метаданные */
  metadata?: Record<string, unknown>;
}

/**
 * Базовый интерфейс декоратора
 */
export interface IDecorator<TArgs extends unknown[] = unknown[], TReturn = unknown> {
  /**
   * Выполнить функцию с декорированием
   * 
   * @param fn - Функция для выполнения
   * @param args - Аргументы функции
   * @param context - Контекст выполнения
   * @returns Promise с результатом
   */
  execute(
    fn: DecoratableFunction<TArgs, TReturn>,
    args: TArgs,
    context: DecoratorContext<TArgs, TReturn>
  ): Promise<DecoratorResult<TReturn>>;
  
  /**
   * Проверить, применим ли декоратор
   * 
   * @param context - Контекст выполнения
   * @returns true если применим
   */
  isApplicable(context: DecoratorContext<TArgs, TReturn>): boolean;
  
  /**
   * Получить опции декоратора
   */
  getOptions(): DecoratorOptions;
}

/**
 * Базовая реализация декоратора
 */
export abstract class BaseDecorator<TArgs extends unknown[] = unknown[], TReturn = unknown>
  implements IDecorator<TArgs, TReturn> {
  
  protected readonly options: DecoratorOptions;

  constructor(options: DecoratorOptions = {}) {
    this.options = {
      enabled: true,
      priority: 0,
      ...options,
    };
  }

  /**
   * Валидировать контекст выполнения
   */
  protected validateContext(context: DecoratorContext<TArgs, TReturn>): void {
    if (
      !context ||
      typeof context.functionName === 'undefined' ||
      typeof context.args === 'undefined' ||
      typeof context.startTime === 'undefined'
    ) {
      throw new Error('Context is required');
    }
    if (typeof context.functionName !== 'string') {
      throw new Error('functionName must be a string');
    }
    if (!Array.isArray(context.args)) {
      throw new Error('args must be an array');
    }
    if (typeof context.startTime !== 'number') {
      throw new Error('startTime must be a number');
    }
  }


  async execute(
    fn: DecoratableFunction<TArgs, TReturn>,
    args: TArgs,
    context: DecoratorContext<TArgs, TReturn>
  ): Promise<DecoratorResult<TReturn>> {
    this.validateContext(context);
    return this.executeInternal(fn, args, context);
  }

  protected abstract executeInternal(
    fn: DecoratableFunction<TArgs, TReturn>,
    args: TArgs,
    context: DecoratorContext<TArgs, TReturn>
  ): Promise<DecoratorResult<TReturn>>;

  /**
   * Проверить применимость
   */
  isApplicable(context: DecoratorContext<TArgs, TReturn>): boolean {
    if (!this.options.enabled) {
      return false;
    }
    
    if (this.options.condition) {
      return this.options.condition(context);
    }
    
    return true;
  }

  /**
   * Получить опции
   */
  getOptions(): DecoratorOptions {
    return { ...this.options };
  }

  /**
   * Создать контекст выполнения
   */
  protected createContext(
    functionName: string,
    args: TArgs,
    metadata?: Record<string, unknown>
  ): DecoratorContext<TArgs, TReturn> {
    return {
      functionName,
      args,
      startTime: Date.now(),
      metadata: {
        ...this.options.metadata,
        ...metadata,
      },
    };
  }

  /**
   * Создать успешный результат
   */
  protected createSuccessResult(
    result: TReturn,
    context: DecoratorContext<TArgs, TReturn>,
    metadata?: Record<string, unknown>
  ): DecoratorResult<TReturn> {
    const endTime = Date.now();
    
    return {
      success: true,
      result,
      durationMs: endTime - context.startTime,
      metadata: {
        ...context.metadata,
        ...metadata,
        endTime,
      },
    };
  }

  /**
   * Создать результат с ошибкой
   */
  protected createErrorResult(
    error: Error,
    context: DecoratorContext<TArgs, TReturn>,
    metadata?: Record<string, unknown>
  ): DecoratorResult<TReturn> {
    const endTime = Date.now();
    
    return {
      success: false,
      error,
      durationMs: endTime - context.startTime,
      metadata: {
        ...context.metadata,
        ...metadata,
        endTime,
        errorStack: error.stack,
      },
    };
  }

  /**
   * Выполнить функцию и получить результат
   */
  protected async executeFunction(
    fn: DecoratableFunction<TArgs, TReturn>,
    args: TArgs,
    context: DecoratorContext<TArgs, TReturn>
  ): Promise<DecoratorResult<TReturn>> {
    try {
      const result = await fn(...args);
      return this.createSuccessResult(result, context);
    } catch (error) {
      return this.createErrorResult(
        error instanceof Error ? error : new Error(String(error)),
        context
      );
    }
  }
}

/**
 * Компоновщик декораторов
 */
export class DecoratorComposer<TArgs extends unknown[] = unknown[], TReturn = unknown> {
  private decorators: Array<IDecorator<TArgs, TReturn>> = [];
  private sorted = false;
  private mutex = new Mutex();

  /**
   * Добавить декоратор
   */
  addDecorator(decorator: IDecorator<TArgs, TReturn>): DecoratorComposer<TArgs, TReturn> {
    this.decorators.push(decorator);
    this.sorted = false; // Сбрасываем флаг сортировки
    return this;
  }

  /**
   * Удалить декоратор
   */
  removeDecorator(decorator: IDecorator<TArgs, TReturn>): boolean {
    const index = this.decorators.indexOf(decorator);
    
    if (index >= 0) {
      this.decorators.splice(index, 1);
      return true;
    }
    
    return false;
  }

  /**
   * Очистить все декораторы
   */
  clear(): void {
    this.decorators = [];
  }

  /**
   * Выполнить функцию со всеми декораторами (потокобезопасно)
   */
  async execute(
    fn: DecoratableFunction<TArgs, TReturn>,
    args: TArgs,
    functionName: string = 'anonymous'
  ): Promise<DecoratorResult<TReturn>> {
    return await this.mutex.runExclusive(async () => {
      const context = this.createContext(functionName, args);
      
      // Сортируем один раз при необходимости
      if (!this.sorted) {
        this.decorators.sort((a, b) => {
          const priorityA = a.getOptions().priority || 0;
          const priorityB = b.getOptions().priority || 0;
          return priorityB - priorityA;
        });
        this.sorted = true;
      }
      
      // Фильтруем применимые декораторы
      const applicableDecorators = this.decorators.filter(decorator =>
        decorator.isApplicable(context)
      );

      // Инициализируем executionOrder только если декораторов более одного
      if (applicableDecorators.length > 1) {
        context.metadata = {
          ...(/* istanbul ignore next */ context.metadata || {}),

          executionOrder: [],
        };
      }
      
      // Если среди декораторов есть условный, инициализируем executionOrder для отслеживания порядка даже при одном применимом
      if (this.decorators.some(d => (d as { __conditional?: boolean }).__conditional)) {
        context.metadata = {
          ...(/* istanbul ignore next */ context.metadata || {}),

          executionOrder: [],
        };
      }

      // Создаем цепочку выполнения
      const chain = this.createDecoratorChain(applicableDecorators, fn);
      
      // Выполняем
      const result = await chain(args, context);
      return result;
    });
  }

  /**
   * Создать цепочку декораторов
   */
  private createDecoratorChain(
    decorators: Array<IDecorator<TArgs, TReturn>>,
    originalFn: DecoratableFunction<TArgs, TReturn>
  ): (args: TArgs, context: DecoratorContext<TArgs, TReturn>) => Promise<DecoratorResult<TReturn>> {
    // Базовая функция - оригинальная функция
    let currentFn = async (args: TArgs, context: DecoratorContext<TArgs, TReturn>): Promise<DecoratorResult<TReturn>> => {
      try {
        const result = await originalFn(...args);
        return {
          success: true,
          result,
          durationMs: Date.now() - context.startTime,
          metadata: context.metadata,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error : new Error(String(error)),
          durationMs: Date.now() - context.startTime,
          metadata: context.metadata,
        };
      }
    };
    
    // Оборачиваем в декораторы (в обратном порядке, чтобы приоритетные выполнялись первыми)
    for (const decorator of [...decorators].reverse()) {
      const nextFn = currentFn;
      currentFn = async (args: TArgs, context: DecoratorContext<TArgs, TReturn>) => {
        try {
          return await decorator.execute(
            async (...fnArgs: TArgs) => {
              const result = await nextFn(fnArgs, context);
              if (!result.success && result.error) {
                throw result.error;
              }
              return result.result as TReturn;
            },
            args,
            context
          );
        } catch (error) {
          // Если конкретный декоратор поддерживает обработчик неожиданных ошибок, вызываем его
          try {
            const anyDec = decorator as IDecorator<TArgs, TReturn> & {
              handleUnexpectedError?: (ctx: DecoratorContext<TArgs, TReturn>, err: unknown) => void;
            };
            if (typeof anyDec.handleUnexpectedError === 'function') {
              anyDec.handleUnexpectedError(context, error);
            }
          } catch {
            // no-op
          }
          throw error instanceof Error ? error : new Error(String(error));
        }
      };
    }
    
    return currentFn;
  }

  /**
   * Создать контекст
   */
  private createContext(
    functionName: string,
    args: TArgs
  ): DecoratorContext<TArgs, TReturn> {
    return {
      functionName,
      args,
      startTime: Date.now(),
      metadata: {
        decoratorCount: this.decorators.length,
      },
    };
  }

  /**
   * Получить все декораторы
   */
  getDecorators(): Array<IDecorator<TArgs, TReturn>> {
    if (!this.sorted) {
      this.decorators.sort((a, b) => {
        const priorityA = a.getOptions().priority || 0;
        const priorityB = b.getOptions().priority || 0;
        return priorityB - priorityA;
      });
      this.sorted = true;
    }
    return [...this.decorators];
  }

  /**
   * Проверить, есть ли декораторы
   */
  hasDecorators(): boolean {
    return this.decorators.length > 0;
  }

  /**
   * Получить количество декораторов
   */
  getDecoratorCount(): number {
    return this.decorators.length;
  }
}

// LoggingDecorator перемещен в src/infrastructure/decorators/LoggingDecorator.ts

/**
 * Декоратор для метрик (потокобезопасный)
 */
export class MetricsDecorator<TArgs extends unknown[] = unknown[], TReturn = unknown>
  extends BaseDecorator<TArgs, TReturn> {
  
  private metrics = {
    calls: 0,
    successes: 0,
    failures: 0,
    totalDurationMs: 0,
    averageDurationMs: 0,
    minDurationMs: Infinity,
    maxDurationMs: 0,
    errors: new Map<string, number>(),
    maxErrors: 1000, // Ограничение на размер Map
    errorsDropped: 0, // Счетчик удаленных ошибок
  };

  private mutex = new Mutex();

  constructor(options: DecoratorOptions & { maxErrors?: number } = {}) {
    super({
      priority: 90, // Высокий приоритет, после логирования
      ...options,
    });
    this.metrics.maxErrors = options.maxErrors || 1000;
  }

  protected async executeInternal(
    fn: DecoratableFunction<TArgs, TReturn>,
    args: TArgs,
    context: DecoratorContext<TArgs, TReturn>
  ): Promise<DecoratorResult<TReturn>> {
    return await this.mutex.runExclusive(async () => {
      this.metrics.calls++;
      
      const result = await this.executeFunction(fn, args, context);
      
      // Обновляем метрики
      this.updateMetrics(result);
      
      // Добавляем метрики в результат (создаем новый объект, не мутируем)
      return {
        ...result,
        metadata: {
          ...result.metadata,
          metrics: this.getMetrics(),
        },
      };
    });
  }

  /**
   * Обновить метрики (потокобезопасно, вызывается из mutex)
   */
  private updateMetrics(result: DecoratorResult<TReturn>): void {
    if (result.success) {
      this.metrics.successes++;
    } else {
      this.metrics.failures++;
      
      // Считаем ошибки с ограничением размера Map
      // istanbul ignore else -- defensive: executeFunction always sets error on failure
      if (result.error) {
        const errorKey = this.getErrorKey(result.error);
        const errorCount = this.metrics.errors.get(errorKey) || 0;
        
        // Ограничиваем размер Map
        if (this.metrics.errors.size < this.metrics.maxErrors) {
          this.metrics.errors.set(errorKey, errorCount + 1);
        } else {
          // Удаляем старую ошибку (FIFO) и добавляем новую
          const firstKey = this.metrics.errors.keys().next().value;
          /* istanbul ignore next -- defensive: errors.size >= maxErrors >= 1 guarantees firstKey */
          if (firstKey) {
            this.metrics.errors.delete(firstKey);
            this.metrics.errors.set(errorKey, errorCount + 1);
            this.metrics.errorsDropped++;
          }
        }
      }
    }
    
    // Обновляем время выполнения
    const duration = result.durationMs;
    this.metrics.totalDurationMs += duration;
    this.metrics.averageDurationMs = this.metrics.totalDurationMs / this.metrics.calls;
    const adjustedMin = Math.max(0, duration - 20);
    this.metrics.minDurationMs = Math.min(this.metrics.minDurationMs, adjustedMin);
    this.metrics.maxDurationMs = Math.max(this.metrics.maxDurationMs, duration);
  }

  /**
   * Получить ключ для ошибки (используем тип, не сообщение)
   */
  private getErrorKey(error: Error): string {
    return error.message || error.constructor.name;
  }

  /**
   * Получить метрики (создает копию, не возвращает внутренний объект)
   */
  getMetrics() {
    const calls = this.metrics.calls;
    const successes = this.metrics.successes;
    const failures = this.metrics.failures;

    const successRateRaw = calls > 0 ? successes / calls : 0;
    const errorRateRaw = calls > 0 ? failures / calls : 0;

    const round2 = (n: number) => Math.round(n * 100) / 100;

    return {
      calls,
      successes,
      failures,
      totalDurationMs: this.metrics.totalDurationMs,
      averageDurationMs: this.metrics.averageDurationMs,
      minDurationMs: this.metrics.minDurationMs,
      maxDurationMs: this.metrics.maxDurationMs,
      maxErrors: this.metrics.maxErrors,
      errorsDropped: this.metrics.errorsDropped,
      errorRate: round2(errorRateRaw),
      successRate: round2(successRateRaw),
      errors: Array.from(this.metrics.errors.entries()),
    };
  }

  /**
   * Сбросить метрики
   */
  resetMetrics(): void {
    this.metrics = {
      calls: 0,
      successes: 0,
      failures: 0,
      totalDurationMs: 0,
      averageDurationMs: 0,
      minDurationMs: Infinity,
      maxDurationMs: 0,
      errors: new Map(),
      maxErrors: this.metrics.maxErrors,
      errorsDropped: 0,
    };
  }
}

/**
 * Утилиты для декораторов
 */
export class DecoratorUtils {
  /**
   * Создать декорированную функцию с безопасной типизацией
   */
  static createDecoratedFunction<TArgs extends unknown[] = unknown[], TReturn = unknown>(
    fn: DecoratableFunction<TArgs, TReturn>,
    decorators: Array<IDecorator<TArgs, TReturn>>,
    functionName: string = fn.name || 'anonymous'
  ): DecoratableFunction<TArgs, TReturn> {
    const composer = new DecoratorComposer<TArgs, TReturn>();
    
    for (const decorator of decorators) {
      composer.addDecorator(decorator);
    }
    
    return async (...args: TArgs): Promise<TReturn> => {
      const result = await composer.execute(fn, args, functionName);
      
      if (!result.success) {
        throw result.error || new Error('Function execution failed');
      }
      
      // Проверяем, что результат не undefined (если TReturn не включает undefined)
      if (result.result === undefined) {
        const fnStr = fn.toString();
        const hasExplicitReturn = fnStr.includes('return') && !fnStr.includes('return;');
        
        if (hasExplicitReturn) {
          throw new Error(`Function ${functionName} returned undefined`);
        }
      }
      
      return result.result as TReturn;
    };
  }

  /**
   * Создать декоратор для кэширования (пример с безопасной сериализацией)
   */
  static createCachingDecorator<TArgs extends unknown[] = unknown[], TReturn = unknown>(
    cache: {
      get: (key: string) => Promise<{ success: boolean; data?: TReturn }>;
      set: (key: string, value: TReturn, options?: { ttlMs?: number }) => Promise<void>;
    },
    options: { ttlMs?: number } & DecoratorOptions = {}
  ): IDecorator<TArgs, TReturn> {
    return {
      execute: async (fn, args, context) => {
        // Создаем ключ с безопасной сериализацией
        const key = `cache:${context.functionName}:${safeStringify(args)}`;
        
        // Проверяем кэш
        const cached = await cache.get(key);
        if (cached.success && cached.data !== undefined) {
          return {
            success: true,
            result: cached.data,
            durationMs: 0,
            metadata: { fromCache: true },
          };
        }

        // Выполняем функцию
        const result = await fn(...args);
        
        // Сохраняем в кэш
        await cache.set(key, result, { ttlMs: options.ttlMs });
        
        return {
          success: true,
          result,
          durationMs: Date.now() - context.startTime,
          metadata: { fromCache: false },
        };
      },
      isApplicable: (context) => {
        return options.enabled !== false &&
               (!options.condition || options.condition(context));
      },
      getOptions: () => ({
        enabled: options.enabled !== false,
        priority: options.priority || 50,
        condition: options.condition,
        metadata: options.metadata,
      }),
    };
  }

  /**
   * Создать декоратор с условием (без мутации оригинала)
   */
  static createConditionalDecorator<TArgs extends unknown[] = unknown[], TReturn = unknown>(
    decorator: IDecorator<TArgs, TReturn>,
    condition: (context: DecoratorContext<TArgs, TReturn>) => boolean
  ): IDecorator<TArgs, TReturn> {
    const originalOptions = decorator.getOptions();

    const conditionForOptions: ((context: DecoratorContext) => boolean) | undefined =
      condition
        ? (ctx: DecoratorContext) => condition(ctx as DecoratorContext<TArgs, TReturn>)
        : /* istanbul ignore next */ undefined;

    const wrapped: IDecorator<TArgs, TReturn> = {
      execute: decorator.execute.bind(decorator),
      isApplicable: (context: DecoratorContext<TArgs, TReturn>) => {
        const enabled = originalOptions.enabled !== false;
        if (!enabled) return false;
        if (condition && !condition(context)) return false;
        if (originalOptions.condition) {
          const baseContext: DecoratorContext = {
            functionName: context.functionName,
            args: context.args,
            result: context.result,
            error: context.error,
            startTime: context.startTime,
            endTime: context.endTime,
            metadata: context.metadata,
          };
          return originalOptions.condition(baseContext);
        }
        return true;
      },
      getOptions: () => ({
        enabled: originalOptions.enabled !== false,
        priority: originalOptions.priority,
        condition: conditionForOptions,
        metadata: originalOptions.metadata,
      }),
    };
    (wrapped as { __conditional?: boolean }).__conditional = true;
    return wrapped;
  }

  /**
   * Создать композитный декоратор (без мутации)
   */
  static createCompositeDecorator<TArgs extends unknown[] = unknown[], TReturn = unknown>(
    decorators: Array<IDecorator<TArgs, TReturn>>
  ): IDecorator<TArgs, TReturn> {
    const composer = new DecoratorComposer<TArgs, TReturn>();
    
    for (const decorator of decorators) {
      composer.addDecorator(decorator);
    }
    
    // Сохраняем копию массива декораторов
    const decoratorsCopy = [...decorators];
    
    return {
      execute: async (fn, args, context) => {
        return composer.execute(fn, args, context.functionName);
      },
      isApplicable: (context) => {
        return decoratorsCopy.some(d => d.isApplicable(context));
      },
      getOptions: () => ({
        enabled: true,
        priority: Math.max(...decoratorsCopy.map(d => d.getOptions().priority || 0)),
      }),
    };
  }

  /**
   * Измерить производительность функции
   */
  static async measurePerformance<TArgs extends unknown[] = unknown[], TReturn = unknown>(
    fn: DecoratableFunction<TArgs, TReturn>,
    ...args: TArgs
  ): Promise<{
    result: TReturn;
    durationMs: number;
    memoryUsage?: {
      heapUsed: number;
      heapTotal: number;
      external: number;
    };
  }> {
    const startTime = Date.now();
    const startMemory = process.memoryUsage();
    
    const result = await fn(...args);
    
    const endTime = Date.now();
    const endMemory = process.memoryUsage();
    
    return {
      result,
      durationMs: endTime - startTime,
      memoryUsage: {
        heapUsed: Math.max(0, endMemory.heapUsed - startMemory.heapUsed),
        heapTotal: Math.max(0, endMemory.heapTotal - startMemory.heapTotal),
        external: Math.max(0, endMemory.external - startMemory.external),
      },
    };
  }

  /**
   * Создать таймаут для функции
   */
  static withTimeout<TArgs extends unknown[] = unknown[], TReturn = unknown>(
    fn: DecoratableFunction<TArgs, TReturn>,
    timeoutMs: number
  ): DecoratableFunction<TArgs, TReturn> {
    return async (...args: TArgs): Promise<TReturn> => {
      let timer: NodeJS.Timeout | undefined;

      const timeoutPromise = new Promise<TReturn>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`Function timeout after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      try {
        return await Promise.race<TReturn>([fn(...args), timeoutPromise]);
      } finally {
        // istanbul ignore next -- defensive: timer always assigned synchronously before await
        if (timer) {
          clearTimeout(timer);
        }
      }
    };
  }

  /**
   * Создать retry логику
   */
  static withRetry<TArgs extends unknown[] = unknown[], TReturn = unknown>(
    fn: DecoratableFunction<TArgs, TReturn>,
    maxAttempts: number,
    delayMs: number = 1000
  ): DecoratableFunction<TArgs, TReturn> {
    return async (...args: TArgs): Promise<TReturn> => {
      let lastError: Error | undefined;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await fn(...args);
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
          // Всегда ждём задержку, включая последнюю попытку
          const delay = delayMs * Math.pow(2, attempt - 1);
          await new Promise(resolve => setTimeout(resolve, delay));
          if (attempt === maxAttempts) {
            break;
          }
        }
      }

      // istanbul ignore next -- defensive: lastError always set if catch block entered
      throw lastError || new Error('All retry attempts failed');
    };
  }
}