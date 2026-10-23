/**
 * Redis-backed implementation of IMasSessionStore for MAS session state.
 *
 * Layer: Infrastructure (MAS).
 *
 * MVP scope (T004):
 * - JSON-serializable MasSessionState stored under mas:session:{masSessionId};
 * - best-effort dual-write target for MAS runtime (in-memory + Redis);
 * - no optimistic locking / advanced TTL policies yet.
 */

import type { IMasSessionStore, MasSessionState } from '../../domain/mas/mas-session-store';
import type { MasSessionId } from '../../domain/mas/mas-types';
import type { ICache } from '../../domain/cache/ICache';
import { getOrCreateCounter, getOrCreateHistogram } from '../../monitoring';
import { incrementMasMemoryErrorsTotal } from '../../monitoring/mas-metrics';
import type { IStructuredLogger } from '../../core/logging/IStructuredLogger';

type Operation = 'get' | 'save' | 'delete';
type Outcome = 'success' | 'error';

const SESSION_TTL_SECONDS = 30 * 60; // 30 minutes; TTL policy may be refined in follow-up T004 tasks.

const masSessionStoreOperationsTotal = getOrCreateCounter(
  'mas_session_store_operations_total',
  'Total MAS session store operations by operation and outcome',
  ['operation', 'outcome'],
);

const masSessionStoreOperationDurationSeconds = getOrCreateHistogram(
  'mas_session_store_operation_duration_seconds',
  'Duration of MAS session store operations in seconds',
  ['operation', 'outcome'],
);

const masSessionStoreErrorsTotal = getOrCreateCounter(
  'mas_session_store_errors_total',
  'Total MAS session store errors by operation',
  ['operation'],
);

export class RedisMasSessionStore implements IMasSessionStore {
  private readonly MAX_RETRIES = 3;
  private readonly RETRY_DELAY_MS = 10;

  constructor(
    private readonly cache: ICache,
    private readonly ttlSeconds: number = SESSION_TTL_SECONDS,
    private readonly logger?: IStructuredLogger,
  ) {}

  private buildKey(sessionId: MasSessionId): string {
    return `mas:session:${String(sessionId)}`;
  }

  /**
   * A-009 FIX: Atomic check-and-set using optimistic locking pattern.
   * Uses Lua script to perform version check and update atomically.
   * Prevents Lost Update race condition in GET -> Modify -> SET pattern.
   */
  private buildSaveScript(): string {
    // Lua script for atomic check-and-set with version validation
    // KEYS[1] = session key
    // ARGV[1] = expected version (for optimistic locking, -1 means new)
    // ARGV[2] = new serialized state
    // ARGV[3] = TTL in seconds
    return `
      local key = KEYS[1]
      local expectedVersion = tonumber(ARGV[1])
      local newState = ARGV[2]
      local ttl = tonumber(ARGV[3])
      local sessionId = ARGV[4]
      local status = ARGV[5]
      local score = tonumber(ARGV[6])

      local current = redis.call('GET', key)

      if current == false then
        -- Key doesn't exist, check if we're expecting a new entry
        if expectedVersion == -1 or expectedVersion == 0 then
          redis.call('SETEX', key, ttl, newState)
          
          -- Maintain runnable index
          if status == 'active' or status == 'pending' or status == 'in_progress' then
            redis.call('ZADD', 'mas:sessions:runnable_z', score, sessionId)
          else
             redis.call('ZREM', 'mas:sessions:runnable_z', sessionId)
          end
          
          return {1, 0}  -- success, previous version was 0
        else
          return {-1, 0}  -- concurrency conflict: expected existing but not found
        end
      end

      local currentData = cjson.decode(current)
      local currentVersion = tonumber(currentData.version) or 0

      if expectedVersion ~= -1 and currentVersion ~= expectedVersion then
        return {-1, currentVersion}  -- concurrency conflict
      end

      redis.call('SETEX', key, ttl, newState)
      
      -- Maintain runnable index
      if status == 'active' or status == 'pending' or status == 'in_progress' then
        redis.call('ZADD', 'mas:sessions:runnable_z', score, sessionId)
      else
         redis.call('ZREM', 'mas:sessions:runnable_z', sessionId)
      end
      
      return {1, currentVersion}  -- success, return previous version
    `;
  }

