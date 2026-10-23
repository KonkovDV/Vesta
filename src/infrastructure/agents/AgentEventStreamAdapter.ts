/**
 * AgentEventStreamAdapter — In-memory chronological agent event stream.
 *
 * In-memory implementation of IAgentEventStream. Manages agent sessions
 * with typed action/observation events in sequential order. Each session
 * tracks accumulated cost and event counts.
 *
 * @layer Infrastructure (Agents)
 * @pattern CC-017 Agent Event Stream (FITNESS-K: 80)
 * @see src/domain/agents/IAgentEventStream.ts — domain port
 * @see src/core/events/agent-event-stream.schemas.ts — Zod validation schemas
 */

import type {
  IAgentEventStream,
  AgentAction,
  AgentObservation,
  AgentEvent,
  AgentSession,
  ActionKind,
  ObservationKind,
  StreamQuery,
} from '../../domain/agents/IAgentEventStream';

// ── Minimal Logger ────────────────────────────────────────────────

interface StreamLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

// ── Internal State ────────────────────────────────────────────────

interface SessionState {
  session: AgentSession;
  events: AgentEvent[];
  sequenceCounter: number;
}

// ── Adapter ───────────────────────────────────────────────────────

export class AgentEventStreamAdapter implements IAgentEventStream {
  private readonly sessions = new Map<string, SessionState>();
  private eventCounter = 0;

  constructor(private readonly logger?: StreamLogger) {}

  createSession(agentId: string, taskDescription: string, metadata?: Record<string, unknown>): AgentSession {
    const sessionId = `ses-${++this.eventCounter}`;
    const session: AgentSession = {
      sessionId,
      agentId,
      taskDescription,
      startedAt: new Date().toISOString(),
      status: 'active',
      totalActions: 0,
      totalObservations: 0,
      accumulatedCostUsd: 0,
      metadata,
    };
    this.sessions.set(sessionId, { session, events: [], sequenceCounter: 0 });
    this.logger?.info('Session created', { sessionId, agentId });
    return session;
  }

  recordAction(
    sessionId: string,
    kind: ActionKind,
    payload: Record<string, unknown>,
    cost?: { tokens?: number; usd?: number },
  ): AgentAction {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);
    if (state.session.status !== 'active') throw new Error(`Session not active: ${sessionId}`);

    const action: AgentAction = {
      eventId: `evt-${++this.eventCounter}`,
      sessionId,
      eventType: 'action',
      kind,
      payload,
      timestamp: new Date().toISOString(),
      sequenceNumber: state.sequenceCounter++,
      estimatedTokens: cost?.tokens,
      estimatedCostUsd: cost?.usd,
    };

    state.events.push(action);
    state.session = {
      ...state.session,
      totalActions: state.session.totalActions + 1,
      accumulatedCostUsd: state.session.accumulatedCostUsd + (cost?.usd ?? 0),
    };

    return action;
  }

  recordObservation(
    sessionId: string,
    kind: ObservationKind,
    payload: Record<string, unknown>,
    sourceActionId?: string,
  ): AgentObservation {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);
    if (state.session.status !== 'active') throw new Error(`Session not active: ${sessionId}`);

    const observation: AgentObservation = {
      eventId: `evt-${++this.eventCounter}`,
      sessionId,
      eventType: 'observation',
      kind,
      payload,
      timestamp: new Date().toISOString(),
      sequenceNumber: state.sequenceCounter++,
      sourceActionId,
    };

    state.events.push(observation);
    state.session = {
      ...state.session,
      totalObservations: state.session.totalObservations + 1,
    };

    return observation;
  }

  queryEvents(query: StreamQuery): readonly AgentEvent[] {
    const state = this.sessions.get(query.sessionId);
    if (!state) return [];

    let events: AgentEvent[] = [...state.events];

    if (query.eventType) {
      events = events.filter(e => e.eventType === query.eventType);
    }
    if (query.actionKind) {
      events = events.filter(e => e.eventType === 'action' && (e).kind === query.actionKind);
    }
    if (query.observationKind) {
      events = events.filter(e => e.eventType === 'observation' && (e).kind === query.observationKind);
    }
    if (query.afterSequence !== undefined) {
      events = events.filter(e => e.sequenceNumber > query.afterSequence!);
    }
    if (query.limit !== undefined) {
      events = events.slice(0, query.limit);
    }

    return events;
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId)?.session;
  }

  closeSession(sessionId: string, status: 'completed' | 'failed' | 'timeout'): AgentSession {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Session not found: ${sessionId}`);

    state.session = {
      ...state.session,
      status,
      closedAt: new Date().toISOString(),
    };

    this.logger?.info('Session closed', { sessionId, status, totalEvents: state.events.length });
    return state.session;
  }

  getRecentEvents(sessionId: string, count: number): readonly AgentEvent[] {
    const state = this.sessions.get(sessionId);
    if (!state) return [];
    return state.events.slice(-count);
  }
}
