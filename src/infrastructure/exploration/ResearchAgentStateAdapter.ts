/**
 * ResearchAgentStateAdapter — Infrastructure adapter for IResearchAgentState.
 *
 * Pure state machine with typed transitions between research phases.
 * Enforces valid transitions using a transition table — no invalid phase jumps.
 *
 * Best Practices Applied (March 2026):
 * - State Machine pattern (GoF) with immutable transition history
 * - Guard-based transitions: canTransition() before transition()
 * - correlationId in all state transitions for traceability
 * - No DI dependencies on external services (pure logic)
 *
 * DI: constructor(logger) — 1 arg
 *
 * @layer Infrastructure (implements Domain port)
 * @see IResearchAgentState (src/domain/exploration/research-state.interface.ts)
 * @see Book Ch.21 "Agent Laboratory" — PostdocAgent state management
 */

import type {
  IResearchAgentState,
  ResearchState,
  StateTransition,
} from '../../domain/exploration/research-state.interface';
import type { ILogger } from '../../core/decorators/ILogger';
import type { CorrelationId } from '../../core/types/branded';

// ── Valid transitions table ─────────────────────────────────────────

/**
 * Defines allowed state transitions.
 * Key: source state. Value: set of valid target states.
 */
const VALID_TRANSITIONS: Readonly<Record<ResearchState, readonly ResearchState[]>> = {
  idle:                 ['literature_review'],
  literature_review:    ['hypothesis_formation', 'idle'],
  hypothesis_formation: ['experiment_design', 'literature_review'],
  experiment_design:    ['experimentation', 'hypothesis_formation'],
  experimentation:      ['analysis', 'experiment_design'],
  analysis:             ['writing', 'experimentation'],
  writing:              ['review', 'analysis'],
  review:               ['revision', 'complete'],
  revision:             ['writing', 'experiment_design', 'complete'],
  complete:             ['idle'],
};

// ── Adapter ─────────────────────────────────────────────────────────

export class ResearchAgentStateAdapter implements IResearchAgentState {
  private _currentState: ResearchState = 'idle';
  private _history: StateTransition[] = [];

  constructor(
    private readonly logger: ILogger,
  ) {}

  get currentState(): ResearchState {
    return this._currentState;
  }

  get history(): readonly StateTransition[] {
    return this._history;
  }

  canTransition(to: ResearchState): boolean {
    const allowed = VALID_TRANSITIONS[this._currentState];
    return allowed.includes(to);
  }

  transition(to: ResearchState, condition: string, correlationId: CorrelationId): void {
    if (!this.canTransition(to)) {
      const message = `Invalid transition: "${this._currentState}" → "${to}". Allowed: [${VALID_TRANSITIONS[this._currentState].join(', ')}]`;
      this.logger.error('ResearchAgentStateAdapter.invalidTransition', {
        correlationId,
        from: this._currentState,
        to,
        allowed: VALID_TRANSITIONS[this._currentState],
      });
      throw new Error(message);
    }

    const transition: StateTransition = {
      from: this._currentState,
      to,
      condition,
      timestamp: Date.now(),
    };

    this._history.push(transition);
    this._currentState = to;

    this.logger.info('ResearchAgentStateAdapter.transition', {
      correlationId,
      from: transition.from,
      to: transition.to,
      condition,
      historyLength: this._history.length,
    });
  }

  reset(): void {
    this._currentState = 'idle';
    this._history = [];
  }
}