  async getSession(sessionId: MasSessionId): Promise<MasSessionState | null> {
    const key = this.buildKey(sessionId);
    const started = process.hrtime.bigint();
    let outcome: Outcome = 'success';

    try {
      const state = await this.cache.get<MasSessionState>(key);
      if (!state) {
        this.recordMetrics('get', outcome, started);
        return null;
      }

      const nowIso = new Date().toISOString();
      const normalized: MasSessionState = {
        ...state,
        sessionId: state.sessionId ?? sessionId,
        version: Number.isFinite(state.version) ? state.version : 0,
        createdAt: state.createdAt ?? nowIso,
        updatedAt: state.updatedAt ?? nowIso,
      };

      this.recordMetrics('get', outcome, started);
      return normalized;
    } catch (error) {
      outcome = 'error';
      this.recordMetrics('get', outcome, started, error);
      try {
        incrementMasMemoryErrorsTotal({
          operation: 'session_state_load',
          backend: 'dualwrite',
        });
      } catch {
        // MAS memory metrics must never break session store behavior.
      }
      // Storage errors must not crash MAS; callers are expected to degrade gracefully.
       
      console.error('[RedisMasSessionStore] getSession error', {
        sessionId: String(sessionId),
        error,
      });
      return null;
    }
  }

  async saveSession(state: MasSessionState, options?: { expectedVersion?: number }): Promise<void> {
    const key = this.buildKey(state.sessionId);
    const started = process.hrtime.bigint();
    let outcome: Outcome = 'success';

    // A-009 FIX: Implement optimistic locking with retry
    for (let attempt = 0; attempt < this.MAX_RETRIES; attempt += 1) {
      try {
        const nowIso = new Date().toISOString();
        const currentVersion = Number.isFinite(state.version) ? state.version : 0;
        const expectedVersion = options?.expectedVersion ?? currentVersion;

        // Increment version for new state
        const newVersion = currentVersion + 1;

        const payload: MasSessionState = {
          ...state,
          version: newVersion,
          createdAt: state.createdAt ?? nowIso,
          updatedAt: nowIso,
        };

        // Try to use atomic Lua script if cache supports it, otherwise fall back to compare-and-swap
        const saved = await this.tryAtomicSave(key, payload, expectedVersion, this.ttlSeconds);

        if (!saved) {
          // Concurrent modification detected - fetch current state and retry
          const current = await this.cache.get<MasSessionState>(key);
          if (current && Number.isFinite(current.version)) {
            // Merge logic: update our state with current version and retry
            state = { ...state, version: current.version };
            if (attempt < this.MAX_RETRIES - 1) {
              await this.delay(this.RETRY_DELAY_MS * Math.pow(2, attempt));
              continue;  // Retry with updated version
            }
          }

          // Max retries exceeded or no current state
          throw new Error(
            `Optimistic locking conflict for session ${String(state.sessionId)}: ` +
            `expected version ${expectedVersion} but found different version`,
          );
        }

        this.recordMetrics('save', outcome, started);
        return;  // Success
      } catch (error) {
        // Only retry on optimistic locking conflicts, not other errors
        if (attempt < this.MAX_RETRIES - 1 && this.isOptimisticLockingError(error)) {
          await this.delay(this.RETRY_DELAY_MS * Math.pow(2, attempt));
          continue;
        }

        outcome = 'error';
        this.recordMetrics('save', outcome, started, error);
        try {
          incrementMasMemoryErrorsTotal({
            operation: 'session_state_save',
            backend: 'dualwrite',
          });
        } catch {
          // MAS memory metrics must never break session store behavior.
        }

        this.logger?.error('[RedisMasSessionStore] saveSession error', {
          sessionId: String(state.sessionId),
          attempt: attempt + 1,
          error: String(error),
        });
        throw error;
      }
    }
  }

