/**
 * MAS Runtime Core - ContextCoordinatorV1 implementation.
 *
 * Layer: Application (business orchestration).
 *
 * MAS-A1.3 scope (subtask skeleton):
 * - thin adapter over ISessionMemoryManager from Memory layer;
 * - no metrics, events or DI wiring (see MAS-A2 / MAS-A1.6 for that);
 * - basic mapping between MAS types and Memory API DTOs.
 */

import {
  type IRequestContext,
  type CorrelationId,
} from '../../context/request-context';
import type { ILogger } from '../../../core/decorators/ILogger';
import { ensureMasTraceIdsInContext } from '../context/mas-request-context';
import { type EnrichedError } from '../../../core/errors/enriched-error';
import type {
  MasContextWindow,
  MasMessage,
  MasSessionContext,
  ContextRequest,
  MasTaskId,
  AgentId,
  MasKnowledgeSnippet,
  MasContextFilters,
  MasMetadataBag,
} from '../types/mas-types';
import {
  resolveTokenBudget,
  estimateTokensForMessages,
  estimateMessageTokens,
} from '../context/token-budget';
import {
  DEFAULT_PRUNING_CONFIG,
  planPruneContextWindow,
  applyPrunePlanToContextWindow,
} from '../context/context-pruner';
import type {
  IContextCoordinator,
  AppendMessagesRequest,
  FinalizeSessionRequest,
} from '../core/context-coordinator';
import type { ISessionMemoryManager } from '../../../domain/memory/ISessionMemoryManager';
import type {
  SessionMessage,
  SessionRole,
  WorkingMemoryEntry,
} from '../../../domain/memory/session-types';
import { MemoryGovernanceError } from '../../../domain/memory/governance/memory-governance.types';
import {
  incrementMasContextWindowRequests,
  incrementMasMemoryWrite,
  recordMasContextWindowDuration,
  incrementMasErrorsTotal,
  incrementMasMemoryErrorsTotal,
  recordMasContextPruning,
} from '../observability/mas-metrics';
import type { GovernanceStatus } from '../observability/mas-memory-metrics';
import {
  recordMasMemoryContextRequest,
  recordMasMemoryAppend,
  incrementMasMemoryGovernanceDenied,
} from '../observability/mas-memory-metrics';
import type { PolicyDecisionStatus } from '../../security/policy-engine';
import {
  getPolicyDenialsCounter,
  getPolicyEvaluationsCounter,
} from '../../../monitoring';
import {
  emitMasSessionMemoryFinalized,
  emitMasSessionMemoryFinalizationFailed,
  emitMasMemoryContextUsed,
} from '../events/mas-events';
import type { MasMemoryContextUsedEventPayload } from '../events/mas-events';

type EventGovernanceStatus =
  | 'ok'
  | 'deny'
  | 'allow_with_modifications'
  | 'unknown';

function mapGovernanceStatusForEvent(
  status: GovernanceStatus,
): EventGovernanceStatus {
  if (status === 'fallback') {
    return 'unknown';
  }
  return status;
}

const MAS_INLINE_POLICY_SOURCE = 'mas_inline_memory';
const MAS_INLINE_POLICY_RESOURCE = 'memory.session';
const masInlinePolicyEvaluations = getPolicyEvaluationsCounter();
const masInlinePolicyDenials = getPolicyDenialsCounter();

export class ContextCoordinatorV1 implements IContextCoordinator {
  constructor(
    private readonly sessionMemoryManager: ISessionMemoryManager,
    private readonly logger?: ILogger,
  ) {}

