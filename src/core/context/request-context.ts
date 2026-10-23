/**
 * Request Context - контекст HTTP запроса для propagation correlation_id
 * Layer: Application (бизнес-логика)
 *
 * Обеспечивает автоматическое распространение correlation_id, user_id, session_id
 * и других атрибутов запроса через все слои приложения. Используется для
 * трассировки операций и логирования.
 */

import { AsyncLocalStorage } from 'async_hooks';
import * as core from 'express-serve-static-core';
type Request = core.Request;
type Response = core.Response;
type NextFunction = core.NextFunction;
import { IAmbientScopeProvider } from '../di/types';
import { CorrelationIdProvider } from '../correlation/correlation';
import { IdGenerator } from '../utils/IdGenerator';
import type { DomainEvent } from '../../domain/events/event-store.interface';
import { readInt, readStr } from '../config/app-config';

// Core Imports
import {
  BrandedIds,
  type UserId,
  type SessionId,
  type TenantId,
  type CorrelationId,
  type RequestId,
  type MasSessionId,
  type MasTraceId,
  type RequestContextData,
  type IRequestContext,
  RequestContextError
} from './IRequestContext';

// Re-export for compatibility (during gradual migration if needed, but we will fix all consumers)
export {
  BrandedIds,
  type UserId,
  type SessionId,
  type TenantId,
  type CorrelationId,
  type RequestId,
  type MasSessionId,
  type MasTraceId,
  type RequestContextData,
  type IRequestContext,
  RequestContextError
};

/**
 * RequestContext - управление контекстом запроса через AsyncLocalStorage.
 */
export class AsyncLocalRequestContext implements IRequestContext, IAmbientScopeProvider {
  private static readonly storage = new AsyncLocalStorage<RequestContextData>();

  // Track context initialization to prevent double initialization
  private static contextInitialized = false;

  // Maximum context age before considered stale (30 seconds default)
  private static readonly DEFAULT_MAX_CONTEXT_AGE_MS = 30000;

  /**
   * Returns the current requestId as the ambient scope ID.
   * Part of IAmbientScopeProvider implementation.
   */
  public getScopeId(): string | undefined {
    try {
      return AsyncLocalRequestContext.getContext().requestId;
    } catch {
      return undefined;
    }
  }

  /**
   * Получить текущий контекст из async-local storage
   */
  static getCurrent(): RequestContextData | null {
    return this.storage.getStore() || null;
  }

  /**
   * Получить текущий контекст. Бросает ошибку, если вне контекста.
   */
  public static getContext(): RequestContextData {
    const context = this.storage.getStore();
    if (!context) {
      throw RequestContextError.notInitialized('getContext');
    }
    return context;
  }

  /**
   * Установить контекст в async-local storage
   * @deprecated Use runWith() for proper cleanup. setCurrent() is deprecated and throws.
   *
   * A-019 FIX: This method has been DISABLED due to unsafe enterWith() usage causing
   * context bleeding across requests. enterWith() sets context for the entire remaining
   * async stack, which causes leaks in long-running servers.
   *
   * MIGRATION PATH: Replace setCurrent() calls with runWith():
   *   // OLD (unsafe):
   *   AsyncLocalRequestContext.setCurrent(context);
   *   await doWork();
   *   AsyncLocalRequestContext.clear();
   *
   *   // NEW (safe):
   *   await AsyncLocalRequestContext.runWith(context, async () => {
   *     await doWork();
   *   });
   *
   * For Express middleware, the RequestContextMiddleware already uses runWith() correctly.
   */
  static setCurrent(context: RequestContextData | null): void {
    if (context === null) {
      this.storage.disable();
      this.contextInitialized = false;
      return;
    }
    
    // A-019 FIX: setCurrent() is disabled due to enterWith() causing context bleeding
    // The only safe pattern is runWith() which uses AsyncLocalStorage.run()
    throw new RequestContextError(
      'setCurrent() is disabled (A-019). Use AsyncLocalRequestContext.runWith() instead. ' +
      'enterWith() causes context bleeding across requests. ' +
      'See migration guide in AGENTS.md or AI_MASTER.md',
      'setCurrent_disabled_A019'
    );
  }

  /**
   * Очистить async-local storage
   */
  static clear(): void {
    this.storage.disable();
    this.contextInitialized = false;
  }
  
  /**
   * Validate that context is not stale (too old)
   */
  static validateContextNotStale(context: RequestContextData): void {
    let maxAge = this.DEFAULT_MAX_CONTEXT_AGE_MS;
    try {
      maxAge = readInt('REQUEST_CONTEXT_MAX_AGE_MS', this.DEFAULT_MAX_CONTEXT_AGE_MS);
    } catch {
      // Fallback to default if config validation fails (e.g. in minimal test environments)
    }
    
    const age = Date.now() - context.startedAt.getTime();
    
    if (age > maxAge) {
      throw new RequestContextError(
        `Stale context detected: age=${age}ms exceeds max=${maxAge}ms ` +
        `for correlationId=${context.correlationId}`,
        'validateContextNotStale'
      );
    }
  }
  