  async resetStuckSessions(maxDurationMs: number): Promise<number> {
    const started = process.hrtime.bigint();
    try {
      const cache = this.cache as unknown as {
        eval?(script: string, keys: string[], args: string[]): Promise<number>;
      };

      if (typeof cache.eval !== 'function') {
         return 0; // Not supported on this cache backend
      }

      const now = Date.now();
      const threshold = now - maxDurationMs;
      
      // Script:
      // 1. ZRANGEBYSCORE to get stale session IDs
      // 2. Loop, GET, check if 'in_progress', SET 'pending', update ZSET
      const script = `
        local zsetKey = 'mas:sessions:runnable_z'
        local threshold = tonumber(ARGV[1]) -- now - maxDuration
        local nowStr = ARGV[2]            -- ISO string
        local nowScore = tonumber(ARGV[3]) -- Numeric timestamp
        
        -- Get session IDs that haven't been updated recently (limit 50 to avoid blocking)
        local sessionIds = redis.call('ZRANGEBYSCORE', zsetKey, '-inf', threshold, 'LIMIT', 0, 50)
        local count = 0

        for _, sessionId in ipairs(sessionIds) do
            local key = 'mas:session:' .. sessionId
            local raw = redis.call('GET', key)
            if raw then
                local state = cjson.decode(raw)
                if state.status == 'in_progress' then
                    -- Reset to pending
                    state.status = 'pending'
                    state.updatedAt = nowStr
                    state.version = (state.version or 0) + 1
                    state.metadata = state.metadata or {}
                    state.metadata.reset_reason = 'stuck_worker_ttl'

                    local saved = cjson.encode(state)
                    -- Keep TTL
                    local ttl = redis.call('TTL', key)
                    if ttl < 0 then ttl = 3600 end -- fallback

                    redis.call('SETEX', key, ttl, saved)
                    
                    -- Update score in ZSET so we don't pick it up again immediately
                    redis.call('ZADD', zsetKey, nowScore, sessionId)
                    
                    count = count + 1
                end
            end
        end
        return count
      `;

      const result = await cache.eval(
        script, 
        [], 
        [String(threshold), new Date().toISOString(), String(now)]
      );

      this.recordMetrics('save', 'success', started); // Counting resets as saves
      return Number(result);
    } catch (error) {
       this.recordMetrics('save', 'error', started, error);
       console.error('[RedisMasSessionStore] resetStuckSessions error', error);
       return 0;
    }
  }

  async listRunnableSessions(limit: number = 50): Promise<MasSessionId[]> {
    const started = process.hrtime.bigint();
    try {
      const cache = this.cache as unknown as {
        eval?(script: string, keys: string[], args: string[]): Promise<string[]>;
      };

      if (typeof cache.eval === 'function') {
         // Use ZRANGE to get oldest active sessions first (FIFO)
         // ZRANGE key 0 start stop
         const script = `return redis.call('ZRANGE', 'mas:sessions:runnable_z', 0, ARGV[1])`;
         const result = await cache.eval(script, [], [String(limit - 1)]);
         
         this.recordMetrics('get', 'success', started); // Using 'get' as proxy for list
         
         if (Array.isArray(result)) {
            return result as MasSessionId[];
         }
         return [];
      }
      
      // Fallback if no eval - return empty or throw? 
      // Returning empty is safer for now to avoid crashing loop.
      return [];
    } catch (error) {
       this.recordMetrics('get', 'error', started, error);
       console.error('[RedisMasSessionStore] listRunnableSessions error', error);
       return [];
    }
  }

