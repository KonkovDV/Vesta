import type {
  MasSessionContext,
  MasMessage,
  MasContextWindow,
  MasContextFilters,
  ContextWindowLimits,
} from '../types/mas-types';
import type { IRequestContext } from '../../context/request-context';
import type {
  TenantId,
  UserId,
  SessionId,
} from '../../../domain/memory/session-types';

/**
 * MAS ⇄ Memory application-level port for MAS Runtime.
 *
 * This contract is intentionally free from infrastructure types and
 * exposes only MAS/Application/Memory DTOs.
 */
export interface MasMemorySessionBinding {
  masSession: MasSessionContext;
  tenantId: TenantId;
  userId?: UserId;
  memorySessionId: SessionId;
}

export type MasStepKind =
  | 'user_input'
  | 'agent_message'
  | 'agent_thought'
  | 'tool_call'
  | 'tool_result'
  | 'system';

export interface MasMemoryContextRequest {
  /** MAS-level session context. */
  session: MasSessionContext;
  /** High-level business scenario identifier. */
  scenario: string;
  /** Optional business use-case or route name. */
  useCase?: string;
  /** Optional explicit limits for the context window. */
  limits?: ContextWindowLimits;
  /** Optional filters for knowledge / message selection. */
  filters?: MasContextFilters;
}

export interface MasMemoryAppendRequest {
  /** MAS-level session context. */
  session: MasSessionContext;
  /** High-level business scenario identifier. */
  scenario: string;
  /** Optional business use-case or route name. */
  useCase?: string;
  /** Kind of MAS step being appended. */
  stepKind: MasStepKind;
  /** One or more MAS messages to append to memory. */
  messages: MasMessage[];
}

export interface MasMemoryFinalizeRequest {
  /** MAS-level session context. */
  session: MasSessionContext;
  /** High-level business scenario identifier. */
  scenario: string;
  /** Optional business use-case or route name. */
  useCase?: string;
  /** Optional human-readable reason of finalization. */
  reason?: string;
  /**
   * Optional high-level MAS outcome, used only for diagnostics/metadata.
   *
   * Memory layer does not interpret this directly; adapters MAY map it
   * into textual reason when calling underlying APIs.
   */
  outcome?: 'completed' | 'failed' | 'abandoned';
}

export interface IMasMemoryPort {
  /**
   * Ensure that the given MAS session is bound to a concrete Memory session.
   *
   * Implementations:
   * - resolve tenantId/userId from MasSessionContext or IRequestContext;
   * - resolve or create underlying Memory session;
   * - update MasSessionContext/IRequestContext with resolved session id.
   */
  ensureSessionBinding(
    input: { session: MasSessionContext },
    ctx: IRequestContext,
  ): Promise<MasMemorySessionBinding>;

  /**
   * Build a MAS context window for a given scenario using Memory.
   */
  getContextForScenario(
    input: MasMemoryContextRequest,
    ctx: IRequestContext,
  ): Promise<MasContextWindow>;

  /**
   * Append MAS step messages into Memory, enriching them with MAS metadata.
   */
  appendMasStep(
    input: MasMemoryAppendRequest,
    ctx: IRequestContext,
  ): Promise<void>;

  /**
   * Finalize MAS session at Memory level (e.g. consolidate/end_session).
   */
  finalizeMasSession(
    input: MasMemoryFinalizeRequest,
    ctx: IRequestContext,
  ): Promise<void>;
}