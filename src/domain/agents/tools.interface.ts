
import { z } from 'zod';
import { IAgentContext } from './agent-context.interface';

/**
 * Represents a concrete tool capability exposed to agents.
 * OpenClaw-style: "Atomic" tool definition.
 */
export interface IAgentTool {
  /** Check if this tool matches the given name (case-insensitive) */
  matches(name: string): boolean;

  /** Unique name of the tool (e.g. "web-browser.navigate") */
  readonly name: string;
  
  /** Human-readable description for LLM prompts */
  readonly description: string;
  
  /** Zod schema for input validation */
  readonly schema: z.ZodType<unknown>;

  /** 
   * Execute the tool logic.
   * Runs in the Main Process (Trusted Boundary).
   */
  execute(args: unknown, context: IAgentContext): Promise<unknown>;
}

/**
 * Registry service for managing available tools.
 */
export interface IToolRegistry {
  register(tool: IAgentTool): void;
  getTool(name: string): IAgentTool | undefined;
  listTools(agentId?: string): IAgentTool[];
  execute(name: string, args: unknown, context: IAgentContext): Promise<unknown>;
}

/**
 * RPC Message: Worker -> Main
 * Request to execute a tool.
 */
export interface CallToolMessage {
  type: 'CALL_TOOL';
  id: string; // Correlation ID (UUID)
  tool: string; // Tool Name
  args: unknown; // Arguments (to be validated)
  agentId?: string; // Context hint
}

/**
 * RPC Message: Main -> Worker
 * Result of a tool execution.
 */
export interface ToolResultMessage {
  type: 'TOOL_RESULT';
  id: string; // Correlation ID
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}

export type WorkerMessage = CallToolMessage;
export type MainMessage = ToolResultMessage;
