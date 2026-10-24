/**
 * Zod payloads for one agent run stream.
 * Layer: Core
 */

import { z } from 'zod';

export const TOOL_OUTPUT_CHAR_LIMIT = 25_000;

export const AgentRunEventTypeSchema = z.enum([
  'AgentRunStarted',
  'ModelCalled',
  'ToolCallRequested',
  'ToolCallStarted',
  'ToolCallCompleted',
  'AgentContextCompacted',
  'AgentRunFinished',
]);

const agentRunBase = {
  runId: z.string().min(1),
  step: z.number().int().nonnegative(),
  correlationId: z.string().min(1),
};

export const AgentRunStartedSchema = z.object({
  ...agentRunBase,
  messages: z.array(z.record(z.string(), z.unknown())),
  codeVersion: z.string().min(1).optional(),
  modelId: z.string().min(1).optional(),
  toolsetHash: z.string().min(1).optional(),
  /** Principal that started the run. Readers and cancel check it. */
  ownerId: z.string().min(1).optional(),
  tenantId: z.string().min(1).optional(),
});

export const ModelCalledSchema = z.object({
  ...agentRunBase,
  finishReason: z.enum(['stop', 'tool_calls', 'length', 'error']),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  message: z.record(z.string(), z.unknown()),
});

export const ToolCallRequestedSchema = z.object({
  ...agentRunBase,
  toolCallId: z.string().min(1),
  name: z.string().min(1),
});

/**
 * Written right before the tool body runs, with the stream version the writer
 * read. A second writer that read the same version fails, so one call has one
 * executor. A Started without a Completed after restart means the outcome is unknown.
 */
export const ToolCallStartedSchema = z.object({
  ...agentRunBase,
  toolCallId: z.string().min(1),
  name: z.string().min(1),
  /** The execution that holds the claim. */
  executorId: z.string().min(1).optional(),
  /** Until then a resume elsewhere treats the call as running, not as unknown. */
  leaseExpiresAt: z.string().datetime().optional(),
});

export const ToolCallCompletedSchema = z.object({
  ...agentRunBase,
  toolCallId: z.string().min(1),
  output: z.string().max(TOOL_OUTPUT_CHAR_LIMIT),
});

export const ToolApprovalRequestedSchema = z.object({
  ...agentRunBase,
  toolCallId: z.string().min(1),
  name: z.string().min(1),
  argumentsJson: z.string(),
  argumentsHash: z.string().min(1).optional(),
});

export const ToolApprovalDecidedSchema = z.object({
  ...agentRunBase,
  toolCallId: z.string().min(1),
  decision: z.enum(['approved', 'denied', 'expired']),
  argumentsHash: z.string().min(1).optional(),
  /** Who decided. Absent for an expiry written by the kernel. */
  decidedBy: z.string().min(1).optional(),
});

export const AgentRunCancelledSchema = z.object({
  ...agentRunBase,
});

export const AgentContextCompactedSchema = z.object({
  ...agentRunBase,
  tokensUsed: z.number().int().nonnegative(),
  summary: z.string().min(1),
  transcriptPath: z.string().min(1),
});

export const AgentRunFinishedSchema = z.object({
  ...agentRunBase,
  reason: z.enum(['completed', 'max_steps', 'budget_exhausted', 'paused', 'cancelled', 'killed', 'version_mismatch']),
  content: z.string().optional(),
});

export const AgentRunPayloadSchema = z.union([
  AgentRunStartedSchema,
  ModelCalledSchema,
  ToolCallRequestedSchema,
  ToolCallStartedSchema,
  ToolCallCompletedSchema,
  ToolApprovalRequestedSchema,
  ToolApprovalDecidedSchema,
  AgentContextCompactedSchema,
  AgentRunFinishedSchema,
]);
