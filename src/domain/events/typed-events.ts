/**
 * Typed Events SSOT layer for critical domain/integration events.
 *
 * Layer: Domain/Core
 *
 * Цели:
 * - Типобезопасные контракты для критичных событий.
 * - Единый реестр (CriticalEventMap) для аудита и автогенерации.
 * - Schema-based валидация payload до append/publish.
 *
 * Важно:
 * - НЕ ломает существующие IEventStore/IEventBus/IOutbox.
 * - Используется как надстройка над существующими DomainEvent.
 * - Реализации infra/adapters могут постепенно мигрировать на этот слой.
 */

/**
 * ВНИМАНИЕ:
 * - Этот модуль является code-level реализацией части SSOT по typed events.
 * - Он должен оставаться максимально лёгким и не тянуть инфраструктурные зависимости.
 * - Zod используется как внутренняя validation-библиотека; при изменении политики
 *   валидации допустимо вынести схемы/адаптеры в верхний слой.
 */
import { z } from 'zod';

/**
 * Базовый тип типизированного доменного события.
 * Не зависит от инфраструктурных реализаций.
 */
export interface TypedDomainEvent<TType extends string = string, TPayload = unknown> {
  type: TType;
  payload: TPayload;
  occurredAt: string; // ISO-8601 timestamp
  metadata?: Record<string, unknown>;
}

/**
 * Критичные события: LLM telemetry, Outbox/EBus сбои, интеграции и т.п.
 * Здесь задается единый реестр типов и payload-контрактов.
 *
 * P2: расширяйте этот словарь только через код-ревью и архитектурный аудит.
 */

/**
 * Zod-схемы и типы для LLM usage.
 */
export const LlmUsageSchema = z.object({
  model: z.string(),
  route: z.enum(['newapi', 'litellm', 'openrouter']),
  provider: z.string(),
  prompt_tokens: z.number().nonnegative(),
  completion_tokens: z.number().nonnegative(),
  cost_usd: z.number().nonnegative(),
  session_id: z.string(),
  user_id: z.string(),
});

export type LlmUsagePayload = z.infer<typeof LlmUsageSchema>;

/**
 * v2 payload for llm.usage.* events.
 * Extends v1 with precomputed total_tokens to simplify analytics/replay.
 */
export const LlmUsageV2Schema = LlmUsageSchema.extend({
  total_tokens: z.number().nonnegative(),
});

export type LlmUsageV2Payload = z.infer<typeof LlmUsageV2Schema>;

/**
 * Zod-схема и тип для outbox.failure.v1.
 */
export const OutboxFailureSchema = z.object({
  messageId: z.string(),
  reason: z.string(),
  attempts: z.number().int().nonnegative(),
  lastError: z.string().optional(),
});

export type OutboxFailurePayload = z.infer<typeof OutboxFailureSchema>;

/**
 * Unified correlation source enum for MAS/MEM/Policy/Plugins typed events.
 * Must stay in sync with RCTX contract in 14-typed-events-registry.md.
 */
export type CorrelationSource =
  | 'mas_context'
  | 'memory_context'
  | 'policy_context'
  | 'request_context'
  | 'plugin_context'
  | 'fallback_dev'
  | 'fallback_prod';

/**
 * Zod-схема и тип для memory.governance.decision.v1.
 *
 * Mirrors JSON Schema "memory.governance.decision" (v1) from typed-events registry.
 * PII is limited to stable identifiers (tenant_id/user_id/session_id).
 */
export const MemoryGovernanceDecisionV1Schema = z.object({
  tenant_id: z.string(),
  user_id: z.string().optional(),
  session_id: z.string().optional(),
  plan_tier: z.enum(['free', 'pro', 'enterprise']).optional(),
  region: z.string().optional(),
  operation: z.string(),
  status: z.enum(['allow', 'deny', 'allow_with_modifications']),
  quota_status: z.enum(['ok', 'near_limit', 'soft_exceeded', 'hard_exceeded']),
  reasons: z.array(z.string()).min(1),
  effects: z.record(z.string(), z.unknown()),
  quota_views: z.array(z.record(z.string(), z.unknown())),
  violations: z.array(z.record(z.string(), z.unknown())),
  audit_ref: z.string().optional(),
  policy_snapshot_id: z.string().optional(),
  policy_evaluation_id: z.string().optional(),
  timestamp: z.string(),
  correlation_id: z.string(),
  correlation_source: z
    .enum([
      'mas_context',
      'memory_context',
      'policy_context',
      'request_context',
      'plugin_context',
      'fallback_dev',
      'fallback_prod',
    ])
    .optional(),
});

export type MemoryGovernanceDecisionPayloadV1 = z.infer<
  typeof MemoryGovernanceDecisionV1Schema
>;

/**
 * Zod-схема и тип для memory.governance.violation.v1.
 *
 * Mirrors JSON Schema "memory.governance.violation" (v1) from typed-events registry.
 */
export const MemoryGovernanceViolationV1Schema = z.object({
  tenant_id: z.string(),
  user_id: z.string().optional(),
  session_id: z.string().optional(),
  operation: z.string(),
  violation_code: z.string(),
  severity: z.enum(['warning', 'error']),
  reason: z.string().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
  quota_view: z.record(z.string(), z.unknown()).optional(),
  audit_ref: z.string().optional(),
  policy_evaluation_id: z.string().optional(),
  timestamp: z.string(),
  correlation_id: z.string(),
  correlation_source: z
    .enum([
      'mas_context',
      'memory_context',
      'policy_context',
      'request_context',
      'plugin_context',
      'fallback_dev',
      'fallback_prod',
    ])
    .optional(),
});

export type MemoryGovernanceViolationPayloadV1 = z.infer<
  typeof MemoryGovernanceViolationV1Schema
