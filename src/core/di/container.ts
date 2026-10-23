/**
 * DI Container - централизованное управление зависимостями
 * Layer: Core
 *
 * Реализует паттерн Dependency Injection Container для управления
 * жизненным циклом и разрешением зависимостей компонентов.
 *
 * @example
 * ```typescript
 * // Регистрация зависимостей
 * container.register('IAIClient', () => createOpenAIAdapterFromEnv());
 * container.register('ICache', () => createRedisAdapterFromEnv());
 *
 * // Разрешение зависимостей
 * const aiClient = container.resolve<IAIClient>('IAIClient');
 * const cache = container.resolve<ICache>('ICache');
 * ```
 */

import { Timestamp, now } from '../types';
import type { AspectManager, ApplyAspectsOptions } from '../aop/AspectManager';
import type { ContainerDisposalEvent, DisposalResult, IDisposable, IContainer, IAmbientScopeProvider } from './types';

/** Counter for generating unique container IDs */
let containerIdCounter = 0;

/** Generate unique container ID */
function generateContainerId(): string {
  return `container-${++containerIdCounter}-${Date.now().toString(36)}`;
}

// Типы для DI Container
export type ServiceFactory<T> = (c: DIContainer) => T;
export type ServiceToken = string | symbol;

/**
 * Type-safe injection token for DI container.
 * Provides compile-time type checking for resolved services.
 */
export type InjectionToken<T> = symbol & { __type?: T };

/**
 * Опции регистрации сервиса
 */
export interface ServiceRegistrationOptions {
  /** Жизненный цикл сервиса */
  lifecycle?: 'singleton' | 'transient' | 'scoped';
  /** Теги для группировки сервисов */
  tags?: string[];
  /** Описание сервиса */
  description?: string;
  /** Настройки применения аспектов */
  aspectOptions?: ApplyAspectsOptions | ((token: ServiceToken) => ApplyAspectsOptions | undefined);
}

/**
 * Информация о зарегистрированном сервисе
 */
export interface ServiceInfo {
  /** Токен сервиса */
  token: ServiceToken;
  /** Тип жизненного цикла */
  lifecycle: 'singleton' | 'transient' | 'scoped';
  /** Теги */
  tags: string[];
  /** Описание */
  description?: string;
  /** Время регистрации */
  registeredAt: Timestamp;
  /** Количество разрешений */
  resolveCount: number;
  /** Настройки аспектов */
  aspectOptions?: ApplyAspectsOptions;
}

/**
 * Ошибка DI Container
 */
export class DIError extends Error {
  constructor(
    message: string,
    public readonly token?: ServiceToken,
    public readonly cause?: Error
  ) {
    super(message);
    this.name = 'DIError';
  }

  static notRegistered(token: ServiceToken): DIError {
    return new DIError(`Service not registered: ${String(token)}`);
  }

  static circularDependency(token: ServiceToken): DIError {
    return new DIError(`Circular dependency detected for: ${String(token)}`);
  }

  static invalidFactory(token: ServiceToken): DIError {
    return new DIError(`Invalid factory for service: ${String(token)}`);
  }

  static alreadyRegistered(token: ServiceToken): DIError {
    return new DIError(`Service already registered: ${String(token)}`);
  }
}

/**
 * DI Container - централизованное управление зависимостями
 */
export class DIContainer implements IContainer {
  /** Unique identifier for this container */
  readonly id: string;

  private services = new Map<ServiceToken, ServiceFactory<unknown>>();
  private singletons = new Map<ServiceToken, unknown>();
  private serviceInfo = new Map<ServiceToken, ServiceInfo>();
  private resolving = new Set<ServiceToken>();
  private scopedInstances = new Map<string, Map<ServiceToken, unknown>>();
  private allowOverrides = false;
  private aspectManager: AspectManager | null = null;
  private ambientScopeProvider: IAmbientScopeProvider | null = null;
  private disposed = false;

  /** Child containers for cascade disposal */
  private children = new Set<WeakRef<DIContainer>>();
  /* istanbul ignore next -- GC-triggered callback; non-deterministic, untestable */
  private childFinalizers = new FinalizationRegistry<string>((id) => {
    // Cleanup when child container is garbage collected
    this.children.forEach((ref) => {
      if (ref.deref() === undefined) {
        this.children.delete(ref);
      }
    });
  });

