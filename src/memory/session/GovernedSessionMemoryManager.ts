/**
 * GovernedSessionMemoryManager - governance decorator over ISessionMemoryManager.
 *
 * Layer: Memory
 *
 * Responsibilities (MEM-NEXT.1 MVP):
 * - формировать MemoryGovernanceRequest для ключевых операций Session Memory API;
 * - вызывать IMemoryGovernanceService.evaluateOperation;
 * - интерпретировать MemoryGovernanceDecision:
 *   - status = 'deny'                     → бросать MemoryGovernanceError;
 *   - status = 'allow_with_modifications' → применять effects (MVP: контекстное окно);
 *   - status = 'allow'                   → делегировать вызов inner.
 */

import type {
  CorrelationId,
  SessionConfig,
  SessionId,
  SessionMessage,
  SessionMetadata,
  TenantId,
  UserId,
  WorkingMemoryEntry,
} from '../../domain/memory/session-types';
import type { ISessionMemoryManager } from './SessionMemoryManager';
import type {
  MemoryGovernanceDecision,
  MemoryGovernanceRequest,
  MemoryGovernanceReasonCode,
  MemoryGovernanceScope,
  MemoryUsageSnapshot,
} from '../../domain/memory/governance/memory-governance.types';
import { MemoryGovernanceError } from '../../domain/memory/governance/memory-governance.types';
import type { IMemoryGovernanceService } from '../governance/memory-governance.service';
import type { IContentScanner, ContentScanInput } from '../../domain/memory/governance/content-scanner';
import { logger } from '../../infrastructure/logging/logger';

const log = logger.child({ component: 'GovernedSessionMemoryManager' });

import { countTokens } from '../../core/utils/tokenizer';

import type { ISessionCounter } from '../../domain/memory/governance/session-counter';

function resolveScope(request: MemoryGovernanceRequest): MemoryGovernanceScope {
  if (request.session_id) return 'session';
  if (request.user_id) return 'user';
  return 'tenant';
}

function makeSessionKey(tenantId: TenantId, sessionId: SessionId): string {
  return `${tenantId}::${sessionId}`;
}

/**
 * Декоратор ISessionMemoryManager, пробрасывающий все операции через governance-слой.
 *
 * Важно:
 * - inner является "core" реализацией (DualWriteMemoryManager или аналог);
 * - данный класс не изменяет семантику Session Memory API, только добавляет
 *   квотирование и возможную деградацию контекстного окна.
 */
export class GovernedSessionMemoryManager implements ISessionMemoryManager {
  constructor(
    private readonly inner: ISessionMemoryManager,
    private readonly governance: IMemoryGovernanceService,
    private readonly contentScanner?: IContentScanner,
    private readonly sessionCounter?: ISessionCounter,
  ) {}

  // ---------------------------------------------------------------------------
  // ISessionMemoryManager implementation
  // ---------------------------------------------------------------------------

