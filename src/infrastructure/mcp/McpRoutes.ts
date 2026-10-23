/**
 * McpRoutes — Express router for MCP Streamable HTTP endpoints.
 *
 * Layer: Infrastructure
 * Protocol: MCP 2025-03-26 (Streamable HTTP transport)
 *
 * Mounts a single endpoint per (clientName, userId) pair under /mcp:
 * - POST /mcp/:clientName/:userId — JSON-RPC messages (initialize, tools/list, tools/call)
 * - GET  /mcp/:clientName/:userId — SSE event stream (server→client notifications)
 * - DELETE /mcp/:clientName/:userId — Session termination
 *
 * Session identification via Mcp-Session-Id header (per MCP spec 2025-03-26).
 *
 * Phase 7 → SOTA: Migrated from deprecated SSE (spec 2024-11-05) to
 * Streamable HTTP transport with full SDK integration.
 * @see https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http
 */

import type { Request, Response, IRouter, RequestHandler } from 'express-serve-static-core';
import type { McpStreamableTransport } from './McpStreamableTransport';
import type { ILogger } from '../../core/decorators/ILogger';

// FIX: MCPS-M5 — Use ES import instead of require('express') for TypeScript type-checking.
 
const express = require('express') as { Router: () => IRouter };

/**
 * Create an Express Router for MCP Streamable HTTP endpoints.
 *
 * Usage in app.ts:
 *   app.use('/mcp', createMcpRoutes(transport, logger));
 */
export function createMcpRoutes(
  transport: McpStreamableTransport,
  logger?: ILogger,
  routeMiddleware: RequestHandler | RequestHandler[] = [],
): IRouter {
  const router = express.Router();
  const middlewareChain = Array.isArray(routeMiddleware)
    ? routeMiddleware
    : [routeMiddleware];

  // MCP Streamable HTTP: single endpoint handles POST/GET/DELETE via method dispatch.
  // The Mcp-Session-Id header (not URL params) identifies established sessions.
  // FIX: MCPS-M6 — Return the promise from handleRequest so Express can handle errors.
  // Previously fire-and-forget pattern risked swallowing rejections.
  const handler = (req: Request, res: Response) => {
    // Return the promise chain (Express 5 handles async errors; Express 4 ignores return value but .catch still handles)
    return transport.handleRequest(req, res).catch((error: unknown) => {
      logger?.error?.('mcp_request_handler_error', {
        error: error instanceof Error ? error.message : String(error),
        method: req.method,
        clientName: req.params.clientName,
        userId: req.params.userId,
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  };

  router.post('/:clientName/:userId', ...middlewareChain, handler);
  router.get('/:clientName/:userId', ...middlewareChain, handler);
  router.delete('/:clientName/:userId', ...middlewareChain, handler);

  return router;
}