  async getContextWindow(
    request: ContextRequest,
    requestContext: IRequestContext,
  ): Promise<MasContextWindow> {
    const tenantId = this.resolveTenantId(request.session, requestContext);
    const sessionId = this.resolveSessionId(request.session, requestContext);
    const userId = this.resolveUserId(request.session, requestContext);

    // Ensure MAS context is propagated
    this.ensureMasContext(request.session, requestContext);

    const startTime = process.hrtime.bigint();
    let outcome: 'success' | 'error' = 'success';
    let governanceStatus: GovernanceStatus = 'ok';
    let policyReason: string | undefined = 'ok';

    // Snapshot limits up-front to avoid accidental mutation of the request DTO.
    const limits = request.limits ?? {};
    const filters = request.filters ?? {};

    const correlationId = String(
      requestContext.getCorrelationId() ?? request.session.correlationId,
    );
    const scenario = request.scenario ?? (request.metadata?.scenario as string | undefined);
    const useCase =
      request.useCase ??
      (request.metadata?.use_case as string | undefined) ??
      (request.metadata?.useCase as string | undefined);

    try {
      const memoryWindow = await this.sessionMemoryManager.get_context_window({
        tenant_id: tenantId,
        session_id: sessionId,
        max_messages: limits.maxMessages,
        max_tokens: limits.maxTokens,
        correlation_id: correlationId,
        // NOTE: ContextRequest.filters (MasContextFilters) and other advanced
        // fields are intentionally not mapped to Memory API at MAS-B2.4.2 stage.
        // They are reserved for future MAS-B2.4.3+ work when Memory exposes
        // richer query capabilities for channel-/knowledge-aware context.
      });

      const messages = memoryWindow.messages.map(message =>
        this.mapSessionMessageToMasMessage(message),
      );

      const metadata: MasMetadataBag = {
        source: 'session_memory_v1',
        sessionId: memoryWindow.session_id,
        appliedLimits: {
          maxMessages: limits.maxMessages,
          maxTokens: limits.maxTokens,
        },
      };

      let knowledgeSnippets: MasKnowledgeSnippet[] = [];
      let originalKnowledgeItems: number | undefined;

      // Knowledge enrichment is best-effort: failures must not break MAS context
      // window retrieval. Any backend errors are handled/logged in Memory layer.
      try {
        const sessionState = await this.sessionMemoryManager.get_session_state({
          tenant_id: tenantId,
          session_id: sessionId,
        });

        knowledgeSnippets = this.mapWorkingMemoryToKnowledgeSnippets(
          sessionState.working_memory ?? [],
          filters,
        );

        originalKnowledgeItems = knowledgeSnippets.length;
        metadata.knowledge = {
          enabled: true,
          items: knowledgeSnippets.length,
          source: 'session_memory_working_memory_v1',
        };
      } catch {
        // Degrade gracefully when knowledge backends are unavailable or error out.
        knowledgeSnippets = [];
        originalKnowledgeItems = 0;
        metadata.knowledge = {
          enabled: false,
        };
      }

      if (request.filters) {
        metadata.filters = request.filters;
      }

      let contextWindow: MasContextWindow = {
        messages,
        knowledgeSnippets,
        metadata,
      };

      let plan:
        | ReturnType<typeof planPruneContextWindow>
        | undefined;
      let tokensBefore: number | undefined;
      let messagesBefore: number | undefined;

      try {
        const budget = resolveTokenBudget(request.session);
        tokensBefore = estimateTokensForMessages(messages);
        messagesBefore = messages.length;

        plan = planPruneContextWindow(
          contextWindow.messages,
          budget,
          DEFAULT_PRUNING_CONFIG,
        );

        if (plan.shouldPrune) {
          contextWindow = applyPrunePlanToContextWindow(contextWindow, plan);
        }

        const messageTokensAfter = estimateTokensForMessages(
          contextWindow.messages,
        );

        if (contextWindow.knowledgeSnippets?.length) {
          const prunedKnowledge = this.pruneKnowledgeSnippetsForBudget(
            contextWindow.knowledgeSnippets,
            budget.maxContextTokens,
            messageTokensAfter,
          );

          contextWindow = {
            ...contextWindow,
            knowledgeSnippets: prunedKnowledge,
          };
        }

        if (
          contextWindow.metadata &&
          typeof originalKnowledgeItems === 'number'
        ) {
          const metaRecord = contextWindow.metadata;
          const knowledgeMeta = (metaRecord.knowledge ?? {}) as MasMetadataBag;
          const itemsAfter = contextWindow.knowledgeSnippets?.length ?? 0;

          metaRecord.knowledge = {
            ...knowledgeMeta,
            items: itemsAfter,
            originalItems: originalKnowledgeItems,
            pruned: itemsAfter < originalKnowledgeItems,
          };
        }
      } catch (pruningError) {
        governanceStatus = 'fallback';
        policyReason = 'token_pruning_error';

        incrementMasErrorsTotal({
          component: 'context_coordinator',
          errorType:
            pruningError instanceof Error ? pruningError.name : 'UnknownError',
        });

        if (this.logger) {
          this.logger.warn('mas_context_pruning_error', {
            component: 'ContextCoordinatorV1',
            tenantId,
            sessionId,
            error_name:
              pruningError instanceof Error ? pruningError.name : undefined,
          });
        }
      }

      const messagesReturned = contextWindow.messages.length;
      const knowledgeSnippetsReturned =
        contextWindow.knowledgeSnippets?.length ?? 0;

      if (
        plan &&
        typeof tokensBefore === 'number' &&
        typeof messagesBefore === 'number'
      ) {
        recordMasContextPruning({
          scenario,
          result: plan.shouldPrune ? 'pruned' : 'skipped',
          tokensBefore,
          tokensAfter: plan.tokensAfter,
          messagesBefore,
          messagesAfter: messagesReturned,
        });
      }

      const payload: MasMemoryContextUsedEventPayload = {
        mas_session_id: String(request.session.masSessionId),
        mas_trace_id: request.session.masTraceId
          ? String(request.session.masTraceId)
          : undefined,
        scenario: typeof scenario === 'string' ? scenario : undefined,
        use_case: typeof useCase === 'string' ? useCase : undefined,
        tenant_id: tenantId,
        user_id: userId,
        session_id: String(memoryWindow.session_id ?? sessionId),
        messages_returned: messagesReturned,
        knowledge_snippets_returned: knowledgeSnippetsReturned,
        governance_status: mapGovernanceStatusForEvent(governanceStatus),
        applied_limits:
          typeof limits.maxMessages === 'number' ||
          typeof limits.maxTokens === 'number'
            ? {
                max_messages: limits.maxMessages,
                max_tokens: limits.maxTokens,
              }
            : undefined,
        filters: request.filters,
        timestamp: new Date().toISOString(),
        correlation_id: correlationId,
      };

      await emitMasMemoryContextUsed({
        aggregateId: String(memoryWindow.session_id ?? sessionId),
        payload,
      });

      return contextWindow;
    } catch (error) {
      outcome = 'error';

      if (error instanceof MemoryGovernanceError) {
        // Governance-level deny: degrade to an empty context window instead of
        // propagating an exception to MAS callers.
        governanceStatus = 'deny';
        policyReason = error.reason;

        incrementMasMemoryErrorsTotal({
          operation: 'get_context_window',
        });

        try {
          incrementMasMemoryGovernanceDenied({
            operation: 'get_context_window',
            scope: 'session',
            reason: error.reason,
          });
        } catch {
          // ignore metric errors
        }

        const metadata: MasMetadataBag = {
          source: 'session_memory_v1',
          sessionId,
          appliedLimits: {
            maxMessages: limits.maxMessages,
            maxTokens: limits.maxTokens,
          },
          governance: {
            status: 'deny',
            reason: error.reason,
          },
        };

        if (request.filters) {
          metadata.filters = request.filters;
        }

        const payload: MasMemoryContextUsedEventPayload = {
          mas_session_id: String(request.session.masSessionId),
          mas_trace_id: request.session.masTraceId
            ? String(request.session.masTraceId)
            : undefined,
          scenario: typeof scenario === 'string' ? scenario : undefined,
          use_case: typeof useCase === 'string' ? useCase : undefined,
          tenant_id: tenantId,
          user_id: userId,
          session_id: sessionId,
          messages_returned: 0,
          knowledge_snippets_returned: 0,
          governance_status: mapGovernanceStatusForEvent(governanceStatus),
          applied_limits:
            typeof limits.maxMessages === 'number' ||
            typeof limits.maxTokens === 'number'
              ? {
                  max_messages: limits.maxMessages,
                  max_tokens: limits.maxTokens,
                }
              : undefined,
          filters: request.filters,
          timestamp: new Date().toISOString(),
          correlation_id: correlationId,
        };

        await emitMasMemoryContextUsed({
          aggregateId: sessionId,
          payload,
        });

        return {
          messages: [],
          knowledgeSnippets: [],
          metadata,
        };
      }

      governanceStatus = 'fallback';
      policyReason = 'fallback';

      incrementMasErrorsTotal({
        component: 'context_coordinator',
        errorType: error instanceof Error ? error.name : undefined,
      });

      incrementMasMemoryErrorsTotal({
        operation: 'get_context_window',
      });

      if (this.logger) {
        this.logger.warn('mas_memory_backend_get_context_window_error', {
          component: 'ContextCoordinatorV1',
          tenantId,
          sessionId,
          error_name: error instanceof Error ? error.name : undefined,
        });
      }

      const metadata: MasMetadataBag = {
        source: 'session_memory_v1',
        sessionId,
        appliedLimits: {
          maxMessages: limits.maxMessages,
          maxTokens: limits.maxTokens,
        },
        fallback: {
          reason: 'backend_error',
        },
      };

      if (request.filters) {
        metadata.filters = request.filters;
      }

      const payload: MasMemoryContextUsedEventPayload = {
        mas_session_id: String(request.session.masSessionId),
        mas_trace_id: request.session.masTraceId
          ? String(request.session.masTraceId)
          : undefined,
        scenario: typeof scenario === 'string' ? scenario : undefined,
        use_case: typeof useCase === 'string' ? useCase : undefined,
        tenant_id: tenantId,
        user_id: userId,
        session_id: sessionId,
        messages_returned: 0,
        knowledge_snippets_returned: 0,
        governance_status: mapGovernanceStatusForEvent(governanceStatus),
        applied_limits:
          typeof limits.maxMessages === 'number' ||
          typeof limits.maxTokens === 'number'
            ? {
                max_messages: limits.maxMessages,
                max_tokens: limits.maxTokens,
              }
            : undefined,
        filters: request.filters,
        timestamp: new Date().toISOString(),
        correlation_id: correlationId,
      };

      await emitMasMemoryContextUsed({
        aggregateId: sessionId,
        payload,
      });

      return {
        messages: [],
        knowledgeSnippets: [],
        metadata,
      };
    } finally {
      const durationSeconds = Number(process.hrtime.bigint() - startTime) / 1e9;
      incrementMasContextWindowRequests({ outcome });
      recordMasContextWindowDuration({ outcome, durationSeconds });

      recordMasMemoryContextRequest({
        scenario: typeof scenario === 'string' ? scenario : undefined,
        useCase: typeof useCase === 'string' ? useCase : undefined,
        outcome,
        governanceStatus,
        durationSeconds,
      });

      this.recordInlinePolicyDecision({
        operation: 'get_context_window',
        status: this.mapGovernanceToPolicyStatus(governanceStatus),
        reason: policyReason,
      });
    }
  }