  /**
   * Attempt atomic save using optimistic locking.
   * Returns true if saved successfully, false if version conflict.
   */
  private async tryAtomicSave(
    key: string,
    state: MasSessionState,
    expectedVersion: number,
    ttlSeconds: number,
  ): Promise<boolean> {
    // Check if the underlying cache supports Lua scripting (Redis-specific optimization)
    const cache = this.cache as unknown as {
      eval?(script: string, keys: string[], args: string[]): Promise<[number, number] | null>;
    };

    if (typeof cache.eval === 'function') {
      try {
        const result = await cache.eval(
          this.buildSaveScript(),
          [key],
          [
            String(expectedVersion), 
            JSON.stringify(state), 
            String(ttlSeconds),
            String(state.sessionId),
            String(state.status || 'active'), // Default to active if undefined? No, explicit undefined is fine, logic handles it.
            String(Date.now())
          ],
        );

        if (result && result[0] === 1) {
          return true;  // Success
        } else if (result && result[0] === -1) {
          return false;  // Version conflict
        }
      } catch {
        // Lua script failed, fall through to compare-and-swap
      }
    }

    // Fallback: Read-Compare-Write pattern (still has small race window but better than nothing)
    const current = await this.cache.get<MasSessionState>(key);
    const currentVersion = current?.version ?? 0;

    if (currentVersion !== expectedVersion) {
      return false;  // Version mismatch
    }

    if (current === null) {
      // New entry - use onlyIfNotExists to prevent race conditions
      await this.cache.set(key, state, { ttlSeconds, onlyIfNotExists: true });
      return true;
    } else {
      // Existing entry - update directly
      await this.cache.set(key, state, { ttlSeconds });
      return true;
    }
  }

  private isOptimisticLockingError(error: unknown): boolean {
    if (error instanceof Error) {
      return error.message.includes('Optimistic locking conflict');
    }
    return false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async deleteSession(sessionId: MasSessionId): Promise<void> {
    const key = this.buildKey(sessionId);
    const started = process.hrtime.bigint();
    let outcome: Outcome = 'success';

    try {
      await this.cache.delete(key);
      
      // Cleanup index
      const cache = this.cache as unknown as {
        eval?(script: string, keys: string[], args: string[]): Promise<unknown>;
      };
      if (typeof cache.eval === 'function') {
        const script = `redis.call('ZREM', 'mas:sessions:runnable_z', ARGV[1])`;
        await cache.eval(script, [], [String(sessionId)]);
      }

      this.recordMetrics('delete', outcome, started);
    } catch (error) {
      outcome = 'error';
      this.recordMetrics('delete', outcome, started, error);
      try {
        incrementMasMemoryErrorsTotal({
          operation: 'session_state_delete',
          backend: 'dualwrite',
        });
      } catch {
        // MAS memory metrics must never break session store behavior.
      }

      console.error('[RedisMasSessionStore] deleteSession error', {
        sessionId: String(sessionId),
        error,
      });
      throw error;
    }
  }

  /**
   * A-026 FIX: Flush any pending operations to Redis.
   * For Redis, operations are immediate, but this ensures connectivity.
   */
  async flush(): Promise<void> {
    try {
      // Redis operations are synchronous from client perspective,
      // but we verify connectivity by attempting a ping-like operation
      if ('ping' in this.cache && typeof (this.cache as { ping?: () => Promise<boolean> }).ping === 'function') {
        await (this.cache as { ping: () => Promise<boolean> }).ping();
      }
    } catch (error) {
      console.warn('[RedisMasSessionStore] Flush connectivity check failed:', error);
      // Don't throw - Redis is designed to be resilient
    }
  }

  /**
   * A-026 FIX: Close the session store and clean up resources.
   * Called during graceful shutdown to ensure proper cleanup.
   */
  async close(): Promise<void> {
    try {
      await this.flush();
      console.info('[RedisMasSessionStore] Session store closed successfully');
    } catch (error) {
      console.error('[RedisMasSessionStore] Error during close:', error);
      // Don't throw during shutdown - log and continue
    }
  }

  private recordMetrics(
    operation: Operation,
    outcome: Outcome,
    started: bigint,
    error?: unknown,
  ): void {
    const durationSeconds = Number(process.hrtime.bigint() - started) / 1e9;

    try {
      masSessionStoreOperationsTotal.inc({ operation, outcome });
      masSessionStoreOperationDurationSeconds.observe(
        { operation, outcome },
        durationSeconds,
      );
      if (outcome === 'error') {
        masSessionStoreErrorsTotal.inc({ operation });
      }
    } catch {
      // Metrics must never affect MAS runtime.
    }

    if (error) {
      // Placeholder for future structured logging integration if needed.
    }
  }
}