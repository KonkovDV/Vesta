
import { z } from 'zod';

export const MasExecutionRequestSchema = z.object({
  scenario: z.string().min(1).max(50),      // e.g. 'default'
  sessionId: z.string().uuid().optional(),  // Must be UUID if present
  payload: z.object({
    instruction: z.string().min(1).max(20000).optional(), // Reasonable limit for chat
    input: z.string().optional(),             // Alternative field, normalized to instruction
    context: z.record(z.string(), z.any()).optional(),
  }).optional(),
}).passthrough();

export type IMasExecutionRequest = z.infer<typeof MasExecutionRequestSchema>;
