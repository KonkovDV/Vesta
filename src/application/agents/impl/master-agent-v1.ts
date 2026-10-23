/**
 * MAS Runtime Core - MasterAgentV1 implementation.
 *
 * Layer: Application (business orchestration).
 *
 * MAS-A1.2 scope:
 * - minimal orchestration skeleton without side effects;
 * - no direct access to Memory / LLM / Outbox / monitoring;
 * - uses only MAS core abstractions from Application layer;
 * - allows EventStoreService for observability (no direct infra access).
 *
 * REFACTOR NOTE:
 * This class is now a FACADE. Real logic is delegated to:
 * - AgentRouter (Domain Layer) - for agent selection
 * - TaskOrchestrator (Application Layer) - for execution loop and state
 */
import {
  type IRequestContext,
} from '../../context/request-context';
import {
  createMasSessionContextFromRequest,
  ensureMasTraceIdsInContext,
} from '../context/mas-request-context';
import type {
  MasRequest,
  MasResponse,
  MasSessionContext,
} from '../types/mas-types';
import type {
  IMasterAgent,
  MasterAgentExecutionOptions,
} from '../core/master-agent';
import { TaskOrchestrator } from '../../orchestration/TaskOrchestrator';

/**
 * Basic v1 implementation of IMasterAgent.
 *
 * Responsibilities in MAS-A1.2/B1.1 and MAS-A3.1/A3.2:
 * - FACADE PATTERN: Delegates all operations to TaskOrchestrator.
 */
export class MasterAgentV1 implements IMasterAgent {
  constructor(
    private readonly orchestrator: TaskOrchestrator,
  ) {}

  /**
   * Execute a MAS scenario using one or more agents.
   * FACADE: Delegates to TaskOrchestrator.runScenario().
   */
  async executeMultiAgentTask(
    request: MasRequest,
    requestContext: IRequestContext,
    options?: MasterAgentExecutionOptions,
  ): Promise<MasResponse> {
    return this.orchestrator.runScenario(request, requestContext, options);
  }

  /**
   * Explicitly start a new MAS session without executing any tasks.
   */
  async startSession(
    request: MasRequest,
    requestContext: IRequestContext,
  ): Promise<MasSessionContext> {
    return createMasSessionContextFromRequest(request, requestContext);
  }

  /**
   * Continue an existing MAS session by delegating to executeMultiAgentTask.
   */
  async continueSession(
    session: MasSessionContext,
    request: MasRequest,
    requestContext: IRequestContext,
  ): Promise<MasResponse> {
    const normalizedSession = ensureMasTraceIdsInContext(session, requestContext);

    const requestWithSession: MasRequest = {
      ...request,
      session: normalizedSession,
    };

    return this.executeMultiAgentTask(requestWithSession, requestContext, {
      resumeExistingSession: true,
    });
  }

  /**
   * MAS-A1.2 skeleton: endSession is a no-op.
   * Real finalization logic will be implemented together with ContextCoordinator/Memory.
   */
  async endSession(
    _session: MasSessionContext,
    _requestContext: IRequestContext,
    _reason?: string,
  ): Promise<void> {
    return Promise.resolve();
  }
}
