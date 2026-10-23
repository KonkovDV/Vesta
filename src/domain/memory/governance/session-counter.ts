/**
 * Session Counter Port.
 *
 * Layer: Domain
 *
 * Abstract interface for tracking active session counts per tenant.
 * Implementations can be in-memory (MVP) or Redis-based (Production).
 */

import type { TenantId } from '../session-types';

export interface ISessionCounter {
  /**
   * Increment active session count for a tenant.
   * @returns New count
   */
  increment(tenantId: TenantId): Promise<number>;

  /**
   * Decrement active session count for a tenant.
   * @returns New count
   */
  decrement(tenantId: TenantId): Promise<number>;

  /**
   * Get current active session count for a tenant.
   */
  getCount(tenantId: TenantId): Promise<number>;
}

/**
 * DI Token for ISessionCounter
 */
export const SESSION_COUNTER_TOKEN = 'ISessionCounter' as const;
