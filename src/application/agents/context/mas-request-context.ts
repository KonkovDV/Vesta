/**
 * MAS Runtime Core - helpers for bridging MasRequest / MasSessionContext
 * with IRequestContext.
 *
 * Layer: Application (business orchestration).
 *
 * MAS-A2.1 scope:
 * - centralize creation and normalization of MasSessionContext;
 * - guarantee consistent MasSessionId / MasTraceId / correlationId handling;
 * - provide a single place to evolve MAS diagnostics and tracing.
 */

import type {
  IRoutingContext,
  CorrelationId,
} from '../../../domain/routing/IRoutingContext';
import type { IRequestContext } from '../../context/request-context';
import { BrandedIds } from '../../context/request-context';
import { IdGenerator } from '../../../core/utils/IdGenerator';
import type {
  MasRequest,
  MasSessionContext,
  MasSessionId,
  MasTraceId,
  MasTaskId,
  MasAgentExecutionId,
  TokenBudget,
  PolicyDecisionRecord,
  MasMetadataBag,
} from '../types/mas-types';

type MasMetadata = {
  session_id?: string;
  task_id?: string;
  agent_execution_id?: string;
  trace_id?: string;
  token_budget?: TokenBudget;
  policy_decisions?: PolicyDecisionRecord;
  debug_flags?: MasMetadataBag;
} & MasMetadataBag;

function readMasMetadata(ctx: IRequestContext): MasMetadata | undefined {
  try {
    const raw = ctx.getMetadata('mas');
    if (!raw || typeof raw !== 'object') {
      return undefined;
    }
    return raw as MasMetadata;
  } catch {
    return undefined;
  }
}

function writeMasMetadata(ctx: IRequestContext, metadata: MasMetadata): void {
  try {
    ctx.addMetadata('mas', metadata);
  } catch {
    // Metadata errors must never break MAS business logic.
  }
}

/**
 * Read MAS session identifier from IRequestContext in a type-safe way.
 *
 * This helper is the single MAS-aware entrypoint for accessing masSessionId
 * on RequestContext. Internally it now prefers metadata.mas.session_id but
 * falls back to the dedicated masSessionId field for backward compatibility.
 */
export function getMasSessionId(
  ctx: IRequestContext,
): MasSessionId | undefined {
  const metadata = readMasMetadata(ctx);
  if (metadata?.session_id) {
    try {
      return BrandedIds.createMasSessionId(
        String(metadata.session_id),
      );
    } catch {
      // fall through to direct field
    }
  }

  try {
    return ctx.getMasSessionId();
  } catch {
    return undefined;
  }
}

/**
 * Set MAS session identifier on IRequestContext.
 *
 * MAS code must always go through this helper rather than calling
 * ctx.setMasSessionId() напрямую, чтобы детали хранения оставались
 * инкапсулированы в одном месте. Helper синхронизирует как поле
 * masSessionId, так и metadata.mas.session_id.
 */
export function setMasSessionId(
  ctx: IRequestContext,
  masSessionId: MasSessionId,
): void {
  try {
    ctx.setMasSessionId(masSessionId);
  } catch {
    // ignore RequestContext initialization issues for MAS helpers
  }

  const current = readMasMetadata(ctx) ?? {};
  const updated: MasMetadata = {
    ...current,
    session_id: String(masSessionId),
  };
  writeMasMetadata(ctx, updated);
}

/**
 * Read MAS trace identifier from IRequestContext in a type-safe way.
 */
export function getMasTraceId(
  ctx: IRequestContext,
): MasTraceId | undefined {
  const metadata = readMasMetadata(ctx);
  if (metadata?.trace_id) {
    try {
      return BrandedIds.createMasTraceId(
        String(metadata.trace_id),
      );
    } catch {
      // fall through to direct field
    }
  }

  try {
    return ctx.getMasTraceId();
  } catch {
    return undefined;
  }
}

/**
 * Set MAS trace identifier on IRequestContext.
 *
 * Helper синхронизирует как поле masTraceId, так и metadata.mas.trace_id.
 */
export function setMasTraceId(
  ctx: IRequestContext,
  masTraceId: MasTraceId,
): void {
  try {
    ctx.setMasTraceId(masTraceId);
  } catch {
    // ignore RequestContext initialization issues for MAS helpers
  }

  const current = readMasMetadata(ctx) ?? {};
  const updated: MasMetadata = {
    ...current,
    trace_id: String(masTraceId),
  };
  writeMasMetadata(ctx, updated);
}

/**
 * Get MAS-level token budget from RequestContext metadata, if present.
 */
