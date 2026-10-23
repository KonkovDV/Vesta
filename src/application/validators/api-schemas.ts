/**
 * Zod schemas for API input validation
 * P0-012: Comprehensive input validation to prevent injection attacks and data corruption
 */
import { z } from 'zod';

// Common validation constants
const MAX_ID_LENGTH = 128;
const MAX_NAME_LENGTH = 256;
const MAX_MESSAGE_LENGTH = 100_000;
const MAX_JSON_PAYLOAD_SIZE = 500_000;
const MAX_QUERY_LENGTH = 10_000;
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Helper to validate no SQL injection patterns
 */
function hasSQLInjection(val: string): boolean {
  const sqlInjectionPatterns = [
    /(\b(SELECT|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|EXEC|EXECUTE|UNION|SCRIPT)\b.*\b(FROM|INTO|TABLE|DATABASE)\b)/i,
    /(--|#|\/\*|\*\/)/,
    /(\bOR\b|\bAND\b)\s+\d+\s*=\s*\d+/i,
    /(\bOR\b|\bAND\b)\s+'[^']*'\s*=\s*'[^']*'/i,
    /;\s*\b(DROP|DELETE|INSERT|UPDATE|EXEC|EXECUTE)\b/i,
  ];
  return sqlInjectionPatterns.some((pattern) => pattern.test(val));
}

/**
 * Creates a sanitized string schema with SQL injection prevention
 */
export function sanitizedString(maxLength: number) {
  return z.string()
    .min(1)
    .max(maxLength)
    .refine(
      (val) => !hasSQLInjection(val),
      { message: 'Input contains potentially dangerous SQL patterns' }
    );
}

export function sanitizedTrimmedString(maxLength: number) {
  return z.string()
    .trim()
    .min(1)
    .max(maxLength)
    .refine(
      (val) => !hasSQLInjection(val),
      { message: 'Input contains potentially dangerous SQL patterns' }
    );
}

/**
 * UUID string schema
 */
export const UUIDString = z
  .string()
  .max(MAX_ID_LENGTH)
  .regex(UUID_REGEX, 'Invalid UUID format');

/**
 * Safe ID string (alphanumeric, hyphens, underscores)
 */
export const SafeIdString = z
  .string()
  .min(1)
  .max(MAX_ID_LENGTH)
  .regex(/^[a-zA-Z0-9_-]+$/, 'ID must be alphanumeric with hyphens and underscores only');

/**
 * Email schema with validation
 */
export const EmailSchema = z.string().email('Invalid email format').max(256);

/**
 * Pagination query parameters
 */
export const PaginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// ============================================================================
// Chat API Schemas
// ============================================================================

const ChatMessageContentPartSchema = z.union([
  z.object({
    type: z.literal('text'),
    text: z.string().max(MAX_MESSAGE_LENGTH),
  }),
  z.object({
    type: z.literal('image_url'),
    image_url: z.object({
      url: z.string().max(MAX_MESSAGE_LENGTH),
    }),
  }),
  z.object({
    type: z.literal('input_audio'),
    input_audio: z.object({
      data: z.string().min(1).max(MAX_MESSAGE_LENGTH),
      format: z.string().max(64).optional(),
    }),
  }),
]);

/**
 * Chat message schema
 */
export const ChatMessageSchema = z.object({
  role: z.enum(['system', 'user', 'assistant', 'function', 'tool']),
  content: z.union([
    z.string().max(MAX_MESSAGE_LENGTH),
    z.array(ChatMessageContentPartSchema).min(1).max(32),
  ]),
  name: z.string().max(64).optional(),
  function_call: z.record(z.string(), z.unknown()).optional(),
  tool_calls: z.array(z.record(z.string(), z.unknown())).optional(),
  tool_call_id: z.string().max(64).optional(),
});

/**
 * Chat completion request schema
 */
export const ChatCompletionRequestSchema = z.object({
  model: z.string().max(128).optional(),
  messages: z.array(ChatMessageSchema).min(1).max(100),
  temperature: z.number().min(0).max(2).optional(),
  top_p: z.number().min(0).max(1).optional(),
  n: z.number().int().min(1).max(10).optional(),
  stream: z.boolean().optional(),
  max_tokens: z.number().int().min(1).max(100_000).optional(),
  presence_penalty: z.number().min(-2).max(2).optional(),
  frequency_penalty: z.number().min(-2).max(2).optional(),
  user: z.string().max(128).optional(),
  conversationId: SafeIdString.optional(),
});

/**
 * Send message request schema
 */
export const SendMessageRequestSchema = z.object({
  conversationId: SafeIdString,
  message: sanitizedString(MAX_MESSAGE_LENGTH),
  parentMessageId: SafeIdString.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

/**
 * Regenerate message request params
 */
export const RegenerateMessageParamsSchema = z.object({
  id: SafeIdString,
});

/**
 * Stop generation request schema
 */
export const StopGenerationRequestSchema = z.object({
  conversationId: SafeIdString,
});

/**
 * Tip feedback request schema — clients report helpfulness of injected TIM tips
 */
export const TipFeedbackRequestSchema = z.object({
  tip_ids: z.array(SafeIdString).min(1).max(50),
  helpful: z.boolean(),
  response_id: SafeIdString.optional(),
  comment: sanitizedString(1000).optional(),
});

// ============================================================================
// Conversation API Schemas
// ============================================================================

/**
 * Create conversation request schema
 */
export const CreateConversationRequestSchema = z.object({
  name: sanitizedString(MAX_NAME_LENGTH).optional(),
  participants: z.array(SafeIdString).max(100).optional(),
  metadata: z.record(z.string(), z.unknown()).refine(
    (val) => JSON.stringify(val).length <= 10000,
    'Metadata too large'
  ).optional(),
});

/**
 * Update conversation request schema
 */
export const UpdateConversationRequestSchema = z.object({
  name: sanitizedString(MAX_NAME_LENGTH).optional(),
  title: sanitizedString(MAX_NAME_LENGTH).optional(),
  metadata: z.record(z.string(), z.unknown()).refine(
    (val) => JSON.stringify(val).length <= 10000,
    'Metadata too large'
  ).optional(),
});

/**
 * Conversation ID params schema
 */
export const ConversationIdParamsSchema = z.object({
  id: SafeIdString,
});

/**
 * List conversations query schema
 */
export const ListConversationsQuerySchema = PaginationQuerySchema;

/**
 * Export conversations request schema
 */
export const ExportConversationsRequestSchema = z.object({
  conversationIds: z.array(SafeIdString).max(1000).optional(),
  includeMetadata: z.boolean().optional(),
  format: z.enum(['json', 'csv']).optional(),
});

/**
 * Import conversations request schema
 */
export const ImportConversationsRequestSchema = z.object({
  data: z.string().min(1).max(50_000_000), // Base64 encoded data
  mergeStrategy: z.enum(['skip', 'overwrite', 'create_copy']).optional(),
});

// ============================================================================
// RAG & Memory API Schemas
// ============================================================================

/**
 * RAG query request schema
 */
export const RagQueryRequestSchema = z.object({
  query: sanitizedString(MAX_QUERY_LENGTH),
  topK: z.number().int().min(1).max(100).optional(),
  userId: SafeIdString.optional(),
});

/**
 * Semantic search request schema
 */
export const SemanticSearchRequestSchema = z.object({
  query: sanitizedTrimmedString(MAX_QUERY_LENGTH),
  topK: z.number().int().min(1).max(100).optional(),
});

/**
 * Advanced retrieval request schema
 */
export const AdvancedRetrievalRequestSchema = z.object({
  tenantId: SafeIdString,
  sessionId: SafeIdString.optional(),
  query: sanitizedString(MAX_QUERY_LENGTH),
  topK: z.number().int().min(1).max(100).optional(),
  namespace: sanitizedString(128).optional(),
  filters: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// MAS (Multi-Agent System) API Schemas
// ============================================================================

/**
 * MAS generate plan request schema
 */
export const MasGeneratePlanRequestSchema = z.object({
  goal: sanitizedTrimmedString(MAX_QUERY_LENGTH),
  maxSteps: z.number().int().min(1).max(100).optional(),
});

/**
 * MAS execute request schema
 */
export const MasExecuteRequestSchema = z.object({
  scenario: sanitizedString(MAX_NAME_LENGTH),
  useCase: sanitizedString(MAX_NAME_LENGTH).optional(),
  payload: z.record(z.string(), z.unknown()).refine(
    (val) => JSON.stringify(val).length <= MAX_JSON_PAYLOAD_SIZE,
    'Payload too large'
  ).optional(),
  strategy: z.enum(['sequential', 'parallel', 'dag']).optional(),
  session: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// Plugin API Schemas
// ============================================================================

/**
 * Plugin execute request schema
 */
export const PluginExecuteRequestSchema = z.object({
  name: sanitizedString(128),
  version: sanitizedString(64).optional(),
  payload: z.unknown().optional(),
});

// ============================================================================
// Slack Integration API Schemas
// ============================================================================

/**
 * Slack slash command request schema
 */
export const SlackSlashRequestSchema = z.object({
  team_id: z.string().max(64).optional(),
  teamId: z.string().max(64).optional(),
  channel_id: z.string().max(64).optional(),
  channelId: z.string().max(64).optional(),
  user_id: z.string().max(64).optional(),
  userId: z.string().max(64).optional(),
  text: z.string().max(4000).optional(),
  thread_ts: z.string().max(64).optional(),
  threadTs: z.string().max(64).optional(),
});

// ============================================================================
// Admin API Schemas
// ============================================================================

/**
 * Feature flags update request schema
 */
export const UpdateFeatureFlagsRequestSchema = z.record(z.string(), z.boolean());

/**
 * Feature flags bulk update request schema
 */
export const BulkUpdateFeatureFlagsRequestSchema = z.object({
  updates: z.record(z.string(), z.boolean()),
});

// Type exports for TypeScript
export type ChatCompletionRequest = z.infer<typeof ChatCompletionRequestSchema>;
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;
export type UpdateConversationRequest = z.infer<typeof UpdateConversationRequestSchema>;
export type RagQueryRequest = z.infer<typeof RagQueryRequestSchema>;
export type SemanticSearchRequest = z.infer<typeof SemanticSearchRequestSchema>;
export type AdvancedRetrievalRequest = z.infer<typeof AdvancedRetrievalRequestSchema>;
export type MasGeneratePlanRequest = z.infer<typeof MasGeneratePlanRequestSchema>;
export type MasExecuteRequest = z.infer<typeof MasExecuteRequestSchema>;
export type PluginExecuteRequest = z.infer<typeof PluginExecuteRequestSchema>;
export type SlackSlashRequest = z.infer<typeof SlackSlashRequestSchema>;
export type ExportConversationsRequest = z.infer<typeof ExportConversationsRequestSchema>;
export type ImportConversationsRequest = z.infer<typeof ImportConversationsRequestSchema>;
