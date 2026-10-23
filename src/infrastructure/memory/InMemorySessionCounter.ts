/**
 * In-memory Session Counter Implementation.
 *
 * Layer: Infrastructure
 *
 * Fallback implementation for development or when Redis is unavailable.
 * Matches the behavior of the previous internal map in GovernedSessionMemoryManager.
 */

import type { ISessionCounter } from '../../domain/memory/governance/session-counter';
import type { TenantId } from '../../domain/memory/session-types';

export class InMemorySessionCounter implements ISessionCounter {
  private readonly counts = new Map<TenantId, number>();

  async increment(tenantId: TenantId): Promise<number> {
    const current = this.counts.get(tenantId) ?? 0;
    const next = current + 1;
    this.counts.set(tenantId, next);
    return next;
  }

  async decrement(tenantId: TenantId): Promise<number> {
    const current = this.counts.get(tenantId) ?? 0;
    const next = Math.max(0, current - 1);
    this.counts.set(tenantId, next);
    return next;
  }

  async getCount(tenantId: TenantId): Promise<number> {
    return this.counts.get(tenantId) ?? 0;
  }
}