  async appendMessages(request: AppendMessagesRequest): Promise<void> {
    const { session, messages, requestContext } = request;
    const tenantId = this.resolveTenantId(session, requestContext);
    const sessionId = this.resolveSessionId(session, requestContext);
    const userId = this.resolveUserId(session, requestContext);
    const correlationId = String(requestContext.getCorrelationId());

    // Ensure MAS context is propagated
    this.ensureMasContext(session, requestContext);

    const startTime = process.hrtime.bigint();
    let outcome: 'success' | 'error' = 'success';
    let governanceStatus: GovernanceStatus = 'ok';
    let policyReason: string | undefined = 'ok';

    const stepKind =
      (request.metadata?.step_kind) ?? 'system';
    const scenario = request.metadata?.scenario;
    const useCase = request.metadata?.use_case;

    try {
      for (const message of messages) {
        const content = this.normalizeContent(message.content);
        const role = this.mapMasRoleToSessionRole(message.role);

        const metadata = {
          ...(message.metadata ?? {}),
          // Preserve existing source when explicitly set, otherwise mark MAS as source.
          source: (message.metadata?.source as string | undefined) ?? 'mas',
        };

        try {
          await this.sessionMemoryManager.add_message({
            tenant_id: tenantId,
            session_id: sessionId,
            user_id: userId,
            role,
            modality: 'text',
            content,
            metadata,
            correlation_id: correlationId,
          });
        } catch (error) {
          if (error instanceof MemoryGovernanceError) {
            // Governance deny for memory write: degrade gracefully and continue MAS orchestration.
            outcome = 'error';
            governanceStatus = 'deny';
            policyReason = error.reason;

            incrementMasMemoryErrorsTotal({
              operation: 'append_messages',
            });

            try {
              incrementMasMemoryGovernanceDenied({
                operation: 'append_messages',
                scope: 'session',
                reason: error.reason,
              });
            } catch {
              // ignore metric errors
            }

            if (this.logger) {
              this.logger.warn(
                'mas_memory_governance_append_messages_denied',
                {
                  component: 'ContextCoordinatorV1',
                  tenantId,
                  sessionId,
                  reason: error.reason,
                },
              );
            }

            // Skip persisting this particular message but continue with the rest.
            continue;
          }

          // Non-governance error: rethrow to be handled by the outer catch.
          throw error;
        }
      }
    } catch (error) {
      outcome = 'error';
      governanceStatus = 'fallback';
      policyReason = 'fallback';

      incrementMasErrorsTotal({
        component: 'context_coordinator',
        errorType: error instanceof Error ? error.name : undefined,
      });

      incrementMasMemoryErrorsTotal({
        operation: 'append_messages',
      });

      if (this.logger) {
        this.logger.warn('mas_memory_backend_append_messages_error', {
          component: 'ContextCoordinatorV1',
          tenantId,
          sessionId,
          error_name: error instanceof Error ? error.name : undefined,
        });
      }

      // Do not rethrow: degrade gracefully on backend errors.
    } finally {
      incrementMasMemoryWrite({
        operation: 'append_messages',
        outcome,
      });

      const durationSeconds =
        Number(process.hrtime.bigint() - startTime) / 1e9;

      recordMasMemoryAppend({
        scenario,
        useCase,
        stepKind:
          stepKind as import('../memory/mas-memory.port').MasStepKind,
        outcome,
        governanceStatus,
        durationSeconds,
      });

      this.recordInlinePolicyDecision({
        operation: 'append_messages',
        status: this.mapGovernanceToPolicyStatus(governanceStatus),
        reason: policyReason,
      });
    }
  }

