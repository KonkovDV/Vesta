import type { CircuitBreakerKey } from './CircuitBreakerKey';
import type {
  CircuitBreakerState,
  CircuitBreakerMetrics,
} from '../../domain/external/ICircuitBreaker';
import type { CircuitBreakerConfig } from './CircuitBreakerConfig';

/**
 * Persistent snapshot of circuit breaker state suitable for storage in a database.
 *
 * CircuitBreakerPersistentState represents a full snapshot of the breaker state
 * that can be written/read by infrastructure backends (Postgres, Redis, etc.).
 */
export interface CircuitBreakerPersistentState {
  key: CircuitBreakerKey;
  state: CircuitBreakerState;
  metrics: CircuitBreakerMetrics;
  config: CircuitBreakerConfig;
  updatedAt: Date;
}

/**
 * Abstract store for distributed circuit breaker state.
 *
 * Implementations SHOULD use a simple optimistic-locking strategy based on
 * updatedAt (e.g. WHERE key = $1 AND updated_at = $2), without introducing
 * heavyweight distributed locks or cross-process transactions.
 */
export interface ICircuitBreakerStateStore {
  getState(key: CircuitBreakerKey): Promise<CircuitBreakerPersistentState | null>;

  /**
   * Создать запись состояния, если её ещё нет.
   *
   * Реализация должна использовать семантику "insert if not exists"
   * (например, INSERT ... ON CONFLICT DO NOTHING) и возвращать уже
   * существующую строку при гонке записей.
   */
  createState(initial: CircuitBreakerPersistentState): Promise<CircuitBreakerPersistentState>;

  /**
   * Обновить состояние на основе optimistic-lock через updatedAt.
   *
   * Базовая модель:
   *   UPDATE ... SET ..., updated_at = next.updatedAt
   *   WHERE key = $key AND updated_at = prevUpdatedAt
   *
   * Возвращает true, если обновление применено (rowCount === 1),
   * и false — если состояние успело измениться конкурентно
   * (вызывающий код должен перечитать и повторить попытку).
   */
  tryUpdateState(
    key: CircuitBreakerKey,
    prevUpdatedAt: Date,
    next: CircuitBreakerPersistentState,
  ): Promise<boolean>;
}