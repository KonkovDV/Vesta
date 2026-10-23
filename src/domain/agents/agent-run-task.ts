/**
 * Journal status as an MCP task view.
 * Layer: Domain
 */

import type { McpTaskStatus, McpTaskView } from '../mcp/IMcpServer';
import type { AgentRunStatus } from './agent-run.port';

export type { McpTaskStatus, McpTaskView };

const OPEN_STATUSES = new Set(['running', 'awaiting_approval', 'paused']);

export function mcpTaskStatus(status: AgentRunStatus['status']): McpTaskStatus {
  switch (status) {
    case 'running':
      return 'working';
    case 'awaiting_approval':
    case 'paused':
      return 'input_required';
    case 'completed':
      return 'completed';
    case 'cancelled':
    case 'killed':
      return 'cancelled';
    default:
      return 'failed';
  }
}

/** Journal status as a tasks/get result. ttl null: the journal keeps the run. */
export function mcpTaskFromRun(status: AgentRunStatus): McpTaskView {
  const createdAt = status.createdAt ?? status.updatedAt ?? new Date(0).toISOString();
  const taskStatus = mcpTaskStatus(status.status);
  return {
    taskId: status.runId,
    status: taskStatus,
    ttl: null,
    createdAt,
    lastUpdatedAt: status.updatedAt ?? createdAt,
    ...(OPEN_STATUSES.has(status.status) ? { pollInterval: 1_000 } : {}),
    ...(status.content || status.reason ? { statusMessage: status.content ?? status.reason } : {}),
  };
}