  async finalizeSession(request: FinalizeSessionRequest): Promise<void> {
    const { session, requestContext, reason } = request;
    const tenantId = this.resolveTenantId(session, requestContext);
    const sessionId = this.resolveSessionId(session, requestContext);
    const correlationId = String(requestContext.getCorrelationId());

    // Ensure MAS context is propagated
    this.ensureMasContext(session, requestContext);

    const startTime = process.hrtime.bigint();
    let outcome: 'success' | 'error' = 'success';
    let lastOperation:
      | 'consolidate_session'
      | 'end_session'
      | 'finalize_session' = 'finalize_session';
    let governanceStatus: GovernanceStatus = 'ok';
    let policyReason: string | undefined = 'ok';

    const scenario = request.metadata?.scenario as string | undefined;
    const useCase = request.metadata?.use_case as string | undefined;

    try {
      // 1) Give Session Memory a chance to consolidate the session history before
      //    final archival. Error-handling and mode-specific behavior are delegated
      //    to ISessionMemoryManager / DualWriteMemoryManager.
      lastOperation = 'consolidate_session';
      await this.sessionMemoryManager.consolidate_session({
        tenant_id: tenantId,
        session_id: sessionId,
        strategy: 'auto',
        correlation_id: correlationId,
      });

      // 2) Finalize/close the underlying memory session.
      lastOperation = 'end_session';
      await this.sessionMemoryManager.end_session({
        tenant_id: tenantId,
        session_id: sessionId,
        reason,
        correlation_id: correlationId,
      });

      await emitMasSessionMemoryFinalized({
        session,
        tenantId,
        sessionId,
        reason,
        requestContext,
      });
    } catch (error) {
      outcome = 'error';

      if (error instanceof MemoryGovernanceError) {
        governanceStatus = 'deny';
        policyReason = error.reason;

        const operationForMetrics:
          | 'finalize_session'
          | 'consolidate_session'
          | 'end_session' =
          lastOperation === 'consolidate_session' ||
          lastOperation === 'end_session'
            ? lastOperation
            : 'finalize_session';

        incrementMasMemoryErrorsTotal({
          operation: operationForMetrics,
        });

        try {
          incrementMasMemoryGovernanceDenied({
            operation: 'finalize_session',
            scope: 'session',
            reason: error.reason,
          });
        } catch {
          // ignore metric errors
        }

        const governanceReason = `memory_governance_deny:${error.reason}`;

        await emitMasSessionMemoryFinalizationFailed({
          session,
          tenantId,
          sessionId,
          reason: governanceReason,
          // Provide a sanitized error object without tenant/session identifiers.
          error: new Error(
            'Memory governance denied memory session finalization',
          ),
          requestContext,
        });

        if (this.logger) {
          this.logger.warn('mas_memory_governance_finalize_session_denied', {
            component: 'ContextCoordinatorV1',
            tenantId,
            sessionId,
            operation: lastOperation,
            reason: error.reason,
          });
        }

        // Governance deny must not surface as an exception to MAS callers.
        return;
      }

      governanceStatus = 'fallback';
      policyReason = 'fallback';

      incrementMasErrorsTotal({
        component: 'context_coordinator',
        errorType: error instanceof Error ? error.name : undefined,
      });

      const operationForMetrics:
        | 'finalize_session'
        | 'consolidate_session'
        | 'end_session' = lastOperation;

      incrementMasMemoryErrorsTotal({
        operation: operationForMetrics,
      });

      await emitMasSessionMemoryFinalizationFailed({
        session,
        tenantId,
        sessionId,
        reason,
        error,
        requestContext,
      });

      if (this.logger) {
        this.logger.warn('mas_memory_backend_finalize_session_error', {
          component: 'ContextCoordinatorV1',
          tenantId,
          sessionId,
          operation: lastOperation,
          error_name: error instanceof Error ? error.name : undefined,
        });
      }

      // Do not rethrow: degrade gracefully on backend errors.
    } finally {
      incrementMasMemoryWrite({
        operation: 'finalize_session',
        outcome,
      });

      const durationSeconds =
        Number(process.hrtime.bigint() - startTime) / 1e9;

      recordMasMemoryAppend({
        scenario,
        useCase,
        stepKind: 'system',
        outcome,
        governanceStatus,
        durationSeconds,
      });

      this.recordInlinePolicyDecision({
        operation: 'finalize_session',
        status: this.mapGovernanceToPolicyStatus(governanceStatus),
        reason: policyReason,
      });
    }
  }

