/*
-- Table: cb_state
-- Columns:
--   key         text        primary key, serialized CircuitBreakerKey
--   state       text        current circuit state
--   metrics     jsonb       aggregated metrics (failures, successes, etc.)
--   config      jsonb       effective config snapshot / overrides
--   updated_at  timestamptz last update timestamp (used for optimistic locking)
*/

import type {
  ICircuitBreakerStateStore,
  CircuitBreakerPersistentState,
} from '../../core/resilience/ICircuitBreakerStateStore';
import type { CircuitBreakerKey } from '../../core/resilience/CircuitBreakerKey';
import { serializeCircuitBreakerKey } from '../../core/resilience/CircuitBreakerKey';
import type { IDatabaseConnection } from '../../domain/persistence/IDatabaseConnection';
import type {
  CircuitBreakerMetrics,
  CircuitBreakerState,
} from '../../domain/external/ICircuitBreaker';
import type { CircuitBreakerConfig } from '../../core/resilience/CircuitBreakerConfig';
import { tryJsonParse } from '../../core/utils/json';

interface CircuitBreakerStateRow {
  key: string;
  state: string;
  metrics: unknown;
  config: unknown;
  updated_at: Date | string;
}

/**
 * PostgreSQL-backed implementation of ICircuitBreakerStateStore.
 *
 * Uses a simple optimistic-locking model based on updated_at without
 * introducing heavyweight distributed locks or cross-process transactions.
 */
export class PostgresCircuitBreakerStateStore
  implements ICircuitBreakerStateStore
{
  constructor(private readonly db: IDatabaseConnection) {}

  async getState(
    key: CircuitBreakerKey,
  ): Promise<CircuitBreakerPersistentState | null> {
    const serializedKey = serializeCircuitBreakerKey(key);

    const row = await this.db.queryOne<CircuitBreakerStateRow>(
      `
        SELECT
          key,
          state,
          metrics,
          config,
          updated_at
        FROM cb_state
        WHERE key = $1
      `,
      [serializedKey],
    );

    if (!row) {
      return null;
    }

    return this.mapRowToPersistentState(key, row);
  }

  async createState(
    initial: CircuitBreakerPersistentState,
  ): Promise<CircuitBreakerPersistentState> {
    const serializedKey = serializeCircuitBreakerKey(initial.key);
    const updatedAt = initial.updatedAt ?? new Date();

    const rowCount = await this.db.execute(
      `
        INSERT INTO cb_state (key, state, metrics, config, updated_at)
        VALUES ($1, $2, $3, $4, $5)
        ON CONFLICT (key) DO NOTHING
      `,
      [
        serializedKey,
        initial.state,
        JSON.stringify(initial.metrics),
        JSON.stringify(initial.config),
        updatedAt,
      ],
    );

    if (rowCount > 0) {
      // Successfully inserted; return the snapshot we just persisted.
      return {
        ...initial,
        updatedAt,
      };
    }

    // Someone else inserted concurrently; read and return existing state.
    const existing = await this.getState(initial.key);
    if (existing) {
      return existing;
    }

    // Fallback: table might be missing/misconfigured; return provided snapshot.
    return {
      ...initial,
      updatedAt,
    };
  }

  async tryUpdateState(
    key: CircuitBreakerKey,
    prevUpdatedAt: Date,
    next: CircuitBreakerPersistentState,
  ): Promise<boolean> {
    const serializedKey = serializeCircuitBreakerKey(key);
    const nextUpdatedAt = next.updatedAt ?? new Date();

    const rowCount = await this.db.execute(
      `
        UPDATE cb_state
        SET
          state = $1,
          metrics = $2,
          config = $3,
          updated_at = $4
        WHERE key = $5 AND updated_at = $6
      `,
      [
        next.state,
        JSON.stringify(next.metrics),
        JSON.stringify(next.config),
        nextUpdatedAt,
        serializedKey,
        prevUpdatedAt,
      ],
    );

    if (rowCount > 0) {
      // Reflect the timestamp we actually wrote.
      next.updatedAt = nextUpdatedAt;
      return true;
    }

    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ─────────────────────────────────────────────────────────────────────────────

  private mapRowToPersistentState(
    key: CircuitBreakerKey,
    row: CircuitBreakerStateRow,
  ): CircuitBreakerPersistentState {
    const metrics = this.deserializeJsonColumn<CircuitBreakerMetrics>(
      row.metrics,
      'metrics',
    );
    const config = this.deserializeJsonColumn<CircuitBreakerConfig>(
      row.config,
      'config',
    );
    const updatedAt = this.toDate(row.updated_at, 'updated_at');

    return {
      key,
      state: row.state as CircuitBreakerState,
      metrics,
      config,
      updatedAt,
    };
  }

  private deserializeJsonColumn<T>(value: unknown, column: string): T {
    if (value == null) {
      throw new Error(`cb_state.${column} is null`);
    }

    if (typeof value === 'string') {
      const parsed = tryJsonParse<T>(value);
      if (!parsed.ok) {
        throw parsed.error;
      }
      return parsed.value;
    }

    // For jsonb, pg typically returns already-parsed objects.
    return value as T;
  }

  private toDate(value: Date | string, column: string): Date {
    if (value instanceof Date) {
      return value;
    }

    const d = new Date(value);
    if (Number.isNaN(d.getTime())) {
      throw new Error(`Invalid timestamp in cb_state.${column}`);
    }
    return d;
  }
}