/**
 * Wraps the runtime MCP server with `run_agent` when the agent loop was built by the composition root.
 * Layer: Infrastructure
 */

import type { IAgentRunControl } from '../../domain/agents/agent-run.port';
import type { IMcpServer } from '../../domain/mcp/IMcpServer';
import { DI_TOKENS } from '../../core/di/DI_TOKENS';
import { RunAgentMcpServer } from './RunAgentMcpServer';

interface AgentRunContainer {
  isRegistered(token: string): boolean;
  resolve<T>(token: string): T;
}

type AgentRuns = Pick<IAgentRunControl, 'start'> & Partial<Pick<IAgentRunControl, 'status' | 'cancel'>>;

export function wrapMcpServerWithRunAgent(
  container: AgentRunContainer,
  inner: IMcpServer,
  runs?: AgentRuns,
  workspaceRoot: string = process.cwd(),
): IMcpServer {
  return runs ? new RunAgentMcpServer(runs, inner, workspaceRoot, agentRunTimeoutMs(container)) : inner;
}

function agentRunTimeoutMs(container: AgentRunContainer): number {
  const fallback = 30_000;
  if (!container.isRegistered(DI_TOKENS.IConfigLoader)) {
    return fallback;
  }
  try {
    const loader = container.resolve<{ get?: (key: string) => unknown }>(DI_TOKENS.IConfigLoader);
    const value = typeof loader.get === 'function' ? loader.get('agentRun.mcpTimeoutMs') : undefined;
    return typeof value === 'number' && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
}
