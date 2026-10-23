/**
 * IA2ATaskRunner — Domain Port for A2A Task Execution
 *
 * Layer: Domain (port / contract)
 *
 * Sends tasks to remote A2A-compliant agents via JSON-RPC (sendTask).
 * Uses IAgentCardProvider for agent discovery/validation before sending tasks.
 *
 * Implementation resides in Infrastructure; resolution via DI only:
 *   container.resolve<IA2ATaskRunner>(DI_TOKENS.IA2ATaskRunner)
 *
 * Protocol: A2A (Agent-to-Agent) RC v1.0, Linux Foundation
 *
 * @see Book Ch.15 "A2A Agent-to-Agent Protocol"
 * @see https://google.github.io/A2A/ — A2A Protocol specification
 */

import type { CorrelationId } from '../../core/types/branded';
import type { AgentCard } from './IAgentCardProvider';

// ─── Value Types ──────────────────────────────────────────────────────

/** Status of an A2A task during its lifecycle */
export type A2ATaskStatus = 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled';

/** A request to execute a task on a remote A2A agent */
export interface A2ATaskRequest {
  /** The base URL of the remote A2A agent */
  readonly agentUrl: string;
  /** The user message / prompt to send to the agent */
  readonly message: string;
  /** Optional session ID for multi-turn conversations */
  readonly sessionId?: string;
  /** Additional metadata for the task */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** An artifact produced by a remote agent during task execution */
export interface A2AArtifact {
  /** Human-readable artifact name */
  readonly name: string;
  /** MIME type of the artifact content */
  readonly mimeType: string;
  /** Base64-encoded data or text content */
  readonly data: string;
}

/** Response from a remote A2A agent after task execution */
export interface A2ATaskResponse {
  /** Unique task ID assigned by the remote agent */
  readonly taskId: string;
  /** Current task status */
  readonly status: A2ATaskStatus;
  /** Text result from the agent (for completed tasks) */
  readonly result?: string;
  /** Artifacts produced during execution */
  readonly artifacts: readonly A2AArtifact[];
  /** Total execution time in milliseconds */
  readonly durationMs: number;
}

// ─── Port Interface ───────────────────────────────────────────────────

/**
 * Port for sending tasks to remote A2A-compliant agents.
 *
 * Domain/Application layers consume this interface; concrete adapter
 * lives in Infrastructure and is registered via DI token `IA2ATaskRunner`.
 */
export interface IA2ATaskRunner {
  /**
   * Discover a remote agent's capabilities via /.well-known/agent.json.
   * Validates capabilities are accessible and returns the agent card.
   *
   * @throws A2ATaskError — if discovery fails or agent is unreachable
   */
  discoverAgent(
    url: string,
    correlationId: CorrelationId,
  ): Promise<AgentCard>;

  /**
   * Send a task to a remote A2A agent via JSON-RPC sendTask.
   * Polls for completion up to the configured timeout.
   *
   * @throws A2ATaskError — if task fails or times out
   */
  sendTask(
    request: A2ATaskRequest,
    correlationId: CorrelationId,
  ): Promise<A2ATaskResponse>;

  /**
   * Get the current status/result of a previously submitted task.
   *
   * @throws A2ATaskError — if task not found or agent unreachable
   */
  getTask(
    agentUrl: string,
    taskId: string,
    correlationId: CorrelationId,
  ): Promise<A2ATaskResponse>;

  /**
   * Cancel a running task on a remote agent.
   *
   * @throws A2ATaskError — if task cannot be canceled
   */
  cancelTask(
    agentUrl: string,
    taskId: string,
    correlationId: CorrelationId,
  ): Promise<void>;
}
