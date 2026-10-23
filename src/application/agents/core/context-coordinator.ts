/**
 * MAS Runtime Core - Context Coordinator contract.
 *
 * Layer: Application (business orchestration).
 *
 * Context Coordinator is responsible for:
 * - assembling MAS context windows using Memory and other sources;
 * - updating Memory with new messages;
 * - coordinating MAS session lifecycle operations (consolidation/finalization).
 *
 * This is a pure contract; implementations live in impl/adapters layers.
 */

import type { IRequestContext } from '../../../core/context/IRequestContext';
import type {
  MasContextWindow,
  MasSessionContext,
  ContextRequest,
  MasMessage,
  MasMetadataBag,
} from '../types/mas-types';

/**
 * Request to append one or more MAS messages into session memory.
 */
export interface AppendMessagesRequest {
  /** MAS session to which messages belong. */
  session: MasSessionContext;
  /** Routing context of the caller for correlation and metadata. */
  requestContext: IRequestContext;
  /** Messages to append to MAS/Memory history. */
  messages: MasMessage[];
  /** Optional opaque metadata for adapters/implementations. */
  metadata?: MasMetadataBag & {
    /** Optional step classification for observability (e.g. 'reasoning', 'action', 'response'). */
    step_kind?: string;
    /** Optional scenario identifier for metrics. */
    scenario?: string;
    /** Optional use-case identifier for metrics. */
    use_case?: string;
  };
}

/**
 * Request to finalize a MAS session at context/memory level.
 */
export interface FinalizeSessionRequest {
  /** MAS session being finalized. */
  session: MasSessionContext;
  /** Routing context of the caller for correlation and metadata. */
  requestContext: IRequestContext;
  /** Optional human-readable reason of finalization. */
  reason?: string;
  /** Additional metadata (e.g. outcome, error details). */
  metadata?: MasMetadataBag;
}

/**
 * MAS Context Coordinator interface.
 */
export interface IContextCoordinator {
  /**
   * Build a context window for the given MAS session/task.
   *
   * Implementations typically call underlying Memory services
   * (e.g. ISessionMemoryManager) and enrich results with MAS metadata
   * and policy decisions.
   */
  getContextWindow(
    request: ContextRequest,
    requestContext: IRequestContext,
  ): Promise<MasContextWindow>;

  /**
   * Append one or more messages to MAS/Memory history.
   */
  appendMessages(request: AppendMessagesRequest): Promise<void>;

  /**
   * Finalize a MAS session from context perspective (e.g. end_session/consolidation).
   */
  finalizeSession(request: FinalizeSessionRequest): Promise<void>;
}

/**
 * DI token for IContextCoordinator.
 *
 * Implementations are registered in the infrastructure DI bootstrap:
 * [`src/infrastructure/di/bootstrap.ts`](src/infrastructure/di/bootstrap.ts:1),
 * while application-layer code should use this token to resolve the
 * context coordinator from the shared container.
 */
export const contextCoordinatorToken = 'IContextCoordinator' as const;
export type ContextCoordinatorDiToken = typeof contextCoordinatorToken;