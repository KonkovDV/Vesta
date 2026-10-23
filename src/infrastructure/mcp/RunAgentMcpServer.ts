/**
 * Adds the phase-3 agent loop as the MCP tool `run_agent`.
 * Layer: Infrastructure
 */

import path from 'node:path';
import type { IMcpServer, McpSessionContext, McpTaskView, McpToolDefinition, McpToolResult } from '../../domain/mcp/IMcpServer';
import { agentRunRequestFromTask, correlationIdForMcpSession } from '../../domain/agents/agent-run-mcp';
import { mcpTaskFromRun } from '../../domain/agents/agent-run-task';
import type { IAgentRunControl } from '../../domain/agents/agent-run.port';
import { isInsideWorkspace } from '../../core/workspace/workspace-path';
import { IdGenerator } from '../../core/utils/IdGenerator';

export const RUN_AGENT_MCP_TOOL_NAME = 'run_agent';
export const GET_AGENT_RUN_TOOL_NAME = 'get_agent_run';
export const CANCEL_AGENT_RUN_TOOL_NAME = 'cancel_agent_run';
export const RUN_AGENT_REQUIRED_SCOPE = 'agents.run';
export const AGENT_RUN_SCOPE_TOOLS = new Set([
  RUN_AGENT_MCP_TOOL_NAME,
  GET_AGENT_RUN_TOOL_NAME,
  CANCEL_AGENT_RUN_TOOL_NAME,
]);
const DEFAULT_RUN_TIMEOUT_MS = 30_000;