export function getMasTokenBudget(
  ctx: IRequestContext,
): TokenBudget | undefined {
  const metadata = readMasMetadata(ctx);
  return metadata?.token_budget;
}

/**
 * Persist MAS-level token budget into RequestContext metadata.
 */
export function setMasTokenBudget(
  ctx: IRequestContext,
  tokenBudget: TokenBudget | undefined,
): void {
  const current = readMasMetadata(ctx) ?? {};
  const updated: MasMetadata = {
    ...current,
    token_budget: tokenBudget,
  };
  writeMasMetadata(ctx, updated);
}

/**
 * Get MAS-level policy decisions snapshot from RequestContext metadata.
 */
export function getMasPolicyDecisions(
  ctx: IRequestContext,
): PolicyDecisionRecord | undefined {
  const metadata = readMasMetadata(ctx);
  return metadata?.policy_decisions;
}

/**
 * Persist MAS-level policy decisions into RequestContext metadata.
 */
export function setMasPolicyDecisions(
  ctx: IRequestContext,
  policyDecisions: PolicyDecisionRecord | undefined,
): void {
  const current = readMasMetadata(ctx) ?? {};
  const updated: MasMetadata = {
    ...current,
    policy_decisions: policyDecisions,
  };
  writeMasMetadata(ctx, updated);
}

/**
 * Get MAS debug flags (if any) from RequestContext metadata.
 */
export function getMasDebugFlags(
  ctx: IRequestContext,
): MasMetadataBag | undefined {
  const metadata = readMasMetadata(ctx);
  return metadata?.debug_flags;
}

/**
 * Persist MAS debug flags into RequestContext metadata.
 */
export function setMasDebugFlags(
  ctx: IRequestContext,
  debugFlags: MasMetadataBag | undefined,
): void {
  const current = readMasMetadata(ctx) ?? {};
  const updated: MasMetadata = {
    ...current,
    debug_flags: debugFlags,
  };
  writeMasMetadata(ctx, updated);
}

/**
 * Get current MAS task identifier from RequestContext metadata, if any.
 */
export function getMasTaskId(
  ctx: IRequestContext,
): MasTaskId | undefined {
  const metadata = readMasMetadata(ctx);
  const raw = metadata?.task_id;
  if (!raw) return undefined;
  return String(raw) as MasTaskId;
}

/**
 * Persist MAS task identifier into RequestContext metadata.
 */
export function setMasTaskId(
  ctx: IRequestContext,
  taskId: MasTaskId | undefined,
): void {
  const current = readMasMetadata(ctx) ?? {};
  const updated: MasMetadata = {
    ...current,
    task_id: taskId ? String(taskId) : undefined,
  };
  writeMasMetadata(ctx, updated);
}

/**
 * Get current MAS agent-execution identifier from RequestContext metadata, if any.
 */
export function getMasAgentExecutionId(
  ctx: IRequestContext,
): MasAgentExecutionId | undefined {
  const metadata = readMasMetadata(ctx);
  const raw = metadata?.agent_execution_id;
  if (!raw) return undefined;
  return String(raw) as MasAgentExecutionId;
}

/**
 * Persist MAS agent-execution identifier into RequestContext metadata.
 */
export function setMasAgentExecutionId(
  ctx: IRequestContext,
  agentExecutionId: MasAgentExecutionId | undefined,
): void {
  const current = readMasMetadata(ctx) ?? {};
  const updated: MasMetadata = {
    ...current,
    agent_execution_id: agentExecutionId ? String(agentExecutionId) : undefined,
  };
  writeMasMetadata(ctx, updated);
}

/**
 * Build a MasSessionContext snapshot purely from IRequestContext and
 * metadata.mas.*, initializing missing MAS identifiers when necessary.
 *
 * This helper is useful for internal MAS flows that start from an existing
 * RequestContext without an explicit MasRequest.
 */
export function getMasContextFromRequestContext(
  requestContext: IRequestContext,
): MasSessionContext {
  const correlationId: CorrelationId = requestContext.getCorrelationId();

  const ctxSessionId = requestContext.getSessionId();
  const ctxTenantId = requestContext.getTenantId();
  const ctxUserId = requestContext.getUserId();

  let masSessionId = getMasSessionId(requestContext);
  let masTraceId = getMasTraceId(requestContext);

  if (!masSessionId) {
    masSessionId = generateMasSessionId(correlationId);
  }
  if (!masTraceId) {
    masTraceId = generateMasTraceId(correlationId);
  }

  // Mirror identifiers back to RequestContext and metadata for downstream flows.
  setMasSessionId(requestContext, masSessionId);
  setMasTraceId(requestContext, masTraceId);

  const tokenBudget = getMasTokenBudget(requestContext);
  const policyDecisions = getMasPolicyDecisions(requestContext);

  const session: MasSessionContext = {
    masSessionId,
    correlationId,
    sessionId: ctxSessionId,
    tenantId: ctxTenantId,
    userId: ctxUserId,
    masTraceId,
    tokenBudget,
    policyDecisions,
    requestContext,
    // debug flags and other MAS-specific data can be stored in metadata
    // and surfaced via dedicated helpers when needed.
    metadata: undefined,
  };

  return session;
}

