import express from 'express';
import * as core from 'express-serve-static-core';

import { McpApprovalsController } from '../controllers/McpApprovalsController';

type ExpressRequest = core.Request;
type ExpressResponse = core.Response;

export type RegisterMcpApprovalRoutesOptions = {
  app: express.Application;
  authMw: core.RequestHandler;
  featureFlagsAdminMw: core.RequestHandler;
  rateLimitMw: core.RequestHandler;
  mcpApprovalsController: McpApprovalsController;
};

export function registerMcpApprovalRoutes(
  options: RegisterMcpApprovalRoutesOptions,
): void {
  const {
    app,
    authMw,
    featureFlagsAdminMw,
    rateLimitMw,
    mcpApprovalsController,
  } = options;

  app.get('/api/mcp/approvals', authMw, featureFlagsAdminMw, rateLimitMw, (req: ExpressRequest, res: ExpressResponse) =>
    mcpApprovalsController.listPending(req, res)
  );
  app.post('/api/mcp/approvals/:id/approve', authMw, featureFlagsAdminMw, rateLimitMw, (req: ExpressRequest, res: ExpressResponse) =>
    mcpApprovalsController.approve(req, res)
  );
  app.post('/api/mcp/approvals/:id/deny', authMw, featureFlagsAdminMw, rateLimitMw, (req: ExpressRequest, res: ExpressResponse) =>
    mcpApprovalsController.deny(req, res)
  );
}