  /**
   * Check if we're currently inside an async context
   */
  static isInContext(): boolean {
    return this.getCurrent() !== null;
  }

  /**
   * Выполнить функцию в рамках переданного контекста (без утечки за пределы области)
   * Implements proper cleanup using AsyncLocalStorage.run() which automatically
   * cleans up the context when the callback completes.
   */
  static async runWith<T>(contextData: RequestContextData, fn: () => Promise<T> | T): Promise<T> {
    // Validate context is not stale
    AsyncLocalRequestContext.validateContextNotStale(contextData);
    
    // Use AsyncLocalStorage.run() for automatic cleanup
    // This is the key fix for P0-003: proper context isolation
    return await AsyncLocalRequestContext.storage.run(contextData, async () => {
      return await Promise.resolve(fn());
    });
  }

  /**
   * Получить correlation ID
   */
  getCorrelationId(): CorrelationId {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('getCorrelationId');
    }
    return context.correlationId;
  }

  /**
   * Установить correlation ID
   */
  setCorrelationId(id: CorrelationId): void {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('setCorrelationId');
    }
    this.validateCorrelationId(id);
    context.correlationId = id;
  }

  /**
   * Получить user ID
   */
  getUserId(): UserId | undefined {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('getUserId');
    }
    return context.userId;
  }

  /**
   * Установить user ID
   */
  setUserId(userId: UserId): void {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('setUserId');
    }
    context.userId = userId;
  }

  /**
   * Получить session ID
   */
  getSessionId(): SessionId | undefined {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('getSessionId');
    }
    return context.sessionId;
  }

  /**
   * Установить session ID
   */
  setSessionId(sessionId: SessionId): void {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('setSessionId');
    }
    context.sessionId = sessionId;
  }

  /**
   * Получить tenant ID
   */
  getTenantId(): TenantId | undefined {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('getTenantId');
    }
    return context.tenantId;
  }

  /**
   * Установить tenant ID
   */
  setTenantId(tenantId: TenantId): void {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('setTenantId');
    }
    context.tenantId = tenantId;
  }

  /**
   * Получить request ID
   */
  getRequestId(): RequestId {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('getRequestId');
    }
    return context.requestId;
  }

  /**
   * Получить MAS session ID
   */
  getMasSessionId(): MasSessionId | undefined {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('getMasSessionId');
    }
    return context.masSessionId;
  }

  /**
   * Установить MAS session ID
   */
  setMasSessionId(id: MasSessionId): void {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('setMasSessionId');
    }
    context.masSessionId = id;
  }

  /**
   * Получить MAS trace ID
   */
  getMasTraceId(): MasTraceId | undefined {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('getMasTraceId');
    }
    return context.masTraceId;
  }

  /**
   * Установить MAS trace ID
   */
  setMasTraceId(id: MasTraceId): void {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('setMasTraceId');
    }
    context.masTraceId = id;
  }

  /**
   * Получить все данные контекста
   */
  getContext(): RequestContextData {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('getContext');
    }
    return { ...context };
  }

  /**
   * Очистить контекст
   */
  clear(): void {
    AsyncLocalRequestContext.clear();
  }

  /**
   * Проверить, установлен ли контекст
   */
  isInitialized(): boolean {
    return AsyncLocalRequestContext.getCurrent() !== null;
  }

  /**
   * Получить время жизни контекста (в миллисекундах)
   */
  getAge(): number {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('getAge');
    }
    return Date.now() - context.startedAt.getTime();
  }

  /**
   * Добавить метаданные с ограничением размера
   */
  addMetadata(key: string, value: unknown): void {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('addMetadata');
    }
    
    if (!context.metadata) {
      context.metadata = {};
    }
    // Ограничение размера метаданных (по умолчанию 1MB)
    const maxMetadataSize = readInt('REQUEST_CONTEXT_MAX_METADATA_SIZE', 1048576);

    
    // Проверяем размер текущих метаданных
    const currentSize = this.calculateMetadataSize(context.metadata);
    const newEntrySize = this.calculateValueSize(value);
    
    if (currentSize + newEntrySize > maxMetadataSize) {
      throw new RequestContextError(
        `Metadata size limit exceeded. Current: ${currentSize} bytes, ` +
        `New entry: ${newEntrySize} bytes, Limit: ${maxMetadataSize} bytes`,
        'addMetadata'
      );
    }
    
    context.metadata[key] = value;
  }

  /**
   * Вычислить размер метаданных в байтах
   */
  private calculateMetadataSize(metadata: Record<string, unknown>): number {
    return JSON.stringify(metadata).length;
  }

  /**
   * Вычислить размер значения в байтах
   */
  private calculateValueSize(value: unknown): number {
    return JSON.stringify(value).length;
  }
  /**
   * Получить метаданные
   */
  getMetadata(key: string): unknown {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('getMetadata');
    }
    return context.metadata?.[key];
  }

  /**
   * Добавить доменное событие в RCTX-очередь (HTTP-буфер/диагностика) с ограничением размера.
   * Наличие события в очереди само по себе не гарантирует его сохранение без вызова EventStoreService.
   */
  addPendingEvent(event: DomainEvent): void {
    // Валидация структуры DomainEvent
    if (!event || typeof event !== 'object') {
      throw new RequestContextError(
        `Invalid DomainEvent: expected object, got ${typeof event}`,
        'addPendingEvent'
      );
    }
    
    const requiredFields = ['eventId', 'eventType', 'aggregateId', 'timestamp'];
    for (const field of requiredFields) {
      if (!(field in event)) {
        throw new RequestContextError(
          `Invalid DomainEvent: missing required field '${field}'`,
          'addPendingEvent'
        );
      }
    }
    
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('addPendingEvent');
    }
    
    if (!context.metadata) {
      context.metadata = {};
    }
    
    const events = this.getPendingEvents();
    
    // Ограничение размера очереди (по умолчанию 100 событий)
    const maxEvents = readInt('REQUEST_CONTEXT_MAX_EVENTS', 100);
    if (events.length >= maxEvents) {
      throw new RequestContextError(
        `Pending events queue exceeded maximum size (${maxEvents}). ` +
        `This may indicate a memory leak or excessive event generation.`,
        'addPendingEvent'
      );
    }
    
    events.push(event);
  }

  /**
   * Получить текущий RCTX-буфер ожидающих событий для HTTP-флоу и диагностики.
   */
  getPendingEvents(): DomainEvent[] {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('getPendingEvents');
    }
    
    if (!context.metadata) {
      context.metadata = {};
    }
    
    if (!Array.isArray(context.metadata.pending_events)) {
      context.metadata.pending_events = [];
    }
    
    return context.metadata.pending_events as DomainEvent[];
  }

  /**
   * Очистить RCTX-очередь ожидающих событий (в т.ч. из EventStoreMiddleware для избежания утечек).
   */
  clearPendingEvents(): void {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('clearPendingEvents');
    }
    
    if (!context.metadata) {
      context.metadata = {};
    }
    context.metadata.pending_events = [];
  }

  /**
   * Создать дочерний контекст на основе текущего AsyncLocal контекста.
   * Дочерний correlationId детерминированно наследуется от родительского:
   *   parentId.child[.suffix].<timestamp>_<random>
   * Возвращаемый контекст является отсоединённым (ClonedRequestContext) и
   * не меняет глобальный AsyncLocalStorage до явного вызова child.run().
   */
  createChild(childCorrelationId?: CorrelationId): IRequestContext {
    const parentContext = AsyncLocalRequestContext.getCurrent();
    if (!parentContext) {
      throw RequestContextError.notInitialized('createChild');
    }

    const childContext = this.clone();
    const rawChildId =
      childCorrelationId ??
      (RequestContextUtils.createChildCorrelationId(parentContext.correlationId) as CorrelationId);

    childContext.setCorrelationId(BrandedIds.createCorrelationId(rawChildId));

    return childContext;
  }

  /**
   * Клонировать контекст
   */
  /**
   * Клонирует текущий контекст БЕЗ изменения глобального AsyncLocalStorage.
   * Возвращает отсоединенный (detached) IRequestContext, основанный на снимке данных.
   * Для выполнения кода в рамках клона используйте RequestContextUtils.withChildContext()
   * или AsyncLocalRequestContext.runWith().
   */
  clone(): IRequestContext {
    const context = AsyncLocalRequestContext.getCurrent();
    if (!context) {
      throw RequestContextError.notInitialized('clone');
    }

    const clonedData: RequestContextData = {
      ...context,
      startedAt: new Date(),
      metadata: context.metadata ? { ...context.metadata } : undefined,
    };

    return new ClonedRequestContext(clonedData);
  }

  /**
   * Выполнить функцию в новом КОРНЕВОМ RequestContext.
   * Предназначено только для job/worker/CLI-флоу, не связанных с текущим HTTP-запросом.
   * Внутри уже инициализированного контекста выполнение защищено guard'ом
   * RequestContextUtils.assertSafeToCreateRootContext().
   */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    RequestContextUtils.assertSafeToCreateRootContext('RequestContext.run');

    const contextData: RequestContextData = {
      correlationId: BrandedIds.createCorrelationId(),
      requestId: BrandedIds.createRequestId(),
      startedAt: new Date(),
    };
    return AsyncLocalRequestContext.runWith(contextData, fn);
  }

  /**
   * Валидация correlation ID
   */
  private validateCorrelationId(correlationId: string): void {
    if (!correlationId || typeof correlationId !== 'string') {
      throw RequestContextError.invalidCorrelationId(correlationId || 'undefined');
    }
    
    // Простая валидация формата
    if (correlationId.length < 5 || correlationId.length > 255) {
      throw RequestContextError.invalidCorrelationId(correlationId);
    }
    
    // Проверка на запрещенные символы (базовая)
    if (!/^[a-zA-Z0-9._-]+$/.test(correlationId)) {
      throw RequestContextError.invalidCorrelationId(correlationId);
    }
  }
}

