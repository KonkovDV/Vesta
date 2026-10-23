/**
 * Redis Connectivity Check
 * Validates Redis connection and basic operations
 */

import { BaseIntegrityCheck, CheckResult } from '../system-integrity-checker';
import { container } from '../../di/container';
import { getRawEnv } from '../../../config';

interface RedisClient {
  ping?(): Promise<string>;
  isReady?: boolean;
  isOpen?: boolean;
  get?(key: string): Promise<string | null>;
  set?(key: string, value: string, options?: { EX?: number }): Promise<string | null>;
}

export class RedisCheck extends BaseIntegrityCheck {
  readonly name = 'redis';
  readonly description = 'Validates Redis connectivity';
  readonly priority = 15;
  readonly severity = 'warning'; // Warning because app can work without Redis
  readonly timeoutMs = 3000;

  async check(): Promise<CheckResult> {
    const errors: string[] = [];
    let connectionStatus = 'unknown';
    let latencyMs: number | undefined;

     // Check if Redis is configured
    if (!getRawEnv().REDIS_URL && !getRawEnv().REDIS_HOST) {
      return this.pass('Redis not configured (REDIS_URL or REDIS_HOST not set)', {
        status: 'skipped',
        reason: 'Redis not configured',
      });
    }

    try {
      // Check if Redis is registered in DI container
      if (!container.isRegistered('RedisClient')) {
        // In Phase 0 (Pre-Bootstrap), DI is not ready yet.
        // We validate that config is present (checked above), but skip connectivity check.
        return this.pass('Redis config present (connectivity check deferred until DI bootstrap)', {
            status: 'deferred',
            reason: 'DI container not yet populated',
        });
      }

      const redis = container.resolve<RedisClient>('RedisClient');

      // Test connectivity with timing
      const startTime = Date.now();

      if (typeof redis.ping === 'function') {
        const pong = await redis.ping();
        latencyMs = Date.now() - startTime;
        if (pong === 'PONG') {
          connectionStatus = 'connected';
        } else {
          connectionStatus = 'unexpected-response';
          errors.push(`Redis ping returned unexpected response: ${pong}`);
        }
      } else if (redis.isReady !== undefined) {
        latencyMs = Date.now() - startTime;
        if (redis.isReady) {
          connectionStatus = 'ready';
        } else {
          connectionStatus = 'not-ready';
          errors.push('Redis client is not ready');
        }
      } else if (typeof redis.get === 'function') {
        await redis.get('__health_check__');
        latencyMs = Date.now() - startTime;
        connectionStatus = 'connected';
      } else {
        errors.push('Redis client has no recognized test method (ping, isReady, or get)');
      }
    } catch (error) {
      connectionStatus = 'error';
      const errorMessage = error instanceof Error ? error.message : String(error);
      errors.push(`Redis connection error: ${errorMessage}`);
    }

    if (errors.length > 0) {
      return this.fail(`Redis connectivity check failed: ${errors.join(', ')}`, {
        status: connectionStatus,
        errors,
      });
    }

    return this.pass('Redis connectivity verified', {
      status: connectionStatus,
      latencyMs,
    });
  }
}
