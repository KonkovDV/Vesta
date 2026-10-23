/**
 * IAgentEventStream — Domain port for chronological agent execution tracing.
 *
 * CC-017 Agent Event Stream: a shared chronological log of actions and
 * observations that provides the canonical execution state for agents.
 * Inspired by the OpenHands event stream architecture (Wang et al. 2024,
 * arXiv:2407.16741) where all agent interactions flow through a unified
 * action/observation stream that serves as ground truth for execution state.
 *
 * Sub-capabilities:
 *   1. Action Recording — log agent actions with typed payloads
 *   2. Observation Recording — log environment observations (tool results, errors)
 *   3. Stream Query — retrieve events by session, type, or time range
 *   4. Cost Tracking — accumulative LLM cost per session
 *   5. Session Management — create/close execution sessions with metadata
 *
 * @extraction V8.0 Knowledge Pipeline — Source: OpenHands (ICLR 2025)
 * @see PLANS/EXTRACTION/EXTRACTION_SYSTEM.md — Phase 2K Delta Classification
 */

export type AgentEventType = 'action' | 'observation';

export type ActionKind =
  | 'llm_call'
  | 'tool_call'
  | 'file_read'
  | 'file_write'
  | 'command_run'
  | 'delegate'
  | 'user_message'
  | 'agent_message'
  | 'finish';

export type ObservationKind =
  | 'tool_result'
  | 'command_output'
  | 'file_content'
  | 'error'
  | 'user_feedback'
  | 'delegation_result';

export interface AgentAction {
  readonly eventId: string;
  readonly sessionId: string;
  readonly eventType: 'action';
  readonly kind: ActionKind;
  readonly payload: Record<string, unknown>;
  readonly timestamp: string;
  readonly sequenceNumber: number;
  readonly estimatedTokens?: number;
  readonly estimatedCostUsd?: number;
}

export interface AgentObservation {
  readonly eventId: string;
  readonly sessionId: string;
  readonly eventType: 'observation';
  readonly kind: ObservationKind;
  readonly payload: Record<string, unknown>;
  readonly timestamp: string;
  readonly sequenceNumber: number;
  readonly sourceActionId?: string;
}

export type AgentEvent = AgentAction | AgentObservation;

export interface AgentSession {
  readonly sessionId: string;
  readonly agentId: string;
  readonly taskDescription: string;
  readonly startedAt: string;
  readonly closedAt?: string;
  readonly status: 'active' | 'completed' | 'failed' | 'timeout';
  readonly totalActions: number;
  readonly totalObservations: number;
  readonly accumulatedCostUsd: number;
  readonly metadata?: Record<string, unknown>;
}

export interface StreamQuery {
  readonly sessionId: string;
  readonly eventType?: AgentEventType;
  readonly actionKind?: ActionKind;
  readonly observationKind?: ObservationKind;
  readonly afterSequence?: number;
  readonly limit?: number;
}

export interface IAgentEventStream {
  /**
   * Create a new agent execution session.
   */
  createSession(agentId: string, taskDescription: string, metadata?: Record<string, unknown>): AgentSession;

  /**
   * Record an action in the event stream.
   */
  recordAction(sessionId: string, kind: ActionKind, payload: Record<string, unknown>, cost?: { tokens?: number; usd?: number }): AgentAction;

  /**
   * Record an observation from the environment.
   */
  recordObservation(sessionId: string, kind: ObservationKind, payload: Record<string, unknown>, sourceActionId?: string): AgentObservation;

  /**
   * Query events from a session with optional filters.
   */
  queryEvents(query: StreamQuery): readonly AgentEvent[];

  /**
   * Get the current session state including accumulated cost.
   */
  getSession(sessionId: string): AgentSession | undefined;

  /**
   * Close a session with a final status.
   */
  closeSession(sessionId: string, status: 'completed' | 'failed' | 'timeout'): AgentSession;

  /**
   * Get the latest N events from a session (tail).
   */
  getRecentEvents(sessionId: string, count: number): readonly AgentEvent[];
}