/**
 * Отсоединенный (detached) клон контекста запросов.
 * Не использует AsyncLocalStorage и не влияет на глобальный контекст.
 * Подходит для безопасной передачи снимка RequestContext между компонентами
 * без побочных эффектов. Для выполнения кода внутри такого контекста
 * используйте AsyncLocalRequestContext.runWith().
 */
class ClonedRequestContext implements IRequestContext {
  constructor(private data: RequestContextData) {}

  private validateCorrelationId(id: string): void {
    if (!id || typeof id !== 'string') {
      throw RequestContextError.invalidCorrelationId(id || 'undefined');
    }
    if (id.length < 5 || id.length > 255) {
      throw RequestContextError.invalidCorrelationId(id);
    }
    if (!/^[a-zA-Z0-9._-]+$/.test(id)) {
      throw RequestContextError.invalidCorrelationId(id);
    }
  }

  getCorrelationId(): CorrelationId {
    return this.data.correlationId;
  }

  setCorrelationId(id: CorrelationId): void {
    this.validateCorrelationId(id);
    this.data.correlationId = id;
  }

  getUserId(): UserId | undefined {
    return this.data.userId;
  }

  setUserId(userId: UserId): void {
    this.data.userId = userId;
  }

  getSessionId(): SessionId | undefined {
    return this.data.sessionId;
  }

