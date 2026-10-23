/**
 * IRequestContext - Core Interface and Types
 * Layer: Core
 *
 * Provides the fundamental contract for Request Context propagation across the system.
 * Includes Branded IDs for strict type safety and the primary IRequestContext interface.
 */

import { randomUUID } from 'node:crypto';
import type { DomainEvent } from '../../domain/events/event-store.interface';

/**
 * Branded Types for Type Safety
 */
export type UserId = string & { readonly __brand: 'UserId' };
export type SessionId = string & { readonly __brand: 'SessionId' };
export type TenantId = string & { readonly __brand: 'TenantId' };
export type CorrelationId = string & { readonly __brand: 'CorrelationId' };
export type RequestId = string & { readonly __brand: 'RequestId' };
export type MasSessionId = string & { readonly __brand: 'MasSessionId' };
export type MasTraceId = string & { readonly __brand: 'MasTraceId' };

/**
 * Factory for creating Branded IDs
 */
export class BrandedIds {
  static createUserId(id: string): UserId {
    if (!id || typeof id !== 'string') {
      throw new Error('Invalid UserId: must be a non-empty string');
    }
    return id as UserId;
  }

  static createSessionId(id?: string): SessionId {
    const sessionId = id || this.generateUuid();
    return sessionId as SessionId;
  }

  static createTenantId(id: string): TenantId {
    if (!id || typeof id !== 'string') {
      throw new Error('Invalid TenantId: must be a non-empty string');
    }
    return id as TenantId;
  }

  static createCorrelationId(id?: string): CorrelationId {
    const correlationId = id || this.generateUuid();
    return correlationId as CorrelationId;
  }

  static createRequestId(id?: string): RequestId {
    const requestId = id || this.generateUuid();
    return requestId as RequestId;
  }

  static createMasSessionId(id?: string): MasSessionId {
    const masSessionId = id || `mas_${this.generateUuid()}`;
    return masSessionId as MasSessionId;
  }

  static createMasTraceId(id?: string): MasTraceId {
    const masTraceId = id || `mas_trace_${this.generateUuid()}`;
    return masTraceId as MasTraceId;
  }

  private static generateUuid(): string {
    return randomUUID();
  }
}

/**
 * Structure of Request Context Data
 */
export interface RequestContextData {
    /** Correlation ID for tracing operation chains */
    correlationId: CorrelationId;
    /** User ID */
    userId?: UserId;
    /** Session ID */
    sessionId?: SessionId;
    /** Tenant ID (for multi-tenancy) */
    tenantId?: TenantId;
    /** Request ID (unique for each HTTP request) */
    requestId: RequestId;
    /** MAS Session ID (if applicable) */
    masSessionId?: MasSessionId;
    /** MAS Trace ID (if applicable) */
    masTraceId?: MasTraceId;
    /** Client IP Address */
    clientIp?: string;
    /** User-Agent */
    userAgent?: string;
    /** B3 Trace ID (distributed tracing) */
    b3TraceId?: string;
    /** B3 Span ID (distributed tracing) */
    b3SpanId?: string;
    /** B3 Parent Span ID (distributed tracing) */
    b3ParentSpanId?: string;
    /** HTTP Method */
    method?: string;
    /** HTTP Path */
    path?: string;
    /** Request start time */
    startedAt: Date;
    /** Additional metadata */
    metadata?: Record<string, unknown>;
}

/**
 * Interface for Request Context Access
 */
export interface IRequestContext {
    /** Get correlation ID */
    getCorrelationId(): CorrelationId;

    /** Set correlation ID */
    setCorrelationId(id: CorrelationId): void;

    /** Get user ID */
    getUserId(): UserId | undefined;

    /** Set user ID */
    setUserId(userId: UserId): void;

    /** Get session ID */
    getSessionId(): SessionId | undefined;

    /** Set session ID */
    setSessionId(sessionId: SessionId): void;

    /** Get tenant ID */
    getTenantId(): TenantId | undefined;

    /** Set tenant ID */
    setTenantId(tenantId: TenantId): void;

    /** Get request ID */
    getRequestId(): RequestId;

    /** Get MAS session ID */
    getMasSessionId(): MasSessionId | undefined;

    /** Set MAS session ID */
    setMasSessionId(id: MasSessionId): void;

    /** Get MAS trace ID */
    getMasTraceId(): MasTraceId | undefined;

    /** Set MAS trace ID */
    setMasTraceId(id: MasTraceId): void;

    /** Get all context data */
    getContext(): RequestContextData;

    /** Clear context */
    clear(): void;

    /** Check if context is initialized */
    isInitialized(): boolean;

    /** Get context age (in milliseconds) */
    getAge(): number;

    /** Add metadata */
    addMetadata(key: string, value: unknown): void;

    /** Get metadata */
    getMetadata(key: string): unknown;

    /** Add domain event to pending queue */
    addPendingEvent(event: DomainEvent): void;

    /** Get all pending events */
    getPendingEvents(): DomainEvent[];

    /** Clear pending events queue */
    clearPendingEvents(): void;

    /** Create child context */
    createChild(childCorrelationId?: CorrelationId): IRequestContext;

    /** Clone context */
    clone(): IRequestContext;

    /** Run function in new context */
    run<T>(fn: () => Promise<T> | T): Promise<T>;
}

/**
 * Request Context Error
 */
export class RequestContextError extends Error {
    constructor(message: string, public readonly operation?: string) {
        super(message);
        this.name = 'RequestContextError';
    }

    static notInitialized(operation?: string): RequestContextError {
        return new RequestContextError('Request context is not initialized', operation);
    }

    static alreadyInitialized(operation?: string): RequestContextError {
        return new RequestContextError('Request context is already initialized', operation);
    }

    static invalidCorrelationId(correlationId: string): RequestContextError {
        return new RequestContextError(`Invalid correlation ID format: ${correlationId}`);
    }
}
