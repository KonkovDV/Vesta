/**
 * Barrel re-export for branded types.
 * Canonical source: src/core/context/IRequestContext.ts
 *
 * This file exists so that modules can import from '@/core/types/branded'
 * as a convenience alias. The SSOT remains IRequestContext.ts.
 */
export type {
  UserId,
  SessionId,
  TenantId,
  CorrelationId,
  RequestId,
  MasSessionId,
  MasTraceId,
} from '../context/IRequestContext';