  setSessionId(sessionId: SessionId): void {
    this.data.sessionId = sessionId;
  }

  getTenantId(): TenantId | undefined {
    return this.data.tenantId;
  }

  setTenantId(tenantId: TenantId): void {
    this.data.tenantId = tenantId;
  }

  getRequestId(): RequestId {
    return this.data.requestId;
  }

  getMasSessionId(): MasSessionId | undefined {
    return this.data.masSessionId;
  }

  setMasSessionId(id: MasSessionId): void {
    this.data.masSessionId = id;
  }

  getMasTraceId(): MasTraceId | undefined {
    return this.data.masTraceId;
  }

  setMasTraceId(id: MasTraceId): void {
    this.data.masTraceId = id;
  }

  getContext(): RequestContextData {
    return {
      ...this.data,
      metadata: this.data.metadata ? { ...this.data.metadata } : undefined,
    };
  }

  clear(): void {
    // Отсоединенный снимок: очищаем только изменяемые/чувствительные поля
    this.data.userId = undefined;
    this.data.sessionId = undefined;
    this.data.tenantId = undefined;
    this.data.metadata = undefined;
  }

  isInitialized(): boolean {
    // Снимок всегда валиден как локальный объект
    return true;
  }

  getAge(): number {
    return Date.now() - this.data.startedAt.getTime();
  }

  addMetadata(key: string, value: unknown): void {
    if (!this.data.metadata) this.data.metadata = {};
    this.data.metadata[key] = value;
  }

  getMetadata(key: string): unknown {
    return this.data.metadata?.[key];
  }

  addPendingEvent(event: DomainEvent): void {
    if (!this.data.metadata) {
      this.data.metadata = {};
    }
    
    const events = this.getPendingEvents();
    events.push(event);
    this.data.metadata.pending_events = events;
  }

  getPendingEvents(): DomainEvent[] {
    const events = this.data.metadata?.pending_events;
    if (Array.isArray(events)) {
      return events;
    }
    
    if (!this.data.metadata) {
      this.data.metadata = {};
    }
    this.data.metadata.pending_events = [];
    return [];
  }

  clearPendingEvents(): void {
    if (!this.data.metadata) {
      this.data.metadata = {};
    }
    this.data.metadata.pending_events = [];
  }

  /**
   * Создать дочерний отсоединённый контекст на основе локальных данных.
   * Дочерний correlationId детерминированно наследуется от текущего:
   *   parentId.child[.suffix].<timestamp>_<random>
   */
  createChild(childCorrelationId?: CorrelationId): IRequestContext {
    const rawChildId =
      childCorrelationId ??
      (RequestContextUtils.createChildCorrelationId(this.data.correlationId) as CorrelationId);
    const child: RequestContextData = {
      ...this.data,
      correlationId: BrandedIds.createCorrelationId(rawChildId),
      startedAt: new Date(),
      metadata: this.data.metadata ? { ...this.data.metadata } : undefined,
    };
    return new ClonedRequestContext(child);
  }

