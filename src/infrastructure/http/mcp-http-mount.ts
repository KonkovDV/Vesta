/**
 * MCP Streamable HTTP as a library mount.
 *
 * runKernel() does not call this. A product calls it from KernelExtension.routes,
 * which runs before the kernel's 404 handler. The URL segment :clientName is not
 * the tool-policy agent id: researcher-* in the path must not select the full profile.
 */
import { routeParam } from '../../core/http/route-param';
import { createMcpAuthMiddleware } from './mcp-auth';
import { createMcpRoutes } from '../mcp/McpRoutes';
import { McpStreamableTransport } from '../mcp/McpStreamableTransport';
import { mcpHttpAccessContext, type McpHttpMountOptions } from './mcp-http-access';

export { MCP_HTTP_AGENT_ID, mcpHttpAccessContext } from './mcp-http-access';
export type { McpHttpMountOptions } from './mcp-http-access';

type ExpressApp = {
  use: (...args: Array<unknown>) => unknown;
};

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
