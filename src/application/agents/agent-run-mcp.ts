/**
 * Turns one user task into an agent run request for the MCP tool `run_agent`.
 * Layer: Application
 */

import type { AgentRunRequest } from './AgentRunService';
import type { ChatToolSpec } from '../../domain/ai/IChatCompletionModel';

export const BASH_TOOL_SPEC: ChatToolSpec = {
  name: 'bash',
  description: 'Run one shell command in the process container. Network is closed. Each call is a new process.',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string' },
      timeout_ms: { type: 'integer' },
    },
    required: ['command'],
    additionalProperties: false,
  },
};

export const PYTHON_TOOL_SPEC: ChatToolSpec = {
  name: 'python',
  description: 'Run Python in the process container. function_results lists this run. Network is closed. Each call is a new process.',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string' },
      timeout_ms: { type: 'integer' },
    },
    required: ['code'],
    additionalProperties: false,
  },
};

export function withProcessTools(request: AgentRunRequest, containerAvailable: boolean): AgentRunRequest {
  if (!containerAvailable) return request;
  const present = new Set((request.tools ?? []).map((tool) => tool.name));
  const extra = [BASH_TOOL_SPEC, PYTHON_TOOL_SPEC].filter((tool) => !present.has(tool.name));
  if (extra.length === 0) return request;
  return { ...request, tools: [...(request.tools ?? []), ...extra] };
}

export { AGENT_RUN_MCP_TOOLS, agentRunRequestFromTask, correlationIdForMcpSession } from '../../domain/agents/agent-run-mcp';
