/**
 * MAS Durable Execution - external result reference.
 *
 * Layer: Domain (MAS durable execution model).
 *
 * Lightweight pointer to a result stored in external systems
 * (event store, memory, tracing, etc.). This object is purely
 * descriptive and does not imply any direct I/O from the domain.
 */
export interface MasResultRef {
  /**
   * Logical provider / backend name, e.g.:
   * - "event_store"
   * - "session_memory"
   * - "long_term_memory"
   * - "trace"
   * - "custom"
   */
  provider: string;

  /**
   * Primary identifier of the stored result in the provider space.
   * For example:
   * - event id in EventStore
   * - memory record id
   * - trace/span id
   */
  refId: string;

  /**
   * Optional locator (URI, path, composite key, etc.) that can help
   * external systems resolve the result without extra conventions.
   */
  locator?: string;

  /**
   * Correlation identifier that was active when the result was
   * produced. Helpful for cross-linking with other observability
   * streams (T002).
   */
  correlationId?: string;

  /**
   * Backend-specific attributes (collection, table, region, etc.).
   * Kept opaque at domain level.
   */
  metadata?: Record<string, unknown>;
}