  private resolveTenantId(
    session: MasSessionContext,
    requestContext: IRequestContext,
  ): string {
    if (session.tenantId) {
      return String(session.tenantId);
    }

    const tenantId = requestContext.getTenantId();
    if (tenantId) {
      return String(tenantId);
    }

    throw new Error(
      'ContextCoordinatorV1: tenantId is required to interact with SessionMemoryManager',
    );
  }

  private resolveSessionId(
    session: MasSessionContext,
    requestContext: IRequestContext,
  ): string {
    if (session.sessionId) {
      return String(session.sessionId);
    }

    const ctxSessionId = requestContext.getSessionId();
    if (ctxSessionId) {
      return String(ctxSessionId);
    }

    // Fallback: use MAS-level session identifier when no explicit mapping is provided.
    return String(session.masSessionId);
  }

  private resolveUserId(
    session: MasSessionContext,
    requestContext: IRequestContext,
  ): string | undefined {
    if (session.userId) {
      return String(session.userId);
    }

    const userId = requestContext.getUserId();
    return userId ? String(userId) : undefined;
  }

  private ensureMasContext(
    session: MasSessionContext,
    requestContext: IRequestContext,
  ): void {
    const correlationId = requestContext.getCorrelationId();
    // Do we need full IRequestContext here? ensureMasTraceIdsInContext probably expects IRequestContext.
    // If ensureMasTraceIdsInContext expects IRequestContext, we might need a cast or check.
    // However, IRequestContext extends IRoutingContext typically.
    // Let's assume ensureMasTraceIdsInContext needs IRequestContext.
    ensureMasTraceIdsInContext(session, requestContext); 
  }

