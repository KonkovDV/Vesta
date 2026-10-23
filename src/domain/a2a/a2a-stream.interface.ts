/**
 * IA2AStreamTransport — Domain Port for A2A SSE Streaming
 *
 * Layer: Domain (port / contract)
 *
 * SSE-based streaming transport for A2A protocol.
 * Implements sendTaskSubscribe for real-time task monitoring.
 * Client subscribes to task events and receives incremental status/artifact updates.
 *
 * Implementation resides in Infrastructure; resolution via DI only:
 *   container.resolve<IA2AStreamTransport>(DI_TOKENS.IA2AStreamTransport)
 *
 * @see Book Ch.15 "A2A Protocol" — sendTaskSubscribe
 * @see https://google.github.io/A2A/ — A2A Protocol specification
 */

import type { CorrelationId } from '../../core/types/branded';
import type { A2ATaskRequest, A2ATaskResponse } from './a2a-task-runner.interface';

// ─── Value Types ──────────────────────────────────────────────────────

/** Type of streaming event received from a remote A2A agent */
export type A2AStreamEventType = 'status' | 'artifact' | 'message' | 'error';

/** A single streaming event from an A2A task subscription */
export interface A2AStreamEvent {
  /** Event type indicating what kind of update this is */
  readonly type: A2AStreamEventType;
  /** Event payload — structure depends on type */
  readonly data: unknown;
  /** Server-assigned event ID (for resumability) */
  readonly eventId?: string;
  /** ISO timestamp of when the event was generated */
  readonly timestamp: number;
}

// ─── Port Interface ───────────────────────────────────────────────────

/**
 * Port for SSE-based streaming of A2A task execution.
 *
 * Domain/Application layers consume this interface; concrete adapter
 * lives in Infrastructure and is registered via DI token `IA2AStreamTransport`.
 */
export interface IA2AStreamTransport {
  /**
   * Subscribe to a task's execution via SSE (sendTaskSubscribe).
   * Events are delivered to the onEvent callback as they arrive.
   * Returns the final task response when the stream completes.
   *
   * @throws A2ATaskError — if connection fails or stream is interrupted
   */
  sendTaskSubscribe(
    request: A2ATaskRequest,
    onEvent: (event: A2AStreamEvent) => void,
    correlationId: CorrelationId,
  ): Promise<A2ATaskResponse>;

  /**
   * Unsubscribe from a previously subscribed task.
   * Safe to call if subscription is already closed.
   */
  unsubscribe(taskId: string): void;
}
