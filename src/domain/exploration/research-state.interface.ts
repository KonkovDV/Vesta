/**
 * IResearchAgentState — Domain port for research agent state machine.
 *
 * Manages typed state transitions for research agents across phases.
 * Each state has defined valid transitions to prevent invalid phase jumps.
 *
 * @layer Domain (port contract)
 * @see Book Ch.21 "Agent Laboratory" — PostdocAgent state management
 */

import type { CorrelationId } from '../../core/types/branded';

// ── Types ──────────────────────────────────────────────────────────

/**
 * Research agent lifecycle states.
 * Ordered roughly by typical flow, but transitions are explicitly constrained.
 */
export type ResearchState =
  | 'idle'
  | 'literature_review'
  | 'hypothesis_formation'
  | 'experiment_design'
  | 'experimentation'
  | 'analysis'
  | 'writing'
  | 'review'
  | 'revision'
  | 'complete';

/**
 * Record of a single state transition with timestamp and reason.
 */
export interface StateTransition {
  readonly from: ResearchState;
  readonly to: ResearchState;
  readonly condition: string;
  readonly timestamp: number;
}

// ── Interface ──────────────────────────────────────────────────────

/**
 * State machine for research agent lifecycle.
 * Enforces valid transitions and provides state history for auditability.
 *
 * @see DI_TOKENS.IResearchAgentState
 */
export interface IResearchAgentState {
  /** Current state of the research agent. */
  readonly currentState: ResearchState;

  /** Full history of state transitions (immutable). */
  readonly history: readonly StateTransition[];

  /**
   * Check whether a transition from current state to target is valid.
   * @param to — target state
   * @returns true if transition is allowed
   */
  canTransition(to: ResearchState): boolean;

  /**
   * Execute a state transition.
   * @param to            — target state
   * @param condition     — reason/condition for the transition
   * @param correlationId — request correlation ID for tracing
   * @throws Error if transition is not valid (use canTransition first)
   */
  transition(to: ResearchState, condition: string, correlationId: CorrelationId): void;

  /**
   * Reset agent to idle state, clearing history.
   */
  reset(): void;
}