  clone(): IRequestContext {
    const cloned: RequestContextData = {
      ...this.data,
      startedAt: new Date(),
      metadata: this.data.metadata ? { ...this.data.metadata } : undefined,
    };
    return new ClonedRequestContext(cloned);
  }

  /**
   * Выполнить функцию в рамках текущего снимка контекста.
   * Не создаёт новый корневой RequestContext и не модифицирует родительский.
   */
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
    return AsyncLocalRequestContext.runWith(this.data, fn);
  }
}

/**
 * Статический экземпляр Request Context
 */
export const RequestContext = new AsyncLocalRequestContext();

/**
 * Упрощённый HTTP-подобный запрос, из которого фабрика строит RequestContext.
 * Используется как мост между Express и Application-слоем без `unknown`-кастов.
 *
 * ВАЖНО: поле headers типизировано через Record<string, unknown>, чтобы оставаться
 * совместимым с различными HTTP-адаптерами. Нормализация до
 * Record<string, string | string[] | undefined> выполняется внутри фабрики.
 */
export interface HttpLikeRequestForContext {
  headers?: Record<string, unknown>;
  ip?: string;
  connection?: { remoteAddress?: string };
  socket?: { remoteAddress?: string };
  method?: string;
  path?: string;
  query?: Record<string, unknown>;
  body?: unknown;
}

/**
 * Фабрика для создания Request Context из HTTP запроса
 */
export class RequestContextFactory {
  /**
   * Создать контекст из HTTP запроса с брендированными типами
   */
  static fromHttpRequest(req: HttpLikeRequestForContext): RequestContextData {
    // Извлечение correlation_id из заголовков
    const correlationId = this.extractCorrelationId(req);
    
    // Извлечение user_id
    const authHeader = this.extractHeader(req, 'authorization');
    /**
     * ВАЖНО:
     * - RequestContextFactory не должен трактовать bearer-токен как userId.
     * - Здесь используем только x-user-id (если явно задан доверенным upstream).
     * - Аутентификация обязана позже вызвать setUserId()/setAuthenticatedUser() с проверенным идентификатором.
     */
    const userId = this.extractHeader(req, 'x-user-id') || undefined;

    // Извлечение session_id
    const sessionId = this.extractHeader(req, 'x-session-id') ||
                     this.extractCookieSession(req) ||
                     undefined;

    // Извлечение tenant_id
    const tenantId = this.extractHeader(req, 'x-tenant-id') ||
                    this.extractHeader(req, 'x-organization-id') ||
                    undefined;

    // Извлечение request_id
    const requestId = this.extractHeader(req, 'x-request-id') ||
                     this.generateRequestId();

    // Извлечение MAS заголовков
    const masSessionId = this.extractHeader(req, 'x-mas-session-id');
    const masTraceId = this.extractHeader(req, 'x-mas-trace-id');

    // Извлечение IP адреса
    const clientIp = this.extractClientIp(req);

    // Извлечение User-Agent
    const userAgent = this.extractHeader(req, 'user-agent') || undefined;

    // Извлечение B3 tracing headers
    const b3TraceId = this.extractHeader(req, 'x-b3-traceid') || undefined;
    const b3SpanId = this.extractHeader(req, 'x-b3-spanid') || undefined;
    const b3ParentSpanId = this.extractHeader(req, 'x-b3-parentspanid') || undefined;

    // Время начала запроса
    const startedAt = new Date();

    return {
      correlationId: BrandedIds.createCorrelationId(correlationId),
      userId: typeof userId === 'string' ? BrandedIds.createUserId(userId) : undefined,
      sessionId: typeof sessionId === 'string' ? BrandedIds.createSessionId(sessionId) : undefined,
      tenantId: typeof tenantId === 'string' ? BrandedIds.createTenantId(tenantId) : undefined,
      requestId: BrandedIds.createRequestId(typeof requestId === 'string' ? requestId : this.generateRequestId()),
      masSessionId: typeof masSessionId === 'string' ? BrandedIds.createMasSessionId(masSessionId) : undefined,
      masTraceId: typeof masTraceId === 'string' ? BrandedIds.createMasTraceId(masTraceId) : undefined,
      clientIp,
      userAgent: typeof userAgent === 'string' ? userAgent : undefined,
      b3TraceId: typeof b3TraceId === 'string' ? b3TraceId : undefined,
      b3SpanId: typeof b3SpanId === 'string' ? b3SpanId : undefined,
      b3ParentSpanId: typeof b3ParentSpanId === 'string' ? b3ParentSpanId : undefined,
      method: req.method,
      path: req.path,
      startedAt,
      metadata: {
        // Сохраняем оригинальные заголовки для трассировки
        headers: this.sanitizeHeaders(req.headers),
        query: req.query,
        body: this.sanitizeBody(req.body)
      }
    };
  }