  private mapSessionMessageToMasMessage(message: SessionMessage): MasMessage {
    const metadata = message.metadata ?? {};
    const metaRecord = metadata as MasMetadataBag;
    const rawTaskId = metaRecord.mas_task_id ?? metaRecord.taskId;
    const rawAgentId = metaRecord.mas_agent_id ?? metaRecord.agentId;

    const masMessage: MasMessage = {
      id: message.message_id,
      role: this.mapSessionRoleToMasRole(message.role),
      content: message.content,
      createdAt: new Date(message.created_at),
      metadata,
    };

    if (rawTaskId) {
      masMessage.taskId = rawTaskId as MasTaskId;
    }

    if (rawAgentId) {
      masMessage.agentId = rawAgentId as AgentId;
    }

    return masMessage;
  }

  private mapWorkingMemoryToKnowledgeSnippets(
    entries: WorkingMemoryEntry[],
    filters?: MasContextFilters,
  ): MasKnowledgeSnippet[] {
    if (!entries?.length) {
      return [];
    }

    const knowledgeSourcesFilter =
      filters?.knowledgeSources && filters.knowledgeSources.length
        ? new Set(filters.knowledgeSources.map(source => source.toLowerCase()))
        : undefined;

    const timeRange = filters?.timeRange;
    const hasTimeRangeBounds =
      !!timeRange &&
      (typeof timeRange.from === 'string' ||
        typeof timeRange.to === 'string');

    let fromDate: Date | undefined;
    let toDate: Date | undefined;

    if (hasTimeRangeBounds && timeRange?.from) {
      const parsedFrom = new Date(timeRange.from);
      if (!Number.isNaN(parsedFrom.getTime())) {
        fromDate = parsedFrom;
      }
    }

    if (hasTimeRangeBounds && timeRange?.to) {
      const parsedTo = new Date(timeRange.to);
      if (!Number.isNaN(parsedTo.getTime())) {
        toDate = parsedTo;
      }
    }

    const rawQuery = filters?.query?.trim();
    const hasQuery = typeof rawQuery === 'string' && rawQuery.length > 0;
    const queryLower = hasQuery ? rawQuery.toLowerCase() : undefined;

    const maxKnowledgeSnippets =
      filters?.maxKnowledgeSnippets && filters.maxKnowledgeSnippets > 0
        ? filters.maxKnowledgeSnippets
        : undefined;

    const hasEffectiveFilters =
      (knowledgeSourcesFilter && knowledgeSourcesFilter.size > 0) ||
      fromDate ||
      toDate ||
      hasQuery ||
      typeof maxKnowledgeSnippets === 'number';

    // When no effective filters are provided, preserve legacy behavior:
    // map all entries 1:1 without reordering.
    if (!hasEffectiveFilters) {
      return entries.map(entry =>
        this.mapWorkingMemoryEntryToKnowledgeSnippet(entry),
      );
    }

    type WorkingEntryWithDerived = {
      entry: WorkingMemoryEntry;
      source: string;
      index: number;
    };

    let candidates: WorkingEntryWithDerived[] = entries.map(
      (entry, index) => ({
        entry,
        source: this.resolveKnowledgeSourceFromWorkingMemoryEntry(entry),
        index,
      }),
    );

    if (knowledgeSourcesFilter && knowledgeSourcesFilter.size > 0) {
      candidates = candidates.filter(candidate =>
        candidate.source
          ? knowledgeSourcesFilter.has(candidate.source.toLowerCase())
          : false,
      );
    }

    if (fromDate || toDate) {
      candidates = candidates.filter(({ entry }) => {
        const entryDate = new Date(entry.timestamp);
        if (Number.isNaN(entryDate.getTime())) {
          // Fail-open for bad timestamps so that knowledge is not silently dropped.
          return true;
        }

        if (fromDate && entryDate < fromDate) {
          return false;
        }

        if (toDate && entryDate > toDate) {
          return false;
        }

        return true;
      });
    }

    if (!candidates.length) {
      return [];
    }

    if (hasQuery && queryLower) {
      candidates.sort((a, b) => {
        const aSummary = a.entry.summary ?? '';
        const bSummary = b.entry.summary ?? '';

        const aMatches = aSummary.toLowerCase().includes(queryLower);
        const bMatches = bSummary.toLowerCase().includes(queryLower);

        if (aMatches !== bMatches) {
          // Entries whose summary matches the query go first.
          return aMatches ? -1 : 1;
        }

        const importanceDiff = b.entry.importance - a.entry.importance;
        if (importanceDiff !== 0) {
          // Higher-importance snippets go first.
          return importanceDiff;
        }

        // Stable fallback to preserve original ordering when importance is equal.
        return a.index - b.index;
      });
    }

    if (typeof maxKnowledgeSnippets === 'number') {
      candidates = candidates.slice(0, maxKnowledgeSnippets);
    }

    return candidates.map(candidate =>
      this.mapWorkingMemoryEntryToKnowledgeSnippet(
        candidate.entry,
        candidate.source,
      ),
    );
  }

