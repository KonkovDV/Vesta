import type {
  IMasMemoryPort,
  MasMemorySessionBinding,
  MasMemoryContextRequest,
  MasMemoryAppendRequest,
  MasMemoryFinalizeRequest,
} from './mas-memory.port';
import type {
  MasSessionContext,
  MasMessage,
  MasMetadataBag,
} from '../types/mas-types';
import {
  BrandedIds,
  type IRequestContext,
} from '../../context/request-context';
import type { IContextCoordinator } from '../core/context-coordinator';
import type { ISessionMemoryManager } from '../../../domain/memory/ISessionMemoryManager';

/**
 * Application-level adapter between MAS Runtime and Memory (Session Memory API).
 *
 * Responsibilities:
 * - resolve and bind MAS sessions to underlying Memory sessions;
 * - delegate context-window operations to IContextCoordinator;
 * - enrich MAS messages with MAS-specific metadata before persisting;
 * - delegate session finalization to IContextCoordinator.
 */
export class MasMemoryAdapterV1 implements IMasMemoryPort {
  constructor(
    private readonly contextCoordinator: IContextCoordinator,
    private readonly sessionMemoryManager: ISessionMemoryManager,
  ) {}

  async ensureSessionBinding(
    input: { session: MasSessionContext },
    ctx: IRequestContext,
  ): Promise<MasMemorySessionBinding> {
    const masSession = input.session;

    const tenantId = this.resolveTenantId(masSession, ctx);
    const userId = this.resolveUserId(masSession, ctx);
    const memorySessionId = await this.resolveOrCreateSessionId(
      masSession,
      ctx,
      tenantId,
      userId,
    );

    return {
      masSession,
      tenantId,
      userId,
      memorySessionId,
    };
  }

  async getContextForScenario(
    input: MasMemoryContextRequest,
    ctx: IRequestContext,
  ) {
    const { session, scenario, useCase, limits, filters } = input;

    // Callers are expected to bind sessions explicitly, but this is cheap
    // and makes the port more robust in edge cases.
    await this.ensureSessionBinding({ session }, ctx);

    return this.contextCoordinator.getContextWindow(
      {
        session,
        scenario,
        useCase,
        limits,
        filters,
        metadata: {
          scenario,
          use_case: useCase,
        },
      },
      ctx,
    );
  }

  async appendMasStep(
    input: MasMemoryAppendRequest,
    ctx: IRequestContext,
  ): Promise<void> {
    const { session, scenario, useCase, stepKind, messages } = input;

    await this.ensureSessionBinding({ session }, ctx);

    const enrichedMessages: MasMessage[] = messages.map(message => {
      const baseMetadata = message.metadata ? { ...message.metadata } : {};

      const metadata: MasMetadataBag = {
        ...baseMetadata,
        // Preserve explicit source when provided; otherwise mark MAS as source.
        source: baseMetadata.source ?? 'mas',
        mas_session_id: session.masSessionId,
        mas_step_kind: stepKind,
        scenario,
      };

      if (useCase) {
        metadata.use_case = useCase;
      }

      if (message.taskId) {
        metadata.mas_task_id = message.taskId;
      }

      if (message.agentId) {
        metadata.mas_agent_id = message.agentId;
      }

      // Optionally propagate structured policy metadata from session/request context.
      const sessionPolicy =
        session.metadata?.policy ?? session.policyDecisions;
      const ctxPolicy = ctx.getMetadata
        ? (ctx.getMetadata('policy'))
        : undefined;
      const existingPolicy = baseMetadata.policy;

      const policy = existingPolicy ?? sessionPolicy ?? ctxPolicy;
      if (policy) {
        metadata.policy = policy;
      }

      return {
        ...message,
        metadata,
      };
    });

    await this.contextCoordinator.appendMessages({
      session,
      requestContext: ctx,
      messages: enrichedMessages,
      metadata: {
        scenario,
        use_case: useCase,
        step_kind: stepKind,
      },
    });
  }

  async finalizeMasSession(
    input: MasMemoryFinalizeRequest,
    ctx: IRequestContext,
  ): Promise<void> {
    const { session } = input;

    await this.ensureSessionBinding({ session }, ctx);

    const metadata: MasMetadataBag = {
      scenario: input.scenario,
    };

    if (input.useCase) {
      metadata.use_case = input.useCase;
    }

    if (input.outcome) {
      metadata.mas_outcome = input.outcome;
    }

    const reasonParts: string[] = [];
    if (input.reason) {
      reasonParts.push(input.reason);
    }
    if (input.outcome) {
      reasonParts.push(`outcome:${input.outcome}`);
    }
    const effectiveReason = reasonParts.length
      ? reasonParts.join(' | ')
      : undefined;

    await this.contextCoordinator.finalizeSession({
      session,
      requestContext: ctx,
      reason: effectiveReason,
      metadata,
    });
  }

  private resolveTenantId(
    session: MasSessionContext,
    ctx: IRequestContext,
  ): string {
    if (session.tenantId) {
      return String(session.tenantId);
    }

    const ctxTenant = ctx.getTenantId();
    if (ctxTenant) {
      // Propagate tenant to MAS session for future calls.
      session.tenantId = ctxTenant;
      return String(ctxTenant);
    }

    throw new Error(
      'MasMemoryAdapterV1.ensureSessionBinding: tenantId is required to interact with SessionMemoryManager',
    );
  }

  private resolveUserId(
    session: MasSessionContext,
    ctx: IRequestContext,
  ): string | undefined {
    if (session.userId) {
      return String(session.userId);
    }

    const ctxUser = ctx.getUserId();
    if (ctxUser) {
      session.userId = ctxUser;
      return String(ctxUser);
    }

    return undefined;
  }

  private async resolveOrCreateSessionId(
    session: MasSessionContext,
    ctx: IRequestContext,
    tenantId: string,
    userId?: string,
  ): Promise<string> {
    // 1) Explicit MAS <-> Memory binding already present.
    if (session.sessionId) {
      const existing = session.sessionId;
      try {
        if (!ctx.getSessionId()) {
          ctx.setSessionId(existing);
        }
      } catch {
        // Best-effort sync; RequestContext issues must not break MAS flow.
      }
      return String(existing);
    }

    // 2) RequestContext already has a session id — treat it as Memory session id.
    try {
      const ctxSessionId = ctx.getSessionId();
      if (ctxSessionId) {
        session.sessionId = ctxSessionId;
        return String(ctxSessionId);
      }
    } catch {
      // If RequestContext is not initialized, fall through to create_session.
    }

    // 3) No existing binding: create a new Memory session.
    if (!userId) {
      throw new Error(
        'MasMemoryAdapterV1.ensureSessionBinding: userId is required to create a new Memory session',
      );
    }

    const correlationId = String(ctx.getCorrelationId());

    const result = await this.sessionMemoryManager.create_session({
      tenant_id: tenantId,
      user_id: userId,
      external_session_ref: String(session.masSessionId),
      initial_context: {
        mas_session_id: session.masSessionId,
        mas_trace_id: session.masTraceId,
      },
      config_override: {},
      correlation_id: correlationId,
    });

    const memorySessionId = result.session_id;
    const brandedSessionId = BrandedIds.createSessionId(String(memorySessionId));

    session.sessionId = brandedSessionId;
    try {
      ctx.setSessionId(brandedSessionId);
    } catch {
      // ignore
    }

    return String(memorySessionId);
  }
}