  /**
   * Создать контекст из отдельных параметров с брендированными типами
   */
  static fromParams(params: {
    correlationId?: string;
    userId?: string;
    sessionId?: string;
    tenantId?: string;
    requestId?: string;
    masSessionId?: string;
    masTraceId?: string;
    clientIp?: string;
    userAgent?: string;
    method?: string;
    path?: string;
    metadata?: Record<string, unknown>;
  }): RequestContextData {
    const startedAt = new Date();
    
    return {
      correlationId: BrandedIds.createCorrelationId(params.correlationId || this.generateCorrelationId()),
      userId: params.userId ? BrandedIds.createUserId(params.userId) : undefined,
      sessionId: params.sessionId ? BrandedIds.createSessionId(params.sessionId) : undefined,
      tenantId: params.tenantId ? BrandedIds.createTenantId(params.tenantId) : undefined,
      requestId: BrandedIds.createRequestId(params.requestId || this.generateRequestId()),
      masSessionId: params.masSessionId ? BrandedIds.createMasSessionId(params.masSessionId) : undefined,
      masTraceId: params.masTraceId ? BrandedIds.createMasTraceId(params.masTraceId) : undefined,
      clientIp: params.clientIp,
      userAgent: params.userAgent,
      method: params.method,
      path: params.path,
      startedAt,
      metadata: params.metadata
    };
  }

  /**
   * Нормализовать headers до формы, совместимой с CorrelationIdProvider.
   * Отбрасывает все значения, не являющиеся строками или массивами строк.
   */
  private static normalizeHeadersForCorrelation(
    headers: Record<string, unknown> | undefined,
  ): Record<string, string | string[] | undefined> {
    if (!headers || typeof headers !== 'object') {
      return {};
    }

    const normalized: Record<string, string | string[] | undefined> = {};

    for (const [key, value] of Object.entries(headers)) {
      if (typeof value === 'string') {
        normalized[key] = value;
      } else if (Array.isArray(value)) {
        const stringItems = value.filter((item): item is string => typeof item === 'string');
        if (stringItems.length > 0) {
          normalized[key] = stringItems;
        }
      }
    }

    return normalized;
  }

  /**
   * Извлечь correlation_id из HTTP заголовков
   * Использует единый провайдер с приоритетами и валидацией
   */
  private static extractCorrelationId(req: Pick<HttpLikeRequestForContext, 'headers'>): CorrelationId {
    const headers = this.normalizeHeadersForCorrelation(req.headers);
    return CorrelationIdProvider.getPreferred(headers) as CorrelationId;
  }

  /**
   * Извлечь заголовок из запроса
   */
  private static extractHeader(
    req: Pick<HttpLikeRequestForContext, 'headers'>,
    name: string,
  ): string | string[] | undefined {
    const headers = req.headers || {};
    const headerValue = headers[name.toLowerCase()] ?? headers[name];

    // Возвращаем строку или первый элемент строкового массива для безопасного использования
    if (Array.isArray(headerValue)) {
      const stringItems = headerValue.filter(
        (item): item is string => typeof item === 'string',
      );
      return stringItems.length > 0 ? stringItems[0] : undefined;
    }

    if (typeof headerValue === 'string') {
      return headerValue;
    }

    return undefined;
  }

  /**
   * Извлечь session ID из cookie
   */
  private static extractCookieSession(req: Pick<HttpLikeRequestForContext, 'headers'>): string | undefined {
    const cookieHeader = this.extractHeader(req, 'cookie');
    if (typeof cookieHeader === 'string') {
      const match = cookieHeader.match(/session_id=([^;]+)/);
      return match ? match[1] : undefined;
    }
    return undefined;
  }

  /**
   * Извлечь IP адрес клиента
   */
  private static extractClientIp(req: HttpLikeRequestForContext): string | undefined {
    return req.ip ||
           req.connection?.remoteAddress ||
           req.socket?.remoteAddress ||
           (typeof req.headers?.['x-forwarded-for'] === 'string' ? req.headers['x-forwarded-for'].split(',')[0] : undefined) ||
           (typeof req.headers?.['x-real-ip'] === 'string' ? req.headers['x-real-ip'] : undefined);
  }

  /**
   * Санитизировать заголовки (убрать чувствительные данные)
   */
  private static sanitizeHeaders(headers: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!headers || typeof headers !== 'object') return {};

    const sanitized: Record<string, unknown> = {};

    // Список чувствительных заголовков
    const sensitiveHeaders = [
      'authorization', 'cookie', 'set-cookie', 'x-api-key',
      'x-auth-token', 'x-access-token'
    ];

