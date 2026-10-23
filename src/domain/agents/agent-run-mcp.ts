/**
 * Maps one MCP task onto an agent-run request.
 * Layer: Domain
 */

import type { ChatToolSpec } from '../ai/IChatCompletionModel';
import type { AgentRunRequest } from './agent-run.port';

export const AGENT_RUN_MCP_TOOLS: readonly ChatToolSpec[] = [
  {
    name: 'read_file',
    description: 'Read a UTF-8 file inside the workspace. path must be absolute. offset is the first line, from 0. limit is at most 400 lines. Page a large file this way, including .agent-run-spills.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        offset: { type: 'integer' },
        limit: { type: 'integer' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_text',
    description: 'Find lines containing query under the workspace. In each directory, files are scanned before subdirectories. Directories src and tests come before docs and parked. Stops after 2000 files; truncated is true when that cap is hit. Skips node_modules, .git, and symlinks.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        maxResults: { type: 'integer' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'finish',
    description: 'Finish the run and return the final message to the caller.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string' },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
];

export function correlationIdForMcpSession(sessionId: string): string {
  const cleaned = sessionId.replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 64);
  if (cleaned.length >= 5) {
    return cleaned;
  }
  return `mcp-${cleaned || 'run'}`.padEnd(5, '0');
}

export function agentRunRequestFromTask(input: {
  task: string;
  workspaceRoot: string;
  correlationId: string;
  maxSteps?: number;
  runId?: string;
  approvalTimeoutMs?: number;
}): AgentRunRequest {
  const maxSteps = Math.min(8, Math.max(1, Math.floor(input.maxSteps ?? 8)));
  return {
    messages: [{ role: 'user', content: input.task }],
    tools: [...AGENT_RUN_MCP_TOOLS],
    correlationId: input.correlationId,
    workspaceRoot: input.workspaceRoot,
    agentId: 'agent-run',
    runId: input.runId,
    limits: { maxSteps, approvalTimeoutMs: input.approvalTimeoutMs },
  };
}
