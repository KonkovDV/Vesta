/**
 * Redis Session Counter Implementation.
 *
 * Layer: Infrastructure
 */

import type { Redis } from 'ioredis';
import type { ISessionCounter } from '../../domain/memory/governance/session-counter';
import type { TenantId } from '../../domain/memory/session-types';
import { logger } from '../logging/logger';

const log = logger.child({ component: 'RedisSessionCounter' });

export class RedisSessionCounter implements ISessionCounter {
  private readonly prefix = 'memory:governance:active_sessions:';

  constructor(private readonly redis: Redis) {}

  async increment(tenantId: TenantId): Promise<number> {
    const key = this.getKey(tenantId);
    try {
      return await this.redis.incr(key);
    } catch (error) {
      log.error('Failed to increment session count', { tenantId, error });
      return 0; // Fail-safe
    }
  }

  async decrement(tenantId: TenantId): Promise<number> {
    const key = this.getKey(tenantId);
    try {
      const val = await this.redis.decr(key);
      return Math.max(0, val);
    } catch (error) {
      log.error('Failed to decrement session count', { tenantId, error });
      return 0;
    }
  }

  async getCount(tenantId: TenantId): Promise<number> {
    const key = this.getKey(tenantId);
    try {
      const val = await this.redis.get(key);
      return val ? parseInt(val, 10) : 0;
    } catch (error) {
      log.error('Failed to get session count', { tenantId, error });
      return 0;
    }
  }

  private getKey(tenantId: TenantId): string {
    return `${this.prefix}${tenantId}`;
  }
}
