/**
 * MAS Background Context - Factory for autonomous execution context.
 *
 * Layer: Application (agents/context).
 *
 * Responsibility:
 * Reconstruct a valid IRequestContext from a MasSessionContext specifically
 * for use in background execution loops (TaskOrchestrator resumption).
 *
 * Features:
 * - Preserves TenantId (critical for multi-tenancy).
 * - Preserves CorrelationId/MasSessionId/MasTraceId for observability.
 * - Handles "System Impersonation" when original UserId is missing or
 *   when operating in a purely system-driven mode.
 */

import type { MasSessionContext } from '../types/mas-types';
import type { 
  IRequestContext,
  RequestContextData,
  CorrelationId,
  UserId,
  SessionId,
  TenantId,
  RequestId,
  MasSessionId,
  MasTraceId
} from '../../context/request-context';
import type { DomainEvent } from '../../../domain/events/event-store.interface';
import {
  BrandedIds,
} from '../../context/request-context';
import {
  setMasSessionId,
  setMasTraceId,
} from './mas-request-context';

/**
 * A standalone implementation of IRequestContext that holds state in memory.
 * Useful for background workers where AsyncLocalStorage might not be initialized
 * or when we need to pass a rehydrated context explicitely.
 */
class DetachedRequestContext implements IRequestContext {
  private data: RequestContextData;

  constructor(data: Partial<RequestContextData> = {}) {
     this.data = {
         correlationId: data.correlationId ?? BrandedIds.createCorrelationId(),
         requestId: data.requestId ?? BrandedIds.createRequestId(),
         startedAt: data.startedAt ?? new Date(),
         ...data
     };
  }

  getCorrelationId(): CorrelationId { return this.data.correlationId; }
  setCorrelationId(id: CorrelationId): void { this.data.correlationId = id; }

  getUserId(): UserId | undefined { return this.data.userId; }
  setUserId(id: UserId): void { this.data.userId = id; }

  getSessionId(): SessionId | undefined { return this.data.sessionId; }
  setSessionId(id: SessionId): void { this.data.sessionId = id; }

  getTenantId(): TenantId | undefined { return this.data.tenantId; }
  setTenantId(id: TenantId): void { this.data.tenantId = id; }

  getRequestId(): RequestId { return this.data.requestId; }
  
  getMasSessionId(): MasSessionId | undefined { return this.data.masSessionId; }
  setMasSessionId(id: MasSessionId): void { this.data.masSessionId = id; }

  getMasTraceId(): MasTraceId | undefined { return this.data.masTraceId; }
  setMasTraceId(id: MasTraceId): void { this.data.masTraceId = id; }

  getContext(): RequestContextData { return { ...this.data }; }
  
  clear(): void { 
      this.data.userId = undefined;
      this.data.sessionId = undefined;
      this.data.tenantId = undefined;
      this.data.metadata = undefined;
  }
  
  isInitialized(): boolean { return true; }
  getAge(): number { return Date.now() - this.data.startedAt.getTime(); }

  addMetadata(key: string, value: unknown): void {
      if (!this.data.metadata) this.data.metadata = {};
      this.data.metadata[key] = value;
  }
  getMetadata(key: string): unknown { return this.data.metadata?.[key]; }

  addPendingEvent(event: DomainEvent): void {
      if (!this.data.metadata) this.data.metadata = {};
      const events = this.data.metadata.pending_events as DomainEvent[] || [];
      events.push(event);
      this.data.metadata.pending_events = events;
  }
  getPendingEvents(): DomainEvent[] {
      return (this.data.metadata?.pending_events as DomainEvent[]) || [];
  }
  clearPendingEvents(): void {
      if (this.data.metadata) this.data.metadata.pending_events = [];
  }

  createChild(childCorrelationId?: CorrelationId): IRequestContext {
      // Minimal implementation for background tasks
      return new DetachedRequestContext({
          ...this.data,
          correlationId: childCorrelationId ?? BrandedIds.createCorrelationId()
      });
  }
  clone(): IRequestContext {
      return new DetachedRequestContext({ ...this.data });
  }
  async run<T>(fn: () => Promise<T> | T): Promise<T> {
      // In a detached context, 'run' just executes the function.
      // We assume the caller handles async context propagation if they need it.
      return fn();
  }
}

export function createBackgroundRequestContext(
  session: MasSessionContext,
): IRequestContext {
  const ctx = new DetachedRequestContext();

  // 1. Restore critical tracing identifiers
  if (session.correlationId) ctx.setCorrelationId(session.correlationId);
  if (session.masSessionId) setMasSessionId(ctx, session.masSessionId);
  if (session.masTraceId) setMasTraceId(ctx, session.masTraceId);

  // 2. Restore Multi-Tenancy context
  if (session.tenantId) {
    ctx.setTenantId(session.tenantId);
  } else {
    try {
        ctx.setTenantId(BrandedIds.createTenantId('default'));
    } catch {
        // ignore
    }
  }

  // 3. Restore Principal (User Identity)
  if (session.userId) {
    ctx.setUserId(session.userId);
  } else {
    const systemUserId = BrandedIds.createUserId('system_background_worker');
    ctx.setUserId(systemUserId);
  }

  // 4. Copy Metadata
  ctx.addMetadata('is_background_execution', true);
  ctx.addMetadata('mas_restored_from_session', true);

  if (session.metadata?.debug_flags) {
     ctx.addMetadata('debug_flags', session.metadata.debug_flags);
  }

  return ctx;
}