  private mapWorkingMemoryEntryToKnowledgeSnippet(
    entry: WorkingMemoryEntry,
    resolvedSource?: string,
  ): MasKnowledgeSnippet {
    const metadata: MasMetadataBag = {
      type: entry.type,
      originalCount: entry.original_count,
      timestamp: entry.timestamp,
      importance: entry.importance,
    };

    if (entry.hsg_pointer) {
      metadata.hsgPointer = {
        primarySector: entry.hsg_pointer.primary_sector,
        sectors: entry.hsg_pointer.sectors,
        hsgId: entry.hsg_pointer.hsg_id,
        graphTags: entry.hsg_pointer.graph_tags,
      };
    }

    if (entry.vector_pointer) {
      metadata.vectorPointer = {
        collection: entry.vector_pointer.collection,
        vectorId: entry.vector_pointer.vector_id,
        embeddingDim: entry.vector_pointer.embedding_dim,
      };
    }

    let id: string | undefined;
    if (entry.hsg_pointer?.hsg_id) {
      id = entry.hsg_pointer.hsg_id;
    } else if (entry.vector_pointer?.vector_id) {
      id = entry.vector_pointer.vector_id;
    }

    return {
      id,
      content: entry.summary,
      source:
        resolvedSource ??
        this.resolveKnowledgeSourceFromWorkingMemoryEntry(entry),
      score: entry.importance,
      metadata,
    };
  }

