import type { ILogger } from '../../core/decorators/ILogger';
import type { IMcpServer } from '../../domain/mcp/IMcpServer';
import type { IMcpScopeGuard } from '../../domain/mcp/IMcpScopeGuard';
import type { IToolExecutionPolicy } from '../../domain/security/tool-execution-policy.interface';
import type { HttpRequestAuthenticator } from './mcp-auth';

/** Tool-policy agent id for MCP HTTP. Not read from the request URL. */
export const MCP_HTTP_AGENT_ID = 'mcp-http-client';

export function mcpHttpAccessContext(req: {
  authContext?: { scopes?: string[] };
}): { agentId: string; scopeLevel: 'user' | 'project'; grantedScopes: string[] } {
  return {
    agentId: MCP_HTTP_AGENT_ID,
    scopeLevel: req.authContext ? 'user' : 'project',
    grantedScopes: req.authContext?.scopes ?? [],
  };
}

export interface McpHttpMountOptions {
  server: IMcpServer;
  authenticator: HttpRequestAuthenticator;
  scopeGuard?: IMcpScopeGuard;
  toolExecutionPolicy?: IToolExecutionPolicy;
  logger?: ILogger;
}
