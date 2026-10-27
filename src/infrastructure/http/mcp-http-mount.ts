/**
 * MCP Streamable HTTP as a library mount.
 *
 * runKernel() does not call this. A product calls it from KernelExtension.routes,
 * which runs before the kernel's 404 handler. The URL segment :clientName is not
 * the tool-policy agent id: researcher-* in the path must not select the full profile.
 */
import type { ILogger } from '../../core/decorators/ILogger';
import type { IMcpServer } from '../../domain/mcp/IMcpServer';
import type { IMcpScopeGuard } from '../../domain/mcp/IMcpScopeGuard';
import type { IToolExecutionPolicy } from '../../domain/security/tool-execution-policy.interface';
import { routeParam } from '../../core/http/route-param';
import { createMcpAuthMiddleware, type HttpRequestAuthenticator } from './mcp-auth';
import { createMcpRoutes } from '../mcp/McpRoutes';
import { McpStreamableTransport } from '../mcp/McpStreamableTransport';

/** Tool-policy agent id for MCP HTTP. Not read from the request URL. */
export const MCP_HTTP_AGENT_ID = 'mcp-http-client';

type ExpressApp = {
  use: (...args: Array<unknown>) => unknown;
};

export interface McpHttpMountOptions {
  server: IMcpServer;
  authenticator: HttpRequestAuthenticator;
  scopeGuard?: IMcpScopeGuard;
  toolExecutionPolicy?: IToolExecutionPolicy;
  logger?: ILogger;
}

export function mcpHttpAccessContext(req: {
  authContext?: { scopes?: string[] };
}): { agentId: string; scopeLevel: 'user' | 'project'; grantedScopes: string[] } {
  return {
    agentId: MCP_HTTP_AGENT_ID,
    scopeLevel: req.authContext ? 'user' : 'project',
    grantedScopes: req.authContext?.scopes ?? [],
  };
}

/** Attach POST/GET/DELETE /api/mcp/:clientName/:userId. Call this before any 404 handler. */
export function mountMcpHttp(app: ExpressApp, options: McpHttpMountOptions): McpStreamableTransport {
  const transport = new McpStreamableTransport(
    options.server,
    {
      resolveIdentity: (req) => {
        const authenticated = req as {
          authContext?: { userId?: string };
          user?: { id?: string };
          params?: { clientName?: string; userId?: string };
        };
        return {
          clientName: routeParam(authenticated.params?.clientName) ?? '',
          userId: authenticated.authContext?.userId ?? authenticated.user?.id,
        };
      },
      resolveAccessContext: (req) => mcpHttpAccessContext(req as { authContext?: { scopes?: string[] } }),
    },
    options.scopeGuard,
    options.toolExecutionPolicy,
  );
  app.use('/api/mcp', createMcpAuthMiddleware(options.authenticator), createMcpRoutes(transport, options.logger));
  return transport;
}