/**
 * Build MasSessionContext for a given MasRequest and IRequestContext.
 *
 * Rules:
 * - if request.session is provided, reuse it and gently merge with RequestContext;
 * - otherwise, create a new session using RequestContext identifiers.
 *
 * Identifier precedence:
 * - masSessionId / masTraceId:
 *   1) explicit values from request.session;
 *   2) MAS ids already present in RequestContext (e.g. from HTTP headers);
 *   3) freshly generated with deterministic MAS prefixes.
 * - tenantId / userId / sessionId:
 *   - prefer explicit values from MasSessionContext;
 *   - otherwise take them from IRequestContext.
 */
export function createMasSessionContextFromRequest(
  request: MasRequest,
  requestContext: IRequestContext,
): MasSessionContext {
  const existing = request.session;

  const correlationId: CorrelationId =
    existing?.correlationId ?? requestContext.getCorrelationId();

  const ctxSessionId = requestContext.getSessionId();
  const ctxTenantId = requestContext.getTenantId();
  const ctxUserId = requestContext.getUserId();

  const ctxMasSessionId = getMasSessionId(requestContext);
  const ctxMasTraceId = getMasTraceId(requestContext);

  let masSessionId: MasSessionId | undefined =
    existing?.masSessionId ?? ctxMasSessionId;
  let masTraceId: MasTraceId | undefined =
    existing?.masTraceId ?? ctxMasTraceId;

  if (!masSessionId) {
    masSessionId = generateMasSessionId(correlationId);
  }
  if (!masTraceId) {
    masTraceId = generateMasTraceId(correlationId);
  }

  // Synchronize MAS identifiers back to RequestContext if they are missing.
  if (!ctxMasSessionId && masSessionId) {
    setMasSessionId(requestContext, masSessionId);
  }
  if (!ctxMasTraceId && masTraceId) {
    setMasTraceId(requestContext, masTraceId);
  }

  // Resolve MAS-level budgets and policy decisions from RequestContext metadata.
  const ctxTokenBudget = getMasTokenBudget(requestContext);
  const ctxPolicyDecisions = getMasPolicyDecisions(requestContext);

  // If caller provided an existing session, normalize it in-place to keep
  // reference identity while filling missing identifiers and links.
  if (existing) {
    if (!existing.correlationId) {
      existing.correlationId = correlationId;
    }

    if (!existing.sessionId && ctxSessionId) {
      existing.sessionId = ctxSessionId;
    }
    if (!existing.tenantId && ctxTenantId) {
      existing.tenantId = ctxTenantId;
    }
    if (!existing.userId && ctxUserId) {
      existing.userId = ctxUserId;
    }

    if (!existing.masSessionId) {
      existing.masSessionId = masSessionId;
    }
    if (!existing.masTraceId) {
      existing.masTraceId = masTraceId;
    }

    if (!existing.requestContext) {
      existing.requestContext = requestContext;
    }

    // Prefer explicit tokenBudget / policyDecisions from existing session,
    // but if they are missing, bootstrap from RequestContext metadata.
    if (!existing.tokenBudget && ctxTokenBudget) {
      existing.tokenBudget = ctxTokenBudget;
    }
    if (!existing.policyDecisions && ctxPolicyDecisions) {
      existing.policyDecisions = ctxPolicyDecisions;
    }

    existing.metadata = mergeMetadata(existing.metadata, request.metadata);

    // Keep RequestContext metadata.mas.* in sync with normalized session.
    if (existing.tokenBudget) {
      setMasTokenBudget(requestContext, existing.tokenBudget);
    }
    if (existing.policyDecisions) {
      setMasPolicyDecisions(requestContext, existing.policyDecisions);
    }

    return existing;
  }

  const tokenBudget = ctxTokenBudget;
  const policyDecisions = ctxPolicyDecisions;

  const session: MasSessionContext = {
    masSessionId,
    correlationId,
    sessionId: ctxSessionId,
    tenantId: ctxTenantId,
    userId: ctxUserId,
    masTraceId,
    tokenBudget,
    policyDecisions,
    requestContext,
    metadata: mergeMetadata(undefined, request.metadata),
  };

  if (tokenBudget) {
    setMasTokenBudget(requestContext, tokenBudget);
  }
  if (policyDecisions) {
    setMasPolicyDecisions(requestContext, policyDecisions);
  }

  return session;
}

