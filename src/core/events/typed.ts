/**
 * Typed Events (MVP) aligned with 10-layer SSOT
 * Layer: Core (types, protocols, contracts)
 *
 * Содержит минимальный реестр типизированных событий и валидаторы:
 * - tool.called
 * - tool.result
 *
 * Примечание:
 * - Core не зависит от внешних слоёв (Application/Infrastructure/и т.д.).
 * - Здесь описаны только типы/контракты и утилиты валидации.
 */
import { z } from 'zod';

// PQC (Post-Quantum Cryptography) metadata schemas
export const PqcVerificationMethodEnum = z.enum([
  'ML-KEM-768',
  'ML-DSA-65',
  'SLH-DSA-SHA2-128s',
  'none',
]);

export const PqcMetadataSchema = z.object({
  pqc_signature: z.string().min(1).optional(),
  verification_method: PqcVerificationMethodEnum.optional(),
});

export type PqcMetadata = z.infer<typeof PqcMetadataSchema>;

 // Общие поля события
export const BaseEventSchema = z.object({
  type: z.string().min(1), // Имя/тип события (например, 'tool.called')
  timestamp: z.string().min(1), // ISO timestamp (обязательно, выставляется эмиттером)
  correlation_id: z.string().min(1), // Обязательный корреляционный идентификатор (x-correlation-id)
  tenant_id: z.string().min(1).optional(), // Мульти-тенант (если используется)
  session_id: z.string().min(1).optional(), // Сессия пользователя
  actor: z.string().min(1).optional(), // Инициатор (user/system/agent)
  correlation_source: z
    .enum([
      'request_context',
      'plugin_context',
      'mas_context',
      'memory_context',
      'policy_context',
      'fallback_dev',
      'fallback_prod',
    ])
    .optional(), // Источник корреляции для observability (ось PLUGINS/MAS/MEM/POLICY)
  trace_lost: z
    .object({
      plugins: z.boolean().optional(),
      mas: z.boolean().optional(),
      memory: z.boolean().optional(),
    })
    .optional(), // Флаги потери трассировки (ось plugins/mas/memory и др.)
  pqc_metadata: PqcMetadataSchema.optional(), // Post-Quantum Cryptography metadata (Horizon 3)
});

// Input-схемы: допускают отсутствие timestamp/correlation_id, валидатор добавит значения по умолчанию
export const BaseEventInputSchema = z.object({
  type: z.string().min(1),
  timestamp: z.string().min(1).optional(),
  correlation_id: z.string().min(1).optional(),
  tenant_id: z.string().min(1).optional(),
  session_id: z.string().min(1).optional(),
  actor: z.string().min(1).optional(),
  correlation_source: z
    .enum([
      'request_context',
      'plugin_context',
      'mas_context',
      'memory_context',
      'policy_context',
      'fallback_dev',
      'fallback_prod',
    ])
    .optional(),
  trace_lost: z
    .object({
      plugins: z.boolean().optional(),
      mas: z.boolean().optional(),
      memory: z.boolean().optional(),
    })
    .optional(),
  pqc_metadata: PqcMetadataSchema.optional(),
});

export const ToolCalledEventInputSchema = BaseEventInputSchema.extend({
  type: z.literal('tool.called'),
  tool_name: z.string().min(1),
  args: z.unknown().optional(),
});

export const ToolResultEventInputSchema = BaseEventInputSchema.extend({
  type: z.literal('tool.result'),
  tool_name: z.string().min(1),
  success: z.boolean(),
  duration_ms: z.number().nonnegative().optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      message: z.string(),
      code: z.string().optional(),
      details: z.unknown().optional(),
    })
    .optional(),
});

// tool.called
export const ToolCalledEventSchema = BaseEventSchema.extend({
  type: z.literal('tool.called'),
  tool_name: z.string().min(1),
  args: z.unknown().optional(),                    // payload аргументов (нормализованный)
});

// tool.result
export const ToolResultEventSchema = BaseEventSchema.extend({
  type: z.literal('tool.result'),
  tool_name: z.string().min(1),
  success: z.boolean(),
  duration_ms: z.number().nonnegative().optional(),
  result: z.unknown().optional(),
  error: z
    .object({
      message: z.string(),
      code: z.string().optional(),
      details: z.unknown().optional(),
    })
    .optional(),
});

// secret.accessed
export const SecretAccessedEventSchema = BaseEventSchema.extend({
  type: z.literal('secret.accessed'),
  secret_id: z.string().min(1),
  secret_source: z.enum(['env', 'file', 'exec']),
  action: z.enum(['read', 'resolve', 'rotate', 'delete', 'audit']),
  result: z.enum(['success', 'denied', 'not_found', 'error']),
  duration_ms: z.number().nonnegative().optional(),
});