  /** Event handlers for disposal lifecycle */
  private disposingHandlers = new Set<(event: ContainerDisposalEvent) => void>();
  private disposedHandlers = new Set<(event: ContainerDisposalEvent) => void>();

  constructor() {
    this.id = generateContainerId();
  }

  /**
   * Check if container has been disposed
   */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Ensure container is not disposed before operations
   */
  private ensureNotDisposed(): void {
    if (this.disposed) {
      throw new DIError(`Container ${this.id} has been disposed`);
    }
  }

  /**
   * Зарегистрировать сервис
   *
   * @param token - Токен сервиса (ключ для разрешения)
   * @param factory - Фабричная функция
   * @param options - Опции регистрации
   *
   * @example
   * ```typescript
   * container.register('IAIClient', () => new OpenAIAdapter(config), {
   *   lifecycle: 'singleton',
   *   tags: ['ai', 'external'],
   *   description: 'OpenAI API client'
   * });
   * ```
   */
  // Перегрузки для контекстной типизации параметра фабрики 'c'
  register<T>(token: ServiceToken, factory: (c: DIContainer) => T, optionsOrLifecycle?: ServiceRegistrationOptions | 'singleton' | 'transient' | 'scoped'): void;
  register<T>(token: ServiceToken, factory: () => T, optionsOrLifecycle?: ServiceRegistrationOptions | 'singleton' | 'transient' | 'scoped'): void;
  register<T>(
    token: ServiceToken,
    factory: ServiceFactory<T>,
    optionsOrLifecycle: ServiceRegistrationOptions | 'singleton' | 'transient' | 'scoped' = {}
  ): void {
    this.ensureNotDisposed();

    if (typeof factory !== 'function') {
      throw DIError.invalidFactory(token);
    }

    const opts = (typeof optionsOrLifecycle === 'string'
      ? { lifecycle: optionsOrLifecycle }
      : optionsOrLifecycle);

    const { lifecycle = 'singleton', tags = [], description } = opts;
    const aspectOptions =
      typeof opts.aspectOptions === 'function'
        ? opts.aspectOptions(token)
        : opts.aspectOptions;

    if (this.services.has(token) && !this.allowOverrides) {
      throw DIError.alreadyRegistered(token);
    }

    this.services.set(token, factory);
    this.serviceInfo.set(token, {
      token,
      lifecycle,
      tags,
      description,
      registeredAt: now(),
      resolveCount: this.serviceInfo.get(token)?.resolveCount ?? 0,
      aspectOptions,
    });

    // Очистка кэшированных инстансов на случай повторной регистрации
    this.singletons.delete(token);
    // Также очищаем scoped инстансы
    for (const scope of this.scopedInstances.values()) {
      scope.delete(token);
    }
  }

  /**
   * Разрешить зависимость
   *
   * @param token - Токен сервиса
   * @returns Экземпляр сервиса
   *
   * @example
   * ```typescript
   * const aiClient = container.resolve<IAIClient>('IAIClient');
   * ```
   */
  resolve<T = unknown>(token: ServiceToken, scopeId?: string): T {
    if (!this.services.has(token)) {
      throw DIError.notRegistered(token);
    }

    const info = this.serviceInfo.get(token);
    /* istanbul ignore next -- defensive: serviceInfo always in sync with services Map */
    if (!info) {
      throw DIError.notRegistered(token);
    }
    info.resolveCount++;

    // Проверка циклических зависимостей
    if (this.resolving.has(token)) {
      throw DIError.circularDependency(token);
    }

    const factory = this.services.get(token);
    /* istanbul ignore next -- defensive: services.has() already checked above */
    if (!factory) {
      throw DIError.notRegistered(token);
    }

    switch (info.lifecycle) {
      case 'singleton': {
        if (!this.singletons.has(token)) {
          this.resolving.add(token);
          try {
            const created = factory(this);
            const enhanced = this.applyAspectsIfNeeded(token, created);
            this.singletons.set(token, enhanced);
          } finally {
            this.resolving.delete(token);
          }
        }
        return this.singletons.get(token) as T;
      }
      case 'transient': {
        this.resolving.add(token);
        try {
          const created = factory(this);
          return this.applyAspectsIfNeeded(token, created) as T;
        } finally {
          this.resolving.delete(token);
        }
      }
      case 'scoped': {
        const effectiveScopeId = scopeId ?? this.ambientScopeProvider?.getScopeId();
        if (!effectiveScopeId) {
          throw new DIError(`No active scope for scoped dependency: ${String(token)}`, token);
        }
        let scope = this.scopedInstances.get(effectiveScopeId);
        if (!scope) {
          scope = new Map<ServiceToken, unknown>();
          this.scopedInstances.set(effectiveScopeId, scope);
        }
        if (!scope.has(token)) {
          this.resolving.add(token);
          try {
            const created = factory(this);
            const enhanced = this.applyAspectsIfNeeded(token, created);
            scope.set(token, enhanced);
          } finally {
            this.resolving.delete(token);
          }
        }
        return scope.get(token) as T;
      }
      /* istanbul ignore next -- unreachable: TypeScript enforces valid lifecycle */
      default:
        throw new Error('Unknown lifecycle');
    }
  }

