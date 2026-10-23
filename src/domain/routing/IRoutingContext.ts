/**
 * IRoutingContext - Domain layer interface for routing context.
 *
 * Layer: Domain (enterprise business rules)
 *
 * Minimal context interface required for agent routing decisions.
 * This interface is intentionally small to avoid coupling with Application layer.
 */

/**
 * Branded types for type safety
 */
import { randomUUID } from 'crypto';

/**
 * Branded types for type safety
 * Note: Must match definition in core/context/IRequestContext.ts to be compatible
 */
export type CorrelationId = string & { readonly __brand: 'CorrelationId' };

export namespace CorrelationId {
  export const create = (): CorrelationId => randomUUID() as CorrelationId;
  
  export const parse = (id: string): CorrelationId => {
    // Basic validation
    if (!id || typeof id !== 'string') {
        throw new Error('Invalid CorrelationId');
    }
    return id as CorrelationId;
  };

  export const isValid = (id: unknown): boolean => {
      return typeof id === 'string' && id.length > 0;
  };
}

export type MasSessionId = string & { readonly __brand: 'MasSessionId' };
export type MasTraceId = string & { readonly __brand: 'MasTraceId' };

/**
 * Domain-level routing context interface.
 * Provides minimal context needed for agent routing without
 * depending on Application-layer IRequestContext.
 */
export interface IRoutingContext {
  /** Correlation ID for tracing */
  getCorrelationId(): CorrelationId;

  /** MAS session ID if applicable */
  getMasSessionId(): MasSessionId | undefined;

  /** MAS trace ID if applicable */
  getMasTraceId(): MasTraceId | undefined;

  /** Set MAS session ID */
  setMasSessionId(id: MasSessionId): void;

  /** Set MAS trace ID */
  setMasTraceId(id: MasTraceId): void;
}