  private pruneKnowledgeSnippetsForBudget(
    snippets: MasKnowledgeSnippet[] | undefined,
    budgetMaxTokens: number,
    usedTokensByMessages: number,
  ): MasKnowledgeSnippet[] | undefined {
    if (!snippets?.length) {
      return snippets;
    }

    if (usedTokensByMessages >= budgetMaxTokens) {
      // No budget left for knowledge; drop all snippets to keep the context
      // window within the model limits.
      return [];
    }

    const remainingBudget = budgetMaxTokens - usedTokensByMessages;

    type ScoredSnippet = {
      snippet: MasKnowledgeSnippet;
      tokens: number;
      index: number;
    };

    const scored: ScoredSnippet[] = snippets.map((snippet, index) => {
      const pseudoMessage: MasMessage = {
        role: 'system',
        content: snippet.content,
      };
      const tokens = estimateMessageTokens(pseudoMessage);
      return { snippet, tokens, index };
    });

    scored.sort((a, b) => {
      const scoreA =
        typeof a.snippet.score === 'number' ? a.snippet.score : 0;
      const scoreB =
        typeof b.snippet.score === 'number' ? b.snippet.score : 0;

      if (scoreA !== scoreB) {
        return scoreB - scoreA;
      }

      return a.index - b.index;
    });

    const kept: MasKnowledgeSnippet[] = [];
    let tokensUsed = 0;

    for (const { snippet, tokens } of scored) {
      if (tokensUsed + tokens > remainingBudget) {
        continue;
      }
      kept.push(snippet);
      tokensUsed += tokens;
    }

    // If nothing fits into the remaining budget, keep the single best snippet
    // to avoid completely starving the model of long-term context.
    if (!kept.length && scored.length > 0) {
      kept.push(scored[0].snippet);
    }

    const keptSet = new Set(kept);
    return snippets.filter(snippet => keptSet.has(snippet));
  }

  private resolveKnowledgeSourceFromWorkingMemoryEntry(
    entry: WorkingMemoryEntry,
  ): string {
    switch (entry.type) {
      case 'user_profile':
        return 'long_term_user_profile';
      case 'preference':
        return 'user_preference';
      case 'episodic_reference':
        return 'episodic_memory';
      case 'consolidated_context':
      default:
        return 'session_consolidated_context';
    }
  }

  private mapSessionRoleToMasRole(role: SessionRole): MasMessage['role'] {
    // Session roles are a subset of MAS roles.
    switch (role) {
      case 'user':
      case 'assistant':
      case 'system':
      case 'tool':
        return role;
      default:
        return 'system';
    }
  }

  private mapMasRoleToSessionRole(role: MasMessage['role']): SessionRole {
    switch (role) {
      case 'user':
      case 'assistant':
      case 'system':
      case 'tool':
        return role;
      case 'agent':
        // Internal MAS agents are persisted as "assistant" messages in Memory.
        return 'assistant';
      default:
        return 'system';
    }
  }

  private mapGovernanceToPolicyStatus(
    status: GovernanceStatus,
  ): PolicyDecisionStatus {
    if (status === 'deny') {
      return 'deny';
    }
    if (status === 'fallback') {
      return 'allow_with_constraints';
    }
    return 'allow';
  }

  private recordInlinePolicyDecision(params: {
    operation: string;
    status: PolicyDecisionStatus;
    reason?: string;
  }): void {
    try {
      masInlinePolicyEvaluations.inc({
        status: params.status,
        source: MAS_INLINE_POLICY_SOURCE,
        resource: params.operation,
      });

      if (params.status === 'deny') {
        const reason = params.reason ?? 'unknown';
        masInlinePolicyDenials.inc({
          reason,
          severity: this.mapInlineSeverity(reason),
          source: MAS_INLINE_POLICY_SOURCE,
        });
      }
    } catch {
      // Policy metrics must never affect MAS runtime stability.
    }
  }

  private mapInlineSeverity(reason: string): 'critical' | 'warning' | 'info' {
    if (reason.includes('policy') || reason.includes('deny')) {
      return 'critical';
    }
    if (reason.includes('limit') || reason.includes('quota')) {
      return 'warning';
    }
    return 'info';
  }

  private normalizeContent(content: MasMessage['content']): string {
    if (typeof content === 'string') {
      return content;
    }

    try {
      return JSON.stringify(content);
    } catch {
      return String(content);
    }
  }

  private wrapError(operation: string, error: unknown): Error {
    if (error instanceof Error) {
      const wrapped = new Error(
        'ContextCoordinatorV1.' + operation + ' failed: ' + error.message,
      );
      (wrapped as EnrichedError).originalError = error;
      return wrapped;
    }

    return new Error(
      'ContextCoordinatorV1.' + operation + ' failed: ' + String(error),
    );
  }
}