    for (const [key, value] of Object.entries(headers)) {
      if (sensitiveHeaders.includes(key.toLowerCase())) {
        sanitized[key] = '[REDACTED]';
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  /**
   * Санитизировать тело запроса
   */
  private static sanitizeBody(body: unknown): unknown {
    if (!body || typeof body !== 'object') return body;
    
    // Простое санитизирование - в продакшене может потребоваться более сложная логика
    const sanitized = { ...body } as Record<string, unknown>;
    
    // Маскируем пароли и токены
    const sensitiveFields = ['password', 'token', 'secret', 'key'];
    for (const field of sensitiveFields) {
      if (sanitized[field]) {
        sanitized[field] = '[REDACTED]';
      }
    }
    
    return sanitized;
  }

  /**
   * Генерировать correlation ID
   */
  private static generateCorrelationId(): CorrelationId {
    return CorrelationIdProvider.generate('corr') as CorrelationId;
  }

  /**
   * Генерировать request ID
   */
  private static generateRequestId(): RequestId {
    const timestamp = Date.now();
    const random = IdGenerator.generateRandomString(6);
    return BrandedIds.createRequestId(`req_${timestamp}_${random}`);
  }
}

/**
 * Middleware для автоматической установки контекста
 */
export class RequestContextMiddleware {
  /**
   * Express middleware для установки Request Context с правильной изоляцией
   * и автоматической очисткой после обработки запроса.
   */
  static express() {
    return (req: Request, res: Response, next: NextFunction) => {
      try {
        // Create context from HTTP request
        const contextData = RequestContextFactory.fromHttpRequest(req);
        
        // Validate no existing context (prevents pollution)
        if (AsyncLocalRequestContext.isInContext()) {
          const existing = AsyncLocalRequestContext.getCurrent();
          const existingCorrelationId = String(existing?.correlationId ?? 'unknown');
          const newCorrelationId = String(contextData.correlationId);
          console.warn(
            `[RCTX-LEAK] Existing context detected during request initialization: ` +
            `existing_corr=${existingCorrelationId}, new_corr=${newCorrelationId}`
          );
          // Clear existing context before proceeding
          AsyncLocalRequestContext.clear();
        }

        // Execute request handling within isolated context
        void AsyncLocalRequestContext.runWith(contextData, async () => {
          // A-019 FIX: Ensure scoped DI instances are cleaned up after request
          const { container } = require('../../core/di/container');
          
          const cleanup = () => {
            container.disposeScope(contextData.requestId);
          };

          res.on('finish', cleanup);
          res.on('close', cleanup);

          try {
            // Set response headers
            res.setHeader('x-correlation-id', contextData.correlationId);
            res.setHeader('x-request-id', contextData.requestId);
            res.setHeader('X-Trace-Id', contextData.correlationId);
            
            if (contextData.masSessionId) {
              res.setHeader('x-mas-session-id', contextData.masSessionId);
            }
            if (contextData.masTraceId) {
              res.setHeader('x-mas-trace-id', contextData.masTraceId);
            }

            // Continue to next middleware
            next();
          } catch (error) {
            next(error as Error);
          }
        });
      } catch (error) {
        next(error as Error);
      }
    };
  }

  /**
   * Установить контекст программно (например, для background jobs) с валидацией
   * и защитой от повторной инициализации.
   *
   * A-019 FIX: This method now uses runWith() instead of setCurrent() to prevent
   * context bleeding. Returns a Promise that must be awaited.
   *
   * MIGRATION: This method is now async. Callers must await it:
   *   // OLD:
   *   RequestContextMiddleware.initialize(context);
   *   await doWork();
   *
   *   // NEW:
   *   await RequestContextMiddleware.initialize(context, async () => {
   *     await doWork();
   *   });
   */
  static async initialize<T>(
    contextData: RequestContextData,
    fn?: () => Promise<T> | T
  ): Promise<T | void> {
    // Guard: prevent double initialization
    if (AsyncLocalRequestContext.isInContext()) {
      const current = AsyncLocalRequestContext.getCurrent();
      const currentCorrelationId = String(current?.correlationId ?? 'unknown');
      throw new RequestContextError(
        `Cannot initialize context: context already exists ` +
        `(correlationId=${currentCorrelationId}). ` +
        `Use runWith() for nested contexts.`,
        'initialize'
      );
    }
    
    // Явная валидация входных данных
    if (!contextData || typeof contextData !== 'object') {
      throw new Error('Invalid context data: expected object, got ' + typeof contextData);
    }
    
    if (!contextData.correlationId || typeof contextData.correlationId !== 'string') {
      throw new Error('Invalid correlationId: expected non-empty string');
    }
    
    if (!contextData.requestId || typeof contextData.requestId !== 'string') {
      throw new Error('Invalid requestId: expected non-empty string');
    }
    
    if (!contextData.startedAt || !(contextData.startedAt instanceof Date)) {
      throw new Error('Invalid startedAt: expected Date object');
    }

    // Validate context age
    AsyncLocalRequestContext.validateContextNotStale(contextData);

    // A-019 FIX: Use runWith() instead of deprecated setCurrent()
    if (fn) {
      return await AsyncLocalRequestContext.runWith(contextData, fn);
    } else {
      // Legacy: if no function provided, we can't safely set context
      // This path should be removed in future versions
      throw new RequestContextError(
        'initialize() now requires a function argument. ' +
        'Use: await RequestContextMiddleware.initialize(context, async () => { ... })',
        'initialize_requires_fn'
      );
    }
  }

  /**
   * Очистить контекст
   */
  static cleanup(): void {
    AsyncLocalRequestContext.clear();
  }
}

/**
 * Утилиты для работы с Request Context
 */
export class RequestContextUtils {
  /**
   * Валидировать correlation ID (без побочных эффектов)
   */
  static isValidCorrelationId(id: string): boolean {
    if (!id || typeof id !== 'string') return false;
    if (id.length < 5 || id.length > 255) return false;
    return /^[a-zA-Z0-9._-]+$/.test(id);
  }

  /**
   * Создать child correlation ID
   */
  static createChildCorrelationId(parentId: string, suffix?: string): string {
    const timestamp = Date.now();
    const random = IdGenerator.generateRandomString(6);
    const suffixPart = suffix ? `.${suffix}` : '';
    return `${parentId}.child${suffixPart}.${timestamp}_${random}`;
  }

  /**
   * Извлечь parent correlation ID из child ID
   */
  static extractParentCorrelationId(childId: string): string | null {
    const match = childId.match(/^(.+)\.child/);
    return match ? match[1] : null;
  }

  /**
   * Выполнить функцию в изолированном дочернем контексте
   * с проверкой на stale parent context.
   */
  static async withChildContext<T>(fn: () => Promise<T> | T, childCorrelationId?: string): Promise<T> {
    const parent = AsyncLocalRequestContext.getCurrent();
    if (!parent) {
      throw RequestContextError.notInitialized('withChildContext');
    }
    
    // Validate parent context is not stale before creating child
    AsyncLocalRequestContext.validateContextNotStale(parent);
    
    const childCtx: RequestContextData = {
      ...parent,
      correlationId: BrandedIds.createCorrelationId(
        childCorrelationId ?? this.createChildCorrelationId(parent.correlationId)
      ),
      startedAt: new Date(),
      metadata: parent.metadata ? { ...parent.metadata } : undefined,
    };
    return await AsyncLocalRequestContext.runWith(childCtx, fn);
  }

  /**
   * Guard против создания нового корневого RequestContext внутри уже
   * инициализированного контекста (HTTP-цепочки).
   * В проде логирует предупреждение, в строгом режиме (REQUEST_CONTEXT_STRICT_ROOT_CREATION)
   * выбрасывает RequestContextError.
   */
  static assertSafeToCreateRootContext(locationHint: string): void {
    const current = AsyncLocalRequestContext.getCurrent();
    if (!current) {
      return;
    }

    const message =
      `[RCTX-ASYNC] Attempt to create new root RequestContext inside existing context ` +
      `(correlationId=${current.correlationId}, location=${locationHint})`;

    try {
      const violationMarker = {
        location: locationHint,
        at: new Date().toISOString(),
      };
      if (!current.metadata) {
        current.metadata = {};
      }
      current.metadata.rctx_root_context_violation = violationMarker;
    } catch {
      // ignore instrumentation errors
    }

    
        const strictRaw = readStr('REQUEST_CONTEXT_STRICT_ROOT_CREATION', '');
        const strictFlag = strictRaw ? strictRaw.toLowerCase() : '';
        const shouldThrow = strictFlag === '1' || strictFlag === 'true';
    if (shouldThrow) {
      throw new RequestContextError(message, 'assertSafeToCreateRootContext');
    }

    // Логирование нарушения корневого контекста ограничено установкой маркера
    // в RequestContext.metadata; дополнительный вывод в stdout отключён для
    // соблюдения инвариантов структурированного логирования.
  }

  /**
   * Форматировать контекст для логирования
   */
  static formatForLogging(context: RequestContextData): Record<string, unknown> {
    return {
      correlation_id: context.correlationId,
      request_id: context.requestId,
      mas_session_id: context.masSessionId,
      mas_trace_id: context.masTraceId,
      user_id: context.userId,
      session_id: context.sessionId,
      tenant_id: context.tenantId,
      method: context.method,
      path: context.path,
      client_ip: context.clientIp,
      user_agent: context.userAgent,
      request_age_ms: Date.now() - context.startedAt.getTime()
    };
  }

  /**
   * Проверить, нужно ли propagation context
   */
  static shouldPropagateContext(operation: string): boolean {
    // Определяем операции, которые требуют propagation context
    const propagatedOperations = [
      'database_query',
      'external_api_call',
      'message_publish',
      'event_publish',
      'cache_operation',
      'file_operation'
    ];

    return propagatedOperations.includes(operation);
  }
}

// Экспорт по умолчанию
export default RequestContext;