  /**
   * Проверить, зарегистрирован ли сервис
   *
   * @param token - Токен сервиса
   * @returns true если сервис зарегистрирован
   */
  isRegistered(token: ServiceToken): boolean {
    return this.services.has(token);
  }

  /**
   * Проверить регистрацию (alias для isRegistered) — совместимость с тестами
   */
  has(token: ServiceToken): boolean {
    return this.isRegistered(token);
  }

  /**
   * Проверить, был ли singleton-сервис уже инстанцирован (resolve вызывался)
   *
   * @param token - Токен сервиса
   * @returns true если singleton уже создан
   */
  isInstantiated(token: ServiceToken): boolean {
    return this.singletons.has(token);
  }

  /**
   * Разрешить пере-регистрацию существующих токенов без ошибки.
   * Включено по умолчанию для глобального контейнера в тестовой среде.
   */
  setAllowOverrides(allow: boolean): void {
    this.allowOverrides = allow;
  }

  /**
   * Получить информацию о сервисе
   *
   * @param token - Токен сервиса
   * @returns Информация о сервисе или null
   */
  getServiceInfo(token: ServiceToken): ServiceInfo | null {
    return this.serviceInfo.get(token) || null;
  }

  /**
   * Получить все зарегистрированные сервисы
   *
   * @returns Массив информации о всех сервисах
   */
  getAllServices(): ServiceInfo[] {
    return Array.from(this.serviceInfo.values());
  }

  /**
   * Получить список зарегистрированных токенов — совместимость с тестами
   */
  getRegisteredTokens(): ServiceToken[] {
    return Array.from(this.services.keys());
  }

  /**
   * Найти сервисы по тегу
   *
   * @param tag - Тег для поиска
   * @returns Массив токенов сервисов с указанным тегом
   */
  findByTag(tag: string): ServiceToken[] {
    return Array.from(this.serviceInfo.values())
      .filter(info => info.tags.includes(tag))
      .map(info => info.token);
  }

  /**
   * Удалить регистрацию сервиса
   *
   * @param token - Токен сервиса
   */
  unregister(token: ServiceToken): boolean {
    const existed = this.services.delete(token);
    this.serviceInfo.delete(token);
    this.singletons.delete(token);
    for (const scope of this.scopedInstances.values()) {
      scope.delete(token);
    }
    return existed;
  }

  /**
   * Очистить контейнер
   */
  clear(): void {
    this.services.clear();
    this.serviceInfo.clear();
    this.singletons.clear();
    this.resolving.clear();
    this.scopedInstances.clear();
  }

  /**
   * Очистить кэш инстансов (singleton/scoped) без удаления регистраций.
   * После вызова singleton-сервисы будут пересозданы при следующем resolve().
   */
  clearInstances(): void {
    this.ensureNotDisposed();
    // Удаляем кэшированные singleton инстансы
    this.singletons.clear();

    // Удаляем scoped инстансы
    this.scopedInstances.clear();
  }

