import { z } from 'zod';

/**
 * Represents the definition of a tool that an agent can call.
 * Compatible with OpenAI's 'function' tool definition.
 */
export interface IAgentTool {
  /**
   * The name of the function to be called.
   * Must be a-z, A-Z, 0-9, or contain underscores and dashes, with a maximum length of 64.
   */
  name: string;

  /**
   * A description of what the function does, used by the model to choose when and how to call the function.
   */
  description: string;

  /**
   * The parameters the functions accepts, described as a JSON Schema object.
   * Typically defined using Zod.
   */
  parameters: z.ZodType<unknown> | Record<string, unknown>;

  /**
   * Executes the tool with the given arguments.
   * @param args The arguments parsed from the LLM's tool call.
   * @param context Optional context (userId, conversationId, etc).
   */
  execute(args: unknown, context?: ToolExecutionContext): Promise<ToolExecutionResult>;
}

export interface ToolExecutionContext {
  userId: string;
  conversationId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export type ToolExecutionStatus = 'completed' | 'approval_required' | 'failed';

export interface ToolExecutionResult {
  /**
   * The output of the tool execution (stringified JSON, plain text, etc).
   * This content is sent back to the LLM as a tool message.
   */
  content: string;

  /**
   * Optional: If the tool execution resulted in an error.
   */
  isError?: boolean;

  /**
   * Optional: Normalized execution status for non-binary outcomes such as approval gating.
   */
  status?: ToolExecutionStatus;

  /**
   * Optional: Additional metadata or artifacts (e.g., file paths, images).
   */
  metadata?: Record<string, unknown>;
}