const RUN_AGENT_TOOL: McpToolDefinition = {
  name: RUN_AGENT_MCP_TOOL_NAME,
  description: 'Run the project agent on one task. The agent may read files and search text inside workspaceRoot, and every step is stored in the event journal.',
  inputSchema: {
    type: 'object',
    properties: {
      task: { type: 'string', minLength: 1 },
      workspaceRoot: { type: 'string' },
      maxSteps: { type: 'integer', minimum: 1, maximum: 8 },
    },
    required: ['task'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
};

const GET_AGENT_RUN_TOOL: McpToolDefinition = {
  name: GET_AGENT_RUN_TOOL_NAME,
  description: 'Read the status of an agent run from its event journal.',
  inputSchema: {
    type: 'object',
    properties: { runId: { type: 'string', minLength: 1 } },
    required: ['runId'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

const CANCEL_AGENT_RUN_TOOL: McpToolDefinition = {
  name: CANCEL_AGENT_RUN_TOOL_NAME,
  description: 'Cancel an agent run. The journal records AgentRunCancelled.',
  inputSchema: {
    type: 'object',
    properties: { runId: { type: 'string', minLength: 1 } },
    required: ['runId'],
    additionalProperties: false,
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

export class RunAgentMcpServer implements IMcpServer {
  constructor(
    private readonly runs: Pick<IAgentRunControl, 'start'> & Partial<Pick<IAgentRunControl, 'status' | 'cancel'>>,
    private readonly inner: IMcpServer,
    private readonly workspaceRoot: string,
    private readonly runTimeoutMs: number = DEFAULT_RUN_TIMEOUT_MS,
  ) {}

  listTools(): McpToolDefinition[] {
    return [RUN_AGENT_TOOL, GET_AGENT_RUN_TOOL, CANCEL_AGENT_RUN_TOOL, ...this.inner.listTools()];
  }

  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    context: McpSessionContext,
  ): Promise<McpToolResult> {
    if (toolName === GET_AGENT_RUN_TOOL_NAME) {
      return this.readRun(args);
    }
    if (toolName === CANCEL_AGENT_RUN_TOOL_NAME) {
      return this.cancelRun(args, context);
    }
    if (toolName !== RUN_AGENT_MCP_TOOL_NAME) {
      return this.inner.callTool(toolName, args, context);
    }
    const task = typeof args.task === 'string' ? args.task.trim() : '';
    if (!task) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'run_agent requires task' }],
      };
    }
    const requestedRoot = typeof args.workspaceRoot === 'string' ? args.workspaceRoot.trim() : '';
    const workspaceRoot = requestedRoot && isInsideWorkspace(this.workspaceRoot, path.resolve(requestedRoot))
      ? path.resolve(requestedRoot)
      : this.workspaceRoot;
    if (requestedRoot && workspaceRoot === this.workspaceRoot && path.resolve(requestedRoot) !== path.resolve(this.workspaceRoot)) {
      return {
        isError: true,
        content: [{ type: 'text', text: 'workspaceRoot must stay inside the server workspace' }],
      };
    }
    const maxSteps = typeof args.maxSteps === 'number' ? args.maxSteps : undefined;
    const runId = IdGenerator.generateWithPrefix('run');
    const pending = this.runs.start(agentRunRequestFromTask({
      task,
      workspaceRoot,
      correlationId: correlationIdForMcpSession(context.sessionId),
      maxSteps,
      runId,
      approvalTimeoutMs: this.runTimeoutMs,
    }));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      pending.then(
        (result) => ({ kind: 'done' as const, result }),
        (error: unknown) => ({ kind: 'error' as const, error }),
      ),
      new Promise<{ kind: 'running' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'running' }), this.runTimeoutMs);
      }),
    ]);
    if (timer) {
      clearTimeout(timer);
    }
    if (outcome.kind === 'running') {
      pending.catch(() => undefined);
      return {
        content: [{ type: 'text', text: runId }],
        structuredContent: { runId, reason: 'running', content: '' },
      };
    }
    if (outcome.kind === 'error') {
      throw outcome.error;
    }
    return {
      content: [{ type: 'text', text: outcome.result.content ?? outcome.result.reason }],
      structuredContent: {
        runId: outcome.result.runId,
        reason: outcome.result.reason,
        content: outcome.result.content ?? '',
      },
    };
  }

  private async readRun(args: Record<string, unknown>): Promise<McpToolResult> {
    const runId = typeof args.runId === 'string' ? args.runId.trim() : '';
    if (!runId || !this.runs.status) {
      return { isError: true, content: [{ type: 'text', text: 'get_agent_run requires runId' }] };
    }
    const status = await this.runs.status(runId);
    if (!status) {
      return { isError: true, content: [{ type: 'text', text: `agent run ${runId} was not found` }] };
    }
    return {
      content: [{ type: 'text', text: status.content ?? status.status }],
      structuredContent: { ...status },
    };
  }

  private async cancelRun(args: Record<string, unknown>, context: McpSessionContext): Promise<McpToolResult> {
    const runId = typeof args.runId === 'string' ? args.runId.trim() : '';
    if (!runId || !this.runs.cancel) {
      return { isError: true, content: [{ type: 'text', text: 'cancel_agent_run requires runId' }] };
    }
    await this.runs.cancel(runId, correlationIdForMcpSession(context.sessionId));
    return {
      content: [{ type: 'text', text: runId }],
      structuredContent: { runId, reason: 'cancelled', content: '' },
    };
  }

  async getTask(taskId: string): Promise<McpTaskView | undefined> {
    if (!this.runs.status) return undefined;
    const status = await this.runs.status(taskId);
    return status ? mcpTaskFromRun(status) : undefined;
  }

  async cancelTask(taskId: string, context: McpSessionContext): Promise<McpTaskView | undefined> {
    if (!this.runs.cancel || !taskId) return undefined;
    await this.runs.cancel(taskId, correlationIdForMcpSession(context.sessionId));
    return this.getTask(taskId);
  }

  async taskResult(taskId: string): Promise<McpToolResult | undefined> {
    if (!this.runs.status) return undefined;
    const status = await this.runs.status(taskId);
    if (!status) return undefined;
    return {
      content: [{ type: 'text', text: status.content ?? status.status }],
      structuredContent: { ...status },
      isError: status.status === 'paused' || status.status === 'killed' || status.status === 'version_mismatch',
    };
  }

  async close(): Promise<void> {
    await this.inner.close?.();
  }
}