  /**
   * Удалить и утилизировать (dispose) все инстансы в рамках конкретного scopeId.
   * Критично для предотвращения утечек памяти при использовании scoped lifecycle.
   * 
   * @param scopeId - Идентификатор скоупа (например, requestId)
   */
  disposeScope(scopeId: string): void {
    const scope = this.scopedInstances.get(scopeId);
    if (!scope) {
      return;
    }

    // Dispose instances that implement IDisposable
    for (const [token, instance] of scope) {
      if (instance && typeof instance === 'object' && 'dispose' in instance) {
        try {
          (instance as IDisposable).dispose();
        } catch (error) {
          // @audit-ok: Core layer, no DI — error handler in disposeScope cleanup
          console.error(`[DIContainer] Failed to dispose scoped instance ${String(token)} in scope ${scopeId}:`, error);
        }
      }
    }

    // Remove scope from registry
    this.scopedInstances.delete(scopeId);
  }

  /**
   * Dispose container and cleanup all resources
   * - Clears all singleton instances
   * - Clears all scoped instances
   * - Removes all registrations
   * - Emits disposal events for cleanup
   *
   * @returns Disposal result with statistics
   */
  dispose(): DisposalResult {
    if (this.disposed) {
      return {
        success: true,
        singletonsDisposed: 0,
        scopedDisposed: 0,
        registrationsCleared: 0,
        errors: [],
        durationMs: 0,
      };
    }

    const startTime = performance.now();
    const errors: Error[] = [];

    // Emit disposing event
    const disposingEvent: ContainerDisposalEvent = {
      type: 'container:disposing',
      containerId: this.id,
      timestamp: Date.now(),
      servicesDisposed: this.singletons.size + this.scopedInstances.size,
    };
    this.disposingHandlers.forEach((handler) => {
      try {
        handler(disposingEvent);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    });

    // Dispose child containers first (cascade disposal)
    this.children.forEach((ref) => {
      const child = ref.deref();
      if (child && !child.isDisposed) {
        try {
          child.dispose();
        } catch (error) {
          /* istanbul ignore next -- defensive: child.dispose() never throws */
          errors.push(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    this.children.clear();

    // Count instances before clearing
    const singletonsCount = this.singletons.size;
    let scopedCount = 0;
    for (const scope of this.scopedInstances.values()) {
      scopedCount += scope.size;
    }
    const registrationsCount = this.services.size;

    // Dispose singleton instances that implement IDisposable
    for (const [token, instance] of this.singletons) {
      if (instance && typeof instance === 'object' && 'dispose' in instance) {
        try {
          (instance as IDisposable).dispose();
        } catch (error) {
          errors.push(error instanceof Error ? error : new Error('Failed to dispose ' + String(token) + ': ' + String(error)));
        }
      }
    }

    // Clear all data
    this.services.clear();
    this.serviceInfo.clear();
    this.singletons.clear();
    this.resolving.clear();
    this.scopedInstances.clear();
    this.disposed = true;

    // Emit disposed event
    const disposedEvent: ContainerDisposalEvent = {
      type: 'container:disposed',
      containerId: this.id,
      timestamp: Date.now(),
      servicesDisposed: singletonsCount + scopedCount,
    };
    this.disposedHandlers.forEach((handler) => {
      try {
        handler(disposedEvent);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    });

    // Clear event handlers
    this.disposingHandlers.clear();
    this.disposedHandlers.clear();

    const durationMs = performance.now() - startTime;

    return {
      success: errors.length === 0,
      singletonsDisposed: singletonsCount,
      scopedDisposed: scopedCount,
      registrationsCleared: registrationsCount,
      errors,
      durationMs,
    };
  }

  /**
   * Subscribe to disposal event (triggered before disposal starts)
   * @returns Unsubscribe function
   */
  onDisposing(handler: (event: ContainerDisposalEvent) => void): () => void {
    this.disposingHandlers.add(handler);
    return () => {
      this.disposingHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to post-disposal event (triggered after disposal completes)
   * @returns Unsubscribe function
   */
  onDisposed(handler: (event: ContainerDisposalEvent) => void): () => void {
    this.disposedHandlers.add(handler);
    return () => {
      this.disposedHandlers.delete(handler);
    };
  }

  /**
   * Создать дочерний контейнер
   *
   * Дочерний контейнер наследует все регистрации родителя,
   * но может переопределять их локально.
   *
   * @param scopeId - Optional scope identifier for the child container
   * @returns Новый дочерний контейнер
   */
  createChild(scopeId?: string): DIContainer {
    this.ensureNotDisposed();

    const child = new DIContainer();
    // Разрешаем переопределение регистраций в дочернем контейнере для тестов и локальной конфигурации
    child.setAllowOverrides(true);

    // Копируем все регистрации
    for (const [token, factory] of this.services) {
      const info = this.serviceInfo.get(token);
      /* istanbul ignore next -- defensive: serviceInfo always in sync with services Map */
      if (!info) {
        continue;
      }
      child.services.set(token, factory);
      child.serviceInfo.set(token, { ...info });
    }

    // Track child for cascade disposal
    const childRef = new WeakRef(child);
    this.children.add(childRef);
    this.childFinalizers.register(child, child.id);

    // Set ID if provided
    if (scopeId) {
      (child as unknown as { id: string }).id = scopeId;
    }

    return child;
  }

  /**
   * Установить менеджер аспектов для автоматического применения AOP при разрешении зависимостей
   */
  setAspectManager(manager: AspectManager | null): void {
    this.aspectManager = manager;
  }

  /**
   * Set the ambient scope provider for automatic 'scoped' dependency resolution.
   */
  setAmbientScopeProvider(provider: IAmbientScopeProvider | null): void {
    this.ambientScopeProvider = provider;
  }

  private applyAspectsIfNeeded<T>(token: ServiceToken, instance: T): T {
    if (!instance || typeof instance !== 'object' || !this.aspectManager) {
      return instance;
    }

    const info = this.serviceInfo.get(token);
    const inferredOptions: ApplyAspectsOptions = {
      className: (instance as { constructor?: { name?: string } })?.constructor?.name,
    };

    const options = info?.aspectOptions
      ? {
          ...inferredOptions,
          ...info.aspectOptions,
          metadata: {
            ...(inferredOptions.metadata ?? {}),
            ...(info.aspectOptions.metadata ?? {}),
          },
          methodMetadata: {
            ...(inferredOptions.methodMetadata ?? {}),
            ...(info.aspectOptions.methodMetadata ?? {}),
          },
        }
      : inferredOptions;

    return this.aspectManager.applyTo(instance, options);
  }

  /**
   * Получить статистику использования контейнера
   */
  getStats() {
    const services = this.getAllServices();
    const totalResolves = services.reduce((sum, info) => sum + info.resolveCount, 0);

    return {
      totalServices: services.length,
      singletonServices: services.filter(s => s.lifecycle === 'singleton').length,
      transientServices: services.filter(s => s.lifecycle === 'transient').length,
      scopedServices: services.filter(s => s.lifecycle === 'scoped').length,
      totalResolves,
      averageResolvesPerService: services.length > 0 ? totalResolves / services.length : 0,
    };
  }
}

/**
 * Глобальный экземпляр DI Container
 */
export const container = new DIContainer();
container.setAllowOverrides(true);

/**
 * ServiceTokens — типобезопасные токены для тестов/бутстрапа
 */
export const ServiceTokens = {
  DatabaseConnection: 'IDatabaseConnection',
  IConversationRepository: 'IConversationRepository',
  IEventBus: 'IEventBus',
  OpenAIClient: 'IAIClient',
  AnthropicClient: 'AnthropicClient'
} as const;


/**
 * Декоратор для автоматической регистрации сервиса
 *
 * @param token - Токен для регистрации
 * @param options - Опции регистрации
 *
 * @example
 * ```typescript
 * @injectable('IAIClient', { lifecycle: 'singleton' })
 * class OpenAIAdapter implements IAIClient {
 *   // ...
 * }
 * ```
 */
export function injectable(token: ServiceToken, options?: ServiceRegistrationOptions) {
  return function <T extends { new (...args: unknown[]): unknown }>(constructor: T) {
    // Регистрируем конструктор как фабрику
    container.register(token, () => new constructor(), options);
    return constructor;
  };
}

/**
 * Удалено: декоратор inject
 *
 * В соответствии с DI политикой запрещены property injection и service locator.
 * Используйте только constructor injection: зависимости передаются через параметры
 * конструктора и регистрируются фабриками в DI контейнере.
 */