  async create_session(input: {
    tenant_id: TenantId;
    user_id: UserId;
    external_session_ref?: string;
    initial_context?: Record<string, unknown>;
    config_override?: Partial<SessionConfig>;
    correlation_id: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    created: boolean;
    loaded_working_memory: number;
  }> {
    const activeSessions = await this.getActiveSessions(input.tenant_id);
    const usage: MemoryUsageSnapshot = {
      tenant_id: input.tenant_id,
      active_sessions: activeSessions,
    };

    const request: MemoryGovernanceRequest = {
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      session_id: undefined,
      plan_tier: undefined,
      region: undefined,
      operation: 'create_session',
      role: undefined,
      modality: undefined,
      current_context_tokens: 0,
      added_tokens_estimate: 0,
      prospective_context_tokens: 0,
      added_storage_bytes_estimate: undefined,
      usage_snapshot: usage,
      sensitivity: undefined,
      policy_tags: undefined,
      correlation_id: input.correlation_id,
    };

    const decision = await this.governance.evaluateOperation(request);
    this.ensureAllowedOrThrow(decision, request);

    const effectiveInput = this.applyCreateSessionEffects(input, decision);

    const result = await this.inner.create_session(effectiveInput);
    if (result.created) {
      await this.incrementActiveSessions(input.tenant_id);
    }

    return result;
  }

  async add_message(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    user_id?: UserId;
    role: SessionMessage['role'];
    modality?: SessionMessage['modality'];
    content: string;
    metadata?: SessionMessage['metadata'];
    correlation_id: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    message_id: string;
    total_tokens: number;
    context_window_size: number;
    consolidation_triggered: boolean;
  }> {
    const state = await this.inner.get_session_state({
      tenant_id: input.tenant_id,
      session_id: input.session_id,
    });

    const metadata = state.metadata;
    const currentTokens = metadata.total_tokens ?? 0;
    const messageTokens = countTokens(input.content);
    const prospectiveTokens = currentTokens + messageTokens;
    const activeSessions = await this.getActiveSessions(input.tenant_id);

    const usage: MemoryUsageSnapshot = {
      tenant_id: input.tenant_id,
      active_sessions: activeSessions,
      session: {
        session_id: input.session_id,
        context_tokens: currentTokens,
        message_count: metadata.message_count,
        storage_bytes: undefined,
      },
    };

    const request: MemoryGovernanceRequest = {
      tenant_id: input.tenant_id,
      user_id: input.user_id,
      session_id: input.session_id,
      plan_tier: undefined,
      region: undefined,
      operation: 'add_message',
      role: input.role,
      modality: input.modality ?? 'text',
      current_context_tokens: currentTokens,
      added_tokens_estimate: messageTokens,
      prospective_context_tokens: prospectiveTokens,
      added_storage_bytes_estimate: undefined,
      usage_snapshot: usage,
      sensitivity: undefined,
      policy_tags: input.metadata?.policy?.engine_tags,
      correlation_id: input.correlation_id,
    };

    const decision = await this.governance.evaluateOperation(request);
    this.ensureAllowedOrThrow(decision, request);

    // MEM-NEXT.1: PII/sensitivity scanning before persist
    let contentToStore = input.content;
    if (this.contentScanner) {
      const scanInput: ContentScanInput = {
        tenant_id: input.tenant_id,
        user_id: input.user_id,
        session_id: input.session_id,
        content: input.content,
        content_type: 'text/plain',
        redact: true, // Auto-redact detected PII
        reject_above: 'restricted', // Block restricted content
        correlation_id: input.correlation_id,
      };

      const scanResult = await this.contentScanner.scan(scanInput);

      if (!scanResult.allowed) {
        log.warn('Content blocked by scanner', {
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          sensitivity: scanResult.sensitivity,
          entity_count: scanResult.detected_entities.length,
        });
        throw new MemoryGovernanceError(
          'pii_content_blocked',
          `Content scan blocked message: detected ${scanResult.sensitivity} content`,
        );
      }

      // Apply redacted content if available
      if (scanResult.redacted_content) {
        contentToStore = scanResult.redacted_content;
        log.info('Content redacted by scanner', {
          tenant_id: input.tenant_id,
          session_id: input.session_id,
          entity_count: scanResult.detected_entities.length,
        });
      }
    }

    // MEM-NEXT.1 MVP: эффекты allow_hsg_persist / allow_vector_persist
    // пока не маппятся на DualWrite/SessionMemoryManager и рассматриваются
    // как advisory. Реализация будет расширена в последующих задачах.
    return this.inner.add_message({
      ...input,
      content: contentToStore,
    });
  }

  async get_context_window(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    max_messages?: number;
    max_tokens?: number;
    correlation_id?: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    messages: SessionMessage[];
  }> {
    const state = await this.inner.get_session_state({
      tenant_id: input.tenant_id,
      session_id: input.session_id,
    });

    const metadata = state.metadata;

    const currentTokens = metadata.total_tokens ?? 0;

    const activeSessions = await this.getActiveSessions(input.tenant_id);

    const usage: MemoryUsageSnapshot = {
      tenant_id: input.tenant_id,
      active_sessions: activeSessions,
      session: {
        session_id: input.session_id,
        context_tokens: currentTokens,
        message_count: metadata.message_count,
        storage_bytes: undefined,
      },
    };

    const governanceCorrelationId: CorrelationId =
      (input.correlation_id as CorrelationId | undefined) ??
      (`memory-governance:get_context_window:${input.tenant_id}:${input.session_id}` as CorrelationId);

    const request: MemoryGovernanceRequest = {
      tenant_id: input.tenant_id,
      user_id: metadata.user_id,
      session_id: input.session_id,
      plan_tier: undefined,
      region: undefined,
      operation: 'get_context_window',
      role: undefined,
      modality: undefined,
      current_context_tokens: currentTokens,
      added_tokens_estimate: 0,
      prospective_context_tokens: currentTokens,
      added_storage_bytes_estimate: undefined,
      usage_snapshot: usage,
      sensitivity: undefined,
      policy_tags: undefined,
      correlation_id: governanceCorrelationId,
    };

    const decision = await this.governance.evaluateOperation(request);
    this.ensureAllowedOrThrow(decision, request);

    let maxMessages = input.max_messages;
    let maxTokens = input.max_tokens;

    if (decision.status === 'allow_with_modifications') {
      const effects = decision.effects;
      if (typeof effects.truncate_context_to_messages === 'number') {
        maxMessages =
          typeof maxMessages === 'number'
            ? Math.min(maxMessages, effects.truncate_context_to_messages)
            : effects.truncate_context_to_messages;
      }
      if (typeof effects.truncate_context_to_tokens === 'number') {
        maxTokens =
          typeof maxTokens === 'number'
            ? Math.min(maxTokens, effects.truncate_context_to_tokens)
            : effects.truncate_context_to_tokens;
      }
    }

    return this.inner.get_context_window({
      tenant_id: input.tenant_id,
      session_id: input.session_id,
      max_messages: maxMessages,
      max_tokens: maxTokens,
      correlation_id: input.correlation_id,
    });
  }

  async consolidate_session(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    strategy?: 'auto' | 'full' | 'recent_window';
    correlation_id: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    summaries: WorkingMemoryEntry[];
    consolidated_messages: number;
  }> {
    const state = await this.inner.get_session_state({
      tenant_id: input.tenant_id,
      session_id: input.session_id,
    });

    const metadata = state.metadata;
    const currentTokens = metadata.total_tokens ?? 0;

    const activeSessions = await this.getActiveSessions(input.tenant_id);

    const usage: MemoryUsageSnapshot = {
      tenant_id: input.tenant_id,
      active_sessions: activeSessions,
      session: {
        session_id: input.session_id,
        context_tokens: currentTokens,
        message_count: metadata.message_count,
        storage_bytes: undefined,
      },
    };

    const request: MemoryGovernanceRequest = {
      tenant_id: input.tenant_id,
      user_id: metadata.user_id,
      session_id: input.session_id,
      plan_tier: undefined,
      region: undefined,
      operation: 'consolidate_session',
      role: undefined,
      modality: undefined,
      current_context_tokens: currentTokens,
      added_tokens_estimate: 0,
      prospective_context_tokens: currentTokens,
      added_storage_bytes_estimate: undefined,
      usage_snapshot: usage,
      sensitivity: undefined,
      policy_tags: undefined,
      correlation_id: input.correlation_id,
    };

    const decision = await this.governance.evaluateOperation(request);
    this.ensureAllowedOrThrow(decision, request);

    // MEM-NEXT.1 MVP: эффекты, влияющие на long-term persist (HSG/Vector),
    // пока не маппятся на underlying LongTermMemoryStore.
    return this.inner.consolidate_session(input);
  }

  async end_session(input: {
    tenant_id: TenantId;
    session_id: SessionId;
    reason?: string;
    correlation_id: CorrelationId;
  }): Promise<{
    session_id: SessionId;
    archived: boolean;
  }> {
    const activeSessions = await this.getActiveSessions(input.tenant_id);

    const usage: MemoryUsageSnapshot = {
      tenant_id: input.tenant_id,
      active_sessions: activeSessions,
    };

    const request: MemoryGovernanceRequest = {
      tenant_id: input.tenant_id,
      user_id: undefined,
      session_id: input.session_id,
      plan_tier: undefined,
      region: undefined,
      operation: 'end_session',
      role: undefined,
      modality: undefined,
      current_context_tokens: undefined,
      added_tokens_estimate: 0,
      prospective_context_tokens: undefined,
      added_storage_bytes_estimate: undefined,
      usage_snapshot: usage,
      sensitivity: undefined,
      policy_tags: undefined,
      correlation_id: input.correlation_id,
    };

    const decision = await this.governance.evaluateOperation(request);
    this.ensureAllowedOrThrow(decision, request);

    const result = await this.inner.end_session(input);
    if (result.archived) {
      await this.decrementActiveSessions(input.tenant_id);
    }

    return result;
  }

  async get_session_state(input: {
    tenant_id: TenantId;
    session_id: SessionId;
  }): Promise<{
    metadata: SessionMetadata;
    working_memory: WorkingMemoryEntry[];
  }> {
    // На данный момент get_session_state не проходит через governance.
    // В последующих итерациях сюда могут быть добавлены privacy-ограничения.
    return this.inner.get_session_state(input);
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async getActiveSessions(tenantId: TenantId): Promise<number> {
    if (this.sessionCounter) {
      return this.sessionCounter.getCount(tenantId);
    }
    return 0;
  }

  private async incrementActiveSessions(tenantId: TenantId): Promise<void> {
    if (this.sessionCounter) {
      await this.sessionCounter.increment(tenantId);
    }
  }

  private async decrementActiveSessions(tenantId: TenantId): Promise<void> {
    if (this.sessionCounter) {
      await this.sessionCounter.decrement(tenantId);
    }
  }

  private ensureAllowedOrThrow(
    decision: MemoryGovernanceDecision,
    request: MemoryGovernanceRequest,
  ): void {
    if (decision.status !== 'deny') {
      return;
    }

    const primaryReason: MemoryGovernanceReasonCode =
      decision.reasons[0] ?? 'internal_error';
    const scope = resolveScope(request);

    log.warn('Memory governance denied operation', {
      tenant_id: request.tenant_id,
      user_id: request.user_id,
      session_id: request.session_id,
      operation: request.operation,
      scope,
      reasons: decision.reasons,
      quota_status: decision.quota_status,
    });

    throw new MemoryGovernanceError(
      primaryReason,
      `Memory governance denied operation ${request.operation} for tenant=${request.tenant_id}, session=${request.session_id ?? 'n/a'} (reason=${primaryReason})`,
    );
  }

  private applyCreateSessionEffects(
    input: {
      tenant_id: TenantId;
      user_id: UserId;
      external_session_ref?: string;
      initial_context?: Record<string, unknown>;
      config_override?: Partial<SessionConfig>;
      correlation_id: CorrelationId;
    },
    decision: MemoryGovernanceDecision,
  ): {
    tenant_id: TenantId;
    user_id: UserId;
    external_session_ref?: string;
    initial_context?: Record<string, unknown>;
    config_override?: Partial<SessionConfig>;
    correlation_id: CorrelationId;
  } {
    if (decision.status !== 'allow_with_modifications') {
      return input;
    }

    const effects = decision.effects;
    if (!effects) {
      return input;
    }

    const override: Partial<SessionConfig> = {
      ...(input.config_override ?? {}),
    };

    if (typeof effects.truncate_context_to_tokens === 'number') {
      const current = override.max_context_tokens;
      override.max_context_tokens =
        typeof current === 'number'
          ? Math.min(current, effects.truncate_context_to_tokens)
          : effects.truncate_context_to_tokens;
    }

    // MEM-NEXT.1 MVP: другие эффекты (retention_days, режимы памяти и т.п.)
    // будут добавлены в следующих итерациях.
    return {
      ...input,
      config_override: Object.keys(override).length > 0 ? override : input.config_override,
    };
  }
}