>;

/**
 * Logical content type for multimodal.content.processed events.
 * Aligned with JSON Schema enum "content_type".
 */
export type MultimodalContentType = 'image' | 'audio' | 'video' | 'text';

/**
 * Zod-схема и тип для multimodal.content.processed.v1.
 *
 * Mirrors JSON Schema "multimodal.content.processed" (v1) from typed-events registry.
 */
export const MultimodalContentProcessedV1Schema = z.object({
  content_id: z.string(),
  content_type: z.enum(['image', 'audio', 'video', 'text']),
  processing_result: z.record(z.string(), z.unknown()),
  timestamp: z.string(),
  correlation_id: z.string(),
  processing_time_ms: z.number().nonnegative().optional(),
  model_used: z.string().optional(),
});

export type MultimodalContentProcessedPayloadV1 = z.infer<
  typeof MultimodalContentProcessedV1Schema
>;

/**
 * Zod-схема и тип для mas.session.memory_finalized.v1.
 *
 * Mirrors JSON Schema "mas.session.memory_finalized" (v1) from typed-events registry.
 */
export const MasSessionMemoryFinalizedV1Schema = z.object({
  mas_session_id: z.string(),
  mas_trace_id: z.string().optional(),
  tenant_id: z.string(),
  session_id: z.string(),
  reason: z.string().optional(),
  timestamp: z.string(),
  correlation_id: z.string(),
  correlation_source: z
    .enum([
      'mas_context',
      'memory_context',
      'policy_context',
      'request_context',
      'plugin_context',
      'fallback_dev',
      'fallback_prod',
    ])
    .optional(),
});

export type MasSessionMemoryFinalizedPayloadV1 = z.infer<
  typeof MasSessionMemoryFinalizedV1Schema
>;

/**
 * Zod-схема и тип для mas.memory.context_used.v1.
 *
 * Mirrors JSON Schema "mas.memory.context_used" (v1) from typed-events registry.
 */
export const MasMemoryContextUsedV1Schema = z.object({
  mas_session_id: z.string(),
  mas_trace_id: z.string().optional(),
  scenario: z.string().optional(),
  use_case: z.string().optional(),
  tenant_id: z.string(),
  user_id: z.string().optional(),
  session_id: z.string(),
  messages_returned: z.number().int().nonnegative(),
  knowledge_snippets_returned: z.number().int().nonnegative(),
  governance_status: z
    .enum(['ok', 'deny', 'allow_with_modifications', 'unknown'])
    .optional(),
  applied_limits: z
    .object({
      max_messages: z.number().int().nonnegative().optional(),
      max_tokens: z.number().int().nonnegative().optional(),
    })
    .optional(),
  filters: z
    .object({
      query: z.string().optional(),
      channels: z.array(z.string()).optional(),
      timeRange: z
        .object({
          from: z.string().optional(),
          to: z.string().optional(),
        })
        .optional(),
      knowledgeSources: z.array(z.string()).optional(),
      maxKnowledgeSnippets: z.number().int().nonnegative().optional(),
      extra: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  timestamp: z.string(),
  correlation_id: z.string(),
  correlation_source: z
    .enum([
      'mas_context',
      'memory_context',
      'policy_context',
      'request_context',
      'plugin_context',
      'fallback_dev',
      'fallback_prod',
    ])
    .optional(),
});

export type MasMemoryContextUsedPayloadV1 = z.infer<
  typeof MasMemoryContextUsedV1Schema
>;

/**
 * Реестр критичных событий и их payload-типов.
 */
export type CriticalEventMap = {
  'llm.usage.v1': LlmUsagePayload;
  'llm.usage.v2': LlmUsageV2Payload;
  'outbox.failure.v1': OutboxFailurePayload;
  'memory.governance.decision.v1': MemoryGovernanceDecisionPayloadV1;
  'memory.governance.violation.v1': MemoryGovernanceViolationPayloadV1;
  'multimodal.content.processed.v1': MultimodalContentProcessedPayloadV1;
  'mas.session.memory_finalized.v1': MasSessionMemoryFinalizedPayloadV1;
  'mas.memory.context_used.v1': MasMemoryContextUsedPayloadV1;
  // Примеры для будущего расширения:
  // 'payment.processed.v1': PaymentProcessedPayload;
  // 'integration.webhook.received.v1': WebhookReceivedPayload;
};

export type CriticalEventType = keyof CriticalEventMap;

export type CriticalEvent<T extends CriticalEventType = CriticalEventType> =
  TypedDomainEvent<T, CriticalEventMap[T]>;

/**
 * Фабрика для создания типизированного события БЕЗ schema-валидации.
 * Использовать там, где payload уже гарантирован (например, после DTO/mapper).
 */
export function createTypedEvent<T extends CriticalEventType>(
  type: T,
  payload: CriticalEventMap[T],
  metadata?: Record<string, unknown>,
): CriticalEvent<T> {
  return {
    type,
    payload,
    occurredAt: new Date().toISOString(),
    metadata,
  };
}

/**
 * Утилита для адаптации TypedDomainEvent к существующему DomainEvent формату.
 * Реализация должна быть синхронизирована с текущим IEventStore/DomainEvent контрактом.
 *
 * P2: при интеграции:
 * - либо расширить существующий DomainEvent так, чтобы он принимал typed payload/metadata,
 * - либо реализовать mapper здесь, не ломая public API.
 */
export interface LegacyDomainEvent {
  type: string;
  payload: unknown;
  occurredAt: string;
  metadata?: Record<string, unknown>;
}

export function toLegacyDomainEvent(event: TypedDomainEvent): LegacyDomainEvent {
  return {
    type: event.type,
    payload: event.payload,
    occurredAt: event.occurredAt,
    metadata: event.metadata,
  };
}