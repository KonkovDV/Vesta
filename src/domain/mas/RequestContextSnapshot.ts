/**
 * RequestContextSnapshot - Domain type for request context snapshots in durable execution.
 *
 * Layer: Domain (enterprise business rules)
 */

export interface RequestContextSnapshot {
  correlationId: string;
  tenantId?: string;
  userId?: string;
  masSessionId: string;
  masTraceId?: string;
  meta?: Record<string, unknown>;
}
