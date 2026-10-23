/**
 * MAS Runtime Core - Master Agent contract.
 *
 * Layer: Application (business orchestration).
 *
 * Master Agent is responsible for:
 * - accepting normalized MAS requests;
 * - coordinating Task Decomposer, Context Coordinator, Agent Registry;
 * - aggregating results and producing MasResponse;
 * - managing MAS session lifecycle at a high level.
 *
 * This is a pure contract; implementations are provided in impl layer.
 */

import type { IRequestContext } from '../../context/request-context';
import type {
  MasRequest,
  MasResponse,
  MasSessionContext,
  MasTaskPlan,
  MasMetadataBag,
} from '../types/mas-types';

/**
 * Options for executing a multi-agent task.
 */
export interface MasterAgentExecutionOptions {
  /**
   * Optional precomputed task plan. If provided, the Master Agent MAY skip
   * calling ITaskDecomposer for this execution and use the supplied plan.
   */
  planHint?: MasTaskPlan;

  /**
   * Hint that the execution should attach to an existing MAS session
   * instead of initializing a brand new one.
   */
  resumeExistingSession?: boolean;

  /**
   * Additional opaque debug metadata, propagated to logs/observability
   * but not interpreted at the type level.
   */
  debugMetadata?: MasMetadataBag;
}

/**
 * Top-level MAS orchestrator interface.
 */
export interface IMasterAgent {
  /**
   * Execute a MAS scenario using one or more agents.
   *
   * Implementations are expected to:
   * - normalize and validate the incoming request;
   * - initialize or reuse MAS session context based on IRequestContext metadata;
   * - obtain a task plan via ITaskDecomposer (unless planHint is provided);
   * - coordinate Context Coordinator and Agent Registry for each task;
   * - persist relevant steps into Memory via Context Coordinator;
   * - produce a MasResponse suitable for the calling use-case.
   */
  executeMultiAgentTask(
    request: MasRequest,
    requestContext: IRequestContext,
    options?: MasterAgentExecutionOptions,
  ): Promise<MasResponse>;

  /**
   * Explicitly start a new MAS session.
   *
   * Implementations may use this to perform session bootstrap steps
   * (e.g. initializing Memory session or MAS metadata), but callers
   * are not required to use it for simple one-shot scenarios.
   */
  startSession?(
    request: MasRequest,
    requestContext: IRequestContext,
  ): Promise<MasSessionContext>;

  /**
   * Continue an existing MAS session with a new request.
   */
  continueSession?(
    session: MasSessionContext,
    request: MasRequest,
    requestContext: IRequestContext,
  ): Promise<MasResponse>;

  /**
   * Gracefully finalize a MAS session.
   */
  endSession?(
    session: MasSessionContext,
    requestContext: IRequestContext,
    reason?: string,
  ): Promise<void>;
}

/**
 * DI token for IMasterAgent.
 *
 * NOTE:
 * - The actual registration of IMasterAgent implementations is performed
 *   in the infrastructure DI bootstrap:
 *   [`src/infrastructure/di/bootstrap.ts`](src/infrastructure/di/bootstrap.ts:1).
 * - Application code (HTTP/BFF, use-cases) should use this token when
 *   resolving IMasterAgent from the shared container.
 */
export const masterAgentToken = 'IMasterAgent' as const;
export type MasterAgentDiToken = typeof masterAgentToken;