/**
 * Ensure that MasSessionContext has consistent MAS identifiers
 * and that IRoutingContext is synchronized with them.
 */
export function ensureMasTraceIdsInContext(
  session: MasSessionContext,
  requestContext: IRoutingContext,
): MasSessionContext {
  const correlationId: CorrelationId =
    session.correlationId ?? requestContext.getCorrelationId();

  const ctxMasSessionId = requestContext.getMasSessionId();
  const ctxMasTraceId = requestContext.getMasTraceId();

  const masSessionId: MasSessionId =
    session.masSessionId ??
    ctxMasSessionId ??
    generateMasSessionId(correlationId);

  const masTraceId: MasTraceId =
    session.masTraceId ??
    ctxMasTraceId ??
    generateMasTraceId(correlationId);

  if (!ctxMasSessionId && masSessionId) {
    requestContext.setMasSessionId(masSessionId);
  }
  if (!ctxMasTraceId && masTraceId) {
    requestContext.setMasTraceId(masTraceId);
  }

  return {
    ...session,
    masSessionId,
    masTraceId,
    correlationId,
    requestContext: session.requestContext ?? requestContext as unknown as MasSessionContext['requestContext'],
  };
}

/**
 * Synchronize MasSessionContext with identifiers and principal
 * information from IRequestContext.
 *
 * Semantics:
 * - correlationId in the returned session is always equal to
 *   requestContext.getCorrelationId();
 * - masSessionId / masTraceId:
 *   - prefer existing values from MasSessionContext;
 *   - otherwise reuse identifiers already present in RequestContext;
 *   - otherwise generate new identifiers derived from correlationId;
 * - tenantId / sessionId / userId:
 *   - keep explicit values from MasSessionContext;
 *   - backfill missing fields from IRequestContext.
 *
 * The original session object is not mutated; a shallow copy with
 * normalized identifiers is returned.
 */
export function syncMasSessionContextFromRequestContext(
  session: MasSessionContext,
  requestContext: IRequestContext,
): MasSessionContext {
  const correlationId: CorrelationId = requestContext.getCorrelationId();

  const ctxMasSessionId = getMasSessionId(requestContext);
  const ctxMasTraceId = getMasTraceId(requestContext);

  const masSessionId: MasSessionId =
    session.masSessionId ??
    ctxMasSessionId ??
    generateMasSessionId(correlationId);

  const masTraceId: MasTraceId =
    session.masTraceId ??
    ctxMasTraceId ??
    generateMasTraceId(correlationId);

  const tenantId = session.tenantId ?? requestContext.getTenantId();
  const sessionId = session.sessionId ?? requestContext.getSessionId();
  const userId = session.userId ?? requestContext.getUserId();

  // Mirror identifiers back to RequestContext when they were missing.
  if (!ctxMasSessionId && masSessionId) {
    setMasSessionId(requestContext, masSessionId);
  }
  if (!ctxMasTraceId && masTraceId) {
    setMasTraceId(requestContext, masTraceId);
  }

  return {
    ...session,
    correlationId,
    masSessionId,
    masTraceId,
    tenantId,
    sessionId,
    userId,
    requestContext: session.requestContext ?? requestContext,
    // metadata/tokenBudget/policyDecisions are preserved from the
    // original session object.
  };
}

export const updateMasContext = syncMasSessionContextFromRequestContext;

function mergeMetadata(
  sessionMetadata?: MasMetadataBag,
  requestMetadata?: MasMetadataBag,
): MasMetadataBag | undefined {
  if (!sessionMetadata && !requestMetadata) {
    return undefined;
  }

  return {
    ...(sessionMetadata ?? {}),
    ...(requestMetadata ?? {}),
  };
}

function generateMasSessionId(correlationId: CorrelationId): MasSessionId {
  const value = `mas_${String(correlationId)}_${Date.now()}`;
  return BrandedIds.createMasSessionId(value);
}

function generateMasTraceId(correlationId: CorrelationId): MasTraceId {
  const randomSuffix = IdGenerator.generateRandomString(12);
  const value = `mas_trace_${String(correlationId)}_${Date.now()}_${randomSuffix}`;
  return BrandedIds.createMasTraceId(value);
}