// extraction.recorded
export const ExtractionEventSchema = BaseEventSchema.extend({
  type: z.literal('extraction.recorded'),
  phase: z.enum(['RECON', 'DIG', 'SCAN', 'RE_VERIFY', 'SCORE', 'SPEC', 'ADAPT', 'TEST', 'AUDIT', 'DOC']),
  donor_name: z.string().min(1),
  source_file: z.string().min(1),
  tier: z.number().int().min(0).max(4),
  fitness_score: z.number().min(0).max(100).optional(),
  mcp_tool_name: z.string().min(1),
  duration_ms: z.number().nonnegative(),
  owasp_asi: z.string().optional(),
  target_path: z.string().optional(),
  success: z.boolean(),
});

// extraction.semantic_archived
export const SemanticArchiveEventSchema = BaseEventSchema.extend({
  type: z.literal('extraction.semantic_archived'),
  donor_name: z.string().min(1),
  archived_files_count: z.number().int().nonnegative(),
  skip_reasons: z.array(z.string()),
  embedding_model: z.string().optional(),
  total_tokens_archived: z.number().nonnegative().optional(),
});

// Соответствующие TypeScript-типы
export type BaseEvent = z.infer<typeof BaseEventSchema>;
export type ToolCalledEvent = z.infer<typeof ToolCalledEventSchema>;
export type ToolResultEvent = z.infer<typeof ToolResultEventSchema>;
export type SecretAccessedEvent = z.infer<typeof SecretAccessedEventSchema>;
export type ExtractionEvent = z.infer<typeof ExtractionEventSchema>;
export type SemanticArchiveEvent = z.infer<typeof SemanticArchiveEventSchema>;

// Утилиты валидации
export function validateToolCalledEvent(input: unknown): ToolCalledEvent {
  const parsedInput = ToolCalledEventInputSchema.parse(input);

  const normalized: ToolCalledEvent = {
    type: 'tool.called',
    timestamp: parsedInput.timestamp ?? new Date().toISOString(),
    correlation_id: parsedInput.correlation_id ?? `corr_${Date.now()}`,
    tenant_id: parsedInput.tenant_id,
    session_id: parsedInput.session_id,
    actor: parsedInput.actor,
    correlation_source: parsedInput.correlation_source,
    trace_lost: parsedInput.trace_lost,
    pqc_metadata: parsedInput.pqc_metadata,
    tool_name: parsedInput.tool_name,
    args: parsedInput.args,
  };

  return ToolCalledEventSchema.parse(normalized);
}

export function validateToolResultEvent(input: unknown): ToolResultEvent {
  const parsedInput = ToolResultEventInputSchema.parse(input);

  const normalized: ToolResultEvent = {
    type: 'tool.result',
    timestamp: parsedInput.timestamp ?? new Date().toISOString(),
    correlation_id: parsedInput.correlation_id ?? `corr_${Date.now()}`,
    tenant_id: parsedInput.tenant_id,
    session_id: parsedInput.session_id,
    actor: parsedInput.actor,
    correlation_source: parsedInput.correlation_source,
    trace_lost: parsedInput.trace_lost,
    pqc_metadata: parsedInput.pqc_metadata,
    tool_name: parsedInput.tool_name,
    success: parsedInput.success,
    duration_ms: parsedInput.duration_ms,
    result: parsedInput.result,
    error: parsedInput.error,
  };

  return ToolResultEventSchema.parse(normalized);
}

// Узкий тип-гард (runtime)
export function isToolCalledEvent(e: unknown): e is ToolCalledEvent {
  const r = ToolCalledEventSchema.safeParse(e);
  return r.success;
}

export function isToolResultEvent(e: unknown): e is ToolResultEvent {
  const r = ToolResultEventSchema.safeParse(e);
  return r.success;
}

export function isSecretAccessedEvent(e: unknown): e is SecretAccessedEvent {
  return SecretAccessedEventSchema.safeParse(e).success;
}

export function isExtractionEvent(e: unknown): e is ExtractionEvent {
  return ExtractionEventSchema.safeParse(e).success;
}

export function isSemanticArchiveEvent(e: unknown): e is SemanticArchiveEvent {
  return SemanticArchiveEventSchema.safeParse(e).success;
}

/**
 * Пример использования (для справки):
 *
 * const ev: ToolCalledEvent = validateToolCalledEvent({
 *   type: 'tool.called',
 *   tool_name: 'browser.open',
 *   args: { url: 'https://example.com' },
 *   correlation_id: 'abc-123',
 * });
 *
 * if (isToolCalledEvent(ev)) {
 *   // ok
 * }
 */

// Re-export agentic event schemas for unified access
export { AgenticEventSchemas } from './agentic-events';